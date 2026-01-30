# 📊 Relatório Completo: Sistema de Bots e Agentes

**Data:** 2026-01-29
**Autor:** MoltBot Agent
**Solicitado por:** Markus Glucksberg

---

## 🏗️ Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MOLTBOT GATEWAY                                 │
│                         (Servidor: ubuntu-32gb-fsn1-1)                       │
│                              Modelo: Claude Opus 4.5                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │    main     │  │   moltbot   │  │  cloudfarm  │  │   opsec     │        │
│  │     🔮      │  │     🤖      │  │     🛠️      │  │     🔒      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   devops    │  │ researcher  │  │code-reviewer│  │  architect  │        │
│  │     ⚙️      │  │     🔬      │  │     🔍      │  │     🏗️      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                                              │
│  ┌─────────────┐                                                            │
│  │  extractor  │  (standby)                                                 │
│  │     🚛      │                                                            │
│  └─────────────┘                                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📱 Plataformas

### Moltbot (ex-ClawdBot)
- **Repositório:** `/home/dev/clawdbot` (fork de moltbot/moltbot)
- **Função:** Framework de agentes IA multi-canal
- **Canais:** Telegram, WhatsApp, Discord, etc.
- **Config:** `~/.moltbot/moltbot.json`

### CloudFarm
- **Repositório:** `/home/dev/projects/CloudFarm`
- **Função:** Sistema de gestão agrícola (soja/milho)
- **Stack:** Node.js, Express, MongoDB, Telegram Bot
- **Módulos:** Estoque, Talhões, Máquinas, Combustível, Biológicos, Receituário

---

## 🤖 Agentes Detalhados

### 1. main 🔮 (Clawd)
| Atributo | Valor |
|----------|-------|
| **ID** | `main` |
| **Nome** | Clawd |
| **Workspace** | `/home/dev/clawdbot/agents/main` |
| **Grupo Telegram** | *(sem binding específico - default)* |
| **Função** | Agente principal/generalista |
| **Especialidade** | Assistente pessoal geral |
| **Status** | ⚠️ Não inicializado (IDENTITY.md vazio) |
| **Modelo** | Claude Opus 4.5 (default) |

---

### 2. moltbot 🤖 (EU)
| Atributo | Valor |
|----------|-------|
| **ID** | `moltbot` |
| **Nome** | MoltBot |
| **Workspace** | `/home/dev/clawdbot/agents/moltbot` |
| **Grupo Telegram** | MoltBot Fork CEO (`-1003680817077`) |
| **Função** | Agente dedicado ao projeto Moltbot |
| **Especialidade** | Desenvolvimento, PRs, issues, monitoramento do repo |
| **Status** | ✅ Ativo e configurado |
| **Modelo** | Claude Opus 4.5 |
| **Cronjob** | `moltbot-smart-monitor` (4h) - monitora repo oficial |

**Características:**
- Pragmático, hands-on
- Conhece o código do Moltbot
- Monitora PRs/issues do repo oficial
- Posta comentários linkando issues relacionadas
- Reporta atividade no grupo

**Arquivos de Estado:**
- `memory/moltbot-monitor-state.json` - comentários postados
- `memory/moltbot-stats-history.json` - histórico de snapshots
- `moltbot-monitor-spec.md` - especificação do monitor
- `moltbot-triage-plan.md` - plano de triagem

---

### 3. cloudfarm 🛠️ (CloudFarm Dev)
| Atributo | Valor |
|----------|-------|
| **ID** | `cloudfarm` |
| **Nome** | CloudFarm Dev |
| **Workspace** | `/home/dev/projects/CloudFarm` |
| **agentDir** | `/home/dev/projects/CloudFarm/agents/cloudfarm-dev` |
| **Grupo Telegram** | MoltBot - CloudFarm CEO (`-1003599342443`) |
| **Função** | Desenvolvimento do CloudFarm |
| **Especialidade** | Debug, código, arquitetura, testes |
| **Status** | ✅ Ativo e configurado |
| **Modelo** | Claude Opus 4.5 (default) |

**Características:**
- Técnico e direto
- Acesso total ao código e banco
- Pode modificar código (com confirmação)
- Discussões de arquitetura
- **SEPARADO do Claudinho** (produção)

