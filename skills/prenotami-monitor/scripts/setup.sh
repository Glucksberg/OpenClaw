#!/bin/bash
# Prenotami Monitor v2.0 Setup Script

set -e

echo ""
echo "🇮🇹 Prenotami Monitor v2.0 Setup"
echo "================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "   Install it from https://nodejs.org/ (v18+)"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js v18+ required, found: $(node -v)"
    exit 1
fi

echo "✅ Node.js: $(node -v)"

# Install dependencies
echo ""
echo "📦 Installing npm dependencies..."
npm install

# Install Playwright browsers
echo ""
echo "🌐 Installing Playwright Chromium..."
npx playwright install chromium

# Create directories
mkdir -p screenshots sessions

# Create .env if not exists
if [ ! -f .env ]; then
    echo ""
    echo "📝 Creating .env from template..."
    cp .env.example .env
    echo ""
    echo "⚠️  IMPORTANT: Edit .env with your credentials!"
    echo "   nano .env"
fi

# Generate encryption key suggestion
echo ""
echo "🔐 Security Tip: Generate an encryption key:"
echo "   openssl rand -hex 32"
echo "   Add it as SESSION_ENCRYPTION_KEY in .env"

echo ""
echo "✅ Setup complete!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit .env with your Prenotami credentials:"
echo "     nano .env"
echo ""
echo "  2. First run (manual login to establish session):"
echo "     npm run start:manual"
echo ""
echo "  3. Start monitoring:"
echo "     npm start"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Commands:"
echo "  npm start              Continuous monitoring"
echo "  npm run start:once     Single check"
echo "  npm run start:manual   Manual login mode"
echo "  npm run start:health   Monitor + health endpoint"
echo ""
echo "Multi-client example:"
echo "  ACCOUNT_ID=client1 PRENOTAMI_EMAIL=... npm start"
echo ""
