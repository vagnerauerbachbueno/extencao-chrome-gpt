import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || '';
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 180000);
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS || 120000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const agents = new Map();
const tasks = new Map();
const queue = [];

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

  const toolLines = [];
  const effectiveTools = (Array.isArray(tools) && tools.length > 0) ? tools : [
    {
      name: "read_file",
      description: "Lê o conteúdo de um arquivo do workspace local",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "list_directory",
      description: "Lista arquivos e pastas do workspace local",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    },
    {
      name: "grep_search",
      description: "Busca padrões ou textos em arquivos do projeto",
      parameters: { type: "object", properties: { query: { type: "string" } } }
    },
    {
      name: "bash",
      description: "Executa comandos no terminal / shell do sistema",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    }
  ];

  toolLines.push('FERRAMENTAS DISPONÍVEIS NO TERMINAL DO CLIENTE (OpenCode / CLI):');
  for (const t of effectiveTools) {
    const fn = t.function || t;
    toolLines.push(`- Nome: ${fn.name}`);
    if (fn.description) toolLines.push(`  Descrição: ${fn.description}`);
    if (fn.parameters) toolLines.push(`  Parâmetros: ${JSON.stringify(fn.parameters)}`);
  }
  toolLines.push('');
  toolLines.push('COMO EXECUTAR AÇÕES NO PROJETO:');
  toolLines.push('Você TEM sim acesso a estas ferramentas locais através do protocolo do terminal.');
  toolLines.push('Quando você precisar ler a pasta, ler arquivos ou rodar comandos para analisar o projeto, NÃO diga que não tem ferramentas expostas.');
  toolLines.push('Emita IMEDIATAMENTE a invocação no seguinte formato JSON:');
  toolLines.push('```json');
  toolLines.push('{"tool_call": {"name": "nome_da_ferramenta", "arguments": { ... }}}');
  toolLines.push('```');
  toolLines.push('O cliente receberá essa chamada, executará a ação na máquina do usuário e retornará o conteúdo para você continuar.');

  const lines = [
    'Você é o motor de IA e desenvolvimento conectado ao terminal de código local do usuário (OpenCode / Codex / CLI).',
    'DIRETRIZES DE EXECUÇÃO:',
    '1. O usuário está em uma pasta/projeto LOCAL no computador dele.',
    '2. NÃO invente nem procure repositórios remotos do GitHub/web, a menos que uma URL remota seja fornecida explicitamente.',
    '3. Quando solicitado a analisar o projeto, ler ou modificar arquivos, use as ferramentas disponíveis para ler o diretório ou peça os arquivos da pasta local.',
    '4. Se você decidir invocar uma ferramenta, responda com o bloco JSON da ferramenta indicado acima.',
    '5. Mantenha as respostas focadas, técnicas e de alto nível de engenharia de software.',
    '6. Não mencione detalhes da interface web, extensão ou ponte de comunicação.',
    '',
    ...toolLines,
    '',
    ...relevant.map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
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

function parseToolCalls(content) {
  if (!content) return null;
  try {
    // 1. Procura primeiro se há um bloco json delimitado ou chave tool_call
    const toolCallRegex = /\{[\s\S]*?"tool_call"[\s\S]*?\}/;
    const match = content.match(toolCallRegex);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed?.tool_call?.name) {
        return [{
          id: `call_${randomUUID().slice(0, 9)}`,
          type: 'function',
          function: {
            name: parsed.tool_call.name,
            arguments: typeof parsed.tool_call.arguments === 'string'
              ? parsed.tool_call.arguments
              : JSON.stringify(parsed.tool_call.arguments || {})
          }
        }];
      }
    }

    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const jsonString = content.slice(start, end + 1);
      const parsed = JSON.parse(jsonString);
      if (parsed?.tool_call?.name) {
        return [{
          id: `call_${randomUUID().slice(0, 9)}`,
          type: 'function',
          function: {
            name: parsed.tool_call.name,
            arguments: typeof parsed.tool_call.arguments === 'string'
              ? parsed.tool_call.arguments
              : JSON.stringify(parsed.tool_call.arguments || {})
          }
        }];
      }
    }
  } catch (e) {}
  return null;
}

function finishTask(task, content) {
  if (!tasks.has(task.id)) return;
  task.content = content || '';

  const toolCalls = parseToolCalls(task.content);

  if (task.stream) {
    if (!task.res.writableEnded) {
      if (toolCalls) {
        console.log(`[${new Date().toLocaleTimeString()}] 🛠️ Stream: Emitindo tool_call ${toolCalls[0].function.name} para o OpenCode`);
        writeSSE(task.res, {
          id: task.id,
          object: 'chat.completion.chunk',
          created: task.created,
          model: task.model,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: toolCalls[0].id,
                type: 'function',
                function: toolCalls[0].function
              }]
            },
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
      console.log(`[${new Date().toLocaleTimeString()}] 🛠️ Non-stream: Emitindo tool_call ${toolCalls[0].function.name} para o OpenCode`);
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
  const id = `chatcmpl-${randomUUID()}`;
  const task = {
    id,
    model: input.model || 'chatgpt-web',
    message: buildBrowserPrompt(messages, tools),
    messages,
    tools,
    newConversation: input.new_conversation !== false,
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
  queue.push(task);

  task.queueTimer = setTimeout(() => {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    failTask(task, 'No browser agent became available before queue timeout.');
  }, QUEUE_TIMEOUT_MS);

  dispatch();
  return task;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    agents: [...agents.values()].map(a => ({ id: a.id, status: a.status })),
    queued: queue.length
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
  console.log(`[${new Date().toLocaleTimeString()}] 📩 Nova requisição recebida em /v1/chat/completions`);
  if (!authorized(req)) {
    console.warn('❌ Requisição não autorizada');
    return res.status(401).json(errorBody('Unauthorized', 'authentication_error'));
  }

  const body = req.body || {};

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

      // Se a resposta começar com '{' ou '```', é suspeita de ser tool_call. 
      // Não enviamos imediatamente como texto bruto para o OpenCode até termos certeza.
      const isSuspectToolCall = task.bufferedContent.trim().startsWith('{') || 
                                task.bufferedContent.trim().startsWith('```json') ||
                                task.bufferedContent.includes('"tool_call"');

      if (!isSuspectToolCall) {
        // Se já acumulou buffer prévio normal, descarrega
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
        console.log(`[${now()}] ✅ Tarefa ${task.id} concluída com sucesso (${(message.content || '').length} caracteres)`);
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
