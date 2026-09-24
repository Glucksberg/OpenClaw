# CloudFarm OPSEC hourly monitor

This is the bounded replacement definition for the disabled
`cloudfarm-opsec-hourly-monitor` automation. The script payload is
`cloudfarm-opsec-hourly-monitor.script`; its one-source worker is
`cloudfarm-opsec-source-check.cjs`.

Apply only after the OpenClaw build containing these files is deployed. Keep the
existing job disabled while patching it, preserve its schedule and delivery
target, and change only these payload fields:

```json
{
  "kind": "script",
  "timeoutSeconds": 240,
  "toolBudget": 8,
  "toolsAllow": ["exec"]
}
```

The script itself must be loaded verbatim from the `.script` file. It performs
three light probes every cycle. Every fourth cycle it discovers the configured
source keys without logging their configuration, processes at most two sources,
and persists `cycle` and `sourceCursor` through native `trigger.state`. A source
failure is caught and included in both `notify` and state, so partial work is not
reported as `NO_REPLY` and the next batch can resume.

The payload intentionally pins the host's registered CloudFarm checkout at
`/home/dev/projects/CloudFarm` and invokes the helper through the stable current
release symlink under `/home/dev/.openclaw/releases/current`. This is an
operations definition for this host; those paths must be changed together if
the service registry or release layout changes.

For the production checkpoint, force-run the still-disabled job once and require:

- a terminal run in less than 240 seconds;
- at most eight tool calls and no agent/subagent session;
- state containing `done`, `remaining`, `sourceCursor`, and `errors`;
- no leftover scraper/browser/helper process;
- correct alert delivery only when `notify` is present.

Enable the job only after that checkpoint is reviewed. Roll back by restoring the
previous payload while leaving the job disabled.
