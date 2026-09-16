import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";

const pendingTempDirectoryCleanup = new Set<string>();
let cleanupExitHandlerInstalled = false;
// Staging directory names carry their creating PID, so a directory whose owner
// is gone can no longer be read from and is safe to reclaim.
const abandonedStagingEntry = /^openclaw-sqlite-readonly-(\d+)-/;
const reclaimedStagingRoots = new Set<string>();
const tempDirectoryRemovalOptions = {
  force: true,
  maxRetries: 3,
  recursive: true,
  retryDelay: 20,
} as const;

// A non-throwing cleanup-failure report emitted once per owner; a successful
// read is never turned into a failure by temp-file cleanup.
export type CleanupFailureReport = {
  cleanupRoot: string;
  operation: "rm";
  code: string | undefined;
};

function emitSnapshotCleanupFailure(
  report: CleanupFailureReport,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): void {
  if (onCleanupFailure) {
    try {
      onCleanupFailure(report);
      return;
    } catch {
      // A failed consumer diagnostic still belongs in the shared log sink.
    }
  }
  try {
    // File/diagnostic transports preserve subprocess stdout/stderr result contracts.
    getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
      { path: report.cleanupRoot, operation: report.operation, errorCode: report.code },
      "SQLite read-only snapshot cleanup failed. Check directory permissions and available storage before retrying.",
    );
  } catch {
    // Diagnostic failures must not replace the read's result or original error.
  }
}

function recordTempDirectoryCleanup(tempDir: string, removed: boolean): boolean {
  if (removed) {
    pendingTempDirectoryCleanup.delete(tempDir);
    return true;
  }
  pendingTempDirectoryCleanup.add(tempDir);
  if (!cleanupExitHandlerInstalled) {
    cleanupExitHandlerInstalled = true;
    process.once("exit", () => {
      for (const pendingDir of pendingTempDirectoryCleanup) {
        try {
          fs.rmSync(pendingDir, { force: true, recursive: true });
        } catch {
          // The directory is private and remains registered until process teardown completes.
        }
      }
    });
  }
  return false;
}

export function removeTempDirectory(
  tempDir: string,
  onFailure?: (error: unknown) => void,
): boolean {
  try {
    fs.rmSync(tempDir, tempDirectoryRemovalOptions);
    return recordTempDirectoryCleanup(tempDir, true);
  } catch (error) {
    onFailure?.(error);
    return recordTempDirectoryCleanup(tempDir, false);
  }
}

function isStagingOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID was recycled by a process this user cannot signal;
    // treat it as live so a foreign owner is never mistaken for an abandoned one.
    return extractErrorCode(error) === "EPERM";
  }
}

/**
 * Removes snapshot staging directories left by processes that are already gone.
 *
 * Owner-driven cleanup cannot run when a process is terminated by a signal or
 * lost with the host, so abandoned staging bytes would otherwise stay until
 * something outside OpenClaw removed them. Reclaiming them when a new snapshot
 * is staged keeps the recovery inside the owner that created them.
 */
export function reclaimAbandonedSqliteSnapshotStaging(stagingRoot: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    // A missing or unreadable staging root has nothing to reclaim; snapshot
    // creation reports its own failure.
    return 0;
  }
  let reclaimed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const owner = abandonedStagingEntry.exec(entry.name);
    if (!owner) {
      continue;
    }
    const ownerPid = Number(owner[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      continue;
    }
    if (ownerPid === process.pid || isStagingOwnerAlive(ownerPid)) {
      continue;
    }
    if (removeTempDirectory(path.join(stagingRoot, entry.name))) {
      reclaimed += 1;
    }
  }
  return reclaimed;
}

/** Reclaims abandoned staging once per root, before this process stages its own. */
export function reclaimAbandonedSqliteSnapshotStagingOnce(stagingRoot: string): void {
  if (reclaimedStagingRoots.has(stagingRoot)) {
    return;
  }
  reclaimedStagingRoots.add(stagingRoot);
  reclaimAbandonedSqliteSnapshotStaging(stagingRoot);
}

export async function removeTempDirectoryAsync(
  tempDir: string,
  onFailure?: (error: unknown) => void,
): Promise<boolean> {
  try {
    await fs.promises.rm(tempDir, tempDirectoryRemovalOptions);
    return recordTempDirectoryCleanup(tempDir, true);
  } catch (error) {
    onFailure?.(error);
    return recordTempDirectoryCleanup(tempDir, false);
  }
}

export function adoptPreparedLocation(
  location: string,
  ownedRoot?: string,
  requireCleanup = false,
  onCleanupFailure?: (report: CleanupFailureReport) => void,
): PreparedSqliteReadOnlyLocation {
  const tempDir = ownedRoot ?? path.dirname(location);
  let active = true;
  let pending: Promise<boolean> | undefined;
  let reported = false;
  const reportFailure = (error: unknown) => {
    if (!requireCleanup && !reported) {
      reported = true;
      emitSnapshotCleanupFailure(
        { cleanupRoot: tempDir, operation: "rm", code: extractErrorCode(error) },
        onCleanupFailure,
      );
    }
  };
  const complete = (removed: boolean) => {
    if (removed) {
      active = false;
    } else if (requireCleanup) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${tempDir}`);
    }
    return removed;
  };
  return {
    location,
    cleanupRoot: tempDir,
    cleanup: () => {
      if (pending) {
        // Pending async removal: return false without a false warning;
        // requireCleanup delegates to complete(false) for the fatal throw.
        return requireCleanup ? complete(false) : false;
      }
      if (!active) {
        return true;
      }
      return complete(removeTempDirectory(tempDir, reportFailure));
    },
    cleanupAsync: () => {
      if (pending) {
        return pending;
      }
      if (!active) {
        return Promise.resolve(true);
      }
      // Register ownership before invoking native removal; concurrent callers
      // join it, and synchronous callers cannot race or report early success.
      pending = Promise.resolve()
        .then(() => removeTempDirectoryAsync(tempDir, reportFailure))
        .then(complete)
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
