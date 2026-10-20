/** 使用本机真实 Cordis、BlockAssembler 和已安装过滤器验证集成。@author wwj */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import * as guard from '../index.js';
import { guardStream } from '../stream.js';
import { chunks, collect, leaked, options } from './helpers.js';

const hostRoot = process.argv[2];
assert.ok(hostRoot, '用法：node test/host.mjs <dsh 的 node_modules 目录> [实际会话回放 JSON]');
const load = (name) => import(pathToFileURL(resolve(hostRoot, `@deepseek-ai/${name}/lib/index.js`)).href);
const { Context, Service } = await load('cordis');
const { BlockAssembler } = await load('dsh-llm');
const artifactUrl = new URL('../../../node_modules/@goodandready/dsh-dsml-artifact-guard/lib/index.js', import.meta.url);
const { sanitizeDsmlArtifacts } = await import(artifactUrl.href);

class Llm extends Service {
  input = chunks();
  constructor(ctx) { super(ctx, 'llm'); }
  stream(request) {
    return this.ctx.waterfall(this, 'llm/stream', request, () => this.input);
  }
}

const ctx = new Context();
try {
  await ctx.plugin(Llm);
  const llm = ctx.get('llm');
  // 使用现有 artifact guard 的真实转换器串联，验证同步返回迭代器。
  await ctx.plugin({
    inject: ['llm'],
    apply(child) { child.on('llm/stream', (request, next) => sanitizeDsmlArtifacts(next(request))); },
  });
  let fiber = ctx.plugin(guard);
  await fiber;
  for (let cycle = 0; cycle < 3; cycle++) {
    const stream = llm.stream(options);
    assert.equal(typeof stream[Symbol.asyncIterator], 'function');
    const output = await collect(stream);
    const assembler = new BlockAssembler();
    for (const chunk of output) assembler.push(chunk);
    const calls = assembler.blocks().filter((block) => block.type === 'tool-call');
    assert.equal(calls.length, 1);
    assert.equal(assembler.finish.kind, 'tool-calls');
    // 用无副作用的记录器消费与宿主一致的调用块，不执行参数中的代码。
    const executed = calls.map((call) => ({ name: call.name, args: JSON.parse(call.arguments) }));
    assert.equal(executed[0].name, 'run_code');
    assert.equal(executed[0].args.description, '读取用例锚点');
    await fiber.dispose();
    const unloaded = await collect(llm.stream(options));
    assert.equal(unloaded.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
    assert.ok(unloaded.some((chunk) => chunk.text?.includes('｜DSML｜')));
    fiber = ctx.plugin(guard);
    await fiber;
  }
  await fiber.dispose();
  console.log('PASS: 真实事件过滤、标准块组装、现有过滤器串联、卸载与重复加载');

  const mixed = leaked.replace('<｜DSML｜ parameter name="code" string="true">', '<parameter name="code">');
  for (const invalid of [false, true]) {
    const text = invalid ? mixed.replace('run_code', 'unknown_tool') : mixed;
    const assembler = new BlockAssembler();
    for await (const chunk of guardStream(chunks(text, [...text]), options)) assembler.push(chunk);
    assert.equal(assembler.blocks().filter((block) => block.type === 'tool-call').length, invalid ? 0 : 1);
    assert.equal(assembler.finish.kind, invalid ? 'error' : 'tool-calls');
    if (invalid) assert.equal(assembler.blocks()[0].text, text);
  }
  console.log('PASS: 混合格式恢复、失败原文保留与错误结束均符合宿主块契约');

  const chatml = '先读取技能。\n<|im_start|>tool:run_code\nconsole.log("example");\n<|im_end|>';
  let chatmlClosed = false;
  async function* chatmlSource() {
    try {
      yield* chunks(chatml, [...chatml], false).slice(0, -2);
      assert.fail('ChatML 工具头后不应继续消费源流');
    } finally { chatmlClosed = true; }
  }
  const chatmlAssembler = new BlockAssembler();
  for await (const chunk of guardStream(chatmlSource(), options)) chatmlAssembler.push(chunk);
  assert.equal(chatmlAssembler.finish.kind, 'error');
  assert.equal(chatmlAssembler.finish.failure.code, 'CHATML_TOOL_LEAK');
  assert.equal(chatmlAssembler.blocks().filter((block) => block.type === 'tool-call').length, 0);
  assert.equal(chatmlClosed, true);
  console.log('PASS: 未结束的 ChatML 流及时关闭，宿主收到明确错误且不产生工具调用');

  const isolated = ctx.isolate('llm');
  await isolated.plugin(Llm);
  const isolatedFiber = isolated.plugin(guard);
  await isolatedFiber;
  assert.equal((await collect(isolated.get('llm').stream(options))).filter((chunk) => chunk.type === 'tool-call-delta').length, 1);
  assert.equal((await collect(llm.stream(options))).filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
  await isolatedFiber.dispose();
  console.log('PASS: 隔离的 llm 服务只命中对应插件');

  const plain = chunks('正常思考。');
  let intercepted;
  guard.apply({
    on(event, listener) { intercepted = listener; },
    logger: { info() {} },
  });
  assert.equal(intercepted({ model: 'claude-opus' }, () => plain), plain);
  assert.equal(intercepted({ model: 'DEEPSEEK-test' }, () => plain)[Symbol.asyncIterator] instanceof Function, true);
  console.log('PASS: 非 DeepSeek 请求保持原始迭代器');

  if (process.argv[3]) {
    const samples = JSON.parse(await readFile(process.argv[3], 'utf8'));
    let recovered = 0;
    for (const sample of samples) {
      const input = [];
      sample.message.content.forEach((block, index) => {
        input.push({ type: 'block-start', index, blockType: block.type });
        if (['reasoning', 'text'].includes(block.type)) {
          for (let i = 0; i < block.text.length; i += 7) {
            input.push({ type: `${block.type}-delta`, index, text: block.text.slice(i, i + 7) });
          }
        }
        input.push({ type: 'block-end', index, block });
      });
      input.push({ type: 'finish', reason: { kind: 'stop' }, replayState: sample.message.source.replayState });
      const assembler = new BlockAssembler();
      for await (const chunk of guardStream(input, { model: sample.message.source.model, tools: sample.tools })) assembler.push(chunk);
      const calls = assembler.blocks().filter((block) => block.type === 'tool-call');
      assert.equal(calls.length, 1, `turn=${sample.turn} step=${sample.step}`);
      assert.equal(assembler.finish.kind, 'tool-calls');
      assert.ok(assembler.blocks().filter((block) => block.text).every((block) => !block.text.includes('｜DSML｜')));
      recovered += calls.length;
    }
    console.log(`PASS: 实际会话 ${samples.length} 条泄漏消息恢复 ${recovered} 次工具调用，未执行历史代码`);
  }
} finally {
  await ctx.fiber.dispose();
}
