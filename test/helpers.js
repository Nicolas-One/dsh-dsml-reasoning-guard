/** 复现实际泄漏格式；测试工具只记录参数，不执行代码。@author wwj */
export const tools = [{
  name: 'run_code',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' }, description: { type: 'string' } },
    required: ['code', 'description'],
    additionalProperties: false,
  },
}];
export const options = { model: 'r4/deepseek-v4.1-flash', provider: 'company', tools };
export const invocation = `<｜DSML｜ invoke name="run_code">
<｜DSML｜ parameter name="code" string="true">const value: number = 1; return value;</｜DSML｜ parameter>
<｜DSML｜ parameter name="description" string="true">读取用例锚点</｜DSML｜ parameter>
</｜DSML｜ invoke>`;
export const leaked = `先读取用例锚点。\n\n<｜DSML｜ calls>\n${invocation}\n</｜DSML｜ calls>`;
export const finish = { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {}, blocks: [{ type: 'reasoning' }] } };
export function chunks(text = leaked, parts = [text], end = true) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...parts.map((part) => ({ type: 'reasoning-delta', index: 0, text: part })),
    ...(end ? [{ type: 'block-end', index: 0, block: { type: 'reasoning', text } }] : []),
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } },
    finish,
  ];
}
export async function collect(stream) {
  const output = [];
  for await (const chunk of stream) output.push(chunk);
  return output;
}
