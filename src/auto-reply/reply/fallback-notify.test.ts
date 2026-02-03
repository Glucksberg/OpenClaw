import { describe, expect, it } from "vitest";
import { checkFallbackNotification } from "./fallback-notify.js";

describe("checkFallbackNotification", () => {
  it("returns undefined when no attempts (primary succeeded)", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-1",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "openai",
      usedModel: "gpt-4.1-mini",
      attempts: [],
    });
    expect(result).toBeUndefined();
  });

  it("returns a notification when fallback model is used", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-2",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          error: "rate limited",
          reason: "rate_limit",
        },
      ],
    });
    expect(result).toBeDefined();
    expect(result).toContain("anthropic/claude-haiku-3-5");
    expect(result).toContain("openai/gpt-4.1-mini");
    expect(result).toContain("rate_limit");
  });

  it("suppresses duplicate notifications for the same fallback", () => {
    const sessionKey = "test-session-3";
    const params = {
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          error: "rate limited",
          reason: "rate_limit" as const,
        },
      ],
    };

    // First call should notify
    const first = checkFallbackNotification(params);
    expect(first).toBeDefined();

    // Second call with same fallback should be suppressed
    const second = checkFallbackNotification(params);
    expect(second).toBeUndefined();
  });

  it("clears tracker when primary succeeds again", () => {
    const sessionKey = "test-session-4";

    // Fallback used — should notify
    const first = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(first).toBeDefined();

    // Primary recovers — clears tracker
    checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "openai",
      usedModel: "gpt-4.1-mini",
      attempts: [],
    });

    // Fallback again — should notify again (new failover event)
    const third = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(third).toBeDefined();
  });

  it("notifies again when fallback model changes", () => {
    const sessionKey = "test-session-5";

    // First fallback
    const first = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(first).toBeDefined();
    expect(first).toContain("claude-haiku-3-5");

    // Different fallback model — should notify again
    const second = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "google",
      usedModel: "gemini-2.5-flash",
      attempts: [
        { provider: "openai", model: "gpt-4.1-mini", error: "rate limited" },
        { provider: "anthropic", model: "claude-haiku-3-5", error: "also rate limited" },
      ],
    });
    expect(second).toBeDefined();
    expect(second).toContain("gemini-2.5-flash");
  });

  it("returns undefined when used model matches original despite attempts", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-6",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "openai",
      usedModel: "gpt-4.1-mini",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "transient error" }],
    });
    expect(result).toBeUndefined();
  });

  it("works without a session key", () => {
    const result = checkFallbackNotification({
      sessionKey: undefined,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(result).toBeDefined();
  });

  it("includes reason from the primary attempt when available", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-7",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          error: "billing error",
          reason: "billing",
        },
      ],
    });
    expect(result).toContain("billing");
  });

  it("omits reason when not available on primary attempt", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-8",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "unknown error" }],
    });
    expect(result).toBeDefined();
    expect(result).not.toContain("(undefined)");
  });
});
