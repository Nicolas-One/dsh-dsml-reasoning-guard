/** 识别代码围栏外、独立成行的 ChatML 工具头，不解析或执行其中的代码。@author wwj */
export class ChatmlDetector {
  line = '';
  fence;
  tool;

  inspect(complete) {
    if (!this.fence) {
      const header = /^[ \t]*<\|im_start\|>tool:([\w.:-]+)(?:[ \t\r]|$)/.exec(this.line);
      // 行尚未结束时必须看到工具名分隔符，避免根据不完整头部下结论。
      if (header && (complete || /[ \t\r]$/.test(header[0]))) this.tool = header[1];
    }
    if (!complete) return;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(this.line);
    if (!marker) return;
    if (!this.fence) this.fence = marker[1];
    else if (marker[1][0] === this.fence[0] && marker[1].length >= this.fence.length
      && !marker[2].trim()) this.fence = undefined;
  }

  push(text, final = false) {
    let start = 0;
    while (start < text.length && !this.tool) {
      const end = text.indexOf('\n', start);
      const stop = end === -1 ? text.length : end;
      // 只检查行头；普通长正文不进入无界缓冲。
      this.line += text.slice(start, Math.min(stop, start + Math.max(0, 512 - this.line.length)));
      this.inspect(end !== -1);
      if (end === -1) break;
      this.line = '';
      start = end + 1;
    }
    if (final && !this.tool) this.inspect(true);
    return this.tool;
  }
}

export function chatmlFailure() {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: 'CHATML_TOOL_LEAK',
        message: '模型将工具调用输出为 ChatML 文本，已停止生成以避免重复循环；该调用未执行。',
      },
    },
  };
}
