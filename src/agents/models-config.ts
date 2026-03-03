import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { normalizeProviderId } from "./model-selection.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) {
    return { ...implicit, ...explicit };
  }

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") {
      return "";
    }
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const implicitById = new Map(
    implicitModels.map((model) => [getId(model), model] as const).filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();

  const mergedModels = explicitModels.map((explicitModel) => {
    const id = getId(explicitModel);
    if (!id) {
      return explicitModel;
    }
    seen.add(id);
    const implicitModel = implicitById.get(id);
    if (!implicitModel) {
      return explicitModel;
    }

    // Refresh capability metadata from the implicit catalog while preserving
    // user-specific fields (cost, headers, compat, etc.) on explicit entries.
    // reasoning is treated as user-overridable: if the user has explicitly set
    // it in their config (key present), honour that value; otherwise fall back
    // to the built-in catalog default so new reasoning models work out of the
    // box without requiring every user to configure it.
    return {
      ...explicitModel,
      input: implicitModel.input,
      reasoning: "reasoning" in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
      contextWindow: implicitModel.contextWindow,
      maxTokens: implicitModel.maxTokens,
    };
  });

  for (const implicitModel of implicitModels) {
    const id = getId(implicitModel);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedModels.push(implicitModel);
  }

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
  }
  return out;
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();

  // Filter out explicitly disabled providers (enabled: false) before resolution.
  // Normalize disabled keys through the same alias→canonical mapping used in
  // provider resolution so that aliases like "qwen", "aws-bedrock", "doubao"
  // correctly suppress their canonical counterparts.
  const rawProviders = cfg.models?.providers ?? {};
  const disabledIds = new Set(
    Object.entries(rawProviders)
      .filter(([, p]) => p.enabled === false)
      .map(([id]) => normalizeProviderId(id)),
  );
  const explicitProviders = Object.fromEntries(
    Object.entries(rawProviders).filter(([, p]) => p.enabled !== false),
  );
  const implicitProviders = await resolveImplicitProviders({ agentDir, explicitProviders });
  // Suppress implicit providers whose canonical ID (or the canonical ID of their
  // base, for companion "-plan" entries) matches a disabled config entry.
  // This ensures that aliases like "doubao" → "volcengine" also suppress the
  // implicitly-added "volcengine-plan" companion provider.
  if (implicitProviders) {
    for (const key of Object.keys(implicitProviders)) {
      const normalized = normalizeProviderId(key);
      // Strip a trailing "-plan" suffix so companion providers follow the base.
      const base = normalized.endsWith("-plan") ? normalized.slice(0, -"-plan".length) : normalized;
      if (disabledIds.has(normalized) || disabledIds.has(base)) {
        delete implicitProviders[key];
      }
    }
  }
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock && !disabledIds.has("amazon-bedrock")) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }
  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !disabledIds.has("github-copilot") && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }

  // When all providers are disabled and none resolved implicitly, we still need
  // to proceed through merge-mode cleanup so stale entries in models.json get removed.
  if (Object.keys(providers).length === 0 && disabledIds.size === 0) {
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  let existingRaw = "";
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<
        string,
        NonNullable<ModelsConfig["providers"]>[string]
      >;
      mergedProviders = {};
      for (const [key, entry] of Object.entries(existingProviders)) {
        // Skip providers explicitly disabled in config — toggling enabled: false
        // must remove the provider from the merged output, not preserve the stale entry.
        // Normalize the existing key so alias-keyed stale entries are also caught.
        // Also handle companion "-plan" providers: if the base provider is disabled,
        // its companion (e.g. "volcengine-plan" when "doubao" is disabled) must also go.
        const normalizedKey = normalizeProviderId(key);
        const baseKey = normalizedKey.endsWith("-plan")
          ? normalizedKey.slice(0, -"-plan".length)
          : normalizedKey;
        if (disabledIds.has(key) || disabledIds.has(normalizedKey) || disabledIds.has(baseKey)) {
          continue;
        }
        mergedProviders[key] = entry;
      }
      for (const [key, newEntry] of Object.entries(providers)) {
        const existing = existingProviders[key] as
          | (NonNullable<ModelsConfig["providers"]>[string] & {
              apiKey?: string;
              baseUrl?: string;
            })
          | undefined;
        if (existing) {
          const preserved: Record<string, unknown> = {};
          if (typeof existing.apiKey === "string" && existing.apiKey) {
            preserved.apiKey = existing.apiKey;
          }
          if (typeof existing.baseUrl === "string" && existing.baseUrl) {
            preserved.baseUrl = existing.baseUrl;
          }
          mergedProviders[key] = { ...newEntry, ...preserved };
        } else {
          mergedProviders[key] = newEntry;
        }
      }
    }
  }

  const normalizedProviders = normalizeProviders({
    providers: mergedProviders,
    agentDir,
  });
  const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
  try {
    existingRaw = await fs.readFile(targetPath, "utf8");
  } catch {
    existingRaw = "";
  }

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}