---

### 4. opsec 🔒 (OpSec)
| Atributo | Valor |
|----------|-------|
| **ID** | `opsec` |
| **Nome** | OpSec |
| **Workspace** | `/home/dev/projects/CloudFarm/agents/opsec` |
| **Grupo Telegram** | OpSec Dev (`-1002912787560`) |
| **Função** | Segurança e operações |
| **Especialidade** | Code review de segurança, alertas, multi-tenant |
| **Status** | ✅ Ativo e configurado |
| **Modelo** | Claude Sonnet 4 |
| **Heartbeat** | 15 min (06:00-23:00 BRT) |

**Características:**
- Especialista em segurança B2B SaaS
- Dupla função: Dev + Alertas
- Sistema de falsos positivos v1.1
- Tools restritos (allow list)
- Foco em multi-tenant isolation

---

### 5. devops ⚙️
| Atributo | Valor |
|----------|-------|
| **ID** | `devops` |
| **Nome** | DevOps Agent |
| **Workspace** | `/home/dev/clawdbot/agents/devops` |
| **Grupo Telegram** | (`-1003570642163`) |
| **Função** | DevOps e infraestrutura |
| **Status** | ⚠️ Não inicializado (IDENTITY.md vazio) |
| **Modelo** | Claude Opus 4.5 (default) |
| **Heartbeat** | 15 min |

---

### 6. researcher 🔬
| Atributo | Valor |
|----------|-------|
| **ID** | `researcher` |
| **Nome** | Researcher |
| **Workspace** | `/home/dev/clawdbot/agents/researcher` |
| **Grupo Telegram** | Research (`-1003840574484`) |
| **Função** | Pesquisa e análise |
| **Status** | ⚠️ Parcialmente configurado |
| **Modelo** | Claude Opus 4.5 (default) |

**Nota:** O sistema de monitoramento do Moltbot foi migrado deste agente para o `moltbot`.

---

### 7. code-reviewer 🔍
| Atributo | Valor |
|----------|-------|
| **ID** | `code-reviewer` |
| **Nome** | Code Reviewer |
| **Workspace** | `/home/dev/clawdbot/agents/code-reviewer` |
| **Grupo Telegram** | (`-1003721066242`) |
| **Função** | Review de código |
| **Especialidade** | Bugs, segurança, performance, testes |
| **Status** | ⚠️ Não inicializado (IDENTITY.md vazio) |
| **Modelo** | Claude Opus 4.5 (default) |

**Características (do SOUL.md específico):**
- Cirúrgico, zero bullshit
- Foco: Correctness, Security, Reliability, Performance
- Formato: Summary + Risk Level + Must-Fix + Important + Tests

---

### 8. architect 🏗️
| Atributo | Valor |
|----------|-------|
| **ID** | `architect` |
| **Nome** | Architect |
| **Workspace** | `/home/dev/clawdbot/agents/architect` |
| **Grupo Telegram** | (`-1003776583305`) |
| **Função** | Arquitetura de software |
| **Status** | ⚠️ Não inicializado |
| **Modelo** | Claude Opus 4.5 (default) |

---

### 9. extractor 🚛
| Atributo | Valor |
|----------|-------|
| **ID** | `extractor` |
| **Nome** | Extractor |
| **Workspace** | `/home/dev/clawdbot/agents/extractor` |
| **Grupo Telegram** | *(sem binding)* |
| **Função** | Extração de dados (cargas de grãos) |
| **Status** | 💤 Standby |
| **Modelo** | Claude Sonnet 4 |

**Projeto relacionado:** ZapExtractor (`/home/dev/projects/zapextractor`)
- Sistema de OCR via WhatsApp
- Extrai peso, motorista, data de imagens
- OpenAI Vision API

---

## 🌾 CloudFarm: Agentes Internos

Além dos agentes Moltbot, o CloudFarm tem agentes com workspaces próprios:

### Claudinho (Produção) 🌾
| Atributo | Valor |
|----------|-------|
| **Localização** | `/home/dev/projects/CloudFarm/agents/claudinho` |
| **Função** | Atendimento a usuários finais |
| **Acesso** | READ-ONLY |
| **Multi-tenant** | Sim, isolado por fazenda |
| **Status** | 📦 Workspace configurado (não é agente Moltbot) |

