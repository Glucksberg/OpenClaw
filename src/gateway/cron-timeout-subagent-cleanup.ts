import { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
import {
  isSubagentSessionRunActive,
  listSubagentRunsForController,
} from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type CronTimeoutSubagentCleanupDeps = {
  listRuns: (controllerSessionKey: string) => SubagentRunRecord[];
  isActive: (childSessionKey: string) => boolean;
  kill: typeof killSubagentRunAdmin;
};

const defaultDeps: CronTimeoutSubagentCleanupDeps = {
  listRuns: listSubagentRunsForController,
  isActive: isSubagentSessionRunActive,
  kill: killSubagentRunAdmin,
};

export type CronTimeoutSubagentCleanupResult = {
  requested: number;
  killed: number;
  remaining: string[];
  errors: string[];
  drained: boolean;
};

/** Cancels direct child runs of a timed-out cron session; each admin kill cascades descendants. */
export async function cancelTimedOutCronSubagents(params: {
  cfg: OpenClawConfig;
  controllerSessionKey: string;
  deps?: CronTimeoutSubagentCleanupDeps;
}): Promise<CronTimeoutSubagentCleanupResult> {
  const deps = params.deps ?? defaultDeps;
  const childSessionKeys = [
    ...new Set(
      deps
        .listRuns(params.controllerSessionKey)
        .map((entry) => entry.childSessionKey)
        .filter((sessionKey) => deps.isActive(sessionKey)),
    ),
  ];
  const results = await Promise.allSettled(
    childSessionKeys.map((sessionKey) => deps.kill({ cfg: params.cfg, sessionKey })),
  );
  let killed = 0;
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(String(result.reason));
      continue;
    }
    if (result.value.killed) {
      killed += 1;
    }
    if ("error" in result.value && result.value.error) {
      errors.push(String(result.value.error));
    }
  }
  const remaining = childSessionKeys.filter((sessionKey) => deps.isActive(sessionKey));
  return {
    requested: childSessionKeys.length,
    killed,
    remaining,
    errors,
    drained: remaining.length === 0,
  };
}
