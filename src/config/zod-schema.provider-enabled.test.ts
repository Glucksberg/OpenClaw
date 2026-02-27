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
});
