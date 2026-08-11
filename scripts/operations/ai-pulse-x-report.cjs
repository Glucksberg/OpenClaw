#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const DEFAULT_ARCHIVE_ROOT =
  process.env.AI_PULSE_ARCHIVE_ROOT ??
  "/home/dev/.openclaw/workspace-code-reviewer/tasks/ai-pulse/archive";
const DEFAULT_STATE_ROOT =
  process.env.AI_PULSE_STATE_ROOT ?? "/home/dev/.openclaw/cron/bounded-ai-pulse";
const SEARCH_TIMEOUT_MS = 25_000;
const SEARCH_OUTPUT_MAX_BYTES = 1_000_000;
const PIPELINE_BUDGET_MS = 175_000;
const FINALIZATION_RESERVE_MS = 10_000;
const activeProcessGroups = new Set();

const topics = [
  {
    key: "news",
    theme: "other",
    query: "AI lang:en min_faves:50 -filter:replies",
  },
  {
    key: "labs",
    theme: "models",
    query:
      "(from:OpenAI OR from:AnthropicAI OR from:GoogleDeepMind OR from:MetaAI) -filter:replies",
  },
  {
    key: "models",
    theme: "models",
    query: '(LLM OR "AI model" OR reasoning) lang:en min_faves:25 -filter:replies',
  },
  {
    key: "agents",
    theme: "agents",
    query: '("AI agent" OR agentic OR "coding agent") lang:en min_faves:25 -filter:replies',
  },
  {
    key: "business",
    theme: "business",
    query: '("AI startup" OR "AI funding" OR "AI revenue") lang:en min_faves:10 -filter:replies',
  },
];

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
      // The child already exited.
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

function safeError(error) {
  return String(error?.message ?? error)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function utcRunId(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 13)}${iso.slice(14, 16)}Z`;
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

async function boundedIo(deadline, operation) {
  if (!Number.isFinite(deadline)) {
    return await operation(undefined);
  }
  const timeoutMs = remainingBudgetMs(deadline);
  if (timeoutMs <= 0) {
    throw deadlineError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw deadlineError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function writeJsonAtomic(filePath, value, deadline = Number.POSITIVE_INFINITY) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await boundedIo(deadline, (signal) =>
    fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, signal }),
  );
  if (remainingBudgetMs(deadline) <= 0) {
    throw deadlineError();
  }
  await fs.rename(temporary, filePath);
}

async function readJson(filePath, deadline = Number.POSITIVE_INFINITY) {
  try {
    return JSON.parse(
      await boundedIo(deadline, (signal) => fs.readFile(filePath, { encoding: "utf8", signal })),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
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
  if (Number.isInteger(child.pid)) {
    activeProcessGroups.add(child.pid);
  }
  child.stdin.on("error", () => {
    // A concurrent non-owner can exit before stdin is observed by the parent.
  });

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
    const acquisitionTimer = setTimeout(() => {
      if (!acquired) {
        killProcessGroup(child.pid, "SIGKILL");
        reject(new Error("timed out while acquiring AI Pulse singleton lock"));
      }
    }, 5_000);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-240);
    });
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-32);
      if (acquired || !stdout.includes("acquired")) {
        return;
      }
      acquired = true;
      clearTimeout(acquisitionTimer);
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
    child.on("error", (error) => {
      clearTimeout(acquisitionTimer);
      reject(error);
    });
    exited.then(() => {
      clearTimeout(acquisitionTimer);
      if (acquired) {
        return;
      }
      if (exitResult?.code === 75) {
        resolve(null);
        return;
      }
      reject(
        new Error(
          `flock exited ${exitResult?.code ?? exitResult?.signal}: ${stderr || "no diagnostic"}`,
        ),
      );
    });
  });
}

function runBirdSearch(query, options = {}) {
  const timeoutMs = Math.min(
    SEARCH_TIMEOUT_MS,
    parsePositiveInteger(options.timeoutMs, SEARCH_TIMEOUT_MS),
  );
  const birdTimeoutMs = Math.max(1_000, timeoutMs - 1_000);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bird",
      ["--timeout", String(birdTimeoutMs), "search", "-n", "8", "--json", query],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (Number.isInteger(child.pid)) {
      activeProcessGroups.add(child.pid);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      killProcessGroup(child.pid, "SIGTERM");
      setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 100).unref();
      finish(new Error("bird search timed out"));
    }, timeoutMs);
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > SEARCH_OUTPUT_MAX_BYTES) {
        killProcessGroup(child.pid, "SIGTERM");
        setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 100).unref();
        finish(new Error("bird output exceeded the bounded capture limit"));
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        finish(new Error(`bird exited ${code ?? signal}: ${stderr.slice(0, 160)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        finish(null, Array.isArray(parsed) ? parsed : []);
      } catch {
        finish(new Error("bird returned invalid JSON"));
      }
    });
  });
}

