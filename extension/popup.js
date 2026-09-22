let currentState = 'idle';

function applyRuntimeState(state) {
  currentState = state || 'idle';

  const dot = document.getElementById('dot');
  const status = document.getElementById('status');

  const states = {
    idle: ['Servidor conectado', '#16a34a'],
    thinking: ['IA pensando...', '#38bdf8'],
    tool_call: ['Executando ferramenta...', '#f59e0b'],
    writing: ['Gravando arquivo...', '#a855f7'],
    completed: ['Concluido', '#22c55e'],
    error: ['Erro na execucao', '#dc2626']
  };

  const config = states[currentState] || states.idle;
  status.textContent = config[0];
  dot.style.background = config[1];
  dot.style.boxShadow = `0 0 18px ${config[1]}`;

  document.body.dataset.state = currentState;
}

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'get_status' });
  applyRuntimeState(result.connected ? currentState : 'error');
  document.getElementById('server').textContent = result.serverUrl;

  const { bridge_logs = [], runtime_state = 'idle' } = await chrome.storage.local.get(['bridge_logs', 'runtime_state']);
  applyRuntimeState(runtime_state);

  const logContainer = document.getElementById('logs');
  if (bridge_logs.length === 0) {
    logContainer.innerHTML = '<span style="color:#64748b">Nenhum evento registrado ainda.</span>';
  } else {
    logContainer.innerHTML = bridge_logs.slice().reverse().map(l => {
      const time = l.timestamp.split('T')[1]?.split('.')[0] || '';
      return `<div style="margin-bottom:4px;border-bottom:1px solid #334155;padding-bottom:2px;"><strong style="color:#38bdf8">[${time}] ${l.category}:</strong> ${l.details}</div>`;
    }).join('');
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.runtime_state) {
      applyRuntimeState(changes.runtime_state.newValue);
    }
  });
}

document.getElementById('options').onclick = () => chrome.runtime.openOptionsPage();
document.getElementById('clearLogs').onclick = async () => {
  await chrome.storage.local.set({ bridge_logs: [] });
  refresh();
};

refresh();
