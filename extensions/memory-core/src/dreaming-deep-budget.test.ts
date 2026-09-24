import { describe, expect, test } from "vitest";
import { deepPromotionGroupKey, selectDeepPromotionGroup } from "./dreaming-deep-budget.js";

describe("deep dreaming work-item budget", () => {
  const groups = [
    { projectKey: "alpha", candidates: ["a"] },
    { candidates: ["global"] },
    { projectKey: "omega", candidates: ["o"] },
  ];

  test("selects one group and exposes the next durable group cursor", () => {
    const first = selectDeepPromotionGroup({ groups });
    expect(first).toEqual({
      group: groups[0],
      index: 0,
      nextDeepGroupKey: deepPromotionGroupKey(undefined),
    });
    const second = selectDeepPromotionGroup({
      groups,
      deepGroupKey: first.nextDeepGroupKey,
    });
    expect(second).toEqual({
      group: groups[1],
      index: 1,
      nextDeepGroupKey: "omega",
    });
    const third = selectDeepPromotionGroup({ groups, deepGroupKey: second.nextDeepGroupKey });
    expect(third).toEqual({ group: groups[2], index: 2 });
  });

  test("selects the same group again when an error leaves its cursor unchanged", () => {
    const cursor = deepPromotionGroupKey(undefined);
    expect(selectDeepPromotionGroup({ groups, deepGroupKey: cursor }).group).toBe(groups[1]);
    expect(selectDeepPromotionGroup({ groups, deepGroupKey: cursor }).group).toBe(groups[1]);
  });

  test("falls back to the first remaining group when a committed group disappeared", () => {
    const remaining = groups.slice(1);
    expect(selectDeepPromotionGroup({ groups: remaining, deepGroupKey: "alpha" }).group).toBe(
      remaining[0],
    );
  });
});
