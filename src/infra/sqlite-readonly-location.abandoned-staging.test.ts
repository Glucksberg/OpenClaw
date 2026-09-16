import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  reclaimAbandonedSqliteSnapshotStaging,
  reclaimAbandonedSqliteSnapshotStagingOnce,
} from "./sqlite-readonly-location-cleanup.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

// A PID no live process can own, so the staging directory reads as abandoned.
const ABANDONED_OWNER_PID = 0x7fffffff;

function stage(stagingRoot: string, name: string): string {
  const directory = path.join(stagingRoot, name);
  fs.mkdirSync(path.join(directory, `openclaw-sqlite-readonly-${ABANDONED_OWNER_PID}-child`), {
    recursive: true,
  });
  fs.writeFileSync(path.join(directory, "database.sqlite"), "retained snapshot bytes");
  return directory;
}

describe("abandoned SQLite snapshot staging", () => {
  it("reclaims staging owned by a process that is gone", () => {
    const stagingRoot = tempDirs.make("sqlite-abandoned-staging-");
    const abandoned = stage(stagingRoot, `openclaw-sqlite-readonly-${ABANDONED_OWNER_PID}-aBcDeF`);

    expect(reclaimAbandonedSqliteSnapshotStaging(stagingRoot)).toBe(1);
    expect(fs.existsSync(abandoned)).toBe(false);
  });

  it("keeps staging owned by this process and unrelated entries", () => {
    const stagingRoot = tempDirs.make("sqlite-abandoned-staging-");
    const own = stage(stagingRoot, `openclaw-sqlite-readonly-${process.pid}-aBcDeF`);
    const unrelated = stage(stagingRoot, "openclaw-backup-staging-aBcDeF");
    const looseFile = path.join(stagingRoot, "openclaw-sqlite-readonly-1-not-a-directory");
    fs.writeFileSync(looseFile, "file, not staging");

    expect(reclaimAbandonedSqliteSnapshotStaging(stagingRoot)).toBe(0);
    expect(fs.existsSync(own)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(looseFile)).toBe(true);
  });

  it("keeps staging whose recycled owner cannot be signalled", () => {
    const stagingRoot = tempDirs.make("sqlite-abandoned-staging-");
    const foreign = stage(stagingRoot, `openclaw-sqlite-readonly-${ABANDONED_OWNER_PID}-aBcDeF`);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    expect(reclaimAbandonedSqliteSnapshotStaging(stagingRoot)).toBe(0);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("reports nothing for a staging root that does not exist", () => {
    const stagingRoot = path.join(tempDirs.make("sqlite-abandoned-staging-"), "absent");

    expect(reclaimAbandonedSqliteSnapshotStaging(stagingRoot)).toBe(0);
  });

  it("reads a staging root once per process", () => {
    const stagingRoot = tempDirs.make("sqlite-abandoned-staging-");
    const readStagingRoot = vi.spyOn(fs, "readdirSync");

    reclaimAbandonedSqliteSnapshotStagingOnce(stagingRoot);
    reclaimAbandonedSqliteSnapshotStagingOnce(stagingRoot);

    expect(readStagingRoot).toHaveBeenCalledTimes(1);
  });
});
