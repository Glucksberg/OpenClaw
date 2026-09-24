# AI Pulse X News Report

This is the bounded replacement definition for automation
`f8fb9fa5-49bf-4102-b099-3184d0e4af78` (`🗞️ AI Pulse - X News Report`). It
preserves the `0 8,20 * * *` UTC schedule and the existing delivery and failure
alert destinations, but replaces the isolated model turn with the native script
payload in `ai-pulse-x-report.script`.

Apply only after the OpenClaw release containing these files is active. Disable
the job before editing it, load the script verbatim, and change only these
payload fields:

```json
{
  "kind": "script",
  "timeoutSeconds": 240,
  "toolBudget": 1,
  "toolsAllow": ["exec"]
}
```

The native script makes one bounded `exec` call. The helper performs five
finite public-X search batches, retries each failed search once with a short
backoff, checkpoints after every topic, deduplicates archive URLs, and always
returns either a complete or explicit partial report. It does not load the old
agent prompt, private report bodies, environment files, or diagnostic exports.

The helper holds an OS `flock` singleton under
`/home/dev/.openclaw/cron/bounded-ai-pulse`; the kernel releases it even if the
owner is killed. It treats a held lock as an overlap skip and uses physical
process-group termination for every `bird` search. The internal pipeline budget
is 175 seconds, leaving 35 seconds below the 210-second `exec` timeout for
checkpoint and process cleanup. A scheduler retry or operator force-run resumes
every non-finalized checkpoint, including one that collected all topics but was
interrupted while archiving.

Archive writes are planned in checkpoint version 2 and reconciled independently
against the daily file and global index. The checkpoint is finalized only after
both sinks contain each planned `run_id` + URL record, so a retry cannot duplicate
the daily side when a prior process died before updating the index.

For an isolated canary, invoke the helper with temporary `--archive-root` and
`--state-root` directories. For the production checkpoint, force-run this same
payload once while the job is disabled and require:

- a terminal run in less than 240 seconds and exactly one tool call;
- no agent or subagent session;
- state containing `runId`, `cursor`, `done`, `remaining`, and `errors`;
- no held singleton lock or descendant `bird` process after completion;
- a complete or explicit partial report delivered through the unchanged target.

Enable the job only after that checkpoint is reviewed. Roll back by disabling
the job and restoring its prior payload snapshot; never run old and new job IDs
in parallel.
