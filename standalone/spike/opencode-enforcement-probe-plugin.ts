// Throwaway spike plugin — DO NOT ship. Plan task p15-t0.
// Tests whether OpenCode's plugin hooks can actually BLOCK a tool call and
// INJECT text into model context, on OpenCode 1.18.27. Writes one JSON line
// per observation to enforcement-probe-log.jsonl beside this file.
//
// Mechanisms under test:
//   (a) permission.ask -> output.status = "deny"
//   (b) experimental.chat.system.transform -> output.system.push(marker)
//   (c) throwing inside tool.execute.before
//
// Types confirmed against @opencode-ai/plugin@1.18.27 (dist/index.d.ts) and
// @opencode-ai/sdk@1.18.27 (dist/gen/types.gen.d.ts), fetched via `npm pack`.

import * as fs from "node:fs";
import * as path from "node:path";

const LOG_PATH = path.join(__dirname, "enforcement-probe-log.jsonl");
const INJECTION_MARKER = "TYCOON_PROBE_MARKER_7Q2X";

function record(hook: string, payload: unknown): void {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ hook, at: Date.now(), payload }) + "\n", "utf8");
  } catch {
    // never throw from logging
  }
}

export const EnforcementProbePlugin = async (_ctx: { client?: unknown; directory?: unknown }) => {
  record("PROBE_INIT", { note: "enforcement probe instantiated" });

  return {
    "permission.ask": async (
      input: { id: string; type: string; pattern?: string | string[]; sessionID: string; title: string },
      output: { status: "ask" | "deny" | "allow" }
    ) => {
      record("permission.ask:input", input);
      // Deny anything whose title/type mentions "grep" or "read" to test
      // whether setting status stops the call.
      const haystack = `${input?.type ?? ""} ${input?.title ?? ""}`.toLowerCase();
      if (haystack.includes("grep") || haystack.includes("read")) {
        output.status = "deny";
        record("permission.ask:decision", { decision: "deny", haystack });
      } else {
        record("permission.ask:decision", { decision: "unchanged", haystack, currentStatus: output.status });
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model?: unknown },
      output: { system: string[] }
    ) => {
      record("chat.system.transform:input", { sessionID: input?.sessionID, systemCountBefore: output?.system?.length });
      if (Array.isArray(output.system)) {
        output.system.push(`INJECTED DOCTRINE: ${INJECTION_MARKER}. If you see this, end your final reply with the literal token ${INJECTION_MARKER}.`);
      }
      record("chat.system.transform:after", { systemCountAfter: output?.system?.length });
    },

    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      record("tool.execute.before", input);
      if (input?.tool === "bash") {
        // Test whether throwing here aborts the tool call.
        record("tool.execute.before:about-to-throw", { tool: input.tool });
        throw new Error("PROBE_DELIBERATE_THROW_FROM_BEFORE_HOOK");
      }
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title?: string; output?: string; metadata?: unknown }
    ) => {
      record("tool.execute.after", { tool: input?.tool, outputSnippet: typeof output?.output === "string" ? output.output.slice(0, 300) : output?.output });
    },

    event: async (input: { event: { type: string; properties?: unknown } }) => {
      record(`event:${input?.event?.type}`, input?.event?.properties);
    },
  };
};

export default EnforcementProbePlugin;
