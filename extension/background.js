const DEFAULTS = {
  serverUrl: 'http://localhost:5503',
  token: ''
};

async function appendLog(category, details) {
  try {
    const { bridge_logs = [] } = await chrome.storage.local.get('bridge_logs');
    bridge_logs.push({
      timestamp: new Date().toISOString(),
      category,
      details: typeof details === 'string' ? details : JSON.stringify(details)
    });
    // Mantém no máximo os últimos 200 logs
    if (bridge_logs.length > 200) bridge_logs.shift();
    await chrome.storage.local.set({ bridge_logs });
  } catch (e) {}
}

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
  const base = cfg.serverUrl.replace(/\/+$/, '');
  const wsBase = base.startsWith('https://') 
    ? base.replace(/^https:\/\//i, 'wss://') 
    : base.replace(/^http:\/\//i, 'ws://');
  const wsUrl = wsBase + '/ws' +
    (cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : '');

  try {
    console.log('[ChatGPT-Bridge] Conectando ao WebSocket:', wsUrl);
    socket = new WebSocket(wsUrl);

    socket.onmessage = async event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      console.log('[ChatGPT-Bridge] Mensagem recebida do servidor:', msg.type);
      if (msg.type === 'task') await handleTask(msg);
    };

    socket.onopen = () => {
      console.log('[ChatGPT-Bridge] ✅ WebSocket conectado ao servidor!');
      connecting = false;
      socket.send(JSON.stringify({ type: 'agent.ready' }));
      fetchChatGPTToken().then(() => pushAuthIfAny(true));
      broadcast({ type: 'connection', connected: true });

      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
          pushAuthIfAny();
        }
      }, 15000);
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

let lastAuthPushAt = 0;
let lastAuthPushToken = '';
async function pushAuthIfAny(force = false) {
  try {
    const now = Date.now();
    const { chatgpt_access_token, chatgpt_account_id } = await chrome.storage.local.get([
      'chatgpt_access_token',
      'chatgpt_account_id'
    ]);
    if (!chatgpt_access_token || !socket || socket.readyState !== WebSocket.OPEN) return;
    const same = chatgpt_access_token === lastAuthPushToken;
    if (!force && (same || now - lastAuthPushAt < 60000)) return;
    lastAuthPushAt = now;
    lastAuthPushToken = chatgpt_access_token;
    socket.send(JSON.stringify({
      type: 'auth.chatgpt',
      access_token: chatgpt_access_token,
      account_id: chatgpt_account_id || ''
    }));
    appendLog('AUTH_PUSHED', { hasToken: true, force });
  } catch (e) {
    appendLog('AUTH_PUSH_ERROR', { error: e.message });
  }
}

async function fetchChatGPTToken() {
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }
    const token = data?.accessToken || '';
    const account = data?.user?.id || data?.auth?.account_id || data?.account_id || '';
    await chrome.storage.local.set({
      chatgpt_access_token: token,
      chatgpt_account_id: account,
      chatgpt_auth_status: token ? 'ok' : (res.ok ? 'no_token' : `http_${res.status}`),
      chatgpt_auth_at: new Date().toISOString(),
      chatgpt_auth_source: 'background',
      chatgpt_auth_preview: (raw || '').slice(0, 100)
    });
    appendLog('AUTH_FETCH', { status: res.status, hasToken: !!token, preview: (raw || '').slice(0, 60) });
    if (token) await pushAuthIfAny(true);
    return token;
  } catch (e) {
    await chrome.storage.local.set({ chatgpt_auth_status: 'error', chatgpt_auth_error: e.message });
    appendLog('AUTH_FETCH_ERROR', { error: e.message });
    return '';
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'auth.chatgpt' && message.access_token) {
    chrome.storage.local.set({
      chatgpt_access_token: message.access_token,
      chatgpt_account_id: message.account_id || '',
      chatgpt_auth_status: 'ok',
      chatgpt_auth_at: new Date().toISOString()
    }).then(() => pushAuthIfAny(true));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.chatgpt_access_token?.newValue) {
    pushAuthIfAny(true);
  }
});

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

  appendLog('TASK_RECEIVED', { taskId: task.task_id, stream: task.stream, promptPreview: task.message?.slice(0, 120) });

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'execute_task',
      task_id: task.task_id,
      message: task.message,
      new_conversation: task.new_conversation,
      stream: task.stream === true
    });

    appendLog('TASK_RESULT', { taskId: task.task_id, ok: response?.ok, responsePreview: response?.content?.slice(0, 150) });

    socket?.send(JSON.stringify({
      type: 'task.result',
      task_id: task.task_id,
      ok: response?.ok === true,
      content: response?.content || '',
      error: response?.error || null
    }));
  } catch (error) {
    appendLog('TASK_ERROR', { taskId: task.task_id, error: error.message });
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
    fetchChatGPTToken();
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
