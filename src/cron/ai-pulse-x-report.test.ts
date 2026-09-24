import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseCodeModeScriptSyntax } from "../agents/code-mode-script-syntax.js";

const require = createRequire(import.meta.url);
const helperPath = path.resolve(
  import.meta.dirname,
  "../../scripts/operations/ai-pulse-x-report.cjs",
);

type Tweet = {
  id: string;
  text: string;
  createdAt: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  author: { username: string };
};

function tweet(id: string, text = `AI update ${id}`): Tweet {
  return {
    id,
    text,
    createdAt: "2026-08-11T20:00:00.000Z",
    likeCount: 30,
    retweetCount: 10,
    replyCount: 5,
    author: { username: `source_${id}` },
  };
}

async function loadDefinition() {
  const source = await fs.readFile(
    path.resolve(import.meta.dirname, "../../scripts/operations/ai-pulse-x-report.script"),
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

describe("bounded AI Pulse X report", () => {
  test("native definition uses one bounded helper call and returns explicit checkpoint state", async () => {
    const { source, definition } = await loadDefinition();
    expect(parseCodeModeScriptSyntax(source)).toMatchObject({ ok: true });
    const call = vi.fn().mockResolvedValue({
      result: {
        details: {
          aggregated: JSON.stringify({
            status: "partial",
            runId: "2026-08-11T2000Z",
            report: "AI Pulse partial: 2/5 topics",
            cursor: 2,
            done: 2,
            remaining: 3,
            errors: ["models: timed out"],
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
        command: expect.stringContaining("ai-pulse-x-report.cjs"),
        timeoutSeconds: 210,
        workdir: "/home/dev/.openclaw/workspace-code-reviewer",
      }),
    );
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty("timeout");
    expect(output.notify).toContain("partial");
    expect(output.state).toMatchObject({ cursor: 2, done: 2, remaining: 3 });
  });

  test("pipeline checkpoints finite batches, deduplicates URLs, and resumes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-"));
    const archiveRoot = path.join(root, "archive");
    const stateRoot = path.join(root, "state");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const search = vi
      .fn()
      .mockResolvedValueOnce([tweet("1"), tweet("same")])
      .mockResolvedValueOnce([tweet("2"), tweet("same")])
      .mockResolvedValueOnce([tweet("3")])
      .mockResolvedValueOnce([tweet("4")])
      .mockResolvedValueOnce([tweet("5")]);

    const first = await runPipeline({
      archiveRoot,
      stateRoot,
      runId: "2026-08-11T2000Z",
      batchSize: 2,
      search,
    });
    expect(first).toMatchObject({ status: "partial", cursor: 2, done: 2, remaining: 3 });

    const second = await runPipeline({
      archiveRoot,
      stateRoot,
      runId: "2026-08-11T2000Z",
      batchSize: 5,
      search,
    });
    expect(second).toMatchObject({ status: "complete", cursor: 5, done: 5, remaining: 0 });
    expect(search).toHaveBeenCalledTimes(5);

    const daily = await fs.readFile(
      path.join(archiveRoot, "daily", "2026-08-11T2000Z.jsonl"),
      "utf8",
    );
    const urls = daily
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { url: string }).url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain("https://x.com/source_1/status/1");
    await fs.rm(root, { recursive: true, force: true });
  });

  test("OS lock returns overlap without running a search", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-lock-"));
    const stateRoot = path.join(root, "state");
    const { acquireRunLock, runPipeline } = require(helperPath) as {
      acquireRunLock: (stateRoot: string) => Promise<null | (() => Promise<void>)>;
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const release = await acquireRunLock(stateRoot);
    expect(release).toBeTypeOf("function");
    try {
      const search = vi.fn();
      const output = await runPipeline({
        archiveRoot: path.join(root, "archive"),
        stateRoot,
        search,
      });
      expect(output).toMatchObject({ status: "overlap", remaining: 5 });
      expect(search).not.toHaveBeenCalled();
    } finally {
      await release?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("atomic singleton admits exactly one owner across 120 concurrent pairs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-race-"));
    const { acquireRunLock } = require(helperPath) as {
      acquireRunLock: (stateRoot: string) => Promise<null | (() => Promise<void>)>;
    };
    try {
      for (let pair = 0; pair < 120; pair += 1) {
        const stateRoot = path.join(root, String(pair));
        const owners = await Promise.all([acquireRunLock(stateRoot), acquireRunLock(stateRoot)]);
        expect(owners.filter(Boolean)).toHaveLength(1);
        await Promise.all(owners.map(async (release) => release?.()));
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("global deadline checkpoints a hung search and the next run resumes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-deadline-"));
    const archiveRoot = path.join(root, "archive");
    const stateRoot = path.join(root, "state");
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const hungSearch = vi.fn(() => new Promise(() => {}));
    const startedAt = Date.now();
    const first = await runPipeline({
      archiveRoot,
      stateRoot,
      runId: "2026-08-11T2100Z",
      budgetMs: 200,
      finalizationReserveMs: 50,
      search: hungSearch,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(first).toMatchObject({ status: "partial", cursor: 0, remaining: 5 });
    expect(hungSearch).toHaveBeenCalledTimes(1);

    const resumedSearch = vi.fn().mockResolvedValue([]);
    const second = await runPipeline({
      archiveRoot,
      stateRoot,
      batchSize: 1,
      search: resumedSearch,
    });
    expect(second).toMatchObject({ runId: "2026-08-11T2100Z", cursor: 1, remaining: 4 });
    expect(resumedSearch).toHaveBeenCalledTimes(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  test("slow archive sink returns within the global deadline and resumes idempotently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-slow-sink-"));
    const archiveRoot = path.join(root, "archive");
    const stateRoot = path.join(root, "state");
    const runId = "2026-08-11T2150Z";
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const slowAppend = vi.fn(
      async (filePath: string, data: string, options: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 300);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const error = new Error("aborted slow sink");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        await fs.appendFile(filePath, data);
      },
    );
    const search = vi.fn().mockResolvedValue([tweet("99")]);
    const startedAt = performance.now();
    const first = await runPipeline({
      archiveRoot,
      stateRoot,
      runId,
      batchSize: 5,
      budgetMs: 250,
      finalizationReserveMs: 100,
      search,
      archiveIo: {
        mkdir: fs.mkdir.bind(fs),
        readFile: fs.readFile.bind(fs),
        appendFile: slowAppend,
      },
    });
    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeLessThan(500);
    expect(first).toMatchObject({ status: "partial", cursor: 5, remaining: 0 });
    expect(slowAppend).toHaveBeenCalledTimes(1);
    const interrupted = JSON.parse(
      await fs.readFile(path.join(stateRoot, "checkpoint.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(interrupted).toMatchObject({
      runId,
      phase: "archiving",
      archiveComplete: false,
      finalized: false,
    });

    const resumedSearch = vi.fn();
    const second = await runPipeline({ archiveRoot, stateRoot, search: resumedSearch });
    expect(second).toMatchObject({ status: "complete", runId, cursor: 5, remaining: 0 });
    expect(resumedSearch).not.toHaveBeenCalled();
    const daily = await fs.readFile(path.join(archiveRoot, "daily", `${runId}.jsonl`), "utf8");
    const index = await fs.readFile(path.join(archiveRoot, "index", "stories.jsonl"), "utf8");
    expect(daily.trim().split("\n")).toHaveLength(1);
    expect(index.trim().split("\n")).toHaveLength(1);
    await fs.rm(root, { recursive: true, force: true });
  });

  test("resumes a fully collected checkpoint and reconciles both archive sinks once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-archive-"));
    const archiveRoot = path.join(root, "archive");
    const stateRoot = path.join(root, "state");
    const runId = "2026-08-11T2200Z";
    const story = {
      run_id: runId,
      published_at_utc: "2026-08-11T20:00:00.000Z",
      source: "x",
      url: "https://x.com/source_9/status/9",
      handle: "@source_9",
      summary: "AI update 9",
      theme: "models",
      impact: "medium",
      confidence: "x-chatter",
      why_it_matters: "Public X signal in the models watch batch.",
      relevance_to_markus_openclaw: "Potentially relevant to OpenClaw agent and model operations.",
      score: 55,
    };
    await fs.mkdir(path.join(stateRoot), { recursive: true });
    await fs.mkdir(path.join(archiveRoot, "daily"), { recursive: true });
    await fs.writeFile(
      path.join(stateRoot, "checkpoint.json"),
      `${JSON.stringify({
        version: 2,
        runId,
        cursor: 5,
        candidates: [story],
        archiveStories: [story],
        archivedUrls: [],
        failures: [],
        remaining: 0,
        phase: "archiving",
        archiveComplete: false,
        finalized: false,
      })}\n`,
    );
    // Simulate process death after the daily append but before the index append/checkpoint.
    const archivedStory = { ...story } as Record<string, unknown>;
    delete archivedStory.score;
    await fs.writeFile(
      path.join(archiveRoot, "daily", `${runId}.jsonl`),
      `${JSON.stringify(archivedStory)}\n`,
    );
    const { runPipeline } = require(helperPath) as {
      runPipeline: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const search = vi.fn();
    const output = await runPipeline({ archiveRoot, stateRoot, search });
    expect(output).toMatchObject({ runId, status: "complete", cursor: 5, remaining: 0 });
    expect(search).not.toHaveBeenCalled();

    const daily = await fs.readFile(path.join(archiveRoot, "daily", `${runId}.jsonl`), "utf8");
    const index = await fs.readFile(path.join(archiveRoot, "index", "stories.jsonl"), "utf8");
    expect(daily.trim().split("\n")).toHaveLength(1);
    expect(index.trim().split("\n")).toHaveLength(1);
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(stateRoot, "checkpoint.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(checkpoint).toMatchObject({
      phase: "complete",
      archiveComplete: true,
      finalized: true,
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  test.runIf(process.platform !== "win32")(
    "releases the singleton when the owner process is killed",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ai-pulse-dead-owner-"));
      const stateRoot = path.join(root, "state");
      const readyPath = path.join(root, "ready");
      const child = spawn(
        process.execPath,
        [helperPath, "--hold-lock-ready", readyPath, "--state-root", stateRoot],
        { detached: true, stdio: "ignore" },
      );
      try {
        await waitForFile(readyPath);
        expect(child.pid).toBeGreaterThan(0);
        process.kill(child.pid!, "SIGKILL");
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });

        const { acquireRunLock } = require(helperPath) as {
          acquireRunLock: (stateRoot: string) => Promise<null | (() => Promise<void>)>;
        };
        let release: null | (() => Promise<void>) = null;
        for (let attempt = 0; attempt < 50 && !release; attempt += 1) {
          release = await acquireRunLock(stateRoot);
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
          // The child already exited.
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "physically kills a detached helper process group",
    async () => {
      const { killProcessGroup } = require(helperPath) as {
        killProcessGroup: (pid: number, signal?: NodeJS.Signals) => void;
      };
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      let childPid = child.pid ?? 0;
      try {
        expect(childPid).toBeGreaterThan(0);
        killProcessGroup(childPid, "SIGTERM");
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            process.kill(childPid, 0);
          } catch {
            childPid = 0;
            break;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
        expect(childPid).toBe(0);
      } finally {
        if (childPid > 0) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );
});