function deadlineError() {
  const error = new Error("pipeline deadline reached; checkpoint preserved for resume");
  error.code = "AI_PULSE_DEADLINE";
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("search attempt timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function searchWithRetry(query, search, deadline, finalizationReserveMs) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const availableMs = remainingBudgetMs(deadline) - finalizationReserveMs;
    if (availableMs <= 0) {
      throw deadlineError();
    }
    const attemptTimeoutMs = Math.min(SEARCH_TIMEOUT_MS, availableMs);
    try {
      return await withTimeout(
        Promise.resolve(search(query, { timeoutMs: Math.max(1, attemptTimeoutMs - 100) })),
        attemptTimeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (remainingBudgetMs(deadline) <= finalizationReserveMs) {
        throw deadlineError();
      }
      if (attempt < 2) {
        const backoffMs = Math.min(1_000, remainingBudgetMs(deadline) - finalizationReserveMs);
        if (backoffMs <= 0) {
          throw deadlineError();
        }
        await new Promise((resolve) => {
          setTimeout(resolve, backoffMs);
        });
      }
    }
  }
  throw lastError;
}

function usernameOf(item) {
  const author = item?.author;
  const value =
    (author && typeof author === "object"
      ? (author.username ?? author.userName ?? author.screenName ?? author.handle)
      : author) ??
    item?.username ??
    item?.userName ??
    "unknown";
  return (
    String(value)
      .replace(/^@/u, "")
      .replace(/[^a-zA-Z0-9_]/gu, "")
      .slice(0, 32) || "unknown"
  );
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280);
}

function normalizeTweet(item, topic, runId) {
  const id = String(item?.id ?? "").replace(/\D/gu, "");
  const summary = normalizeText(item?.text);
  if (!id || !summary) {
    return null;
  }
  const username = usernameOf(item);
  const engagement =
    Number(item?.likeCount ?? 0) +
    2 * Number(item?.retweetCount ?? 0) +
    Number(item?.replyCount ?? 0);
  return {
    run_id: runId,
    published_at_utc: new Date(item?.createdAt ?? Date.now()).toISOString(),
    source: "x",
    url: `https://x.com/${username}/status/${id}`,
    handle: `@${username}`,
    summary,
    theme: topic.theme,
    impact: engagement >= 100 ? "high" : "medium",
    confidence: "x-chatter",
    why_it_matters: `Public X signal in the ${topic.key} watch batch.`,
    relevance_to_markus_openclaw:
      topic.key === "agents" || topic.key === "models"
        ? "Potentially relevant to OpenClaw agent and model operations."
        : "Included in the bounded AI ecosystem watch.",
    score: engagement,
  };
}

