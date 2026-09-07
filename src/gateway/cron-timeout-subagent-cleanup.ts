import { isSameSubagentRunGeneration } from "../agents/subagents/registry/subagent-control-scope.js";
import {
  killAllControlledSubagentRuns,
  resolveSubagentController,
} from "../agents/subagents/registry/subagent-control.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentSessionRunActive,
  listSubagentRunsForController,
} from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type CronTimeoutSubagentCleanupDeps = {
  listRuns: (controllerSessionKey: string) => SubagentRunRecord[];
  isActive: (entry: SubagentRunRecord) => boolean;
  kill: (runs: SubagentRunRecord[]) => Promise<{ killed: number; error?: string }>;
};

type CronTimeoutSubagentCleanupResult = {
  requested: number;
  killed: number;
  remaining: string[];
  errors: string[];
  drained: boolean;
};

function subagentRunGenerationKey(entry: SubagentRunRecord): string {
  return `${entry.childSessionKey}\0${entry.runId}\0${entry.generation ?? ""}\0${entry.createdAt}`;
}

/** Cancels exact direct-child generations of a timed-out cron session and their descendants. */
export async function cancelTimedOutCronSubagents(params: {
  cfg: OpenClawConfig;
  controllerSessionKey: string;
  deps?: CronTimeoutSubagentCleanupDeps;
}): Promise<CronTimeoutSubagentCleanupResult> {
  const controller = resolveSubagentController({
    cfg: params.cfg,
    agentSessionKey: params.controllerSessionKey,
  });
  const deps: CronTimeoutSubagentCleanupDeps =
    params.deps ??
    ({
      listRuns: listSubagentRunsForController,
      isActive: (entry) => {
        const latest = getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey);
        return (
          isSubagentSessionRunActive(entry.childSessionKey) &&
          latest !== null &&
          isSameSubagentRunGeneration(latest, entry)
        );
      },
      kill: async (runs) => {
        const result = await killAllControlledSubagentRuns({
          cfg: params.cfg,
          controller,
          runs,
          suppressTaskDelivery: true,
        });
        return {
          killed: result.killed,
          ...(result.status !== "ok" ? { error: result.error } : {}),
        };
      },
    } satisfies CronTimeoutSubagentCleanupDeps);

  const activeRunsByGeneration = new Map<string, SubagentRunRecord>();
  for (const entry of deps.listRuns(params.controllerSessionKey)) {
    if (deps.isActive(entry)) {
      activeRunsByGeneration.set(subagentRunGenerationKey(entry), entry);
    }
  }
  const activeRuns = [...activeRunsByGeneration.values()];
  let killed = 0;
  const errors: string[] = [];
  if (activeRuns.length > 0) {
    try {
      const result = await deps.kill(activeRuns);
      killed += result.killed;
      if (result.error) {
        errors.push(result.error);
      }
    } catch (error) {
      errors.push(String(error));
    }
  }
  const remaining = [
    ...new Set(
      deps
        .listRuns(params.controllerSessionKey)
        .filter((entry) => deps.isActive(entry))
        .map((entry) => entry.childSessionKey),
    ),
  ];
  return {
    requested: activeRuns.length,
    killed,
    remaining,
    errors,
    drained: remaining.length === 0,
  };
}
