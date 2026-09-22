import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'bridge.log');

export function logToFile(type, data) {
  const line = `[${new Date().toISOString()}] [${type}] ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
  fs.appendFile(LOG_FILE, line, () => {});
}

export { LOG_FILE };
