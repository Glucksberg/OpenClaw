#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsPath = path.join(root, "docs/reference/database-schemas.md");
const packagePath = path.join(root, "package.json");
const agentContractPath = path.join(root, "src/state/openclaw-agent-db-contract.ts");
const stateContractPath = path.join(root, "src/state/openclaw-state-db-contract.ts");

const startMarker = "<!-- database-schema-history:start -->";
const endMarker = "<!-- database-schema-history:end -->";

const agentHistory = [
  {
    versions: [1],
    change: "Initial per-agent store ([#88349](https://github.com/openclaw/openclaw/pull/88349))",
    release: "`v2026.5.30-beta.1`, stable through `v2026.7.1`",
  },
  {
    versions: [2],
    change: "Memory index identity ([#104449](https://github.com/openclaw/openclaw/pull/104449))",
    release: "`v2026.7.2-beta.1`",
  },
  {
    versions: [4],
    change:
      "Sessions and transcripts moved into SQLite ([#98236](https://github.com/openclaw/openclaw/pull/98236))",
    release: "`v2026.7.2-beta.1`",
  },
  {
    versions: [5, 6],
    change:
      "Terminal freshness and state lifecycle ([#104859](https://github.com/openclaw/openclaw/pull/104859))",
    release: "`v2026.7.2-beta.1`",
  },
  {
    versions: [7],
    change:
      "Per-entry lifecycle status projection ([#106151](https://github.com/openclaw/openclaw/pull/106151))",
    release: "`v2026.7.2-beta.1`",
  },
  {
    versions: [8],
    change:
      "Per-transcript session provenance ([#106766](https://github.com/openclaw/openclaw/pull/106766))",
    release: "`v2026.7.2-beta.2`",
  },
  {
    versions: [9],
    change: "`STRICT` tables ([#108663](https://github.com/openclaw/openclaw/pull/108663))",
    release: "`v2026.7.2-beta.2`",
  },
  {
    versions: [10],
    change:
      "Materialized active transcript paths ([#108851](https://github.com/openclaw/openclaw/pull/108851))",
    release: "`v2026.7.2-beta.3`",
  },
  {
    versions: [11],
    change:
      "Leases, durable delivery, conversation addresses, and heartbeat outcomes ([#109636](https://github.com/openclaw/openclaw/pull/109636), [#95838](https://github.com/openclaw/openclaw/pull/95838), [#109999](https://github.com/openclaw/openclaw/pull/109999))",
    release: "`v2026.7.2-beta.3`",
  },
  {
    versions: [12],
    change:
      "Session-owned ACP parent-stream events ([#110374](https://github.com/openclaw/openclaw/pull/110374))",
    release: "`v2026.7.2-beta.5`",
  },
  {
    versions: [13, 14],
    change:
      "Durable rewrite watermarks, logical session nodes, generation windows, and node-owned artifact foreign keys ([#113071](https://github.com/openclaw/openclaw/pull/113071))",
    release: "`v2026.7.2-beta.5`",
  },
  {
    versions: [15],
    change:
      "Canonical board and session-sharing tables with upgrade data-loss rejection ([#113473](https://github.com/openclaw/openclaw/pull/113473))",
    release: "`v2026.7.2-beta.5`",
  },
  {
    versions: [16],
    change:
      "Canonical persisted media facts and downgrade guard ([#113695](https://github.com/openclaw/openclaw/pull/113695))",
    release: "`v2026.7.2-beta.5`",
  },
];

