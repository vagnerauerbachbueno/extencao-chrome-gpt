import { createHash, randomUUID } from 'node:crypto';

const NAVIGATOR_KEYS = [
  ['Mozilla/5.0', 'Win32', '', 'en-US'],
  ['Mozilla/5.0', 'Win32', 'Google Inc.', 'en-US'],
];
const DOCUMENT_KEYS = [
  ['Chrome', 'internet explorer', 'extensions'],
  ['Chrome', '', 'plugins'],
];
const WINDOW_KEYS = [
  [1920, 1080, 16, 8, 24, 24],
  [2560, 1440, 16, 8, 24, 24],
  [1920, 1200, 16, 8, 24, 24],
];
const CORES = [8, 12, 16, 4];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseTime() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${pad(d.getDate())} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} GMT-0500 (Eastern Standard Time)`;
}

function buildConfig(userAgent) {
  return [
    pick([1920 + 1080, 2560 + 1440, 1920 + 1200, 2560 + 1600]),
    parseTime(),
    4294705152,
    0,
    userAgent,
    '',
    '',
    'en-US',
    'en-US,es-US,en,es',
    0,
    pick(NAVIGATOR_KEYS),
    pick(DOCUMENT_KEYS),
    pick(WINDOW_KEYS),
    Math.round(performance.now()),
    randomUUID(),
    '',
    pick(CORES),
    Date.now() - Math.round(performance.now()),
  ];
}

function compact(config, from, to) {
  const slice = to === undefined ? config.slice(from) : config.slice(from, to);
  return JSON.stringify(slice).slice(1, -1);
}

function generateAnswer(seed, diff, config) {
  const target = Buffer.from(diff, 'hex');
  const sliceLen = diff.length;
  const seedEncoded = Buffer.from(seed, 'utf8');
  const part1 = Buffer.from(`[${compact(config, 0, 3)},`, 'utf8');
  const part2 = Buffer.from(`,${compact(config, 4, 9)},`, 'utf8');
  const part3 = Buffer.from(`,${compact(config, 10)}]`, 'utf8');

  for (let i = 0; i < 500000; i++) {
    const dynI = Buffer.from(String(i), 'utf8');
    const dynJ = Buffer.from(String(i >> 1), 'utf8');
    const finalBytes = Buffer.concat([part1, dynI, part2, dynJ, part3]);
    const baseEncoded = finalBytes.toString('base64');
    const h = createHash('sha3-512')
      .update(Buffer.concat([seedEncoded, Buffer.from(baseEncoded, 'utf8')]))
      .digest();
    if (Buffer.compare(h.subarray(0, sliceLen), target) <= 0) {
      return [baseEncoded, true];
    }
  }
  const fallback = 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + Buffer.from(`"${seed}"`, 'utf8').toString('base64');
  return [fallback, false];
}

export function getRequirementsToken(userAgent) {
  const config = buildConfig(userAgent);
  const [require] = generateAnswer(String(Math.random()), '0fffff', config);
  return 'gAAAAAC' + require;
}

export function solvePow(seed, difficulty, userAgent) {
  const config = buildConfig(userAgent);
  const [answer, ok] = generateAnswer(seed, difficulty, config);
  return { token: 'gAAAAAB' + answer, ok };
}
