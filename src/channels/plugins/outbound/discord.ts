import type { OpenClawConfig } from "../../../config/config.js";
import {
  allowListMatches,
  normalizeDiscordAllowList,
} from "../../../discord/monitor/allow-list.js";
import {
  getThreadBindingManager,
  type ThreadBindingRecord,
} from "../../../discord/monitor/thread-bindings.js";
import {
  sendMessageDiscord,
  sendPollDiscord,
  sendWebhookMessageDiscord,
} from "../../../discord/send.js";
import type { OutboundIdentity } from "../../../infra/outbound/identity.js";
import { missingTargetError } from "../../../infra/outbound/target-errors.js";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";
import type { ChannelOutboundAdapter } from "../types.js";

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = params.identity?.name?.trim();
  const fallbackUsername = params.binding.label?.trim() || params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = params.identity?.avatarUrl?.trim() || undefined;
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = String(params.threadId).trim();
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

/**
 * Extract the raw ID from a normalized Discord target for allowFrom comparison.
 * Strips leading kind prefixes ("user:", "channel:", "discord:") so the ID
 * can be matched against allowFrom entries that may or may not have prefixes.
 */
function extractDiscordTargetId(normalized: string): string {
  return normalized
    .replace(/^(user|channel|discord):/i, "")
    .trim()
    .toLowerCase();
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  resolveTarget: ({ to, allowFrom }) => {
    const normalized = normalizeDiscordOutboundTarget(to);
    if (!normalized.ok) {
      return normalized;
    }
    // Enforce allowFrom when a non-wildcard list is configured.
    // allowFrom entries use the same prefix conventions as the inbound
    // allowlist (e.g. "user:<id>", "discord:<id>", bare IDs, or names).
    if (allowFrom && allowFrom.length > 0 && !allowFrom.includes("*")) {
      const list = normalizeDiscordAllowList(allowFrom, ["discord:", "user:", "channel:", "pk:"]);
      if (list) {
        const rawId = extractDiscordTargetId(normalized.to);
        // Allow name-based matching so channel slugs in allowFrom work too.
        if (!allowListMatches(list, { id: rawId, name: rawId }, { allowNameMatching: true })) {
          return { ok: false, error: missingTargetError("Discord", "user:<id> or channel:<id>") };
        }
      }
    }
    return normalized;
  },
  sendPayload: async (ctx) =>
    await sendTextMediaPayload({ channel: "discord", ctx, adapter: discordOutbound }),
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
    if (!silent) {
      const webhookResult = await maybeSendDiscordWebhookText({
        cfg,
        text,
        threadId,
        accountId,
        identity,
        replyToId,
      }).catch(() => null);
      if (webhookResult) {
        return { channel: "discord", ...webhookResult };
      }
    }
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      cfg,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    silent,
  }) => {
    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to, threadId });
    const result = await send(target, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      cfg,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) => {
    const target = resolveDiscordOutboundTarget({ to, threadId });
    return await sendPollDiscord(target, poll, {
      accountId: accountId ?? undefined,
      silent: silent ?? undefined,
      cfg,
    });
  },
};
