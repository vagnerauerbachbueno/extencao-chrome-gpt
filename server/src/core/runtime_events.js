const listeners = new Set();

export function onRuntimeEvent(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function emitRuntimeEvent(type, payload = {}) {
  const event = {
    type,
    timestamp: new Date().toISOString(),
    ...payload
  };

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener failures to keep execution running.
    }
  }

  return event;
}

export const RUNTIME_STATES = {
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  WRITING: 'writing',
  COMPLETED: 'completed',
  ERROR: 'error'
};
