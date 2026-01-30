---
name: prenotami-monitor
description: Production-ready monitor for Italian consulate appointment slots on Prenotami (prenotami.esteri.it). Features auto-booking, CAPTCHA solving, stealth browsing, multi-account support, and real-time notifications. Use for passport, citizenship, CIE appointments at São Paulo, Curitiba, Rio de Janeiro, and other Brazilian consulates.
---

# Prenotami Monitor v2.0

Production-ready monitor for Italian consulate appointments with auto-booking capabilities.

## Features

- ✅ **Stealth browsing** - User agent rotation, fingerprint spoofing, human-like behavior
- ✅ **CAPTCHA solving** - Automatic via 2Captcha API
- ✅ **Auto-booking** - Automatically book when slots appear
- ✅ **Session encryption** - Secure credential storage
- ✅ **Multi-account** - Run multiple instances for different clients
- ✅ **Health monitoring** - HTTP endpoint for status checks
- ✅ **Moltbot integration** - Real-time notifications via Telegram/Signal/etc
- ✅ **Graceful shutdown** - Saves session state on exit
- ✅ **Proxy support** - IP rotation for anti-detection

## Quick Start

```bash
cd skills/prenotami-monitor/scripts

# Install dependencies
npm install
npx playwright install chromium

# Configure
cp .env.example .env
nano .env  # Fill in credentials

# First run: Manual login to establish session
npm run start:manual

# Normal monitoring
npm start
```

## Configuration

### Required

```env
PRENOTAMI_EMAIL=your@email.com
PRENOTAMI_PASSWORD=your_password
PRENOTAMI_CONSULATE=saopaulo
PRENOTAMI_SERVICE=passport_first
NOTIFY_TARGET=your_telegram_id
```

### Auto-Booking

```env
AUTO_BOOK=true              # Automatically book when slots found
CAPTCHA_API_KEY=your_key    # Required for CAPTCHA pages
```

### Multi-Account (Service Mode)

Run multiple instances for different clients:

```bash
# Client 1
ACCOUNT_ID=client1 \
PRENOTAMI_EMAIL=client1@email.com \
PRENOTAMI_PASSWORD=pass1 \
SESSION_PATH=./sessions/client1.json \
HEALTH_PORT=8081 \
npm start

# Client 2
ACCOUNT_ID=client2 \
PRENOTAMI_EMAIL=client2@email.com \
PRENOTAMI_PASSWORD=pass2 \
SESSION_PATH=./sessions/client2.json \
HEALTH_PORT=8082 \
npm start
```

### Proxy (Anti-Detection)

```env
PROXY_SERVER=http://user:pass@proxy.example.com:8080
PROXY_ROTATE=true
```

### Session Security

```env
# Generate key: openssl rand -hex 32
SESSION_ENCRYPTION_KEY=your_32_byte_hex_key
```

## Usage Modes

### Continuous Monitoring

```bash
npm start                # Monitor with auto-intervals
npm run start:health     # Monitor + health endpoint
```

### Single Check

```bash
npm run start:once       # Check once and exit
```

### Manual Login (Recommended First Run)

```bash
npm run start:manual     # Opens browser for manual login
```

## Health Endpoint

When running with `--health`:

```bash
# Check status
curl http://localhost:8080/health

# Response
{
  "status": "healthy",
  "accountId": "client1",
  "lastCheck": 1706540400000,
  "checksToday": 150,
  "slotsFoundToday": 0,
  "bookingsToday": 0
}
```

## Anti-Detection Features

The monitor includes 25+ stealth techniques:

- **Browser fingerprint** - Spoofed WebGL, Canvas, plugins
- **User agents** - Rotates between 6 realistic agents
- **Viewports** - Random screen sizes
- **Mouse movements** - Bezier curves with random variation
- **Typing** - Variable speed with occasional typos
- **Timing** - Random delays with jitter

## CAPTCHA Handling

### Automatic (2Captcha)

1. Sign up at [2captcha.com](https://2captcha.com)
2. Add funds (~$3 per 1000 CAPTCHAs)
3. Set `CAPTCHA_API_KEY` in .env

### Manual Mode

If no API key, the monitor will:
1. Detect CAPTCHA
2. If `MANUAL_LOGIN=true`, wait for you to solve manually
3. Continue after solved

## Timing

The monitor adjusts check frequency automatically:

| Mode | When | Interval |
|------|------|----------|
| **Active** | Mon/Wed 10:00-12:00 BRT | 5s |
| **Normal** | Daytime (07:00-23:00) | 5min |
| **Idle** | Night (23:00-07:00) | 30min |

## Notifications

When slots are found:

```
🎉 VAGAS DISPONÍVEIS NO PRENOTAMI!

👤 Conta: client1
📍 Consulado: saopaulo
📋 Serviço: passport_first
📊 Quantidade: 3
📅 Datas: 15/04, 16/04, 17/04

🔗 https://prenotami.esteri.it
```

When auto-booking succeeds:

```
✅ AGENDAMENTO CONFIRMADO!

👤 Conta: client1
📍 Consulado: saopaulo
📋 Serviço: passport_first
🎫 Código: ABC123
📅 Data: 15/04/2026
⏰ Horário: 10:30

🔗 https://prenotami.esteri.it
```

## Docker Deployment

```dockerfile
FROM node:20-slim

RUN npx playwright install-deps chromium
WORKDIR /app
COPY scripts/ .
RUN npm install && npx playwright install chromium

ENV HEADLESS=true
CMD ["npm", "start"]
```

```bash
docker build -t prenotami-monitor .
docker run -d \
  --name client1 \
  -e PRENOTAMI_EMAIL=client1@email.com \
  -e PRENOTAMI_PASSWORD=pass \
  -e ACCOUNT_ID=client1 \
  -e NOTIFY_TARGET=123456 \
  -p 8081:8080 \
  prenotami-monitor
```

## Troubleshooting

### "Session expired" frequently

- Enable `SESSION_ENCRYPTION_KEY` for secure storage
- Use `--manual` to establish a fresh session

### CAPTCHA appearing often

- Add `CAPTCHA_API_KEY` for automatic solving
- Try using a proxy: `PROXY_SERVER=...`
- Increase check intervals (reduce frequency)

### Not detecting available slots

- Check `PRENOTAMI_SERVICE` matches your target
- Run with `HEADLESS=false` to see what's happening
- Check screenshots in `./screenshots/`

### Notifications not sending

- Verify `NOTIFY_TARGET` is correct
- Check Moltbot is running: `moltbot status`
- Try `MOLTBOT_GATEWAY=http://localhost:PORT`

## Files

```
prenotami-monitor/
├── SKILL.md                    # This documentation
├── references/
│   └── consulates.md           # Consulate-specific info
└── scripts/
    ├── monitor.ts              # Main monitor (TypeScript)
    ├── package.json            # Dependencies
    ├── setup.sh                # Installation script
    └── .env.example            # Configuration template
```

## Legal Notice

This tool is for **personal use** to help schedule legitimate appointments.

**Do NOT use for:**
- Selling appointments commercially
- Operating as an unlicensed "despachante"
- Bypassing fair queue systems

Italian consulates actively combat automated booking abuse.
