import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { handleAgentEnd } from "./pi-embedded-subscribe.handlers.lifecycle.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void;
    hookRunner?: EmbeddedPiSubscribeContext["hookRunner"];
    sessionMessages?: unknown[];
  },
): EmbeddedPiSubscribeContext {
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
      session: { messages: overrides?.sessionMessages ?? [] },
      hookAgentId: "test-agent",
      sessionId: "session-1",
      workspaceDir: "/tmp/workspace",
      messageProvider: "telegram",
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedPiSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      blockState: {
        thinking: true,
        final: true,
        inlineCode: createInlineCodeState(),
      },
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    hookRunner: overrides?.hookRunner,
    flushBlockReplyBuffer: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedPiSubscribeContext;
}

describe("handleAgentEnd", () => {
  it("logs the resolved error message when run ends with assistant error", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    handleAgentEnd(ctx);

    const warn = vi.mocked(ctx.log.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("runId=run-1");
    expect(warn.mock.calls[0]?.[0]).toContain("error=connection refused");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "connection refused",
      },
    });
  });

  it("keeps non-error run-end logging on debug only", () => {
    const ctx = createContext(undefined);

    handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });

  it("fires agent_end plugin hook when hookRunner has hooks", () => {
    const runAgentEnd = vi.fn().mockResolvedValue(undefined);
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAgentEnd,
    };
    const sessionMessages = [{ role: "user", content: "hello" }];
    const ctx = createContext(undefined, {
      hookRunner: hookRunner as unknown as EmbeddedPiSubscribeContext["hookRunner"],
      sessionMessages,
    });

    handleAgentEnd(ctx);

    expect(hookRunner.hasHooks).toHaveBeenCalledWith("agent_end");
    expect(runAgentEnd).toHaveBeenCalledWith(
      {
        messages: sessionMessages,
        success: true,
        error: undefined,
      },
      {
        agentId: "test-agent",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        workspaceDir: "/tmp/workspace",
        messageProvider: "telegram",
      },
    );
    expect(ctx.state.agentEndHookFired).toBe(true);
  });

  it("passes error text to agent_end hook on error", () => {
    const runAgentEnd = vi.fn().mockResolvedValue(undefined);
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAgentEnd,
    };
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      {
        hookRunner: hookRunner as unknown as EmbeddedPiSubscribeContext["hookRunner"],
        sessionMessages: [],
      },
    );

    handleAgentEnd(ctx);

    expect(runAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "connection refused",
      }),
      expect.any(Object),
    );
  });

  it("does not fire agent_end hook when hookRunner has no hooks", () => {
    const runAgentEnd = vi.fn().mockResolvedValue(undefined);
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(false),
      runAgentEnd,
    };
    const ctx = createContext(undefined, {
      hookRunner: hookRunner as unknown as EmbeddedPiSubscribeContext["hookRunner"],
    });

    handleAgentEnd(ctx);

    expect(runAgentEnd).not.toHaveBeenCalled();
    expect(ctx.state.agentEndHookFired).toBeUndefined();
  });

  it("does not fire agent_end hook when no hookRunner is provided", () => {
    const ctx = createContext(undefined);

    handleAgentEnd(ctx);

    // Should complete without error and not set the flag
    expect(ctx.state.agentEndHookFired).toBeUndefined();
  });

  it("logs warning if agent_end hook rejects", async () => {
    const runAgentEnd = vi.fn().mockRejectedValue(new Error("plugin crash"));
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAgentEnd,
    };
    const ctx = createContext(undefined, {
      hookRunner: hookRunner as unknown as EmbeddedPiSubscribeContext["hookRunner"],
    });

    handleAgentEnd(ctx);

    // Wait for the async catch handler to run
    await vi.waitFor(() => {
      expect(ctx.log.warn).toHaveBeenCalledWith(
        "agent_end hook failed (streaming): Error: plugin crash",
      );
    });
  });
});
