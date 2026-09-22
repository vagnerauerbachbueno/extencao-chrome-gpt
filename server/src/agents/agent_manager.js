export class AgentManager {
  constructor({ toolEngine, contextManager } = {}) {
    this.agents = new Map();
    this.toolEngine = toolEngine;
    this.contextManager = contextManager;
  }

  register(name, config = {}) {
    this.agents.set(name, {
      name,
      system: config.system || '',
      tools: config.tools || []
    });
  }

  get(name) {
    return this.agents.get(name);
  }

  list() {
    return [...this.agents.values()];
  }

  async execute(name, input) {
    const agent = this.get(name);
    if (!agent) throw new Error(`Agent ${name} not found`);

    return {
      agent: name,
      system: agent.system,
      input
    };
  }
}
