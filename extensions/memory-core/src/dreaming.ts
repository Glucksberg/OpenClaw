import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMemoryDreamingPluginConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT as DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { probeDreamingAdmission } from "./dreaming-admission.js";
import {
  type CronServiceLike,
  reconcileShortTermDreamingCronJob,
  resolveCronServiceFromGatewayContext,
} from "./dreaming-cron.js";
import { selectDeepPromotionGroup } from "./dreaming-deep-budget.js";
import { appendFailedDreamingEvent } from "./dreaming-events.js";
import {
  formatErrorMessage,
  formatRecallRepairDetails,
  includesSystemEventToken,
} from "./dreaming-shared.js";
import {
  acquireDreamingSweepLeaseGuard,
  advanceDreamingSweepProgress,
  checkpointDreamingSweep,
  DREAMING_MAX_WORKSPACES_PER_RUN,
  readDreamingSweepProgress,
  selectDreamingWorkspaceBatch,
} from "./dreaming-sweep-budget.js";
import { resolveMemoryPromotionFileMaxChars } from "./memory-budget.js";

const RUNTIME_CRON_RECONCILE_INTERVAL_MS = 60_000;
const HEARTBEAT_ISOLATED_SESSION_SUFFIX = ":heartbeat";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type ShortTermPromotionDreamingConfig = ReturnType<typeof resolveMemoryDeepDreamingConfig>;

function formatRepairSummary(repair: {
  rewroteStore: boolean;
  removedInvalidEntries: number;
  removedDanglingEntries?: number;
  removedOverflowEntries?: number;
  removedStaleLock: boolean;
}): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    const details = formatRecallRepairDetails(repair);
    actions.push(`rewrote recall store${details ? ` (${details})` : ""}`);
  }
  if (repair.removedStaleLock) {
    actions.push("removed stale promotion lock");
  }
  return actions.join(", ");
}

function resolveDreamingTriggerSessionKeys(sessionKey?: string): string[] {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return [];
  }

  const keys = [normalized];
  // Isolated heartbeat runs execute in a sibling `:heartbeat` session while cron
  // system events stay queued on the base main session.
  if (normalized.endsWith(HEARTBEAT_ISOLATED_SESSION_SUFFIX)) {
    const baseSessionKey = normalized.slice(0, -HEARTBEAT_ISOLATED_SESSION_SUFFIX.length).trim();
    if (baseSessionKey) {
      keys.push(baseSessionKey);
    }
  }

  return uniqueStrings(keys);
}

function hasPendingManagedDreamingCronEvent(sessionKey?: string, agentId?: string): boolean {
  return resolveDreamingTriggerSessionKeys(sessionKey).some((candidateSessionKey) =>
    peekSystemEventEntries(candidateSessionKey, agentId).some(
      (event) =>
        event.contextKey?.startsWith("cron:") === true &&
        normalizeOptionalString(event.text) === DREAMING_SYSTEM_EVENT_TEXT,
    ),
  );
}

