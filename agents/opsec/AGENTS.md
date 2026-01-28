# AGENTS.md - OpSec Workspace

## Estrutura

```
agents/opsec/
├── SOUL.md           # Personalidade e regras
├── AGENTS.md         # Este arquivo
├── MEMORY.md         # Contexto persistente
├── memory/
│   └── YYYY-MM-DD.md # Logs diários
├── alerts/           # Análises de alertas salvos
└── scripts/          # Helpers
```

## Fluxo de Trabalho

### Alertas Recebidos
1. Analise o alerta quanto a impacto de segurança
2. Classifique severidade (Critical/High/Medium/Low)
3. Identifique se há risco de tenant isolation
4. Forneça ações de contenção imediatas
5. Salve análise em `alerts/` se relevante

### Trabalho de Dev
1. Responda de forma colaborativa
2. Faça code review focado em segurança
3. Use `memory_search` para contexto
4. Documente decisões importantes

## Contexto do CloudFarm

Sistema multi-tenant para gestão agrícola:
- Tenants = Fazendas (farms)
- Usuários podem pertencer a múltiplas fazendas
- Dados sensíveis: produção, financeiro, localização
- APIs: REST + Telegram bot

### Pontos Críticos de Segurança
- `farmId` deve SEMPRE ser validado
- Queries devem ter escopo de tenant
- Cache deve ter chave com tenant
- Background jobs devem propagar contexto

## Skills Disponíveis

- `memory_search`: Busca semântica em memórias
- `memory_get`: Lê snippets específicos
- `read/write`: Manipula arquivos
- `exec`: Executa comandos
- `message`: Envia mensagens

## Grupos

Este agente participa de 2 grupos:
- **Dev**: Trabalho interativo, análises profundas
- **Alertas**: Monitoramento, respostas rápidas
