# Protocolo WebSocket

O WebSocket é interno entre o servidor compatível com OpenAI e a extensão.

## Server -> Agent

```json
{
  "type": "task",
  "task_id": "chatcmpl-...",
  "model": "chatgpt-web",
  "stream": false,
  "new_conversation": true,
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "message": "Prompt compilado para o ChatGPT Web"
}
```

## Agent -> Server

Pronto:

```json
{"type":"agent.ready"}
```

Delta de streaming:

```json
{"type":"task.delta","task_id":"chatcmpl-...","content":"texto"}
```

Resultado:

```json
{
  "type":"task.result",
  "task_id":"chatcmpl-...",
  "ok":true,
  "content":"..."
}
```

## Contrato OpenAI

O endpoint público é:

`POST /v1/chat/completions`

Ele mantém os campos principais do Chat Completions:

- `model`
- `messages`
- `stream`
- `tools` (opcional; ativa tool calling)
- `choices[].message.role`
- `choices[].message.content`
- `choices[].message.tool_calls` (quando o modelo emite tool_call)
- `choices[].finish_reason` (`stop` ou `tool_calls`)
- `usage`
- streaming via SSE com `chat.completion.chunk` e `[DONE]`

### Tool calls

Formato aceito na resposta bruta do ChatGPT Web:

```json
{"tool_call": {"name": "read_file", "arguments": {"path": "package.json"}}}
```

Também são aceitos múltiplos `tool_call` e o array `tool_calls` no padrão OpenAI. O servidor converte para:

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": {"name": "read_file", "arguments": "{...}"}
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

A extensão nunca retorna um formato próprio ao cliente. Ela apenas entrega o texto do ChatGPT Web ao servidor, e o servidor converte o resultado para o contrato OpenAI.
