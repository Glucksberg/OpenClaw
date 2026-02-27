import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { resolveAuthStorePath } from "./auth-profiles/paths.js";
import {
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

describe("saveAuthProfileStore", () => {
  it("strips plaintext when keyRef/tokenRef are present", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-runtime-value",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            token: "gh-runtime-token",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic-plain",
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<
          string,
          { key?: string; keyRef?: unknown; token?: string; tokenRef?: unknown }
        >;
      };

      expect(parsed.profiles["openai:default"]?.key).toBeUndefined();
      expect(parsed.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });

      expect(parsed.profiles["github-copilot:default"]?.token).toBeUndefined();
      expect(parsed.profiles["github-copilot:default"]?.tokenRef).toEqual({
        source: "env",
        provider: "default",
        id: "GITHUB_TOKEN",
      });

      expect(parsed.profiles["anthropic:default"]?.key).toBe("sk-anthropic-plain");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("strips redaction sentinel from api_key credentials on save (issue #23264)", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-sentinel-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: REDACTED_SENTINEL,
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-real-key",
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { key?: string }>;
      };

      // Sentinel should be stripped — never persisted as a credential value
      expect(parsed.profiles["openai:default"]?.key).toBeUndefined();
      // Real keys must be preserved
      expect(parsed.profiles["anthropic:default"]?.key).toBe("sk-real-key");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("strips redaction sentinel from token credentials on save (issue #23264)", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-sentinel-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "telegram:default": {
            type: "token",
            provider: "telegram",
            token: REDACTED_SENTINEL,
          },
          "github:default": {
            type: "token",
            provider: "github",
            token: "ghp-real-token",
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { token?: string }>;
      };

      // Sentinel should be stripped — never persisted as a credential value
      expect(parsed.profiles["telegram:default"]?.token).toBeUndefined();
      // Real tokens must be preserved
      expect(parsed.profiles["github:default"]?.token).toBe("ghp-real-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("loadAuthProfileStoreForAgent – sentinel rejection (issue #23264)", () => {
  it("drops api_key profiles with sentinel value on load", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-load-sentinel-"));
    try {
      // Simulate a corrupted on-disk store where the sentinel was persisted
      const corruptedStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: REDACTED_SENTINEL,
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-valid-key",
          },
        },
      };
      const storePath = resolveAuthStorePath(agentDir);
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(corruptedStore, null, 2));

      const loaded = loadAuthProfileStoreForSecretsRuntime(agentDir);

      // The sentinel-corrupted profile should be rejected on load
      expect(loaded.profiles["openai:default"]).toBeUndefined();
      // Valid profiles must still load
      const anthropic = loaded.profiles["anthropic:default"];
      expect(anthropic?.type).toBe("api_key");
      expect(anthropic?.type === "api_key" ? anthropic.key : undefined).toBe("sk-valid-key");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("drops token profiles with sentinel value on load", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-load-sentinel-"));
    try {
      const corruptedStore = {
        version: 1,
        profiles: {
          "telegram:default": {
            type: "token",
            provider: "telegram",
            token: REDACTED_SENTINEL,
          },
          "github:default": {
            type: "token",
            provider: "github",
            token: "ghp-valid-token",
          },
        },
      };
      const storePath = resolveAuthStorePath(agentDir);
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(corruptedStore, null, 2));

      const loaded = loadAuthProfileStoreForSecretsRuntime(agentDir);

      // The sentinel-corrupted profile should be rejected on load
      expect(loaded.profiles["telegram:default"]).toBeUndefined();
      // Valid profiles must still load
      const github = loaded.profiles["github:default"];
      expect(github?.type).toBe("token");
      expect(github?.type === "token" ? github.token : undefined).toBe("ghp-valid-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
