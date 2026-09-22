import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, isRefusalText, isActionIntentText } from './src/parser.js';

test('parseia tool_call único simples', () => {
  const result = parseToolCalls('{"tool_call":{"name":"glob","arguments":{"pattern":"*"}}}');
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, 'glob');
  assert.equal(result[0].function.arguments, '{"pattern":"*"}');
  assert.equal(result[0].type, 'function');
  assert.ok(result[0].id.startsWith('call_'));
});

test('parseia tool_call dentro de bloco markdown', () => {
  const content = 'Claro!\n```json\n{"tool_call":{"name":"read_file","arguments":{"path":"package.json"}}}\n```';
  const result = parseToolCalls(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, 'read_file');
});

test('parseia múltiplos tool_call objects', () => {
  const content = [
    '{"tool_call":{"name":"glob","arguments":{"pattern":"**/*"}}}',
    ' e depois ',
    '{"tool_call":{"name":"read_file","arguments":{"path":"a.js"}}}'
  ].join('');
  const result = parseToolCalls(content);
  assert.equal(result.length, 2);
  assert.equal(result[0].function.name, 'glob');
  assert.equal(result[1].function.name, 'read_file');
});

test('parseia array tool_calls estilo OpenAI', () => {
  const content = '{"tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}},{"function":{"name":"read_file","arguments":{"path":"x"}}}]}';
  const result = parseToolCalls(content);
  assert.equal(result.length, 2);
  assert.equal(result[0].function.name, 'bash');
  assert.equal(result[1].function.name, 'read_file');
});

test('argumentos string permanecem string', () => {
  const result = parseToolCalls('{"tool_call":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}');
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, 'bash');
  assert.equal(typeof result[0].function.arguments, 'string');
});

test('chaves aninhadas nos argumentos não quebram o parser', () => {
  const args = { pattern: 'src/**', options: { hidden: true, note: 'fecha } aqui' } };
  const content = `Texto antes {"tool_call":{"name":"glob","arguments":${JSON.stringify(args)}}} depois`;
  const result = parseToolCalls(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, 'glob');
  assert.deepEqual(JSON.parse(result[0].function.arguments), args);
});

test('retorna null para texto puro', () => {
  assert.equal(parseToolCalls('Olá, tudo bem?'), null);
  assert.equal(parseToolCalls(''), null);
  assert.equal(parseToolCalls(null), null);
});

test('retorna null para JSON sem tool_call', () => {
  assert.equal(parseToolCalls('{"hello":"world"}'), null);
});

test('isRefusalText detecta recusa em PT e EN', () => {
  assert.equal(isRefusalText('Não consigo executar essa ferramenta.'), true);
  assert.equal(isRefusalText('A ferramenta não está disponível nesta sessão.'), true);
  assert.equal(isRefusalText("I don't have access to the tools."), true);
  assert.equal(isRefusalText('No tools are available.'), true);
  assert.equal(isRefusalText('Aqui está o arquivo solicitado.'), false);
  assert.equal(isRefusalText(''), false);
});

test('isRefusalText detecta recusa longa do ChatGPT sobre terminal/arquivos', () => {
  const refusal = `Não consegui concluir a análise do código local porque, nesta execução, o ambiente de ferramentas disponível não expôs o terminal/arquivos do diretório C:\\Users\\vagne\\Desktop\\extencao-chrome-gpt.

Não vou inventar uma análise com base apenas no nome do projeto ou no histórico.

Para eu fazer a análise real do projeto, preciso conseguir acessar os arquivos locais desta pasta. Assim que o acesso ao workspace estiver disponível, a análise que farei será:`;
  assert.equal(isRefusalText(refusal), true);
  assert.equal(isRefusalText('The environment did not expose the terminal.'), true);
  assert.equal(isRefusalText('Bom dia, Vagner. Como posso ajudar hoje?'), false);
});

test('repara caminho Windows com barras não escapadas', () => {
  const content = '{"tool_call":{"name":"glob","arguments":{"pattern":"*/","path":"C:\\Users\\vagne\\Desktop\\proj"}}}';
  const result = parseToolCalls(content);
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, 'glob');
  const args = JSON.parse(result[0].function.arguments);
  assert.equal(args.path, 'C:\\Users\\vagne\\Desktop\\proj');
});

test('repara path estilo read com filePath Windows', () => {
  const raw = '{"tool_call":{"name":"read","arguments":{"filePath":"C:\\Users\\vagne\\Desktop\\extencao-chrome-gpt\\server\\src\\index.js","offset":180,"limit":180}}}';
  const result = parseToolCalls(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, 'read');
  const args = JSON.parse(result[0].function.arguments);
  assert.ok(args.filePath.includes('index.js'));
});

test('isActionIntentText detecta narração de intenção', () => {
  assert.equal(isActionIntentText('Vou analisar o estado'), true);
  assert.equal(isActionIntentText('Let me check the files.'), true);
  assert.equal(isActionIntentText("I'll read package.json"), true);
  assert.equal(isActionIntentText('Primeiro vou listar o diretório'), true);
  assert.equal(isActionIntentText('Aqui está a análise completa do projeto com vários detalhes e explicação longa da arquitetura...'), false);
  assert.equal(isActionIntentText('{"tool_call":{"name":"glob","arguments":{}}}'), false);
  assert.equal(isActionIntentText(''), false);
});
