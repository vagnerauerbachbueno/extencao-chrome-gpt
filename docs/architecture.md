# Arquitetura

## Componentes

### API
Implementa os endpoints OpenAI-compatible e transforma cada chamada em uma tarefa.

### Task Manager
Mantém fila, estado, timeout e associação entre tarefa e agente de navegador.

### WebSocket Hub
Conecta instâncias da extensão e distribui tarefas para agentes disponíveis.

### Chrome Extension
Manifest V3 com service worker e content script. O service worker mantém o WebSocket e o content script opera a página do ChatGPT.

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
