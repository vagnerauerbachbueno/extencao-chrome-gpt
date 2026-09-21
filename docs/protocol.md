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
- `choices[].message.role`
- `choices[].message.content`
- `choices[].finish_reason`
- `usage`
- streaming via SSE com `chat.completion.chunk` e `[DONE]`

A extensão nunca retorna um formato próprio ao cliente. Ela apenas entrega o texto do ChatGPT Web ao servidor, e o servidor converte o resultado para o contrato OpenAI.
