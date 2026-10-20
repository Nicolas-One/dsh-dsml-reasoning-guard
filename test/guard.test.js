import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCalls, stripTags, stripThink, TagCleaner } from '../dsml.js';
import { guardStream } from '../stream.js';
import { chunks, collect, finish, invocation, leaked, options, tools } from './helpers.js';

test('ESM 入口提供插件与 llm 注入声明', async () => {
  const plugin = await import('../index.js');
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['llm']);
});

test('真实格式的思考调用恢复为标准事件，原对象不变', async () => {
  const input = chunks();
  const snapshot = structuredClone(input);
  const output = await collect(guardStream(input, options));
  const calls = output.filter((chunk) => chunk.type === 'tool-call-delta');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].index, 1);
  assert.equal(calls[0].name, 'run_code');
  assert.deepEqual(JSON.parse(calls[0].argumentsDelta), {
    code: 'const value: number = 1; return value;', description: '读取用例锚点',
  });
  assert.equal(output.at(-1).reason.kind, 'tool-calls');
  assert.equal(output.at(-1).replayState, undefined);
  assert.equal(output.find((chunk) => chunk.type === 'block-end').block.text, stripTags(leaked));
  assert.deepEqual(input, snapshot);
});

test('在所有双分片边界及逐字符分片中恢复一次，增量与完整块一致', async () => {
  for (let i = 0; i <= leaked.length; i++) {
    const output = await collect(guardStream(chunks(leaked, [leaked.slice(0, i), leaked.slice(i)]), options));
    assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 1, `split=${i}`);
    assert.equal(output.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), stripTags(leaked), `split=${i}`);
  }
  const output = await collect(guardStream(chunks(leaked, [...leaked], false), options));
  assert.equal(output.at(-1).reason.kind, 'tool-calls');
  assert.equal(output.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), stripTags(leaked));
});

test('原生工具调用不重复恢复，工具块原样保留', async () => {
  const native = { type: 'tool-call-delta', index: 3, id: 'native', name: 'run_code', argumentsDelta: '{}' };
  const input = chunks();
  input.splice(-1, 0, native);
  const output = await collect(guardStream(input, options));
  assert.deepEqual(output.filter((chunk) => chunk.type === 'tool-call-delta'), [native]);
  assert.equal(output.at(-1).reason.kind, 'stop');
});

for (const kind of ['error', 'aborted', 'max-tokens', 'tool-calls']) {
  test(`${kind} 结束不恢复工具调用`, async () => {
    const input = chunks();
    input[input.length - 1] = { type: 'finish', reason: { kind } };
    const output = await collect(guardStream(input, options));
    assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
    assert.equal(output.at(-1).reason.kind, kind);
  });
}

test('取消、辅助请求及正文示例不恢复', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const extra of [{ signal: controller.signal }, { purpose: 'session-title' }, { tools: [] }]) {
    const output = await collect(guardStream(chunks(), { ...options, ...extra }));
    assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
  }
  const input = chunks().map((chunk) => chunk.type === 'reasoning-delta'
    ? { ...chunk, type: 'text-delta' } : chunk.type === 'block-end'
      ? { ...chunk, block: { ...chunk.block, type: 'text' } } : chunk);
  const output = await collect(guardStream(input, options));
  assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
});

test('严格拒绝截断、示例、未知工具、重复参数、非法 JSON 和缺少参数', () => {
  for (const text of [
    leaked.slice(0, -10), `\`\`\`xml\n${leaked}\n\`\`\``,
    leaked.replace('run_code', 'unknown'), leaked.replace('name="description"', 'name="code"'),
    leaked.replace('string="true"', 'string="false"'),
    leaked.replace(/<｜DSML｜ parameter name="description"[^]*?<\/｜DSML｜ parameter>/, ''),
    leaked + '\n以上是一个示例。', leaked.replace('name="description"', 'name="extra"'),
  ]) assert.equal(parseCalls(text, tools), undefined);
});

test('多调用及 JSON 参数保留类型', () => {
  assert.equal(parseCalls('已分析代码：\n```ts\nconst value = 1;\n```\n' + leaked, tools).length, 1);
  assert.equal(parseCalls(leaked.replace(invocation, invocation + '\n' + invocation), tools).length, 2);
  const text = `<｜DSML｜tool_calls><｜DSML｜invoke name="typed">
<｜DSML｜parameter name="count" string="false">2</｜DSML｜parameter>
<｜DSML｜parameter name="enabled" string="false">true</｜DSML｜parameter>
</｜DSML｜invoke></｜DSML｜tool_calls>`;
  const [call] = parseCalls(text, [{ name: 'typed' }]);
  assert.deepEqual(JSON.parse(call.arguments), { count: 2, enabled: true });
});

test('普通文本保留内容与 replayState，跨块不拼接标签', async () => {
  const text = 'x < y，末尾 <';
  const output = await collect(guardStream(chunks(text, ['x <', ' y，末尾 <']), options));
  assert.equal(output.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), text);
  assert.equal(output.at(-1), finish);
  const a = new TagCleaner();
  const b = new TagCleaner();
  assert.equal(a.push('<｜DSML｜'), '');
  assert.equal(b.push('calls>正常正文'), 'calls>正常正文');
  assert.equal(a.push('', true), '<｜DSML｜');
});

test('可见文本块中的 think 包裹内容被隐藏并保留答案', async () => {
  const text = '<think>内部推理</think>最终答案';
  assert.equal(stripThink(text), '最终答案');
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thi' },
    { type: 'text-delta', index: 0, text: 'nk>内部推理</think>最终答案' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const output = await collect(guardStream(input, options));
  assert.equal(output.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), '最终答案');
  assert.equal(output.find((chunk) => chunk.type === 'block-end').block.text, '最终答案');
});

test('正文中的 think 示例不清洗', async () => {
  const text = '示例：<think>标签</think>';
  const input = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const output = await collect(guardStream(input, options));
  assert.equal(output.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), text);
});

test('上游异常传播，提前停止时关闭源迭代器', async () => {
  const failure = new Error('upstream failed');
  async function* broken() { yield chunks()[0]; throw failure; }
  await assert.rejects(collect(guardStream(broken(), options)), (error) => error === failure);
  let closed = false;
  async function* source() { try { yield* chunks(); } finally { closed = true; } }
  for await (const chunk of guardStream(source(), options)) { assert.ok(chunk); break; }
  assert.equal(closed, true);
});

test('超出捕获上限时只清洗，不执行截断调用', async () => {
  const text = 'a'.repeat(2 * 1024 * 1024) + '\n' + leaked;
  const events = [];
  const output = await collect(guardStream(chunks(text), options, (event) => events.push(event)));
  assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
  assert.ok(events.some((event) => event.includes('capture limit')));
});
