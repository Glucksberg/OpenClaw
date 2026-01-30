# Prenotami Consulates Reference

## Brazilian Consulates

### São Paulo (conssanpaolo.esteri.it)

**Coverage**: São Paulo, Mato Grosso, Mato Grosso do Sul, Rondônia, Acre

**Services monitored**:
- `passport_first` - Passaporto prima emissione (first passport)
- `passport_renewal` - Passaporto rinnovo (passport renewal)

**Typical slot release**:
- Mondays around 11:00 BRT (14:00 UTC)
- Random releases throughout the week

**URL patterns**:
- Login: `https://prenotami.esteri.it`
- Services: `/Services` after login
- Passport booking: Service ID varies

---

### Curitiba (conscuritiba.esteri.it)

**Coverage**: Paraná, Santa Catarina

**Services monitored**:
- `passport` - Passaporto
- `citizenship_new_law` - Cidadania (nova lei)
- `citizenship_minors` - Cidadania (filhos menores)

**Typical slot release**:
- Mondays and Wednesdays 11:00 BRT

---

### Rio de Janeiro (consrio.esteri.it)

**Coverage**: Rio de Janeiro, Espírito Santo, Minas Gerais (partial)

**Services monitored**:
- `cie` - Carta d'Identità Elettronica
- `citizenship_new_law` - Cidadania (nova lei)
- `citizenship_minors` - Cidadania (filhos menores)

---

### Belo Horizonte (consbh.esteri.it)

**Coverage**: Minas Gerais (partial), Goiás, Tocantins, Distrito Federal

**Services monitored**:
- `passport` - Passaporto
- `cie` - Carta d'Identità Elettronica

---

### Recife (consrecife.esteri.it)

**Coverage**: Pernambuco, Alagoas, Paraíba, Rio Grande do Norte, Ceará (partial)

**Services monitored**:
- `passport` - Passaporto

---

### Fortaleza (consfortaleza.esteri.it)

**Coverage**: Ceará (partial), Piauí, Maranhão

**Services monitored**:
- `passport` - Passaporto

---

### Salvador (conssalvador.esteri.it)

**Coverage**: Bahia, Sergipe

**Services monitored**:
- `passport` - Passaporto

---

### Brasília (ambbrasilia.esteri.it)

**Coverage**: Distrito Federal, Goiás (partial)

**Services monitored**:
- `passport` - Passaporto
- `cie` - Carta d'Identità Elettronica

---

### Porto Alegre (consportoalegre.esteri.it)

**Coverage**: Rio Grande do Sul

**Services monitored**:
- `passport` - Passaporto
- `citizenship` - Cidadania

---

### Vitória (consvitoria.esteri.it)

**Coverage**: Espírito Santo

**Services monitored**:
- `cie` - Carta d'Identità Elettronica

---

## Service IDs

The Prenotami system uses numeric service IDs. These may change, but common patterns:

| Service | Typical ID Range |
|---------|-----------------|
| Passport (first) | 300-399 |
| Passport (renewal) | 400-499 |
| Citizenship | 500-599 |
| CIE | 600-699 |

**Note**: Always verify current service IDs by inspecting the Services page after login.

## Slot Release Patterns

1. **Scheduled releases**: Most consulates release slots on specific days/times (typically Monday mornings)

2. **Random releases**: Slots may appear at any time due to:
   - Cancellations
   - Additional capacity
   - System updates

3. **Batch sizes**: Usually 50-200 slots per release

4. **Duration**: Slots typically fill within 30 seconds to 2 minutes

## Tips by Consulate

### São Paulo
- Highest demand, fastest to fill
- Consider monitoring 24/7 for cancellation slots
- Peak monitoring: Sunday night through Monday noon

### Curitiba
- More predictable schedule
- Check Monday and Wednesday mornings

### Rio de Janeiro
- CIE slots are particularly scarce
- Citizenship slots more available than São Paulo
