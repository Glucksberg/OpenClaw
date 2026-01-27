# Clawd Playground

> ⚠️ **Sync:** Este arquivo é espelhado com `CLAUDE.md`. Ao atualizar um, atualize o outro.

Este diretório é um **playground** — um espaço neutro para prototipar, experimentar e desenvolver ideias.

## Estrutura

```
clawd/
├── README.md           # Este arquivo
├── CLAUDE.md           # Instruções para o agente
├── AGENTS.md           # Configuração do agente
├── SOUL.md             # Personalidade do agente
├── IDENTITY.md         # Identidade do agente
├── USER.md             # Info sobre o usuário
├── TOOLS.md            # Notas sobre ferramentas
├── HEARTBEAT.md        # Checklist de heartbeat
├── memory/             # Logs diários e memória
└── [projeto]/          # Subpastas de projetos
```

## Como Usar

### Iniciando uma nova ideia

1. **Crie uma subpasta** com nome descritivo:
   ```bash
   mkdir minha-ideia
   cd minha-ideia
   ```

2. **Crie um README.md** na subpasta explicando a ideia:
   ```markdown
   # Minha Ideia
   
   ## Objetivo
   O que você quer construir/explorar.
   
   ## Status
   - [ ] Fase 1: Pesquisa
   - [ ] Fase 2: Protótipo
   - [ ] Fase 3: Refinamento
   ```

3. **Documente o processo** em arquivos `.md`:
   - `NOTES.md` — anotações e descobertas
   - `TODO.md` — próximos passos
   - `DECISIONS.md` — decisões tomadas e por quê

### Projetos existentes

| Pasta | Descrição |
|-------|-----------|
| `monitors/` | Scripts de monitoramento |
| `canvas/` | Experimentos com canvas |

## Convenções

- **Uma ideia = uma subpasta**
- **Documentar sempre** — arquivos `.md` são seus amigos
- **Commits frequentes** — este repo tem git
- **Experimente livremente** — é um playground!

## Acesso a outros diretórios

O agente tem acesso a outras pastas em `/home/dev/`:
- `projects/` — projetos mais maduros
- `clawdbot/` — código fonte do Clawdbot
- `agents/` — outros agentes

Quando um protótipo amadurecer, pode ser movido para `projects/`.
