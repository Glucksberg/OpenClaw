/**
 * Prenotami Monitor v2.1
 *
 * Production-ready monitor for Italian consulate appointments.
 * Features: stealth browsing, CAPTCHA solving, auto-booking, multi-account support.
 *
 * Usage:
 *   npx tsx monitor.ts              # Start monitoring loop
 *   npx tsx monitor.ts --once       # Single check
 *   npx tsx monitor.ts --manual     # Manual login mode
 *   npx tsx monitor.ts --health     # Start with health endpoint
 */

import { chromium, Browser, BrowserContext, Page, ElementHandle } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";
import { spawn } from "child_process";

// ============================================================================
// TYPES
// ============================================================================

interface PrenotamiConfig {
  // Credentials
  email: string;
  password: string;

  // Target
  consulate: string;
  service: string;
  serviceId: string;

  // Timing (milliseconds)
  checkIntervalActive: number;
  checkIntervalNormal: number;
  checkIntervalIdle: number;

  // Notification
  notifyChannel: string;
  notifyTarget: string;
  moltbotGateway: string;

  // Options
  captchaApiKey: string;
  manualLogin: boolean;
  headless: boolean;
  screenshotOnFind: boolean;
  autoBook: boolean;

  // Proxy
  proxyServers: string[];
  proxyRotate: boolean;
  currentProxyIndex: number;

  // Security
  sessionEncryptionKey: string;

  // Paths
  sessionPath: string;
  screenshotDir: string;

  // Health
  healthPort: number;

  // Account ID (for multi-account)
  accountId: string;

  // Circuit breaker
  maxConsecutiveErrors: number;
  browserRestartIntervalMs: number;
}

interface SessionData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

interface EncryptedSession {
  salt: string;
  iv: string;
  data: string;
  tag: string;
  savedAt: number;
  expiresAt: number;
}

interface SlotCheckResult {
  available: boolean;
  count?: number;
  dates?: string[];
  screenshotPath?: string;
  error?: string;
}

interface BookingResult {
  success: boolean;
  confirmationCode?: string;
  date?: string;
  time?: string;
  error?: string;
}

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy" | "stopped";
  accountId: string;
  lastCheck: number;
  lastSuccess: number;
  consecutiveErrors: number;
  checksToday: number;
  slotsFoundToday: number;
  bookingsToday: number;
  uptime: number;
  browserRestarts: number;
  currentProxy: string | null;
}

enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

// ============================================================================
// SELECTORS (Centralized)
// ============================================================================

const SELECTORS = {
  // Login page
  emailInput: 'input[name="Email"], input[type="email"], #Email',
  passwordInput: 'input[name="Password"], input[type="password"], #Password',
  loginButton: 'button[type="submit"], input[type="submit"], .btn-login, #login-button',

  // CAPTCHA
  captchaImage: 'img[src*="captcha"], #captchaImage, .captcha-image, [class*="captcha"] img',
  captchaInput: 'input[name*="captcha"], #captchaInput, .captcha-input, [class*="captcha"] input',
  recaptcha: '.g-recaptcha, #recaptcha, [data-sitekey], .recaptcha',

  // Services
  serviceLink: 'a[href*="booking"], a[href*="Booking"], a[href*="Services"]',
  bookingLink: 'a[href*="booking"], [data-service-id]',

  // Slots
  availableSlot: '.available, .open, [class*="available"], td:not(.disabled), .day:not(.disabled)',
  calendar: '.calendar, #calendar, [class*="calendar"], .datepicker',
  timeSlot: '.time-slot, [class*="time"], select[name*="time"], .slot',

  // Confirmation
  confirmButton: 'button[type="submit"], input[type="submit"], .confirm-booking, .btn-primary, .btn-confirm',
  confirmationCode: '.confirmation-code, [class*="confirmation"], [class*="booking-id"], .booking-number',

  // Errors
  errorMessage: '.error, .alert-danger, .validation-summary-errors, .alert-error, [class*="error"]',
};

// No slots indicators (multi-language)
const NO_SLOTS_INDICATORS = [
  "não há disponibilidade",
  "non ci sono date disponibili",
  "no available dates",
  "nessuna disponibilità",
  "unavailable",
  "indisponível",
  "non sono presenti date",
  "nenhuma data disponível",
  "no appointments available",
  "nessun appuntamento disponibile",
];

// Success indicators (multi-language)
const SUCCESS_INDICATORS = [
  "prenotazione confermata",
  "booking confirmed",
  "agendamento confirmado",
  "successo",
  "success",
  "sucesso",
  "appuntamento confermato",
  "appointment confirmed",
];

// ============================================================================
// CONFIGURATION
// ============================================================================

