# Protocolo WebSocket

## Server -> Agent

```json
{
  "type": "task",
  "task_id": "task-...",
  "model": "chatgpt-web",
  "new_conversation": true,
  "message": "..."
}
```

## Agent -> Server

Pronto:

```json
{"type":"agent.ready"}
```

Resultado:

```json
{
  "type":"task.result",
  "task_id":"task-...",
  "ok":true,
  "content":"..."
}
```

Erro:

```json
{
  "type":"task.result",
  "task_id":"task-...",
  "ok":false,
  "error":"..."
}
```
