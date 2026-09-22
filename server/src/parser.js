import { randomUUID } from 'node:crypto';

function makeCall(name, args) {
  return {
    id: `call_${randomUUID().slice(0, 9)}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args || {})
    }
  };
}

// ChatGPT costuma emitir caminhos Windows inválidos em JSON: "C:\Users\..." (\U não é escape válido).
function sanitizeJson(raw) {
  return raw.replace(/\\(?![\"\\/bfnrtu])/g, '\\\\');
}

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(sanitizeJson(raw));
    } catch {
      return null;
    }
  }
}

function extractBalancedJsonObjects(content) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function fromToolCallObject(parsed) {
  const tc = parsed.tool_call;
  if (!tc?.name) return null;
  return [makeCall(tc.name, tc.arguments)];
}

function fromToolCallsObject(parsed) {
  const list = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : null;
  if (!list || list.length === 0) return null;

  const calls = [];
  for (const item of list) {
    const name = item?.function?.name || item?.name;
    if (!name) continue;
    const args = item?.function?.arguments ?? item?.arguments ?? {};
    calls.push(makeCall(name, args));
  }
  return calls.length > 0 ? calls : null;
}

function fromOpenAIStyleItem(item) {
  if (!item) return null;
  const name = item.function?.name || item.name;
  if (!name) return null;
  return makeCall(name, item.function?.arguments ?? item.arguments ?? {});
}

export function parseToolCalls(content) {
  if (!content || typeof content !== 'string') return null;

  // 1. Blocos JSON balanceados (suporta múltiplos objetos e aninhamento)
  const candidates = extractBalancedJsonObjects(content);
  const collected = [];

  for (const raw of candidates) {
    const parsed = tryParse(raw);
    if (!parsed) continue;

    if (parsed?.tool_call) {
      const calls = fromToolCallObject(parsed);
      if (calls) collected.push(...calls);
    } else if (parsed?.tool_calls) {
      const calls = fromToolCallsObject(parsed);
      if (calls) collected.push(...calls);
    }
  }

  if (collected.length > 0) return collected;

  // 2. Fallback: fatiar do primeiro { ao último } (objeto único envolto em texto)
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(content.slice(start, end + 1));
    if (parsed?.tool_call) return fromToolCallObject(parsed);
    if (parsed?.tool_calls) return fromToolCallsObject(parsed);
  }

  return null;
}

export function isRefusalText(content) {
  if (!content) return false;
  return /n[ãa]o (consigo|consegui|pude|foi poss[íi]vel|expôs|expor|disponibiliz|concluir)|n[ãa]o (est[áa]|foram?|vão estar) dispon[íi]vel|ferramentas?[^.\n]{0,100}n[ãa]o|terminal[^.\n]{0,100}n[ãa]o|arquivos?[^.\n]{0,80}n[ãa]o (exp|dispon|acess)|ambiente de ferramentas|n[ãa]o exp[ôo]s|preciso (que |do |de |ter )?(acesso|ferramenta|terminal|expor)|assim que o acesso|workspace estiver dispon[íi]vel|n[ãa]o vou inventar|acesso (ao workspace|dos arquivos|local) (est[áa] |n[ãa]o )|no tools? (are |were )?(available|provided|exposed)|tools? (were |are |not )?(not )?(available|exposed|provided)|i don'?t (have|have access to) (the )?tools?|cannot (execute|run|use|access) (the )?(tool|function|terminal|files)|tool (is|was) not (available|provided)|don'?t have (access|the tools)|not exposed|couldn'?t (access|complete)|unable to (access|run|use|complete)|did not (expose|provide) (the )?(tool|terminal)|environment did not/i.test(content);
}

// O modelo narra a intenção de usar uma ferramenta ("Vou analisar...", "Let me check...")
// em vez de emitir o JSON. Tratar como tool_call pendente quando houver tools.
export function isActionIntentText(content) {
  if (!content) return false;
  if (content.includes('tool_call')) return false;
  const trimmed = content.trim();
  if (trimmed.length > 400) return false;
  return /^(vou |vamos |vamos a|let me |i'?ll |i will |primeiro,? |first,? |analis|verificar|checking|preciso |deixe-me|deixa eu|i need to |going to |allow me )/i.test(trimmed);
}
