export type DeepPromotionGroup<T> = {
  projectKey?: string;
  candidates: T[];
};

export const GLOBAL_DEEP_GROUP_KEY = "__global__";

export function deepPromotionGroupKey(projectKey: string | undefined): string {
  return projectKey ?? GLOBAL_DEEP_GROUP_KEY;
}

export function selectDeepPromotionGroup<T>(params: {
  groups: Array<DeepPromotionGroup<T>>;
  deepGroupKey?: string;
}): {
  group?: DeepPromotionGroup<T>;
  index: number;
  nextDeepGroupKey?: string;
} {
  if (params.groups.length === 0) {
    return { index: 0 };
  }
  const requestedIndex = params.deepGroupKey
    ? params.groups.findIndex(
        (group) => deepPromotionGroupKey(group.projectKey) === params.deepGroupKey,
      )
    : -1;
  const index = Math.max(0, requestedIndex);
  const group = params.groups[index];
  const following = params.groups[index + 1];
  return {
    ...(group ? { group } : {}),
    index,
    ...(following ? { nextDeepGroupKey: deepPromotionGroupKey(following.projectKey) } : {}),
  };
}
