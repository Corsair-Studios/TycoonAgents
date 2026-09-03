// Throwaway spike plugin — DO NOT ship. Records exact payload shapes of
// OpenCode plugin hooks so a later phase can map them to TycoonAgents'
// activity records without guessing.
//
// Docs read: https://opencode.ai/docs/plugins, https://opencode.ai/docs/agents.
// Types confirmed against the locally installed packages:
//   .opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts
//   .opencode/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
//   .opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
//
// Key finding from a real run (.opencode/plugin/probe-log.jsonl): only
// tool.execute.before/after ever fired. session.* and message.* never did,
// because those are NOT top-level hook keys in OpenCode's plugin API — bus
// events are delivered through exactly one hook:
//
//   event: async ({ event }) => { ... }   // event.type e.g. "session.created",
//                                         // "message.updated",
//                                         // "message.part.updated",
//                                         // "session.idle";
//                                         // event.properties = payload
//
// (Hooks type at @opencode-ai/plugin/dist/index.d.ts: `event?: (input: {
// event: Event }) => Promise<void>`.) The plain top-level keys used below
// (session.created, message.updated, etc.) are kept registered too since
// they're harmless no-ops, but the `event` hook is what actually fires for
// bus events.
//
// SDK call used to pull a session's message/usage history:
//   client.session.messages({ path: { id: sessionId } })
// returns (per SessionMessagesResponses in types.gen.d.ts):
//   { data: Array<{ info: Message; parts: Part[] }>, error, request, response }
// where Message = UserMessage | AssistantMessage, and AssistantMessage
// carries { id, modelID, providerID, cost, tokens: { input, output,
// reasoning, cache: { read, write } }, time: { created, completed? } }.

import * as fs from "node:fs";
import * as path from "node:path";

const LOG_PATH = path.join(__dirname, "probe-log.jsonl");
const MAX_STRING_BYTES = 8 * 1024; // 8 KB

/**
 * Recursively truncate any string longer than MAX_STRING_BYTES so a giant
 * base64 image part (or huge tool output) doesn't blow up the log file.
 */
