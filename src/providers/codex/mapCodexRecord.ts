/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent } from "../../core/events";
import type { HookRecord } from "../claude-code/hookRecord";
import { mapHookRecord } from "../claude-code/mapHookRecord";

// hooks/tycoon-codex-hook.cjs already translates every codex notify/hooks
// payload into HookRecord-shaped lines carrying provider:"codex" (event
// names mapped to the Claude-hook vocabulary: UserPromptSubmit, PreToolUse,
// SubagentStop, Stop — see that script's HOOKS_EVENT_MAP). So, mirroring
// src/providers/opencode/mapOpenCodeRecord.ts, this mapper just delegates
// straight to mapHookRecord rather than duplicating its switch. Records
// carrying an event name with no Claude-hook analogue (permission_request,
// pre_compact, post_compact, interrupt) fall through mapHookRecord's
// default case and produce [] — same behavior as any other unrecognized
// HookRecord.event, never a throw.
export function mapCodexRecord(record: unknown): NormalizedEvent[] {
  return mapHookRecord(record as HookRecord);
}