function loadConfig(): PrenotamiConfig {
  // Parse proxy servers (comma-separated)
  const proxyEnv = process.env.PROXY_SERVER || process.env.PROXY_SERVERS || "";
  const proxyServers = proxyEnv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    // Credentials
    email: process.env.PRENOTAMI_EMAIL || "",
    password: process.env.PRENOTAMI_PASSWORD || "",

    // Target
    consulate: process.env.PRENOTAMI_CONSULATE || "saopaulo",
    service: process.env.PRENOTAMI_SERVICE || "passport_first",
    serviceId: process.env.PRENOTAMI_SERVICE_ID || "",

    // Timing (milliseconds)
    checkIntervalActive: parseInt(process.env.CHECK_INTERVAL_ACTIVE || "5000", 10),
    checkIntervalNormal: parseInt(process.env.CHECK_INTERVAL_NORMAL || "300000", 10),
    checkIntervalIdle: parseInt(process.env.CHECK_INTERVAL_IDLE || "1800000", 10),

    // Notification
    notifyChannel: process.env.NOTIFY_CHANNEL || "telegram",
    notifyTarget: process.env.NOTIFY_TARGET || "",
    moltbotGateway: process.env.MOLTBOT_GATEWAY || "http://localhost:3000",

    // Options
    captchaApiKey: process.env.CAPTCHA_API_KEY || "",
    manualLogin: process.env.MANUAL_LOGIN === "true",
    headless: process.env.HEADLESS !== "false",
    screenshotOnFind: process.env.SCREENSHOT_ON_FIND !== "false",
    autoBook: process.env.AUTO_BOOK === "true",

    // Proxy
    proxyServers,
    proxyRotate: process.env.PROXY_ROTATE === "true",
    currentProxyIndex: 0,

    // Security
    sessionEncryptionKey: process.env.SESSION_ENCRYPTION_KEY || "",

    // Paths
    sessionPath: process.env.SESSION_PATH || `./sessions/${process.env.ACCOUNT_ID || "default"}.json`,
    screenshotDir: process.env.SCREENSHOT_DIR || "./screenshots",

    // Health
    healthPort: parseInt(process.env.HEALTH_PORT || "8080", 10),

    // Account ID
    accountId: process.env.ACCOUNT_ID || "default",

    // Circuit breaker
    maxConsecutiveErrors: parseInt(process.env.MAX_CONSECUTIVE_ERRORS || "20", 10),
    browserRestartIntervalMs: parseInt(
      process.env.BROWSER_RESTART_INTERVAL_MS || String(6 * 60 * 60 * 1000),
      10
    ), // 6 hours default
  };
}

const config = loadConfig();

// ============================================================================
// LOGGING
// ============================================================================

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  const entry = {
    level,
    msg,
    accountId: config.accountId,
    ts: new Date().toISOString(),
    ...meta,
  };
  const line = JSON.stringify(entry);

  switch (level) {
    case LogLevel.ERROR:
      console.error(line);
      break;
    case LogLevel.WARN:
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

function logConfig(): void {
  log(LogLevel.INFO, "Configuration loaded", {
    email: config.email ? `${config.email.slice(0, 3)}***@***` : "(not set)",
    password: config.password ? "****" : "(not set)",
    consulate: config.consulate,
    service: config.service,
    captchaApiKey: config.captchaApiKey ? "****" : "(not set)",
    proxyServers: config.proxyServers.length > 0 ? `${config.proxyServers.length} configured` : "(none)",
    proxyRotate: config.proxyRotate,
    autoBook: config.autoBook,
    headless: config.headless,
    maxConsecutiveErrors: config.maxConsecutiveErrors,
  });
}

// ============================================================================
// USER AGENTS & FINGERPRINTS
// ============================================================================

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
];

const DEVICE_MEMORIES = [4, 8, 16];
const HARDWARE_CONCURRENCIES = [4, 8, 12, 16];

function getRandomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomUserAgent(): string {
  return getRandomItem(USER_AGENTS);
}

function getRandomViewport(): { width: number; height: number } {
  return getRandomItem(VIEWPORTS);
}

function getRandomDeviceMemory(): number {
  return getRandomItem(DEVICE_MEMORIES);
}

function getRandomHardwareConcurrency(): number {
  return getRandomItem(HARDWARE_CONCURRENCIES);
}

// ============================================================================
// PROXY ROTATION
// ============================================================================

function getNextProxy(): string | undefined {
  if (config.proxyServers.length === 0) return undefined;

  if (config.proxyRotate) {
    config.currentProxyIndex = (config.currentProxyIndex + 1) % config.proxyServers.length;
  }

  const proxy = config.proxyServers[config.currentProxyIndex];
  log(LogLevel.DEBUG, "Using proxy", {
    index: config.currentProxyIndex,
    total: config.proxyServers.length,
  });
  return proxy;
}

function getCurrentProxy(): string | null {
  if (config.proxyServers.length === 0) return null;
  return config.proxyServers[config.currentProxyIndex];
}

// ============================================================================
// SESSION ENCRYPTION (with random salt)
// ============================================================================

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function encryptSession(data: string): string {
  if (!config.sessionEncryptionKey) return data;

  // Generate random salt for each encryption
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(config.sessionEncryptionKey, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const session: EncryptedSession = {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: authTag.toString("base64"),
    savedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  return JSON.stringify(session);
}

function decryptSession(encrypted: string): string | null {
  if (!config.sessionEncryptionKey) return encrypted;

  try {
    const session: EncryptedSession = JSON.parse(encrypted);

    // Check expiry
    if (Date.now() > session.expiresAt) {
      log(LogLevel.WARN, "Session expired");
      return null;
    }

    // Use stored salt
    const salt = Buffer.from(session.salt, "base64");
    const key = crypto.scryptSync(config.sessionEncryptionKey, salt, 32);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(session.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(session.tag, "base64"));
    const decrypted =
      decipher.update(Buffer.from(session.data, "base64")) + decipher.final("utf8");

    return decrypted;
  } catch (e) {
    log(LogLevel.ERROR, "Failed to decrypt session", { error: String(e) });
    return null;
  }
}

// ============================================================================
// INPUT VALIDATION
// ============================================================================

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.email) {
    errors.push("PRENOTAMI_EMAIL is required");
  } else if (!validateEmail(config.email)) {
    errors.push("PRENOTAMI_EMAIL is not a valid email address");
  }

  if (!config.password) {
    errors.push("PRENOTAMI_PASSWORD is required");
  } else if (config.password.length < 4) {
    errors.push("PRENOTAMI_PASSWORD seems too short");
  }

  if (config.sessionEncryptionKey && config.sessionEncryptionKey.length < 32) {
    errors.push("SESSION_ENCRYPTION_KEY should be at least 32 characters (use: openssl rand -hex 32)");
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    name?: string;
  } = {}
): Promise<T> {
  const { maxRetries = 5, baseDelayMs = 1000, maxDelayMs = 60000, name = "operation" } = options;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        maxDelayMs
      );
      log(LogLevel.WARN, `${name} failed, retrying`, {
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delay),
        error: String(error),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Max retries exceeded");
}

