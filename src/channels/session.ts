import type { MsgContext } from "../auto-reply/templating.js";
import {
  recordSessionMetaFromInbound,
  type GroupKeyResolution,
  type SessionEntry,
  updateLastRoute,
} from "../config/sessions.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";

function normalizeSessionStoreKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

export type InboundLastRouteUpdate = {
  sessionKey: string;
  channel: SessionEntry["lastChannel"];
  to: string;
  accountId?: string;
  threadId?: string | number;
  mainDmOwnerPin?: {
    ownerRecipient: string;
    senderRecipient: string;
    onSkip?: (params: { ownerRecipient: string; senderRecipient: string }) => void;
  };
};

function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  if (!pin) {
    return false;
  }
  const owner = pin.ownerRecipient.trim().toLowerCase();
  const sender = pin.senderRecipient.trim().toLowerCase();
  if (!owner || !sender || owner === sender) {
    return false;
  }
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeSessionStoreKey(sessionKey);
  void recordSessionMetaFromInbound({
    storePath,
    sessionKey: canonicalSessionKey,
    ctx,
    groupResolution,
    createIfMissing,
  }).catch(params.onRecordError);

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  // WebChat (INTERNAL_MESSAGE_CHANNEL) is a cross-channel viewer that replies
  // via WebSocket, not through deliveryContext routing.  Updating the session's
  // delivery fields to "webchat" would break announce/heartbeat/cron delivery
  // for whichever external channel actually owns the conversation.
  if (isInternalMessageChannel(update.channel)) {
    return;
  }
  const targetSessionKey = normalizeSessionStoreKey(update.sessionKey);
  await updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
  });
}
