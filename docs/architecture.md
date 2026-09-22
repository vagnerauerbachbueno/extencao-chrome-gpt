# Arquitetura

## Componentes

### API
Implementa os endpoints OpenAI-compatible e transforma cada chamada em uma tarefa. Inclui o parser de tool_calls (`server/src/parser.js`).

### Task Manager
Mantém fila, estado, timeout e associação entre tarefa e agente de navegador.

### WebSocket Hub
Conecta instâncias da extensão e distribui tarefas para agentes disponíveis. Autenticação via query `?token=` quando `API_KEY` está definida.

### Chrome Extension
Manifest V3 com service worker e content script. O service worker mantém o WebSocket e o content script opera a página do ChatGPT. Quando `new_conversation` é verdadeiro, o content script inicia um chat novo antes de enviar o prompt (evita acúmulo de histórico).

## Estados

```
queued -> processing -> completed
                    \-> error
```

## Princípios

- A API não depende da sessão do navegador.
- A extensão não recebe credenciais do ChatGPT.
- Cada tarefa possui ID único.
- Um agente processa uma tarefa por vez.
- Desconexão e timeout encerram a tarefa.
