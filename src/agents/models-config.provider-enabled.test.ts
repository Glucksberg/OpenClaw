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

        // No providers should be written since the only one is disabled.
        expect(result.wrote).toBe(false);
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
});
