import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("models.providers.*.enabled schema validation", () => {
  it("accepts provider with enabled: true", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          "test-provider": {
            enabled: true,
            baseUrl: "http://localhost:4000/v1",
            models: [],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts provider with enabled: false", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          "test-provider": {
            enabled: false,
            baseUrl: "http://localhost:4000/v1",
            models: [],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts provider without enabled (defaults to true)", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          "test-provider": {
            baseUrl: "http://localhost:4000/v1",
            models: [],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects provider with non-boolean enabled", () => {
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          "test-provider": {
            enabled: "false",
            baseUrl: "http://localhost:4000/v1",
            models: [],
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts disable-only stub { enabled: false } without baseUrl or models", () => {
    // Users must be able to disable implicit/ambient providers (e.g. github-copilot,
    // amazon-bedrock) without providing a full configuration block.
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          "github-copilot": { enabled: false },
          "amazon-bedrock": { enabled: false },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects disable-only stub with extra unknown fields", () => {
    // The disabled schema uses strict mode — extra keys should be rejected.
    const result = OpenClawSchema.safeParse({
      models: {
        providers: {
          "test-provider": {
            enabled: false,
            unknownField: "should-fail",
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
