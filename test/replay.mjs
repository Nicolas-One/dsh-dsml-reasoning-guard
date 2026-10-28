/** stdin 只接收本地历史消息并解析组装，绝不执行历史工具。@author wwj */
import { run } from './helpers.js';
let input = '';
for await (const value of process.stdin) input += value;
const rows = JSON.parse(input);
const summary = { messages: rows.length, recovered: 0, rejected: 0, preserved: 0, tools: {}, reasons: {} };
for (const row of rows) {
  const input = [];
  row.blocks.forEach((block, index) => {
    input.push({ type: 'block-start', index, blockType: block.type });
    if (['text', 'reasoning'].includes(block.type)) {
      for (let offset = 0; offset < block.text.length; offset += 7) {
        input.push({ type: `${block.type}-delta`, index, text: block.text.slice(offset, offset + 7) });
      }
    } else if (block.type === 'tool-call') {
      input.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments });
    }
    input.push({ type: 'block-end', index, block });
  });
  input.push({ type: 'finish', reason: { kind: 'stop' } });
  const result = await run(input, { tools: row.tools });
  const recovered = result.calls.filter((call) => call.id.startsWith('call_dsml_'));
  if (recovered.length) {
    summary.recovered++;
    for (const call of recovered) summary.tools[call.name] = (summary.tools[call.name] ?? 0) + 1;
  } else if (result.finish.kind === 'error') {
    summary.rejected++;
    const reason = result.finish.failure.message;
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
  }
  else summary.preserved++;
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
