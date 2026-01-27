# CloudFarm → Clawdbot: Plano de Migração de Ferramentas IA

> **Objetivo:** Migrar todas as ferramentas de IA do CloudFarm para uma stack unificada baseada em Clawdbot, eliminando dependências fragmentadas e centralizando inteligência em um único agente.

**Criado em:** 2026-01-27  
**Status:** Em andamento  
**Autor:** Assistente Clawd

---

## 📋 Índice

1. [Inventário Consolidado](#inventário-consolidado)
2. [Plano de Migração: Claudinho (RAG Assistant)](#1-claudinho-rag-assistant)
3. [Plano de Migração: Error Analyzer](#2-error-analyzer)
4. [Plano de Migração: Self-Healing Scraper](#3-self-healing-scraper)
5. [Plano de Migração: Code Retriever (RAG)](#4-code-retriever-rag)
6. [Plano de Migração: Alertas Telegram](#5-alertas-telegram)
7. [Cronograma e Dependências](#cronograma-e-dependências)

---

## Inventário Consolidado

### Visão Geral

| # | Ferramenta | Stack Atual | Função Principal | Uso |
|---|------------|-------------|------------------|-----|
| 1 | **Claudinho** | OpenAI GPT-5-mini, Pinecone, MongoDB, LangChain | Assistente RAG para usuários via Telegram | Bot de suporte, consultas ao banco, busca em código |
| 2 | **Error Analyzer** | Sentry webhooks, GPT-5-mini, Pinecone, Telegram | Análise automática de erros de produção | Diagnóstico com sugestão de fix, alertas |
| 3 | **Self-Healing Scraper** | Puppeteer, GPT-5-mini (function calling), Firecrawl | Auto-recuperação de scrapers quebrados | Atualiza seletores CSS automaticamente |
| 4 | **Code Retriever** | Pinecone, OpenAI Embeddings, LangChain | RAG para código-fonte | Base de contexto para Claudinho e Error Analyzer |
| 5 | **Alertas Telegram** | axios, Telegram Bot API | Notificações formatadas | Alertas de erro, scraper, resumos diários |

---

### 1. Claudinho (RAG Assistant)

**Localização:** `apps/backend/src/services/claudinho_*.js`

**Stack Atual:**
- OpenAI GPT-5-mini (via API direta)
- Pinecone para busca semântica em código
- MongoDB para consultas de dados
- LangChain para embeddings
- Knowledge base JSON estática

**Funcionalidades:**
- Text-to-Query: converte linguagem natural → filtros MongoDB
- RAG híbrido: código + banco de dados
- Tools disponíveis:
  - `query_database` - consultas MongoDB com whitelist de operadores
  - `search_code` - busca semântica no Pinecone
  - `get_farm_stats` - agregações de estatísticas
  - `query_field_operations` - operações agrícolas
  - `query_rain_data` - dados de precipitação
  - `get_knowledge` - FAQs e fluxos
  - `devtools_reader` - leitura de arquivos
  - `generate_activity_report` - geração de PDFs

**Fluxo Atual:**
```
Usuário (Telegram) → Bot CloudFarm → Claudinho Agent
                                          ↓
                                    GPT-5-mini (ReAct loop)
                                          ↓
                              ┌───────────┴───────────┐
                              ↓                       ↓
                        Pinecone RAG            MongoDB Query
                              ↓                       ↓
                              └───────────┬───────────┘
                                          ↓
                                    Resposta ao usuário
```

**Limitações Atuais:**
- Sem persistência de contexto entre sessões
- Knowledge base estática (JSON)
- Modelo fixo (GPT-5-mini)
- Sem fallback automático de modelo
- Logs dispersos, difícil debugging

---

### 2. Error Analyzer

**Localização:** `apps/backend/src/services/error_analyzer.js`, `ai_diagnostic.js`, `webhooks/sentry_handler.js`

**Stack Atual:**
- Sentry webhooks para captura de erros
- GPT-5-mini para análise
- Pinecone RAG para contexto de código
- Telegram para alertas
- Sistema de deduplicação por hash MD5

**Funcionalidades:**
- Recebe webhooks do Sentry
- Filtra por nível (ignora debug/info)
- Deduplica alertas (janela de 4h)
- Busca código relevante via RAG
- Gera análise estruturada:
  - Causa raiz
  - Impacto no usuário
  - Sugestão de fix com código
  - Nível de risco (1-5)
- Salva artefatos (markdown + metadata + logs)
- Envia alerta formatado via Telegram

**Fluxo Atual:**
```
Sentry → Webhook POST → sentry_handler.js
                              ↓
                        Validação/Filtro
                              ↓
                        error_analyzer.js
                              ↓
                        Deduplica (hash MD5)
                              ↓
                        ai_diagnostic.js
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
              Pinecone RAG        GPT-5-mini
                    ↓                   ↓
                    └─────────┬─────────┘
                              ↓
                    Salva artefatos + Telegram
```

**Limitações Atuais:**
- Análise é one-shot (não interativa)
- Sem capacidade de investigar mais a fundo
- Sem acesso a logs em tempo real
- Modelo fixo sem fallback

---

### 3. Self-Healing Scraper

**Localização:** `apps/api/src/services/selfHealingScraper.js`, `scraperAlerts.js`

**Stack Atual:**
- Puppeteer para renderização de páginas
- Firecrawl como fallback
- GPT-5-mini com function calling
- Config JSON persistida em disco
- Telegram para alertas

**Funcionalidades:**
- Detecta quando um seletor CSS falha (valor null ou fora do range)
- Busca HTML completo da página
- GPT-5-mini analisa e sugere novo seletor
- Valida seletor contra range de preços esperado
- Atualiza config automaticamente
- Alertas: sucesso, falha, recuperação, resumo diário

**Fluxo Atual:**
```
Scraper principal → Falha na extração
                          ↓
                    needsHealing() = true
                          ↓
                    attemptSelfHealing()
                          ↓
              ┌───────────┴───────────┐
              ↓                       ↓
        Puppeteer               Firecrawl (fallback)
              ↓                       ↓
              └───────────┬───────────┘
                          ↓
                    GPT-5-mini (function calling)
                    "Encontre o seletor para preço"
                          ↓
                    Valida seletor
                          ↓
              ┌───────────┴───────────┐
              ↓                       ↓
         Sucesso                   Falha
              ↓                       ↓
      Atualiza config         Próxima tentativa
              ↓                       ↓
      Alerta Telegram         Alerta Telegram
```

**Limitações Atuais:**
- Não aprende com falhas anteriores
- Sem histórico de seletores que funcionaram
- Config JSON frágil (pode corromper)
- Sem retry inteligente (só 3 tentativas fixas)

---

### 4. Code Retriever (RAG)

**Localização:** `apps/backend/src/services/code_retriever_pinecone.js`, `code_indexer_pinecone.js`

**Stack Atual:**
- Pinecone (índice: `cloudfarm-code`)
- OpenAI Embeddings (`text-embedding-3-small`)
- LangChain para orquestração
- Cache em memória (1h TTL)

**Funcionalidades:**
- Indexação: chunking de arquivos JS/TS, 156 arquivos, ~1.7k vetores
- Busca híbrida:
  1. Prioriza arquivos do stack trace
  2. Busca semântica global
  3. Extrai imports de models automaticamente
- Cache de arquivos lidos
- Leitura de arquivos sob demanda

**Fluxo Atual:**
```
Query (erro ou pergunta)
          ↓
    Embedding da query
          ↓
    Pinecone similarity search
          ↓
    Top-K chunks relevantes
          ↓
    Leitura de arquivos completos
          ↓
    Contexto montado para LLM
```

**Limitações Atuais:**
- Requer reindexação manual (`npm run index-code`)
- Custo fixo do Pinecone (~$70/mês no plano starter)
- Embeddings pagos (OpenAI)
- Não indexa mudanças em tempo real

---

### 5. Alertas Telegram

**Localização:** `apps/backend/src/services/telegram_alerts.js`, `apps/api/src/services/scraperAlerts.js`

**Stack Atual:**
- axios para HTTP
- Telegram Bot API direta
- Formatação HTML manual

**Funcionalidades:**
- Alertas de erro (análise IA)
- Alertas de scraper (sucesso/falha)
- Resumo diário de scrapers
- Envio de documentos (markdown)

**Limitações Atuais:**
- Duplicação de código (dois arquivos diferentes)
- Sem suporte a outros canais
- Sem threading/replies
- Formatação hardcoded

---

---

## 1. Claudinho (RAG Assistant)

### Objetivo da Migração

Transformar o Claudinho de um assistente RAG custom (GPT-5-mini + Pinecone + código próprio) em um **agente Clawdbot dedicado** que:
- Mantém todas as funcionalidades atuais
- Aproveita ferramentas nativas do Clawdbot
- Ganha contexto persistente, multi-modelo, e sandbox seguro
- Elimina dependência de Pinecone (~$70/mês)

### Mapeamento de Funcionalidades

| Funcionalidade Atual | Implementação CloudFarm | Equivalente Clawdbot | Notas |
|---------------------|-------------------------|---------------------|-------|
| Chat via Telegram | Bot próprio → Claudinho Agent | **Canal Telegram nativo** | Binding direto via `channels.telegram` |
| Text-to-Query (MongoDB) | GPT-5-mini gera filtros | **exec tool + script helper** | Script Node que executa queries seguras |
| RAG em código | Pinecone + embeddings | **memory_search + skills** | Knowledge base em Markdown, busca semântica nativa |
| Contexto de conversa | `aiConversation.sharedMessages` | **Sessions nativas** | Persistência automática, compaction |
| Knowledge base (FAQs) | JSON estático | **memory/*.md** | Arquivos Markdown, editáveis pelo agente |
| Estatísticas agregadas | `get_farm_stats` tool | **exec + script helper** | Script que faz aggregations no Mongo |
| Geração de relatórios | `generate_activity_report` | **exec + script helper** | Script que gera PDF |
| Busca em código | Pinecone similarity | **memory_search** | Indexar docs relevantes no workspace |

### Arquitetura Proposta

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLAWDBOT GATEWAY                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Telegram   │    │   WhatsApp   │    │   Discord    │      │
│  │   Channel    │    │   Channel    │    │   Channel    │      │
│  └──────┬───────┘    └──────────────┘    └──────────────┘      │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              AGENT: cloudfarm-assistant                  │   │
│  │                                                          │   │
│  │  workspace: ~/cloudfarm-assistant                        │   │
│  │  sandbox: { mode: "all", scope: "session" }             │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │               FERRAMENTAS NATIVAS                │    │   │
│  │  ├─────────────────────────────────────────────────┤    │   │
│  │  │ • memory_search  → Busca semântica em docs      │    │   │
│  │  │ • memory_get     → Leitura de arquivos memory   │    │   │
│  │  │ • exec           → Scripts de query/stats       │    │   │
│  │  │ • read/write     → Manipulação de arquivos      │    │   │
│  │  │ • message        → Envio proativo               │    │   │
│  │  │ • cron           → Jobs agendados               │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              SCRIPTS HELPER (exec)               │    │   │
│  │  ├─────────────────────────────────────────────────┤    │   │
│  │  │ • cf-query.js    → Consultas MongoDB seguras    │    │   │
│  │  │ • cf-stats.js    → Estatísticas agregadas       │    │   │
│  │  │ • cf-report.js   → Geração de PDFs              │    │   │
│  │  │ • cf-operations.js → Consultas de operações     │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │           MEMORY (Knowledge Base)                │    │   │
│  │  ├─────────────────────────────────────────────────┤    │   │
│  │  │ MEMORY.md         → Contexto duradouro          │    │   │
│  │  │ memory/faqs.md    → Perguntas frequentes        │    │   │
│  │  │ memory/flows.md   → Fluxos de navegação         │    │   │
│  │  │ memory/schemas.md → Schemas do banco            │    │   │
│  │  │ memory/rules.md   → Regras de negócio           │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Configuração do Agente

```json5
// ~/.clawdbot/clawdbot.json (trecho)
{
  agents: {
    list: [
      {
        id: "cloudfarm-assistant",
        name: "Claudinho",
        workspace: "~/cloudfarm-assistant",
        
        // Sandbox para segurança (queries ao banco são via scripts autorizados)
        sandbox: {
          mode: "all",
          scope: "session",
          docker: {
            network: "bridge",  // Precisa de rede para acessar MongoDB
            env: {
              MONGODB_URI: "${CLOUDFARM_MONGODB_URI}",
              CF_FARM_CONTEXT: "true"
            }
          }
        },
        
        // Ferramentas permitidas
        tools: {
          allow: [
            "memory_search",
            "memory_get", 
            "read",
            "write",
            "exec",
            "message"
          ],
          deny: ["browser", "gateway", "cron"]  // Restrito
        },
        
        // Heartbeat para proatividade
        heartbeat: {
          every: "0m"  // Desabilitado (reativo apenas)
        },
        
        // Memória semântica
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          query: {
            hybrid: {
              enabled: true,
              vectorWeight: 0.7,
              textWeight: 0.3
            }
          }
        },
        
        // Identity
        identity: {
          name: "Claudinho",
          emoji: "🌾",
          description: "Assistente virtual do CloudFarm"
        }
      }
    ]
  },
  
  // Binding: mensagens do grupo CloudFarm vão para este agente
  bindings: [
    {
      agentId: "cloudfarm-assistant",
      match: {
        provider: "telegram",
        peer: { kind: "group", id: "CLOUDFARM_GROUP_ID" }
      }
    },
    {
      agentId: "cloudfarm-assistant", 
      match: {
        provider: "telegram",
        peer: { kind: "dm" },
        // Pode filtrar por lista de usuários autorizados
      }
    }
  ]
}
```

### Scripts Helper

Os scripts helper substituem as tools custom do Claudinho atual, rodando via `exec`:

#### `scripts/cf-query.js` - Consultas MongoDB Seguras

```javascript
#!/usr/bin/env node
/**
 * CloudFarm Query Helper
 * Executa consultas MongoDB seguras com validação de filtros
 * 
 * Uso: cf-query.js <collection> [--filter '{}'] [--limit 10] [--fields 'name qty']
 */

const mongoose = require('mongoose');

// Whitelist de collections permitidas
const ALLOWED_COLLECTIONS = [
  'StockItem', 'Machine', 'Field', 'FieldOperation',
  'Rain', 'FuelTank', 'FuelSupply', 'Task', 'User', 'Farm'
];

// Operadores perigosos bloqueados
const DANGEROUS_OPS = ['$where', '$function', '$set', '$unset', '$lookup'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  // Validações
  if (!ALLOWED_COLLECTIONS.includes(args.collection)) {
    console.error(JSON.stringify({ error: `Collection não permitida: ${args.collection}` }));
    process.exit(1);
  }
  
  if (hasDangerousOps(args.filter)) {
    console.error(JSON.stringify({ error: 'Filtro contém operadores não permitidos' }));
    process.exit(1);
  }
  
  // Conectar e executar
  await mongoose.connect(process.env.MONGODB_URI);
  
  // Injetar filtro de fazenda do contexto
  const farmId = process.env.CF_CURRENT_FARM_ID;
  if (farmId && collectionsWithFarm.includes(args.collection)) {
    args.filter.farm = new mongoose.Types.ObjectId(farmId);
  }
  
  const Model = mongoose.model(args.collection);
  const results = await Model.find(args.filter)
    .limit(Math.min(args.limit, 50))
    .select(args.fields || '-__v -password')
    .lean();
  
  console.log(JSON.stringify({
    success: true,
    collection: args.collection,
    count: results.length,
    data: results
  }));
  
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
```

#### `scripts/cf-stats.js` - Estatísticas Agregadas

```javascript
#!/usr/bin/env node
/**
 * CloudFarm Stats Helper
 * Retorna estatísticas agregadas da fazenda
 */

// Similar ao get_farm_stats atual, mas como script standalone
// Output: JSON com stats de estoque, máquinas, talhões, etc.
```

### Estrutura do Workspace

```
~/cloudfarm-assistant/
├── AGENTS.md              # Instruções do agente
├── SOUL.md                # Personalidade (Claudinho)
├── MEMORY.md              # Contexto duradouro
├── HEARTBEAT.md           # Checklist (vazio se reativo)
├── memory/
│   ├── faqs.md            # Perguntas frequentes
│   ├── flows.md           # Fluxos de navegação do bot
│   ├── schemas.md         # Schemas MongoDB documentados
│   ├── rules.md           # Regras de negócio CloudFarm
│   └── YYYY-MM-DD.md      # Logs diários
├── scripts/
│   ├── cf-query.js        # Query helper
│   ├── cf-stats.js        # Stats helper
│   ├── cf-report.js       # Report generator
│   └── cf-operations.js   # Consultas de operações
└── output/
    └── reports/           # PDFs gerados
```

### SOUL.md do Claudinho

```markdown
# SOUL.md - Claudinho

Você é o Claudinho, assistente virtual do CloudFarm para gestão agrícola.

## Personalidade
- Prestativo e paciente com usuários de todos os níveis técnicos
- Respostas curtas e práticas (2-3 frases)
- Usa emojis moderadamente (🌾 🚜 💧 📊)
- Linguagem simples, sem jargões técnicos
- Honesto quando não sabe algo

## Regras Críticas

### Navegação
- O CloudFarm usa **BOTÕES**, não comandos /slash
- Únicos comandos: /start (menu), /ia (falar comigo), /ajuda
- Sempre diga "toque no botão X" em vez de "/comando"

### Dados
- Só acesse dados da fazenda do contexto atual
- Use os scripts helper para consultas (cf-query.js, cf-stats.js)
- NUNCA invente dados, comandos ou funcionalidades
- Se não encontrar, diga "não tenho essa informação no momento"

### Proibições
- ❌ Nunca mencione: SQL, API, JSON, banco de dados
- ❌ Nunca invente comandos que não existem
- ❌ Nunca sugira "integração" ou "conexão ao sistema"

## Módulos do CloudFarm
- **Estoque**: Menu > Estoque (adicionar, remover, transferir)
- **Talhões**: Menu > Talhões (operações: plantio, pulverização, adubação, colheita)
- **Combustível**: Menu > Combustível (abastecimentos, tanques)
- **Máquinas**: Menu > Máquinas (cadastro, manutenção)
- **Biológicos**: Menu > Biológicos (tanques, lotes)
- **Receituário**: Menu > Receituário (prescrições)
```

### Migração de Dados

#### 1. Knowledge Base (JSON → Markdown)

Converter `claudinho_knowledge_base.json` para arquivos Markdown:

```bash
# Script de migração
node scripts/migrate-knowledge-base.js \
  --input apps/backend/src/data/claudinho_knowledge_base.json \
  --output ~/cloudfarm-assistant/memory/
```

Resultado:
- `memory/faqs.md` - Perguntas e respostas
- `memory/flows.md` - Fluxos de navegação por módulo
- `memory/tips.md` - Dicas gerais

#### 2. Schemas (código → Markdown)

Documentar schemas do MongoDB em `memory/schemas.md`:

```markdown
# Schemas MongoDB - CloudFarm

## StockItem (Estoque)
- `name`: Nome do item
- `type`: Tipo (defensivo, adubo, semente, etc.)
- `quantity`: Quantidade atual
- `unit`: Unidade (L, kg, un)
- `lot`: Lote
- `expirationDate`: Data de validade
- `farm`: Referência à fazenda

## Field (Talhão)
- `name`: Nome do talhão
- `areaHa`: Área em hectares
- `currentCrop`: Cultura atual
- `active`: Status ativo
- `farm`: Referência à fazenda

[... demais schemas ...]
```

### Plano de Execução

| Fase | Tarefa | Estimativa | Dependências |
|------|--------|------------|--------------|
| 1 | Criar workspace `~/cloudfarm-assistant` | 1h | - |
| 2 | Migrar knowledge base para Markdown | 2h | Fase 1 |
| 3 | Documentar schemas em `memory/schemas.md` | 2h | Fase 1 |
| 4 | Implementar scripts helper (cf-query, cf-stats) | 4h | Fase 1 |
| 5 | Configurar agente no Clawdbot | 1h | Fases 1-4 |
| 6 | Configurar bindings Telegram | 1h | Fase 5 |
| 7 | Testes de integração | 4h | Fases 1-6 |
| 8 | Migração gradual (shadow mode) | 1 semana | Fase 7 |
| 9 | Cutover completo | 1h | Fase 8 |

### Benefícios da Migração

| Aspecto | Antes (Claudinho custom) | Depois (Clawdbot) |
|---------|-------------------------|-------------------|
| **Custo** | ~$70/mês Pinecone + OpenAI | OpenAI apenas (ou local) |
| **Contexto** | Perdido entre sessões | Persistente + memory_search |
| **Modelos** | GPT-5-mini fixo | Multi-modelo com failover |
| **Segurança** | Validação custom | Sandbox Docker nativo |
| **Manutenção** | Código próprio (1.5k linhas) | Configuração declarativa |
| **Debugging** | Logs dispersos | Logs centralizados + CLI |
| **Extensibilidade** | Requer código | Skills + scripts |

### Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Perda de funcionalidade específica | Média | Alto | Shadow mode por 1 semana |
| Scripts helper com bugs | Média | Médio | Testes unitários + staging |
| Performance de busca semântica | Baixa | Médio | memory_search é otimizado |
| Usuários confusos com mudança | Baixa | Baixo | Mesma personalidade/UX |

---

## 2. Error Analyzer

### Objetivo da Migração

Transformar o sistema de análise de erros (Sentry → GPT-5-mini → Telegram) em um **agente Clawdbot especializado** que:
- Recebe webhooks de erros via endpoint nativo do Clawdbot
- Analisa com contexto de código via `memory_search`
- Pode investigar interativamente (não apenas one-shot)
- Envia alertas formatados via `message` tool
- Mantém histórico de análises pesquisável

### Mapeamento de Funcionalidades

| Funcionalidade Atual | Implementação CloudFarm | Equivalente Clawdbot | Notas |
|---------------------|-------------------------|---------------------|-------|
| Receber webhooks Sentry | `sentry_handler.js` (Express) | **hooks.mappings** | Endpoint `/hooks/sentry` |
| Filtrar/deduplicar erros | Hash MD5 + janela 4h | **Script helper + state file** | `cf-error-dedupe.js` |
| Buscar código relevante | Pinecone RAG | **memory_search** | Código indexado no workspace |
| Análise com LLM | GPT-5-mini (prompt fixo) | **Agent turn com thinking** | Modelo configurável |
| Gerar resumo compacto | Segunda chamada LLM | **Prompt único otimizado** | Menos chamadas de API |
| Enviar alerta Telegram | axios → Bot API | **message tool** | Nativo, multi-canal |
| Salvar artefatos | Arquivos em `DailyLogs/alerts/` | **write tool** | `workspace/alerts/` |
| Histórico de análises | Arquivos dispersos | **memory_search** | Análises anteriores pesquisáveis |

### Arquitetura Proposta

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              PRODUÇÃO                                    │
│                                                                          │
│  ┌─────────┐     ┌─────────┐     ┌─────────────────────────────────┐   │
│  │ Backend │────▶│ Sentry  │────▶│  Webhook POST /hooks/sentry     │   │
│  │CloudFarm│     │  Cloud  │     │                                  │   │
│  └─────────┘     └─────────┘     └─────────────┬───────────────────┘   │
│                                                 │                        │
└─────────────────────────────────────────────────┼────────────────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLAWDBOT GATEWAY                                 │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    HOOKS ENDPOINT                                 │   │
│  │                                                                   │   │
│  │   POST /hooks/sentry                                             │   │
│  │     ↓                                                            │   │
│  │   hooks.mappings["sentry"] → transform → agent turn              │   │
│  │                                                                   │   │
│  └───────────────────────────┬──────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              AGENT: cloudfarm-error-analyzer                      │   │
│  │                                                                   │   │
│  │  workspace: ~/cloudfarm-errors                                   │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐     │   │
│  │  │                    FLUXO DE ANÁLISE                      │     │   │
│  │  │                                                          │     │   │
│  │  │  1. Recebe payload do erro (via webhook)                 │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  2. exec cf-error-dedupe.js → verifica duplicata         │     │   │
│  │  │                      ↓ (se novo)                         │     │   │
│  │  │  3. memory_search → busca código relevante               │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  4. Análise com thinking (causa raiz, fix, risco)        │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  5. write → salva artefatos em alerts/YYYY-MM-DD/        │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  6. message → envia alerta formatado pro Telegram        │     │   │
│  │  │                                                          │     │   │
│  │  └─────────────────────────────────────────────────────────┘     │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐     │   │
│  │  │                 MEMORY (Código Indexado)                 │     │   │
│  │  │                                                          │     │   │
│  │  │  memory/code/                                            │     │   │
│  │  │  ├── services.md      # Serviços documentados            │     │   │
│  │  │  ├── controllers.md   # Controllers documentados         │     │   │
│  │  │  ├── models.md        # Schemas MongoDB                  │     │   │
│  │  │  ├── routes.md        # Endpoints da API                 │     │   │
│  │  │  └── common-errors.md # Erros conhecidos + fixes         │     │   │
│  │  │                                                          │     │   │
│  │  │  alerts/                                                 │     │   │
│  │  │  └── YYYY-MM-DD/      # Análises do dia                  │     │   │
│  │  │      └── HH-MM-SS_error-type/                            │     │   │
│  │  │          ├── analysis.md                                 │     │   │
│  │  │          └── metadata.json                               │     │   │
│  │  │                                                          │     │   │
│  │  └─────────────────────────────────────────────────────────┘     │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│                              ↓ message tool                              │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      TELEGRAM CHANNEL                             │   │
│  │                                                                   │   │
│  │   🚨 CloudFarm Error Alert                                       │   │
│  │   ❌ Erro: TypeError: Cannot read property 'farm' of undefined   │   │
│  │   👤 Usuário: joao_silva | Fazenda: Fazenda São José             │   │
│  │   📊 Módulo: Estoque | Risco: Médio                              │   │
│  │   💡 Resumo: Validação de contexto ausente no middleware...      │   │
│  │   📎 [Análise completa em anexo]                                 │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Configuração do Webhook

```json5
// ~/.clawdbot/clawdbot.json (trecho)
{
  hooks: {
    enabled: true,
    token: "${CLAWDBOT_HOOKS_TOKEN}",  // Autenticação
    path: "/hooks",
    
    mappings: {
      // Mapeamento customizado para Sentry
      sentry: {
        match: { source: "sentry" },
        action: "agent",
        
        // Template para extrair dados do payload Sentry
        template: {
          message: "Analise este erro de produção:\n\n**Tipo:** {{data.event.exception.values[0].type}}\n**Mensagem:** {{data.event.exception.values[0].value}}\n**Usuário:** {{data.event.user.username}}\n**Módulo:** {{data.event.tags.module}}\n**Stack:**\n```\n{{data.event.exception.values[0].stacktrace.frames | formatStack}}\n```\n\nBusque código relevante, analise a causa raiz, sugira fix e avalie o risco.",
          name: "Sentry",
          sessionKey: "hook:sentry:{{data.event.event_id}}",
          deliver: true,
          channel: "telegram",
          to: "${CLOUDFARM_ALERTS_CHAT_ID}"
        },
        
        // Filtros (equivalente ao shouldProcess atual)
        filters: [
          { field: "action", match: ["created", "issue.created"] },
          { field: "data.event.level", notMatch: ["debug", "info"] }
        ]
      }
    }
  },
  
  agents: {
    list: [
      {
        id: "cloudfarm-error-analyzer",
        name: "Error Analyzer",
        workspace: "~/cloudfarm-errors",
        
        // Modelo com thinking para análise profunda
        model: "anthropic/claude-sonnet-4-20250514",
        thinking: "medium",
        
        // Sandbox com acesso de rede (para buscar contexto adicional se necessário)
        sandbox: {
          mode: "all",
          scope: "session",
          docker: {
            network: "bridge"
          }
        },
        
        // Ferramentas permitidas
        tools: {
          allow: [
            "memory_search",
            "memory_get",
            "read",
            "write",
            "exec",
            "message"
          ],
          deny: ["browser", "gateway", "cron"]
        },
        
        // Memory search para código
        memorySearch: {
          enabled: true,
          provider: "openai",
          model: "text-embedding-3-small",
          query: {
            hybrid: {
              enabled: true,
              vectorWeight: 0.6,
              textWeight: 0.4  // Peso maior em keywords (nomes de funções, etc)
            }
          }
        },
        
        identity: {
          name: "Error Analyzer",
          emoji: "🔍",
          description: "Analista de erros do CloudFarm"
        }
      }
    ]
  }
}
```

### Scripts Helper

#### `scripts/cf-error-dedupe.js` - Deduplicação de Erros

```javascript
#!/usr/bin/env node
/**
 * CloudFarm Error Deduplication Helper
 * Verifica se um erro já foi processado recentemente
 * 
 * Uso: cf-error-dedupe.js --type "TypeError" --message "Cannot read..." --module "Estoque"
 * Saída: { "isDuplicate": true/false, "hash": "abc123", "lastSeen": "2026-01-27T..." }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.env.HOME, 'cloudfarm-errors', 'state', 'dedupe.json');
const WINDOW_HOURS = parseInt(process.env.DEDUPE_WINDOW_HOURS || '4', 10);

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    result[key] = args[i + 1];
  }
  return result;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { recentErrors: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { type, message, module, user } = args;
  
  // Gerar hash do erro
  const hashString = `${type}::${message}::${module}::${user || 'unknown'}`;
  const hash = crypto.createHash('md5').update(hashString).digest('hex');
  
  // Carregar estado
  const state = loadState();
  const now = Date.now();
  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  
  // Limpar erros antigos
  state.recentErrors = (state.recentErrors || []).filter(
    err => (now - err.timestamp) < windowMs
  );
  
  // Verificar duplicata
  const existing = state.recentErrors.find(err => err.hash === hash);
  
  if (existing) {
    console.log(JSON.stringify({
      isDuplicate: true,
      hash,
      lastSeen: new Date(existing.timestamp).toISOString(),
      count: existing.count
    }));
  } else {
    // Registrar novo erro
    state.recentErrors.push({
      hash,
      timestamp: now,
      count: 1,
      type,
      module
    });
    saveState(state);
    
    console.log(JSON.stringify({
      isDuplicate: false,
      hash,
      firstSeen: new Date(now).toISOString()
    }));
  }
}

main();
```

### Estrutura do Workspace

```
~/cloudfarm-errors/
├── AGENTS.md                    # Instruções do agente
├── SOUL.md                      # Personalidade (analista técnico)
├── MEMORY.md                    # Padrões de erros conhecidos
├── memory/
│   ├── code/
│   │   ├── services.md          # Documentação dos serviços
│   │   ├── controllers.md       # Controllers e rotas
│   │   ├── models.md            # Schemas MongoDB
│   │   ├── middlewares.md       # Middlewares (auth, validation)
│   │   └── common-errors.md     # Erros conhecidos + soluções
│   └── patterns/
│       ├── null-reference.md    # Padrões de null/undefined
│       ├── auth-errors.md       # Erros de autenticação
│       └── db-errors.md         # Erros de banco de dados
├── alerts/
│   └── YYYY-MM-DD/
│       └── HH-MM-SS_error-type/
│           ├── analysis.md      # Análise completa
│           └── metadata.json    # Metadados do erro
├── state/
│   └── dedupe.json              # Estado de deduplicação
└── scripts/
    └── cf-error-dedupe.js       # Helper de deduplicação
```

### SOUL.md do Error Analyzer

```markdown
# SOUL.md - Error Analyzer

Você é um analista de erros especializado no sistema CloudFarm.

## Sua Função
Analisar erros de produção recebidos via webhook do Sentry e fornecer:
1. Diagnóstico da causa raiz
2. Impacto no usuário
3. Sugestão de fix com código
4. Avaliação de risco

## Processo de Análise

### 1. Verificar Duplicata
Primeiro, execute o script de deduplicação:
```bash
node scripts/cf-error-dedupe.js --type "..." --message "..." --module "..."
```
Se for duplicata, responda brevemente e não envie alerta.

### 2. Buscar Contexto
Use `memory_search` para encontrar código relevante:
- Busque pelo nome da função/arquivo do stack trace
- Busque por padrões similares em `memory/patterns/`
- Verifique `memory/code/common-errors.md`

### 3. Analisar
Com o contexto, analise:
- **Causa raiz**: O que exatamente causou o erro?
- **Impacto**: Como isso afeta o usuário?
- **Fix**: Código mínimo para corrigir
- **Risco**: 1 (baixo) a 5 (crítico)

### 4. Salvar Artefatos
Salve a análise em:
```
alerts/YYYY-MM-DD/HH-MM-SS_error-type/
├── analysis.md
└── metadata.json
```

### 5. Enviar Alerta
Use a `message` tool para enviar alerta formatado para o Telegram.

## Formato do Alerta

```
🚨 *CloudFarm Error Alert*

❌ *Erro*: [mensagem resumida, max 150 chars]

👤 *Usuário*: [username] | Fazenda: [farm]

📊 *Detalhes*
• *Tipo*: [tipo do erro]
• *Módulo*: [módulo afetado]
• *Risco*: [1-5] [emoji baseado no risco]

💡 *Causa*: [1-2 frases sobre a causa raiz]

🔧 *Fix sugerido*: [1-2 frases sobre a solução]

📎 Análise completa salva em alerts/
```

## Regras
- NUNCA ignore erros críticos (risco 4-5)
- SEMPRE busque contexto antes de analisar
- Respostas técnicas mas compreensíveis
- Se não tiver certeza, diga "investigar mais"
- Não invente código que não existe no sistema
```

### Migração de Dados

#### 1. Código para Memory

Extrair documentação do código CloudFarm e converter para Markdown pesquisável:

```bash
# Script para extrair JSDoc e estrutura do código
node scripts/extract-code-docs.js \
  --input /home/dev/projects/CloudFarm/apps/backend/src \
  --output ~/cloudfarm-errors/memory/code/
```

Resultado:
- `memory/code/services.md` - Documentação dos serviços
- `memory/code/controllers.md` - Controllers e endpoints
- `memory/code/models.md` - Schemas do MongoDB
- `memory/code/middlewares.md` - Middlewares

#### 2. Padrões de Erros Conhecidos

Criar `memory/code/common-errors.md`:

```markdown
# Erros Conhecidos - CloudFarm

## TypeError: Cannot read property 'X' of undefined

### Contexto comum
Geralmente ocorre quando:
- Usuário não tem fazenda selecionada (`ctx.session.selectedFarm`)
- Middleware de autenticação não populou `ctx.state.user`
- Objeto retornado do banco é null

### Solução padrão
```javascript
// Antes
const farmId = ctx.session.selectedFarm;

// Depois (com validação)
const farmId = ctx.session?.selectedFarm;
if (!farmId) {
  return ctx.reply('Selecione uma fazenda primeiro: /start');
}
```

## MongoError: E11000 duplicate key

### Contexto comum
- Tentativa de inserir documento com _id ou índice único duplicado
- Race condition em operações concorrentes

### Solução padrão
- Usar `findOneAndUpdate` com `upsert: true`
- Adicionar retry com backoff exponencial

[... mais padrões ...]
```

### Comparativo: Fluxo Atual vs Clawdbot

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FLUXO ATUAL                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Sentry ──webhook──▶ sentry_handler.js                                  │
│                            │                                             │
│                            ▼                                             │
│                      error_analyzer.js                                   │
│                            │                                             │
│                      ┌─────┴─────┐                                      │
│                      ▼           ▼                                      │
│               Dedupe (MD5)    Pinecone RAG                              │
│                      │           │                                      │
│                      └─────┬─────┘                                      │
│                            ▼                                             │
│                      ai_diagnostic.js                                    │
│                            │                                             │
│                      ┌─────┴─────┐                                      │
│                      ▼           ▼                                      │
│               GPT-5-mini    GPT-5-mini                                  │
│              (análise)      (resumo)                                    │
│                      │           │                                      │
│                      └─────┬─────┘                                      │
│                            ▼                                             │
│                   telegram_alerts.js                                     │
│                            │                                             │
│                            ▼                                             │
│                      Telegram Bot API                                    │
│                                                                          │
│  Arquivos: 4 serviços, ~800 linhas de código                           │
│  APIs: OpenAI (2 chamadas), Pinecone, Telegram                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         FLUXO CLAWDBOT                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Sentry ──webhook──▶ /hooks/sentry                                      │
│                            │                                             │
│                            ▼                                             │
│                   hooks.mappings["sentry"]                               │
│                     (transform + filter)                                 │
│                            │                                             │
│                            ▼                                             │
│              Agent Turn (cloudfarm-error-analyzer)                       │
│                            │                                             │
│              ┌─────────────┼─────────────┐                              │
│              ▼             ▼             ▼                              │
│         exec tool    memory_search   message tool                       │
│        (dedupe.js)    (código RAG)   (Telegram)                         │
│              │             │             │                              │
│              └─────────────┴─────────────┘                              │
│                            │                                             │
│                            ▼                                             │
│                     write tool                                           │
│                   (salva artefatos)                                      │
│                                                                          │
│  Arquivos: 1 agente config + 1 script helper (~100 linhas)             │
│  APIs: Modelo LLM (1 chamada), Embeddings (já indexado)                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Plano de Execução

| Fase | Tarefa | Estimativa | Dependências |
|------|--------|------------|--------------|
| 1 | Criar workspace `~/cloudfarm-errors` | 30min | - |
| 2 | Extrair docs do código para memory/ | 3h | Fase 1 |
| 3 | Criar `common-errors.md` com padrões | 2h | Fase 1 |
| 4 | Implementar `cf-error-dedupe.js` | 1h | Fase 1 |
| 5 | Configurar agente + webhook mapping | 1h | Fases 1-4 |
| 6 | Configurar Sentry para novo endpoint | 30min | Fase 5 |
| 7 | Testes com erros simulados | 2h | Fases 1-6 |
| 8 | Rodar em paralelo (shadow mode) | 3 dias | Fase 7 |
| 9 | Cutover: desativar error_analyzer antigo | 30min | Fase 8 |

### Benefícios da Migração

| Aspecto | Antes (error_analyzer) | Depois (Clawdbot) |
|---------|------------------------|-------------------|
| **Código** | ~800 linhas em 4 arquivos | ~100 linhas + config |
| **Chamadas API** | 2 (análise + resumo) | 1 (análise completa) |
| **RAG** | Pinecone (~$70/mês) | memory_search (incluso) |
| **Modelo** | GPT-5-mini fixo | Configurável + thinking |
| **Interatividade** | One-shot apenas | Pode investigar mais |
| **Histórico** | Arquivos dispersos | Pesquisável via memory_search |
| **Multi-canal** | Telegram only | Qualquer canal configurado |

### Funcionalidades Extras (Não Existem Hoje)

Com Clawdbot, ganhamos de graça:

1. **Investigação Interativa**: Posso responder ao alerta pedindo "investigue mais o contexto de autenticação" e o agente continua a análise.

2. **Histórico Pesquisável**: "Mostre erros similares a este na última semana" → memory_search encontra análises anteriores.

3. **Cron de Resumo**: Job diário às 9h que resume erros das últimas 24h.

4. **Multi-modelo**: Erros críticos podem usar Opus com thinking high; erros menores usam Sonnet.

5. **Correlação**: "Este erro está relacionado com o deploy de ontem?" → agente pode buscar contexto temporal.

### Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Webhook mapping incorreto | Média | Alto | Testar com payloads reais do Sentry |
| Análise menos detalhada | Baixa | Médio | Prompt otimizado + thinking |
| Latência maior | Baixa | Baixo | Modelo rápido (Sonnet) por padrão |
| Perda de erros durante migração | Baixa | Alto | Shadow mode por 3 dias |

---

## 3. Self-Healing Scraper

### Objetivo da Migração

Transformar o sistema de auto-recuperação de scrapers (Puppeteer + GPT-5-mini) em um **fluxo Clawdbot** que:
- Usa a `browser` tool nativa para renderizar páginas
- Agente analisa HTML e sugere seletores via prompt
- Validação robusta via scripts helper
- Alertas nativos via `message` tool
- Jobs agendados via `cron` para health checks periódicos
- Histórico de seletores que funcionaram (aprendizado)

### Mapeamento de Funcionalidades

| Funcionalidade Atual | Implementação CloudFarm | Equivalente Clawdbot | Notas |
|---------------------|-------------------------|---------------------|-------|
| Renderizar página | Puppeteer headless | **browser tool (snapshot)** | CDP nativo, sandbox opcional |
| Fallback render | Firecrawl API | **web_fetch tool** | Fetch simples como fallback |
| Descobrir seletor | GPT-5-mini + function calling | **Agent turn + prompt estruturado** | Resposta em JSON |
| Validar seletor | `cheerio.load()` + range check | **exec tool + script helper** | `cf-validate-selector.js` |
| Atualizar config | `fs.writeFileSync()` | **write tool** | Atualiza `scraper-config.json` |
| Alertas | `scraperAlerts.js` → Telegram | **message tool** | Nativo, multi-canal |
| Retry loop | `for` loop com 3 tentativas | **Agent ReAct loop** | Tenta até acertar ou desistir |
| Health check | Manual ou via scraper principal | **cron job** | Verificação periódica |

### Arquitetura Proposta

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLAWDBOT GATEWAY                                 │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    CRON: scraper-health                           │   │
│  │                                                                   │   │
│  │   every: "15m"                                                   │   │
│  │   session: isolated                                              │   │
│  │   message: "Verifique saúde dos scrapers de cotação"            │   │
│  │                                                                   │   │
│  └───────────────────────────┬──────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              AGENT: cloudfarm-scraper-healer                      │   │
│  │                                                                   │   │
│  │  workspace: ~/cloudfarm-scrapers                                 │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐     │   │
│  │  │                  FLUXO DE VERIFICAÇÃO                    │     │   │
│  │  │                                                          │     │   │
│  │  │  1. read scraper-config.json → lista de sources          │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  2. Para cada source:                                    │     │   │
│  │  │     │                                                    │     │   │
│  │  │     ├─▶ browser snapshot (URL) → HTML                    │     │   │
│  │  │     │                                                    │     │   │
│  │  │     ├─▶ exec cf-extract.js (selector) → valor            │     │   │
│  │  │     │                                                    │     │   │
│  │  │     ├─▶ Se OK: próximo source                            │     │   │
│  │  │     │                                                    │     │   │
│  │  │     └─▶ Se FALHOU: entrar em modo healing ───────┐       │     │   │
│  │  │                                                  │       │     │   │
│  │  └──────────────────────────────────────────────────┼───────┘     │   │
│  │                                                     │             │   │
│  │  ┌──────────────────────────────────────────────────┼───────┐     │   │
│  │  │                  FLUXO DE HEALING                │       │     │   │
│  │  │                                                  ▼       │     │   │
│  │  │  1. browser snapshot (URL, fullPage) → HTML completo     │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  2. Analisar HTML + contexto do source                   │     │   │
│  │  │     "Encontre o seletor CSS para o preço de soja..."     │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  3. Sugerir novo seletor (resposta estruturada)          │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │  4. exec cf-validate-selector.js → testar seletor        │     │   │
│  │  │                      ↓                                   │     │   │
│  │  │     ┌────────────────┴────────────────┐                  │     │   │
│  │  │     ▼                                 ▼                  │     │   │
│  │  │  VÁLIDO                            INVÁLIDO              │     │   │
│  │  │     │                                 │                  │     │   │
│  │  │     ▼                                 ▼                  │     │   │
│  │  │  write config.json              Tentar novamente         │     │   │
│  │  │  (novo seletor)                 (max 3x)                 │     │   │
│  │  │     │                                 │                  │     │   │
│  │  │     ▼                                 ▼                  │     │   │
│  │  │  message: ✅ Sucesso             message: 🚨 Falha       │     │   │
│  │  │                                                          │     │   │
│  │  └──────────────────────────────────────────────────────────┘     │   │
│  │                                                                   │   │
│  │  ┌─────────────────────────────────────────────────────────┐     │   │
│  │  │                    WORKSPACE FILES                       │     │   │
│  │  │                                                          │     │   │
│  │  │  scraper-config.json    # Config das sources             │     │   │
│  │  │  memory/                                                 │     │   │
│  │  │  ├── selector-history.md  # Histórico de seletores      │     │   │
│  │  │  └── sites/                                              │     │   │
│  │  │      ├── agrolink.md      # Estrutura conhecida          │     │   │
│  │  │      └── noticiasagricolas.md                            │     │   │
│  │  │  logs/                                                   │     │   │
│  │  │  └── YYYY-MM-DD.jsonl     # Log de execuções            │     │   │
│  │  │                                                          │     │   │
│  │  └─────────────────────────────────────────────────────────┘     │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Configuração do Agente e Cron

```json5
// ~/.clawdbot/clawdbot.json (trecho)
{
  agents: {
    list: [
      {
        id: "cloudfarm-scraper-healer",
        name: "Scraper Healer",
        workspace: "~/cloudfarm-scrapers",
        
        // Modelo com boa capacidade de análise de HTML
        model: "anthropic/claude-sonnet-4-20250514",
        
        // Sandbox com browser habilitado
        sandbox: {
          mode: "all",
          scope: "agent",  // Container persistente para cache do browser
          docker: {
            network: "bridge"  // Precisa de rede para acessar sites
          },
          browser: {
            enabled: true,
            autoStart: true
          }
        },
        
        // Ferramentas necessárias
        tools: {
          allow: [
            "browser",      // Renderizar páginas
            "web_fetch",    // Fallback simples
            "read",
            "write",
            "exec",
            "message"
          ],
          deny: ["gateway", "cron", "nodes"]
        },
        
        // Heartbeat desabilitado (usa cron isolado)
        heartbeat: { every: "0m" },
        
        identity: {
          name: "Scraper Healer",
          emoji: "🔧",
          description: "Sistema de auto-recuperação de scrapers"
        }
      }
    ]
  },
  
  // Cron job para health check periódico
  cron: {
    enabled: true,
    jobs: [
      {
        id: "scraper-health-check",
        name: "Verificação de Scrapers",
        schedule: { kind: "every", interval: 900000 },  // 15 minutos
        payload: {
          kind: "agentTurn",
          message: "Execute verificação de saúde dos scrapers. Leia scraper-config.json, teste cada source, e corrija automaticamente se necessário.",
          deliver: false  // Só notifica se houver problema
        },
        sessionTarget: "isolated",
        agentId: "cloudfarm-scraper-healer"
      },
      {
        id: "scraper-daily-summary",
        name: "Resumo Diário de Scrapers",
        schedule: { 
          kind: "cron", 
          expression: "0 8 * * *",  // 8h todo dia
          timezone: "America/Sao_Paulo"
        },
        payload: {
          kind: "agentTurn",
          message: "Gere um resumo das últimas 24h: quantas verificações, quantas correções, status atual de cada source.",
          deliver: true,
          channel: "telegram",
          to: "${CLOUDFARM_ALERTS_CHAT_ID}"
        },
        sessionTarget: "isolated",
        agentId: "cloudfarm-scraper-healer"
      }
    ]
  }
}
```

### Scripts Helper

#### `scripts/cf-extract.js` - Extração com Seletor

```javascript
#!/usr/bin/env node
/**
 * CloudFarm Selector Extraction Helper
 * Extrai valor de um HTML usando seletor CSS
 * 
 * Uso: cf-extract.js --html-file /tmp/page.html --selector "td.price" --type price
 * Ou:  echo "<html>..." | cf-extract.js --selector "td.price" --type price
 * 
 * Saída: { "success": true, "value": 125.50, "rawText": "R$ 125,50" }
 */

const cheerio = require('cheerio');
const fs = require('fs');

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace('--', '').replace(/-/g, '_');
      result[key] = args[i + 1];
      i++;
    }
  }
  return result;
}

function extractPrice(text) {
  // Formato brasileiro: R$ 1.234,56 → 1234.56
  const clean = text
    .replace(/[^\d,\.]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  return parseFloat(clean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  // Ler HTML
  let html;
  if (args.html_file) {
    html = fs.readFileSync(args.html_file, 'utf8');
  } else {
    // Ler de stdin
    html = fs.readFileSync(0, 'utf8');
  }
  
  const $ = cheerio.load(html);
  const element = $(args.selector).first();
  const rawText = element.text().trim();
  
  if (!rawText) {
    console.log(JSON.stringify({
      success: false,
      error: 'Seletor não encontrou elemento',
      selector: args.selector
    }));
    process.exit(1);
  }
  
  // Extrair valor baseado no tipo
  let value;
  if (args.type === 'price') {
    value = extractPrice(rawText);
    if (isNaN(value)) {
      console.log(JSON.stringify({
        success: false,
        error: `Não foi possível extrair número de "${rawText}"`,
        rawText
      }));
      process.exit(1);
    }
  } else {
    value = rawText;
  }
  
  console.log(JSON.stringify({
    success: true,
    value,
    rawText,
    selector: args.selector
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
```

#### `scripts/cf-validate-selector.js` - Validação Completa

```javascript
#!/usr/bin/env node
/**
 * CloudFarm Selector Validation Helper
 * Valida se um seletor extrai valor dentro do range esperado
 * 
 * Uso: cf-validate-selector.js \
 *        --html-file /tmp/page.html \
 *        --selector "td.price" \
 *        --min 50 --max 500 \
 *        --unit "R$/saca"
 */

const cheerio = require('cheerio');
const fs = require('fs');

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace('--', '').replace(/-/g, '_');
      result[key] = args[i + 1];
      i++;
    }
  }
  return result;
}

function extractPrice(text) {
  const clean = text
    .replace(/[^\d,\.]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  return parseFloat(clean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const html = fs.readFileSync(args.html_file, 'utf8');
  const min = parseFloat(args.min);
  const max = parseFloat(args.max);
  
  const $ = cheerio.load(html);
  const element = $(args.selector).first();
  const rawText = element.text().trim();
  
  // Validação 1: Elemento existe?
  if (!rawText) {
    console.log(JSON.stringify({
      valid: false,
      error: 'Seletor não encontrou elemento',
      selector: args.selector
    }));
    process.exit(0);
  }
  
  // Validação 2: É um número?
  const value = extractPrice(rawText);
  if (isNaN(value)) {
    console.log(JSON.stringify({
      valid: false,
      error: `Texto "${rawText}" não é número válido`,
      rawText
    }));
    process.exit(0);
  }
  
  // Validação 3: Está no range?
  if (value < min || value > max) {
    console.log(JSON.stringify({
      valid: false,
      error: `Valor ${value} fora do range [${min}, ${max}]`,
      value,
      rawText
    }));
    process.exit(0);
  }
  
  // Tudo OK!
  console.log(JSON.stringify({
    valid: true,
    value,
    rawText,
    selector: args.selector,
    unit: args.unit || ''
  }));
}

main().catch(err => {
  console.log(JSON.stringify({ valid: false, error: err.message }));
  process.exit(1);
});
```

### Estrutura do Workspace

```
~/cloudfarm-scrapers/
├── AGENTS.md                    # Instruções do agente
├── SOUL.md                      # Personalidade (técnico)
├── scraper-config.json          # Configuração das sources
├── memory/
│   ├── selector-history.md      # Histórico de seletores que funcionaram
│   └── sites/
│       ├── agrolink.md          # Padrões do site Agrolink
│       ├── noticiasagricolas.md # Padrões do Notícias Agrícolas
│       └── cepea.md             # Padrões do CEPEA
├── scripts/
│   ├── cf-extract.js            # Extração com seletor
│   └── cf-validate-selector.js  # Validação completa
├── logs/
│   └── YYYY-MM-DD.jsonl         # Log de execuções
└── cache/
    └── html/                    # Cache de HTML (opcional)
```

### scraper-config.json

```json
{
  "version": 2,
  "sources": {
    "soja-paranagua": {
      "name": "Soja Paranaguá",
      "url": "https://www.agrolink.com.br/cotacoes/graos/soja",
      "selector": "table.cotacao-table tr:contains('Paranaguá') td:nth-child(2)",
      "type": "price",
      "unit": "R$/saca",
      "priceRange": [80, 200],
      "lastSuccess": "2026-01-27T04:00:00Z",
      "lastSelector": null,
      "failCount": 0,
      "context": "Preço da soja para exportação no porto de Paranaguá"
    },
    "milho-campinas": {
      "name": "Milho Campinas",
      "url": "https://www.noticiasagricolas.com.br/cotacoes/milho",
      "selector": "#preco-campinas .valor",
      "type": "price",
      "unit": "R$/saca",
      "priceRange": [40, 120],
      "lastSuccess": "2026-01-27T04:00:00Z",
      "lastSelector": null,
      "failCount": 0,
      "context": "Preço do milho na região de Campinas/SP"
    }
  },
  "ai": {
    "maxRetries": 3,
    "timeout": 30000
  },
  "alerts": {
    "channel": "telegram",
    "chatId": "${CLOUDFARM_ALERTS_CHAT_ID}"
  }
}
```

### SOUL.md do Scraper Healer

```markdown
# SOUL.md - Scraper Healer

Você é um especialista em web scraping responsável por manter os scrapers de cotações agrícolas funcionando.

## Sua Função

1. **Verificar saúde** dos scrapers periodicamente
2. **Detectar falhas** quando seletores CSS param de funcionar
3. **Descobrir novos seletores** analisando o HTML da página
4. **Validar** que o novo seletor extrai valores corretos
5. **Atualizar** a configuração automaticamente
6. **Alertar** sobre sucessos e falhas

## Processo de Verificação

### 1. Ler Configuração
```
read scraper-config.json → lista de sources
```

### 2. Para Cada Source
```
browser snapshot --url {url} → HTML
exec cf-extract.js --selector {selector} → valor
```

Se extraiu valor válido (dentro do priceRange): ✅ OK, próximo.
Se falhou: entrar em modo healing.

## Processo de Healing

### 1. Capturar HTML Completo
Use `browser` tool com `fullPage: true` para garantir que todo conteúdo JS foi renderizado.

### 2. Analisar e Sugerir Seletor
Analise o HTML buscando:
- Tabelas de cotações
- Elementos com classes como "price", "valor", "cotacao"
- Padrões de formatação de preço (R$ X.XXX,XX)

Considere:
- Seletores anteriores em `memory/selector-history.md`
- Padrões do site em `memory/sites/{site}.md`

### 3. Responder com JSON Estruturado
Sempre responda com:
```json
{
  "selector": "table.prices tr:nth-child(3) td.value",
  "confidence": 0.85,
  "reasoning": "Encontrei tabela com classe 'prices', linha de Paranaguá é a terceira",
  "alternativeSelectors": [
    "div.cotacao-paranagua .preco",
    "#paranagua-price"
  ]
}
```

### 4. Validar
```
exec cf-validate-selector.js --selector {novo} --min {min} --max {max}
```

Se válido: atualizar config e alertar sucesso.
Se inválido: tentar alternativa ou próxima tentativa.

### 5. Atualizar Histórico
Sempre que um seletor funcionar, adicione a `memory/selector-history.md`:
```markdown
## soja-paranagua
- 2026-01-27: `table.cotacao-table tr:contains('Paranaguá') td:nth-child(2)` ✅
- 2026-01-20: `div.preco-soja` ❌ (site mudou layout)
```

## Formato dos Alertas

### Sucesso
```
✅ [SCRAPER] Auto-correção realizada

📍 Source: Soja Paranaguá
🔧 Problema: Seletor antigo não funcionou

Seletor antigo: table.old-selector td
Seletor novo: table.new-selector td.price

Valor obtido: R$ 125,50/saca
Confiança: 85%
```

### Falha
```
🚨 [SCRAPER] FALHA - Requer intervenção

📍 Source: Soja Paranaguá
❌ Não foi possível corrigir após 3 tentativas

URL: https://...
Último erro: Valor 5000 fora do range [80, 200]

⚠️ Verificar manualmente a estrutura do site
```

## Regras
- NUNCA invente valores de cotação
- SEMPRE valide o seletor antes de salvar
- Máximo 3 tentativas por source
- Se falhar, alerte e continue para próxima source
- Log todas as ações em logs/YYYY-MM-DD.jsonl
```

### Comparativo: Fluxo Atual vs Clawdbot

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FLUXO ATUAL                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Scraper principal (scrapers.js)                                        │
│         │                                                                │
│         ▼                                                                │
│  Falha extração? ──▶ selfHealingScraper.attemptSelfHealing()           │
│                              │                                           │
│                      ┌───────┴───────┐                                  │
│                      ▼               ▼                                  │
│               Firecrawl API    Puppeteer                                │
│                      │               │                                  │
│                      └───────┬───────┘                                  │
│                              ▼                                           │
│                   GPT-5-mini (function calling)                         │
│                   update_selector(selector, value, confidence)          │
│                              │                                           │
│                              ▼                                           │
│                   validateSelector() com Cheerio                        │
│                              │                                           │
│                      ┌───────┴───────┐                                  │
│                      ▼               ▼                                  │
│                   Sucesso         Falha                                 │
│                      │               │                                  │
│                      ▼               ▼                                  │
│              fs.writeFileSync   retry (max 3)                           │
│                      │               │                                  │
│                      ▼               ▼                                  │
│              scraperAlerts     scraperAlerts                            │
│              .alertSuccess()   .alertFailure()                          │
│                                                                          │
│  Problemas:                                                             │
│  - Puppeteer não fecha corretamente (processos órfãos)                 │
│  - Firecrawl é pago e às vezes lento                                   │
│  - Não aprende com histórico de seletores                              │
│  - Config JSON pode corromper                                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         FLUXO CLAWDBOT                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Cron job (every 15m)                                                   │
│         │                                                                │
│         ▼                                                                │
│  Agent: cloudfarm-scraper-healer                                        │
│         │                                                                │
│         ▼                                                                │
│  read scraper-config.json                                               │
│         │                                                                │
│         ▼                                                                │
│  Para cada source:                                                      │
│         │                                                                │
│         ▼                                                                │
│  browser snapshot (URL) ──▶ HTML                                        │
│         │                                                                │
│         ▼                                                                │
│  exec cf-extract.js ──▶ valor                                           │
│         │                                                                │
│         ├──▶ OK: próximo                                                │
│         │                                                                │
│         └──▶ Falhou: modo healing                                       │
│                   │                                                      │
│                   ▼                                                      │
│              Analisar HTML (LLM)                                        │
│              + memory_search (histórico)                                │
│                   │                                                      │
│                   ▼                                                      │
│              Sugerir seletor (JSON)                                     │
│                   │                                                      │
│                   ▼                                                      │
│              exec cf-validate-selector.js                               │
│                   │                                                      │
│           ┌───────┴───────┐                                             │
│           ▼               ▼                                             │
│        Válido          Inválido                                         │
│           │               │                                             │
│           ▼               ▼                                             │
│     write config     retry (max 3)                                      │
│     write history         │                                             │
│           │               ▼                                             │
│           ▼          message: 🚨                                        │
│     message: ✅                                                         │
│                                                                          │
│  Benefícios:                                                            │
│  - Browser gerenciado pelo Clawdbot (sem processos órfãos)             │
│  - Aprende com histórico via memory_search                             │
│  - Cron nativo para verificação periódica                              │
│  - Alertas multi-canal                                                  │
│  - Logs estruturados                                                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Plano de Execução

| Fase | Tarefa | Estimativa | Dependências |
|------|--------|------------|--------------|
| 1 | Criar workspace `~/cloudfarm-scrapers` | 30min | - |
| 2 | Migrar `scraper-selectors.json` → `scraper-config.json` | 30min | Fase 1 |
| 3 | Implementar scripts helper (cf-extract, cf-validate) | 2h | Fase 1 |
| 4 | Documentar estrutura dos sites em `memory/sites/` | 2h | Fase 1 |
| 5 | Criar `memory/selector-history.md` inicial | 30min | Fase 1 |
| 6 | Configurar agente no Clawdbot | 1h | Fases 1-5 |
| 7 | Configurar cron jobs (health + resumo) | 30min | Fase 6 |
| 8 | Testes com sites reais | 3h | Fases 1-7 |
| 9 | Rodar em paralelo por 1 semana | 1 semana | Fase 8 |
| 10 | Desativar selfHealingScraper.js antigo | 30min | Fase 9 |

### Benefícios da Migração

| Aspecto | Antes (selfHealingScraper) | Depois (Clawdbot) |
|---------|----------------------------|-------------------|
| **Browser** | Puppeteer (processos órfãos) | Browser tool gerenciado |
| **Fallback** | Firecrawl (~$30/mês) | web_fetch (grátis) |
| **Health check** | Manual/scraper principal | Cron nativo (15min) |
| **Aprendizado** | Nenhum | Histórico pesquisável |
| **Alertas** | Telegram only | Multi-canal |
| **Logs** | Console disperso | JSONL estruturado |
| **Resumo diário** | Manual | Cron automático 8h |
| **Código** | ~400 linhas | ~150 linhas + config |

### Funcionalidades Extras

1. **Aprendizado**: Memory search encontra seletores que funcionaram antes para sites similares.

2. **Resumo diário**: Cron às 8h envia status de todas as sources.

3. **Investigação manual**: Posso perguntar "por que o scraper de soja está falhando?" e o agente analisa.

4. **Multi-site**: Fácil adicionar novas sources editando `scraper-config.json`.

5. **Cache de HTML**: Opcional, para debug sem re-renderizar.

### Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Browser sandbox lento | Média | Médio | web_fetch como fallback |
| Seletores diferentes | Baixa | Baixo | Mesmo LLM analisa HTML |
| Sites bloqueiam | Média | Alto | User-Agent realista, rate limit |
| Cron muito frequente | Baixa | Baixo | Ajustar intervalo se necessário |

---

## 4. Code Retriever (RAG)

### Objetivo da Migração

O Code Retriever atual (Pinecone + OpenAI Embeddings) é **completamente substituído** pelo `memory_search` nativo do Clawdbot. Não há código para migrar — apenas documentação do código CloudFarm precisa ser convertida para Markdown.

### Por que Eliminar o Pinecone?

| Aspecto | Pinecone (atual) | memory_search (Clawdbot) |
|---------|-----------------|--------------------------|
| **Custo** | ~$70/mês (Starter) | Incluso |
| **Embeddings** | OpenAI API ($) | OpenAI, Gemini ou Local |
| **Reindexação** | Manual (`npm run index-code`) | Automática (watcher) |
| **Armazenamento** | Cloud (Pinecone) | SQLite local |
| **Busca híbrida** | Apenas vetorial | Vetorial + BM25 |
| **Latência** | ~200-500ms | ~50-100ms (local) |

### Estratégia: Código → Markdown

Em vez de indexar código bruto, documentamos o código em Markdown estruturado:

```
~/cloudfarm-errors/memory/code/
├── services.md          # Documentação dos serviços
├── controllers.md       # Controllers e endpoints
├── models.md            # Schemas MongoDB
├── middlewares.md       # Middlewares
├── common-errors.md     # Erros conhecidos
└── architecture.md      # Visão geral da arquitetura
```

**Vantagens:**
- Mais útil que código bruto (contexto + explicação)
- Editável pelo próprio agente (auto-documentação)
- Busca híbrida encontra símbolos exatos (BM25)
- Não precisa reindexar a cada commit

### Exemplo: services.md

```markdown
# Serviços CloudFarm

## stockService.js

**Localização:** `src/services/stockService.js`

**Função:** Gerenciamento de estoque de produtos agrícolas.

### Métodos principais

#### `addItem(farmId, itemData)`
Adiciona item ao estoque.
- Valida dados com Joi
- Verifica duplicatas por (name + lot + farm)
- Emite evento `stock:added`

#### `removeItem(farmId, itemId, quantity, reason)`
Remove quantidade do estoque.
- Valida quantidade disponível
- Registra motivo da baixa
- Emite evento `stock:removed`

### Erros comuns

- `STOCK_INSUFFICIENT`: Tentativa de remover mais que disponível
- `DUPLICATE_ITEM`: Item com mesmo nome+lote já existe
- `INVALID_FARM`: farmId não encontrado

### Dependências
- `models/StockItem.js`
- `services/auditService.js`
- `utils/validators.js`
```

### Script de Extração Inicial

```bash
#!/bin/bash
# extract-code-docs.sh
# Extrai JSDoc e estrutura para criar documentação inicial

REPO="/home/dev/projects/CloudFarm/apps/backend/src"
OUTPUT="$HOME/cloudfarm-errors/memory/code"

mkdir -p "$OUTPUT"

# Extrair serviços
echo "# Serviços CloudFarm" > "$OUTPUT/services.md"
for file in "$REPO/services/"*.js; do
  name=$(basename "$file")
  echo -e "\n## $name\n" >> "$OUTPUT/services.md"
  # Extrair JSDoc comments
  grep -A 5 "^/\*\*" "$file" >> "$OUTPUT/services.md" 2>/dev/null
  echo "" >> "$OUTPUT/services.md"
done

# Similar para controllers, models, etc.
```

### Plano de Execução

| Fase | Tarefa | Estimativa |
|------|--------|------------|
| 1 | Executar script de extração inicial | 1h |
| 2 | Revisar e enriquecer documentação | 4h |
| 3 | Indexar no workspace do Error Analyzer | Automático |
| 4 | Testar buscas com memory_search | 1h |
| 5 | Desativar Pinecone | 30min |

### Economia

- **Pinecone Starter:** ~$70/mês → **$0**
- **OpenAI Embeddings (indexação):** ~$5/mês → ~$1/mês (apenas query)
- **Total:** ~$75/mês → ~$1/mês

---

## 5. Alertas Telegram

### Objetivo da Migração

Os alertas Telegram atuais (`telegram_alerts.js`, `scraperAlerts.js`) são **completamente substituídos** pela `message` tool nativa do Clawdbot.

### Mapeamento Direto

| Função Atual | Código CloudFarm | Clawdbot Equivalente |
|--------------|------------------|---------------------|
| `sendTelegramMessage(text)` | axios → Bot API | `message(action: "send", target: chatId, message: text)` |
| `alertSelfHealingSuccess()` | Template HTML | Agente formata no SOUL.md |
| `alertSelfHealingFailure()` | Template HTML | Agente formata no SOUL.md |
| `alertDailySummary()` | Template HTML | Cron job isolado |
| `sendAlertWithAnalysis()` | Mensagem + arquivo | `message` + `write` (link para arquivo) |

### Não Há Código para Migrar

A `message` tool já faz tudo:

```javascript
// ANTES (telegram_alerts.js)
await axios.post(`${TELEGRAM_API}${BOT_TOKEN}/sendMessage`, {
  chat_id: CHAT_ID,
  text: message,
  parse_mode: 'HTML'
});

// DEPOIS (Clawdbot - o agente simplesmente usa a tool)
// Não há código - o agente chama message tool diretamente
```

### Benefícios

| Aspecto | Antes | Depois |
|---------|-------|--------|
| **Código** | ~200 linhas em 2 arquivos | 0 linhas |
| **Canais** | Telegram only | Telegram, WhatsApp, Discord, etc. |
| **Formatação** | Templates hardcoded | Definida no SOUL.md |
| **Manutenção** | Atualizar código | Atualizar prompt |

### Único Requisito

Configurar o canal Telegram no Clawdbot (já feito se usa Telegram):

```json5
{
  channels: {
    telegram: {
      enabled: true,
      // ... config existente
    }
  }
}
```

---

## 6. Cronograma Consolidado e Dependências

### Visão Geral

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CRONOGRAMA DE MIGRAÇÃO                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  SEMANA 1: Preparação                                                   │
│  ├── Criar workspaces (3 agentes)                                       │
│  ├── Migrar knowledge base → Markdown                                   │
│  ├── Documentar código → memory/code/                                   │
│  └── Implementar scripts helper                                         │
│                                                                          │
│  SEMANA 2: Configuração                                                 │
│  ├── Configurar agentes no Clawdbot                                     │
│  ├── Configurar bindings e webhooks                                     │
│  ├── Configurar cron jobs                                               │
│  └── Testes unitários dos scripts                                       │
│                                                                          │
│  SEMANA 3: Shadow Mode                                                  │
│  ├── Rodar Claudinho novo em paralelo                                   │
│  ├── Rodar Error Analyzer novo em paralelo                              │
│  ├── Rodar Scraper Healer novo em paralelo                              │
│  └── Comparar resultados                                                │
│                                                                          │
│  SEMANA 4: Cutover                                                      │
│  ├── Desativar sistemas antigos                                         │
│  ├── Cancelar Pinecone                                                  │
│  ├── Monitorar por 1 semana                                             │
│  └── Documentar lições aprendidas                                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Dependências entre Componentes

```
┌─────────────────┐
│  Code Retriever │ ◄─── Eliminar primeiro (libera Pinecone)
│   (Pinecone)    │
└────────┬────────┘
         │ fornece contexto para
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Error Analyzer  │     │    Claudinho    │
│                 │     │                 │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │ ambos usam            │
         ▼                       ▼
┌─────────────────────────────────────────┐
│           Alertas Telegram              │ ◄─── Migra automaticamente
│         (message tool nativa)           │      com os outros
└─────────────────────────────────────────┘

┌─────────────────┐
│ Self-Healing    │ ◄─── Independente, pode migrar em paralelo
│    Scraper      │
└─────────────────┘
```

### Ordem Recomendada de Migração

| Ordem | Componente | Motivo | Duração |
|-------|------------|--------|---------|
| 1 | **Code Retriever** | Libera Pinecone, prepara base para outros | 1 semana |
| 2 | **Error Analyzer** | Usa a documentação criada na fase 1 | 1 semana |
| 3 | **Self-Healing Scraper** | Independente, pode ser paralelo | 1 semana |
| 4 | **Claudinho** | Mais complexo, migrar por último | 2 semanas |
| 5 | **Alertas Telegram** | Automático (já incluso nos outros) | 0 |

### Cronograma Detalhado

#### Semana 1: Code Retriever + Preparação

| Dia | Tarefa | Responsável |
|-----|--------|-------------|
| Seg | Criar script de extração de docs | Dev |
| Ter | Executar extração, revisar output | Dev |
| Qua | Enriquecer documentação de serviços | Dev + Agente |
| Qui | Enriquecer documentação de models | Dev + Agente |
| Sex | Criar workspaces dos 3 agentes | Dev |

#### Semana 2: Error Analyzer + Scraper

| Dia | Tarefa | Responsável |
|-----|--------|-------------|
| Seg | Implementar cf-error-dedupe.js | Dev |
| Ter | Configurar agente Error Analyzer | Dev |
| Qua | Configurar webhook Sentry → Clawdbot | Dev |
| Qui | Implementar scripts do Scraper | Dev |
| Sex | Configurar agente Scraper + cron jobs | Dev |

#### Semana 3: Claudinho + Shadow Mode

| Dia | Tarefa | Responsável |
|-----|--------|-------------|
| Seg | Migrar knowledge base → Markdown | Dev |
| Ter | Implementar scripts cf-query, cf-stats | Dev |
| Qua | Configurar agente Claudinho | Dev |
| Qui | Iniciar shadow mode (todos em paralelo) | Dev |
| Sex | Monitorar, ajustar prompts | Dev |

#### Semana 4: Cutover + Estabilização

| Dia | Tarefa | Responsável |
|-----|--------|-------------|
| Seg | Continuar shadow mode, comparar | Dev |
| Ter | Decisão go/no-go para cutover | Dev |
| Qua | Cutover: desativar sistemas antigos | Dev |
| Qui | Cancelar Pinecone, limpar código antigo | Dev |
| Sex | Documentar, retrospectiva | Dev |

### Economia Projetada

| Item | Custo Atual/mês | Custo Após/mês | Economia |
|------|-----------------|----------------|----------|
| Pinecone Starter | $70 | $0 | $70 |
| Firecrawl | $30 | $0 | $30 |
| OpenAI (embeddings indexação) | $5 | $1 | $4 |
| OpenAI (chamadas duplicadas) | $10 | $5 | $5 |
| **Total** | **$115** | **$6** | **$109/mês** |

**Economia anual projetada: ~$1.300**

### Métricas de Sucesso

| Métrica | Baseline (atual) | Target | Como medir |
|---------|------------------|--------|------------|
| Erros analisados/dia | ~5 | ≥5 | Logs do Clawdbot |
| Tempo de análise | ~30s | ≤20s | Timestamps |
| Scrapers corrigidos automaticamente | 80% | ≥80% | Alertas |
| Uptime dos scrapers | 95% | ≥98% | Cron health check |
| Respostas do Claudinho/dia | ~50 | ≥50 | Sessions |
| Satisfação (informal) | OK | Melhor | Feedback usuários |

### Rollback Plan

Se algo der errado durante o cutover:

1. **Error Analyzer**: Reativar webhook antigo no Sentry (1 clique)
2. **Scraper**: Voltar a chamar `selfHealingScraper.js` no código principal
3. **Claudinho**: Redirecionar bot Telegram para código antigo
4. **Pinecone**: Manter conta ativa por mais 1 mês (segurança)

### Checklist Pré-Cutover

- [ ] Shadow mode rodou por ≥3 dias sem problemas críticos
- [ ] Todos os scripts helper testados com dados reais
- [ ] Alertas chegando no Telegram corretamente
- [ ] memory_search encontrando código relevante
- [ ] Cron jobs executando no horário correto
- [ ] Backup do Pinecone (export dos vetores)
- [ ] Documentação de rollback revisada

---

## Resumo Executivo

### O que está sendo migrado

| De | Para | Benefício Principal |
|----|------|---------------------|
| 5 serviços custom (~2.500 linhas) | 3 agentes Clawdbot + scripts (~400 linhas) | -84% código |
| Pinecone + Firecrawl | memory_search + browser tool | -$100/mês |
| GPT-5-mini fixo | Multi-modelo com failover | Flexibilidade |
| One-shot analysis | Investigação interativa | Qualidade |
| Telegram only | Multi-canal | Alcance |

### Riscos Principais

1. **Regressão funcional** → Mitigado por shadow mode
2. **Performance** → memory_search é mais rápido que Pinecone
3. **Curva de aprendizado** → Prompts bem documentados no SOUL.md

### Próximos Passos Imediatos

1. ✅ Documento de planejamento (este)
2. ⏳ Aprovação do plano
3. ⏳ Criar workspaces e estrutura de arquivos
4. ⏳ Iniciar migração pela Semana 1

---

## Checklist de Progresso

- [x] **Seção 1:** Migração do Claudinho ✅ **DOCUMENTADO**
- [x] **Seção 2:** Migração do Error Analyzer ✅ **DOCUMENTADO**
- [x] **Seção 3:** Migração do Self-Healing Scraper ✅ **DOCUMENTADO**
- [x] **Seção 4:** Migração do Code Retriever ✅ **DOCUMENTADO**
- [x] **Seção 5:** Migração dos Alertas Telegram ✅ **DOCUMENTADO**
- [x] **Seção 6:** Cronograma e Dependências ✅ **DOCUMENTADO**

---

## 📋 Documento Completo

Este documento contém o plano completo de migração das ferramentas de IA do CloudFarm para o Clawdbot.

**Total de páginas:** ~50  
**Linhas de código documentadas:** ~800 (scripts helper)  
**Economia projetada:** $109/mês (~$1.300/ano)  
**Tempo estimado:** 4 semanas  

---

*Documento finalizado em: 2026-01-27*  
*Autor: Assistente Clawd*  
*Revisão: Pendente*
