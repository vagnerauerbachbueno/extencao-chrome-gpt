import { randomUUID } from 'node:crypto';
import { getRequirementsToken, solvePow } from './pow.js';
import { parseToolCalls } from './parser.js';
import { logToFile } from './log.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let accessToken = '';
let accountId = '';
let tokenUpdatedAt = 0;

export function setChatGPTAuth(token, accountIdHint = '') {
  if (!token) return;
  if (token !== accessToken) {
    accessToken = token;
    tokenUpdatedAt = Date.now();
  }
  if (accountIdHint) accountId = accountIdHint;
}

export function getChatGPTAuthState() {
  return {
    hasToken: !!accessToken,
    ageMs: tokenUpdatedAt ? Date.now() - tokenUpdatedAt : null,
    accountId: !!accountId
  };
}

function baseHeaders() {
  const h = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': UA,
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    'OpenAI-Beta': 'interop=v2',
    'oai-client-version': 'web-20240207.022626',
    'oai-device-id': randomUUID(),
  };
  if (accountId) h['chatgpt-account-id'] = accountId;
  return h;
}

async function getSentinelTokens() {
  const p = getRequirementsToken(UA);
  const res = await fetch('https://chatgpt.com/backend-api/sentinel/chat-requirements', {
    method: 'POST',
    headers: { ...baseHeaders(), Accept: '*/*' },
    body: JSON.stringify({ p })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`chat-requirements HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = {
    chatRequirements: data.token || '',
    proof: '',
    turnstile: '',
    conversation: data.conversation || ''
  };
  const pow = data.proofofwork || {};
  if (pow.required && pow.seed && pow.difficulty) {
    out.proof = solvePow(pow.seed, pow.difficulty, UA).token;
  }
  const ts = data.turnstile || {};
  if (ts.required && ts.dx) {
    // Turnstile completo é complexo; envia vazio e deixa o server decidir
    out.turnstile = '';
    out.turnstileRequired = true;
    out.turnstileDx = ts.dx;
  }
  return out;
}

function extractTextFromSSE(dataJson) {
  try {
    const o = JSON.parse(dataJson);
    const msg = o?.message;
    if (!msg) return null;
    const parts = msg?.content?.parts;
    if (Array.isArray(parts)) return parts.join('');
    if (msg?.content?.text) return msg.content.text;
    return null;
  } catch {
    return null;
  }
}

/**
 * Envia prompt direto à API web do ChatGPT e retorna texto final.
 * Usa a mesma conversa (conversationId) para manter contexto.
 * 
 * Rate-limit: fila serializada com cooldown entre chamadas para evitar
 * rajadas que disparam "atividade suspeita" na conta ChatGPT.
 */
let lastConversationId = '';
let lastMessageId = '';
let lastCallAt = 0;
let inFlight = false;
const directQueue = [];
const COOLDOWN_MS = 3000; // 3s entre chamadas
const BACKOFF_MS = 15000; // 15s após 429/rate-limit

async function processDirectQueue() {
  if (inFlight || directQueue.length === 0) return;
  inFlight = true;
  
  const job = directQueue.shift();
  try {
    // Aguarda cooldown desde a última chamada
    const elapsed = Date.now() - lastCallAt;
    if (elapsed < COOLDOWN_MS) {
      await new Promise(r => setTimeout(r, COOLDOWN_MS - elapsed));
    }
    
    lastCallAt = Date.now();
    const result = await job.fn(...job.args);
    job.resolve(result);
  } catch (err) {
    job.reject(err);
    // Backoff após erro de rate-limit
    if (err.status === 429 || err.message?.includes('rate')) {
      lastCallAt = Date.now() + BACKOFF_MS - COOLDOWN_MS;
      logToFile('DIRECT_BACKOFF', { ms: BACKOFF_MS, error: err.message });
    }
  } finally {
    inFlight = false;
    // Processa próximo da fila
    if (directQueue.length > 0) {
      setImmediate(processDirectQueue);
    }
  }
}

function enqueueDirect(fn, ...args) {
  return new Promise((resolve, reject) => {
    directQueue.push({ fn, args, resolve, reject });
    processDirectQueue();
  });
}

export async function chatCompletionDirect(prompt, { conversationId = '', parentId = '' } = {}) {
  if (!accessToken) throw new Error('NO_CHATGPT_TOKEN');
  return enqueueDirect(doChatCompletionDirect, prompt, { conversationId, parentId });
}

async function doChatCompletionDirect(prompt, { conversationId = '', parentId = '' } = {}) {
  if (!accessToken) throw new Error('NO_CHATGPT_TOKEN');

  const sentinel = await getSentinelTokens();
  const userMsgId = randomUUID();
  const parent = parentId || lastMessageId || randomUUID();

  const payload = {
    action: 'next',
    messages: [
      {
        id: userMsgId,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [prompt] },
        metadata: {}
      }
    ],
    model: 'gpt-4o',
    timezone: 'America/Sao_Paulo',
    variant: null,
    parent_message_id: parent
  };
  if (conversationId || lastConversationId) {
    payload.conversation_id = conversationId || lastConversationId;
  }

  const headers = {
    ...baseHeaders(),
    'openai-sentinel-chat-requirements-token': sentinel.chatRequirements,
    'openai-sentinel-proof-token': sentinel.proof
  };
  if (sentinel.turnstile) {
    headers['openai-sentinel-turnstile-token'] = sentinel.turnstile;
  }

  const res = await fetch('https://chatgpt.com/backend-api/conversation', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`conversation HTTP ${res.status}: ${body.slice(0, 400)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let conversationIdOut = conversationId || lastConversationId;
  let messageIdOut = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      const piece = extractTextFromSSE(data);
      if (piece != null) fullText = piece;
      try {
        const o = JSON.parse(data);
        if (o?.conversation_id) conversationIdOut = o.conversation_id;
        if (o?.message?.id) messageIdOut = o.message.id;
      } catch { /* ignore */ }
    }
  }

  lastConversationId = conversationIdOut;
  lastMessageId = messageIdOut;

  return {
    content: fullText,
    conversationId: conversationIdOut,
    messageId: messageIdOut
  };
}

export function resetDirectConversation() {
  lastConversationId = '';
  lastMessageId = '';
}