async function runShortTermDreamingPromotionIfTriggered(params: {
  cleanedBody: string;
  trigger?: string;
  /** Agent whose heartbeat/cron turn triggered the sweep. */
  agentId?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
  subagent?: OpenClawPluginApi["runtime"]["subagent"];
}): Promise<{ handled: true; reason: string } | undefined> {
  if (params.trigger !== "heartbeat" && params.trigger !== "cron") {
    return undefined;
  }
  if (!includesSystemEventToken(params.cleanedBody, DREAMING_SYSTEM_EVENT_TEXT)) {
    return undefined;
  }
  if (!params.config.enabled) {
    return { handled: true, reason: "memory-core: short-term dreaming disabled" };
  }

  const recencyHalfLifeDays = params.config.recencyHalfLifeDays;
  const fallbackWorkspaceDir = normalizeOptionalString(params.workspaceDir);
  // Each completion uses its workspace owner's model and credentials. The triggering
  // agent owns whatever the roster cannot attribute.
  const triggerAgentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const seenWorkspaces = new Set<string>();
  const workspaces: Array<{ agentId?: string; agentIds: readonly string[]; workspaceDir: string }> =
    [];
  const addWorkspace = (
    workspaceDir: string,
    agentId: string,
    agentIds: readonly string[] = [agentId],
  ): void => {
    if (!workspaceDir || seenWorkspaces.has(workspaceDir)) {
      return;
    }
    seenWorkspaces.add(workspaceDir);
    workspaces.push({ ...(agentId ? { agentId } : {}), agentIds, workspaceDir });
  };
  // The triggering agent wins its own workspace; otherwise sort so a workspace shared by
  // several agents always resolves the same owner across sweeps.
  const resolveWorkspaceOwnerAgentId = (agentIds: readonly string[]): string => {
    if (triggerAgentId && agentIds.includes(triggerAgentId)) {
      return triggerAgentId;
    }
    return agentIds.toSorted()[0] ?? triggerAgentId;
  };
  if (params.cfg) {
    for (const entry of resolveMemoryDreamingWorkspaces(params.cfg, {
      primaryWorkspaceDir: fallbackWorkspaceDir,
      // Attribute the hook's own workspace to the agent whose turn triggered the sweep;
      // the host falls back to the roster default agent when the turn has no id.
      ...(triggerAgentId ? { primaryAgentId: triggerAgentId } : {}),
    })) {
      addWorkspace(
        entry.workspaceDir,
        resolveWorkspaceOwnerAgentId(entry.agentIds),
        entry.agentIds,
      );
    }
  }
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    addWorkspace(fallbackWorkspaceDir, triggerAgentId);
  }
  if (workspaces.length === 0) {
    params.logger.warn(
      "memory-core: dreaming promotion skipped because no memory workspace is available.",
    );
    return { handled: true, reason: "memory-core: short-term dreaming missing workspace" };
  }
  if (params.config.limit === 0) {
    params.logger.info("memory-core: dreaming promotion skipped because limit=0.");
    return { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };
  }

  const storedProgress = await readDreamingSweepProgress();
  const workspaceBatch = selectDreamingWorkspaceBatch({
    workspaces,
    nextWorkspaceKey: storedProgress.nextWorkspaceKey,
    limit: DREAMING_MAX_WORKSPACES_PER_RUN,
  });
  const selectedWorkspace = workspaceBatch[0];
  if (!selectedWorkspace) {
    return { handled: true, reason: "memory-core: short-term dreaming missing workspace" };
  }
  const phase = storedProgress.nextPhase;
  const workspaceSummary = selectedWorkspace.workspaceKey.slice(0, 12);
  const sameProgress = `${workspaceSummary}:${phase}`;
  const formatBoundedError = (error: unknown): string =>
    formatErrorMessage(error)
      .replace(/[\r\n(),]+/gu, " ")
      .slice(0, 180);
  const formatCheckpoint = (checkpoint: {
    dispatched: 0 | 1;
    terminal: string;
    next: string;
    error?: string;
  }): string =>
    `memory-core: dreaming phase checkpoint (workspace=${workspaceSummary}, phase=${phase}, dispatched=${checkpoint.dispatched}, terminal=${checkpoint.terminal}, next=${checkpoint.next}${checkpoint.error ? `, error=${checkpoint.error}` : ""}).`;
  if (params.trigger === "cron") {
    const admission = await probeDreamingAdmission();
    if (!admission.allowed) {
      const summary = formatCheckpoint({
        dispatched: 0,
        terminal: "admission_skipped",
        next: sameProgress,
        error: admission.reason,
      });
      params.logger.warn(summary);
      return { handled: true, reason: "memory-core: short-term dreaming degraded" };
    }
  }
  const leaseGuard = await acquireDreamingSweepLeaseGuard({
    onRenewalFailure: (error) =>
      params.logger.error(`memory-core: dreaming sweep lease renewal failed: ${error.message}`),
  });
  if (!leaseGuard) {
    params.logger.warn("memory-core: dreaming sweep skipped because another sweep is active.");
    return { handled: true, reason: "memory-core: short-term dreaming already active" };
  }
  await using sweepLease = leaseGuard;

  if (params.config.verboseLogging) {
    params.logger.info(
      `memory-core: dreaming verbose enabled (cron=${params.config.cron}, limit=${params.config.limit}, minScore=${params.config.minScore.toFixed(3)}, minRecallCount=${params.config.minRecallCount}, minUniqueQueries=${params.config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${params.config.maxAgeDays ?? "none"}, workspaces=${workspaces.length}).`,
    );
  }
  const pluginConfig = params.cfg ? resolveMemoryDreamingPluginConfig(params.cfg) : undefined;
  const { agentId, agentIds, workspaceDir, workspaceKey, nextWorkspaceKey } = selectedWorkspace;
  const sweepNowMs = Date.now();
  let dispatched: 0 | 1 = 0;
  let terminal: "completed" | "skipped" | "degraded";
  let phaseError: string | undefined;
  let nextDeepGroupKey: string | undefined;
  try {
    if (phase === "light" || phase === "rem") {
      const { runDreamingSweepPhase } = await import("./dreaming-phases.js");
      const result = await runDreamingSweepPhase({
        phase,
        agentId,
        workspaceDir,
        pluginConfig,
        cfg: params.cfg,
        logger: params.logger,
        subagent: params.subagent,
        nowMs: sweepNowMs,
      });
      dispatched = result.dispatched;
      terminal = result.terminal;
      phaseError = result.error;
    } else {
      const [
        { writeDeepDreamingReport },
        {
          applyShortTermPromotions,
          repairShortTermPromotionArtifacts,
          rankShortTermPromotionCandidates,
        },
        { groupPromotionCandidatesByProjectKey },
      ] = await Promise.all([
        import("./dreaming-markdown.js"),
        import("./short-term-promotion.js"),
        import("./short-term-promotion-metadata.js"),
      ]);
      const reportLines: string[] = [];
      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
      if (repair.changed) {
        params.logger.info(
          `memory-core: normalized recall artifacts before dreaming (${formatRepairSummary(repair)}) [workspace=${workspaceDir}].`,
        );
        reportLines.push(`- Repaired recall artifacts: ${formatRepairSummary(repair)}.`);
      }
      const candidates = await rankShortTermPromotionCandidates({
        workspaceDir,
        limit: params.config.limit,
        minScore: params.config.minScore,
        minRecallCount: params.config.minRecallCount,
        minUniqueQueries: params.config.minUniqueQueries,
        recencyHalfLifeDays,
        maxAgeDays: params.config.maxAgeDays,
        nowMs: sweepNowMs,
      });
      const groups = groupPromotionCandidatesByProjectKey(candidates);
      const selected = selectDeepPromotionGroup({
        groups,
        deepGroupKey: storedProgress.deepGroupKey,
      });
      const groupCandidates = selected.group?.candidates ?? [];
      reportLines.push(
        `- Ranked ${candidates.length} candidate(s); selected deep group ${groups.length === 0 ? 0 : selected.index + 1}/${groups.length}.`,
      );
      if (params.config.verboseLogging) {
        const candidateSummary =
          candidates.length > 0
            ? candidates
                .map(
                  (candidate) =>
                    `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} queries=${candidate.uniqueQueries} components={freq=${candidate.components.frequency.toFixed(3)},rel=${candidate.components.relevance.toFixed(3)},div=${candidate.components.diversity.toFixed(3)},rec=${candidate.components.recency.toFixed(3)},cons=${candidate.components.consolidation.toFixed(3)},concept=${candidate.components.conceptual.toFixed(3)}}`,
                )
                .join(" | ")
            : "none";
        params.logger.info(
          `memory-core: dreaming candidate details [workspace=${workspaceDir}] ${candidateSummary}`,
        );
      }
      // Pass only one project group. consolidateMemory therefore performs at most one model
      // dispatch, and requireSuccess leaves the group unpromoted for the next-cycle retry.
      const applied = await applyShortTermPromotions({
        agentId,
        workspaceAgentIds: agentIds,
        workspaceDir,
        candidates: groupCandidates,
        limit: params.config.limit,
        minScore: params.config.minScore,
        minRecallCount: params.config.minRecallCount,
        minUniqueQueries: params.config.minUniqueQueries,
        maxAgeDays: params.config.maxAgeDays,
        maxPromotedSnippetTokens: params.config.maxPromotedSnippetTokens,
        maxPriorEntryLossFraction: params.config.maxPriorEntryLossFraction,
        memoryFileMaxChars: resolveMemoryPromotionFileMaxChars({
          cfg: params.cfg,
          agentIds,
        }),
        consolidation: {
          ...(params.subagent ? { subagent: params.subagent } : {}),
          ...(params.config.execution?.model ? { model: params.config.execution.model } : {}),
          requireSuccess: true,
          logger: params.logger,
        },
        timezone: params.config.timezone,
        nowMs: sweepNowMs,
      });
      dispatched = applied.consolidationAttempted ? 1 : 0;
      if (applied.consolidationAttempted && applied.consolidationSucceeded !== true) {
        terminal = "degraded";
        phaseError = "deep consolidation did not commit";
      } else {
        terminal = groupCandidates.length > 0 ? "completed" : "skipped";
        nextDeepGroupKey = selected.nextDeepGroupKey;
      }
      reportLines.push(`- Promoted ${applied.applied} candidate(s) into MEMORY.md.`);
      if (params.config.verboseLogging) {
        const appliedSummary =
          applied.appliedCandidates.length > 0
            ? applied.appliedCandidates
                .map(
                  (candidate) =>
                    `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount}`,
                )
                .join(" | ")
            : "none";
        params.logger.info(
          `memory-core: dreaming applied details [workspace=${workspaceDir}] ${appliedSummary}`,
        );
      }
      if (applied.rejectedCandidates.length > 0) {
        const rejectionCounts = new Map<string, number>();
        for (const { category } of applied.rejectedCandidates) {
          rejectionCounts.set(category, (rejectionCounts.get(category) ?? 0) + 1);
        }
        const summary = [...rejectionCounts]
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([category, count]) => `${category}: ${count}`)
          .join(", ");
        reportLines.push(
          `- Not promoted: ${applied.rejectedCandidates.length} candidate(s) (${summary}).`,
        );
      }
      const hasReportableRejections = applied.rejectedCandidates.some(
        ({ category }) => category !== "memory budget",
      );
      await writeDeepDreamingReport({
        workspaceDir,
        bodyLines: reportLines,
        hasContent: repair.changed || applied.applied > 0 || hasReportableRejections,
        nowMs: sweepNowMs,
        timezone: params.config.timezone,
        storage: params.config.storage ?? { mode: "separate", separateReports: false },
      });
    }
  } catch (error) {
    terminal = "degraded";
    phaseError = formatBoundedError(error);
    try {
      await appendFailedDreamingEvent({
        workspaceDir,
        phase,
        error: phaseError,
        storageMode: params.config.storage?.mode ?? "separate",
        nowMs: sweepNowMs,
        logger: params.logger,
      });
    } catch (reportError) {
      params.logger.error(
        `memory-core: failed to record dreaming failure: ${formatBoundedError(reportError)}`,
      );
    }
  }
  if (terminal === "degraded" || sweepLease.lost) {
    const summary = formatCheckpoint({
      dispatched,
      terminal: sweepLease.lost ? "lease_lost" : "error",
      next: sameProgress,
      error: formatBoundedError(phaseError ?? "phase degraded"),
    });
    params.logger.warn(summary);
    return { handled: true, reason: "memory-core: short-term dreaming degraded" };
  }
  const nextProgress = advanceDreamingSweepProgress({
    phase,
    workspaceKey,
    nextWorkspaceKey,
    nextDeepGroupKey,
  });
  try {
    await checkpointDreamingSweep(
      nextProgress.nextWorkspaceKey,
      nextProgress.nextPhase,
      nextProgress.deepGroupKey,
    );
  } catch (error) {
    const summary = formatCheckpoint({
      dispatched,
      terminal: "checkpoint_error",
      next: sameProgress,
      error: formatBoundedError(error),
    });
    params.logger.warn(summary);
    return { handled: true, reason: "memory-core: short-term dreaming degraded" };
  }
  const nextSummary = `${nextProgress.nextWorkspaceKey.slice(0, 12)}:${nextProgress.nextPhase}`;
  params.logger.info(formatCheckpoint({ dispatched, terminal, next: nextSummary }));
  return { handled: true, reason: "memory-core: short-term dreaming batch checkpointed" };
}