// ============================================================================
// HUMAN-LIKE DELAYS AND MOVEMENTS
// ============================================================================

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function humanLikeMouseMove(
  page: Page,
  targetX: number,
  targetY: number
): Promise<void> {
  const steps = 10 + Math.floor(Math.random() * 20);

  // Get current position (or start from random edge)
  const startX = Math.random() * 100;
  const startY = Math.random() * 100;

  // Move with bezier-like curve
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    // Add slight curve
    const curve = Math.sin(progress * Math.PI) * (Math.random() * 20 - 10);

    const x = startX + (targetX - startX) * progress + curve;
    const y = startY + (targetY - startY) * progress + curve * 0.5;

    await page.mouse.move(x, y);
    await randomDelay(5, 15);
  }
}

async function humanLikeClick(page: Page, selector: string): Promise<void> {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) throw new Error("Element not visible");

  // Random position within element (avoid edges)
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);

  await humanLikeMouseMove(page, x, y);
  await randomDelay(50, 150);
  await page.mouse.click(x, y);
}

async function humanLikeType(page: Page, text: string): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Occasional typo (2% chance)
    if (Math.random() < 0.02 && i < text.length - 1) {
      const typo = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await page.keyboard.type(typo);
      await randomDelay(100, 200);
      await page.keyboard.press("Backspace");
      await randomDelay(50, 100);
    }

    await page.keyboard.type(char);

    // Variable delay - longer for special chars
    const baseDelay = /[A-Z@.!?]/.test(char) ? 80 : 40;
    await randomDelay(baseDelay, baseDelay * 2.5);

    // Occasional longer pause (thinking)
    if (Math.random() < 0.05) {
      await randomDelay(200, 500);
    }
  }
}

// ============================================================================
// BROWSER MANAGEMENT
// ============================================================================

const BASE_URL = "https://prenotami.esteri.it";

