/** DSML 文本处理；参数中的代码只作为字符串读取。@author wwj */
const MARKERS = ['<｜DSML｜', '</｜DSML｜', '<parameter', '</parameter', '<invoke', '</invoke', '<think', '</think'];
const TAG = /<(\/?)(?:(｜DSML｜)\s*(calls|tool_calls|invoke|parameter)|(invoke|parameter))\b[^>]*>/g;
const THINK_OPEN = /^\s*<think(?:\s[^>]*)?>/i;
const THINK_CLOSE = /<\/think\s*>/i;

function cleanTags(text, state) {
  return text.replace(TAG, (tag, closing, prefix, prefixedName) => {
    // 裸 XML 标签仅在明确的 DSML 调用根内清洗，避免误伤普通正文示例。
    if (!prefix) return state.inCalls ? '' : tag;
    if (prefixedName === 'calls' || prefixedName === 'tool_calls') state.inCalls = !closing;
    return '';
  });
}

export function stripTags(text) {
  return cleanTags(text, { inCalls: false });
}

/** 清除可见文本中的模型思考包裹；普通正文中出现的 think 标签不处理。 */
export function stripThink(text) {
  const open = THINK_OPEN.exec(text);
  if (!open) return text.replace(THINK_CLOSE, '');
  const close = THINK_CLOSE.exec(text.slice(open[0].length));
  return close ? text.slice(0, open.index) + text.slice(open[0].length + close.index + close[0].length) : '';
}

/** 仅保留可能跨分片的标签前缀，普通文本立即透传。 */
export class TagCleaner {
  pending = '';
  changed = false;
  inCalls = false;
  thinkPending = '';
  thinkMode = 'unknown';
  stripThink = false;

  constructor({ stripThink: shouldStripThink = false } = {}) {
    this.stripThink = shouldStripThink;
  }

  cleanThink(text, final) {
    if (!this.stripThink) return text;
    if (this.thinkMode === 'plain') {
      const cleaned = text.replace(THINK_CLOSE, '');
      if (cleaned !== text) this.changed = true;
      return cleaned;
    }
    if (this.thinkMode === 'think') {
      const close = THINK_CLOSE.exec(text);
      if (!close) {
        if (final) this.changed = true;
        return '';
      }
      this.thinkMode = 'plain';
      this.changed = true;
      return text.slice(close.index + close[0].length);
    }
    const value = this.thinkPending + text;
    const open = THINK_OPEN.exec(value);
    if (open) {
      this.thinkMode = 'think';
      this.thinkPending = '';
      this.changed = true;
      return this.cleanThink(value.slice(open[0].length), final);
    }
    const close = /^\s*<\/think\s*>/i.exec(value);
    if (close) {
      this.thinkMode = 'plain';
      this.thinkPending = '';
      this.changed = true;
      return value.slice(close[0].length);
    }
    if (!final && value.length < 128 && /^(?:\s*<\/?[a-z]*)?$/i.test(value)) {
      this.thinkPending = value;
      return '';
    }
    this.thinkMode = 'plain';
    this.thinkPending = '';
    return value;
  }

  push(text, final = false) {
    let value = this.pending + text;
    this.pending = '';
    value = this.cleanThink(value, final);
    if (this.stripThink && final && this.thinkMode === 'unknown' && this.thinkPending) {
      value = this.thinkPending + value;
      this.thinkPending = '';
    }
    if (!final) {
      const start = value.lastIndexOf('<');
      if (start !== -1) {
        const tail = value.slice(start);
        const partial = MARKERS.some((marker) => marker.startsWith(tail) || tail.startsWith(marker));
        if (partial && !tail.includes('>') && tail.length <= 4096) {
          this.pending = tail;
          value = value.slice(0, start);
        }
      }
    }
    const cleaned = cleanTags(value, this);
    if (cleaned !== value) this.changed = true;
    return cleaned;
  }
}

/**
 * 只接受独立成行、完整闭合且位于末尾的调用段，拒绝代码围栏中的示例。
 * 未声明工具、重复参数、非法 JSON 和缺失必填参数均不恢复。
 */
export function findCallStart(text) {
  const root = /(?:^|\n)[ \t]*<｜DSML｜\s*(calls|tool_calls)\s*>/.exec(text);
  if (!root) return;
  const prefix = text.slice(0, root.index);
  let fence;
  for (const line of prefix.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
  }
  if (fence) return;
  return root;
}

export function parseCalls(text, tools = []) {
  const root = findCallStart(text);
  if (!root) return;
  const close = new RegExp(`</｜DSML｜\\s*${root[1]}\\s*>\\s*$`);
  const body = text.slice(root.index + root[0].length);
  const end = close.exec(body);
  if (!end) return;
  let remaining = body.slice(0, end.index).trim();
  const calls = [];
  while (remaining) {
    const invoke = /^<(?:｜DSML｜\s*)?invoke\s+name="([^"<>]+)"\s*>/.exec(remaining);
    if (!invoke) return;
    const tool = tools.find((candidate) => candidate.name === invoke[1]);
    if (!tool) return;
    remaining = remaining.slice(invoke[0].length).trimStart();
    const args = Object.create(null);
    while (!/^<\/(?:｜DSML｜\s*)?invoke\s*>/.test(remaining)) {
      const parameter = /^<(?:｜DSML｜\s*)?parameter\s+name="([^"<>]+)"(?:\s+string="(true|false)")?\s*>/.exec(remaining);
      if (!parameter || Object.hasOwn(args, parameter[1])) return;
      remaining = remaining.slice(parameter[0].length);
      const closing = /<\/(?:｜DSML｜\s*)?parameter\s*>/.exec(remaining);
      if (!closing) return;
      const value = remaining.slice(0, closing.index);
      try {
        const schemaString = parameter[2] === undefined
          && tool.parameters?.properties?.[parameter[1]]?.type === 'string';
        args[parameter[1]] = parameter[2] === 'true' || schemaString ? value : JSON.parse(value);
      } catch {
        return;
      }
      remaining = remaining.slice(closing.index + closing[0].length).trimStart();
    }
    const closing = /^<\/(?:｜DSML｜\s*)?invoke\s*>/.exec(remaining);
    remaining = remaining.slice(closing[0].length).trimStart();
    const schema = tool.parameters ?? {};
    if ((schema.required ?? []).some((key) => !Object.hasOwn(args, key))) return;
    if (schema.additionalProperties === false && Object.keys(args).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) return;
    calls.push({ name: tool.name, arguments: JSON.stringify(args) });
  }
  return calls.length ? calls : undefined;
}
