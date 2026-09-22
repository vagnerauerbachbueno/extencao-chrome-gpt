// Provider Registry
// Centraliza provedores de IA usados pelo AI Gateway.

const providers = new Map();

export function registerProvider(name, provider) {
  providers.set(name, provider);
}

export function getProvider(name) {
  return providers.get(name);
}

export function listProviders() {
  return [...providers.keys()];
}

export async function completion(request) {
  const name = request.provider || process.env.DEFAULT_AI_PROVIDER || 'default';
  const provider = getProvider(name);

  if (!provider) {
    throw new Error(`Provider não encontrado: ${name}`);
  }

  return provider.completion(request);
}
