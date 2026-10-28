/** 完整 DSML 的顺序解析与工具参数校验；从不执行参数。@author wwj */
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strictSchema: false, strictTypes: false });
const validators = new WeakMap();

function readTag(input, expected, closing = false) {
  const match = /^<(\/?)(?:｜DSML｜\s*)?([a-z_]+)\b([^<>]*)>/.exec(input);
  if (!match || Boolean(match[1]) !== closing || match[2] !== expected) {
    throw new Error(`缺少 ${closing ? '/' : ''}${expected} 标签`);
  }
  const attributes = Object.create(null);
  let rest = match[3];
  while (rest.trim()) {
    const attr = /^\s+([a-z]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(rest);
    if (!attr || Object.hasOwn(attributes, attr[1])) throw new Error('标签属性不合法或重复');
    attributes[attr[1]] = attr[2] ?? attr[3];
    rest = rest.slice(attr[0].length);
  }
  if (closing && Object.keys(attributes).length) throw new Error('结束标签不能包含属性');
  return { length: match[0].length, attributes };
}

function checkAttributes(attributes, allowed, required) {
  if (Object.keys(attributes).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(attributes, key))) throw new Error('标签属性不匹配');
}

function validate(tool, args) {
  let validator = validators.get(tool);
  if (!validator) {
    validator = ajv.compile(tool.parameters ?? { type: 'object' });
    validators.set(tool, validator);
  }
  if (!validator(args)) throw new Error(`工具 ${tool.name} 的参数不符合 schema`);
}

export function parseDsml(input, tools = []) {
  const root = /^<｜DSML｜\s*(calls|tool_calls)\s*>/.exec(input);
  if (!root) throw new Error('缺少 DSML 根标签');
  let rest = input.slice(root[0].length).trimStart();
  const calls = [];
  const endRoot = new RegExp(`^</｜DSML｜\\s*${root[1]}\\s*>`);
  while (!endRoot.test(rest)) {
    const invoke = readTag(rest, 'invoke');
    checkAttributes(invoke.attributes, ['name'], ['name']);
    const tool = tools.find((candidate) => candidate.name === invoke.attributes.name);
    if (!tool) throw new Error(`工具未在当前请求声明：${invoke.attributes.name}`);
    rest = rest.slice(invoke.length).trimStart();
    const args = Object.create(null);
    while (!/^<\/(?:｜DSML｜\s*)?invoke\b/.test(rest)) {
      const parameter = readTag(rest, 'parameter');
      checkAttributes(parameter.attributes, ['name', 'string'], ['name']);
      const { name, string } = parameter.attributes;
      if (Object.hasOwn(args, name)) throw new Error('参数重复');
      if (string !== undefined && !['true', 'false'].includes(string)) throw new Error('string 属性不合法');
      rest = rest.slice(parameter.length);
      const close = /<\/(?:｜DSML｜\s*)?parameter\s*>/.exec(rest);
      if (!close) throw new Error('parameter 未闭合');
      const raw = rest.slice(0, close.index);
      const inferredString = string === undefined && tool.parameters?.properties?.[name]?.type === 'string';
      args[name] = string === 'true' || inferredString ? raw : JSON.parse(raw);
      rest = rest.slice(close.index + close[0].length).trimStart();
    }
    const close = readTag(rest, 'invoke', true);
    rest = rest.slice(close.length).trimStart();
    validate(tool, args);
    calls.push({ name: tool.name, arguments: JSON.stringify(args) });
    if (calls.length > 64) throw new Error('DSML 调用超过 64 个');
  }
  rest = rest.slice(endRoot.exec(rest)[0].length);
  if (rest.trim() || !calls.length) throw new Error('DSML 为空或包含尾部正文');
  return calls;
}
