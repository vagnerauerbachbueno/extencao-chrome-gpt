const DEFAULTS = {
  serverUrl: 'http://localhost:8787',
  token: ''
};

let socket = null;
let reconnectTimer = null;
let connecting = false;

async function settings() {
  return await chrome.storage.local.get(DEFAULTS);
}

async function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return;
  connecting = true;
  const cfg = await settings();
  const base = cfg.serverUrl.replace(/\\/$/, '');
  const wsUrl = base.replace(/^http/, 'ws') + '/ws' + (cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : '');

  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      connecting = false;
      socket.send(JSON.stringify({ type: 'agent.ready' }));
      broadcast({ type: 'connection', connected: true });
    };

    socket.onmessage = async event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'task') await handleTask(msg);
    };

    socket.onclose = () => {
      connecting = false;
      socket = null;
      broadcast({ type: 'connection', connected: false });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };

    socket.onerror = () => {};
  } catch {
    connecting = false;
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
  connect();
});

chrome.runtime.onStartup.addListener(connect);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get_status') {
    settings().then(cfg => sendResponse({
      connected: socket?.readyState === WebSocket.OPEN,
      serverUrl: cfg.serverUrl
    }));
    return true;
  }

  if (message.type === 'task.delta') { socket?.send(JSON.stringify({type:'task.delta',task_id:message.task_id,content:message.content||''})); }\n\n  if (message.type === 'reconnect') {
    connect();
    sendResponse({ ok: true });
  }
});

connect();
