/** 本地 HTTP/SSE 验证，不访问真实上游，也不执行 shell。@author wwj */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmAdapter, BlockAssembler, createToolResultMessage, attributionHeaders } from '@deepseek-ai/dsh-llm';
import * as official from '@deepseek-ai/dsh-llm-pi-ai';
import * as plugin from '../index.js';
import { root, tools } from './helpers.js';

function sse(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }

test('显式配置旧会话路由，冷启动源 provider 稍后注册仍可激活', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    const fiber = ctx.plugin(plugin, { sourceProvider: 'late-source' });
    await fiber;
    assert.ok(!ctx.llm.listProviders().some((provider) => provider.id === 'sub2api-deepseek-dsml'));
    await ctx.plugin({ inject: ['llm'], apply(sourceCtx) {
      sourceCtx.llm.registerAdapter(['late-source'], new LlmAdapter());
    } });
    assert.equal(ctx.llm.listProviders().filter((provider) => provider.id === 'sub2api-deepseek-dsml').length, 1);
    await fiber.dispose();
    assert.ok(!ctx.llm.listProviders().some((provider) => provider.id === 'sub2api-deepseek-dsml'));
  } finally { await ctx.fiber.dispose(); }
});

test('官方 Anthropic SSE → 新插件 → 宿主组装 → 工具结果回传；卸载无残留', async () => {
  const requests = [];
  let cutoffs = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const value of req) body += value;
    const request = JSON.parse(body);
    requests.push({ path: req.url, body: request, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const hasResult = request.messages.some((message) => message.content?.some?.((block) => block.type === 'tool_result'));
    sse(res, 'message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant',
      model: 'deepseek-test', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 } } });
    const type = hasResult ? 'text' : 'thinking';
    sse(res, 'content_block_start', { index: 0, content_block: { type, [type]: '' } });
    const value = hasResult ? '工具结果已收到。' : `读取上下文。\n${root()}`;
    for (const char of value) sse(res, 'content_block_delta', { index: 0,
      delta: { type: `${type}_delta`, [type]: char } });
    if (!hasResult && requests.length < 5) {
      // 上游故意不发 block-stop/message-stop；插件必须主动结束 HTTP 流。
      res.on('close', () => { cutoffs++; });
      return;
    }
    sse(res, 'content_block_stop', { index: 0 });
    sse(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
    sse(res, 'message_stop', {});
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(official, { providers: { 'mock-source': {
      api: 'anthropic-messages', baseURL: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'DSML_TEST_KEY', models: [{ id: 'deepseek-test', contextWindow: 100000, maxTokens: 4096 }],
    } } });
    // 凭据只存在测试作用域，绝不读写真实 credential store。
    ctx.provide('credentials', { resolve: async () => ({ value: 'test-only-key' }) });
    const config = { sourceProvider: 'mock-source' };
    const fiber = ctx.plugin(plugin, config); await fiber;
    const providers = ctx.llm.listProviders();
    assert.ok(providers.some((provider) => provider.id === 'sub2api-deepseek-dsml'));
    const models = await ctx.llm.listModels('sub2api-deepseek-dsml');
    assert.deepEqual(models, [], '旧路由不发布模型，避免额外分组');
    const sourceModels = await ctx.llm.listModels('mock-source');
    assert.equal(sourceModels[0].id, 'deepseek-test');

    const generate = async (provider, messages) => {
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream({ provider, model: 'deepseek-test', messages, tools, maxTokens: 2048 })) assembler.push(chunk);
      return assembler;
    };
    const user = { role: 'user', content: [{ type: 'text', text: '读取测试上下文' }] };
    for (const provider of ['sub2api-deepseek-dsml', 'mock-source']) {
      const first = await generate(provider, [user]);
      assert.equal(first.finish.kind, 'tool-calls', JSON.stringify(first.finish));
      const call = first.blocks().find((block) => block.type === 'tool-call');
      assert.equal(call.name, 'bash');
      assert.equal(JSON.parse(call.arguments).command, 'echo test');
      assert.ok(first.blocks().every((block) => !block.text?.includes('DSML')));
      // 无害替身记录一次调用并返回结果，用真实序列化器验证下一步历史。
      let executions = 0;
      const execute = () => { executions++; return 'test'; };
      const result = execute();
      const assistant = first.message({ provider, model: 'deepseek-test' });
      const second = await generate(provider, [user, assistant,
        createToolResultMessage({ callId: call.id,
          content: [{ type: 'text', text: result }], isError: false })]);
      assert.equal(executions, 1);
      const sentResult = requests.at(-1).body.messages.flatMap((message) => message.content ?? [])
        .find((block) => block.type === 'tool_result');
      assert.equal(sentResult.tool_use_id, call.id);
      assert.equal(second.finish.kind, 'stop', JSON.stringify(second.finish));
      assert.ok(second.blocks().some((block) => block.text === '工具结果已收到。'));
    }
    assert.ok(requests.every((request) => new URL(request.path, 'http://local').pathname === '/v1/messages'));
    for (const [key, value] of Object.entries(attributionHeaders())) {
      assert.ok(requests.every((request) => request.headers[key.toLowerCase()] === value));
    }
    await new Promise((done) => setImmediate(done));
    assert.equal(cutoffs, 2);
    await fiber.dispose();
    assert.ok(!ctx.llm.listProviders().some((provider) => provider.id === 'sub2api-deepseek-dsml'));
    const untouched = await generate('mock-source', [user]);
    assert.equal(untouched.finish.kind, 'stop');
    assert.ok(untouched.blocks().some((block) => block.text?.includes('DSML')));
  } finally {
    await ctx.fiber.dispose();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
