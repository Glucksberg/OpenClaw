---
name: openclaw-repo-xray
description: Monitor the OpenClaw GitHub repo (openclaw/openclaw) manually or on a schedule to find strong Issue↔PR connections, avoid duplicate/auto-linked comments, append to the monitor history file, and output a single Telegram report in the canonical “ATIVIDADE/TENDÊNCIA/AÇÕES/DESTAQUE” format.
---

# OpenClaw repo Xray

State/history files:
- History (append-only): `/home/dev/clawdbot/agents/moltbot/memory/moltbot-monitor-history.md`
- Stats snapshots: `/home/dev/clawdbot/agents/moltbot/memory/moltbot-stats-history.json`

## Hard rules

1) **History is append-only**
- Only append a new “Rodada …” section to the end.
- Do not rewrite or delete previous rounds.

2) **Never post duplicate links**
Before commenting, check:
- GitHub already auto-linked the PR/issue in the timeline
- A commit already references the issue
- A human comment already made the same link

3) **Telegram output must be ONE message**
- No progress narration.
- Output must match the template in `references/telegram-report-template.md`.

## Workflow

### 1) Read history and decide the next round number
```bash
cat /home/dev/clawdbot/agents/moltbot/memory/moltbot-monitor-history.md
```

### 2) Compute activity stats (window)
Prefer: window start = last snapshot timestamp in `moltbot-stats-history.json`.
Fallback: start = now-4h.

Use GitHub search totals:
```bash
START='<ISO8601>'
REPO='openclaw/openclaw'

# PRs created in window
PRS_CREATED=$(gh api search/issues -f q="repo:$REPO is:pr created:>=$START" --jq '.total_count')

# PRs closed (not merged) in window
PRS_CLOSED=$(gh api search/issues -f q="repo:$REPO is:pr closed:>=$START -is:merged" --jq '.total_count')

# PRs merged in window
PRS_MERGED=$(gh api search/issues -f q="repo:$REPO is:pr merged:>=$START" --jq '.total_count')

# Issues created in window
ISSUES_CREATED=$(gh api search/issues -f q="repo:$REPO is:issue created:>=$START" --jq '.total_count')

# Issues closed in window
ISSUES_CLOSED=$(gh api search/issues -f q="repo:$REPO is:issue closed:>=$START" --jq '.total_count')
```

Also capture current totals:
```bash
# Open PRs / Issues (current)
PRS_OPEN=$(gh api search/issues -f q="repo:$REPO is:pr is:open" --jq '.total_count')
ISSUES_OPEN=$(gh api search/issues -f q="repo:$REPO is:issue is:open" --jq '.total_count')
```

Append a snapshot into `moltbot-stats-history.json` so the next run can reuse the timestamp.

### 3) Snapshot lists (optional; for titles / picking candidates)
```bash
gh issue list --repo openclaw/openclaw --state open --limit 50 --json number,title,createdAt
gh pr list --repo openclaw/openclaw --state open --limit 50 --json number,title,createdAt
```

### 4) Identify strong Issue↔PR links (max 5)
For each candidate, confirm it’s not duplicated:

Timeline (auto-links):
```bash
gh issue view <num> --repo openclaw/openclaw --json timeline --jq '.timeline[] | select(.type=="cross-referenced" or .type=="connected")'
```

Comments (human duplicates):
```bash
gh issue view <num> --repo openclaw/openclaw --json comments --jq '.comments[].body'
```

### 5) Post comments (only if they add value)
```bash
gh issue comment <num> --repo openclaw/openclaw --body '<short helpful link + why>'
```

Capture the comment URL.

### 6) Update history
- Append the round section to the end of `moltbot-monitor-history.md`.
- Update the global totals and “Já Analisados”.

### 7) Telegram output
Use the exact text format from:
- `references/telegram-report-template.md`
