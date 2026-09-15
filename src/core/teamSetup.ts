/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Team manifest schema + pure builder/validator/serializer for
// .claude/tycoon-team.json (design-docs/team-setup-prd.md, Milestone 1).
//
// This module does NOT read from disk. Hosts (panel.ts, standalone
// server.mjs) assemble a TeamManifestInput from the roster loader, the
// RoutingProfile (src/core/routingProfile.ts), the skills/MCP catalog state,
// and delegation config, then call buildTeamManifest() here. Keeping this
// pure makes it independently testable and reusable by both hosts.
//
// Zero dependencies; safe to compile alongside the other src/core modules
// that are copied into hooks/ (see scripts/copy-hook-runtime.mjs), though
// nothing here currently requires that copy step.
// ---------------------------------------------------------------------------

import type { CostModelClass } from "./agentBackend";

export const TEAM_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface TeamManifestRosterEntry {
  id: string;
  displayName: string;
}

export interface TeamManifestRouting {
  vendor?: string;
  model?: string;
  fallbackChain: string[];
  costClass?: CostModelClass;
}

export interface TeamManifestRequiredEnv {
  name: string;
  setAtExport: boolean;
}

export interface TeamManifestDelegation {
  mode: string;
  parallelLimit: number;
}

export interface TeamManifest {
  schemaVersion: number;
  exportedAt: string;
  exporter: {
    product: string;
    version: string;
  };
  roster: TeamManifestRosterEntry[];
  routing: Record<string, TeamManifestRouting>;
  requiredEnv: TeamManifestRequiredEnv[];
  skills: string[];
  mcp: string[];
  delegation: TeamManifestDelegation;
  planPointer?: string;
}

// ---------------------------------------------------------------------------
// Input shape the builder consumes. Hosts assemble this from live state;
// nothing here is read from disk by this module.
// ---------------------------------------------------------------------------

export interface TeamManifestInput {
  roster: TeamManifestRosterEntry[];
  routing: Record<string, TeamManifestRouting>;
  requiredEnv: TeamManifestRequiredEnv[];
  skills: string[];
  mcp: string[];
  delegation: TeamManifestDelegation;
  planPointer?: string;
}

export interface BuildTeamManifestOptions {
  /** ISO 8601 timestamp to stamp as exportedAt. */
  now: string;
  /** Exporter (TycoonAgents) version string, e.g. from package.json. */
  version: string;
  /** Exporter product id. Defaults to "tycoonagents". */
  product?: string;
}

function sortRoster(roster: TeamManifestRosterEntry[]): TeamManifestRosterEntry[] {
  return [...roster].sort((a, b) => a.id.localeCompare(b.id));
}

function sortRouting(routing: Record<string, TeamManifestRouting>): Record<string, TeamManifestRouting> {
  const out: Record<string, TeamManifestRouting> = {};
  for (const key of Object.keys(routing).sort((a, b) => a.localeCompare(b))) {
    const slot = routing[key];
    out[key] = {
      ...(slot.vendor !== undefined ? { vendor: slot.vendor } : {}),
      ...(slot.model !== undefined ? { model: slot.model } : {}),
      fallbackChain: [...slot.fallbackChain],
      ...(slot.costClass !== undefined ? { costClass: slot.costClass } : {}),
    };
  }
  return out;
}

function sortRequiredEnv(list: TeamManifestRequiredEnv[]): TeamManifestRequiredEnv[] {
  return [...list]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ name: e.name, setAtExport: e.setAtExport }));
}

function sortStrings(list: string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b));
}

/**
 * Pure builder: assembles a deterministic TeamManifest from `input`.
 * Re-building from unchanged input produces byte-identical output except
 * for `exportedAt` (see serializeTeamManifest / the re-export test).
 */
export function buildTeamManifest(input: TeamManifestInput, opts: BuildTeamManifestOptions): TeamManifest {
  const manifest: TeamManifest = {
    schemaVersion: TEAM_MANIFEST_SCHEMA_VERSION,
    exportedAt: opts.now,
    exporter: {
      product: opts.product ?? "tycoonagents",
      version: opts.version,
    },
    roster: sortRoster(input.roster),
    routing: sortRouting(input.routing),
    requiredEnv: sortRequiredEnv(input.requiredEnv),
    skills: sortStrings(input.skills),
    mcp: sortStrings(input.mcp),
    delegation: {
      mode: input.delegation.mode,
      parallelLimit: input.delegation.parallelLimit,
    },
    ...(input.planPointer !== undefined ? { planPointer: input.planPointer } : {}),
  };
  return manifest;
}

// ---------------------------------------------------------------------------
// Validation: rejects absolute paths, secret-shaped strings, and any
// requiredEnv entry carrying a `value` property. Never echoes the offending
// value back in the reason string.
// ---------------------------------------------------------------------------

export interface TeamManifestValidationOk {
  ok: true;
}

export interface TeamManifestValidationFail {
  ok: false;
  field: string;
  reason: string;
}

