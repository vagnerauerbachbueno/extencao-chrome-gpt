import { normalizeOpenAIResponse } from '../core/ai_gateway.js';

export function createOpenAICompatibleProvider(client) {
  return {
    async chatCompletion(request) {
      const response = await client(request);
      const content = response?.choices?.[0]?.message?.content ?? response;
      return normalizeOpenAIResponse(content, request.model);
    }
  };
}
