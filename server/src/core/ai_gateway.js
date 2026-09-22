export class AIGateway {
  constructor(providers = {}) {
    this.providers = providers;
  }

  register(name, provider) {
    this.providers[name] = provider;
  }

  async chat(request) {
    const providerName = request.provider || process.env.AI_PROVIDER || 'default';
    const provider = this.providers[providerName];

    if (!provider) {
      throw new Error(`AI provider '${providerName}' não configurado`);
    }

    return provider.chatCompletion(request);
  }
}

export function normalizeOpenAIResponse(content, model = 'agil-ai') {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: 'stop'
      }
    ]
  };
}
