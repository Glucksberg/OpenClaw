# Prenotami Monitor v2.1 - Production Docker Image
FROM node:20-slim

# Install Playwright dependencies + curl for healthcheck
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

# Install Playwright Chromium
RUN npx playwright install chromium

# Copy source
COPY monitor.ts ./

# Create directories
RUN mkdir -p screenshots sessions

# Default environment
ENV HEADLESS=true
ENV HEALTH_PORT=8080
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${HEALTH_PORT}/ready || exit 1

# Expose health port
EXPOSE 8080

# Run with health endpoint
CMD ["npx", "tsx", "monitor.ts", "--health"]
