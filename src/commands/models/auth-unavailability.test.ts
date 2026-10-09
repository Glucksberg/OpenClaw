import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { listUnusableAuthProfilesWithHints } from "./auth-unavailability.js";

describe("listUnusableAuthProfilesWithHints", () => {
  it("targets the store's agent in the billing recovery command", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
      usageStats: {
        "inline-api-key:openai": {
          disabledUntil: Date.now() + 60_000,
          disabledReason: "billing",
        },
      },
    };

    expect(listUnusableAuthProfilesWithHints(store, "work")).toEqual([
      expect.objectContaining({
        profileId: "inline-api-key:openai",
        kind: "disabled",
        recoveryHint:
          "Top up credits (provider billing), then run `openclaw models auth clear-cooldown 'inline-api-key:openai' --agent 'work'`, or switch provider.",
      }),
    ]);
  });
});
