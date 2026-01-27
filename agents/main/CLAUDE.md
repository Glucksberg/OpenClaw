# CLAUDE.md — Instruções do Playground

> ⚠️ **Sync:** Este arquivo é espelhado com `README.md`. Ao atualizar um, atualize o outro.

Este diretório (`/home/dev/clawd`) é o **playground** — seu espaço de trabalho para prototipar e experimentar.

## Regras do Playground

### Ao iniciar uma nova ideia:

1. **Crie uma subpasta** com nome descritivo (kebab-case)
2. **Crie um README.md** na subpasta com:
   - Objetivo da ideia
   - Status/checklist
   - Notas iniciais
3. **Documente o processo** em arquivos `.md` conforme avança

### Organização de arquivos:

```
nova-ideia/
├── README.md      # Obrigatório: objetivo e status
├── NOTES.md       # Descobertas e anotações
├── TODO.md        # Próximos passos
├── DECISIONS.md   # Decisões e justificativas
└── src/           # Código (se aplicável)
```

### Convenções:

- **Uma ideia por subpasta** — não misture projetos
- **Documente decisões** — seu eu futuro agradece
- **Commits atômicos** — este repo tem git
- **Experimente livremente** — erros são aprendizado

## Estrutura deste diretório

| Arquivo/Pasta | Propósito |
|---------------|-----------|
| `AGENTS.md` | Sua configuração base |
| `SOUL.md` | Sua personalidade |
| `IDENTITY.md` | Sua identidade |
| `USER.md` | Info sobre seu humano |
| `TOOLS.md` | Notas sobre ferramentas |
| `HEARTBEAT.md` | Checklist de heartbeat |
| `memory/` | Logs diários |
| `monitors/` | Projeto: scripts de monitoramento |
| `canvas/` | Projeto: experimentos canvas |

## Acesso externo

Você tem acesso a `/home/dev/` e suas subpastas:

| Diretório | Uso |
|-----------|-----|
| `projects/` | Projetos maduros (ex: claude-mem) |
| `clawdbot/` | Código fonte do Clawdbot |
| `agents/` | Outros agentes |

**Quando um protótipo amadurecer:** mova para `projects/`.

## Lembrete

Este é um playground. Experimente, falhe rápido, aprenda. Documente o suficiente para não perder contexto, mas não tanto que atrapalhe a velocidade.
