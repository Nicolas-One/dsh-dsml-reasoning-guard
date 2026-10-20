import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCalls, stripTags } from '../dsml.js';
import { guardStream } from '../stream.js';
import { chunks, collect, leaked, options, tools } from './helpers.js';

// 新失败消息保留了裸 parameter 且没有 string 属性；其余前缀标签已被旧版清洗。
const mixed = leaked.replace('<｜DSML｜ parameter name="code" string="true">', '<parameter name="code">');

test('混合前缀且省略 string 的参数按已声明字符串 schema 恢复', async () => {
  const calls = parseCalls(mixed, tools);
  assert.equal(calls?.length, 1);
  assert.equal(JSON.parse(calls[0].arguments).code, 'const value: number = 1; return value;');
  for (const parts of [[mixed], [...mixed]]) {
    const output = await collect(guardStream(chunks(mixed, parts), options));
    assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 1);
    assert.equal(output.at(-1).reason.kind, 'tool-calls');
    const deltas = output.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('');
    const final = output.find((chunk) => chunk.type === 'block-end').block.text;
    assert.equal(deltas, final);
    assert.ok(!final.includes('<parameter'));
  }
});

test('完整 DSML 根内支持裸 invoke 与 parameter 的混合闭合标签', () => {
  const text = leaked.replaceAll(/<\/?｜DSML｜\s*(invoke|parameter)/g, (tag) => tag.replace(/｜DSML｜\s*/, ''));
  assert.equal(parseCalls(text, tools)?.length, 1);
  assert.ok(!stripTags(text).includes('<parameter'));
  assert.equal(stripTags('技术正文 <parameter name="code">x</parameter>'), '技术正文 <parameter name="code">x</parameter>');
});

test('无法恢复的完整根保留权威原文，并以明确错误结束', async () => {
  const text = mixed.replace('run_code', 'unregistered_tool');
  for (const end of [true, false]) {
    const output = await collect(guardStream(chunks(text, [...text], end), options));
    assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
    assert.equal(output.find((chunk) => chunk.type === 'block-end').block.text, text);
    assert.equal(output.at(-1).reason.kind, 'error');
    assert.equal(output.at(-1).reason.failure.code, 'DSML_UNRECOVERABLE');
  }
});

test('缺少 string 时只按参数 schema 确认字符串，不猜测未知类型', () => {
  const untyped = [{ ...tools[0], parameters: { ...tools[0].parameters, properties: { description: { type: 'string' } } } }];
  assert.equal(parseCalls(mixed, untyped), undefined);
});

test('没有完整外层的历史清洗残片不生成工具调用', async () => {
  const text = '<parameter name="code">const a = 1;\n读取描述';
  const output = await collect(guardStream(chunks(text), options));
  assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
});
