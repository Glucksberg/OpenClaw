import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseCodeModeScriptSyntax } from "../agents/code-mode-script-syntax.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const helperPath = path.resolve(
  import.meta.dirname,
  "../../scripts/operations/cron-health-monitor.cjs",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function loadDefinition() {
  const source = await fs.readFile(
    path.resolve(import.meta.dirname, "../../scripts/operations/cron-health-monitor.script"),
    "utf8",
  );
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (tools: unknown, trigger: unknown) => Promise<unknown>;
  return { source, definition: new AsyncFunction("tools", "trigger", source) };
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

describe("bounded cron health monitor", () => {
  test("native definition uses one bounded exec and exposes resumable state", async () => {
    const { source, definition } = await loadDefinition();
    expect(parseCodeModeScriptSyntax(source)).toMatchObject({ ok: true });
    const call = vi.fn().mockResolvedValue({
      result: {
        details: {
          aggregated: JSON.stringify({
            status: "partial",
            runId: "health-1",
            cursor: 3,
            done: 3,
            remaining: 5,
            errors: ["seedsearch: timed_out"],
            report: "OpenClaw health partial: 3/8 probes",
          }),
        },
      },
    });

    const output = (await definition({ call }, { state: {} })) as {
      notify: string;
      state: Record<string, unknown>;
    };

    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      "exec",
      expect.objectContaining({
        command: expect.stringContaining("cron-health-monitor.cjs"),
        timeoutSeconds: 210,
        workdir: "/home/dev/.openclaw/workspace-openclaw",
      }),
    );
    expect(output.notify).toContain("partial");
    expect(output.state).toMatchObject({ runId: "health-1", cursor: 3, remaining: 5 });
  });

  test("canonical snapshot keeps legacy all-section order and exposes every probe id", async () => {
    const snapshotPath = path.resolve(
      import.meta.dirname,
      "../../scripts/operations/cron-health-snapshot.sh",
    );
    const source = await fs.readFile(snapshotPath, "utf8");
    const ids = [
      "system-cron",
      "carryover",
      "seedsearch",
      "pm2",
      "disk",
      "tasks",
      "disabled-crons",
      "registry",
    ];
    for (const id of ids) {
      expect(source).toContain(`|${id}`);
    }

    const legacySections = [
      "===DATE===",
      "===CRONTAB_RAW===",
      "===SYSTEM_CRON_DETAIL===",
      "===DISABLED_SYSTEM_CRONS===",
      "===CARRYOVER_DETAIL===",
      "===SEEDSEARCH_DRY_RUN===",
      "===SEEDSEARCH_ARTIFACT_PROOF===",
      "===PM2_PROCESS_DETAIL===",
      "===DISK_DETAIL===",
      "===TASK_AUDIT_DETAIL===",
      "===DISABLED_GATEWAY_CRONS===",
      "===REGISTRY_SNIPPETS===",
    ];
    const indexes = legacySections.map((section) =>
      section === "===DISABLED_GATEWAY_CRONS==="
        ? source.lastIndexOf(section)
        : source.indexOf(section),
    );
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual(indexes.toSorted((left, right) => left - right));
  });

  test.each([
    ["MATCHES|Release Monitor|", "ok"],
    ["MATCHES|Release Monitor|fatal: command failed", "critical"],
    ["ENTRY|CloudFarm|0 6 * * *|/srv/job.sh|yes|/tmp/job.log|120|180|1|1|ok", "ok"],
    ["ENTRY|CloudFarm|0 6 * * *|/srv/job.sh|no|/tmp/job.log|120|180|1|1|ok", "critical"],
    ["ENTRY|CloudFarm|0 6 * * *|/srv/job.sh|yes|/tmp/job.log|181|180|1|1|ok", "critical"],
    ["seedsearch_exit=1", "critical"],
    ["seedsearch_app_missing", "critical"],
    ["catalog_report_status=missing", "critical"],
    ["catalog_report_verdict=warn: report stale", "warning"],
    ["Carryover plugin: false", "critical"],
    ["Carryover files: 0 total, 0 stale (>10min, expected for idle workspaces)", "critical"],
    ["crontab_conversation_carryover=1", "warning"],
    ["DISABLED_GATEWAY_CRON|reason_missing_revisit|id|name", "warning"],
    ["HEALTH|critical|pm2|status_not_online|api status=stopped", "critical"],
    ["HEALTH|warning|pm2|restart_delta_warning|api delta=3", "warning"],
    ["HEALTH|bogus|pm2|status_not_online|api", "critical"],
  ])("classifies canonical finding %s as %s", (output, expected) => {
    const { statusFromOutput } = require(helperPath) as {
      statusFromOutput: (value: string) => string;
    };
    expect(statusFromOutput(output)).toBe(expected);
  });

  test.each([
    ["healthy", (lines: string[]) => lines, "ok", "schedule_present"],
    ["missing", (lines: string[]) => lines.slice(1), "critical", "schedule_missing"],
    [
      "drifted",
      (lines: string[]) => [(lines[0] ?? "").replace("0 * * * *", "1 * * * *"), ...lines.slice(1)],
      "critical",
      "schedule_drift",
    ],
    ["duplicated", (lines: string[]) => [lines[0], ...lines], "critical", "schedule_duplicate"],
  ])(
    "emits a structured system-cron verdict for %s schedules",
    async (_label, mutate, severity, code) => {
      const root = tempDirs.make("openclaw-health-crontab-");
      const crontabPath = path.join(root, "crontab");
      const lines = [
        "0 * * * * node /home/dev/projects/CloudFarm/apps/backend/scripts/releaseMonitor.js",
        "0 6 * * * node /home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js",
        "0 14 * * * node /home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js",
        "0 22 * * * node /home/dev/projects/CloudFarm/agents/opsec/scripts/metrics-reporter.js",
        "0 17 * * 5 node /home/dev/projects/CloudFarm/agents/opsec/scripts/weekly-metrics-reporter.js",
        "20 3 * * * /home/dev/scripts/backup-all-databases.sh",
        "0 4 * * 0 /home/dev/tools/weekly-cleanup",
        "0 7 * * * run-credsys >> /home/dev/projects/credsys/logs/cron-notificacoes.log",
      ];
      await fs.writeFile(crontabPath, `${mutate(lines).join("\n")}\n`, { mode: 0o600 });
      const snapshotPath = path.resolve(
        import.meta.dirname,
        "../../scripts/operations/cron-health-snapshot.sh",
      );
      const { stdout } = await execFileAsync(snapshotPath, ["--probe", "system-cron"], {
        env: { ...process.env, OPENCLAW_HEALTH_CRONTAB_FILE: crontabPath },
        maxBuffer: 2_000_000,
      });
      expect(stdout).toContain(`HEALTH|${severity}|system-cron|${code}|Release Monitor`);
    },
  );

  test.each([
    ["healthy", true, true, "HEALTH|ok|registry|registry_consistent"],
    ["missing", false, true, "HEALTH|critical|registry|registry_file_missing"],
    ["mismatched", true, false, "HEALTH|critical|registry|registry_mismatch"],
  ])(
    "emits a structured registry verdict for a %s registry",
    async (_label, tools, healthy, line) => {
      const root = tempDirs.make("openclaw-health-registry-");
      const toolsPath = path.join(root, "TOOLS.md");
      const registryPath = path.join(root, "registry.md");
      if (tools) {
        await fs.writeFile(toolsPath, "**Callback handlers**\ncronrun_example\n", { mode: 0o600 });
      }
      await fs.writeFile(
        registryPath,
        healthy
          ? "### Gateway Cron Jobs\n| cron-health-monitor | 6be7fd47-6945-4edd-ab83-49800caf9e4f | `0 0,12 * * *` (UTC) |\n### System Cron Jobs\n"
          : "### Gateway Cron Jobs\n| wrong |\n### System Cron Jobs\n",
        { mode: 0o600 },
      );
      const snapshotPath = path.resolve(
        import.meta.dirname,
        "../../scripts/operations/cron-health-snapshot.sh",
      );
      const { stdout } = await execFileAsync(snapshotPath, ["--probe", "registry"], {
        env: {
          ...process.env,
          OPENCLAW_HEALTH_REGISTRY_FILE: registryPath,
          OPENCLAW_HEALTH_TOOLS_FILE: toolsPath,
        },
        maxBuffer: 2_000_000,
      });
      expect(stdout).toContain(line);
    },
  );

  test("checkpoints finite probes and resumes without repeating completed work", async () => {
    const root = tempDirs.make("openclaw-health-monitor-");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const runProbe = vi
      .fn()
      .mockResolvedValueOnce({ status: "ok", findings: [] })
      .mockResolvedValueOnce({ status: "warning", findings: ["disk:warning"] })
      .mockResolvedValueOnce({ status: "ok", findings: [] });
    try {
      const first = await runPipeline({
        stateRoot: root,
        probeIds: ["pm2", "disk", "tasks"],
        batchSize: 2,
        runProbe,
      });
      expect(first).toMatchObject({ status: "partial", cursor: 2, remaining: 1 });

      const second = await runPipeline({
        stateRoot: root,
        probeIds: ["pm2", "disk", "tasks"],
        batchSize: 3,
        runProbe,
      });
      expect(second).toMatchObject({ status: "warning", cursor: 3, remaining: 0 });
      expect(runProbe).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("returns overlap while an OS singleton owner is active", async () => {
    const root = tempDirs.make("openclaw-health-overlap-");
    const { acquireRunLock, runPipeline } = require(helperPath) as {
      acquireRunLock: (stateRoot: string) => Promise<null | (() => Promise<void>)>;
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const release = await acquireRunLock(root);
    try {
      const runProbe = vi.fn();
      const result = await runPipeline({ stateRoot: root, probeIds: ["disk"], runProbe });
      expect(result).toMatchObject({ status: "overlap", done: 0, remaining: 1 });
      expect(runProbe).not.toHaveBeenCalled();
    } finally {
      await release?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("a hung probe is physically terminated and returns an explicit partial", async () => {
    const root = tempDirs.make("openclaw-health-hung-");
    const pidFile = path.join(root, "descendant.pid");
    const probePath = path.join(root, "hung-probe.sh");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    let descendantPid = 0;
    try {
      await fs.writeFile(
        probePath,
        [
          "#!/usr/bin/env bash",
          "set -u",
          'pid_file="$3"',
          "sleep 9999 &",
          'child_pid="$!"',
          'printf \'%s\\n\' "$child_pid" > "$pid_file"',
          'trap \'kill "$child_pid" 2>/dev/null; wait "$child_pid" 2>/dev/null; exit 143\' TERM INT HUP',
          'wait "$child_pid"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const startedAt = Date.now();
      const result = await runPipeline({
        stateRoot: path.join(root, "state"),
        probeIds: ["hung"],
        probeTimeoutMs: 250,
        budgetMs: 800,
        finalizationReserveMs: 100,
        snapshotPath: probePath,
        probeArgs: [pidFile],
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(result).toMatchObject({
        status: "partial",
        cursor: 0,
        remaining: 1,
        attempts: { hung: 1 },
      });
      descendantPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      for (let attempt = 0; attempt < 50 && descendantPid > 0; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        } catch {
          descendantPid = 0;
        }
      }
      expect(descendantPid).toBe(0);
    } finally {
      if (descendantPid > 0) {
        process.kill(descendantPid, "SIGKILL");
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("dead-letters a permanently failed probe only after three visible attempts", async () => {
    const root = tempDirs.make("openclaw-health-dead-letter-");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const runProbe = vi.fn().mockResolvedValue({ status: "error", findings: ["disk: failed"] });
    try {
      const first = await runPipeline({ stateRoot: root, probeIds: ["disk"], runProbe });
      const second = await runPipeline({ stateRoot: root, probeIds: ["disk"], runProbe });
      const third = await runPipeline({ stateRoot: root, probeIds: ["disk"], runProbe });
      expect(first).toMatchObject({ status: "partial", cursor: 0, attempts: { disk: 1 } });
      expect(second).toMatchObject({ status: "partial", cursor: 0, attempts: { disk: 2 } });
      expect(third).toMatchObject({
        status: "degraded",
        cursor: 1,
        remaining: 0,
        attempts: { disk: 3 },
        deadLetters: [{ probeId: "disk", attempts: 3 }],
      });
      expect(runProbe).toHaveBeenCalledTimes(3);

      runProbe.mockResolvedValueOnce({ status: "ok", findings: [] });
      const nextSweep = await runPipeline({ stateRoot: root, probeIds: ["disk"], runProbe });
      expect(nextSweep).toMatchObject({
        status: "ok",
        cursor: 1,
        remaining: 0,
        attempts: {},
        deadLetters: [],
      });
      expect(runProbe).toHaveBeenCalledTimes(4);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("checkpoints a PM2 baseline before commit and resumes the commit idempotently", async () => {
    const root = tempDirs.make("openclaw-health-pm2-");
    const stateRoot = path.join(root, "state");
    const pm2StatePath = path.join(root, "pm2-state.json");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const candidate = Buffer.from(
      JSON.stringify({ captured_at: "2026-08-12T00:00:00Z", processes: [] }),
    ).toString("base64");
    const runProbe = vi.fn().mockResolvedValue({
      status: "ok",
      findings: [],
      commit: { kind: "pm2-state", path: pm2StatePath, base64: candidate },
    });
    const failedCommitIo = {
      mkdir: fs.mkdir.bind(fs),
      rename: fs.rename.bind(fs),
      writeFile: vi.fn().mockRejectedValue(new Error("simulated owner crash before commit")),
    };
    try {
      const first = await runPipeline({
        stateRoot,
        probeIds: ["pm2"],
        runProbe,
        commitIo: failedCommitIo,
      });
      expect(first).toMatchObject({ status: "partial", cursor: 0, remaining: 1 });
      const interrupted = JSON.parse(
        await fs.readFile(path.join(stateRoot, "checkpoint.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(interrupted).toMatchObject({
        cursor: 0,
        pendingCommit: { probeId: "pm2", kind: "pm2-state", path: pm2StatePath },
      });
      await expect(fs.access(pm2StatePath)).rejects.toThrow();

      const resumedProbe = vi.fn();
      const second = await runPipeline({
        stateRoot,
        probeIds: ["pm2"],
        runProbe: resumedProbe,
      });
      expect(second).toMatchObject({ status: "ok", cursor: 1, remaining: 0 });
      expect(resumedProbe).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(pm2StatePath, "utf8"))).toEqual({
        captured_at: "2026-08-12T00:00:00Z",
        processes: [],
      });

      const nextSweepProbe = vi.fn().mockResolvedValue({ status: "ok", findings: [] });
      const third = await runPipeline({
        stateRoot,
        probeIds: ["pm2"],
        runProbe: nextSweepProbe,
      });
      expect(third).toMatchObject({ status: "ok", cursor: 1, remaining: 0 });
      expect(nextSweepProbe).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("bounds a permanent PM2 commit failure, advances tail probes, and retries next sweep", async () => {
    const root = tempDirs.make("openclaw-health-pm2-deferred-");
    const stateRoot = path.join(root, "state");
    const pm2StatePath = path.join(root, "pm2-state.json");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const candidateValue = { captured_at: "deferred", processes: [] };
    const candidate = Buffer.from(JSON.stringify(candidateValue)).toString("base64");
    const runProbe = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok",
        findings: [],
        commit: { kind: "pm2-state", path: pm2StatePath, base64: candidate },
      })
      .mockResolvedValue({ status: "ok", findings: [] });
    const failedCommitIo = {
      mkdir: fs.mkdir.bind(fs),
      rename: fs.rename.bind(fs),
      writeFile: vi.fn().mockRejectedValue(new Error("permanent commit failure")),
    };
    const options = {
      stateRoot,
      probeIds: ["pm2", "disk"],
      batchSize: 2,
      runProbe,
      commitIo: failedCommitIo,
    };
    await runPipeline(options);
    await runPipeline(options);
    const third = await runPipeline(options);
    expect(third).toMatchObject({
      status: "degraded",
      cursor: 2,
      remaining: 0,
      deadLetters: [{ probeId: "pm2", attempts: 3 }],
    });
    expect(runProbe).toHaveBeenCalledTimes(2);
    const finalized = JSON.parse(
      await fs.readFile(path.join(stateRoot, "checkpoint.json"), "utf8"),
    ) as {
      deferredCommit: { base64: string };
      errors: string[];
    };
    expect(finalized.deferredCommit.base64).toBe(candidate);
    expect(finalized.errors).toHaveLength(3);
    expect((await fs.stat(path.join(stateRoot, "checkpoint.json"))).size).toBeLessThan(10_000);
    await expect(fs.access(pm2StatePath)).rejects.toThrow();

    const nextSweep = await runPipeline({
      stateRoot,
      probeIds: ["pm2", "disk"],
      batchSize: 2,
      runProbe,
    });
    expect(nextSweep).toMatchObject({ status: "ok", cursor: 2, remaining: 0, deadLetters: [] });
    expect(JSON.parse(await fs.readFile(pm2StatePath, "utf8"))).toEqual(candidateValue);
    expect(runProbe).toHaveBeenCalledTimes(4);
  });

  test.each([
    ["stopped", "HEALTH|critical|pm2|status_not_online|api status=stopped"],
    ["errored", "HEALTH|critical|pm2|status_not_online|api status=errored"],
    ["missing exec", "HEALTH|critical|pm2|script_missing|api exec_path=/home/dev/missing"],
    ["ambiguous", "HEALTH|bogus|pm2|status_not_online|api"],
  ])("does not commit the PM2 baseline for %s output", async (_label, healthLine) => {
    const root = tempDirs.make("openclaw-health-pm2-critical-");
    const snapshotPath = path.join(root, "snapshot.sh");
    const pm2StatePath = path.join(root, "pm2-state.json");
    const candidate = Buffer.from(JSON.stringify({ captured_at: "now", processes: [] })).toString(
      "base64",
    );
    await fs.writeFile(
      snapshotPath,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' '${healthLine}'`,
        `printf '%s\\n' 'PM2_STATE_CANDIDATE|${candidate}'`,
        "printf '%s\\n' 'HEALTH|ok|pm2|snapshot_complete|candidate_ready'",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const result = await runPipeline({
      stateRoot: path.join(root, "state"),
      pm2StatePath,
      probeIds: ["pm2"],
      snapshotPath,
    });
    expect(result).toMatchObject({ status: "critical", cursor: 1, remaining: 0 });
    await expect(fs.access(pm2StatePath)).rejects.toThrow();
  });

  test("commits a healthy PM2 candidate and advances a warning restart baseline", async () => {
    const root = tempDirs.make("openclaw-health-pm2-warning-");
    const snapshotPath = path.join(root, "snapshot.sh");
    const pm2StatePath = path.join(root, "pm2-state.json");
    const value = { captured_at: "now", processes: [] };
    const candidate = Buffer.from(JSON.stringify(value)).toString("base64");
    await fs.writeFile(
      snapshotPath,
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' 'HEALTH|warning|pm2|restart_delta_warning|api delta=3'",
        `printf '%s\\n' 'PM2_STATE_CANDIDATE|${candidate}'`,
        "printf '%s\\n' 'HEALTH|ok|pm2|snapshot_complete|candidate_ready'",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const result = await runPipeline({
      stateRoot: path.join(root, "state"),
      pm2StatePath,
      probeIds: ["pm2"],
      snapshotPath,
    });
    expect(result).toMatchObject({ status: "warning", cursor: 1, remaining: 0 });
    expect(JSON.parse(await fs.readFile(pm2StatePath, "utf8"))).toEqual(value);
  });

  test("a slow checkpoint sink stays inside the global deadline", async () => {
    const root = tempDirs.make("openclaw-health-sink-");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const slowWrite = vi.fn(
      async (_filePath: string, _data: string, _options: { signal?: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        }),
    );
    try {
      const startedAt = Date.now();
      const result = await runPipeline({
        stateRoot: root,
        probeIds: ["disk"],
        budgetMs: 250,
        finalizationReserveMs: 50,
        runProbe: vi.fn().mockResolvedValue({ status: "ok", findings: [] }),
        checkpointIo: {
          mkdir: fs.mkdir.bind(fs),
          readFile: fs.readFile.bind(fs),
          rename: fs.rename.bind(fs),
          writeFile: slowWrite,
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(750);
      expect(result).toMatchObject({ status: "partial" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform !== "win32")(
    "releases the singleton after the owner crashes",
    async () => {
      const root = tempDirs.make("openclaw-health-owner-");
      const readyPath = path.join(root, "ready");
      const ownerPath = path.join(root, "lock-owner.cjs");
      await fs.writeFile(
        ownerPath,
        [
          'const fs = require("node:fs/promises");',
          "const [, , helperPath, stateRoot, readyPath] = process.argv;",
          "const { acquireRunLock } = require(helperPath);",
          "void (async () => {",
          "  const release = await acquireRunLock(stateRoot);",
          '  if (!release) throw new Error("lock already held");',
          "  await fs.writeFile(readyPath, String(process.pid), { mode: 0o600 });",
          "  setInterval(() => {}, 1000);",
          "})();",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const child = spawn(process.execPath, [ownerPath, helperPath, root, readyPath], {
        detached: true,
        stdio: "ignore",
      });
      try {
        await waitForFile(readyPath);
        process.kill(child.pid!, "SIGKILL");
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
        const { acquireRunLock } = require(helperPath) as {
          acquireRunLock: (stateRoot: string) => Promise<null | (() => Promise<void>)>;
        };
        let release: null | (() => Promise<void>) = null;
        for (let attempt = 0; attempt < 50 && !release; attempt += 1) {
          release = await acquireRunLock(root);
          if (!release) {
            await new Promise((resolve) => {
              setTimeout(resolve, 20);
            });
          }
        }
        expect(release).toBeTypeOf("function");
        await release?.();
      } finally {
        try {
          process.kill(child.pid!, "SIGKILL");
        } catch {
          // The owner already exited.
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
