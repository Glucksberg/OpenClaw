import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MessageEvent, PostbackEvent } from "@line/bot-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildLineMessageContext, buildLinePostbackContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";

describe("buildLineMessageContext", () => {
  let tmpDir: string;
  let storePath: string;
  let cfg: OpenClawConfig;
  const account: ResolvedLineAccount = {
    accountId: "default",
    enabled: true,
    channelAccessToken: "token",
    channelSecret: "secret",
    tokenSource: "config",
    config: {},
  };

  const createMessageEvent = (
    source: MessageEvent["source"],
    overrides?: Partial<MessageEvent>,
  ): MessageEvent =>
    ({
      type: "message",
      message: { id: "1", type: "text", text: "hello" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source,
      mode: "active",
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
      ...overrides,
    }) as MessageEvent;

  const createPostbackEvent = (
    source: PostbackEvent["source"],
    overrides?: Partial<PostbackEvent>,
  ): PostbackEvent =>
    ({
      type: "postback",
      postback: { data: "action=select" },
      replyToken: "reply-token",
      timestamp: Date.now(),
      source,
      mode: "active",
      webhookEventId: "evt-2",
      deliveryContext: { isRedelivery: false },
      ...overrides,
    }) as PostbackEvent;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-context-"));
    storePath = path.join(tmpDir, "sessions.json");
    cfg = { session: { store: storePath } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  it("routes group message replies to the group id", async () => {
    const event = createMessageEvent({ type: "group", groupId: "group-1", userId: "user-1" });

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
    });
    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("context missing");
    }

    expect(context.ctxPayload.OriginatingTo).toBe("line:group:group-1");
    expect(context.ctxPayload.To).toBe("line:group:group-1");
  });

  it("routes group postback replies to the group id", async () => {
    const event = createPostbackEvent({ type: "group", groupId: "group-2", userId: "user-2" });

    const context = await buildLinePostbackContext({
      event,
      cfg,
      account,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:group:group-2");
    expect(context?.ctxPayload.To).toBe("line:group:group-2");
  });

  it("routes room postback replies to the room id", async () => {
    const event = createPostbackEvent({ type: "room", roomId: "room-1", userId: "user-3" });

    const context = await buildLinePostbackContext({
      event,
      cfg,
      account,
    });

    expect(context?.ctxPayload.OriginatingTo).toBe("line:room:room-1");
    expect(context?.ctxPayload.To).toBe("line:room:room-1");
  });

  it("builds context for file messages with filename and media ref", async () => {
    const event = createMessageEvent(
      { type: "user", userId: "user-file" },
      {
        message: {
          id: "file-1",
          type: "file",
          fileName: "report.pdf",
          fileSize: "12345",
        } as unknown as MessageEvent["message"],
      },
    );

    const context = await buildLineMessageContext({
      event,
      allMedia: [{ path: "/tmp/line-media-abc.pdf", contentType: "application/pdf" }],
      cfg,
      account,
    });

    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("context missing");
    }

    // Should include filename in body
    expect(context.ctxPayload.Body).toContain("report.pdf");
    // Should include media path
    expect(context.ctxPayload.MediaUrl).toBe("/tmp/line-media-abc.pdf");
  });

  it("builds context for file messages without media (download failed)", async () => {
    const event = createMessageEvent(
      { type: "user", userId: "user-file-2" },
      {
        message: {
          id: "file-2",
          type: "file",
          fileName: "data.xlsx",
          fileSize: "999",
        } as unknown as MessageEvent["message"],
      },
    );

    const context = await buildLineMessageContext({
      event,
      allMedia: [],
      cfg,
      account,
    });

    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("context missing");
    }

    // Should still have body from extractMessageText (filename)
    expect(context.ctxPayload.Body).toContain("data.xlsx");
  });
});
