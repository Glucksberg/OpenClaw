import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

type TestAccount = { enabled: boolean };

const hoisted = vi.hoisted(() => {
  const startAccount = vi.fn();
  const stopAccount = vi.fn(async () => {});
  const computeBackoff = vi.fn((_policy: unknown, attempt: number) => attempt * 100);
  const sleepWithAbort = vi.fn(async (_ms: number, abortSignal?: AbortSignal) => {
    if (abortSignal?.aborted) {
      throw new Error("aborted");
    }
  });
  const resetDirectoryCache = vi.fn();

  const plugin: ChannelPlugin<TestAccount> = {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isEnabled: (account) => account.enabled,
      isConfigured: async () => true,
    },
    gateway: {
      startAccount: (ctx) => startAccount(ctx),
      stopAccount: (ctx) => stopAccount(ctx),
    },
  };

  return {
    startAccount,
    stopAccount,
    computeBackoff,
    sleepWithAbort,
    resetDirectoryCache,
    plugin,
  };
});

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (id: string) => (id === hoisted.plugin.id ? hoisted.plugin : undefined),
  listChannelPlugins: () => [hoisted.plugin],
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: (policy: unknown, attempt: number) => hoisted.computeBackoff(policy, attempt),
  sleepWithAbort: (ms: number, abortSignal?: AbortSignal) =>
    hoisted.sleepWithAbort(ms, abortSignal),
}));

vi.mock("../infra/outbound/target-resolver.js", () => ({
  resetDirectoryCache: (...args: unknown[]) => hoisted.resetDirectoryCache(...args),
}));

function waitForAbort(abortSignal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createManager() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: (() => {
      throw new Error("exit");
    }) as RuntimeEnv["exit"],
  };
  const cfg = {
    channels: {
      telegram: {},
    },
  } as OpenClawConfig;

  const manager = createChannelManager({
    loadConfig: () => cfg,
    channelLogs: {
      telegram: log,
    } as unknown as Record<string, typeof log>,
    channelRuntimeEnvs: {
      telegram: runtime,
    } as unknown as Record<string, RuntimeEnv>,
  });

  return { manager, log };
}

describe("createChannelManager", () => {
  beforeEach(() => {
    hoisted.startAccount.mockReset();
    hoisted.stopAccount.mockReset();
    hoisted.computeBackoff.mockReset();
    hoisted.computeBackoff.mockImplementation((_policy: unknown, attempt: number) => attempt * 100);
    hoisted.sleepWithAbort.mockReset();
    hoisted.sleepWithAbort.mockImplementation(async (_ms: number, abortSignal?: AbortSignal) => {
      if (abortSignal?.aborted) {
        throw new Error("aborted");
      }
    });
    hoisted.resetDirectoryCache.mockReset();
  });

  it("auto-restarts channel task after unexpected exit", async () => {
    const { manager, log } = createManager();
    hoisted.startAccount
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce((ctx: { abortSignal: AbortSignal }) => waitForAbort(ctx.abortSignal));

    await manager.startChannel("telegram");
    await vi.waitFor(() => {
      expect(hoisted.startAccount).toHaveBeenCalledTimes(2);
    });

    expect(hoisted.computeBackoff).toHaveBeenCalledWith(expect.any(Object), 1);
    expect(hoisted.sleepWithAbort).toHaveBeenCalledWith(100, expect.any(AbortSignal));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("channel exited unexpectedly; restarting in 100ms (attempt 1)"),
    );

    await manager.stopChannel("telegram");
  });

  it("does not auto-restart when channel is intentionally stopped", async () => {
    const { manager } = createManager();
    hoisted.startAccount.mockImplementation((ctx: { abortSignal: AbortSignal }) =>
      waitForAbort(ctx.abortSignal),
    );

    await manager.startChannel("telegram");
    await vi.waitFor(() => {
      expect(hoisted.startAccount).toHaveBeenCalledTimes(1);
    });

    await manager.stopChannel("telegram");

    expect(hoisted.startAccount).toHaveBeenCalledTimes(1);
    expect(hoisted.computeBackoff).not.toHaveBeenCalled();
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("uses exponential retry attempts for repeated unexpected exits", async () => {
    const { manager } = createManager();
    let runCount = 0;
    hoisted.startAccount.mockImplementation((ctx: { abortSignal: AbortSignal }) => {
      runCount += 1;
      if (runCount <= 3) {
        return Promise.reject(new Error(`boom-${runCount}`));
      }
      return waitForAbort(ctx.abortSignal);
    });

    await manager.startChannel("telegram");
    await vi.waitFor(() => {
      expect(hoisted.startAccount).toHaveBeenCalledTimes(4);
    });

    expect(hoisted.computeBackoff.mock.calls.map(([, attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(hoisted.sleepWithAbort.mock.calls.map(([delayMs]) => delayMs)).toEqual([100, 200, 300]);

    await manager.stopChannel("telegram");
  });
});
