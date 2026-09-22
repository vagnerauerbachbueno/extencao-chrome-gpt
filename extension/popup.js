async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'get_status' });
  document.getElementById('status').textContent = result.connected ? 'Servidor conectado' : 'Servidor desconectado';
  document.getElementById('dot').style.background = result.connected ? '#16a34a' : '#dc2626';
  document.getElementById('server').textContent = result.serverUrl;

  const { bridge_logs = [] } = await chrome.storage.local.get('bridge_logs');
  const logContainer = document.getElementById('logs');
  if (bridge_logs.length === 0) {
    logContainer.innerHTML = '<span style="color:#64748b">Nenhum evento registrado ainda.</span>';
  } else {
    logContainer.innerHTML = bridge_logs.slice().reverse().map(l => {
      const time = l.timestamp.split('T')[1]?.split('.')[0] || '';
      return `<div style="margin-bottom:4px;border-bottom:1px solid #334155;padding-bottom:2px;"><strong style="color:#38bdf8">[${time}] ${l.category}:</strong> ${l.details}</div>`;
    }).join('');
  }
}

document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
document.getElementById('clearLogs').onclick = async () => {
  await chrome.storage.local.set({ bridge_logs: [] });
  refresh();
};

refresh();
