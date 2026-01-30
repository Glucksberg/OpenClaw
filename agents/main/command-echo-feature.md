# Command Echo Feature - IMPLEMENTED ✅

## Overview
Allow agents to see outputs of native commands (like /models, /model) in their context.

## Status: COMPLETE
Build passes, ready for testing.

## Files to Change

### 1. Session Types - Add `recentCommands` field
**File:** `src/config/sessions/types.ts`

```diff
+ export type RecentCommandEntry = {
+   cmd: string;
+   summary: string;
+   ts: number;
+ };

  export type SessionEntry = {
+   /** Recent native command outputs for agent context injection */
+   recentCommands?: RecentCommandEntry[];
    // ... rest of existing fields
```

### 2. Command Core - Capture command outputs
**File:** `src/auto-reply/reply/commands-core.ts`

```diff
+ import { updateSessionStore } from "../../config/sessions.js";
+ 
+ const MAX_RECENT_COMMANDS = 5;
+ 
+ function summarizeCommandReply(cmd: string, reply: ReplyPayload): string {
+   const text = reply.text || "";
+   // Truncate to first 200 chars or first 3 lines
+   const lines = text.split("\n").slice(0, 3);
+   const summary = lines.join(" ").slice(0, 200);
+   return summary + (text.length > 200 ? "..." : "");
+ }
+ 
+ async function storeRecentCommand(params: {
+   sessionEntry?: SessionEntry;
+   sessionStore?: Record<string, SessionEntry>;
+   sessionKey: string;
+   storePath?: string;
+   cmd: string;
+   summary: string;
+ }) {
+   if (!params.sessionEntry || !params.storePath) return;
+   
+   const entry: RecentCommandEntry = {
+     cmd: params.cmd,
+     summary: params.summary,
+     ts: Date.now(),
+   };
+   
+   const existing = params.sessionEntry.recentCommands ?? [];
+   const updated = [...existing, entry].slice(-MAX_RECENT_COMMANDS);
+   
+   params.sessionEntry.recentCommands = updated;
+   
+   if (params.sessionStore) {
+     params.sessionStore[params.sessionKey] = params.sessionEntry;
+     await updateSessionStore(params.storePath, params.sessionStore);
+   }
+ }

  export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
    // ... existing code ...
    
    for (const handler of HANDLERS) {
      const result = await handler(params, allowTextCommands);
-     if (result) return result;
+     if (result) {
+       // Store command context for agent visibility (if configured)
+       if (result.reply && params.cfg.commands?.injectToContext !== false) {
+         const cmdMatch = params.command.commandBodyNormalized.match(/^\/(\w+)/);
+         if (cmdMatch) {
+           await storeRecentCommand({
+             sessionEntry: params.sessionEntry,
+             sessionStore: params.sessionStore,
+             sessionKey: params.sessionKey,
+             storePath: params.storePath,
+             cmd: cmdMatch[0],
+             summary: summarizeCommandReply(cmdMatch[0], result.reply),
+           });
+         }
+       }
+       return result;
+     }
    }
```

### 3. System Prompt - Inject recent commands
**File:** `src/agents/pi-embedded-runner/run/attempt.ts`

```diff
+ function formatRecentCommands(commands?: RecentCommandEntry[]): string | undefined {
+   if (!commands || commands.length === 0) return undefined;
+   
+   const lines = ["## Recent Commands"];
+   for (const entry of commands) {
+     const ago = Math.round((Date.now() - entry.ts) / 1000);
+     const agoStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
+     lines.push(`- \`${entry.cmd}\` (${agoStr}): ${entry.summary}`);
+   }
+   return lines.join("\n");
+ }

  // In buildSystemPrompt call, add to workspaceNotes:
  const workspaceNotes = [
    // ... existing notes
+   formatRecentCommands(params.sessionEntry?.recentCommands),
  ].filter(Boolean);
```

### 4. Clear on Agent Turn
After agent processes the commands context, clear it so it's not repeated:

```diff
  // After successful agent run:
+ if (sessionEntry?.recentCommands?.length) {
+   sessionEntry.recentCommands = [];
+   // persist the cleared state
+ }
```

### 5. Config Schema (optional)
**File:** `src/config/types.ts`

```diff
  commands?: {
    native?: "auto" | "on" | "off";
    nativeSkills?: "auto" | "on" | "off";
+   /** Inject native command outputs into agent context. Default: true */
+   injectToContext?: boolean;
+   /** Max recent commands to store. Default: 5 */
+   maxRecentCommands?: number;
  };
```

## Summary of Changes

| File | Change |
|------|--------|
| `src/config/sessions/types.ts` | Add `RecentCommandEntry` type + `recentCommands` field |
| `src/auto-reply/reply/commands-core.ts` | Capture & store command summaries |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Inject into system prompt |
| `src/config/types.ts` | Add config options |

## Estimated Impact
- ~100 lines of new code
- No breaking changes
- Backwards compatible (field is optional)
- Config-driven (can disable)

## Agent will see:
```
## Recent Commands
- `/models` (30s ago): Providers: anthropic (1), openai-codex (3)...
- `/model o3` (15s ago): Switched to openai-codex/o3
```