async function readArchiveRecords(filePath, deadline = Number.POSITIVE_INFINITY, io = fs) {
  let content = "";
  const urls = new Set();
  const keys = new Set();
  try {
    content = await boundedIo(deadline, (signal) =>
      io.readFile(filePath, { encoding: "utf8", signal }),
    );
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item.url) {
          const url = String(item.url);
          urls.add(url);
          keys.add(`${String(item.run_id ?? "")}\u0000${url}`);
        }
      } catch {
        // Historical malformed lines do not block a fresh bounded report.
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { content, keys, urls };
}

function archiveKey(story) {
  return `${String(story.run_id ?? "")}\u0000${String(story.url ?? "")}`;
}

async function reconcileSink(filePath, stories, deadline, io) {
  await boundedIo(deadline, () => io.mkdir(path.dirname(filePath), { recursive: true }));
  const before = await readArchiveRecords(filePath, deadline, io);
  const missing = stories.filter((story) => !before.keys.has(archiveKey(story)));
  if (missing.length > 0) {
    const separator = before.content.length > 0 && !before.content.endsWith("\n") ? "\n" : "";
    const lines = missing.map(({ score: _score, ...story }) => JSON.stringify(story)).join("\n");
    await boundedIo(deadline, (signal) =>
      io.appendFile(filePath, `${separator}${lines}\n`, { mode: 0o600, signal }),
    );
  }
  const after = await readArchiveRecords(filePath, deadline, io);
  const absent = stories.filter((story) => !after.keys.has(archiveKey(story)));
  if (absent.length > 0) {
    throw new Error(`archive verification failed for ${path.basename(filePath)}`);
  }
}

async function planArchiveStories(checkpoint, indexPath, deadline, io) {
  const existingIndex = await readArchiveRecords(indexPath, deadline, io);
  const planned = Array.isArray(checkpoint.archiveStories) ? checkpoint.archiveStories : [];
  const plannedUrls = new Set(planned.map((story) => story.url));
  for (const story of checkpoint.candidates) {
    if (!plannedUrls.has(story.url) && !existingIndex.urls.has(story.url)) {
      planned.push(story);
      plannedUrls.add(story.url);
    }
  }
  checkpoint.archiveStories = planned;
}

async function reconcileArchive(archiveRoot, checkpoint, checkpointPath, deadline, io = fs) {
  const runId = checkpoint.runId;
  const dailyDir = path.join(archiveRoot, "daily");
  const indexDir = path.join(archiveRoot, "index");
  const dailyPath = path.join(dailyDir, `${runId}.jsonl`);
  const indexPath = path.join(indexDir, "stories.jsonl");
  await boundedIo(deadline, () => io.mkdir(dailyDir, { recursive: true }));
  await boundedIo(deadline, () => io.mkdir(indexDir, { recursive: true }));
  await planArchiveStories(checkpoint, indexPath, deadline, io);
  checkpoint.phase = "archiving";
  checkpoint.archiveComplete = false;
  checkpoint.dailyComplete = false;
  checkpoint.indexComplete = false;
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonAtomic(checkpointPath, checkpoint, deadline);

  await reconcileSink(dailyPath, checkpoint.archiveStories, deadline, io);
  checkpoint.dailyComplete = true;
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonAtomic(checkpointPath, checkpoint, deadline);

  await reconcileSink(indexPath, checkpoint.archiveStories, deadline, io);
  checkpoint.indexComplete = true;
  checkpoint.archiveComplete = true;
  checkpoint.archivedUrls = checkpoint.archiveStories.map((story) => story.url);
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonAtomic(checkpointPath, checkpoint, deadline);
}

