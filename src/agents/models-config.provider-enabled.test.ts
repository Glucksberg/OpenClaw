import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks();

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  models?: Array<{ id: string }>;
};

describe("models-config provider enabled flag", () => {
  it("includes providers when enabled is omitted (defaults to true)", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "test-provider": {
              baseUrl: "http://localhost:4000/v1",
              apiKey: "TEST_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "test-model",
                  name: "Test Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 32000,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
      expect(parsed.providers["test-provider"]).toBeDefined();
      expect(parsed.providers["test-provider"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });

  it("includes providers when enabled is explicitly true", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "test-provider": {
              enabled: true,
              baseUrl: "http://localhost:4000/v1",
              apiKey: "TEST_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "test-model",
                  name: "Test Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 32000,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
      expect(parsed.providers["test-provider"]).toBeDefined();
    });
  });

  it("skips disabled providers during model resolution", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const agentDir = path.join(home, "agent-disabled");
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        const cfg: OpenClawConfig = {
          models: {
            providers: {
              "disabled-provider": {
                enabled: false,
                baseUrl: "http://localhost:4000/v1",
                apiKey: "TEST_KEY",
                api: "openai-completions",
                models: [
                  {
                    id: "test-model",
                    name: "Test Model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 32000,
                  },
                ],
              },
            },
          },
        };

        const result = await ensureOpenClawModelsJson(cfg, agentDir);

        // The function still writes models.json (so merge-mode can clean stale entries),
        // but the disabled provider must not appear in the output.
        if (result.wrote) {
          const modelPath = path.join(agentDir, "models.json");
          const raw = await fs.readFile(modelPath, "utf8");
          const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
          expect(parsed.providers["disabled-provider"]).toBeUndefined();
        }
      });
    });
  });

  it("writes only enabled providers when mix of enabled and disabled exist", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "active-provider": {
              baseUrl: "http://localhost:4001/v1",
              apiKey: "ACTIVE_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "active-model",
                  name: "Active Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 32000,
                },
              ],
            },
            "disabled-provider": {
              enabled: false,
              baseUrl: "http://localhost:4002/v1",
              apiKey: "DISABLED_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "disabled-model",
                  name: "Disabled Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 32000,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };

      expect(parsed.providers["active-provider"]).toBeDefined();
      expect(parsed.providers["active-provider"]?.baseUrl).toBe("http://localhost:4001/v1");
      expect(parsed.providers["disabled-provider"]).toBeUndefined();
    });
  });

  it("merge mode removes previously-written disabled provider from models.json", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const agentDir = path.join(home, "agent-merge-disable");
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        // Seed an existing models.json with the provider that will later be disabled.
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify(
            {
              providers: {
                "stale-provider": {
                  baseUrl: "http://stale:4000/v1",
                  apiKey: "STALE_KEY",
                  models: [{ id: "stale-model", name: "Stale" }],
                },
              },
            },
            null,
            2,
          ),
        );

        // Now run with that provider disabled (merge mode is default).
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              "stale-provider": {
                enabled: false,
                baseUrl: "http://stale:4000/v1",
                apiKey: "STALE_KEY",
                api: "openai-completions",
                models: [
                  {
                    id: "stale-model",
                    name: "Stale",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 32000,
                  },
                ],
              },
            },
          },
        };

        await ensureOpenClawModelsJson(cfg, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
        // The stale provider must be gone from the merged output.
        expect(parsed.providers["stale-provider"]).toBeUndefined();
      });
    });
  });

  it("normalizes alias disabled keys to canonical provider IDs", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS], async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const agentDir = path.join(home, "agent-alias-disable");
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        // Seed models.json with canonical provider names that should be cleaned
        // up when the user disables them using aliases.
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "models.json"),
          JSON.stringify(
            {
              providers: {
                "qwen-portal": {
                  baseUrl: "https://portal.qwen.ai/v1",
                  apiKey: "QWEN_KEY",
                  models: [{ id: "coder-model", name: "Qwen Coder" }],
                },
                volcengine: {
                  baseUrl: "https://volcengine.example/v1",
                  apiKey: "VOLC_KEY",
                  models: [{ id: "doubao-model", name: "Doubao" }],
                },
              },
            },
            null,
            2,
          ),
        );

        // Disable using aliases ("qwen" -> "qwen-portal", "doubao" -> "volcengine").
        // Use `as unknown as OpenClawConfig` because TypeScript types require baseUrl/models on
        // provider entries, but the Zod schema explicitly allows { enabled: false } stubs.
        const cfg = {
          models: {
            providers: {
              qwen: { enabled: false },
              doubao: { enabled: false },
            },
          },
        } as unknown as OpenClawConfig;

        await ensureOpenClawModelsJson(cfg, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
        // Both canonical providers must be removed via their alias-disabled keys.
        expect(parsed.providers["qwen-portal"]).toBeUndefined();
        expect(parsed.providers.volcengine).toBeUndefined();
      });
    });
  });

  it("normalizes aws-bedrock alias to suppress amazon-bedrock implicit provider", async () => {
    await withTempHome(async (home) => {
      await withTempEnv(
        [...MODELS_CONFIG_IMPLICIT_ENV_VARS, "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        async () => {
          unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

          const agentDir = path.join(home, "agent-bedrock-alias-disable");
          process.env.OPENCLAW_AGENT_DIR = agentDir;
          process.env.PI_CODING_AGENT_DIR = agentDir;

          // Seed models.json with a stale amazon-bedrock entry.
          await fs.mkdir(agentDir, { recursive: true });
          await fs.writeFile(
            path.join(agentDir, "models.json"),
            JSON.stringify(
              {
                providers: {
                  "amazon-bedrock": {
                    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                    apiKey: "AWS_PROFILE",
                    models: [{ id: "bedrock-model", name: "Bedrock Model" }],
                  },
                },
              },
              null,
              2,
            ),
          );

          // Disable using the "aws-bedrock" alias (canonical: "amazon-bedrock").
          // Use `as unknown as OpenClawConfig` because TypeScript types require baseUrl/models on
          // provider entries, but the Zod schema explicitly allows { enabled: false } stubs.
          const cfg = {
            models: {
              providers: {
                "aws-bedrock": { enabled: false },
              },
            },
          } as unknown as OpenClawConfig;

          await ensureOpenClawModelsJson(cfg, agentDir);

          const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
          const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
          expect(parsed.providers["amazon-bedrock"]).toBeUndefined();
        },
      );
    });
  });

  it("does not re-add implicit copilot provider when disabled in config", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "COPILOT_GITHUB_TOKEN"], async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);

        const agentDir = path.join(home, "agent-copilot-disable");
        process.env.OPENCLAW_AGENT_DIR = agentDir;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        // Set a Copilot token so the implicit resolver would normally add it.
        process.env.COPILOT_GITHUB_TOKEN = "gho_test_copilot_token";

        // Mock the token exchange to succeed.
        const fetchMock = (await import("vitest")).vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            token: "copilot-token;proxy-ep=proxy.copilot.example",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        });
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        // Use `as unknown as OpenClawConfig` because TypeScript types require baseUrl/models on
        // provider entries, but the Zod schema explicitly allows { enabled: false } stubs.
        const cfg = {
          models: {
            providers: {
              "github-copilot": { enabled: false },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await ensureOpenClawModelsJson(cfg, agentDir);

        // If anything was written, copilot must not appear.
        if (result.wrote) {
          const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
          const parsed = JSON.parse(raw) as { providers: Record<string, ProviderConfig> };
          expect(parsed.providers["github-copilot"]).toBeUndefined();
        }
      });
    });
  });
});
