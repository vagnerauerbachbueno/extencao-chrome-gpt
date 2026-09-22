export class ToolEngine {
  constructor() {
    this.tools = new Map();
  }

  register(name, handler, schema = {}) {
    this.tools.set(name, {
      handler,
      schema
    });
  }

  list() {
    return [...this.tools.entries()].map(([name, item]) => ({
      name,
      ...item.schema
    }));
  }

  async execute(call) {
    const tool = this.tools.get(call?.name);

    if (!tool) {
      throw new Error(`Tool nao encontrada: ${call?.name}`);
    }

    return await tool.handler(call.arguments || {});
  }
}
