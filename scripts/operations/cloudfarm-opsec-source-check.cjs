#!/usr/bin/env node
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

if (process.argv[2] === "--timeout-probe") {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(process.argv[3], String(child.pid));
  setInterval(() => {}, 1000);
  return;
}

const cloudfarmRoot = process.env.CLOUDFARM_ROOT;
if (!cloudfarmRoot || !path.isAbsolute(cloudfarmRoot)) {
  throw new Error("CLOUDFARM_ROOT must be an absolute path");
}
const service = require(path.join(cloudfarmRoot, "apps/api-v2/src/services/selfHealingScraper.js"));

if (process.argv[2] === "--list") {
  process.stdout.write(
    Object.keys(service.getConfig()?.sources ?? {})
      .toSorted()
      .join("\n"),
  );
  return;
}

async function main() {
  console.log = () => {};
  console.error = () => {};
  const sourceKey = decodeURIComponent(process.argv[2] ?? "");
  if (!sourceKey) {
    throw new Error("missing source key");
  }
  const source = service.getSourceConfig(sourceKey);
  if (!source) {
    throw new Error("unknown source key");
  }

  let html;
  try {
    html = await service.fetchHtmlWithCrawl4AI(source.url);
  } catch {
    html = await service.fetchHtmlWithPuppeteer(source.url);
  }
  const current = service.validateSelector(html, source.selector, source.priceRange);
  if (current.ok) {
    process.stdout.write(JSON.stringify({ status: "ok" }));
    return;
  }

  const healed = await service.attemptSelfHealing(sourceKey, html);
  if (!healed.success) {
    process.stdout.write(JSON.stringify({ status: "failed", error: "selector healing failed" }));
    return;
  }
  await execFileAsync("pm2", ["restart", "cloudfarm-api"], { timeout: 20_000 });
  await execFileAsync("curl", ["-fsS", "--max-time", "10", "http://127.0.0.1:8001/health"], {
    timeout: 15_000,
  });
  process.stdout.write(JSON.stringify({ status: "healed" }));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({ status: "failed", error: String(error?.message ?? error) }),
  );
  process.exitCode = 1;
});
