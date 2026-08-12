#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const DEFAULT_STATE_ROOT =
  process.env.OPENCLAW_HEALTH_STATE_ROOT ?? "/home/dev/.openclaw/cron/bounded-health-monitor";
const DEFAULT_SNAPSHOT =
  process.env.OPENCLAW_HEALTH_SNAPSHOT ??
  "/home/dev/.openclaw/releases/current/scripts/operations/cron-health-snapshot.sh";
const PIPELINE_BUDGET_MS = 175_000;
const FINALIZATION_RESERVE_MS = 10_000;
const PROBE_TIMEOUT_MS = 45_000;
const MAX_PROBE_ATTEMPTS = 3;
const OUTPUT_MAX_BYTES = 2_000_000;
const DEFAULT_PM2_STATE_PATH =
  process.env.OPENCLAW_HEALTH_PM2_STATE_FILE ??
  "/home/dev/.openclaw/workspace-openclaw/state/pm2-restart-counts.json";
const activeProcessGroups = new Set();

// These stable IDs select sections from the canonical host snapshot script.
const DEFAULT_PROBE_IDS = [
  "system-cron",
  "carryover",
  "seedsearch",
  "pm2",
  "disk",
  "tasks",
  "disabled-crons",
  "registry",
];

function safeError(error) {
  return String(error?.message ?? error)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function remainingBudgetMs(deadline) {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

function deadlineError() {
  const error = new Error("health monitor deadline reached; checkpoint preserved for resume");
  error.code = "DEADLINE";
  return error;
}

async function boundedIo(deadline, operation) {
  const timeoutMs = remainingBudgetMs(deadline);
  if (timeoutMs <= 0) {
    throw deadlineError();
  }
  const controller = new AbortController();
  let deadlineReached = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort();
      reject(deadlineError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (deadlineReached || controller.signal.aborted || error?.name === "AbortError") {
      throw deadlineError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(filePath, deadline) {
  try {
    const raw = await boundedIo(deadline, (signal) =>
      fs.readFile(filePath, { encoding: "utf8", signal }),
    );
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value, deadline, io = fs) {
  await boundedIo(deadline, () => io.mkdir(path.dirname(filePath), { recursive: true }));
  const temporary = `${filePath}.${process.pid}.tmp`;
  let renamed = false;
  try {
    await boundedIo(deadline, (signal) =>
      io.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, signal }),
    );
    await boundedIo(deadline, () => io.rename(temporary, filePath));
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

function killProcessGroup(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

function terminateActiveChildren(signal = "SIGTERM") {
  for (const pid of activeProcessGroups) {
    killProcessGroup(pid, signal);
  }
}

function installSignalHandlers() {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      terminateActiveChildren("SIGTERM");
      setTimeout(() => {
        terminateActiveChildren("SIGKILL");
        process.exit(128);
      }, 100).unref();
    });
  }
}

async function acquireRunLock(stateRoot) {
  const lockPath = path.join(stateRoot, "run.lock");
  await fs.mkdir(stateRoot, { recursive: true });
  const child = spawn(
    "flock",
    ["-n", "-E", "75", lockPath, "sh", "-c", "printf 'acquired\\n'; cat >/dev/null"],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  if (child.pid) {
    activeProcessGroups.add(child.pid);
  }
  child.stdin.on("error", () => {});
  let exitResult;
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      activeProcessGroups.delete(child.pid);
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });

  return await new Promise((resolve, reject) => {
    let acquired = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (!acquired) {
        killProcessGroup(child.pid, "SIGKILL");
        reject(new Error("timed out acquiring health monitor lock"));
      }
    }, 5_000);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-240);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (acquired || !stdout.includes("acquired")) {
        return;
      }
      acquired = true;
      clearTimeout(timer);
      resolve(async () => {
        child.stdin.end();
        let releaseTimer;
        const finished = await Promise.race([
          exited.then(() => true),
          new Promise((finish) => {
            releaseTimer = setTimeout(() => finish(false), 1_000);
          }),
        ]);
        clearTimeout(releaseTimer);
        if (!finished) {
          killProcessGroup(child.pid, "SIGKILL");
          await exited;
        }
      });
    });
    child.on("error", reject);
    exited.then(() => {
      clearTimeout(timer);
      if (acquired) {
        return;
      }
      if (exitResult?.code === 75) {
        resolve(null);
      } else {
        reject(new Error(`flock failed: ${stderr || exitResult?.signal || exitResult?.code}`));
      }
    });
  });
}

