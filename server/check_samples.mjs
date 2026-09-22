import { parseToolCalls } from './src/parser.js';

const samples = [
  '{"tool_call":{"name":"bash","arguments":{"command":"Get-Date"}}}',
  '{"tool_call":{"name":"glob","arguments":{"pattern":"**/*","path":"C:\\Users\\vagne\\Desktop\\extencao-chrome-gpt"}}}',
  '{"tool_call":{"name":"read","arguments":{"filePath":"C:\\Users\\vagne\\Desktop\\extencao-chrome-gpt\\server\\src\\index.js","offset":180,"limit":180}}}',
  '```json\n{"tool_call":{"name":"glob","arguments":{"pattern":"**/*"}}}\n```'
];

let failed = 0;
for (const s of samples) {
  const r = parseToolCalls(s);
  const ok = r && r.length > 0 && r[0].function.name;
  console.log(ok ? 'OK ' : 'FAIL', ok ? r[0].function.name + ' ' + r[0].function.arguments : 'null', '<=', s.slice(0, 70));
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
