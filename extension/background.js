const DEFAULTS = {
  serverUrl: 'https://vagner.defence.com.br',
  token: ''
};

let socket = null;
let reconnectTimer = null;
let connecting = false;
let pingInterval = null;

async function settings() {
  return await chrome.storage.local.get(DEFAULTS);
}

async function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return;
  connecting = true;

  const cfg = await settings();
  const base = cfg.serverUrl.replace(/\/$/, '');
  const wsBase = base.startsWith('https://') 
    ? base.replace(/^https:\/\//i, 'wss://') 
    : base.replace(/^http:\/\//i, 'ws://');
  const wsUrl = wsBase + '/ws' +
    (cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : '');

  try {
    console.log('[ChatGPT-Bridge] Conectando ao WebSocket:', wsUrl);
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[ChatGPT-Bridge] ✅ WebSocket conectado ao servidor!');
      connecting = false;
      socket.send(JSON.stringify({ type: 'agent.ready' }));
      broadcast({ type: 'connection', connected: true });

      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
    };

    socket.onmessage = async event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      console.log('[ChatGPT-Bridge] Mensagem recebida do servidor:', msg.type);
      if (msg.type === 'task') await handleTask(msg);
    };

    socket.onclose = (event) => {
      console.warn('[ChatGPT-Bridge] ⚠️ WebSocket fechado. Código:', event.code, 'Motivo:', event.reason);
      connecting = false;
      socket = null;
      clearInterval(pingInterval);
      broadcast({ type: 'connection', connected: false });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };

    socket.onerror = (err) => {
      console.error('[ChatGPT-Bridge] ❌ Erro no WebSocket:', err);
    };
  } catch (err) {
    console.error('[ChatGPT-Bridge] Exceção ao conectar:', err);
    connecting = false;
    clearInterval(pingInterval);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
  });

  return tabs.find(t => t.status === 'complete') || tabs[0] || null;
}

async function handleTask(task) {
  let tab = await findChatTab();

  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://chatgpt.com/' });
    await waitForTab(tab.id);
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'execute_task',
      task_id: task.task_id,
      message: task.message,
      new_conversation: task.new_conversation,
      stream: task.stream === true
    });

    socket?.send(JSON.stringify({
      type: 'task.result',
      task_id: task.task_id,
      ok: response?.ok === true,
      content: response?.content || '',
      error: response?.error || null
    }));
  } catch (error) {
    socket?.send(JSON.stringify({
      type: 'task.result',
      task_id: task.task_id,
      ok: false,
      error: error.message || 'Failed to communicate with ChatGPT tab'
    }));
  } finally {
    socket?.send(JSON.stringify({ type: 'agent.ready' }));
  }
}

function waitForTab(tabId) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1000);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(DEFAULTS);
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.log('[ChatGPT-Bridge] KeepAlive alarme disparado: reconectando WebSocket...');
      connect();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get_status') {
    settings().then(cfg => sendResponse({
      connected: socket?.readyState === WebSocket.OPEN,
      serverUrl: cfg.serverUrl
    }));
    return true;
  }

  if (message.type === 'task.delta') {
    socket?.send(JSON.stringify({
      type: 'task.delta',
      task_id: message.task_id,
      content: message.content || ''
    }));
    return;
  }

  if (message.type === 'reconnect') {
    connect();
    sendResponse({ ok: true });
  }
});

connect();