const stateHistory = [
  {
    versions: [1],
    change: "Initial shared state database",
    release: "`v2026.5.30-beta.1`",
  },
  {
    versions: [2],
    change:
      "Metadata-only message audit events ([#103903](https://github.com/openclaw/openclaw/pull/103903))",
    release: "`v2026.7.2-beta.1`",
  },
  {
    versions: [3],
    change:
      "`STRICT` tables and schema-drift hardening ([#108663](https://github.com/openclaw/openclaw/pull/108663))",
    release: "`v2026.7.2-beta.2`",
  },
  {
    versions: [4],
    change: "Session watch provenance replaces encoded sentinel rows",
    release: "`v2026.7.2-beta.3`",
  },
  {
    versions: [5],
    change:
      "Durable cloud-worker result references on pending workspace fences ([#110952](https://github.com/openclaw/openclaw/pull/110952))",
    release: "`v2026.7.2-beta.5`",
  },
  {
    versions: [6],
    change:
      "Canonical shared-state tables with upgrade data-loss rejection ([#113473](https://github.com/openclaw/openclaw/pull/113473))",
    release: "`v2026.7.2-beta.5`",
  },
];

function readSchemaVersion(contractPath, constantName) {
  const source = fs.readFileSync(contractPath, "utf8");
  const match = source.match(new RegExp(`export const ${constantName} = (\\d+);`));
  if (!match) {
    throw new Error(`Could not read ${constantName} from ${path.relative(root, contractPath)}`);
  }
  return Number(match[1]);
}

function highestVersion(history) {
  return Math.max(...history.flatMap((entry) => entry.versions));
}

function formatVersions(versions) {
  if (versions.length === 1) {
    return String(versions[0]);
  }
  return `${versions[0]}-${versions.at(-1)}`;
}

function renderTable(history) {
  const rows = history.map((entry) => [
    formatVersions(entry.versions),
    entry.change,
    entry.release,
  ]);
  const cells = [["Version", "Change", "First release"], ...rows];
  const widths = cells[0].map((_, column) => Math.max(...cells.map((row) => row[column].length)));
  const row = (values) =>
    `| ${values.map((value, column) => value.padEnd(widths[column])).join(" | ")} |`;
  const separator = row(widths.map((width) => "-".repeat(width)));
  return [row(cells[0]), separator, ...rows.map(row)].join("\n");
}

function validateHistory() {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const manifestVersions = packageJson.openclaw?.schemaVersions;
  const runtimeVersions = {
    agent: readSchemaVersion(agentContractPath, "OPENCLAW_AGENT_SCHEMA_VERSION"),
    state: readSchemaVersion(stateContractPath, "OPENCLAW_STATE_SCHEMA_VERSION"),
  };

  for (const scope of ["agent", "state"]) {
    if (manifestVersions?.[scope] !== runtimeVersions[scope]) {
      throw new Error(
        `${scope} schema mismatch: package.json declares ${manifestVersions?.[scope]}, runtime declares ${runtimeVersions[scope]}`,
      );
    }
  }

  const documentedVersions = {
    agent: highestVersion(agentHistory),
    state: highestVersion(stateHistory),
  };
  for (const scope of ["agent", "state"]) {
    if (documentedVersions[scope] !== runtimeVersions[scope]) {
      throw new Error(
        `${scope} schema history ends at ${documentedVersions[scope]}, runtime declares ${runtimeVersions[scope]}`,
      );
    }
  }
}

function renderHistory() {
  return [
    startMarker,
    "",
    "## Agent schema history",
    "",
    renderTable(agentHistory),
    "",
    "Version 3 was an unshipped development step folded into version 4.",
    "",
    "## State schema history",
    "",
    renderTable(stateHistory),
    "",
    endMarker,
  ].join("\n");
}

function generateDocument(source) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Expected one ${startMarker} ... ${endMarker} block in ${path.relative(root, docsPath)}`,
    );
  }
  const afterEnd = end + endMarker.length;
  return `${source.slice(0, start)}${renderHistory()}${source.slice(afterEnd)}`;
}

validateHistory();

const current = fs.readFileSync(docsPath, "utf8");
const generated = generateDocument(current);
if (process.argv.includes("--check")) {
  if (generated !== current) {
    console.error(
      `${path.relative(root, docsPath)} is out of date. Run pnpm docs:schema-history:gen.`,
    );
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(docsPath, generated);
  console.log(`Updated ${path.relative(root, docsPath)}`);
}