class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private startTime: number = 0;
  private restartCount: number = 0;

  async initialize(): Promise<Page> {
    await this.createBrowser();
    return this.page!;
  }

  private async createBrowser(): Promise<void> {
    // Close existing if any
    await this.close();

    const proxy = getNextProxy();

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: config.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-infobars",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--metrics-recording-only",
        "--no-first-run",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--window-size=1920,1080",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--flag-switches-begin",
        "--flag-switches-end",
      ],
    };

    if (proxy) {
      launchOptions.proxy = { server: proxy };
      log(LogLevel.INFO, "Using proxy server");
    }

    this.browser = await chromium.launch(launchOptions);
    this.startTime = Date.now();

    // Handle browser disconnect
    this.browser.on("disconnected", () => {
      log(LogLevel.WARN, "Browser disconnected unexpectedly");
      this.browser = null;
      this.context = null;
      this.page = null;
    });

    // Create context
    this.context = await this.createStealthContext();
    this.page = await this.context.newPage();

    log(LogLevel.INFO, "Browser initialized", { restartCount: this.restartCount });
  }

  private async createStealthContext(): Promise<BrowserContext> {
    // Try to load saved session
    let storageState: SessionData | undefined;
    if (fs.existsSync(config.sessionPath)) {
      try {
        const encrypted = fs.readFileSync(config.sessionPath, "utf-8");
        const decrypted = decryptSession(encrypted);
        if (decrypted) {
          storageState = JSON.parse(decrypted);
          log(LogLevel.INFO, "Loaded saved session");
        }
      } catch (e) {
        log(LogLevel.WARN, "Could not load saved session", { error: String(e) });
      }
    }

    const userAgent = getRandomUserAgent();
    const viewport = getRandomViewport();
    const deviceMemory = getRandomDeviceMemory();
    const hardwareConcurrency = getRandomHardwareConcurrency();

    const context = await this.browser!.newContext({
      userAgent,
      viewport,
      locale: "pt-BR",
      timezoneId: "America/Sao_Paulo",
      storageState: storageState as any,
      deviceScaleFactor: Math.random() > 0.5 ? 1 : 1.25,
      hasTouch: false,
      isMobile: false,
      javaScriptEnabled: true,
    });

    // Inject stealth scripts with randomized values
    await context.addInitScript(
      ({ deviceMem, hwConcurrency }) => {
        // Hide webdriver
        Object.defineProperty(navigator, "webdriver", { get: () => false });

        // Fake plugins
        Object.defineProperty(navigator, "plugins", {
          get: () => [
            { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
            { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
            { name: "Native Client", filename: "internal-nacl-plugin" },
          ],
        });

        // Fake languages
        Object.defineProperty(navigator, "languages", {
          get: () => ["pt-BR", "pt", "en-US", "en"],
        });

        // Fake platform
        Object.defineProperty(navigator, "platform", { get: () => "Win32" });

        // Randomized hardware (passed from outer scope)
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => hwConcurrency });
        Object.defineProperty(navigator, "deviceMemory", { get: () => deviceMem });
        Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });

        // Fake vendor
        Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });

        // Chrome runtime object
        (window as any).chrome = {
          runtime: {},
          loadTimes: () => ({}),
          csi: () => ({}),
          app: {},
        };

        // Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: "denied" } as PermissionStatus)
            : originalQuery(parameters);

        // WebGL vendor/renderer spoofing
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (parameter) {
          if (parameter === 37445) return "Intel Inc.";
          if (parameter === 37446) return "Intel Iris OpenGL Engine";
          return getParameter.call(this, parameter);
        };

        // Canvas fingerprint noise
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (type?: string) {
          if (type === "image/png") {
            const context = this.getContext("2d");
            if (context) {
              const imageData = context.getImageData(0, 0, this.width, this.height);
              for (let i = 0; i < imageData.data.length; i += 4) {
                imageData.data[i] ^= Math.random() > 0.5 ? 1 : 0;
              }
              context.putImageData(imageData, 0, 0);
            }
          }
          return originalToDataURL.apply(this, arguments as any);
        };
      },
      { deviceMem: deviceMemory, hwConcurrency: hardwareConcurrency }
    );

    log(LogLevel.INFO, "Browser context created", {
      userAgent: userAgent.slice(0, 50) + "...",
      viewport,
      deviceMemory,
      hardwareConcurrency,
    });

    return context;
  }

  async ensureHealthy(): Promise<boolean> {
    // Check if browser exists
    if (!this.browser || !this.context || !this.page) {
      log(LogLevel.WARN, "Browser not initialized, recreating...");
      await this.restart();
      return true;
    }

    // Check if browser is connected
    if (!this.browser.isConnected()) {
      log(LogLevel.WARN, "Browser disconnected, recreating...");
      await this.restart();
      return true;
    }

    // Check if it's time for periodic restart (memory leak prevention)
    const elapsed = Date.now() - this.startTime;
    if (elapsed > config.browserRestartIntervalMs) {
      log(LogLevel.INFO, "Periodic browser restart for memory management");
      await this.restart();
      return true;
    }

    // Check page health
    try {
      await this.page.evaluate(() => document.readyState, { timeout: 5000 });
      return true;
    } catch {
      log(LogLevel.WARN, "Page unresponsive, recreating...");
      await this.restart();
      return true;
    }
  }

  async restart(): Promise<void> {
    this.restartCount++;
    healthStatus.browserRestarts = this.restartCount;

    // Rotate proxy on restart if enabled
    if (config.proxyRotate && config.proxyServers.length > 0) {
      log(LogLevel.INFO, "Rotating proxy on restart");
    }

    await this.createBrowser();
  }

  async saveSession(): Promise<void> {
    if (!this.context) return;

    try {
      // Ensure directory exists
      const dir = path.dirname(config.sessionPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = await this.context.storageState();
      const encrypted = encryptSession(JSON.stringify(state));
      fs.writeFileSync(config.sessionPath, encrypted);
      log(LogLevel.INFO, "Session saved");
    } catch (error) {
      log(LogLevel.ERROR, "Could not save session", { error: String(error) });
    }
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.saveSession();
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } catch (e) {
      log(LogLevel.DEBUG, "Error during browser close", { error: String(e) });
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  getPage(): Page | null {
    return this.page;
  }

  getContext(): BrowserContext | null {
    return this.context;
  }

  getRestartCount(): number {
    return this.restartCount;
  }
}

// ============================================================================
// CAPTCHA SOLVING (2Captcha)
// ============================================================================

async function solveCaptcha2Captcha(imageBase64: string): Promise<string> {
  if (!config.captchaApiKey) {
    throw new Error("No CAPTCHA API key configured");
  }

  log(LogLevel.INFO, "Submitting CAPTCHA to 2Captcha...");

  // Submit CAPTCHA
  const submitRes = await fetch("http://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      key: config.captchaApiKey,
      method: "base64",
      body: imageBase64,
      json: "1",
    }),
  });
  const submitData = await submitRes.json();

  if (submitData.status !== 1) {
    throw new Error(`2Captcha submit failed: ${submitData.request}`);
  }

  const taskId = submitData.request;
  log(LogLevel.INFO, "CAPTCHA submitted", { taskId });

  // Poll for result
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    const resultRes = await fetch(
      `http://2captcha.com/res.php?key=${config.captchaApiKey}&action=get&id=${taskId}&json=1`
    );
    const resultData = await resultRes.json();

    if (resultData.status === 1) {
      log(LogLevel.INFO, "CAPTCHA solved");
      return resultData.request;
    }

    if (resultData.request !== "CAPCHA_NOT_READY") {
      throw new Error(`2Captcha error: ${resultData.request}`);
    }
  }

  throw new Error("CAPTCHA solve timeout");
}

async function handleCaptcha(page: Page): Promise<boolean> {
  // Check for CAPTCHA presence
  const captchaImage = await page.$(SELECTORS.captchaImage);

  if (!captchaImage) {
    // Check for reCAPTCHA
    const recaptcha = await page.$(SELECTORS.recaptcha);
    if (recaptcha) {
      log(LogLevel.WARN, "reCAPTCHA detected - not supported for auto-solve");
      return false;
    }
    return true; // No CAPTCHA
  }

  if (!config.captchaApiKey) {
    log(LogLevel.WARN, "CAPTCHA detected but no API key configured");
    return false;
  }

  try {
    // Get CAPTCHA image as base64
    const imageBase64 = await captchaImage.evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1];
    });

    // Solve CAPTCHA
    const solution = await solveCaptcha2Captcha(imageBase64);

    // Enter solution
    const captchaInput = await page.$(SELECTORS.captchaInput);
    if (captchaInput) {
      await captchaInput.fill(solution);
      await randomDelay(500, 1000);
      return true;
    }
  } catch (error) {
    log(LogLevel.ERROR, "CAPTCHA handling failed", { error: String(error) });
  }

  return false;
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

