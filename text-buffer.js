/** 按字符保留候选标签，避免标签跨 SSE 分片泄漏；代码围栏原样保留。@author wwj */
const PREFIX = '<｜DSML｜';
const NAMES = ['calls', 'tool_calls'];
const OPEN = /^<｜DSML｜\s*(?:calls|tool_calls)\s*>$/;

function possibleOpening(value) {
  if (PREFIX.startsWith(value)) return true;
  if (!value.startsWith(PREFIX)) return false;
  const tail = value.slice(PREFIX.length).trimStart();
  return NAMES.some((name) => name.startsWith(tail)
    || (tail.startsWith(name) && /^\s*>?$/.test(tail.slice(name.length))));
}

export class DsmlTextBuffer {
  mode = 'normal';
  pending = '';
  captured = '';
  completed = false;
  captureTail = '';
  rootName = '';
  closePattern;
  line = '';
  whitespace = true;
  fence;

  constructor(limit) { this.limit = limit; }

  track(char) {
    if (char === '\n') {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(this.line);
      if (match) {
        if (!this.fence) this.fence = match[1];
        else if (match[1][0] === this.fence[0] && match[1].length >= this.fence.length
          && !match[2].trim()) this.fence = undefined;
      }
      this.line = '';
      this.whitespace = true;
    } else {
      if (this.line.length < 256) this.line += char;
      if (char !== ' ' && char !== '\t' && char !== '\r') this.whitespace = false;
    }
  }

  push(text) {
    let visible = '';
    for (const char of text) {
      if (this.completed) break;
      if (this.mode === 'capture') {
        this.captured += char;
        if (this.captured.length > this.limit) throw new Error('DSML 缓冲超过限制');
        this.captureTail = (this.captureTail + char).slice(-128);
        if (this.closePattern.test(this.captureTail)) this.completed = true;
        continue;
      }
      if (this.mode === 'probe' || (char === '<' && this.whitespace && !this.fence)) {
        this.mode = 'probe';
        this.pending += char;
        if (OPEN.test(this.pending)) {
          this.mode = 'capture';
          this.captured = this.pending;
          this.rootName = /(?:calls|tool_calls)/.exec(this.pending)[0];
          this.closePattern = new RegExp(`</｜DSML｜\\s*${this.rootName}\\s*>$`);
          this.pending = '';
        } else if (this.pending.length > 128 || !possibleOpening(this.pending)) {
          const literal = this.pending;
          this.pending = '';
          this.mode = 'normal';
          visible += literal;
          for (const value of literal) this.track(value);
        }
        continue;
      }
      visible += char;
      this.track(char);
    }
    return visible;
  }

  end() {
    if (this.pending.startsWith(PREFIX)) {
      this.captured = this.pending;
      this.pending = '';
      return '';
    }
    const remainder = this.pending;
    this.pending = '';
    return remainder;
  }
}
