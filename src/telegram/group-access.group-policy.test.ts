import { describe, expect, it } from "vitest";
import type { NormalizedAllowFrom } from "./bot-access.js";
import {
  evaluateTelegramGroupPolicyAccess,
  resolveTelegramRuntimeGroupPolicy,
} from "./group-access.js";

function allow(entries: string[], hasWildcard = false): NormalizedAllowFrom {
  return {
    entries,
    hasWildcard,
    hasEntries: entries.length > 0 || hasWildcard,
    invalidEntries: [],
  };
}

describe("resolveTelegramRuntimeGroupPolicy", () => {
  it("fails closed when channels.telegram is missing and no defaults are set", () => {
    const resolved = resolveTelegramRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open fallback when channels.telegram is configured", () => {
    const resolved = resolveTelegramRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit defaults when provider config is missing", () => {
    const resolved = resolveTelegramRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});

describe("evaluateTelegramGroupPolicyAccess", () => {
  const baseParams = {
    isGroup: true,
    chatId: -1001234567890,
    cfg: { channels: { telegram: {} } },
    telegramCfg: { groupPolicy: "allowlist" as const },
    effectiveGroupAllow: allow([]),
    senderId: "12345",
    senderUsername: "tester",
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    enforcePolicy: true,
    useTopicAndGroupOverrides: false,
    enforceAllowlistAuthorization: true,
    allowEmptyAllowlistEntries: false,
    requireSenderForAllowlistAuthorization: true,
    checkChatAllowlist: false,
  };

  it("returns group-policy-allowlist-empty when allowFrom is undefined/empty", () => {
    const result = evaluateTelegramGroupPolicyAccess(baseParams);

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-empty",
      groupPolicy: "allowlist",
    });
  });

  it("allows message when allowEmptyAllowlistEntries is true (e.g. native commands)", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      ...baseParams,
      allowEmptyAllowlistEntries: true,
      effectiveGroupAllow: allow([]),
    });

    // Empty allowlist + allowEmptyAllowlistEntries=true => isSenderAllowed defaults to allow.
    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("allows message when wildcard is present in allowFrom", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      ...baseParams,
      effectiveGroupAllow: allow([], true),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("allows message when sender is in allowFrom list", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      ...baseParams,
      effectiveGroupAllow: allow(["12345"]),
    });

    expect(result).toEqual({ allowed: true, groupPolicy: "allowlist" });
  });

  it("blocks unauthorized sender even when allowFrom has entries", () => {
    const result = evaluateTelegramGroupPolicyAccess({
      ...baseParams,
      senderId: "99999",
      effectiveGroupAllow: allow(["12345"]),
    });

    expect(result).toEqual({
      allowed: false,
      reason: "group-policy-allowlist-unauthorized",
      groupPolicy: "allowlist",
    });
  });
});
