export class AIRouter {
  constructor(providers = {}) {
    this.providers = providers;
  }

  register(name, provider) {
    this.providers[name] = provider;
  }

  get(name) {
    return this.providers[name];
  }

  async completion(request) {
    const providerName = request.provider || process.env.DEFAULT_AI_PROVIDER || 'openai';
    const provider = this.get(providerName);

    if (!provider) {
      throw new Error(`Provider AI não encontrado: ${providerName}`);
    }

    return provider.completion(request);
  }
}

export default AIRouter;
