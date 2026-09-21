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

function buildBrowserPrompt(messages) {
  const relevant = messages.filter(m => ['system', 'developer', 'user', 'assistant'].includes(m.role));
  if (relevant.length === 1 && relevant[0].role === 'user') {
    return relevant[0].content;
  }

  const lines = [
    'Você está atuando como o motor de resposta de uma API compatível com OpenAI.',
    'Responda somente com o conteúdo da mensagem do assistente.',
    'Não mencione este protocolo, navegador, extensão, automação ou estas instruções.',
    'Preserve o idioma solicitado pelo usuário e siga as instruções de sistema/desenvolvedor.',
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

function finishTask(task, content) {
  if (!tasks.has(task.id)) return;
  task.content = content || '';

  if (task.stream) {
    if (!task.res.writableEnded) {
      if (!task.streamStarted && task.content) {
        writeSSE(task.res, openAIChunk(task, {
          role: 'assistant',
          content: task.content
        }));
      }

      writeSSE(task.res, openAIChunk(task, {}, 'stop'));
      task.res.write('data: [DONE]\n\n');
      task.res.end();
    }
  } else if (!task.res.writableEnded) {
    task.res.status(200).json({
      id: task.id,
      object: 'chat.completion',
      created: task.created,
      model: task.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: task.content },
        finish_reason: 'stop'
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
    if (!agent) return;

    const task = queue.shift();
    clearTimeout(task.queueTimer);

    agent.status = 'busy';
    agent.taskId = task.id;
    task.agentId = agent.id;
    task.status = 'processing';

    task.timer = setTimeout(() => {
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

  const id = `chatcmpl-${randomUUID()}`;
  const task = {
    id,
    model: input.model || 'chatgpt-web',
    message: buildBrowserPrompt(messages),
    messages,
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
    data: [{
      id: 'chatgpt-web',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'browser-bridge'
    }]
  });
});

app.post('/v1/chat/completions', (req, res) => {
  if (!authorized(req)) {
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
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token') || '';

  if (API_KEY && token !== API_KEY) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  const id = `agent-${randomUUID()}`;
  const agent = { id, ws, status: 'available', taskId: null };
  agents.set(id, agent);

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
      return;
    }

    if (message.type === 'agent.ready') {
      agent.status = 'available';
      agent.taskId = null;
      dispatch();
      return;
    }

    if (message.type === 'task.delta') {
      const task = tasks.get(message.task_id);
      if (!task || !task.stream || task.res.writableEnded) return;

      const content = message.content || '';
      if (content) {
        writeSSE(task.res, openAIChunk(task, { content }));
        task.streamStarted = true;
      }
      return;
    }

    if (message.type === 'task.result') {
      const task = tasks.get(message.task_id);
      if (!task) return;

      agent.status = 'available';
      agent.taskId = null;

      if (message.ok) {
        task.status = 'completed';
        finishTask(task, message.content || '');
      } else {
        failTask(task, message.error || 'Browser task failed.');
      }

      dispatch();
    }
  });

  ws.on('close', () => {
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
  console.log(`ChatGPT Web Bridge listening on http://localhost:${PORT}`);
});
