import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || '';
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 180000);
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
  const value = req.headers.authorization || '';
  return value === `Bearer ${API_KEY}`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(x => x?.type === 'text').map(x => x.text || '').join('');
  }
  return '';
}

function lastUserMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return textFromContent(messages[i].content);
  }
  return '';
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

function failTask(task, message) {
  if (!tasks.has(task.id)) return;
  clearTimeout(task.timer);
  task.reject(new Error(message));
  tasks.delete(task.id);
}

function dispatch() {
  while (queue.length) {
    const agent = availableAgent();
    if (!agent) return;

    const task = queue.shift();
    agent.status = 'busy';
    agent.taskId = task.id;
    task.agentId = agent.id;
    task.status = 'processing';

    task.timer = setTimeout(() => {
      send(agent.ws, { type: 'task.cancel', task_id: task.id });
      agent.status = 'available';
      agent.taskId = null;
      failTask(task, 'Task timeout');
      dispatch();
    }, TASK_TIMEOUT_MS);

    send(agent.ws, {
      type: 'task',
      task_id: task.id,
      model: task.model,
      new_conversation: task.newConversation,
      message: task.message
    });
  }
}

function enqueue(input) {
  return new Promise((resolve, reject) => {
    const id = `task-${randomUUID()}`;
    const task = {
      id,
      model: input.model || 'chatgpt-web',
      message: lastUserMessage(input.messages),
      newConversation: input.new_conversation !== false,
      stream: input.stream === true,
      status: 'queued',
      resolve,
      reject,
      createdAt: Date.now(),
      timer: null,
      agentId: null
    };
    if (!task.message) {
      reject(new Error('messages must contain a user message'));
      return;
    }
    tasks.set(id, task);
    queue.push(task);
    dispatch();
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    agents: [...agents.values()].map(a => ({ id: a.id, status: a.status })),
    queued: queue.length
  });
});

app.get('/v1/models', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: { message: 'Unauthorized', type: 'invalid_request_error' } });
  res.json({
    object: 'list',
    data: [
      {
        id: 'chatgpt-web',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'browser-bridge'
      }
    ]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: { message: 'Unauthorized', type: 'invalid_request_error' } });
  }

  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages)) {
      return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
    }

    const taskPromise = enqueue(body);

    if (body.stream === true) {
      const task = await taskPromise;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const payload = {
        id: task.id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'chatgpt-web',
        choices: [{ index: 0, delta: { role: 'assistant', content: task.content }, finish_reason: 'stop' }]
      };
      res.write(`data: ${JSON.stringify(payload)}\\n\\n`);
      res.write('data: [DONE]\\n\\n');
      return res.end();
    }

    const task = await taskPromise;
    return res.json({
      id: task.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'chatgpt-web',
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
  } catch (error) {
    return res.status(503).json({
      error: {
        message: error.message || 'No browser agent available',
        type: 'server_error'
      }
    });
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
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === 'agent.ready') {
      agent.status = 'available';
      agent.taskId = null;
      dispatch();
      return;
    }

    if (message.type === 'task.result') {
      const task = tasks.get(message.task_id);
      if (!task) return;

      clearTimeout(task.timer);
      agent.status = 'available';
      agent.taskId = null;

      if (message.ok) {
        task.status = 'completed';
        task.content = message.content || '';
        task.resolve(task);
      } else {
        task.reject(new Error(message.error || 'Browser task failed'));
      }

      tasks.delete(task.id);
      dispatch();
    }
  });

  ws.on('close', () => {
    if (agent.taskId) {
      const task = tasks.get(agent.taskId);
      if (task) failTask(task, 'Browser agent disconnected');
    }
    agents.delete(id);
    dispatch();
  });

  dispatch();
});

server.listen(PORT, () => {
  console.log(`ChatGPT Web Bridge listening on http://localhost:${PORT}`);
});
