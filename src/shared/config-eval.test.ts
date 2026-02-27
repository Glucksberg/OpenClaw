import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRuntimeEligibility, hasBinary } from "./config-eval.js";

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});

describe("hasBinary", () => {
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalPathExt !== undefined) {
      process.env.PATHEXT = originalPathExt;
    } else {
      delete process.env.PATHEXT;
    }
    vi.restoreAllMocks();
  });

  it("detects binaries that exist in PATH", () => {
    const accessSync = vi.spyOn(fs, "accessSync");
    accessSync.mockImplementation((target) => {
      if (target === path.join("/tmp", "tool")) {
        return;
      }
      throw new Error("missing");
    });

    process.env.PATH = "/tmp";
    expect(hasBinary("tool")).toBe(true);
    expect(accessSync).toHaveBeenCalledWith(path.join("/tmp", "tool"), fs.constants.X_OK);
  });

  it("falls back to well-known dirs when PATH is minimal (non-Windows)", () => {
    if (process.platform === "win32") {
      return;
    }

    const homebrewGh = path.join("/opt/homebrew/bin", "gh");
    const accessSync = vi.spyOn(fs, "accessSync");
    accessSync.mockImplementation((target) => {
      if (target === homebrewGh) {
        return;
      }
      throw new Error("missing");
    });

    // Minimal PATH that does not contain /opt/homebrew/bin.
    process.env.PATH = "/nonexistent";
    expect(hasBinary("gh")).toBe(true);
    expect(accessSync).toHaveBeenCalledWith(homebrewGh, fs.constants.X_OK);
  });

  it("does not duplicate directories already in PATH", () => {
    const accessSync = vi.spyOn(fs, "accessSync");
    const calls: string[] = [];
    accessSync.mockImplementation((target) => {
      calls.push(String(target));
      throw new Error("missing");
    });

    // Include /opt/homebrew/bin in PATH; it should not be probed twice.
    process.env.PATH = `/opt/homebrew/bin${path.delimiter}/usr/bin`;
    hasBinary("nonexistent-binary-xyz");

    const homebrewCalls = calls.filter(
      (c) => c === path.join("/opt/homebrew/bin", "nonexistent-binary-xyz"),
    );
    expect(homebrewCalls.length).toBe(1);
  });

  it("returns false when binary is not found anywhere", () => {
    const accessSync = vi.spyOn(fs, "accessSync");
    accessSync.mockImplementation(() => {
      throw new Error("missing");
    });

    process.env.PATH = "/tmp";
    expect(hasBinary("does-not-exist-anywhere")).toBe(false);
  });
});
