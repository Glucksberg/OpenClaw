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
    const kill = vi.fn(async (runs: SubagentRunRecord[]) => {
      for (const entry of runs) {
        active.delete(entry.childSessionKey);
      }
      return { killed: runs.length };
    });

    const result = await cancelTimedOutCronSubagents({
      cfg: {},
      controllerSessionKey: "agent:main:cron:job",
      deps: {
        listRuns: () => [run("child-a"), run("child-a"), run("child-b"), run("finished")],
        isActive: (entry) => active.has(entry.childSessionKey),
        kill,
      },
    });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ requested: 2, killed: 2, remaining: [], errors: [], drained: true });
  });

  it("reports children that remain active after cancellation", async () => {
    const result = await cancelTimedOutCronSubagents({
      cfg: {},
      controllerSessionKey: "agent:main:cron:job",
      deps: {
        listRuns: () => [run("child-a")],
        isActive: () => true,
        kill: vi.fn(async () => ({ killed: 0, error: "busy" })),
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

  it("does not retarget a stale child entry after its session key is reused", async () => {
    const stale = run("shared-child");
    const replacement = {
      ...run("shared-child"),
      runId: "replacement-run",
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: "agent:main:other-controller",
      createdAt: 2,
    };
    const kill = vi.fn(async () => ({ killed: 0 }));

    const result = await cancelTimedOutCronSubagents({
      cfg: {},
      controllerSessionKey: "agent:main:cron:job",
      deps: {
        listRuns: () => [stale],
        isActive: (entry) => entry === replacement,
        kill,
      },
    });

    expect(kill).not.toHaveBeenCalled();
    expect(result).toEqual({ requested: 0, killed: 0, remaining: [], errors: [], drained: true });
  });
});
