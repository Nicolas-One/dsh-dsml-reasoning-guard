import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { convertDsml } from '../stream.js';

export const tools = [{ name: 'bash', description: 'shell', parameters: {
  type: 'object', properties: { command: { type: 'string' }, count: { type: 'integer' },
    options: { type: 'object', properties: { mode: { enum: ['read'] } }, required: ['mode'] } },
  required: ['command'], additionalProperties: false,
} }, { name: 'read', description: 'read', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} }];

export const invoke = (name = 'bash', args = '<｜DSML｜ parameter name="command" string="true">echo test</｜DSML｜ parameter>') =>
  `<｜DSML｜ invoke name="${name}">${args}</｜DSML｜ invoke>`;
export const root = (body = invoke()) => `<｜DSML｜ calls>\n${body}\n</｜DSML｜ calls>`;
export const sample = `先读取上下文。\n${root()}`;
export const source = async function* (chunks) { yield* chunks; };
export const chunks = (text, parts = [text], kind = 'stop') => [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  ...parts.map((part) => ({ type: 'reasoning-delta', index: 0, text: part })),
  { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
  { type: 'usage', usage: { inputTokens: 8, outputTokens: 16 } },
  { type: 'finish', reason: { kind } },
];

export async function run(input, options = {}, settings = {}) {
  const output = [];
  const assembler = new BlockAssembler();
  for await (const chunk of convertDsml(source(input), { tools, ...options }, settings)) {
    output.push(chunk);
    assembler.push(chunk);
  }
  return { output, blocks: assembler.blocks(), finish: assembler.finish,
    calls: assembler.blocks().filter((block) => block.type === 'tool-call') };
}
