# Extensão Chrome GPT

Ponte entre uma API compatível com OpenAI e uma sessão autenticada do ChatGPT Web.

## Objetivo

O cliente conversa somente com `/v1/chat/completions`. O navegador é um motor interno de execução.

```
Cliente
  -> API OpenAI-compatible
  -> fila
  -> WebSocket
  -> extensão Chrome
  -> chatgpt.com
  -> extensão
  -> API
  -> Cliente
```

O contrato público permanece padronizado nos dois modos:

- `stream: false`: uma resposta JSON `chat.completion`
- `stream: true`: SSE com `chat.completion.chunk` e `data: [DONE]`

## Compatibilidade de mensagens

A API aceita `system`, `developer`, `user` e `assistant`.

Como o ChatGPT Web recebe texto pela interface gráfica, mensagens anteriores são compiladas em um envelope interno antes de serem enviadas ao navegador. Para uma única mensagem `user`, o texto é enviado sem alteração.

Isso padroniza o contrato da API sem expor ao cliente os detalhes da extensão.

## Requisitos

- Node.js 20+
- Google Chrome ou Microsoft Edge
- Sessão autenticada em https://chatgpt.com/

## Servidor

```bash
cd server
npm install
cp .env.example .env
npm start
```

Servidor padrão: `http://localhost:5503`.

Testes do parser de tool_calls:

```bash
cd server
npm test
```

## Extensão

Abra `chrome://extensions`, ative "Modo do desenvolvedor", escolha "Carregar sem compactação" e selecione a pasta `extension`.

Abra o ChatGPT em uma aba e verifique o estado da extensão.

## Exemplo normal

```bash
curl http://localhost:5503/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model":"chatgpt-web",
    "stream":false,
    "messages":[{"role":"user","content":"Explique o que é Firebird."}]
  }'
```

Resposta:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1770000000,
  "model": "chatgpt-web",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

## Exemplo streaming

Envie `"stream": true`. A resposta usa `text/event-stream`:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","model":"chatgpt-web","choices":[{"index":0,"delta":{"content":"Olá"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","model":"chatgpt-web","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

## Variáveis

- `PORT`: porta HTTP/WebSocket, padrão 5503 (no `.env` do repositório)
- `API_KEY`: Bearer token opcional (recomendado fora de localhost)
- `TASK_TIMEOUT_MS`: timeout da tarefa, padrão 180000
- `QUEUE_TIMEOUT_MS`: timeout aguardando agente, padrão 120000
- `CORS_ORIGIN`: origem permitida, padrão `*`

## Tool calling

Quando a requisição inclui `tools`, o servidor instrui o ChatGPT Web a emitir JSON no formato:

```json
{"tool_call": {"name": "read_file", "arguments": {"path": "package.json"}}}
```

O parser aceita também o formato OpenAI `{"tool_calls": [...]}` e múltiplos `tool_call` na mesma resposta. A resposta OpenAI sai com `choices[].message.tool_calls` e `finish_reason: "tool_calls"`.

No streaming, as tool_calls são emitidas em um único chunk com `delta.tool_calls` indexado.

## Segurança

Não coloque credenciais do ChatGPT no servidor. A extensão usa a sessão existente do navegador. Em produção, use HTTPS/WSS, defina `API_KEY` e restrinja `CORS_ORIGIN`.
