import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsml } from '../parser.js';
import { convertDsml } from '../stream.js';
import { tools, invoke, root, sample, chunks, run } from './helpers.js';

test('每个双分片边界及逐 Unicode 字符分片都恢复原生调用', async () => {
  const partitions = [...sample].map((_, index) => [sample.slice(0, index), sample.slice(index)]);
  partitions.push([...sample]);
  for (const parts of partitions) {
    const result = await run(chunks(sample, parts));
    assert.equal(result.finish.kind, 'tool-calls');
    assert.equal(result.calls.length, 1);
    assert.deepEqual(JSON.parse(result.calls[0].arguments), { command: 'echo test' });
    assert.equal(result.blocks[0].text, '先读取上下文。\n');
    assert.ok(!result.output.some((chunk) => /DSML/.test(chunk.text ?? chunk.block?.text ?? '')));
    assert.deepEqual(result.output.slice(-4).map((chunk) => chunk.type),
      ['block-start', 'tool-call-delta', 'block-end', 'finish']);
  }
});

test('多个工具独立 ID，保留工具名称及 JSON 类型', async () => {
  const body = invoke('read', '<｜DSML｜ parameter name="path" string="true">a.txt</｜DSML｜ parameter>')
    + invoke('bash', '<parameter name="command">echo test</parameter><parameter name="count" string="false">2</parameter>'
      + '<parameter name="options" string="false">{"mode":"read"}</parameter>');
  const result = await run(chunks(root(body)));
  assert.deepEqual(result.calls.map((call) => call.name), ['read', 'bash']);
  assert.equal(new Set(result.calls.map((call) => call.id)).size, 2);
  assert.equal(JSON.parse(result.calls[1].arguments).count, 2);
});

test('完整块权威内容及只有 delta / 只有 block-end 都可转换', async () => {
  const full = chunks(sample);
  for (const input of [full.filter((chunk) => chunk.type !== 'block-end'),
    full.filter((chunk) => chunk.type !== 'reasoning-delta')]) {
    const result = await run(input);
    assert.equal(result.calls.length, 1);
    assert.equal(result.finish.kind, 'tool-calls');
  }
});

test('正文中的完整独立 DSML 也可转换', async () => {
  const input = chunks(sample).map((chunk) => ({ ...chunk,
    ...(chunk.type === 'reasoning-delta' ? { type: 'text-delta' } : {}),
    ...(chunk.blockType ? { blockType: 'text' } : {}),
    ...(chunk.block ? { block: { ...chunk.block, type: 'text' } } : {}),
  }));
  assert.equal((await run(input)).calls.length, 1);
});

test('已经收到原生工具调用时不再转换 DSML', async () => {
  const input = chunks(sample);
  input.splice(0, 0, { type: 'block-start', index: 8, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 8, id: 'native', name: 'bash', argumentsDelta: '{"command":"native"}' },
    { type: 'block-end', index: 8, block: { type: 'tool-call', id: 'native', name: 'bash', arguments: '{"command":"native"}' } });
  const result = await run(input);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].id, 'native');
});

test('代码围栏及行内示例保持原文且不执行', async () => {
  for (const text of [`示例 ${root()}`, `\`\`\`xml\n${root()}\n\`\`\``, `~~~xml\n${root()}\n~~~`]) {
    const result = await run(chunks(text, [...text]));
    assert.equal(result.calls.length, 0);
    assert.equal(result.blocks[0].text, text);
  }
});

test('未声明工具、缺参、重复参数、类型/枚举不符以及未闭合段明确失败', async () => {
  const invalid = [root(invoke('unknown')), root(invoke('bash', '')),
    root(invoke('bash', '<parameter name="command" string="false">12</parameter>')),
    root(invoke('bash', '<parameter name="command" string="true">x</parameter>'.repeat(2))),
    root(invoke('bash', '<parameter name="command" string="true">x</parameter><parameter name="count" string="false">1.5</parameter>')),
    root(invoke('bash', '<parameter name="command" string="true">x</parameter><parameter name="options" string="false">{"mode":"write"}</parameter>')),
    root().slice(0, -8), '<｜DSML｜ calls'];
  for (const text of invalid) {
    const result = await run(chunks(text));
    assert.equal(result.finish.kind, 'error', text);
    assert.equal(result.calls.length, 0);
  }
});

test('未知参数和非法 JSON 不做强制类型转换或默认填充', () => {
  assert.throws(() => parseDsml(root(invoke('bash', '<parameter name="extra" string="false">false</parameter>')), tools));
  assert.throws(() => parseDsml(root(invoke('bash', '<parameter name="command" string="false">invalid</parameter>')), tools));
});

test('DSML 闭合前上游失败、截断、取消以及缺失 finish 不生成调用', async () => {
  const partial = sample.slice(0, -8);
  for (const kind of ['error', 'aborted', 'max-tokens']) {
    const result = await run(chunks(partial, [partial], kind));
    assert.equal(result.finish.kind, kind);
    assert.equal(result.calls.length, 0);
  }
  const abort = new AbortController(); abort.abort();
  assert.equal((await run(chunks(sample), { signal: abort.signal })).calls.length, 0);
  assert.equal((await run(chunks(partial).slice(0, -1))).calls.length, 0);
});

test('完整合法 DSML 立即提交并关闭上游，不等待后续重复思考或原生调用', async () => {
  let disposed = false;
  let consumedTail = false;
  async function* repeating() {
    try {
      yield chunks(sample)[0];
      yield { type: 'reasoning-delta', index: 0, text: sample + '\n继续重复。' + root() };
      consumedTail = true;
      throw new Error('不应读取调用后的重复流');
    } finally { disposed = true; }
  }
  const output = [];
  for await (const chunk of convertDsml(repeating(), { tools })) output.push(chunk);
  assert.equal(output.at(-1).reason.kind, 'tool-calls');
  assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 1);
  assert.ok(disposed);
  assert.equal(consumedTail, false);
});

test('变化响应丢弃 replayState，普通流完全保留', async () => {
  const input = chunks(sample);
  input.at(-1).replayState = { test: true };
  assert.equal((await run(input)).output.at(-1).replayState, undefined);
  const plain = chunks('正常思考与回答');
  plain.at(-1).replayState = { test: true };
  assert.deepEqual((await run(plain)).output, plain);
});

test('上游异常传播，提前停止和缓冲溢出都会清理源迭代器', async () => {
  let disposed = false;
  async function* broken() { try { yield chunks('abc')[0]; throw new Error('upstream'); } finally { disposed = true; } }
  await assert.rejects(async () => { for await (const _ of convertDsml(broken(), { tools })) {} }, /upstream/);
  assert.ok(disposed);
  disposed = false;
  async function* large() { try { yield* chunks(root(invoke('bash', '<parameter name="command" string="true">' + 'x'.repeat(200) + '</parameter>'))); } finally { disposed = true; } }
  const output = [];
  for await (const chunk of convertDsml(large(), { tools }, { maxBufferChars: 100 })) output.push(chunk);
  assert.equal(output.at(-1).reason.kind, 'error');
  assert.ok(disposed);
  disposed = false;
  async function* endless() { try { yield* chunks('ordinary'); } finally { disposed = true; } }
  for await (const _ of convertDsml(endless(), { tools })) break;
  assert.ok(disposed);
});
