# Cron Health Monitor

This is the bounded native-script replacement for automation
`6be7fd47-6945-4edd-ab83-49800caf9e4f`. It preserves the
`0 0,12 * * *` UTC schedule and the existing announce destination while
replacing the isolated agent turn with `cron-health-monitor.script`.

Apply only after the OpenClaw release containing these files is active. Disable
the existing job, save its prior payload for rollback, load the script verbatim,
and change only these payload fields:

```json
{
  "kind": "script",
  "timeoutSeconds": 240,
  "toolBudget": 1,
  "toolsAllow": ["exec"]
}
```

Do not create a second job or change the schedule, delivery target, account, or
job identity. Keep the old workspace snapshot script in place during rollout;
the new job calls the release-owned canonical snapshot directly.

The native script makes one bounded `exec` call. The helper runs these stable
probe groups in legacy output order:

1. `system-cron`
2. `carryover`
3. `seedsearch`
4. `pm2`
5. `disk`
6. `tasks`
7. `disabled-crons`
8. `registry`

The canonical snapshot accepts `--probe <id>`. No arguments and `--all` retain
the prior all-section order. The helper processes four probes per invocation,
uses a 175-second internal budget and 45-second per-probe cap, and leaves 35
seconds below the single `exec` timeout for checkpoint and process cleanup.
Every probe child runs in a detached process group and is physically terminated
on timeout.

State is atomically checkpointed with mode `0600` under
`/home/dev/.openclaw/cron/bounded-health-monitor`. An OS `flock` prevents
overlap and is released by the kernel if its owner dies. A timeout or error
keeps the cursor on the failed probe and records an explicit attempt. After
three attempts, that probe is dead-lettered only for the current sweep so later
probes can run; the sweep reports `degraded`. The next sweep probes it again,
and a successful result clears its old dead-letter state.

The PM2 restart baseline is transactional. The snapshot emits a candidate; the
helper checkpoints that pending commit, atomically writes the baseline, and only
then advances the cursor. Replaying an interrupted commit writes identical
bytes. After three sink failures, the current sweep dead-letters PM2 and lets
later probes run, but retains the candidate as a deferred commit. The next sweep
retries that exact candidate before rerunning PM2, so a failed baseline write is
neither treated as committed nor lost.

System schedules, PM2 anomalies, and registry reconciliation also emit bounded
`HEALTH|severity|group|code|sanitized detail` records. The helper classifies
those records while the canonical snapshot retains its legacy human-readable
sections. Structured details contain stable identifiers and counts, not log or
report bodies.

For an isolated canary, invoke the helper with temporary
`OPENCLAW_HEALTH_STATE_ROOT` and `OPENCLAW_HEALTH_PM2_STATE_FILE` paths. Then
force-run the production payload once while the job remains disabled and
require:

- a terminal run in less than 240 seconds and exactly one tool call;
- no agent or subagent session;
- explicit `runId`, `cursor`, `done`, `remaining`, `attempts`, and `errors` state;
- no held singleton lock or surviving probe descendants;
- bounded event-loop delay and RSS, with the Gateway remaining healthy;
- complete or explicit partial output delivered through the unchanged target.

For the descendant check, prefer recorded child PIDs or an exact executable-path
match after the runner exits. A broad `pgrep -f` for a filename can count the
inspection shell itself because that filename appears in its command text.

Enable the job only after the checkpoint and runtime measurements are reviewed.
Roll back by disabling it and restoring the saved prior payload snapshot. Never
run old and new job IDs in parallel.