function buildReport(checkpoint) {
  const status =
    checkpoint.remaining === 0 && checkpoint.failures.length === 0 && checkpoint.archiveComplete
      ? "complete"
      : "partial";
  const top = checkpoint.candidates.toSorted((left, right) => right.score - left.score).slice(0, 8);
  const lines = [
    `🗞️ AI Pulse — X News Report`,
    `Run ${checkpoint.runId} · ${status} · topics ${checkpoint.cursor}/${topics.length} · errors ${checkpoint.failures.length}`,
    "",
  ];
  if (top.length === 0) {
    lines.push("No usable public X stories were collected in this bounded batch.");
  } else {
    lines.push("Top public X signals:");
    for (const story of top) {
      lines.push(`- ${story.summary} — ${story.handle} (${story.url})`);
    }
  }
  if (checkpoint.remaining > 0 || checkpoint.failures.length > 0) {
    lines.push(
      "",
      `Partial checkpoint: cursor=${checkpoint.cursor}, remaining=${checkpoint.remaining}. The same payload can resume without duplicating archived URLs.`,
    );
    for (const failure of checkpoint.failures.slice(-5)) {
      lines.push(`- ${failure}`);
    }
  }
  return lines.join("\n").slice(0, 12_000);
}

async function runPipeline(options = {}) {
  const budgetMs = Math.max(
    50,
    Math.min(PIPELINE_BUDGET_MS, parsePositiveInteger(options.budgetMs, PIPELINE_BUDGET_MS)),
  );
  const deadline = performance.now() + budgetMs;
  const archiveRoot = options.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT;
  const checkpointPath = path.join(stateRoot, "checkpoint.json");
  const releaseLock = await acquireRunLock(stateRoot);
  if (!releaseLock) {
    const checkpoint = await readJson(checkpointPath, deadline);
    const cursor = Number(checkpoint?.cursor ?? 0);
    return {
      status: "overlap",
      runId: checkpoint?.runId ?? null,
      report: `🗞️ AI Pulse — skipped overlapping execution; checkpoint cursor=${cursor}, remaining=${Math.max(0, topics.length - cursor)}.`,
      cursor,
      done: cursor,
      remaining: Math.max(0, topics.length - cursor),
      errors: ["singleton lock is held by another live execution"],
    };
  }

  try {
    const previous = await readJson(checkpointPath, deadline);
    const requestedRunId = options.runId;
    const resumePrevious = !requestedRunId && previous && previous.finalized !== true;
    const runId = requestedRunId ?? (resumePrevious ? previous.runId : utcRunId());
    const checkpoint = {
      version: 2,
      runId,
      cursor: 0,
      candidates: [],
      archiveStories: [],
      archivedUrls: [],
      failures: [],
      remaining: topics.length,
      phase: "collecting",
      archiveComplete: false,
      dailyComplete: false,
      indexComplete: false,
      finalized: false,
      ...(previous?.runId === runId ? previous : {}),
    };
    checkpoint.version = 2;
    checkpoint.candidates = Array.isArray(checkpoint.candidates) ? checkpoint.candidates : [];
    checkpoint.archiveStories = Array.isArray(checkpoint.archiveStories)
      ? checkpoint.archiveStories
      : [];
    checkpoint.archivedUrls = Array.isArray(checkpoint.archivedUrls) ? checkpoint.archivedUrls : [];
    checkpoint.failures = Array.isArray(checkpoint.failures) ? checkpoint.failures : [];
    checkpoint.finalized = false;
    checkpoint.phase = "collecting";
    const search = options.search ?? runBirdSearch;
    const finalizationReserveMs = Math.min(
      30_000,
      Math.max(25, budgetMs - 25),
      parsePositiveInteger(options.finalizationReserveMs, FINALIZATION_RESERVE_MS),
    );
    const checkpointReserveMs = Math.min(
      2_000,
      Math.max(25, Math.floor(finalizationReserveMs / 2)),
    );
    const archiveDeadline = deadline - checkpointReserveMs;
    const batchSize = Math.min(
      topics.length,
      parsePositiveInteger(options.batchSize, topics.length),
    );
    const stopAt = Math.min(topics.length, checkpoint.cursor + batchSize);
    let deadlineReached = false;
    await writeJsonAtomic(checkpointPath, checkpoint, deadline);

    while (checkpoint.cursor < stopAt) {
      const topic = topics[checkpoint.cursor];
      try {
        const items = await searchWithRetry(topic.query, search, deadline, finalizationReserveMs);
        for (const item of Array.isArray(items) ? items : []) {
          const story = normalizeTweet(item, topic, runId);
          if (story && !checkpoint.candidates.some((candidate) => candidate.url === story.url)) {
            checkpoint.candidates.push(story);
          }
        }
      } catch (error) {
        if (error?.code === "AI_PULSE_DEADLINE") {
          deadlineReached = true;
          break;
        }
        checkpoint.failures.push(`${topic.key}: ${safeError(error)}`);
      }
      checkpoint.cursor += 1;
      checkpoint.remaining = topics.length - checkpoint.cursor;
      checkpoint.updatedAt = new Date().toISOString();
      await writeJsonAtomic(checkpointPath, checkpoint, deadline);
    }

    try {
      await reconcileArchive(
        archiveRoot,
        checkpoint,
        checkpointPath,
        archiveDeadline,
        options.archiveIo,
      );
    } catch (error) {
      if (error?.code !== "AI_PULSE_DEADLINE") {
        throw error;
      }
      deadlineReached = true;
      checkpoint.archiveComplete = false;
      checkpoint.finalized = false;
      checkpoint.phase = "archiving";
    }
    if (!deadlineReached) {
      checkpoint.finalized = checkpoint.remaining === 0;
      checkpoint.phase = checkpoint.finalized ? "complete" : "checkpointed";
      checkpoint.updatedAt = new Date().toISOString();
      try {
        await writeJsonAtomic(checkpointPath, checkpoint, deadline);
      } catch (error) {
        if (error?.code !== "AI_PULSE_DEADLINE") {
          throw error;
        }
        deadlineReached = true;
        checkpoint.finalized = false;
        checkpoint.phase = "archiving";
      }
    }
    const status =
      !deadlineReached &&
      checkpoint.remaining === 0 &&
      checkpoint.failures.length === 0 &&
      checkpoint.archiveComplete
        ? "complete"
        : "partial";
    const errors = checkpoint.failures.slice(-12);
    if (deadlineReached) {
      errors.push("pipeline deadline reached; checkpoint preserved for resume");
    }
    return {
      status,
      runId,
      report:
        remainingBudgetMs(deadline) > 0
          ? buildReport(checkpoint)
          : `🗞️ AI Pulse — partial checkpoint cursor=${checkpoint.cursor}, remaining=${checkpoint.remaining}; global deadline reached.`,
      cursor: checkpoint.cursor,
      done: checkpoint.cursor,
      remaining: checkpoint.remaining,
      errors,
      stories: checkpoint.archivedUrls.length,
    };
  } finally {
    await releaseLock();
  }
}

async function main() {
  if (process.argv[2] === "--timeout-probe") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await fs.writeFile(process.argv[3], String(child.pid));
    setInterval(() => {}, 1_000);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args["hold-lock-ready"]) {
    const releaseLock = await acquireRunLock(args["state-root"] ?? DEFAULT_STATE_ROOT);
    if (!releaseLock) {
      throw new Error("test lock is already held");
    }
    await fs.writeFile(args["hold-lock-ready"], String(process.pid), { mode: 0o600 });
    setInterval(() => {}, 1_000);
    return;
  }
  const output = await runPipeline({
    archiveRoot: args["archive-root"],
    stateRoot: args["state-root"],
    runId: args["run-id"],
    batchSize: args["batch-size"],
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = {
  acquireRunLock,
  buildReport,
  killProcessGroup,
  normalizeTweet,
  reconcileArchive,
  runBirdSearch,
  runPipeline,
  topics,
};

if (require.main === module) {
  installSignalHandlers();
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ status: "partial", report: "🗞️ AI Pulse — bounded runner failed before completion.", cursor: 0, done: 0, remaining: topics.length, errors: [safeError(error)] })}\n`,
    );
    process.exitCode = 1;
  });
}
