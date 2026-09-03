/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent } from "../../core/events";
import type { HookRecord } from "../claude-code/hookRecord";
import { mapHookRecord } from "../claude-code/mapHookRecord";

// The OpenCode plugin (hooks/tycoon-opencode-plugin.ts) writes HookRecord-shaped
// lines carrying provider:"opencode" plus vendor/costModelClass/model and an
// extra "PluginError" event the Claude hook never emits. Everything else
// (UserPromptSubmit/PreToolUse/SubagentStop/Stop) maps identically to the
// Claude Code mapper, so we delegate to it directly rather than duplicating
// the switch.

export interface OpenCodePluginErrorRecord {
  event: "PluginError";
  provider: "opencode";
  at: number;
  error?: string;
}

const warnedPluginErrors = new Set<string>();

/**
 * Map one OpenCode-sourced record to NormalizedEvent[]. PluginError records
 * produce no events — they're logged once (by message) and dropped, so a
 * noisy plugin error can't spam the console every poll tick while still
 * surfacing at least once for diagnosis.
 */
export function mapOpenCodeRecord(record: unknown): NormalizedEvent[] {
  if (record && typeof record === "object" && (record as { event?: unknown }).event === "PluginError") {
    const err = record as OpenCodePluginErrorRecord;
    const message = err.error ?? "(no message)";
    if (!warnedPluginErrors.has(message)) {
      warnedPluginErrors.add(message);
      console.warn(`[tycoon] opencode plugin error: ${message}`);
    }
    return [];
  }
  return mapHookRecord(record as HookRecord);
}
