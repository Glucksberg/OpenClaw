import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parseCodeModeScriptSyntax } from "../agents/code-mode-script-syntax.js";
import { runCommandWithTimeout } from "../process/exec.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (tools: unknown, trigger: unknown) => Promise<unknown>;

async function loadMonitor() {
  const source = await fs.readFile(
    path.resolve(
      import.meta.dirname,
      "../../scripts/operations/cloudfarm-opsec-hourly-monitor.script",
    ),
    "utf8",
  );
  return { source, monitor: new AsyncFunction("tools", "trigger", source) };
}

function result(output: string) {
  return { result: { details: { aggregated: output } } };
}

describe("cloudfarm opsec hourly monitor definition", () => {
  test("is accepted by the native cron script parser", async () => {
    const { source } = await loadMonitor();
    expect(parseCodeModeScriptSyntax(source)).toMatchObject({ ok: true });
  });

  test("keeps light cycles to three bounded tool calls", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(result("cloudfarm-api online"))
      .mockResolvedValueOnce(result("1"))
      .mockResolvedValueOnce(result("healthy"));
    const { monitor } = await loadMonitor();

    const output = (await monitor({ call }, { state: { cycle: 0, sourceCursor: 0 } })) as {
      notify?: string;
      state: { cycle: number; sourceCursor: number; done: number; errors: string[] };
    };

    expect(call).toHaveBeenCalledTimes(3);
    expect(
      call.mock.calls.every(
        ([, params]) =>
          params.workdir === "/home/dev/projects/CloudFarm" &&
          params.env?.CLOUDFARM_ROOT === "/home/dev/projects/CloudFarm" &&
          typeof params.timeoutSeconds === "number" &&
          !("timeout" in params),
      ),
    ).toBe(true);
    expect(output.notify).toBeUndefined();
    expect(output.state).toMatchObject({ cycle: 1, sourceCursor: 0, done: 0, errors: [] });
  });

  test("checks only two sources, checkpoints the cursor, and reports partial failure", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(result("cloudfarm-api online"))
      .mockResolvedValueOnce(result("1"))
      .mockResolvedValueOnce(result("healthy"))
      .mockResolvedValueOnce(result("alpha\nbeta\ngamma"))
      .mockResolvedValueOnce(result('{"status":"ok"}'))
      .mockRejectedValueOnce(new Error("source timeout"));
    const { monitor } = await loadMonitor();

    const output = (await monitor({ call }, { state: { cycle: 3, sourceCursor: 1 } })) as {
      notify?: string;
      state: {
        cycle: number;
        sourceCursor: number;
        done: number;
        remaining: number;
        errors: string[];
      };
    };

    expect(call).toHaveBeenCalledTimes(6);
    expect(call.mock.calls[3]?.[1]).toMatchObject({
      command:
        "node /home/dev/.openclaw/releases/current/scripts/operations/cloudfarm-opsec-source-check.cjs --list",
      workdir: "/home/dev/projects/CloudFarm",
      env: { CLOUDFARM_ROOT: "/home/dev/projects/CloudFarm" },
    });
    expect(output.state).toMatchObject({ cycle: 4, sourceCursor: 0, done: 2, remaining: 1 });
    expect(output.state.errors).toContain("source timeout");
    expect(output.notify).toContain("done=2 remaining=1 cursor=0");
  });

  test.runIf(process.platform !== "win32")(
    "physically kills the helper process group on timeout",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opsec-timeout-"));
      const pidFile = path.join(tempDir, "child.pid");
      const helper = path.resolve(
        import.meta.dirname,
        "../../scripts/operations/cloudfarm-opsec-source-check.cjs",
      );
      let childPid = 0;
      try {
        const timedResult = await runCommandWithTimeout(
          [process.execPath, helper, "--timeout-probe", pidFile],
          { timeoutMs: 500, killProcessTree: true },
        );
        expect(timedResult.termination).toBe("timeout");
        childPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
        expect(childPid).toBeGreaterThan(0);
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
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
