import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveAgentMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveStorePath: vi.fn(() => "/tmp/session-store.json"),
}));

vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: vi.fn().mockResolvedValue({ channel: "telegram" }),
}));

import { loadSessionStore } from "../../config/sessions.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveDeliveryTarget", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
  });

  it("falls back to bound accountId when session has no lastAccountId", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBe("account-b");
  });

  it("preserves session lastAccountId when present", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:main": {
        sessionId: "sess-1",
        updatedAt: 1000,
        lastChannel: "telegram",
        lastTo: "123456",
        lastAccountId: "session-account",
      },
    });

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    // Session-derived accountId should take precedence over binding
    expect(result.accountId).toBe("session-account");
  });

  it("returns undefined accountId when no binding and no session", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({ bindings: [] });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBeUndefined();
  });

  it("selects correct binding when multiple agents have bindings", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-a",
          match: { channel: "telegram", accountId: "account-a" },
        },
        {
          agentId: "agent-b",
          match: { channel: "telegram", accountId: "account-b" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBe("account-b");
  });

  it("ignores bindings for different channels", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});

    const cfg = makeCfg({
      bindings: [
        {
          agentId: "agent-b",
          match: { channel: "discord", accountId: "discord-account" },
        },
      ],
    });

    const result = await resolveDeliveryTarget(cfg, "agent-b", {
      channel: "telegram",
      to: "123456",
    });

    expect(result.accountId).toBeUndefined();
  });

  it("keeps telegram topic thread ids for explicit announce targets", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "-1001111111111:topic:999",
        lastThreadId: 999,
      },
    });

    const resolved = await resolveDeliveryTarget({} as OpenClawConfig, "main", {
      channel: "telegram",
      to: "-1001234567890:topic:123",
    });

    expect(resolved.channel).toBe("telegram");
    expect(resolved.to).toBe("-1001234567890:topic:123");
    expect(resolved.threadId).toBe(123);
  });
});