function truncateDeep(value: any, seen: WeakSet<object> = new WeakSet()): any {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_BYTES) {
      const truncatedCount = value.length - MAX_STRING_BYTES;
      return value.slice(0, MAX_STRING_BYTES) + `…[truncated ${truncatedCount} chars]`;
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => truncateDeep(v, seen));
  }
  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    try {
      out[key] = truncateDeep(value[key], seen);
    } catch (err) {
      out[key] = `[unreadable: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  return out;
}

/** Append one JSON line to probe-log.jsonl. Never throws. */
function record(hook: string, payload: unknown): void {
  try {
    const entry = {
      hook,
      at: Date.now(),
      payload: truncateDeep(payload),
    };
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Last-resort: try to at least note the failure, but never let logging
    // itself throw out of a hook handler.
    try {
      fs.appendFileSync(
        LOG_PATH,
        JSON.stringify({
          hook: "PROBE_ERROR",
          at: Date.now(),
          error: err instanceof Error ? err.message : String(err),
          note: `failed while recording hook "${hook}"`,
        }) + "\n",
        "utf8"
      );
    } catch {
      // genuinely nothing more we can do
    }
  }
}

/** Wrap a hook body so it can never throw back into OpenCode's dispatcher. */
function guarded(hook: string, fn: (...args: any[]) => void | Promise<void>) {
  return async (...args: any[]) => {
    try {
      record(hook, args.length === 1 ? args[0] : args);
      await fn(...args);
    } catch (err) {
      record("PROBE_ERROR", {
        hook,
        error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      });
    }
  };
}

// Per-session counters so message.part.updated (which can fire dozens of
// times per turn as text streams in) doesn't explode the log: log only the
// first 3 occurrences per session, then a summary line every 50 after that.
const partUpdatedCounts = new Map<string, number>();

function shouldLogPartUpdated(sessionID: string | undefined): { log: boolean; summary: boolean; count: number } {
  const key = sessionID ?? "__unknown__";
  const prev = partUpdatedCounts.get(key) ?? 0;
  const count = prev + 1;
  partUpdatedCounts.set(key, count);
  if (count <= 3) {
    return { log: true, summary: false, count };
  }
  if (count % 50 === 0) {
    return { log: true, summary: true, count };
  }
  return { log: false, summary: false, count };
}

/**
 * Pull the usage/cost info for the last assistant message in a session via
 * the SDK client. Returns null (and logs PROBE_ERROR) on any failure so a
 * wrong method/shape is visible in the log rather than silently swallowed.
 */
async function fetchSessionUsage(
  client: any,
  sessionId: string,
  label: "PROBE_CHILD_USAGE" | "PROBE_PARENT_USAGE"
): Promise<void> {
  try {
    const res = await client.session.messages({ path: { id: sessionId } });
    const messages: Array<{ info: any; parts: any[] }> = res?.data ?? [];
    const assistantInfos = messages
      .map((m) => m.info)
      .filter((info) => info && info.role === "assistant")
      .map((info) => ({
        id: info.id,
        modelID: info.modelID,
        providerID: info.providerID,
        tokens: info.tokens,
        cost: info.cost,
        time: info.time,
      }));
    const summedTokens = assistantInfos.reduce(
      (acc, a) => {
        const t = a.tokens ?? {};
        acc.input += t.input ?? 0;
        acc.output += t.output ?? 0;
        acc.reasoning += t.reasoning ?? 0;
        acc.cacheRead += t.cache?.read ?? 0;
        acc.cacheWrite += t.cache?.write ?? 0;
        return acc;
      },
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    );
    record(label, {
      sessionId,
      messageCount: messages.length,
      assistantInfos,
      summedTokens,
    });
  } catch (err) {
    record("PROBE_ERROR", {
      hook: label,
      sessionId,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
  }
}

// Plain-JS variant (no static @opencode-ai/plugin import at runtime, though
// the shape now matches the real `Plugin` type from that package 1:1 —
// see PluginInput/Hooks in @opencode-ai/plugin/dist/index.d.ts).
export const ProbePlugin = async (_ctx: {
  project?: unknown;
  client?: any;
  $?: unknown;
  directory?: unknown;
  worktree?: unknown;
}) => {
  record("PROBE_INIT", { note: "plugin instantiated", ctx: Object.keys(_ctx ?? {}) });

  const client = _ctx?.client;

  return {
    // --- The real bus-event hook: OpenCode delivers session.*/message.*/etc.
    // through this ONE hook, keyed by event.type, not as top-level hook names.
    event: guarded("event:dispatch", async (input: { event: { type: string; properties?: any } }) => {
      const evt = input?.event;
      const type = evt?.type ?? "unknown";
      const properties = evt?.properties;

      if (type === "message.part.updated") {
        const sessionID = properties?.part?.sessionID ?? properties?.sessionID;
        const status = shouldLogPartUpdated(sessionID);
        if (status.log) {
          record(`event:${type}`, status.summary ? { summary: true, sessionID, count: status.count } : { payload: properties });
        }
      } else {
        record(`event:${type}`, properties);
      }

      // Tap PROBE_CHILD_USAGE / PROBE_PARENT_USAGE opportunistically off
      // session.idle too, in case tool.execute.after fires before the
      // child session has finished writing its final assistant message.
      if (type === "session.idle" && client) {
        const sessionID = properties?.sessionID ?? properties?.info?.id;
        if (sessionID) {
          await fetchSessionUsage(client, sessionID, "PROBE_PARENT_USAGE");
        }
      }
    }),

    // --- Tool events ---
    "tool.execute.before": guarded("tool.execute.before", () => {}),
    "tool.execute.after": guarded(
      "tool.execute.after",
      async (
        input: { tool: string; sessionID: string; callID: string; args: any },
        output: { title: string; output: string; metadata: any }
      ) => {
        if (input?.tool !== "task") return;
        if (!client) {
          record("PROBE_ERROR", { hook: "tool.execute.after:task", error: "no client on plugin ctx" });
          return;
        }

        const childSessionId = output?.metadata?.sessionId ?? output?.metadata?.sessionID;
        const parentSessionId = input.sessionID;

        if (childSessionId) {
          await fetchSessionUsage(client, childSessionId, "PROBE_CHILD_USAGE");
        } else {
          record("PROBE_ERROR", {
            hook: "tool.execute.after:task",
            error: "no output.metadata.sessionId on task output",
            metadataKeys: output?.metadata ? Object.keys(output.metadata) : null,
          });
        }

        if (parentSessionId) {
          await fetchSessionUsage(client, parentSessionId, "PROBE_PARENT_USAGE");
        }
      }
    ),

    // --- Session events (kept as harmless no-ops; see `event` hook above
    // for what actually fires) ---
    "session.created": guarded("session.created", () => {}),
    "session.updated": guarded("session.updated", () => {}),
    "session.idle": guarded("session.idle", () => {}),
    "session.deleted": guarded("session.deleted", () => {}),
    "session.status": guarded("session.status", () => {}),
    "session.error": guarded("session.error", () => {}),
    "session.compacted": guarded("session.compacted", () => {}),
    "session.diff": guarded("session.diff", () => {}),

    // --- Message events (closest thing to a chat/prompt hook) ---
    "message.updated": guarded("message.updated", () => {}),
    "message.part.updated": guarded("message.part.updated", () => {}),
    "message.removed": guarded("message.removed", () => {}),
    "message.part.removed": guarded("message.part.removed", () => {}),

    // --- Permission events ---
    "permission.asked": guarded("permission.asked", () => {}),
    "permission.replied": guarded("permission.replied", () => {}),

    // --- Command events ---
    "command.executed": guarded("command.executed", () => {}),

    // --- File events ---
    "file.edited": guarded("file.edited", () => {}),
    "file.watcher.updated": guarded("file.watcher.updated", () => {}),

    // --- Installation / LSP / server / todo / shell / TUI / experimental ---
    "installation.updated": guarded("installation.updated", () => {}),
    "lsp.client.diagnostics": guarded("lsp.client.diagnostics", () => {}),
    "lsp.updated": guarded("lsp.updated", () => {}),
    "server.connected": guarded("server.connected", () => {}),
    "todo.updated": guarded("todo.updated", () => {}),
    "shell.env": guarded("shell.env", () => {}),
    "tui.prompt.append": guarded("tui.prompt.append", () => {}),
    "tui.command.execute": guarded("tui.command.execute", () => {}),
    "tui.toast.show": guarded("tui.toast.show", () => {}),
    "experimental.session.compacting": guarded("experimental.session.compacting", () => {}),
  };
};

export default ProbePlugin;
