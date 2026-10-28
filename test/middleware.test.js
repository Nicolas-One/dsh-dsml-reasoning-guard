/** 验证原 provider 自动纠正和不匹配请求的透明性。@author wwj */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, BlockAssembler } from '@deepseek-ai/dsh-llm';
import * as plugin from '../index.js';
import { chunks, sample, tools } from './helpers.js';

class FixtureAdapter extends LlmAdapter {
  async *stream() { yield* chunks(sample); }
}

test('默认配置跨任意 provider 匹配 DeepSeek 模型；其他模型、辅助请求和关闭开关均透传', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin({ inject: ['llm'], apply(sourceCtx) {
      sourceCtx.llm.registerAdapter(['source', 'other'], new FixtureAdapter());
    } });
    const providers = ctx.llm.listProviders().map((provider) => provider.id);
    const fiber = ctx.plugin(plugin, {}); await fiber;
    assert.deepEqual(ctx.llm.listProviders().map((provider) => provider.id), providers, '默认配置不注册兼容路由');
    await ctx.plugin({ inject: ['llm'], apply(sourceCtx) {
      sourceCtx.llm.registerAdapter(['late-source'], new FixtureAdapter());
    } });
    const call = async (extra = {}) => {
      const output = [];
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream({ provider: 'source', model: 'deepseek-test', messages: [], tools, ...extra })) {
        output.push(chunk); assembler.push(chunk);
      }
      return { output, assembler };
    };
    for (const provider of ['source', 'other', 'late-source']) {
      for (const model of ['deepseek-test', 'prefix/DeepSeek-v4.1-flash', 'DEEPSEEK-R1']) {
        const recovered = await call({ provider, model });
        assert.equal(recovered.assembler.finish.kind, 'tool-calls');
        assert.equal(recovered.assembler.blocks().filter((block) => block.type === 'tool-call').length, 1);
      }
    }
    for (const extra of [{ model: 'other-model' }, { provider: 'other', model: 'other-model' }, { purpose: 'title' }]) {
      assert.deepEqual((await call(extra)).output, chunks(sample));
    }
    await fiber.dispose();
    assert.deepEqual((await call()).output, chunks(sample), '卸载后恢复原流');
    const disabled = ctx.plugin(plugin, { dsmlCompatibility: false }); await disabled;
    assert.deepEqual((await call()).output, chunks(sample));
    await disabled.dispose();
  } finally { await ctx.fiber.dispose(); }
});

test('旧提供商列表不再限制自动匹配，正常正文和原生工具调用保持原流', async () => {
  const ctx = new Context();
  const native = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'native-call', name: 'bash', argumentsDelta: '{"command":"echo test"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'native-call', name: 'bash', arguments: '{"command":"echo test"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin({ inject: ['llm'], apply(sourceCtx) {
      class Adapter extends LlmAdapter {
        async *stream(options) {
          yield* options.model.endsWith('native') ? native
            : chunks(options.model.endsWith('plain') ? '正常正文' : sample);
        }
      }
      sourceCtx.llm.registerAdapter(['arbitrary-provider'], new Adapter());
    } });
    await ctx.plugin(plugin, { compatibleProviders: ['unrelated-provider'] });
    const call = async (model) => {
      const output = [];
      for await (const chunk of ctx.llm.stream({ provider: 'arbitrary-provider', model, messages: [], tools })) output.push(chunk);
      return output;
    };
    assert.equal((await call('deepseek-test')).at(-1).reason.kind, 'tool-calls');
    assert.deepEqual(await call('deepseek-plain'), chunks('正常正文'));
    assert.deepEqual(await call('deepseek-native'), native);
  } finally { await ctx.fiber.dispose(); }
});
