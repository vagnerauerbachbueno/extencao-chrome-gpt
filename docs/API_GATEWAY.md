# AI Gateway API

## Objetivo

Disponibilizar uma camada única para Chrome Extension, CLIs e agentes internos.

## Endpoints planejados

### GET /v1/agents

Lista agentes disponíveis.

### POST /v1/responses

Formato:

```json
{
  "model":"agil-ai",
  "messages":[
    {
      "role":"user",
      "content":"consulta estoque"
    }
  ],
  "tools":[]
}
```

Resposta:

```json
{
  "object":"response",
  "choices":[
    {
      "message":{
        "role":"assistant",
        "content":"resultado"
      }
    }
  ]
}
```

## Próximas integrações

- OpenAI compatible
- OpenRouter
- Gemini
- Local LLM
- OpenCode CLI
- agentes ERP
