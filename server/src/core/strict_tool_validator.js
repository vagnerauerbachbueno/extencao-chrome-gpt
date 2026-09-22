import { randomUUID } from 'node:crypto';

const ACTION_PATTERNS = [
  /vou\s+(criar|alterar|editar|analisar|verificar|ler|abrir)/i,
  /não encontrei|nao encontrei|não tenho acesso|nao tenho acesso/i,
  /envie\s+(o|os|a|as)\s+(arquivo|projeto|conteudo)/i,
  /i will|i'll|let me|i need access|cannot access/i
];

function call(name, argumentsValue = {}) {
  return {
    id: `call_${randomUUID().slice(0, 9)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(argumentsValue)
    }
  };
}

export function isStrictToolMode(text = '') {
  return ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateAssistantOutput(content, tools = []) {
  if (!content || !Array.isArray(tools) || tools.length === 0) return null;

  if (!isStrictToolMode(content)) return null;

  const names = tools.map((item) => item.function?.name || item.name).filter(Boolean);

  const safeRead = names.find((name) => ['glob', 'list_directory', 'read', 'read_file'].includes(name));
  const write = names.find((name) => ['write', 'write_file', 'create_file'].includes(name));

  if (/criar|create|write|editar|alterar/i.test(content) && write) {
    return [call(write, { filePath: 'index.html', content: '' })];
  }

  if (safeRead) {
    return [call(safeRead, { path: '.' })];
  }

  return null;
}
