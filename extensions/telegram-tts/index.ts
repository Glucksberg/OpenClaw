/**
 * telegram-tts - Automatic TTS for chat responses
 *
 * Self-contained TTS extension that calls ElevenLabs/OpenAI APIs directly.
 * No external CLI dependencies.
 *
 * Features:
 * - /tts_on, /tts_off commands to toggle TTS mode
 * - /audio command for one-shot voice responses
 * - speak tool for programmatic TTS
 * - Multi-provider support (ElevenLabs, OpenAI)
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, createWriteStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { PluginApi } from "clawdbot";

const PLUGIN_ID = "telegram-tts";

// =============================================================================
// Types
// =============================================================================

interface TtsConfig {
  enabled?: boolean;
  provider?: "elevenlabs" | "openai";
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  prefsPath?: string;
  maxTextLength?: number;
}

interface UserPreferences {
  tts?: {
    enabled?: boolean;
  };
}

interface TtsResult {
  success: boolean;
  audioPath?: string;
  error?: string;
}

// =============================================================================
// Configuration & Preferences
// =============================================================================

function getPrefsPath(config: TtsConfig): string {
  return (
    config.prefsPath ||
    process.env.CLAWDBOT_TTS_PREFS ||
    join(process.env.HOME || "/home/dev", "clawd", ".user-preferences.json")
  );
}

function isTtsEnabled(prefsPath: string): boolean {
  try {
    if (!existsSync(prefsPath)) return false;
    const prefs: UserPreferences = JSON.parse(readFileSync(prefsPath, "utf8"));
    return prefs?.tts?.enabled === true;
  } catch {
    return false;
  }
}

function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  let prefs: UserPreferences = {};
  try {
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8"));
    }
  } catch {
    // ignore
  }
  prefs.tts = { enabled };
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}

function getApiKey(config: TtsConfig, provider: string): string | undefined {
  if (provider === "elevenlabs") {
    return (
      config.elevenlabs?.apiKey ||
      process.env.ELEVENLABS_API_KEY ||
      process.env.XI_API_KEY
    );
  }
  if (provider === "openai") {
    return config.openai?.apiKey || process.env.OPENAI_API_KEY;
  }
  return undefined;
}

// =============================================================================
// TTS Providers
// =============================================================================

async function elevenLabsTTS(
  text: string,
  apiKey: string,
  voiceId: string = "pMsXgVXv3BLzUgSXRplE",
  modelId: string = "eleven_multilingual_v2"
): Promise<Buffer> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${error}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function openaiTTS(
  text: string,
  apiKey: string,
  model: string = "tts-1",
  voice: string = "alloy"
): Promise<Buffer> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI TTS API error (${response.status}): ${error}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// =============================================================================
// Core TTS Function
// =============================================================================

async function textToSpeech(text: string, config: TtsConfig): Promise<TtsResult> {
  const provider = config.provider || "elevenlabs";
  const apiKey = getApiKey(config, provider);

  if (!apiKey) {
    return {
      success: false,
      error: `No API key found for provider: ${provider}. Set ${provider === "elevenlabs" ? "ELEVENLABS_API_KEY" : "OPENAI_API_KEY"} environment variable.`,
    };
  }

  const maxLen = config.maxTextLength || 4000;
  if (text.length > maxLen) {
    return {
      success: false,
      error: `Text too long (${text.length} chars, max ${maxLen})`,
    };
  }

  try {
    let audioBuffer: Buffer;

    if (provider === "elevenlabs") {
      audioBuffer = await elevenLabsTTS(
        text,
        apiKey,
        config.elevenlabs?.voiceId,
        config.elevenlabs?.modelId
      );
    } else if (provider === "openai") {
      audioBuffer = await openaiTTS(
        text,
        apiKey,
        config.openai?.model,
        config.openai?.voice
      );
    } else {
      return { success: false, error: `Unknown provider: ${provider}` };
    }

    // Save to temp file
    const tempDir = mkdtempSync(join(tmpdir(), "tts-"));
    const audioPath = join(tempDir, `voice-${Date.now()}.mp3`);
    writeFileSync(audioPath, audioBuffer);

    return { success: true, audioPath };
  } catch (err) {
    return {
      success: false,
      error: `TTS conversion failed: ${(err as Error).message}`,
    };
  }
}

// =============================================================================
// Plugin Registration
// =============================================================================

export default function register(api: PluginApi) {
  const log = api.logger;
  const config = (api.pluginConfig || {}) as TtsConfig;
  const prefsPath = getPrefsPath(config);

  log.info(`[${PLUGIN_ID}] Registering plugin...`);
  log.info(`[${PLUGIN_ID}] Provider: ${config.provider || "elevenlabs"}`);
  log.info(`[${PLUGIN_ID}] Preferences: ${prefsPath}`);

  // ===========================================================================
  // Tool: speak
  // ===========================================================================
  api.registerTool({
    name: "speak",
    description: `Convert text to speech and send as voice message.
Use this tool when:
- TTS mode is enabled (check with tts.status RPC)
- User explicitly requests audio/voice response
- Responding to /audio command

The tool generates an MP3 file and returns the path for delivery.`,
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to convert to speech",
        },
      },
      required: ["text"],
    },
    execute: async (_id: string, params: { text: string }) => {
      const { text } = params;
      log.info(`[${PLUGIN_ID}] speak() called, length: ${text?.length || 0}`);

      if (!text) {
        return { content: [{ type: "text", text: "Error: No text provided" }] };
      }

      const result = await textToSpeech(text, config);

      if (result.success && result.audioPath) {
        log.info(`[${PLUGIN_ID}] Audio generated: ${result.audioPath}`);
        // Return with MEDIA directive for clawdbot to send
        return {
          content: [
            {
              type: "text",
              text: `MEDIA:${result.audioPath}`,
            },
          ],
        };
      }

      log.error(`[${PLUGIN_ID}] TTS failed: ${result.error}`);
      return {
        content: [
          {
            type: "text",
            text: result.error || "TTS conversion failed",
          },
        ],
      };
    },
  });

  // ===========================================================================
  // RPC Methods
  // ===========================================================================

  // tts.status - Check if TTS is enabled
  api.registerGatewayMethod("tts.status", async () => ({
    enabled: isTtsEnabled(prefsPath),
    provider: config.provider || "elevenlabs",
    prefsPath,
    hasApiKey: !!getApiKey(config, config.provider || "elevenlabs"),
  }));

  // tts.enable - Enable TTS mode
  api.registerGatewayMethod("tts.enable", async () => {
    setTtsEnabled(prefsPath, true);
    log.info(`[${PLUGIN_ID}] TTS enabled via RPC`);
    return { ok: true, enabled: true };
  });

  // tts.disable - Disable TTS mode
  api.registerGatewayMethod("tts.disable", async () => {
    setTtsEnabled(prefsPath, false);
    log.info(`[${PLUGIN_ID}] TTS disabled via RPC`);
    return { ok: true, enabled: false };
  });

  // tts.convert - Convert text to audio (returns path)
  api.registerGatewayMethod("tts.convert", async (params: { text: string }) => {
    if (!params.text) {
      return { ok: false, error: "No text provided" };
    }
    const result = await textToSpeech(params.text, config);
    if (result.success) {
      return { ok: true, audioPath: result.audioPath };
    }
    return { ok: false, error: result.error };
  });

  // tts.providers - List available providers and their status
  api.registerGatewayMethod("tts.providers", async () => ({
    providers: [
      {
        id: "elevenlabs",
        name: "ElevenLabs",
        configured: !!getApiKey(config, "elevenlabs"),
        models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_monolingual_v1"],
      },
      {
        id: "openai",
        name: "OpenAI",
        configured: !!getApiKey(config, "openai"),
        models: ["tts-1", "tts-1-hd"],
        voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
      },
    ],
    active: config.provider || "elevenlabs",
  }));

  // ===========================================================================
  // Startup
  // ===========================================================================

  const ttsEnabled = isTtsEnabled(prefsPath);
  const hasKey = !!getApiKey(config, config.provider || "elevenlabs");

  log.info(`[${PLUGIN_ID}] Ready. TTS: ${ttsEnabled ? "ON" : "OFF"}, API Key: ${hasKey ? "OK" : "MISSING"}`);

  if (!hasKey) {
    log.warn(
      `[${PLUGIN_ID}] No API key configured. Set ELEVENLABS_API_KEY or OPENAI_API_KEY.`
    );
  }
}

// =============================================================================
// Plugin Metadata
// =============================================================================

export const meta = {
  id: PLUGIN_ID,
  name: "Telegram TTS",
  description: "Text-to-speech for chat responses using ElevenLabs or OpenAI",
  version: "0.2.0",
};
