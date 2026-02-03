import type { FallbackAttempt } from "../../agents/model-fallback.js";

/**
 * In-memory tracker for fallback model notifications.
 *
 * Ensures the user is notified only ONCE per failover event —
 * i.e., when the fallback model changes or the primary recovers
 * and then fails again.
 */
const lastNotifiedFallback = new Map<string, string>();

/**
 * Determine whether a fallback notification should be shown to the user.
 *
 * Returns a notification message when:
 * 1. The primary model failed and a different fallback model was used
 * 2. We haven't already notified about this specific fallback for this session
 *
 * Clears the tracker when the primary model succeeds (no attempts).
 */
export function checkFallbackNotification(params: {
  sessionKey: string | undefined;
  originalProvider: string;
  originalModel: string;
  usedProvider: string;
  usedModel: string;
  attempts: FallbackAttempt[];
}): string | undefined {
  const { sessionKey, originalProvider, originalModel, usedProvider, usedModel, attempts } = params;

  // No failed attempts — primary model succeeded
  if (attempts.length === 0) {
    if (sessionKey) {
      lastNotifiedFallback.delete(sessionKey);
    }
    return undefined;
  }

  // Fallback was used — check if it's actually a different model
  const usedKey = `${usedProvider}/${usedModel}`;
  const primaryKey = `${originalProvider}/${originalModel}`;

  if (usedKey === primaryKey) {
    return undefined;
  }

  // Already notified about this exact fallback for this session
  if (sessionKey && lastNotifiedFallback.get(sessionKey) === usedKey) {
    return undefined;
  }

  // Record notification
  if (sessionKey) {
    lastNotifiedFallback.set(sessionKey, usedKey);
  }

  // Build a concise reason from the first failed attempt
  const primaryAttempt = attempts[0];
  const reason = primaryAttempt?.reason ? ` (${primaryAttempt.reason})` : "";

  return `⚡ Using fallback model \`${usedProvider}/${usedModel}\` — primary \`${primaryKey}\` is unavailable${reason}`;
}
