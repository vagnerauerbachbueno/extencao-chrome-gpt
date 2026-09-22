import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseToolCalls, isRefusalText, isActionIntentText } from './parser.js';
import { setChatGPTAuth, getChatGPTAuthState, chatCompletionDirect, resetDirectConversation } from './chatgpt_direct.js';
import { logToFile, LOG_FILE } from './log.js';

const DIRECT_MODE = process.env.DIRECT_MODE !== '0';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || '';
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 180000);
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS || 120000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

if (!API_KEY) {
  console.warn('[segurança] API_KEY vazia — o endpoint /v1/chat/completions está aberto. Defina API_KEY no .env para uso em produção.');
}
if (CORS_ORIGIN === '*' && API_KEY) {
  console.warn('[segurança] CORS_ORIGIN=* com API_KEY definida. Restrinja CORS_ORIGIN ao domínio do cliente.');
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const agents = new Map();
const tasks = new Map();
const queue = [];
let authLogDone = false;

function authorized(req) {
  if (!API_KEY) return true;
  return (req.headers.authorization || '') === `Bearer ${API_KEY}`;
}

function errorBody(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, param: null, code } };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item?.type === 'text')
      .map(item => item.text || '')
      .join('');
  }
  return '';
}

function normalizeMessages(messages) {
  return messages.map((message) => ({
    role: message?.role,
    content: textFromContent(message?.content)
  }));
}

