const defaults = { serverUrl: 'http://localhost:5503', token: '' };

async function load() {
  const cfg = await chrome.storage.local.get(defaults);
  document.getElementById('serverUrl').value = cfg.serverUrl;
  document.getElementById('token').value = cfg.token;
}

document.getElementById('save').onclick = async () => {
  await chrome.storage.local.set({
    serverUrl: document.getElementById('serverUrl').value.replace(/\/+$/, ''),
    token: document.getElementById('token').value
  });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  document.getElementById('result').textContent = 'Configurações salvas.';
};

load();
