import { randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { memoryCoreWorkspaceStateKey, openMemoryCoreStateStore } from "./dreaming-state.js";

export const DREAMING_MAX_WORKSPACES_PER_RUN = 1;
export const DREAMING_PHASES = ["light", "rem", "deep"] as const;
export type DreamingPhase = (typeof DREAMING_PHASES)[number];
const DREAMING_SWEEP_STATE_NAMESPACE = "dreaming-sweep-budget";
const DREAMING_SWEEP_CURSOR_KEY = "cursor";
const DREAMING_SWEEP_LEASE_KEY = "lease";
const DREAMING_SWEEP_LEASE_TTL_MS = 10 * 60_000;
export const DREAMING_SWEEP_LEASE_RENEW_MS = 60_000;

type DreamingWorkspace = { agentId?: string; workspaceDir: string };

type DreamingSweepState =
  | {
      kind: "cursor";
      nextWorkspaceKey: string;
      nextPhase?: DreamingPhase;
      deepGroupKey?: string;
      updatedAtMs: number;
    }
  | { kind: "lease"; token: string; startedAtMs: number };

export type DreamingSweepProgress = {
  nextWorkspaceKey?: string;
  nextPhase: DreamingPhase;
  deepGroupKey?: string;
};

export type DreamingWorkspaceBatchItem = DreamingWorkspace & {
  workspaceKey: string;
  nextWorkspaceKey: string;
};

function openDreamingSweepStore(): PluginStateKeyedStore<DreamingSweepState> {
  return openMemoryCoreStateStore<DreamingSweepState>({
    namespace: DREAMING_SWEEP_STATE_NAMESPACE,
    maxEntries: 2,
    overflowPolicy: "reject-new",
  });
}

export function selectDreamingWorkspaceBatch(params: {
  workspaces: DreamingWorkspace[];
  nextWorkspaceKey?: string;
  limit?: number;
}): DreamingWorkspaceBatchItem[] {
  const ordered = params.workspaces
    .map((workspace) => ({
      ...workspace,
      workspaceKey: memoryCoreWorkspaceStateKey(workspace.workspaceDir),
    }))
    .toSorted((left, right) => left.workspaceKey.localeCompare(right.workspaceKey));
  if (ordered.length === 0) {
    return [];
  }
  const requestedStart = params.nextWorkspaceKey
    ? ordered.findIndex((workspace) => workspace.workspaceKey === params.nextWorkspaceKey)
    : -1;
  const start = Math.max(requestedStart, 0);
  const count = Math.min(
    ordered.length,
    Math.max(0, Math.trunc(params.limit ?? DREAMING_MAX_WORKSPACES_PER_RUN)),
  );
  return Array.from({ length: count }, (_, offset) => {
    const currentIndex = (start + offset) % ordered.length;
    const workspace = ordered[currentIndex];
    const nextWorkspace = ordered[(currentIndex + 1) % ordered.length];
    if (!workspace || !nextWorkspace) {
      throw new Error("memory-core dreaming workspace batch index is out of bounds");
    }
    return {
      ...workspace,
      nextWorkspaceKey: nextWorkspace.workspaceKey,
    };
  });
}

export async function readDreamingSweepCursor(): Promise<string | undefined> {
  const state = await openDreamingSweepStore().lookup(DREAMING_SWEEP_CURSOR_KEY);
  return state?.kind === "cursor" ? state.nextWorkspaceKey : undefined;
}

export async function readDreamingSweepProgress(): Promise<DreamingSweepProgress> {
  const state = await openDreamingSweepStore().lookup(DREAMING_SWEEP_CURSOR_KEY);
  if (state?.kind !== "cursor") {
    return { nextPhase: "light" };
  }
  return {
    nextWorkspaceKey: state.nextWorkspaceKey,
    nextPhase: DREAMING_PHASES.includes(state.nextPhase ?? "light")
      ? (state.nextPhase ?? "light")
      : "light",
    ...(state.deepGroupKey ? { deepGroupKey: state.deepGroupKey } : {}),
  };
}

export async function checkpointDreamingSweep(
  nextWorkspaceKey: string,
  nextPhase: DreamingPhase = "light",
  deepGroupKey?: string,
): Promise<void> {
  await openDreamingSweepStore().register(DREAMING_SWEEP_CURSOR_KEY, {
    kind: "cursor",
    nextWorkspaceKey,
    nextPhase,
    ...(deepGroupKey ? { deepGroupKey } : {}),
    updatedAtMs: Date.now(),
  });
}

export function advanceDreamingSweepProgress(params: {
  phase: DreamingPhase;
  workspaceKey: string;
  nextWorkspaceKey: string;
  nextDeepGroupKey?: string;
}): DreamingSweepProgress & { nextWorkspaceKey: string } {
  if (params.phase === "light") {
    return { nextWorkspaceKey: params.workspaceKey, nextPhase: "rem" };
  }
  if (params.phase === "rem") {
    return { nextWorkspaceKey: params.workspaceKey, nextPhase: "deep" };
  }
  if (params.nextDeepGroupKey) {
    return {
      nextWorkspaceKey: params.workspaceKey,
      nextPhase: "deep",
      deepGroupKey: params.nextDeepGroupKey,
    };
  }
  return { nextWorkspaceKey: params.nextWorkspaceKey, nextPhase: "light" };
}

export async function acquireDreamingSweepLease(): Promise<string | undefined> {
  const token = randomUUID();
  const acquired = await openDreamingSweepStore().registerIfAbsent(
    DREAMING_SWEEP_LEASE_KEY,
    { kind: "lease", token, startedAtMs: Date.now() },
    { ttlMs: DREAMING_SWEEP_LEASE_TTL_MS },
  );
  return acquired ? token : undefined;
}

export async function releaseDreamingSweepLease(token: string): Promise<void> {
  const store = openDreamingSweepStore();
  if (!store.deleteIf) {
    throw new Error("memory-core dreaming lease release requires atomic plugin-state delete");
  }
  await store.deleteIf(
    DREAMING_SWEEP_LEASE_KEY,
    (state) => state.kind === "lease" && state.token === token,
  );
}

export async function renewDreamingSweepLease(token: string): Promise<boolean> {
  const store = openDreamingSweepStore();
  if (!store.update) {
    throw new Error("memory-core dreaming lease renewal requires atomic plugin-state update");
  }
  let ownsLease = false;
  const updated = await store.update(
    DREAMING_SWEEP_LEASE_KEY,
    (state) => {
      if (state?.kind !== "lease" || state.token !== token) {
        return undefined;
      }
      ownsLease = true;
      return { ...state, startedAtMs: Date.now() };
    },
    { ttlMs: DREAMING_SWEEP_LEASE_TTL_MS },
  );
  return updated && ownsLease;
}

export type DreamingSweepLeaseGuard = {
  readonly lost: boolean;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function acquireDreamingSweepLeaseGuard(params: {
  onRenewalFailure: (error: Error) => void;
}): Promise<DreamingSweepLeaseGuard | undefined> {
  const token = await acquireDreamingSweepLease();
  if (!token) {
    return undefined;
  }
  let lost = false;
  let pendingRenewal = Promise.resolve();
  const renewalTimer = setInterval(() => {
    pendingRenewal = pendingRenewal
      .then(async () => {
        if (!(await renewDreamingSweepLease(token))) {
          throw new Error("memory-core dreaming sweep lost its singleton lease");
        }
      })
      .catch((error: unknown) => {
        lost = true;
        params.onRenewalFailure(error instanceof Error ? error : new Error(String(error)));
      });
  }, DREAMING_SWEEP_LEASE_RENEW_MS);
  renewalTimer.unref?.();

  return {
    get lost() {
      return lost;
    },
    async [Symbol.asyncDispose]() {
      clearInterval(renewalTimer);
      await pendingRenewal;
      await releaseDreamingSweepLease(token);
    },
  };
}
