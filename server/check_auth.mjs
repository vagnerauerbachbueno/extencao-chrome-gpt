import json from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const p = path.join(os.homedir(), '.codex', 'auth.json');
const data = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('top_keys:', Object.keys(data).sort().join(', '));
console.log('auth_mode:', data.auth_mode);
console.log('last_refresh:', data.last_refresh);
const tokens = data.tokens;
if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
  console.log('token_keys:', Object.keys(tokens).sort().join(', '));
  const at = tokens.access_token || '';
  const rt = tokens.refresh_token;
  console.log('has_access:', !!at, 'len', at.length);
  console.log('has_refresh:', !!rt);
  const parts = at.split('.');
  if (parts.length >= 2) {
    try {
      const pad = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
      const payload = JSON.parse(Buffer.from(pad, 'base64url').toString('utf8'));
      const exp = payload.exp;
      console.log('exp:', exp, exp ? new Date(exp * 1000).toLocaleString() : null);
      console.log('now:', new Date().toLocaleString());
      console.log('expired:', !!(exp && exp * 1000 < Date.now()));
      console.log('scope:', payload.scope);
    } catch (e) {
      console.log('decode_fail', e.message);
    }
  }
} else if (Array.isArray(tokens)) {
  console.log('tokens list len', tokens.length);
  if (tokens[0] && typeof tokens[0] === 'object') console.log('elem0 keys', Object.keys(tokens[0]).join(', '));
} else {
  console.log('tokens type', typeof tokens);
}