function statusFromOutput(output) {
  const lines = output.split(/\r?\n/);
  let warningDetected = false;
  for (const line of lines) {
    if (line.startsWith("HEALTH|")) {
      const fields = line.split("|");
      if (fields.length < 5 || !["ok", "warning", "critical"].includes(fields[1])) {
        return "critical";
      }
      if (fields[1] === "critical") {
        return "critical";
      }
      if (fields[1] === "warning") {
        warningDetected = true;
      }
    }
    if (line.startsWith("MATCHES|") && line.split("|", 3)[2]?.trim()) {
      return "critical";
    }
    if (line.startsWith("ENTRY|")) {
      const fields = line.split("|");
      const age = Number.parseInt(fields[6] ?? "", 10);
      const maximumAge = Number.parseInt(fields[7] ?? "", 10);
      if (fields[4] === "no" || !Number.isFinite(age) || age > maximumAge) {
        return "critical";
      }
    }
    if (/^seedsearch_exit=(?!0$)/.test(line)) {
      return "critical";
    }
    if (
      line === "seedsearch_app_missing" ||
      /^catalog_report_status=(missing_dir|jq_missing|missing)$/.test(line) ||
      /^Carryover plugin:\s*(?!true$)/.test(line) ||
      /^Carryover files:\s*0 total,/.test(line)
    ) {
      return "critical";
    }
    if (
      line.startsWith("catalog_report_verdict=warn:") ||
      /^crontab_conversation_carryover=[1-9][0-9]*$/.test(line) ||
      /^DISABLED_GATEWAY_CRON\|(reason_missing_revisit|disabled_since_mismatch)\|/.test(line)
    ) {
      warningDetected = true;
    }
  }
  if (/\|(critical|undocumented)\||(^|\n)(critical|undocumented)\b/i.test(output)) {
    return "critical";
  }
  if (warningDetected || /\|warning\||(^|\n)warning\b/i.test(output)) {
    return "warning";
  }
  return "ok";
}

