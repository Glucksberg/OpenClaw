import { describe, expect, it } from "vitest";
import {
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  supportsXHighThinking,
} from "./thinking.js";

describe("normalizeThinkLevel", () => {
  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });

  it("accepts xhigh aliases", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    expect(normalizeThinkLevel("x_high")).toBe("xhigh");
    expect(normalizeThinkLevel("x high")).toBe("xhigh");
  });

  it("accepts extra-high aliases as xhigh", () => {
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra_high")).toBe("xhigh");
    expect(normalizeThinkLevel("  extra high  ")).toBe("xhigh");
  });

  it("does not over-match nearby xhigh words", () => {
    expect(normalizeThinkLevel("extra-highest")).toBeUndefined();
    expect(normalizeThinkLevel("xhigher")).toBeUndefined();
  });

  it("accepts on as low", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
  });
});

describe("listThinkingLevels", () => {
  it("includes xhigh for codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-5.2-codex")).toContain("xhigh");
    expect(listThinkingLevels(undefined, "gpt-5.3-codex")).toContain("xhigh");
    expect(listThinkingLevels(undefined, "gpt-5.3-codex-spark")).toContain("xhigh");
  });

  it("includes xhigh for openai gpt-5.2", () => {
    expect(listThinkingLevels("openai", "gpt-5.2")).toContain("xhigh");
  });

  it("includes xhigh for github-copilot gpt-5.2 refs", () => {
    expect(listThinkingLevels("github-copilot", "gpt-5.2")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.2-codex")).toContain("xhigh");
  });

  it("includes xhigh for anthropic opus-4-6", () => {
    expect(listThinkingLevels("anthropic", "claude-opus-4-6")).toContain("xhigh");
  });

  it("includes xhigh for opus-4-6 on any provider (bedrock, openrouter)", () => {
    expect(listThinkingLevels("amazon-bedrock", "anthropic.claude-opus-4-6-v1:0")).toContain(
      "xhigh",
    );
    expect(listThinkingLevels("openrouter", "anthropic/claude-opus-4-6-20250415")).toContain(
      "xhigh",
    );
  });

  it("excludes xhigh for non-codex/non-opus models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });

  it("excludes xhigh for non-opus anthropic models", () => {
    expect(listThinkingLevels("anthropic", "claude-sonnet-4-5")).not.toContain("xhigh");
  });
});

describe("supportsXHighThinking", () => {
  it("supports anthropic opus-4-6 via direct provider", () => {
    expect(supportsXHighThinking("anthropic", "claude-opus-4-6")).toBe(true);
  });

  it("supports opus-4-6 without provider prefix", () => {
    expect(supportsXHighThinking(undefined, "claude-opus-4-6")).toBe(true);
  });

  it("supports opus-4-6 via bedrock model id", () => {
    expect(supportsXHighThinking("amazon-bedrock", "anthropic.claude-opus-4-6-v1:0")).toBe(true);
  });

  it("does not support non-opus anthropic models", () => {
    expect(supportsXHighThinking("anthropic", "claude-sonnet-4-5")).toBe(false);
  });
});

describe("listThinkingLevelLabels", () => {
  it("returns on/off for ZAI", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});