function buildBrowserPrompt(messages, tools = []) {
  const relevant = messages.filter(m => ['system', 'developer', 'user', 'assistant'].includes(m.role));
  const systemish = relevant.filter(m => m.role === 'system' || m.role === 'developer');
  const dialogue = relevant.filter(m => m.role !== 'system' && m.role !== 'developer');
  // Limita o histórico: prompt gigante deixa o ChatGPT lento e confuso
  const cappedDialogue = dialogue.length > 16 ? dialogue.slice(-16) : dialogue;
  const history = [...systemish, ...cappedDialogue];

  const header = [
    'CRITICAL — FUNCTION CALLING PROTOCOL (behave exactly like an OpenAI tool-calling API):',
    'You are the reasoning engine of a local CLI (OpenCode). Tools ARE available — the CLI runs them when you emit tool_call JSON.',
    'Reply ONLY with JSON when a tool is needed: {"tool_call": {"name": "...", "arguments": {...}}}',
    '',
    'FILE CREATION RULE (highest priority):',
    '- CREATE / WRITE / SAVE file (landing page, script, etc.) → emit write tool_call IMMEDIATELY.',
    '- NEVER narrate plans, NEVER output file trees in prose, NEVER return file body as plain text.',
    '- Example: {"tool_call": {"name": "write", "arguments": {"filePath": "index.html", "content": "<!DOCTYPE html>..."}}}',
    '- Wrong: "Vou criar uma versão..." / Estrutura: ```text ... ```  ← DO NOT DO THIS',
    '- Right: reply starts with { and is only the tool_call JSON.',
    '',
    'NEVER narrate, NEVER say tools/terminal/files are unavailable.',
    'ANTI-LOOP: never repeat the same tool_call (name+arguments) already used above. After glob/list results → read a specific file. After read → answer or grep.',
    ''
  ];

  const toolLines = [];
  const rawTools = (Array.isArray(tools) && tools.length > 0) ? tools : [
    {
      name: "read_file",
      description: "Lê arquivo do workspace",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "list_directory",
      description: "Lista arquivos e pastas",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    },
    {
      name: "grep_search",
      description: "Busca texto no projeto",
      parameters: { type: "object", properties: { query: { type: "string" } } }
    },
    {
      name: "bash",
      description: "Executa comando no shell",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  ];
  // Sem sub-agentes: esconde task/skill/todowrite/question do modelo
  const BLOCKED = new Set(['task', 'skill', 'todowrite', 'question']);
  const effectiveTools = rawTools.filter(t => {
    const name = t.function?.name || t.name || '';
    return !BLOCKED.has(name);
  });

  toolLines.push('TOOLS (name → short description → arg keys):');
  for (const t of effectiveTools) {
    const fn = t.function || t;
    const desc = String(fn.description || '').split('\n')[0].replace(/\s+/g, ' ').slice(0, 100);
    const props = fn.parameters?.properties ? Object.keys(fn.parameters.properties).join(',') : '';
    toolLines.push(`- ${fn.name}: ${desc}${props ? ` (${props})` : ''}`);
  }
  toolLines.push('');
  toolLines.push('RULES:');
  toolLines.push('1. Tool needed → reply ONLY with the tool_call JSON block (no prose before/after).');
  toolLines.push('2. Multiple tools OK in one reply as separate JSON objects.');
  toolLines.push('3. Task done → short final answer in pt-BR (no tool_call).');
  toolLines.push('4. If prior messages already contain tool results, do NOT call the same tool again — progress or finish.');
  toolLines.push('5. NO sub-agents. Never emit task/skill/todowrite/question. Do all work yourself with bash/glob/grep/read/edit/write.');
  toolLines.push('6. CREATE/WRITE/SAVE file → MUST use write tool. NEVER return file body as text/markdown.');
  toolLines.push('7. User asks question only → answer directly in text (no tool_call).');

  const lines = [
    ...header,
    ...history.map(m => `[${m.role.toUpperCase()}]\n${m.content}`),
    '',
    '----------------------------------------',
    ...toolLines
  ];

  return lines.join('\n');
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function availableAgent() {
  for (const agent of agents.values()) {
    if (agent.status === 'available' && agent.ws.readyState === agent.ws.OPEN) return agent;
  }
  return null;
}

function openAIChunk(task, delta = {}, finishReason = null) {
  return {
    id: task.id,
    object: 'chat.completion.chunk',
    created: task.created,
    model: task.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function writeSSE(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function cleanupTask(task) {
  clearTimeout(task.timer);
  clearTimeout(task.queueTimer);
  tasks.delete(task.id);
}

function failTask(task, message, type = 'server_error', status = 503) {
  if (!tasks.has(task.id)) return;

  if (task.stream) {
    writeSSE(task.res, errorBody(message, type));
    if (!task.res.writableEnded) task.res.end();
  } else if (!task.res.headersSent) {
    task.res.status(status).json(errorBody(message, type));
  }

  cleanupTask(task);
}

function finishTask(task, content) {
  if (!tasks.has(task.id)) return;
  task.content = content || '';

  let toolCalls = parseToolCalls(task.content);

  if (toolCalls) {
    console.log(`[${new Date().toLocaleTimeString()}] 🔍 parseToolCalls OK: ${toolCalls.map(c => c.function.name).join(', ')}`);
    logToFile('PARSE_OK', { taskId: task.id, names: toolCalls.map(c => c.function.name) });
  } else if (task.content) {
    console.warn(`[${new Date().toLocaleTimeString()}] 🔍 parseToolCalls NULL — conteúdo vira texto puro. Preview: ${task.content.slice(0, 200)}`);
    logToFile('PARSE_NULL', { taskId: task.id, preview: task.content.slice(0, 300) });
  }

  // Auto-detecção: converte em write só se houver arquivo REAL substancial no texto
  if (!toolCalls && task.tools?.length > 0) {
    const names = task.tools.map(t => t.function?.name || t.name).filter(Boolean);
    const writeTool = ['write', 'write_file', 'create_file'].find(n => names.includes(n));
    if (writeTool) {
      const c = task.content || '';
      let body = '';
      let lang = '';

      // 1) Fence de código com lang de arquivo OU fence cujo conteúdo pareça html — pega o MAIOR (>=200 chars)
      const fenceRe = /```([a-z0-9_-]*)[^\n]*\n([\s\S]*?)\n```/gi;
      let m;
      let best = null;
      while ((m = fenceRe.exec(c)) !== null) {
        const fenceLang = (m[1] || '').toLowerCase();
        const fenceBody = m[2] || '';
        const langOk = ['html', 'htm', 'javascript', 'js', 'typescript', 'ts', 'python', 'py', 'bash', 'sh', 'json', 'css'].includes(fenceLang);
        const looksHtml = /<!DOCTYPE html|<html[\s>]/i.test(fenceBody);
        if (fenceBody.length >= 200 && (langOk || looksHtml)) {
          if (!best || fenceBody.length > best.body.length) {
            best = { lang: fenceLang || (looksHtml ? 'html' : ''), body: fenceBody };
          }
        }
      }
      if (best && best.body.length >= 200) {
        body = best.body;
        lang = best.lang;
      } else {
        // 2) HTML embutido no MEIO da prosa (ex: "Salve como index.html:\n<!DOCTYPE...>")
        const docIdx = c.search(/<!DOCTYPE html>|<html[\s>]/i);
        if (docIdx !== -1) {
          const fromDoc = c.slice(docIdx);
          const endIdx = fromDoc.toLowerCase().lastIndexOf('</html>');
          const candidate = endIdx !== -1 ? fromDoc.slice(0, endIdx + 7) : fromDoc;
          if (candidate.length >= 200) {
            body = candidate;
            lang = 'html';
          }
        } else {
          // 3) Shebang / arquivo que começa a resposta
          const trimmed = c.trim();
          if (/^#!/.test(trimmed) && trimmed.length >= 200) {
            body = trimmed;
            lang = 'bash';
          }
        }
      }

      if (body) {
        const langMap = { html: 'index.html', htm: 'index.html', '': 'index.html', css: 'styles.css', js: 'script.js', javascript: 'script.js', ts: 'script.ts', typescript: 'script.ts', python: 'script.py', py: 'script.py', bash: 'script.sh', sh: 'script.sh', json: 'config.json' };
        const path = langMap[lang] || 'index.html';
        console.log(`[${new Date().toLocaleTimeString()}] 📄 Arquivo real detectado (${lang || 'html'}, ${body.length} chars) — write("${path}")`);
        logToFile('FORCE_WRITE', { taskId: task.id, path, lang, chars: body.length });
        toolCalls = [{
          id: `call_${randomUUID().slice(0, 9)}`,
          type: 'function',
          function: { name: writeTool, arguments: JSON.stringify({ filePath: path, content: body }) }
        }];
        task.content = '';
      }
    }
  }

  // Fallback: recusa OU narração de intenção sem JSON — força uma chamada segura (não bash).
  if (!toolCalls && task.tools?.length > 0 && (isRefusalText(task.content) || isActionIntentText(task.content))) {
    const names = task.tools.map(t => t.function?.name || t.name).filter(Boolean);
    const preferred = ['glob', 'list_directory', 'read', 'read_file', 'grep', 'grep_search'];
    const toolName = preferred.find(n => names.includes(n)) || names[0];
    if (toolName) {
      const reason = isRefusalText(task.content) ? 'Recusa detectada' : 'Narração de intenção sem JSON';
      console.log(`[${new Date().toLocaleTimeString()}] 💡 ${reason} — forçando tool "${toolName}"`);
      logToFile('FORCE_TOOL', { taskId: task.id, reason, tool: toolName, preview: (task.content || '').slice(0, 200) });
      const args = (toolName === 'glob' || toolName === 'list_directory')
        ? { pattern: '**/*' }
        : (toolName === 'read_file' || toolName === 'read')
          ? { path: 'package.json' }
          : (toolName === 'grep' || toolName === 'grep_search')
            ? { query: '.' }
            : {};
      toolCalls = [{
        id: `call_${randomUUID().slice(0, 9)}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args) }
      }];
    }
  }

  if (task.stream) {
    if (!task.res.writableEnded) {
      if (toolCalls) {
        console.log(`[${new Date().toLocaleTimeString()}] 🛠️ Stream: emitindo ${toolCalls.length} tool_call(s): ${toolCalls.map(c => c.function.name).join(', ')}`);
        logToFile('EMIT_TOOL_CALL', { taskId: task.id, names: toolCalls.map(c => c.function.name) });
        writeSSE(task.res, {
          id: task.id,
          object: 'chat.completion.chunk',
          created: task.created,
          model: task.model,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments
                }
              }))
            },
            finish_reason: null
          }]
        });

        writeSSE(task.res, {
          id: task.id,
          object: 'chat.completion.chunk',
          created: task.created,
          model: task.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'tool_calls'
          }]
        });
      } else {
        if (!task.streamStarted && task.content) {
          writeSSE(task.res, openAIChunk(task, {
            role: 'assistant',
            content: task.content
          }));
        } else if (task.streamStarted && task.sentLength < task.content.length) {
          const remaining = task.content.slice(task.sentLength);
          writeSSE(task.res, openAIChunk(task, { content: remaining }));
        }
        writeSSE(task.res, openAIChunk(task, {}, 'stop'));
      }

      task.res.write('data: [DONE]\n\n');
      task.res.end();
    }
  } else if (!task.res.writableEnded) {
    const messageObj = {
      role: 'assistant',
      content: toolCalls ? null : task.content
    };
    if (toolCalls) {
      console.log(`[${new Date().toLocaleTimeString()}] 🛠️ Non-stream: emitindo ${toolCalls.length} tool_call(s): ${toolCalls.map(c => c.function.name).join(', ')}`);
      messageObj.tool_calls = toolCalls;
    }

    task.res.status(200).json({
      id: task.id,
      object: 'chat.completion',
      created: task.created,
      model: task.model,
      choices: [{
        index: 0,
        message: messageObj,
        finish_reason: toolCalls ? 'tool_calls' : 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });
  }

  cleanupTask(task);
}

function dispatch() {
  while (queue.length) {
    const agent = availableAgent();
    if (!agent) {
      console.log(`[${new Date().toLocaleTimeString()}] ⏳ Tarefa na fila, mas nenhum agente disponível no momento (Fila: ${queue.length})`);
      return;
    }

    const task = queue.shift();
    clearTimeout(task.queueTimer);

    agent.status = 'busy';
    agent.taskId = task.id;
    task.agentId = agent.id;
    task.status = 'processing';

  console.log(`[${new Date().toLocaleTimeString()}] 🚀 Enviando tarefa ${task.id} para agente ${agent.id} (stream: ${task.stream})`);
  console.log(`[${new Date().toLocaleTimeString()}] 📝 [PROMPT ENVIADO AO CHATGPT]:\n${task.message.slice(0, 300)}...\n[FIM DO PREVIEW DO PROMPT]`);
  logToFile('DISPATCH', { taskId: task.id, agentId: agent.id, stream: task.stream, promptPreview: task.message.slice(0, 500) });

    task.timer = setTimeout(() => {
      console.warn(`[${new Date().toLocaleTimeString()}] ⏰ Timeout da tarefa ${task.id} no agente ${agent.id}`);
      send(agent.ws, { type: 'task.cancel', task_id: task.id });
      agent.status = 'available';
      agent.taskId = null;
      failTask(task, 'Request timed out while waiting for the browser agent.');
      dispatch();
    }, TASK_TIMEOUT_MS);

    send(agent.ws, {
      type: 'task',
      task_id: task.id,
      model: task.model,
      stream: task.stream,
      new_conversation: task.newConversation,
      messages: task.messages,
      message: task.message
    });
  }
}

function createTask(input, res) {
  const messages = normalizeMessages(input.messages);
  const userMessage = [...messages].reverse().find(m => m.role === 'user');

  if (!userMessage?.content) {
    throw new Error('messages must contain at least one user message with text content');
  }

  const tools = input.tools || [];
  console.log(`[${new Date().toLocaleTimeString()}] 🔧 Tools recebidas do OpenCode: ${tools.length > 0 ? tools.map(t => (t.function?.name || t.name)).join(', ') : 'Nenhuma (usando fallback padrão)'}`);
  const id = `chatcmpl-${randomUUID()}`;
  const wantsNew = input.new_conversation === true;
  const task = {
    id,
    model: input.model || 'chatgpt-web',
    message: buildBrowserPrompt(messages, tools),
    messages,
    tools,
    newConversation: wantsNew,
    stream: input.stream === true,
    status: 'queued',
    content: '',
    created: Math.floor(Date.now() / 1000),
    timer: null,
    queueTimer: null,
    agentId: null,
    res,
    streamStarted: false
  };

  tasks.set(id, task);

  const auth = getChatGPTAuthState();
  if (DIRECT_MODE && auth.hasToken) {
    if (wantsNew) resetDirectConversation();
    task.status = 'processing';
    console.log(`[${new Date().toLocaleTimeString()}] ⚡ API direta ChatGPT (sem DOM) para ${id}`);
    logToFile('DIRECT_START', { taskId: id, stream: task.stream, ageMs: auth.ageMs });
    runDirect(task, userMessage.content).catch(err => {
      console.warn(`[${new Date().toLocaleTimeString()}] ⚠️ API direta falhou, fallback extensão: ${err.message}`);
      logToFile('DIRECT_FAIL', { taskId: id, error: err.message, status: err.status || null });
      task.status = 'queued';
      queue.push(task);
      task.queueTimer = setTimeout(() => {
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        failTask(task, 'No browser agent became available before queue timeout.');
      }, QUEUE_TIMEOUT_MS);
      dispatch();
    });
    return task;
  }

  queue.push(task);

  task.queueTimer = setTimeout(() => {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    failTask(task, 'No browser agent became available before queue timeout.');
  }, QUEUE_TIMEOUT_MS);

  dispatch();
  return task;
}

async function runDirect(task, prompt) {
  const started = Date.now();
  const result = await chatCompletionDirect(prompt);
  const text = result.content || '';

  if (task.res.writableEnded) {
    cleanupTask(task);
    return;
  }

  task.status = 'completed';
  task.sentLength = 0;
  task.streamStarted = false;
  finishTask(task, text);

  logToFile('DIRECT_OK', { taskId: task.id, ms: Date.now() - started, chars: text.length, conv: !!result.conversationId });
  console.log(`[${new Date().toLocaleTimeString()}] ✅ API direta OK ${task.id} em ${Date.now() - started}ms (${text.length} chars)`);
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    agents: [...agents.values()].map(a => ({ id: a.id, status: a.status })),
    queued: queue.length,
    direct: getChatGPTAuthState(),
    directMode: DIRECT_MODE
  });
});

app.get('/logs', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.type('text/plain').send('Nenhum log gravado ainda.');
  fs.readFile(LOG_FILE, 'utf8', (err, data) => {
    if (err) return res.status(500).send('Erro ao ler logs: ' + err.message);
    res.type('text/plain; charset=utf-8').send(data);
  });
});

app.get('/v1/models', (req, res) => {
  if (!authorized(req)) return res.status(401).json(errorBody('Unauthorized', 'authentication_error'));

  res.json({
    object: 'list',
    data: [
      {
        id: 'gpt-5.6',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'vagner'
      },
      {
        id: 'gpt 5.6',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'vagner'
      },
      {
        id: 'chatgpt-web',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'vagner'
      }
    ]
  });
});

app.post('/v1/chat/completions', (req, res) => {
  const body = req.body || {};
  const userMsg = Array.isArray(body.messages) ? [...body.messages].reverse().find(m => m.role === 'user')?.content : '';
  const userPreview = typeof userMsg === 'string' ? userMsg.slice(0, 100) : JSON.stringify(userMsg || '').slice(0, 100);
  console.log(`[${new Date().toLocaleTimeString()}] 📩 Nova requisição /v1/chat/completions (model: ${body.model}, stream: ${body.stream}, msgs: ${body.messages?.length || 0}) -> "${userPreview}"`);
  
  if (!authorized(req)) {
    console.warn('❌ Requisição não autorizada');
    return res.status(401).json(errorBody('Unauthorized', 'authentication_error'));
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json(errorBody('messages is required and must be a non-empty array'));
  }

  if (body.stream === true) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }

  try {
    createTask(body, res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(400).json(errorBody(error.message));
    } else if (!res.writableEnded) {
      writeSSE(res, errorBody(error.message));
      res.end();
    }
  }
});

wss.on('connection', (ws, req) => {
  const now = () => new Date().toLocaleTimeString();

  console.log(`[${now()}] Nova conexão WebSocket de ${req.socket.remoteAddress}`);

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token') || '';

  if (API_KEY && token !== API_KEY) {
    console.warn(`[${now()}] Conexão rejeitada: token inválido`);
    ws.close(1008, 'Unauthorized');
    return;
  }

  const id = `agent-${randomUUID().slice(0, 8)}`;
  const agent = { id, ws, status: 'available', taskId: null };
  agents.set(id, agent);
  console.log(`[${now()}] ✅ Agente registrado: ${id}. Total de agentes ativos: ${agents.size}`);

  send(ws, {
    type: 'agent.connected',
    agent_id: id,
    server_time: new Date().toISOString()
  });

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.error(`[${now()}] Mensagem malformada recebida de ${id}:`, raw.toString());
      return;
    }

    console.log(`[${now()}] [WS Recebido de ${id}] Tipo: ${message.type}`, message.task_id ? `(Task: ${message.task_id})` : '');

    if (message.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    if (message.type === 'auth.chatgpt' && message.access_token) {
      const before = getChatGPTAuthState().hasToken;
      setChatGPTAuth(message.access_token, message.account_id || '');
      const after = getChatGPTAuthState().hasToken;
      if (!before && after) {
        console.log(`[${now()}] 🔑 accessToken ChatGPT recebido (ok).`);
        logToFile('AUTH', { agentId: id, hasToken: true });
      }
      return;
    }

    if (message.type === 'agent.ready') {
      agent.status = 'available';
      agent.taskId = null;
      console.log(`[${now()}] Agente ${id} pronto para receber tarefas.`);
      dispatch();
      return;
    }

    if (message.type === 'task.delta') {
      const task = tasks.get(message.task_id);
      if (!task || !task.stream || task.res.writableEnded) return;

      const content = message.content || '';
      if (!content) return;

      task.bufferedContent = (task.bufferedContent || '') + content;

      // Se a resposta começar com '{', '```', 'JSON' ou contiver 'tool_call',
      // é uma chamada de ferramenta. Retemos no buffer para converter no objeto nativo do OpenAI.
      const trimmed = task.bufferedContent.trim();
      const isSuspectToolCall = trimmed.startsWith('{') ||
                                trimmed.startsWith('```') ||
                                /^json/i.test(trimmed) ||
                                task.bufferedContent.includes('"tool_call"') ||
                                task.bufferedContent.includes('"tool_calls"') ||
                                task.bufferedContent.includes('tool_call');

      const hasTools = Array.isArray(task.tools) && task.tools.length > 0;

      // Com tools, retém tudo até o task.result: evita enviar narração parcial
      // ("Vou...") ao OpenCode e depois trocar por tool_calls no final.
      if (hasTools) return;

      const isRefusal = isRefusalText(trimmed);

      // Sem tools: só retém se houver indício de tool_call/recusa — texto normal segue imediato
      if (!isSuspectToolCall && !isRefusal) {
        const toSend = task.bufferedContent.slice(task.sentLength || 0);
        if (toSend) {
          writeSSE(task.res, openAIChunk(task, { content: toSend }));
          task.streamStarted = true;
          task.sentLength = task.bufferedContent.length;
        }
      }
      return;
    }

    if (message.type === 'task.result') {
      const task = tasks.get(message.task_id);
      if (!task) return;

      agent.status = 'available';
      agent.taskId = null;

      if (message.ok) {
        console.log(`[${now()}] ✅ Tarefa ${task.id} concluída (${(message.content || '').length} caracteres)`);
        logToFile('RESULT', { taskId: task.id, length: (message.content || '').length, contentPreview: (message.content || '').slice(0, 500) });
        task.status = 'completed';
        finishTask(task, message.content || '');
      } else if (message.error && message.error.includes('Browser agent is busy')) {
        console.warn(`[${now()}] ⚠️ Agente ocupado. Reenfileirando tarefa ${task.id} para aguardar término...`);
        clearTimeout(task.timer);
        task.status = 'queued';
        task.agentId = null;
        setTimeout(() => {
          queue.unshift(task);
          dispatch();
        }, 1500);
      } else {
        console.error(`[${now()}] ❌ Tarefa ${task.id} falhou: ${message.error}`);
        failTask(task, message.error || 'Browser task failed.');
      }

      dispatch();
    }
  });

  ws.on('close', (code, reason) => {
    console.warn(`[${now()}] ⚠️ Agente ${id} desconectado (código: ${code}, motivo: ${reason?.toString() || 'sem motivo'}). Restantes: ${agents.size - 1}`);
    if (agent.taskId) {
      const task = tasks.get(agent.taskId);
      if (task) failTask(task, 'Browser agent disconnected.');
    }

    agents.delete(id);
    dispatch();
  });

  dispatch();
});

server.listen(PORT, () => {
  console.log(`[${new Date().toLocaleTimeString()}] 🚀 ChatGPT Web Bridge rodando em http://localhost:${PORT}`);
});