async function login(page: Page): Promise<boolean> {
  log(LogLevel.INFO, "Attempting login...");

  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await randomDelay(1000, 2000);

    // Check if already logged in
    const isLoggedIn = await page.evaluate(() => {
      return (
        window.location.pathname.includes("/UserArea") ||
        window.location.pathname.includes("/Services")
      );
    });

    if (isLoggedIn) {
      log(LogLevel.INFO, "Already logged in (session valid)");
      return true;
    }

    // Find and fill email
    const emailInput = await page.waitForSelector(SELECTORS.emailInput, { timeout: 10000 });
    if (!emailInput) throw new Error("Email input not found");

    await humanLikeClick(page, SELECTORS.emailInput);
    await randomDelay(200, 400);
    await humanLikeType(page, config.email);

    await randomDelay(500, 1000);

    // Find and fill password
    await humanLikeClick(page, SELECTORS.passwordInput);
    await randomDelay(200, 400);
    await humanLikeType(page, config.password);

    await randomDelay(500, 1000);

    // Handle CAPTCHA if present (before submit)
    await handleCaptcha(page);

    // Click login button
    const loginButton = await page.$(SELECTORS.loginButton);
    if (loginButton) {
      const box = await loginButton.boundingBox();
      if (box) {
        await humanLikeMouseMove(page, box.x + box.width / 2, box.y + box.height / 2);
        await randomDelay(100, 200);
        await loginButton.click();
      }
    } else {
      await page.keyboard.press("Enter");
    }

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });

    // Check for CAPTCHA after submit
    const captchaAfter = await page.$(SELECTORS.captchaImage);
    if (captchaAfter) {
      const solved = await handleCaptcha(page);
      if (!solved) {
        if (config.manualLogin) {
          log(LogLevel.WARN, "Please solve CAPTCHA manually...");
          await page.waitForNavigation({ waitUntil: "networkidle", timeout: 120000 });
        } else {
          throw new Error("CAPTCHA detected and could not be solved automatically");
        }
      }

      // Submit again after CAPTCHA
      const submitBtn = await page.$(SELECTORS.loginButton);
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });
      }
    }

    // Verify login success
    const success = await page.evaluate(() => {
      return (
        window.location.pathname.includes("/UserArea") ||
        window.location.pathname.includes("/Services") ||
        document.body.innerText.includes("Prenota") ||
        document.body.innerText.includes("Area riservata")
      );
    });

    if (success) {
      log(LogLevel.INFO, "Login successful");
      return true;
    } else {
      const errorText = await page.evaluate((sel) => {
        const errorEl = document.querySelector(sel);
        return errorEl?.textContent?.trim() || "";
      }, SELECTORS.errorMessage);
      log(LogLevel.ERROR, "Login failed", { errorText });
      return false;
    }
  } catch (error) {
    log(LogLevel.ERROR, "Login error", { error: String(error) });
    return false;
  }
}

// ============================================================================
// SLOT CHECKING
// ============================================================================

async function findServiceLink(page: Page): Promise<ElementHandle | null> {
  // Try specific service ID first
  if (config.serviceId) {
    const byId = await page.$(`a[href*="${config.serviceId}"], [data-service-id="${config.serviceId}"]`);
    if (byId) return byId;
  }

  // Service name mappings
  const serviceKeywords: Record<string, string[]> = {
    passport_first: ["Passaporto", "Passport", "prima emissione", "first"],
    passport_renewal: ["rinnovo", "renewal", "Passaporto"],
    citizenship: ["Cittadinanza", "Citizenship", "cidadania"],
    cie: ["Carta d'Identità", "CIE", "Identity Card", "Identidade"],
  };

  const keywords = serviceKeywords[config.service] || [config.service];

  // Find links containing keywords
  const links = await page.$$("a");
  for (const link of links) {
    const text = await link.textContent();
    const href = await link.getAttribute("href");

    for (const keyword of keywords) {
      if (
        text?.toLowerCase().includes(keyword.toLowerCase()) ||
        href?.toLowerCase().includes(keyword.toLowerCase())
      ) {
        // Verify it's a booking link
        if (href?.includes("booking") || href?.includes("Booking") || href?.includes("Services")) {
          return link;
        }
      }
    }
  }

  // Fallback: any booking link
  return page.$(SELECTORS.bookingLink);
}

async function checkSlots(page: Page): Promise<SlotCheckResult> {
  log(LogLevel.INFO, "Checking for available slots...");

  try {
    // Navigate to services
    await page.goto(`${BASE_URL}/Services`, { waitUntil: "networkidle" });
    await randomDelay(1000, 2000);

    // Find target service
    const serviceLink = await findServiceLink(page);
    if (!serviceLink) {
      log(LogLevel.WARN, "Service link not found");
      return { available: false, error: "Service link not found" };
    }

    await serviceLink.click();
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 });
    await randomDelay(500, 1000);

    // Handle any CAPTCHA
    await handleCaptcha(page);

    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());

    // Check for "no availability" indicators
    const hasNoSlots = NO_SLOTS_INDICATORS.some((indicator) =>
      pageText.includes(indicator.toLowerCase())
    );

    if (hasNoSlots) {
      log(LogLevel.INFO, "No slots available");
      return { available: false };
    }

    // Look for calendar or available dates
    const availableIndicators = await page.evaluate((selectors) => {
      const calendar = document.querySelector(selectors.calendar);
      const availableDates = document.querySelectorAll(selectors.availableSlot);
      const bookButton = document.querySelector(selectors.confirmButton + ":not([disabled])");

      return {
        hasCalendar: calendar !== null,
        availableCount: availableDates.length,
        hasBookButton: bookButton !== null,
      };
    }, SELECTORS);

    if (
      availableIndicators.hasCalendar ||
      availableIndicators.availableCount > 0 ||
      availableIndicators.hasBookButton
    ) {
      log(LogLevel.INFO, "SLOTS POTENTIALLY AVAILABLE!", availableIndicators);

      // Extract available dates
      const dates = await page.evaluate((sel) => {
        const dateElements = document.querySelectorAll(sel);
        return Array.from(dateElements)
          .map((el) => el.textContent?.trim())
          .filter(Boolean)
          .slice(0, 10) as string[];
      }, SELECTORS.availableSlot);

      return {
        available: true,
        count: availableIndicators.availableCount || 1,
        dates: dates.length > 0 ? dates : undefined,
      };
    }

    log(LogLevel.INFO, "No slots found");
    return { available: false };
  } catch (error) {
    log(LogLevel.ERROR, "Error checking slots", { error: String(error) });
    return { available: false, error: String(error) };
  }
}

