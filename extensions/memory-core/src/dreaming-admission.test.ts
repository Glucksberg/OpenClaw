import { describe, expect, test, vi } from "vitest";
import {
  DREAMING_MAX_CGROUP_MEMORY_BYTES,
  DREAMING_MAX_CGROUP_TASKS,
  probeDreamingAdmission,
  type DreamingResourceSnapshot,
} from "./dreaming-admission.js";

const healthy = (): { ok: true; eventLoop: { degraded: false } } => ({
  ok: true,
  eventLoop: { degraded: false },
});
const baseline = (): Promise<DreamingResourceSnapshot> =>
  Promise.resolve({ memoryCurrentBytes: 1_500_000_000, tasksCurrent: 13 });
type AdmissionFailureCase = readonly [
  reason: string,
  readHealth: () => unknown,
  readResources: () => Promise<DreamingResourceSnapshot>,
];

describe("dreaming admission", () => {
  test("admits only a healthy event loop below both cgroup bounds", async () => {
    await expect(
      probeDreamingAdmission({ readHealth: healthy, readResources: baseline }),
    ).resolves.toEqual({
      allowed: true,
      resources: { memoryCurrentBytes: 1_500_000_000, tasksCurrent: 13 },
    });
  });

  const failureCases: AdmissionFailureCase[] = [
    ["health_unavailable", () => undefined, baseline],
    ["health_not_ok", () => ({ ok: false }), baseline],
    ["event_loop_unavailable", () => ({ ok: true }), baseline],
    ["event_loop_degraded", () => ({ ok: true, eventLoop: { degraded: true } }), baseline],
    [
      "memory_high",
      healthy,
      () =>
        Promise.resolve({
          memoryCurrentBytes: DREAMING_MAX_CGROUP_MEMORY_BYTES + 1,
          tasksCurrent: 13,
        }),
    ],
    [
      "tasks_high",
      healthy,
      () =>
        Promise.resolve({
          memoryCurrentBytes: 1_500_000_000,
          tasksCurrent: DREAMING_MAX_CGROUP_TASKS + 1,
        }),
    ],
  ];

  test.each(failureCases)("fails closed with %s", async (reason, requestHealth, readResources) => {
    const result = await probeDreamingAdmission({ readHealth: requestHealth, readResources });
    expect(result).toMatchObject({ allowed: false, reason });
  });

  test("does not read cgroup counters after health fails closed", async () => {
    const readResources = vi.fn(baseline);
    await probeDreamingAdmission({
      readHealth: () => {
        throw new Error("health unavailable");
      },
      readResources,
    });
    expect(readResources).not.toHaveBeenCalled();
  });
});
