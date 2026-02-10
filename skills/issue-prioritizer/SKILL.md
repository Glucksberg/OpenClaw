---
name: issue-prioritizer
description: "Analyze GitHub issues and prioritize by ROI (impact/effort). Find quick wins, match contributor level, detect 'tripping' solutions."
metadata:
  openclaw:
    emoji: "🎯"
    requires:
      bins: ["bun", "gh"]
---

# Issue Prioritizer Skill

Analyze GitHub repositories to find the best issues to work on. Scores issues by:
- **Difficulty** (1-10): How hard to implement
- **Importance** (1-10): How impactful  
- **ROI**: `Importance / Difficulty` (higher = better)
- **Tripping Scale** (1-5): Solution sanity (1=sane, 5=risky/experimental)
- **Adjusted Score**: ROI penalized by trip score

## Quick Start

```bash
# Navigate to the tool
cd /home/dev/agents/issue-prioritizer

# Analyze a repository
bun src/cli.ts analyze owner/repo

# Find quick wins only
bun src/cli.ts quick-wins owner/repo

# Get recommendations for your level
bun src/cli.ts for-me owner/repo --level beginner

# Get the single best issue to work on next
bun src/cli.ts next owner/repo
```

## Commands

### `analyze <owner/repo>`
Full analysis with all issues ranked.

```bash
bun src/cli.ts analyze openclaw/openclaw --limit 50
```

Options:
| Option | Description | Default |
|--------|-------------|---------|
| `--limit, -l` | Number of issues | 30 |
| `--level` | Filter by contributor level: beginner/intermediate/advanced | any |
| `--focus` | Focus area: bugs, features, docs | all |
| `--output, -o` | Format: json, markdown, table | table |
| `--file, -f` | Write to file | stdout |

### `quick-wins <owner/repo>`
Show only issues with ROI ≥ 1.5, Difficulty ≤ 5, Trip ≤ 3.

```bash
bun src/cli.ts quick-wins openclaw/openclaw
```

### `for-me <owner/repo>`
Personalized recommendations based on skill level.

```bash
bun src/cli.ts for-me openclaw/openclaw --level beginner
```

### `next <owner/repo>`
Show the single best issue to work on.

```bash
bun src/cli.ts next openclaw/openclaw
```

## Output Example

```
Issue Prioritization Report
============================================================
Repository: openclaw/openclaw
Generated:  2026-01-31T12:00:00Z
Issues:     30

Quick Wins (3) | Critical Bugs (2) | Tripping Issues (1)

Quick Wins:
---------------------------------------------------------------------------
  #     | Dif | Imp | ROI  | Trip | Adj  | Title
---------------------------------------------------------------------------
  5347  |   2 |   7 | 3.50 | ✅ 1 | 3.50 | Webchat /new command blocked
  5224  |   3 |   8 | 2.67 | ✅ 1 | 2.67 | Compaction summary unavailable
  5209  |   2 |   6 | 3.00 | ✅ 2 | 2.55 | Audio files treated as text

Trip Scale: ✅ 1-2 (sane) | ⚠️ 3 (cautious) | 🚨 4-5 (risky)
```

## Scoring Methodology

### Difficulty Signals
- Documentation only: -3
- Has proposed solution: -2
- Has reproduction steps: -1
- Unknown root cause: +3
- Architectural change: +3
- Security implications: +2

### Importance Signals
- Crash/data loss: 9-10
- Security vulnerability: 9-10
- Broken functionality: 6-7
- Enhancement: 4-5
- Cosmetic/docs: 1-3

### Tripping Scale
| Score | Meaning |
|-------|---------|
| 1 | Total Sanity — proven approach |
| 2 | Grounded with Flair — practical with creativity |
| 3 | Dipping Toes — cautious exploration |
| 4 | Wild Adventure — bold, risky |
| 5 | Tripping — questionable viability |

**Red flags**: "rewrite from scratch", blockchain/AI buzzwords, breaking changes
**Green flags**: standard patterns, minimal change, existing libraries

## Integration with Agents

When an agent asks to analyze issues, use this skill:

```
User: "Analyze openclaw/openclaw for contribution opportunities"

Agent: [uses issue-prioritizer skill]
cd /home/dev/agents/issue-prioritizer
bun src/cli.ts analyze openclaw/openclaw --output markdown
```

## Project Location

The full source code is at:
```
/home/dev/agents/issue-prioritizer/
├── src/
│   ├── analyzer.ts    # Core analysis logic
│   ├── scoring.ts     # Scoring algorithms
│   ├── types.ts       # TypeScript types
│   └── cli.ts         # CLI entry point
├── config.yaml        # Default configuration
└── mcp-tool.json      # MCP tool definition
```

## See Also

- `/home/dev/agents/issue-prioritizer/README.md` — Full documentation
- `/home/dev/agents/issue-prioritizer/AGENT_SPEC.md` — Detailed spec
