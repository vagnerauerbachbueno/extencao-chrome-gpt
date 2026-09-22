# GOAL - Multi CLI AI Gateway

## Objetivo

Transformar o extencao-chrome-gpt em uma camada de inteligência centralizada capaz de atender múltiplos clientes mantendo compatibilidade com APIs de chat.

## Arquitetura alvo

```
Clientes
  |
  +-- Chrome Extension
  +-- OpenCode CLI
  +-- Claude CLI
  +-- Gemini CLI
  +-- Aplicações ERP

          |
          v

AI Gateway

  +-- Context Manager
  +-- Memory Manager
  +-- Tool Calling Engine
  +-- Agent Router
  +-- Provider Adapter

          |
          v

Providers

  +-- OpenAI
  +-- OpenRouter
  +-- Gemini
  +-- Local LLM
```

## Metas

- Usar um único contrato de mensagens.
- Permitir troca de modelos sem alterar clientes.
- Padronizar tool calling.
- Suportar agentes especializados.
- Compartilhar contexto entre CLI e extensão.
- Preparar integração com projetos ERP e agentes .ia.

## Fases

### Fase 1

- Criar camada gateway.
- Criar adapters de providers.
- Normalizar resposta compatível com Chat Completions.

### Fase 2

- Memória persistente.
- Skills.
- Agentes.
- Contexto por workspace.

### Fase 3

- Streaming SSE.
- Controle de custos.
- Métricas.
- Multi usuário.

## Princípio

A extensão Chrome deve ser apenas uma interface cliente. Toda regra de inteligência deve permanecer no gateway para permitir evolução independente dos clientes.
