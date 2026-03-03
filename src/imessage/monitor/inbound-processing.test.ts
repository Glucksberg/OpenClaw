import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

describe("resolveIMessageInboundDecision echo detection", () => {
  const cfg = {} as OpenClawConfig;

  it("drops inbound messages when outbound message id matches echo cache", () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.messageId === "42";
    });

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: 42,
        sender: "+15555550123",
        text: "Reasoning:\n_step_",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "Reasoning:\n_step_",
      bodyText: "Reasoning:\n_step_",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: { has: echoHas },
      logVerbose: undefined,
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenCalledWith(
      "default:imessage:+15555550123",
      expect.objectContaining({
        text: "Reasoning:\n_step_",
        messageId: "42",
      }),
    );
  });
});

describe("describeIMessageEchoDropLog", () => {
  it("includes message id when available", () => {
    expect(
      describeIMessageEchoDropLog({
        messageText: "Reasoning:\n_step_",
        messageId: "abc-123",
      }),
    ).toContain("id=abc-123");
  });
});

describe("resolveIMessageInboundDecision command auth", () => {
  const cfg = {} as OpenClawConfig;
  const resolveDmCommandDecision = (params: { messageId: number; storeAllowFrom: string[] }) =>
    resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: {
        id: params.messageId,
        sender: "+15555550123",
        text: "/status",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "/status",
      bodyText: "/status",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: params.storeAllowFrom,
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const decision = resolveDmCommandDecision({
      messageId: 100,
      storeAllowFrom: [],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(false);
  });

  it("authorizes DM commands for senders in pairing-store allowlist", () => {
    const decision = resolveDmCommandDecision({
      messageId: 101,
      storeAllowFrom: ["+15555550123"],
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
  });
});

describe("resolveIMessageInboundDecision group allowlist bypass (is_group=false)", () => {
  // Config with group allowlist: only chat_id "3" is allowed; "5" is excluded.
  const cfgWithGroupAllowlist: OpenClawConfig = {
    channels: {
      imessage: {
        groups: {
          "3": {},
        },
      },
    },
  } as unknown as OpenClawConfig;

  it("blocks real group message (is_group=true) whose chat_id is not in allowlist", () => {
    const logVerbose = vi.fn();
    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithGroupAllowlist,
      accountId: "default",
      message: {
        id: 200,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: true,
        chat_id: 5,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose,
    });

    expect(decision).toEqual({ kind: "drop", reason: "group id not in allowlist" });
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("pre-isGroup enforcement"));
  });

  it("does not block DM (is_group=false) with a chat_id not in the group allowlist", () => {
    // A DM may carry a chat_id but should never be rejected by the group allowlist guard.
    const logVerbose = vi.fn();
    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithGroupAllowlist,
      accountId: "default",
      message: {
        id: 201,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: false,
        chat_id: 5,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose,
    });

    expect(decision.kind).toBe("dispatch");
    expect(logVerbose).not.toHaveBeenCalledWith(expect.stringContaining("pre-isGroup enforcement"));
  });

  it("does not block DM (is_group=null) with a chat_id not in the group allowlist", () => {
    // null/undefined is_group must not trigger the group allowlist guard.
    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithGroupAllowlist,
      accountId: "default",
      message: {
        id: 201,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: null as unknown as boolean,
        chat_id: 5,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not block DM when groupPolicy is disabled (guard must not fire for non-group messages)", () => {
    const cfgWithDisabledGroupPolicy: OpenClawConfig = {
      channels: {
        imessage: {
          groupPolicy: "disabled",
          groups: {
            "3": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithDisabledGroupPolicy,
      accountId: "default",
      message: {
        id: 205,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: false,
        chat_id: 5,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("allows message from an allowed group when is_group=false", () => {
    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithGroupAllowlist,
      accountId: "default",
      message: {
        id: 202,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: false,
        chat_id: 3,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("allows DMs without chat_id (no false positive blocking)", () => {
    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithGroupAllowlist,
      accountId: "default",
      message: {
        id: 203,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: false,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("allows all groups when wildcard (*) is configured", () => {
    const cfgWithWildcard: OpenClawConfig = {
      channels: {
        imessage: {
          groups: {
            "*": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const decision = resolveIMessageInboundDecision({
      cfg: cfgWithWildcard,
      accountId: "default",
      message: {
        id: 204,
        sender: "thomas@fraley.me",
        text: "hello",
        is_from_me: false,
        is_group: false,
        chat_id: 99,
      },
      opts: undefined,
      messageText: "hello",
      bodyText: "hello",
      allowFrom: ["thomas@fraley.me"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision.kind).toBe("dispatch");
  });
});
