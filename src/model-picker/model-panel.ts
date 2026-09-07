import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { normalizeThinkLevel, resolveSupportedThinkingLevel } from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ModelPanelAction = "home" | "details" | "providers" | "default";
export type ModelPanelControl = { text: string; action: ModelPanelAction };
type ModelPanelView = { text: string; controls: ModelPanelControl[][] };

/** Command-owned controls; channels only encode their typed actions. */
export const MODEL_PANEL_NAVIGATION: ModelPanelControl[][] = [
  [
    { text: "Change model", action: "providers" },
    { text: "Back to panel", action: "home" },
  ],
];

export function formatModelPanelSelection(params: {
  provider: string;
  model: string;
  isDefault: boolean;
  authNotice?: string;
  runtimeReset: boolean;
  pending: boolean;
}): string {
  return [
    params.isDefault
      ? "✅ Session selection cleared; using the agent default."
      : `✅ Session model changed to ${params.provider}/${params.model}.`,
    "Configured defaults are unchanged.",
    params.pending ? "Pending: applies at the next clean retry point." : undefined,
    params.authNotice,
    params.runtimeReset ? "Runtime reset to configured policy." : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildModelPanel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  agentId: string;
  thinking?: string;
  sessionEntry?: Partial<SessionEntry>;
  details?: boolean;
}): ModelPanelView {
  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
  });
  const thinking =
    params.thinking ??
    resolveSupportedThinkingLevel({
      provider: params.provider,
      model: params.model,
      agentRuntime,
      level:
        normalizeThinkLevel(params.sessionEntry?.thinkingLevel) ??
        resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault ??
        resolveThinkingDefault({
          cfg: params.cfg,
          provider: params.provider,
          model: params.model,
          agentRuntime,
        }),
    });
  const refs = resolveSelectedAndActiveModel({
    selectedProvider: params.provider,
    selectedModel: params.model,
    sessionEntry: params.sessionEntry,
  });
  return {
    text: [
      "Session model",
      `Selected: ${refs.selected.label}`,
      refs.activeDiffers ? `Active: ${refs.active.label} (runtime)` : undefined,
      `Agent default: ${params.defaultProvider}/${params.defaultModel}`,
      `Think: ${thinking}`,
      params.details ? `Agent: ${params.agentId}` : undefined,
      params.details
        ? "Changes here affect only this session and survive /new and /reset. Use the agent default to clear the session selection. During a run, changes apply at the next clean retry point."
        : "Buttons change only this session, not configured defaults.",
    ]
      .filter(Boolean)
      .join("\n"),
    controls: params.details
      ? MODEL_PANEL_NAVIGATION
      : [
          [
            { text: "Change model", action: "providers" },
            { text: "Details", action: "details" },
          ],
          [{ text: "Use agent default", action: "default" }],
        ],
  };
}
