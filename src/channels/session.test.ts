import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { recordInboundSession } from "./session.js";

async function makeTempDir(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("recordInboundSession", () => {
  let dir: string;
  let storePath: string;

  afterEach(async () => {
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("skips updateLastRoute when channel is webchat (internal)", async () => {
    dir = await makeTempDir("openclaw-session-webchat-");
    storePath = path.join(dir, "sessions.json");

    // Seed store with main session owned by telegram
    const mainKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [mainKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "telegram:123",
          lastAccountId: "default",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:123",
            accountId: "default",
          },
        },
      }),
      "utf-8",
    );

    // WebChat sends to main session
    await recordInboundSession({
      storePath,
      sessionKey: mainKey,
      ctx: {
        Body: "hello from webchat",
        SessionKey: mainKey,
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        ChatType: "direct",
      },
      updateLastRoute: {
        sessionKey: mainKey,
        channel: "webchat",
        to: "",
      },
      onRecordError: () => {},
    });

    // Delivery context should still be telegram, not webchat
    const store = loadSessionStore(storePath);
    const entry = store[mainKey];
    expect(entry?.lastChannel).toBe("telegram");
    expect(entry?.deliveryContext?.channel).toBe("telegram");
    expect(entry?.deliveryContext?.to).toBe("telegram:123");
  });

  it("updates lastRoute normally for external channels", async () => {
    dir = await makeTempDir("openclaw-session-external-");
    storePath = path.join(dir, "sessions.json");

    const mainKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [mainKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "telegram:123",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:123",
          },
        },
      }),
      "utf-8",
    );

    // Discord sends to main session
    await recordInboundSession({
      storePath,
      sessionKey: mainKey,
      ctx: {
        Body: "hello from discord",
        SessionKey: mainKey,
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        ChatType: "group",
      },
      updateLastRoute: {
        sessionKey: mainKey,
        channel: "discord",
        to: "channel:discord-456",
        accountId: "bot-1",
      },
      onRecordError: () => {},
    });

    // Delivery context should now be discord
    const store = loadSessionStore(storePath);
    const entry = store[mainKey];
    expect(entry?.lastChannel).toBe("discord");
    expect(entry?.deliveryContext?.channel).toBe("discord");
    expect(entry?.deliveryContext?.to).toBe("channel:discord-456");
  });
});
