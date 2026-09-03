/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Entry point for the claude-code provider. Importing this module registers
// its record->NormalizedEvent[] mapper into src/core's mappingRegistry, so
// any host that wants claude-code events flowing must import from here
// (not mapHookRecord.ts directly) before the first record arrives.

import type { NormalizedEvent } from "../../core/events";
import { registerMapper, DEFAULT_PROVIDER_ID } from "../../core/mappingRegistry";
import { mapHookRecord } from "./mapHookRecord";
import type { HookRecord } from "./hookRecord";

registerMapper(DEFAULT_PROVIDER_ID, (record: unknown) => mapHookRecord(record as HookRecord) as NormalizedEvent[]);

export { ClaudeCodeProvider } from "./claudeCodeProvider";
export { mapHookRecord } from "./mapHookRecord";
