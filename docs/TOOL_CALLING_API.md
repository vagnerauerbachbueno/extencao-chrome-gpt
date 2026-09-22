# Tool Calling API

O gateway expõe ferramentas em formato padronizado para clientes CLI e extensão.

## Descoberta

GET `/v1/tools`

Resposta:

```json
{
  "object": "list",
  "data": [
    {
      "name": "read_file",
      "parameters": {}
    }
  ]
}
```

## Execução

Formato compatível com function calling:

```json
{
  "tool_call": {
    "name": "read_file",
    "arguments": {
      "path": "README.md"
    }
  }
}
```

O mesmo contrato pode ser usado por Chrome Extension, OpenCode CLI e outros clientes.
