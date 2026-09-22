export class ContextManager {
  constructor(options = {}) {
    this.maxMessages = options.maxMessages || 32;
    this.sessions = new Map();
  }

  getSession(id = 'default') {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, []);
    }
    return this.sessions.get(id);
  }

  addMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    session.push(message);

    if (session.length > this.maxMessages) {
      session.splice(0, session.length - this.maxMessages);
    }

    return session;
  }

  buildMessages(sessionId, systemContext = null) {
    const messages = this.getSession(sessionId);

    return systemContext
      ? [{ role: 'system', content: systemContext }, ...messages]
      : [...messages];
  }

  clear(sessionId) {
    this.sessions.delete(sessionId);
  }
}
