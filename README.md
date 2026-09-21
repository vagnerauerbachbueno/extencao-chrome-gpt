# Extensão Chrome GPT

Ponte entre uma API compatível com OpenAI e uma sessão autenticada do ChatGPT Web.

## Arquitetura

Cliente -> POST /v1/chat/completions -> API -> fila -> WebSocket -> extensão Chrome -> chatgpt.com -> resposta -> API -> cliente.

> Este projeto automatiza a interface web já autenticada no navegador. Ele não usa nem expõe cookies ou credenciais da conta.

## Requisitos

- Node.js 20+
- Google Chrome ou Microsoft Edge
- Uma sessão autenticada em https://chatgpt.com/

## Servidor

```bash
cd server
npm install
cp .env.example .env
npm start
```

Servidor padrão: `http://localhost:8787`.

## Extensão

Abra `chrome://extensions`, ative "Modo do desenvolvedor", escolha "Carregar sem compactação" e selecione a pasta `extension`.

Abra o ChatGPT em uma aba e clique na extensão para conferir o estado.

## API

```bash
curl http://localhost:8787/v1/models
```

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local-dev" \
  -d '{
    "model":"chatgpt-web",
    "messages":[{"role":"user","content":"Olá, responda apenas OK."}]
  }'
```

Para streaming, envie `"stream": true`.

## Variáveis

- `PORT`: porta HTTP/WebSocket, padrão 8787
- `API_KEY`: opcional; quando definida, exige Bearer token
- `TASK_TIMEOUT_MS`: timeout de uma tarefa, padrão 180000
- `CORS_ORIGIN`: origem permitida, padrão `*`

## Segurança

Não coloque credenciais do ChatGPT no servidor. A extensão usa a sessão existente do navegador. Em produção, defina `API_KEY`, use HTTPS/WSS e restrinja CORS.
