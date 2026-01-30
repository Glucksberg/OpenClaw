/**
 * Prenotami Monitor - Unit Tests
 * 
 * Run with: npx tsx --test monitor.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as crypto from "crypto";

// ============================================================================
// Test Helpers - Isolated implementations for testing
// ============================================================================

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface EncryptedSession {
  salt: string;
  iv: string;
  data: string;
  tag: string;
  savedAt: number;
  expiresAt: number;
}

function encryptSession(data: string, key: string): string {
  if (!key) return data;

  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(key, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
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

function decryptSession(encrypted: string, key: string): string | null {
  if (!key) return encrypted;

  try {
    const session: EncryptedSession = JSON.parse(encrypted);

    if (Date.now() > session.expiresAt) {
      return null;
    }

    const salt = Buffer.from(session.salt, "base64");
    const derivedKey = crypto.scryptSync(key, salt, 32);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      derivedKey,
      Buffer.from(session.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(session.tag, "base64"));
    const decrypted =
      decipher.update(Buffer.from(session.data, "base64")) + decipher.final("utf8");

    return decrypted;
  } catch {
    return null;
  }
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function getCheckInterval(hour: number, day: number, config: { active: number; normal: number; idle: number }): number {
  // Active: Monday (1) or Wednesday (3) 10:00-12:00 BRT
  if ((day === 1 || day === 3) && hour >= 10 && hour <= 12) {
    return config.active;
  }

  // Idle: Late night 23:00-07:00 BRT
  if (hour >= 23 || hour < 7) {
    return config.idle;
  }

  return config.normal;
}

// ============================================================================
// Tests
// ============================================================================

describe("Session Encryption", () => {
  const testKey = "a".repeat(64); // 64 hex chars = 32 bytes
  const testData = JSON.stringify({ cookies: [], origins: [] });

  it("should encrypt and decrypt data correctly", () => {
    const encrypted = encryptSession(testData, testKey);
    const decrypted = decryptSession(encrypted, testKey);
    
    assert.strictEqual(decrypted, testData);
  });

  it("should produce different ciphertext each time (random salt/iv)", () => {
    const encrypted1 = encryptSession(testData, testKey);
    const encrypted2 = encryptSession(testData, testKey);
    
    assert.notStrictEqual(encrypted1, encrypted2);
  });

  it("should fail decryption with wrong key", () => {
    const encrypted = encryptSession(testData, testKey);
    const wrongKey = "b".repeat(64);
    const decrypted = decryptSession(encrypted, wrongKey);
    
    assert.strictEqual(decrypted, null);
  });

  it("should return original data when no key provided", () => {
    const encrypted = encryptSession(testData, "");
    assert.strictEqual(encrypted, testData);
    
    const decrypted = decryptSession(testData, "");
    assert.strictEqual(decrypted, testData);
  });

  it("should reject expired sessions", () => {
    const encrypted = encryptSession(testData, testKey);
    const parsed: EncryptedSession = JSON.parse(encrypted);
    
    // Set expiry in the past
    parsed.expiresAt = Date.now() - 1000;
    
    const decrypted = decryptSession(JSON.stringify(parsed), testKey);
    assert.strictEqual(decrypted, null);
  });

  it("should reject tampered data", () => {
    const encrypted = encryptSession(testData, testKey);
    const parsed: EncryptedSession = JSON.parse(encrypted);
    
    // Tamper with the data
    const tamperedData = Buffer.from(parsed.data, "base64");
    tamperedData[0] ^= 0xff;
    parsed.data = tamperedData.toString("base64");
    
    const decrypted = decryptSession(JSON.stringify(parsed), testKey);
    assert.strictEqual(decrypted, null);
  });
});

describe("Email Validation", () => {
  it("should accept valid emails", () => {
    assert.strictEqual(validateEmail("test@example.com"), true);
    assert.strictEqual(validateEmail("user.name@domain.org"), true);
    assert.strictEqual(validateEmail("user+tag@example.co.uk"), true);
  });

  it("should reject invalid emails", () => {
    assert.strictEqual(validateEmail(""), false);
    assert.strictEqual(validateEmail("notanemail"), false);
    assert.strictEqual(validateEmail("missing@domain"), false);
    assert.strictEqual(validateEmail("@nodomain.com"), false);
    assert.strictEqual(validateEmail("spaces in@email.com"), false);
  });
});

describe("Check Interval Logic", () => {
  const config = {
    active: 5000,
    normal: 300000,
    idle: 1800000,
  };

  it("should return active interval on Monday 11:00", () => {
    const interval = getCheckInterval(11, 1, config);
    assert.strictEqual(interval, config.active);
  });

  it("should return active interval on Wednesday 10:00", () => {
    const interval = getCheckInterval(10, 3, config);
    assert.strictEqual(interval, config.active);
  });

  it("should return idle interval at 2:00 AM", () => {
    const interval = getCheckInterval(2, 2, config);
    assert.strictEqual(interval, config.idle);
  });

  it("should return idle interval at 23:30", () => {
    const interval = getCheckInterval(23, 4, config);
    assert.strictEqual(interval, config.idle);
  });

  it("should return normal interval on Tuesday 15:00", () => {
    const interval = getCheckInterval(15, 2, config);
    assert.strictEqual(interval, config.normal);
  });

  it("should return normal interval on Monday 15:00 (outside active window)", () => {
    const interval = getCheckInterval(15, 1, config);
    assert.strictEqual(interval, config.normal);
  });
});

describe("Proxy Rotation", () => {
  it("should rotate through proxies", () => {
    const proxies = ["proxy1", "proxy2", "proxy3"];
    let currentIndex = 0;

    function getNextProxy(): string {
      currentIndex = (currentIndex + 1) % proxies.length;
      return proxies[currentIndex];
    }

    assert.strictEqual(getNextProxy(), "proxy2");
    assert.strictEqual(getNextProxy(), "proxy3");
    assert.strictEqual(getNextProxy(), "proxy1");
    assert.strictEqual(getNextProxy(), "proxy2");
  });
});

// Run tests
console.log("Running Prenotami Monitor unit tests...\n");
