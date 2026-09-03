/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { NormalizedEvent } from "./events";

// Provider-agnostic mapping registry: turns a provider's raw record shape into
// NormalizedEvent[] without src/core needing to import any specific provider
// (see docs/DESIGN.md section 6). Each provider module registers its own
// mapper at load time (see src/providers/claude-code/index.ts).

/** The provider id used when a record carries no explicit `provider` field. */
export const DEFAULT_PROVIDER_ID = "claude-code";

type MapperFn = (record: unknown) => NormalizedEvent[];

const mappers = new Map<string, MapperFn>();

/** Register a mapper function for a provider id. Re-registering overwrites. */
export function registerMapper(providerId: string, fn: MapperFn): void {
  mappers.set(providerId, fn);
}

/** True if a mapper is currently registered for providerId. */
export function hasMapper(providerId: string): boolean {
  return mappers.has(providerId);
}

/**
 * Lazily register the default (claude-code) mapper if nothing has registered
 * one yet. This exists ONLY for backward compatibility with consumers that
 * require the compiled out/src/core/state.js directly (e.g. standalone/'s
 * sharedLogic.mjs) without ever loading src/providers/claude-code/index.ts,
 * whose module-load side effect normally performs this registration. Without
 * this fallback, computeStateFromRecords would throw for anyone who only
 * loaded state.js. Remove once p4-t3 updates the standalone to import the
 * index module directly.
 */
function ensureDefault(): void {
  if (mappers.has(DEFAULT_PROVIDER_ID)) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mapHookRecord } = require("../providers/claude-code/mapHookRecord");
  mappers.set(DEFAULT_PROVIDER_ID, mapHookRecord as MapperFn);
}

/** Get the registered mapper for providerId, throwing a descriptive error if none. */
export function getMapper(providerId: string): MapperFn {
  if (providerId === DEFAULT_PROVIDER_ID) ensureDefault();
  const fn = mappers.get(providerId);
  if (!fn) {
    const known = Array.from(mappers.keys()).join(", ") || "(none)";
    throw new Error(
      `mappingRegistry: no mapper registered for provider "${providerId}". Registered: ${known}`,
    );
  }
  return fn;
}

/**
 * Map a raw provider record to NormalizedEvent[]. Reads `record.provider`
 * (a string) when present, else falls back to DEFAULT_PROVIDER_ID, and
 * dispatches to the matching registered mapper.
 */
export function mapRecord(record: unknown): NormalizedEvent[] {
  const providerId = resolveProviderId(record);
  return getMapper(providerId)(record);
}

function resolveProviderId(record: unknown): string {
  return record && typeof record === "object" && typeof (record as { provider?: unknown }).provider === "string"
    ? (record as { provider: string }).provider
    : DEFAULT_PROVIDER_ID;
}

const warnedProviders = new Set<string>();

/**
 * Like mapRecord, but never throws: returns undefined (and warns once per
 * distinct unknown provider id) instead of propagating a getMapper error.
 * Used by computeStateFromRecords so one bad/unknown-provider record never
 * aborts a whole replay.
 */
export function tryMapRecord(record: unknown): NormalizedEvent[] | undefined {
  const providerId = resolveProviderId(record);
  try {
    return getMapper(providerId)(record);
  } catch (err) {
    if (!warnedProviders.has(providerId)) {
      warnedProviders.add(providerId);
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tycoon] skipping record with unknown provider "${providerId}": ${message}`);
    }
    return undefined;
  }
}
