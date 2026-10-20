/** 保留 dsh 流式契约，只在成功结束时恢复完整调用。@author wwj */
import { randomUUID } from 'node:crypto';
import { findCallStart, parseCalls, stripTags, stripThink, TagCleaner } from './dsml.js';

const MAX_CAPTURE = 2 * 1024 * 1024;

export async function* guardStream(source, options, report = () => {}) {
  const blocks = new Map();
  const indices = new Set();
  let captured = 0;
  let overflow = false;
  let changed = false;
  let nativeCall = false;
  let visibleText = false;
  let maxIndex = -1;
  let lastIndex;

  const getBlock = (index, type) => {
    if (!blocks.has(index)) blocks.set(index, {
      type, raw: '', cleaner: new TagCleaner({ stripThink: type === 'text' }),
    });
    return blocks.get(index);
  };
  const remember = (block, text, complete = false) => {
    if (overflow) return;
    captured += text.length - (complete ? block.raw.length : 0);
    if (captured > MAX_CAPTURE) {
      overflow = true;
      for (const value of blocks.values()) value.raw = '';
      report('capture limit reached; recovery skipped');
      return;
    }
    block.raw = complete ? text : block.raw + text;
  };
  function* flush(index) {
    const block = blocks.get(index);
    if (!block?.cleaner.pending) return;
    const text = block.cleaner.push('', true);
    if (text) yield { type: `${block.type}-delta`, index, text };
  }

  // 不吞异常；源流报错、取消及迭代器清理沿原链路传播。
  for await (const chunk of source) {
    if (Number.isInteger(chunk.index)) {
      maxIndex = Math.max(maxIndex, chunk.index);
      if (!indices.has(chunk.index)) {
        indices.add(chunk.index);
        lastIndex = chunk.index;
      }
    }
    if (chunk.type === 'block-start') {
      if (chunk.blockType === 'tool-call') nativeCall = true;
    }
    if (chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call') nativeCall = true;

    if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
      const type = chunk.type === 'reasoning-delta' ? 'reasoning' : 'text';
      const block = getBlock(chunk.index, type);
      remember(block, chunk.text);
      if (type === 'text' && chunk.text.trim()) visibleText = true;
      const text = block.cleaner.push(chunk.text);
      if (block.cleaner.changed) changed = true;
      if (text) yield text === chunk.text ? chunk : { ...chunk, text };
      continue;
    }

    if (chunk.type === 'block-end' && ['reasoning', 'text'].includes(chunk.block.type)) {
      const block = getBlock(chunk.index, chunk.block.type);
      remember(block, chunk.block.text, true);
      block.closed = true;
      if (block.type === 'text' && chunk.block.text.trim()) visibleText = true;
      yield* flush(chunk.index);
      // block-end 是宿主的最终权威内容，必须与 delta 一起处理。
      block.callMarkup = block.type === 'reasoning' && Boolean(findCallStart(chunk.block.text));
      const unparsed = block.callMarkup && !parseCalls(chunk.block.text, options.tools);
      // 解析失败不能再抹掉唯一的诊断原文，保留权威块供排查。
      const visible = block.type === 'text' ? stripThink(chunk.block.text) : chunk.block.text;
      const text = unparsed ? chunk.block.text : stripTags(visible);
      if (text !== chunk.block.text) changed = true;
      yield text === chunk.block.text ? chunk : { ...chunk, block: { ...chunk.block, text } };
      continue;
    }

    if (chunk.type === 'finish') {
      for (const index of blocks.keys()) yield* flush(index);
      const block = blocks.get(lastIndex);
      const eligible = chunk.reason.kind === 'stop' && !options.signal?.aborted && !options.purpose
        && !nativeCall && !visibleText && block?.type === 'reasoning';
      const calls = eligible && !overflow ? parseCalls(block.raw, options.tools) : undefined;
      const unrecoverable = eligible && !calls && (block.callMarkup || Boolean(findCallStart(block.raw)));
      if (unrecoverable && !block.closed && !overflow) {
        // 只有 delta 的适配器也保留失败原文，避免清洗后丢失诊断依据。
        yield { type: 'block-end', index: lastIndex, block: { type: 'reasoning', text: block.raw } };
      }
      if (calls) {
        for (const call of calls) {
          const index = ++maxIndex;
          const id = `dsml-${randomUUID()}`;
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, ...call } };
        }
        report(`recovered ${calls.length} tool call(s)`);
      } else if (block?.raw.includes('｜DSML｜')) {
        report('DSML detected; no tool calls recovered');
      }
      if (changed || calls || unrecoverable) {
        // 文本或块发生变化后，旧签名与索引对齐信息不再可信。
        const { replayState, ...finish } = chunk;
        const reason = calls ? { kind: 'tool-calls' } : unrecoverable ? {
          kind: 'error',
          failure: { code: 'DSML_UNRECOVERABLE', message: '模型将工具调用输出为无法完整解析的 DSML；该调用未执行。' },
        } : finish.reason;
        yield { ...finish, reason };
      } else yield chunk;
      continue;
    }
    yield chunk;
  }
  for (const index of blocks.keys()) yield* flush(index);
}
