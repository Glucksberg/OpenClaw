# HEARTBEAT.md - CloudFarm Health Monitor

## Checklist de Monitoramento

Execute estas verificações a cada heartbeat. Se encontrar problemas, envie alerta pro grupo.

### 1. Backend CloudFarm
```bash
# Verificar se processo está rodando
pm2 status cloudfarm-api 2>/dev/null | grep -E "online|stopped|error"

# Verificar logs de erro recentes (últimos 5 min)
pm2 logs cloudfarm-api --lines 50 --nostream 2>/dev/null | grep -iE "error|exception|fatal|crash" | tail -5
```

### 2. MongoDB
```bash
# Verificar conexão
mongosh --eval "db.adminCommand('ping')" --quiet 2>/dev/null || echo "MongoDB: FALHA"
```

### 3. Erros 5xx nos logs
```bash
# Contar erros HTTP 5xx recentes
pm2 logs cloudfarm-api --lines 200 --nostream 2>/dev/null | grep -E "status.*5[0-9]{2}|HTTP 5" | wc -l
```

## Critérios de Alerta

| Condição | Ação |
|----------|------|
| Processo stopped/error | 🚨 Alerta CRÍTICO |
| Erros 5xx > 5 em 5min | ⚠️ Alerta WARNING |
| Exceptions nos logs | 📋 Reportar resumo |
| Tudo OK | HEARTBEAT_OK |

## Formato do Alerta

Se encontrar problema:
```
🔒 *OpSec Health Check*

⚠️ *Status*: [CRÍTICO/WARNING]
📍 *Sistema*: CloudFarm Backend
🕐 *Horário*: [timestamp]

💥 *Problema*:
[descrição]

🔧 *Ação sugerida*:
[recomendação]
```

## Notas

- Não alerte para erros já conhecidos/esperados
- Agrupe múltiplos erros similares
- Se tudo estiver OK, responda apenas: HEARTBEAT_OK
