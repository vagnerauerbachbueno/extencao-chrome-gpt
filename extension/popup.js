async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'get_status' });
  document.getElementById('status').textContent = result.connected ? 'Servidor conectado' : 'Servidor desconectado';
  document.getElementById('dot').style.background = result.connected ? '#16a34a' : '#dc2626';
  document.getElementById('server').textContent = result.serverUrl;
}

document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
refresh();
