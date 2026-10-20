import assert from 'node:assert/strict';
import test from 'node:test';
import { guardStream } from '../stream.js';
import { chunks, collect, options } from './helpers.js';

// 仅保留真实故障的协议形态；不包含用户路径，也不执行代码。
const leak = '先读取技能。\n\n<|im_start|>tool:run_code\n'
  + 'const r = await tools.read({ file_path: "/example/SKILL.md" });\n'
  + 'console.log(r.lines.map(l => `${l.number}: ${l.text}`).join("\\n"));\n<|im_end|>';

function assertRejected(output) {
  assert.equal(output.at(-1).reason.kind, 'error');
  assert.equal(output.at(-1).reason.failure.code, 'CHATML_TOOL_LEAK');
  assert.equal(output.filter((chunk) => chunk.type === 'tool-call-delta').length, 0);
  assert.equal(output.at(-1).replayState, undefined);
}

test('ChatML 原始代码不猜测为工具参数，全部双分片和逐字符分片均及时结束', async () => {
  for (const parts of [[...leak], ...Array.from({ length: leak.length + 1 }, (_, i) => [leak.slice(0, i), leak.slice(i)])]) {
    const output = await collect(guardStream(chunks(leak, parts), options));
    assertRejected(output);
  }
});

test('真实故障形态：没有 finish 的无限源在首次工具头后关闭，不消费后续重复', async () => {
  let closed = false;
  let readAfterHeader = false;
  async function* source() {
    try {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: leak };
      readAfterHeader = true;
      // 有界替身模拟不会结束的重复流，避免缺陷实现使测试自身挂起。
      for (let i = 0; i < 100; i++) yield { type: 'reasoning-delta', index: 0, text: leak };
    } finally { closed = true; }
  }
  const output = await collect(guardStream(source(), options));
  assertRejected(output);
  assert.equal(closed, true);
  assert.equal(readAfterHeader, false);
  assert.equal(output.find((chunk) => chunk.type === 'block-end').block.text, leak);
});

test('正文与只有 block-end 的适配器也识别 ChatML 工具头', async () => {
  for (const type of ['text', 'reasoning']) {
    const output = await collect(guardStream([
      { type: 'block-start', index: 0, blockType: type },
      { type: 'block-end', index: 0, block: { type, text: leak } },
    ], options));
    assertRejected(output);
    assert.equal(output.find((chunk) => chunk.type === 'block-end').block.text, leak);
  }
});

test('行内讲解、代码围栏和普通 ChatML 对话示例保持原样', async () => {
  for (const text of [
    '说明：<|im_start|>tool:run_code 不是普通工具事件。',
    `\`\`\`text\n${leak}\n\`\`\``,
    `~~~text\n${leak}\n~~~`,
    '<|im_start|>assistant\n回答\n<|im_end|>',
    '<|im_start|>toolbox\n内容',
  ]) {
    const output = await collect(guardStream(chunks(text, [...text]), options));
    assert.equal(output.at(-1).reason.kind, 'stop');
    assert.equal(output.find((chunk) => chunk.type === 'block-end').block.text, text);
  }
});
