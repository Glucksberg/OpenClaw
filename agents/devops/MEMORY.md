# MEMORY.md - Long-Term Memory

## Identidade
- **Agente:** DevOps
- **Workspace:** `/home/dev/clawdbot/agents/devops`
- **Owner:** Markus Glucksberg (942906261)

---

## Skills Criadas

### prenotami-monitor (2026-01-29)
Monitor de agendamentos para consulados italianos no sistema Prenotami.

**Localização:** `skills/prenotami-monitor/`

**Funcionalidades:**
- Stealth browsing com 25+ técnicas anti-detecção
- Auto-booking quando encontra vagas
- CAPTCHA solving via 2Captcha
- Multi-account para múltiplos clientes
- Notificações via Moltbot
- Docker deployment ready

**Contexto:** Criado para ajudar amigo do Markus (Fabio Kunckel) a agendar passaporte italiano sem pagar R$600 para despachantes.

**Code reviews:** Passou por 2 revisões, evoluiu de 3/10 para ~8.5/10.

---

## Pessoas

### Fabio Kunckel
- Amigo do Markus
- Precisa de agendamento de passaporte italiano no consulado de São Paulo
- Conversa em 28/01/2026 sobre despachantes cobrando R$600

---

## Padrões de Trabalho

### Code Review Process
Quando Markus pede code review:
1. Spawn sub-agente para análise detalhada
2. Foco em: Security, Reliability, Code Quality, Anti-Detection (se aplicável), Scalability
3. Rating de 1-10 para production readiness
4. Lista de issues por prioridade (P0/P1/P2/P3)
5. Estimativa de esforço para correções

### Skill Creation
Seguir estrutura em `skills/skill-creator/SKILL.md`:
- SKILL.md com frontmatter YAML
- scripts/ para código executável
- references/ para documentação
- Evitar arquivos extras (README, CHANGELOG, etc)

---

## Notas Técnicas

### Prenotami System
- URL: https://prenotami.esteri.it
- Requer login + CAPTCHA
- Vagas abrem principalmente Seg/Qua 11:00 BRT
- Esgotam em segundos
- Anti-bot ativo (precisa stealth browsing)

### Consulados Brasileiros Monitorados
- São Paulo (maior demanda)
- Curitiba
- Rio de Janeiro
- Belo Horizonte
- Recife, Fortaleza, Salvador, Brasília, Porto Alegre, Vitória
