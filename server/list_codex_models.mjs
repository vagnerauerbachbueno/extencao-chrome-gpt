import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
const token = auth?.tokens?.access_token;
const accountId = auth?.tokens?.account_id;

const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Origin': 'https://chatgpt.com',
  'Referer': 'https://chatgpt.com/',
  'User-Agent': 'codex_cli_rs/0.118.0 (Windows NT 10.0; Win64; x64) Rust/1.93.0',
  'oai-client-version': 'codex_cli_rs 0.118.0',
};
if (accountId) headers['chatgpt-account-id'] = accountId;

const url = 'https://chatgpt.com/backend-api/codex/models?client_version=0.118.0';
const res = await fetch(url, { headers });
const text = await res.text();
console.log('status', res.status);
try {
  const j = JSON.parse(text);
  const models = j.models || j.data || j;
  if (Array.isArray(models)) {
    for (const m of models) {
      console.log('-', m.slug || m.id || m.name, '|', m.title || m.name || '');
    }
  } else {
    console.log(JSON.stringify(j).slice(0, 3000));
  }
} catch {
  console.log(text.slice(0, 3000));
}
