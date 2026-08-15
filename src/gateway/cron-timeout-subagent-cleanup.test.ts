import { describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { cancelTimedOutCronSubagents } from "./cron-timeout-subagent-cleanup.js";

function run(childSessionKey: string): SubagentRunRecord {
  return {
    runId: `run-${childSessionKey}`,
    childSessionKey,
    controllerSessionKey: "agent:main:cron:job",
    requesterSessionKey: "agent:main:cron:job",
    requesterDisplayKey: "cron",
    task: "work",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running" },
  };
}

describe("cancelTimedOutCronSubagents", () => {
  it("kills each active direct child once and reports a drained tree", async () => {
    const active = new Set(["child-a", "child-b"]);
    const kill = vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
      active.delete(sessionKey);
      return { found: true as const, killed: true };
    });

    const result = await cancelTimedOutCronSubagents({
      cfg: {},
      controllerSessionKey: "agent:main:cron:job",
      deps: {
        listRuns: () => [run("child-a"), run("child-a"), run("child-b"), run("finished")],
        isActive: (sessionKey) => active.has(sessionKey),
        kill,
      },
    });

    expect(kill).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ requested: 2, killed: 2, remaining: [], errors: [], drained: true });
  });

  it("reports children that remain active after cancellation", async () => {
    const result = await cancelTimedOutCronSubagents({
      cfg: {},
      controllerSessionKey: "agent:main:cron:job",
      deps: {
        listRuns: () => [run("child-a")],
        isActive: () => true,
        kill: vi.fn(async () => ({ found: true as const, killed: false, error: "busy" })),
      },
    });

    expect(result).toEqual({
      requested: 1,
      killed: 0,
      remaining: ["child-a"],
      errors: ["busy"],
      drained: false,
    });
  });
});
