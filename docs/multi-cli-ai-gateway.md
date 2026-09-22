# Multi CLI AI Gateway

## Objetivo

Transformar a extensão Chrome GPT em uma camada intermediária compatível com múltiplos clientes:

- Chrome Extension
- OpenCode CLI
- Claude CLI
- Gemini CLI
- APIs próprias

## Contrato

O gateway mantém compatibilidade com o formato OpenAI Chat Completions.

Entrada:

```json
{
  "messages": [{"role":"user","content":"pergunta"}],
  "provider":"default"
}
```

Saída:

```json
{
  "object":"chat.completion",
  "choices":[{"message":{"role":"assistant","content":"resposta"}}]
}
```

## Próximas etapas

- Integrar gateway no endpoint `/v1/chat/completions`
- Adicionar providers OpenRouter, Gemini e modelos locais
- Padronizar tool calling
- Adicionar memória por workspace `.ia`