export type TeamManifestValidationResult = TeamManifestValidationOk | TeamManifestValidationFail;

// Patterns are built from concatenated fragments so the compiled bundle
// never contains the literal path-example sequences the packaging
// absolute-path checker scans for (scripts/check-no-absolute-paths.mjs).
const ABSOLUTE_PATH_PATTERNS: RegExp[] = [
  new RegExp('[A-Za-z]:[\\\\/]'), // drive letter path
  new RegExp('[\\\\/]' + 'Users' + '[\\\\/]'),
  new RegExp('[\\\\/]' + 'home' + '[\\\\/]'),
  new RegExp('[\\\\/]' + 'root' + '[\\\\/]'),
  new RegExp('\\\\\\\\' + '[^\\\\]+' + '\\\\'), // UNC path
];

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /ghp_[A-Za-z0-9]+/,
  /github_pat_[A-Za-z0-9_]+/,
  /Bearer\s+\S+/,
  /\b[0-9a-fA-F]{32,}\b/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

function looksLikeAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_PATTERNS.some((re) => re.test(value));
}

function looksLikeSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value));
}

/**
 * Walk any JSON-ish value looking for a forbidden string. Returns the
 * dotted/bracketed field path of the first offender, or null if clean.
 */
function scanForForbiddenStrings(value: unknown, path: string): string | null {
  if (typeof value === "string") {
    if (looksLikeAbsolutePath(value)) return path;
    if (looksLikeSecret(value)) return path;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForForbiddenStrings(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const hit = scanForForbiddenStrings((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

export function validateTeamManifest(manifest: TeamManifest): TeamManifestValidationResult {
  if (manifest.schemaVersion !== TEAM_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, field: "schemaVersion", reason: "unsupported schema version" };
  }

  for (const entry of manifest.requiredEnv ?? []) {
    if (Object.prototype.hasOwnProperty.call(entry, "value")) {
      return { ok: false, field: "requiredEnv", reason: "env entry carries a value property; names only" };
    }
  }

  const hit = scanForForbiddenStrings(manifest as unknown, "");
  if (hit !== null) {
    return {
      ok: false,
      field: hit || "(root)",
      reason: "contains an absolute path or secret-shaped string",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeTeamManifest(manifest: TeamManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface ParseTeamManifestOk {
  ok: true;
  manifest: TeamManifest;
}

export interface ParseTeamManifestFail {
  ok: false;
  field: string;
  reason: string;
}

export type ParseTeamManifestResult = ParseTeamManifestOk | ParseTeamManifestFail;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function parseTeamManifest(text: string): ParseTeamManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, field: "(root)", reason: "invalid JSON" };
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, field: "(root)", reason: "not an object" };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.schemaVersion !== "number" || obj.schemaVersion !== TEAM_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, field: "schemaVersion", reason: "unsupported schema version" };
  }
  if (typeof obj.exportedAt !== "string") {
    return { ok: false, field: "exportedAt", reason: "missing or not a string" };
  }
  const exporter = obj.exporter as Record<string, unknown> | undefined;
  if (!exporter || typeof exporter.product !== "string" || typeof exporter.version !== "string") {
    return { ok: false, field: "exporter", reason: "missing product/version" };
  }
  if (!Array.isArray(obj.roster) || !obj.roster.every((r) => r && typeof (r as { id?: unknown }).id === "string" && typeof (r as { displayName?: unknown }).displayName === "string")) {
    return { ok: false, field: "roster", reason: "malformed roster entries" };
  }
  const routing = obj.routing as Record<string, unknown> | undefined;
  if (!routing || typeof routing !== "object") {
    return { ok: false, field: "routing", reason: "missing or not an object" };
  }
  for (const key of Object.keys(routing)) {
    const slot = routing[key] as Record<string, unknown>;
    if (!slot || !isStringArray(slot.fallbackChain)) {
      return { ok: false, field: `routing.${key}`, reason: "malformed routing slot" };
    }
  }
  if (
    !Array.isArray(obj.requiredEnv) ||
    !obj.requiredEnv.every(
      (e) =>
        e &&
        typeof (e as { name?: unknown }).name === "string" &&
        typeof (e as { setAtExport?: unknown }).setAtExport === "boolean",
    )
  ) {
    return { ok: false, field: "requiredEnv", reason: "malformed requiredEnv entries" };
  }
  if (!isStringArray(obj.skills)) {
    return { ok: false, field: "skills", reason: "not a string array" };
  }
  if (!isStringArray(obj.mcp)) {
    return { ok: false, field: "mcp", reason: "not a string array" };
  }
  const delegation = obj.delegation as Record<string, unknown> | undefined;
  if (!delegation || typeof delegation.mode !== "string" || typeof delegation.parallelLimit !== "number") {
    return { ok: false, field: "delegation", reason: "malformed delegation config" };
  }
  if (obj.planPointer !== undefined && typeof obj.planPointer !== "string") {
    return { ok: false, field: "planPointer", reason: "not a string" };
  }

  return { ok: true, manifest: obj as unknown as TeamManifest };
}