**Características:**
- Linguagem simples, sem jargões
- Respostas curtas (2-3 frases)
- Usa emojis moderadamente
- Proibido falar de SQL, API, JSON
- Scripts helper: `cf-query.js`, `cf-stats.js`

**DIFERENTE do CloudFarm Dev** - são separados para isolamento de segurança!

### Error Analyzer 🔍
| Atributo | Valor |
|----------|-------|
| **Localização** | `/home/dev/projects/CloudFarm/agents/error-analyzer` |
| **Função** | Análise de erros de produção |
| **Status** | 🔮 Futuro (workspace existe, não ativo) |

---

## ⏰ Cronjobs Ativos

| Nome | Agente | Intervalo | Função |
|------|--------|-----------|--------|
| `moltbot-smart-monitor` | moltbot | 4 horas | Monitora repo moltbot/moltbot, posta comentários |

---

## 📊 Bindings (Telegram → Agente)

| Grupo | ID | Agente |
|-------|-----|--------|
| MoltBot Fork CEO | `-1003680817077` | moltbot |
| MoltBot - CloudFarm CEO | `-1003599342443` | cloudfarm |
| OpSec Dev | `-1002912787560` | opsec |
| Research | `-1003840574484` | researcher |
| (DevOps) | `-1003570642163` | devops |
| (Code Review) | `-1003721066242` | code-reviewer |
| (Architect) | `-1003776583305` | architect |

---

## 🔄 Interações Entre Plataformas

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              TELEGRAM                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Fork CEO    │  │CloudFarm CEO│  │  OpSec Dev  │  │  Research   │    │
│  │  (moltbot)  │  │ (cloudfarm) │  │   (opsec)   │  │ (researcher)│    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
└─────────┼────────────────┼────────────────┼────────────────┼────────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           MOLTBOT GATEWAY                                │
│                                                                          │
│   Roteamento por binding: grupo → agente → workspace → resposta         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
          │                │                │
          ▼                ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │   Moltbot    │ │  CloudFarm   │ │  CloudFarm   │
   │   Repo       │ │   Repo       │ │   MongoDB    │
   │  (GitHub)    │ │   (Local)    │ │   (Atlas)    │
   └──────────────┘ └──────────────┘ └──────────────┘
```

### Fluxo de Trabalho

1. **Mensagem no Telegram** → Gateway identifica grupo → Roteia para agente
2. **Agente processa** → Lê workspace, executa tools, gera resposta
3. **Resposta enviada** → De volta ao grupo Telegram

### Compartilhamento de Recursos

- **Todos os agentes** compartilham o mesmo gateway
- **CloudFarm Dev** e **OpSec** compartilham acesso ao repo CloudFarm
- **Moltbot** tem cronjob que interage com GitHub (repo oficial)

---

## 📈 Status Geral

| Agente | Inicializado | Grupo | Ativo | Observação |
|--------|--------------|-------|-------|------------|
| main | ❌ | ❌ | ⚠️ | Falta configurar |
| **moltbot** | ✅ | ✅ | ✅ | Funcionando |
| **cloudfarm** | ✅ | ✅ | ✅ | Funcionando |
| **opsec** | ✅ | ✅ | ✅ | Funcionando |
| devops | ❌ | ✅ | ⚠️ | Falta inicializar |
| researcher | ⚠️ | ✅ | ⚠️ | Parcial |
| code-reviewer | ❌ | ✅ | ⚠️ | Falta inicializar |
| architect | ❌ | ✅ | ⚠️ | Falta inicializar |
| extractor | ❌ | ❌ | 💤 | Standby |

---

## 🎯 Recomendações

1. **Inicializar agentes pendentes** — main, devops, code-reviewer, architect têm IDENTITY.md vazios
2. **Criar SOUL.md específicos** — A maioria usa o template genérico
3. **Ativar Error Analyzer** — Workspace existe, falta binding e config
4. **Decidir sobre Extractor** — Projeto ZapExtractor está em standby
5. **Documentar grupos Telegram** — Criar tabela com nomes reais dos grupos

---

*Relatório gerado por MoltBot Agent em 2026-01-29*
