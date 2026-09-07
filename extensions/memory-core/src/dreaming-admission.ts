import fs from "node:fs/promises";
import path from "node:path";
import { readCachedGatewayHealth } from "openclaw/plugin-sdk/gateway-health-runtime";

export const DREAMING_MAX_CGROUP_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const DREAMING_MAX_CGROUP_TASKS = 32;

type GatewayHealth = {
  ok?: boolean;
  eventLoop?: {
    degraded?: boolean;
  };
};

export type DreamingResourceSnapshot = {
  memoryCurrentBytes: number;
  tasksCurrent: number;
};

export type DreamingAdmission =
  | { allowed: true; resources: DreamingResourceSnapshot }
  | {
      allowed: false;
      reason:
        | "health_unavailable"
        | "health_not_ok"
        | "event_loop_unavailable"
        | "event_loop_degraded"
        | "resources_unavailable"
        | "memory_high"
        | "tasks_high";
      resources?: DreamingResourceSnapshot;
    };

async function readPositiveInteger(filePath: string): Promise<number> {
  const value = Number.parseInt((await fs.readFile(filePath, "utf8")).trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid cgroup counter at ${filePath}`);
  }
  return value;
}

export async function readDreamingCgroupResources(): Promise<DreamingResourceSnapshot> {
  const cgroup = await fs.readFile("/proc/self/cgroup", "utf8");
  const unified = cgroup
    .split(/\r?\n/u)
    .map((line) => line.match(/^0::(.+)$/u)?.[1])
    .find((entry): entry is string => Boolean(entry));
  if (!unified) {
    throw new Error("unified cgroup path unavailable");
  }
  const cgroupRoot = path.resolve("/sys/fs/cgroup");
  const cgroupDir = path.resolve(cgroupRoot, `.${unified}`);
  if (cgroupDir !== cgroupRoot && !cgroupDir.startsWith(`${cgroupRoot}${path.sep}`)) {
    throw new Error("resolved cgroup path escaped cgroup root");
  }
  const [memoryCurrentBytes, tasksCurrent] = await Promise.all([
    readPositiveInteger(path.join(cgroupDir, "memory.current")),
    readPositiveInteger(path.join(cgroupDir, "pids.current")),
  ]);
  return { memoryCurrentBytes, tasksCurrent };
}

export async function probeDreamingAdmission(
  params: {
    readHealth?: () => unknown;
    readResources?: () => Promise<DreamingResourceSnapshot>;
  } = {},
): Promise<DreamingAdmission> {
  let health: GatewayHealth;
  try {
    health = (params.readHealth ?? readCachedGatewayHealth)() as GatewayHealth;
  } catch {
    return { allowed: false, reason: "health_unavailable" };
  }
  if (!health || typeof health !== "object") {
    return { allowed: false, reason: "health_unavailable" };
  }
  if (health.ok !== true) {
    return { allowed: false, reason: "health_not_ok" };
  }
  if (!health.eventLoop || typeof health.eventLoop.degraded !== "boolean") {
    return { allowed: false, reason: "event_loop_unavailable" };
  }
  if (health.eventLoop.degraded) {
    return { allowed: false, reason: "event_loop_degraded" };
  }
  let resources: DreamingResourceSnapshot;
  try {
    resources = await (params.readResources ?? readDreamingCgroupResources)();
  } catch {
    return { allowed: false, reason: "resources_unavailable" };
  }
  if (resources.memoryCurrentBytes > DREAMING_MAX_CGROUP_MEMORY_BYTES) {
    return { allowed: false, reason: "memory_high", resources };
  }
  if (resources.tasksCurrent > DREAMING_MAX_CGROUP_TASKS) {
    return { allowed: false, reason: "tasks_high", resources };
  }
  return { allowed: true, resources };
}
