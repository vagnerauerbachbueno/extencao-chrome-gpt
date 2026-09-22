import { onRuntimeEvent } from './runtime_events.js';

export function attachRuntimeWebSocketBridge(sendEvent) {
  return onRuntimeEvent((event) => {
    try {
      sendEvent({
        type: 'runtime.event',
        event
      });
    } catch {
      // Ignore websocket failures so runtime execution is not interrupted.
    }
  });
}