async function runSnapshotProbe({
  snapshotPath,
  probeId,
  timeoutMs,
  args = [],
  pm2StatePath = DEFAULT_PM2_STATE_PATH,
}) {
  return await new Promise((resolve) => {
    const child = spawn(snapshotPath, ["--probe", probeId, ...args], {
      detached: true,
      env: {
        ...process.env,
        ...(probeId === "pm2"
          ? {
              OPENCLAW_HEALTH_PM2_DEFER_COMMIT: "1",
              OPENCLAW_HEALTH_PM2_STATE_FILE: pm2StatePath,
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) {
      activeProcessGroups.add(child.pid);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const capture = (current, chunk) => {
      const next = `${current}${chunk.toString("utf8")}`;
      return Buffer.byteLength(next, "utf8") > OUTPUT_MAX_BYTES
        ? next.slice(-OUTPUT_MAX_BYTES)
        : next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, "SIGTERM");
      setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 100).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      resolve({ status: "error", findings: [safeError(error)] });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      if (timedOut) {
        resolve({ status: "timeout", findings: [`${probeId}: timed_out`] });
        return;
      }
      const combined = `${stdout}\n${stderr}`.trim();
      let status = code === 0 ? statusFromOutput(combined) : "error";
      const pm2Complete = stdout
        .split(/\r?\n/)
        .includes("HEALTH|ok|pm2|snapshot_complete|candidate_ready");
      if (probeId === "pm2" && code === 0 && !pm2Complete) {
        status = "critical";
      }
      const candidate = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("PM2_STATE_CANDIDATE|"))
        ?.slice("PM2_STATE_CANDIDATE|".length);
      resolve({
        status,
        findings: status === "ok" ? [] : [`${probeId}: ${status} (${signal ?? code})`],
        ...(candidate && pm2Complete && status !== "critical"
          ? { commit: { kind: "pm2-state", path: pm2StatePath, base64: candidate } }
          : {}),
      });
    });
  });
}

function buildReport(checkpoint) {
  const findings = checkpoint.results.flatMap((result) => result.findings ?? []).slice(-20);
  const status =
    checkpoint.reportStatus ?? (checkpoint.remaining > 0 ? "partial" : checkpoint.status);
  const lines = [
    `OpenClaw health monitor — ${status}`,
    `Run ${checkpoint.runId}; probes ${checkpoint.cursor}/${checkpoint.probeIds.length}; remaining=${checkpoint.remaining}; errors=${checkpoint.errors.length}.`,
  ];
  if (findings.length > 0) {
    lines.push(...findings.map((finding) => `- ${finding}`));
  }
  if ((checkpoint.deadLetters?.length ?? 0) > 0) {
    lines.push(
      ...checkpoint.deadLetters.map(
        (entry) => `- ${entry.probeId}: degraded after ${entry.attempts} attempts`,
      ),
    );
  }
  if (checkpoint.remaining > 0) {
    lines.push("Partial checkpoint saved; the next run resumes it.");
  }
  return lines.join("\n");
}

function addCheckpointError(checkpoint, message) {
  checkpoint.errors = [...(checkpoint.errors ?? []), message].slice(-16);
}

function deadLetterProbe(checkpoint, probeId, attempts, findings) {
  checkpoint.deadLetters = (checkpoint.deadLetters ?? []).filter(
    (entry) => entry.probeId !== probeId,
  );
  checkpoint.deadLetters.push({ probeId, attempts, findings });
}

async function runPipeline(options = {}) {
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const checkpointPath = path.join(stateRoot, "checkpoint.json");
  const probeIds = options.probeIds ?? DEFAULT_PROBE_IDS;
  const deadline = performance.now() + parsePositiveInteger(options.budgetMs, PIPELINE_BUDGET_MS);
  const finalizationReserveMs = parsePositiveInteger(
    options.finalizationReserveMs,
    FINALIZATION_RESERVE_MS,
  );
  const releaseLock = await acquireRunLock(stateRoot);
  if (!releaseLock) {
    const previous = await readJson(checkpointPath, deadline);
    const cursor = Number(previous?.cursor ?? 0);
    return {
      status: "overlap",
      runId: previous?.runId ?? null,
      cursor,
      done: cursor,
      remaining: Math.max(0, probeIds.length - cursor),
      errors: [],
      report: `OpenClaw health monitor skipped overlapping execution; cursor=${cursor}.`,
    };
  }

  try {
    const previous = await readJson(checkpointPath, deadline);
    const compatible = previous && JSON.stringify(previous.probeIds) === JSON.stringify(probeIds);
    const checkpoint =
      compatible && !previous.finalized
        ? previous
        : {
            version: 2,
            runId: `health-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
            probeIds,
            cursor: 0,
            results: [],
            errors: [],
            attempts: {},
            deadLetters: [],
            deferredCommit: compatible ? (previous.deferredCommit ?? null) : null,
            commitAttempts: {},
            status: "ok",
            remaining: probeIds.length,
            finalized: false,
          };
    checkpoint.results = checkpoint.results ?? [];
    checkpoint.errors = checkpoint.errors ?? [];
    checkpoint.attempts = checkpoint.attempts ?? {};
    checkpoint.deadLetters = checkpoint.deadLetters ?? [];
    checkpoint.commitAttempts = checkpoint.commitAttempts ?? {};

    const commitPendingResult = async (pendingKey) => {
      const pending = checkpoint[pendingKey];
      if (!pending) {
        return;
      }
      if (pending.kind !== "pm2-state") {
        throw new Error("unsupported health probe commit");
      }
      const bytes = Buffer.from(pending.base64, "base64");
      if (bytes.length > OUTPUT_MAX_BYTES) {
        throw new Error("PM2 state candidate exceeds limit");
      }
      const value = JSON.parse(bytes.toString("utf8"));
      if (!value || !Array.isArray(value.processes)) {
        throw new Error("invalid PM2 state candidate");
      }
      await writeJsonAtomic(pending.path, value, deadline, options.commitIo);
      if (pendingKey === "pendingCommit") {
        const result = checkpoint.results.at(-1);
        if (result?.probeId === pending.probeId) {
          result.commitPending = false;
        }
        checkpoint.cursor += 1;
        checkpoint.remaining = probeIds.length - checkpoint.cursor;
      }
      checkpoint[pendingKey] = null;
      checkpoint.commitAttempts[pending.probeId] = 0;
      await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
    };

    const attemptPendingCommit = async (pendingKey) => {
      const pending = checkpoint[pendingKey];
      if (!pending) {
        return "committed";
      }
      try {
        await commitPendingResult(pendingKey);
        return "committed";
      } catch (error) {
        const attempts = Number(checkpoint.commitAttempts[pending.probeId] ?? 0) + 1;
        checkpoint.commitAttempts[pending.probeId] = attempts;
        addCheckpointError(checkpoint, `commit ${pending.probeId}: ${safeError(error)}`);
        if (attempts >= MAX_PROBE_ATTEMPTS) {
          deadLetterProbe(checkpoint, pending.probeId, attempts, [
            `${pending.probeId}: baseline commit failed`,
          ]);
          checkpoint.status = "critical";
          if (pendingKey === "pendingCommit") {
            checkpoint.pendingCommit = null;
            checkpoint.deferredCommit = pending;
            checkpoint.cursor += 1;
            checkpoint.remaining = probeIds.length - checkpoint.cursor;
          }
          checkpoint.deferCommitForSweep = true;
          await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
          return "deadlettered";
        }
        try {
          await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
        } catch {
          // The durable pending commit was already checkpointed before the attempted sink write.
        }
        return "blocked";
      }
    };

    if (checkpoint.deferredCommit && !checkpoint.deferCommitForSweep) {
      const outcome = await attemptPendingCommit("deferredCommit");
      if (outcome === "blocked") {
        return {
          status: "partial",
          runId: checkpoint.runId,
          cursor: checkpoint.cursor,
          done: checkpoint.cursor,
          remaining: checkpoint.remaining,
          errors: checkpoint.errors,
          attempts: checkpoint.attempts,
          deadLetters: checkpoint.deadLetters,
          report: buildReport({ ...checkpoint, reportStatus: "partial" }),
        };
      }
    }
    if (checkpoint.pendingCommit) {
      const outcome = await attemptPendingCommit("pendingCommit");
      if (outcome === "blocked") {
        return {
          status: "partial",
          runId: checkpoint.runId,
          cursor: checkpoint.cursor,
          done: checkpoint.cursor,
          remaining: checkpoint.remaining,
          errors: checkpoint.errors,
          attempts: checkpoint.attempts,
          deadLetters: checkpoint.deadLetters,
          report: buildReport({ ...checkpoint, reportStatus: "partial" }),
        };
      }
    }
    const batchSize = Math.min(
      parsePositiveInteger(options.batchSize, probeIds.length),
      probeIds.length,
    );
    const stopAt = Math.min(probeIds.length, checkpoint.cursor + batchSize);
    const runProbe =
      options.runProbe ??
      ((probeId) =>
        runSnapshotProbe({
          snapshotPath: options.snapshotPath ?? DEFAULT_SNAPSHOT,
          probeId,
          timeoutMs: Math.min(
            parsePositiveInteger(options.probeTimeoutMs, PROBE_TIMEOUT_MS),
            Math.max(1, remainingBudgetMs(deadline) - finalizationReserveMs),
          ),
          args: options.probeArgs,
          pm2StatePath: options.pm2StatePath,
        }));

    try {
      await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
      while (checkpoint.cursor < stopAt && remainingBudgetMs(deadline) > finalizationReserveMs) {
        const probeId = probeIds[checkpoint.cursor];
        if (checkpoint.deadLetters.some((entry) => entry.probeId === probeId)) {
          checkpoint.cursor += 1;
          checkpoint.remaining = probeIds.length - checkpoint.cursor;
          await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
          continue;
        }
        let result;
        try {
          result = await runProbe(probeId);
        } catch (error) {
          result = { status: "error", findings: [`${probeId}: ${safeError(error)}`] };
        }
        const { commit, ...recordedResult } = result;
        checkpoint.results.push({ probeId, ...recordedResult, commitPending: Boolean(commit) });
        if (result.status === "critical" || result.status === "error") {
          checkpoint.status = "critical";
        } else if (
          checkpoint.status === "ok" &&
          (result.status === "warning" || result.status === "timeout")
        ) {
          checkpoint.status = "warning";
        }
        const retryableFailure = result.status === "error" || result.status === "timeout";
        if (retryableFailure) {
          for (const finding of result.findings ?? [`${probeId}: ${result.status}`]) {
            addCheckpointError(checkpoint, finding);
          }
          checkpoint.attempts[probeId] = Number(checkpoint.attempts[probeId] ?? 0) + 1;
          if (checkpoint.attempts[probeId] < MAX_PROBE_ATTEMPTS) {
            await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
            break;
          }
          deadLetterProbe(checkpoint, probeId, checkpoint.attempts[probeId], result.findings ?? []);
        }
        if (commit) {
          checkpoint.pendingCommit = { probeId, ...commit };
          await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
          const outcome = await attemptPendingCommit("pendingCommit");
          if (outcome === "blocked") {
            break;
          }
        } else {
          checkpoint.cursor += 1;
          checkpoint.remaining = probeIds.length - checkpoint.cursor;
          await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
        }
      }
      checkpoint.finalized = checkpoint.remaining === 0;
      await writeJsonAtomic(checkpointPath, checkpoint, deadline, options.checkpointIo);
    } catch (error) {
      checkpoint.finalized = false;
      addCheckpointError(checkpoint, safeError(error));
    }

    const status = checkpoint.finalized
      ? checkpoint.deadLetters?.length > 0
        ? "degraded"
        : checkpoint.status
      : "partial";
    return {
      status,
      runId: checkpoint.runId,
      cursor: checkpoint.cursor,
      done: checkpoint.cursor,
      remaining: checkpoint.remaining,
      errors: checkpoint.errors.slice(-16),
      attempts: checkpoint.attempts,
      deadLetters: checkpoint.deadLetters,
      report: buildReport({ ...checkpoint, reportStatus: status }),
    };
  } finally {
    await releaseLock();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = await runPipeline({
    stateRoot: args["state-root"],
    snapshotPath: args.snapshot,
    batchSize: args["batch-size"],
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = {
  acquireRunLock,
  buildReport,
  killProcessGroup,
  runPipeline,
  runSnapshotProbe,
  statusFromOutput,
};

if (require.main === module) {
  installSignalHandlers();
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ status: "partial", report: "OpenClaw health monitor failed before completion.", cursor: 0, done: 0, remaining: DEFAULT_PROBE_IDS.length, errors: [safeError(error)] })}\n`,
    );
    process.exitCode = 1;
  });
}
