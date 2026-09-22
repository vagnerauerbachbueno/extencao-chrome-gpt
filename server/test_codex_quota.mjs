import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
const token = auth?.tokens?.access_token;
const accountId = auth?.tokens?.account_id;
const model = process.argv[2] || 'gpt-5.6-luna';

const body = {
  model,
  stream: false,
  store: false,
  input: [
    { role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: QUOTA_OK' }] }
  ]
};

const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'OpenAI-Beta': 'responses=experimental',
  'Origin': 'https://chatgpt.com',
  'Referer': 'https://chatgpt.com/',
  'User-Agent': 'codex_cli_rs/0.118.0 (Windows NT 10.0; Win64; x64) Rust/1.93.0',
  'oai-client-version': 'codex_cli_rs 0.118.0',
};
if (accountId) headers['chatgpt-account-id'] = accountId;

const url = 'https://chatgpt.com/backend-api/codex/responses';
console.log('POST', url, model);

const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
const text = await res.text();
console.log('status:', res.status);
if (!res.ok) {
  console.log('body:', text.slice(0, 2000));
  process.exit(2);
}
let parsed;
try { parsed = JSON.parse(text); } catch {}
const out =
  parsed?.output_text ||
  parsed?.output?.map?.(o => (o?.content || []).map(c => c?.text || '').join('')).filter(Boolean).join('\n') ||
  text.slice(0, 800);
console.log('response:', out);
console.log('QUOTA_OK');