// ============================================================================
// AUTO-BOOKING
// ============================================================================

async function attemptBooking(page: Page): Promise<BookingResult> {
  if (!config.autoBook) {
    return { success: false, error: "Auto-booking disabled" };
  }

  log(LogLevel.INFO, "Attempting auto-booking...");

  try {
    // Click on first available date
    const dateElement = await page.$(SELECTORS.availableSlot);

    if (!dateElement) {
      return { success: false, error: "No available date element found" };
    }

    await dateElement.click();
    await randomDelay(500, 1000);

    // Select time slot if present
    const timeSlot = await page.$(SELECTORS.timeSlot + ".available, " + SELECTORS.timeSlot + ":not([disabled])");
    if (timeSlot) {
      await timeSlot.click();
      await randomDelay(300, 500);
    }

    // Handle any CAPTCHA before final submit
    await handleCaptcha(page);

    // Look for confirm/submit button
    const confirmBtn = await page.$(SELECTORS.confirmButton);

    if (!confirmBtn) {
      return { success: false, error: "Confirm button not found" };
    }

    // Take screenshot before confirming
    await takeScreenshot(page, "pre-booking");

    await confirmBtn.click();

    // Wait for confirmation page
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 });

    // Extract confirmation details
    const confirmation = await page.evaluate((selectors) => {
      const confirmCode =
        document.querySelector(selectors.confirmationCode)?.textContent?.trim() ||
        document.body.innerText.match(/(?:codice|code|número|number)[:\s]*([A-Z0-9-]+)/i)?.[1];

      const dateText =
        document.querySelector('.booking-date, [class*="date"]')?.textContent?.trim() ||
        document.body.innerText.match(/(?:data|date)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)?.[1];

      const timeText =
        document.querySelector('.booking-time, [class*="time"]')?.textContent?.trim() ||
        document.body.innerText.match(/(?:ora|time|horário)[:\s]*(\d{1,2}:\d{2})/i)?.[1];

      const pageText = document.body.innerText.toLowerCase();
      const successIndicators = [
        "prenotazione confermata",
        "booking confirmed",
        "agendamento confirmado",
        "successo",
        "success",
        "sucesso",
      ];
      const isSuccess = successIndicators.some((ind) => pageText.includes(ind));

      return { confirmCode, dateText, timeText, isSuccess };
    }, SELECTORS);

    // Take screenshot of confirmation
    await takeScreenshot(page, "booking-confirmation");

    if (confirmation.isSuccess || confirmation.confirmCode) {
      log(LogLevel.INFO, "BOOKING SUCCESSFUL!", confirmation);
      return {
        success: true,
        confirmationCode: confirmation.confirmCode,
        date: confirmation.dateText,
        time: confirmation.timeText,
      };
    } else {
      return { success: false, error: "Booking may have failed - check manually" };
    }
  } catch (error) {
    log(LogLevel.ERROR, "Booking error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

// ============================================================================
// SCREENSHOTS
// ============================================================================

async function takeScreenshot(page: Page, name: string): Promise<string> {
  if (!fs.existsSync(config.screenshotDir)) {
    fs.mkdirSync(config.screenshotDir, { recursive: true });
  }

  const filename = `${config.accountId}_${name}_${Date.now()}.png`;
  const filepath = path.join(config.screenshotDir, filename);

  await page.screenshot({ path: filepath, fullPage: true });
  log(LogLevel.INFO, "Screenshot saved", { filepath });

  return filepath;
}

// ============================================================================
// NOTIFICATIONS (MOLTBOT INTEGRATION)
// ============================================================================

async function sendNotification(message: string, screenshotPath?: string): Promise<void> {
  log(LogLevel.INFO, "Sending notification", { channel: config.notifyChannel, target: config.notifyTarget });

  // Method 1: Try Moltbot CLI
  try {
    const args = [
      "moltbot",
      "message",
      "send",
      "--channel",
      config.notifyChannel,
      "--target",
      config.notifyTarget,
      "--message",
      message,
    ];

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      args.push("--file", screenshotPath);
    }

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(args[0], args.slice(1), { stdio: "inherit" });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
      proc.on("error", reject);
    });

    log(LogLevel.INFO, "Notification sent via Moltbot CLI");
    return;
  } catch (e) {
    log(LogLevel.WARN, "Moltbot CLI failed, trying HTTP", { error: String(e) });
  }

  // Method 2: Try Moltbot HTTP Gateway
  try {
    const payload: Record<string, unknown> = {
      action: "send",
      channel: config.notifyChannel,
      target: config.notifyTarget,
      message,
    };

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const imageData = fs.readFileSync(screenshotPath);
      payload.buffer = `data:image/png;base64,${imageData.toString("base64")}`;
    }

    const res = await fetch(`${config.moltbotGateway}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      log(LogLevel.INFO, "Notification sent via HTTP");
      return;
    }
  } catch (e) {
    log(LogLevel.WARN, "HTTP notification failed", { error: String(e) });
  }

  // Method 3: Fallback to console
  log(LogLevel.WARN, "Could not send notification - logging only");
  console.log("\n" + "=".repeat(60));
  console.log("📢 NOTIFICATION:");
  console.log(message);
  console.log("=".repeat(60) + "\n");
}

// ============================================================================
// TIMING
// ============================================================================

function getCheckInterval(): number {
  const now = new Date();
  const hour = now.getUTCHours() - 3; // BRT = UTC-3
  const day = now.getDay();

  // Active: Monday 10:00-12:00 BRT, Wednesday 10:00-12:00 BRT
  if ((day === 1 || day === 3) && hour >= 10 && hour <= 12) {
    log(LogLevel.DEBUG, "Active mode");
    return config.checkIntervalActive;
  }

  // Idle: Late night 23:00-07:00 BRT
  if (hour >= 23 || hour < 7) {
    log(LogLevel.DEBUG, "Idle mode");
    return config.checkIntervalIdle;
  }

  return config.checkIntervalNormal;
}

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

let healthStatus: HealthStatus = {
  status: "healthy",
  accountId: config.accountId,
  lastCheck: 0,
  lastSuccess: 0,
  consecutiveErrors: 0,
  checksToday: 0,
  slotsFoundToday: 0,
  bookingsToday: 0,
  uptime: Date.now(),
  browserRestarts: 0,
  currentProxy: getCurrentProxy(),
};

function updateHealthStatus(success: boolean, slotsFound: boolean = false, booked: boolean = false): void {
  healthStatus.lastCheck = Date.now();
  healthStatus.currentProxy = getCurrentProxy();

  if (success) {
    healthStatus.lastSuccess = Date.now();
    healthStatus.consecutiveErrors = 0;
    healthStatus.checksToday++;
  } else {
    healthStatus.consecutiveErrors++;
  }

  if (slotsFound) healthStatus.slotsFoundToday++;
  if (booked) healthStatus.bookingsToday++;

  // Update status based on errors
  if (healthStatus.consecutiveErrors === 0) {
    healthStatus.status = "healthy";
  } else if (healthStatus.consecutiveErrors < 5) {
    healthStatus.status = "degraded";
  } else {
    healthStatus.status = "unhealthy";
  }
}

function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...healthStatus, uptime: Date.now() - healthStatus.uptime }));
    } else if (req.url === "/ready") {
      const code = healthStatus.status === "unhealthy" || healthStatus.status === "stopped" ? 503 : 200;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: code === 200 }));
    } else if (req.url === "/metrics") {
      // Prometheus-style metrics
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`# HELP prenotami_checks_total Total number of checks
# TYPE prenotami_checks_total counter
prenotami_checks_total{account="${config.accountId}"} ${healthStatus.checksToday}

# HELP prenotami_slots_found_total Total slots found
# TYPE prenotami_slots_found_total counter
prenotami_slots_found_total{account="${config.accountId}"} ${healthStatus.slotsFoundToday}

# HELP prenotami_bookings_total Total bookings made
# TYPE prenotami_bookings_total counter
prenotami_bookings_total{account="${config.accountId}"} ${healthStatus.bookingsToday}

# HELP prenotami_consecutive_errors Current consecutive errors
# TYPE prenotami_consecutive_errors gauge
prenotami_consecutive_errors{account="${config.accountId}"} ${healthStatus.consecutiveErrors}

# HELP prenotami_browser_restarts_total Total browser restarts
# TYPE prenotami_browser_restarts_total counter
prenotami_browser_restarts_total{account="${config.accountId}"} ${healthStatus.browserRestarts}

# HELP prenotami_up Monitor is up
# TYPE prenotami_up gauge
prenotami_up{account="${config.accountId}"} ${healthStatus.status === "stopped" ? 0 : 1}
`);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(config.healthPort, () => {
    log(LogLevel.INFO, `Health endpoint started`, { port: config.healthPort, endpoints: ["/health", "/ready", "/metrics"] });
  });
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

async function checkCircuitBreaker(browserManager: BrowserManager): Promise<boolean> {
  if (healthStatus.consecutiveErrors >= config.maxConsecutiveErrors) {
    log(LogLevel.ERROR, "Circuit breaker triggered - too many consecutive errors", {
      consecutiveErrors: healthStatus.consecutiveErrors,
      maxConsecutiveErrors: config.maxConsecutiveErrors,
    });

    healthStatus.status = "stopped";

    await sendNotification(
      `🔴 MONITOR PARADO!\n\n` +
        `👤 Conta: ${config.accountId}\n` +
        `❌ Erros consecutivos: ${healthStatus.consecutiveErrors}\n` +
        `⏰ Último sucesso: ${new Date(healthStatus.lastSuccess).toISOString()}\n\n` +
        `O monitor foi parado após ${config.maxConsecutiveErrors} falhas consecutivas.\n` +
        `Verifique as credenciais e reinicie manualmente.`
    );

    return true; // Should stop
  }

  return false; // Continue
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let isShuttingDown = false;
let browserManager: BrowserManager | null = null;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log(LogLevel.INFO, "Shutting down gracefully...");

  try {
    if (browserManager) {
      await browserManager.close();
    }
  } catch (e) {
    log(LogLevel.ERROR, "Shutdown error", { error: String(e) });
  }

  process.exit(0);
}

// ============================================================================
// MANUAL LOGIN MODE
// ============================================================================

async function manualLoginMode(): Promise<void> {
  log(LogLevel.INFO, "Manual login mode - please log in manually");

  browserManager = new BrowserManager();
  const page = await browserManager.initialize();

  await page.goto(BASE_URL);

  console.log("\n" + "=".repeat(60));
  console.log("👤 MANUAL LOGIN MODE");
  console.log("Please log in to Prenotami in the browser window.");
  console.log("The session will be saved automatically once logged in.");
  console.log("=".repeat(60) + "\n");

  // Poll for login completion
  while (!isShuttingDown) {
    await randomDelay(5000, 5000);

    const isLoggedIn = await page.evaluate(() => {
      return (
        window.location.pathname.includes("/UserArea") ||
        window.location.pathname.includes("/Services")
      );
    });

    if (isLoggedIn) {
      log(LogLevel.INFO, "Login detected, saving session...");
      await browserManager.saveSession();
      console.log("\n✅ Session saved! You can now run the monitor normally.\n");
      break;
    }
  }

  await browserManager.close();
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runOnce = args.includes("--once");
  const manualLogin = args.includes("--manual");
  const withHealth = args.includes("--health");

  console.log("\n🇮🇹 Prenotami Monitor v2.1\n");
  logConfig();

  // Validate configuration
  const validation = validateConfig();
  if (!validation.valid) {
    for (const error of validation.errors) {
      log(LogLevel.ERROR, error);
    }
    process.exit(1);
  }

  // Setup signal handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Manual login mode
  if (manualLogin) {
    await manualLoginMode();
    return;
  }

  // Start health server if requested
  if (withHealth) {
    startHealthServer();
  }

  // Main monitoring
  browserManager = new BrowserManager();
  let page = await browserManager.initialize();

  try {
    // Initial login
    const loggedIn = await withRetry(() => login(page), {
      maxRetries: 3,
      name: "login",
    });

    if (!loggedIn) {
      log(LogLevel.ERROR, "Could not log in after retries. Exiting.");
      await shutdown();
      return;
    }

    await browserManager.saveSession();

    // Monitoring loop
    while (!isShuttingDown) {
      try {
        // Check circuit breaker
        if (await checkCircuitBreaker(browserManager)) {
          break;
        }

        // Ensure browser is healthy (handles crashes and periodic restarts)
        await browserManager.ensureHealthy();
        page = browserManager.getPage()!;

        // Re-login if needed after browser restart
        const url = page.url();
        if (!url.includes("/UserArea") && !url.includes("/Services")) {
          log(LogLevel.INFO, "Re-authenticating after browser restart...");
          await login(page);
          await browserManager.saveSession();
        }

        // Check for slots
        const result = await checkSlots(page);
        updateHealthStatus(true, result.available);

        if (result.available) {
          // Take screenshot
          let screenshotPath: string | undefined;
          if (config.screenshotOnFind) {
            screenshotPath = await takeScreenshot(page, "slots_found");
          }

          // Build notification message
          let message = `🎉 VAGAS DISPONÍVEIS NO PRENOTAMI!\n\n`;
          message += `👤 Conta: ${config.accountId}\n`;
          message += `📍 Consulado: ${config.consulate}\n`;
          message += `📋 Serviço: ${config.service}\n`;
          message += `📊 Quantidade: ${result.count || "?"}\n`;
          if (result.dates?.length) {
            message += `📅 Datas: ${result.dates.join(", ")}\n`;
          }
          message += `\n🔗 https://prenotami.esteri.it`;

          // Attempt auto-booking if enabled
          if (config.autoBook) {
            const booking = await attemptBooking(page);
            updateHealthStatus(true, true, booking.success);

            if (booking.success) {
              message = `✅ AGENDAMENTO CONFIRMADO!\n\n`;
              message += `👤 Conta: ${config.accountId}\n`;
              message += `📍 Consulado: ${config.consulate}\n`;
              message += `📋 Serviço: ${config.service}\n`;
              if (booking.confirmationCode) message += `🎫 Código: ${booking.confirmationCode}\n`;
              if (booking.date) message += `📅 Data: ${booking.date}\n`;
              if (booking.time) message += `⏰ Horário: ${booking.time}\n`;
              message += `\n🔗 https://prenotami.esteri.it`;

              screenshotPath = await takeScreenshot(page, "booking_success");
            } else {
              message += `\n\n⚠️ Auto-booking tentado mas ${booking.error || "falhou"}`;
              message += `\nAGENDE MANUALMENTE AGORA!`;
            }
          }

          await sendNotification(message, screenshotPath);
        }
      } catch (error) {
        log(LogLevel.ERROR, "Check cycle error", { error: String(error) });
        updateHealthStatus(false);

        // Try to recover with browser restart after several errors
        if (healthStatus.consecutiveErrors >= 5 && healthStatus.consecutiveErrors % 5 === 0) {
          log(LogLevel.WARN, "Multiple errors, restarting browser...");
          try {
            await browserManager.restart();
            page = browserManager.getPage()!;
            await login(page);
            await browserManager.saveSession();
          } catch (e) {
            log(LogLevel.ERROR, "Recovery failed", { error: String(e) });
          }
        }
      }

      if (runOnce) {
        log(LogLevel.INFO, "Single check complete");
        break;
      }

      const interval = getCheckInterval();
      const jitter = interval * 0.1 * Math.random(); // ±10% jitter
      const waitTime = interval + jitter;

      log(LogLevel.DEBUG, `Next check in ${Math.round(waitTime / 1000)}s`);
      await randomDelay(waitTime, waitTime);
    }
  } finally {
    await shutdown();
  }
}

// Run
main().catch((e) => {
  log(LogLevel.ERROR, "Fatal error", { error: String(e) });
  process.exit(1);
});
