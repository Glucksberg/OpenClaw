import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const logger = { info: vi.fn(), warn: vi.fn() };

describe("required memory consolidation", () => {
  it("keeps a failed group unpromoted for the next-cycle retry", async () => {
    const workspaceDir = await createTempWorkspace("memory-consolidation-required-retry-");
    const notePath = path.join(workspaceDir, "memory", "2026-07-01.md");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "User prefers green tea.\n", "utf8");
    const nowMs = Date.parse("2026-07-02T10:00:00.000Z");
    await recordShortTermRecalls({
      workspaceDir,
      query: "tea preference",
      results: [
        {
          path: "memory/2026-07-01.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "User prefers green tea.",
          source: "memory",
          provenance: {
            originClass: "agent",
            sessionKind: "interactive",
            observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
          },
        },
      ],
      nowMs,
    });
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    const subagent = {
      run: vi.fn(async () => ({ runId: "run-1" })),
      waitForRun: vi.fn(async () => ({ status: "error" })),
      getSessionMessages: vi.fn(async () => ({ messages: [] })),
      deleteSession: vi.fn(async () => undefined),
    };
    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      consolidation: { subagent, requireSuccess: true, logger },
      nowMs,
    });

    expect(subagent.run).toHaveBeenCalledOnce();
    expect(applied).toMatchObject({
      applied: 0,
      consolidationAttempted: true,
      consolidationSucceeded: false,
    });
    await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const retryCandidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    expect(retryCandidates.map((entry) => entry.key)).toEqual(candidates.map((entry) => entry.key));
  });
});