export function registerShortTermPromotionDreaming(api: OpenClawPluginApi): void {
  let resolveServiceCron: (() => CronServiceLike | null) | null = null;
  let unavailableCronWarningEmitted = false;
  let startupDreamingCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  const dreamingTasks = new Set<Promise<unknown>>();
  let runtimeCronReconcileTimer: ReturnType<typeof setInterval> | null = null;
  let gatewayLifecycleGeneration = 0;
  let disposed = true;
  let serviceStartedAtMs: number | undefined;

  const resolveCurrentConfig = (): OpenClawConfig =>
    (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;

  const disposeDreaming = (): void => {
    disposed = true;
    gatewayLifecycleGeneration += 1;
    if (startupDreamingCleanupTimer) {
      clearTimeout(startupDreamingCleanupTimer);
      startupDreamingCleanupTimer = null;
    }
    if (runtimeCronReconcileTimer) {
      clearInterval(runtimeCronReconcileTimer);
      runtimeCronReconcileTimer = null;
    }
    resolveServiceCron = null;
  };

  const reconcileManagedDreamingCron = async (params: {
    reason: "startup" | "runtime";
    startupConfig?: OpenClawConfig;
  }): Promise<void> => {
    const startupCfg =
      params.reason === "startup" ? (params.startupConfig ?? api.config) : resolveCurrentConfig();
    const pluginConfig =
      params.reason === "startup"
        ? (resolveMemoryDreamingPluginConfig(startupCfg) ??
          resolveMemoryDreamingPluginConfig(api.config) ??
          api.pluginConfig)
        : resolveMemoryDreamingPluginConfig(startupCfg);
    const config = resolveMemoryDeepDreamingConfig({
      pluginConfig,
      cfg: startupCfg,
    });
    const cron = resolveServiceCron?.() ?? null;
    // Pausing automatic scheduling preserves jobs; explicitly disabling dreaming
    // still reconciles their removal, and startup artifact cleanup stays independent.
    if (config.enabled && cron?.isEnabled && !(await cron.isEnabled())) {
      return;
    }
    if (!cron && config.enabled && !unavailableCronWarningEmitted) {
      // A non-Gateway host may attach its scheduler later; report persistent
      // unavailability from the regular reconciliation interval.
      if (params.reason === "startup") {
        api.logger.debug?.(
          "memory-core: cron service not yet available at service start; deferring to runtime reconciliation.",
        );
      } else {
        api.logger.warn(
          "memory-core: managed dreaming cron could not be reconciled (cron service unavailable).",
        );
        unavailableCronWarningEmitted = true;
      }
    }
    if (cron) {
      unavailableCronWarningEmitted = false;
    }
    await reconcileShortTermDreamingCronJob({
      cron,
      config,
      logger: api.logger,
    });
  };

  const startRuntimeCronReconcileTimer = (): void => {
    if (disposed || runtimeCronReconcileTimer) {
      return;
    }
    runtimeCronReconcileTimer = setInterval(() => {
      void trackDreamingTask(reconcileManagedDreamingCron({ reason: "runtime" })).catch(
        (err: unknown) => {
          api.logger.error(
            `memory-core: dreaming cron reconcile failed: ${formatErrorMessage(err)}`,
          );
        },
      );
    }, RUNTIME_CRON_RECONCILE_INTERVAL_MS);
    runtimeCronReconcileTimer.unref?.();
  };

  const trackDreamingTask = <T>(task: Promise<T>): Promise<T> => {
    dreamingTasks.add(task);
    void task.then(
      () => dreamingTasks.delete(task),
      () => dreamingTasks.delete(task),
    );
    return task;
  };

  const startDreamingSessionCleanup = async (
    config: OpenClawConfig,
    generation: number,
    startupStartedAtMs: number,
  ): Promise<void> => {
    // Previous releases persisted narrative sessions. Reclaim those historical artifacts
    // at startup; new prompt-only completions create no sessions to scrub.
    const { DREAMING_ORPHAN_MIN_AGE_MS, scrubDreamingNarrativeArtifacts } =
      await import("./dreaming-session-cleanup.js");
    if (disposed || generation !== gatewayLifecycleGeneration) {
      return;
    }
    const scrubConfiguredAgents = async (
      currentConfig: OpenClawConfig,
      nowMs?: number,
    ): Promise<void> => {
      const agentIds = uniqueStrings(
        resolveMemoryDreamingWorkspaces(currentConfig).flatMap(
          ({ agentIds: workspaceAgentIds }) => workspaceAgentIds,
        ),
      );
      for (const agentId of agentIds) {
        if (disposed || generation !== gatewayLifecycleGeneration) {
          return;
        }
        try {
          await scrubDreamingNarrativeArtifacts({
            agentId,
            config: currentConfig,
            logger: api.logger,
            ...(nowMs === undefined ? {} : { nowMs }),
          });
        } catch (error) {
          api.logger.warn(
            `memory-core: dreaming startup cleanup failed for agent ${agentId}: ${formatErrorMessage(error)}`,
          );
        }
      }
    };

    // Cron reconciliation can itself stall; never classify sessions admitted after startup.
    await scrubConfiguredAgents(config, startupStartedAtMs);
    if (disposed || generation !== gatewayLifecycleGeneration) {
      return;
    }
    // Interrupted runs are initially indistinguishable from live runs; revisit once their
    // persisted activity ages past the same guard used by normal narrative cleanup.
    const cleanupTimer = setTimeout(() => {
      if (
        disposed ||
        generation !== gatewayLifecycleGeneration ||
        startupDreamingCleanupTimer !== cleanupTimer
      ) {
        return;
      }
      startupDreamingCleanupTimer = null;
      // Keep the cutoff strictly before startup: equal-millisecond sessions may have
      // started after the hook and must survive even when this timer runs late.
      void trackDreamingTask(
        scrubConfiguredAgents(
          resolveCurrentConfig(),
          startupStartedAtMs + DREAMING_ORPHAN_MIN_AGE_MS - 1,
        ).catch((error: unknown) => {
          api.logger.warn(
            `memory-core: deferred dreaming startup cleanup failed: ${formatErrorMessage(error)}`,
          );
        }),
      );
    }, DREAMING_ORPHAN_MIN_AGE_MS);
    startupDreamingCleanupTimer = cleanupTimer;
    startupDreamingCleanupTimer.unref?.();
  };

  api.registerService({
    id: "memory-core-dreaming",
    async start(ctx) {
      if (!ctx.getCron) {
        return;
      }
      serviceStartedAtMs = Date.now();
      disposed = false;
      resolveServiceCron = () => resolveCronServiceFromGatewayContext(ctx);
      try {
        await trackDreamingTask(
          reconcileManagedDreamingCron({
            reason: "startup",
            startupConfig: ctx.config,
          }),
        );
      } catch (err) {
        api.logger.error(
          `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
        );
      } finally {
        startRuntimeCronReconcileTimer();
      }
    },
    async stop() {
      // Plugin replacement stops services, not Gateway hooks. Fence timers and
      // settle their work before the successor can own the same declaration.
      disposeDreaming();
      await Promise.allSettled(dreamingTasks);
    },
  });

  api.on("gateway_start", async (_event, ctx) => {
    if (disposed || serviceStartedAtMs === undefined) {
      return;
    }
    if (startupDreamingCleanupTimer) {
      clearTimeout(startupDreamingCleanupTimer);
      startupDreamingCleanupTimer = null;
    }
    const generation = ++gatewayLifecycleGeneration;
    await trackDreamingTask(
      startDreamingSessionCleanup(ctx.config ?? api.config, generation, serviceStartedAtMs),
    ).catch((error: unknown) => {
      api.logger.warn(`memory-core: dreaming startup cleanup failed: ${formatErrorMessage(error)}`);
    });
  });

  api.on(
    "before_agent_reply",
    async (event, ctx) => {
      try {
        if (ctx.trigger !== "heartbeat" && ctx.trigger !== "cron") {
          return undefined;
        }
        const currentConfig = resolveCurrentConfig();
        const hasManagedDreamingToken = includesSystemEventToken(
          event.cleanedBody,
          DREAMING_SYSTEM_EVENT_TEXT,
        );
        const isManagedTrigger =
          ctx.trigger === "cron" || hasPendingManagedDreamingCronEvent(ctx.sessionKey, ctx.agentId);
        if (!hasManagedDreamingToken || !isManagedTrigger) {
          return undefined;
        }
        const config = resolveMemoryDeepDreamingConfig({
          pluginConfig: resolveMemoryDreamingPluginConfig(currentConfig),
          cfg: currentConfig,
        });
        return await runShortTermDreamingPromotionIfTriggered({
          cleanedBody: event.cleanedBody,
          trigger: ctx.trigger,
          agentId: ctx.agentId,
          workspaceDir: ctx.workspaceDir,
          cfg: currentConfig,
          config,
          logger: api.logger,
          subagent: config.enabled ? api.runtime?.subagent : undefined,
        });
      } catch (err) {
        api.logger.error(`memory-core: dreaming trigger failed: ${formatErrorMessage(err)}`);
        return undefined;
      }
    },
    { eligibleTriggers: ["heartbeat", "cron"] },
  );
}
