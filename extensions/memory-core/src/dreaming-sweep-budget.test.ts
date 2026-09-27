import { beforeEach, describe, expect, test, vi } from "vitest";
import { configureMemoryCoreDreamingState, memoryCoreWorkspaceStateKey } from "./dreaming-state.js";
import {
  acquireDreamingSweepLease,
  acquireDreamingSweepLeaseGuard,
  advanceDreamingSweepProgress,
  checkpointDreamingSweep,
  readDreamingSweepCursor,
  readDreamingSweepProgress,
  releaseDreamingSweepLease,
  renewDreamingSweepLease,
  selectDreamingWorkspaceBatch,
} from "./dreaming-sweep-budget.js";

function createStore() {
  const values = new Map<string, unknown>();
  return {
    register: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
    registerIfAbsent: vi.fn(async (key: string, value: unknown) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    }),
    lookup: vi.fn(async (key: string) => values.get(key)),
    delete: vi.fn(async (key: string) => values.delete(key)),
    deleteIf: vi.fn(async (key: string, predicate: (value: unknown) => boolean) => {
      const value = values.get(key);
      if (value === undefined || !predicate(value)) {
        return false;
      }
      values.delete(key);
      return true;
    }),
    update: vi.fn(async (key: string, updateValue: (value: unknown) => unknown) => {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    }),
    consume: vi.fn(),
    entries: vi.fn(async () => []),
    clear: vi.fn(),
  };
}

describe("dreaming sweep budget", () => {
  beforeEach(() => configureMemoryCoreDreamingState(() => createStore() as never));

  test("selects a bounded deterministic batch and resumes round-robin", () => {
    const workspaces = ["/z", "/a", "/m"].map((workspaceDir) => ({ workspaceDir }));
    const orderedKeys = workspaces
      .map(({ workspaceDir }) => memoryCoreWorkspaceStateKey(workspaceDir))
      .toSorted();
    const first = selectDreamingWorkspaceBatch({ workspaces, limit: 2 });
    expect(first.map((item) => item.workspaceKey)).toEqual(orderedKeys.slice(0, 2));

    const resumed = selectDreamingWorkspaceBatch({
      workspaces,
      nextWorkspaceKey: first.at(-1)?.nextWorkspaceKey,
      limit: 2,
    });
    expect(resumed.map((item) => item.workspaceKey)).toEqual([orderedKeys[2], orderedKeys[0]]);
  });

  test("persists cursor checkpoints and enforces one active lease", async () => {
    const store = createStore();
    configureMemoryCoreDreamingState(() => store as never);

    await checkpointDreamingSweep("next-workspace");
    await expect(readDreamingSweepCursor()).resolves.toBe("next-workspace");

    const token = await acquireDreamingSweepLease();
    expect(token).toBeTruthy();
    await expect(acquireDreamingSweepLease()).resolves.toBeUndefined();
    await expect(renewDreamingSweepLease(token ?? "")).resolves.toBe(true);
    await expect(renewDreamingSweepLease("not-the-owner")).resolves.toBe(false);
    await expect(acquireDreamingSweepLease()).resolves.toBeUndefined();
    await releaseDreamingSweepLease(token ?? "");
    await expect(acquireDreamingSweepLease()).resolves.toBeTruthy();
  });

  test("advances one phase at a time and preserves the failed phase until success", async () => {
    const store = createStore();
    configureMemoryCoreDreamingState(() => store as never);
    const workspaces = ["/one", "/two", "/three"].map((workspaceDir) => ({ workspaceDir }));
    const selected = selectDreamingWorkspaceBatch({ workspaces, limit: 1 })[0];
    expect(selected).toBeDefined();
    if (!selected) {
      return;
    }

    // A failed run does not checkpoint, so its default light phase remains selected.
    await expect(readDreamingSweepProgress()).resolves.toEqual({ nextPhase: "light" });

    const afterLight = advanceDreamingSweepProgress({
      phase: "light",
      workspaceKey: selected.workspaceKey,
      nextWorkspaceKey: selected.nextWorkspaceKey,
    });
    await checkpointDreamingSweep(afterLight.nextWorkspaceKey, afterLight.nextPhase);
    await expect(readDreamingSweepProgress()).resolves.toEqual({
      nextWorkspaceKey: selected.workspaceKey,
      nextPhase: "rem",
    });

    const afterRem = advanceDreamingSweepProgress({
      phase: "rem",
      workspaceKey: selected.workspaceKey,
      nextWorkspaceKey: selected.nextWorkspaceKey,
    });
    expect(afterRem).toEqual({ nextWorkspaceKey: selected.workspaceKey, nextPhase: "deep" });

    const afterDeep = advanceDreamingSweepProgress({
      phase: "deep",
      workspaceKey: selected.workspaceKey,
      nextWorkspaceKey: selected.nextWorkspaceKey,
      nextDeepGroupKey: "project-two",
    });
    expect(afterDeep).toEqual({
      nextWorkspaceKey: selected.workspaceKey,
      nextPhase: "deep",
      deepGroupKey: "project-two",
    });

    const afterLastDeepGroup = advanceDreamingSweepProgress({
      phase: "deep",
      workspaceKey: selected.workspaceKey,
      nextWorkspaceKey: selected.nextWorkspaceKey,
    });
    expect(afterLastDeepGroup).toEqual({
      nextWorkspaceKey: selected.nextWorkspaceKey,
      nextPhase: "light",
    });
  });

  test("marks a renewable guard lost when atomic ownership disappears", async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      configureMemoryCoreDreamingState(() => store as never);
      const onRenewalFailure = vi.fn();
      const guard = await acquireDreamingSweepLeaseGuard({ onRenewalFailure });
      expect(guard).toBeDefined();
      await store.delete("lease");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(guard?.lost).toBe(true);
      expect(onRenewalFailure).toHaveBeenCalledOnce();
      await guard?.[Symbol.asyncDispose]();
    } finally {
      vi.useRealTimers();
    }
  });
});
