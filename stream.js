/** 首个完整、校验通过的 DSML 结束当前生成，执行由宿主负责。@author wwj */
import { randomUUID } from 'node:crypto';
import { DsmlTextBuffer } from './text-buffer.js';
import { parseDsml } from './parser.js';

export async function* convertDsml(source, options, { maxBufferChars = 1048576, report = () => {} } = {}) {
  const blocks = new Map();
  let maxIndex = -1;
  let native = false;
  let changed = false;
  let captureSize = 0;
  const state = (index, type) => {
    if (!blocks.has(index)) blocks.set(index, { type, visible: '', buffer: new DsmlTextBuffer(maxBufferChars) });
    return blocks.get(index);
  };
  const failure = (message) => ({
    type: 'finish', reason: { kind: 'error', failure: { code: 'DSML_INVALID_CALL', message } },
  });
  function* commit(block, index, closeBlock) {
    try {
      if ([...blocks.values()].filter((value) => value.buffer.captured).length !== 1) {
        throw new Error('多个文本块包含未完成的 DSML，不能确定调用边界');
      }
      const calls = parseDsml(block.buffer.captured, options.tools);
      if (closeBlock) yield { type: 'block-end', index, block: { type: block.type, text: block.visible } };
      for (const call of calls) {
        const callIndex = ++maxIndex;
        const id = `call_dsml_${randomUUID()}`;
        yield { type: 'block-start', index: callIndex, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: callIndex, id, name: call.name, argumentsDelta: call.arguments };
        yield { type: 'block-end', index: callIndex, block: { type: 'tool-call', id, ...call } };
      }
      report({ status: 'recovered', count: calls.length });
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } catch (error) {
      report({ status: 'rejected', reason: error.message });
      yield failure(error.message);
    }
  }

  for await (const chunk of source) {
    if (Number.isInteger(chunk.index)) maxIndex = Math.max(maxIndex, chunk.index);
    if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call')
      || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call') native = true;

    if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
      const block = state(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning');
      let visible;
      try {
        const before = block.buffer.captured.length;
        visible = block.buffer.push(chunk.text);
        captureSize += block.buffer.captured.length - before;
        if (captureSize > maxBufferChars) throw new Error('DSML 总缓冲超过限制');
      } catch (error) {
        yield failure(error.message);
        return;
      }
      if (visible !== chunk.text) changed = true;
      block.visible += visible;
      if (visible) yield { ...chunk, text: visible };
      if (block.buffer.completed && !native && !options.signal?.aborted) {
        yield* commit(block, chunk.index, true);
        return;
      }
      continue;
    }

    if (chunk.type === 'block-end' && ['reasoning', 'text'].includes(chunk.block.type)) {
      const block = state(chunk.index, chunk.block.type);
      // block-end 是最终权威文本，独立解析，不能把已隐藏的 DSML 再送回宿主。
      const authoritative = new DsmlTextBuffer(maxBufferChars);
      let visible;
      try { visible = authoritative.push(chunk.block.text) + authoritative.end(); }
      catch (error) { yield failure(error.message); return; }
      block.buffer = authoritative;
      block.visible = visible;
      block.closed = true;
      if (visible !== chunk.block.text) changed = true;
      yield visible === chunk.block.text ? chunk : { ...chunk, block: { ...chunk.block, text: visible } };
      if (block.buffer.completed && !native && !options.signal?.aborted) {
        yield* commit(block, chunk.index, false);
        return;
      }
      continue;
    }

    if (chunk.type === 'finish') {
      for (const [index, block] of blocks) {
        if (!block.closed) {
          const text = block.buffer.end();
          if (text) yield { type: `${block.type}-delta`, index, text };
        }
      }
      const candidates = [...blocks.entries()].filter(([, block]) => block.buffer.captured);
      const successful = ['stop', 'tool-calls'].includes(chunk.reason.kind) && !options.signal?.aborted;
      if (candidates.length && successful && !native) {
        yield failure('DSML 未完整闭合，该调用未执行');
        return;
      }
      if (changed) {
        // 内容变化后上游签名和回放游标失效；让下次请求按标准历史序列化。
        const { replayState, ...finish } = chunk;
        yield finish;
      } else yield chunk;
      return;
    }
    yield chunk;
  }
  // 没有 finish 的流不能提交工具调用；仍保留普通标签探测尾部。
  for (const [index, block] of blocks) {
    if (!block.closed) {
      const text = block.buffer.end();
      if (text) yield { type: `${block.type}-delta`, index, text };
    }
  }
}
