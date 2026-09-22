function updateRuntimeState(state, details = {}) {
  chrome.storage.local.set({
    runtime_state: {
      state,
      details,
      updatedAt: new Date().toISOString()
    }
  });
}

function handleRuntimeEvent(event) {
  if (!event?.type) return;

  const map = {
    'agent.thinking': 'thinking',
    'tool.call': 'tool_call',
    'tool.result': 'tool_result',
    'file.write': 'writing',
    'task.completed': 'completed',
    'task.error': 'error'
  };

  const state = map[event.type];
  if (state) {
    updateRuntimeState(state, event);
  }
}

if (typeof chrome !== 'undefined') {
  chrome.runtime.onMessage.addListener((message) => {
    handleRuntimeEvent(message);
  });
}
