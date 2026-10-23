/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Host-agnostic "Apply team setup" implementation (plan task p49-t1, PRD
// Milestone 2 — docs/design/team-setup-prd.md). Reads the committed
// .claude/tycoon-team.json (src/core/teamSetup.ts's parseTeamManifest),
// validates it, and re-runs the project's existing installers against it.
// This module never calls into `vscode` and never talks to a real
// installer directly — every side-effecting step (seeding an agent file,
// installing hooks, regenerating opencode config, applying the MCP
// catalog) is INJECTED so panel.ts and standalone/src/server.mjs can bind
// their own real installers while tests drive this with fakes. Only the
// manifest read, the .claude/tycoon/routing.json merge, and the applied
// stamp are done directly here via fs — all three are plain, host-agnostic
// JSON I/O with no vscode/UI dependency, same posture as teamSetupHost.ts.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";

import {
  computeRosterHash,
  parseTeamManifest,
  TEAM_MANIFEST_SCHEMA_VERSION,
  type TeamManifest,
  type TeamManifestRosterEntry,
  type TeamManifestRouting,
} from "./teamSetup";

const ROSTER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SeedAgentResult {
  ok: boolean;
  detail?: string;
}

export interface StepResult {
  ok: boolean;
  detail?: string;
}

/**
 * Real side-effecting installers a host binds in. Each is optional except
 * `seedAgent` and `installHooks`, which every host must provide; a host
 * that has no equivalent for an optional step (e.g. standalone has no
 * VS Code MCP UI wiring) passes `null` or omits it, and that step is
 * reported as "skipped" rather than attempted.
 */
export interface TeamSetupInstallers {
  /** Seed (or refresh) the agent file for one roster entry. Return
   *  `{ ok: false }` when the id is unknown to this host's installer —
   *  such ids are collected into the report's `missingAgents`, never
   *  fabricated. */
  seedAgent: (entry: TeamManifestRosterEntry) => SeedAgentResult;
  /** Install/refresh the portable hook wiring (settings.local.json). */
  installHooks: () => StepResult;
  /** Regenerate the OpenCode config from current routing state, if this
   *  host has that installer. */
  regenerateOpencodeConfig?: (() => StepResult) | null;
  /** Apply the manifest's MCP catalog selections, if this host has that
   *  installer. */
  applyMcp?: ((ids: string[]) => StepResult) | null;
}

export interface ApplyTeamSetupOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  version: string;
  installers: TeamSetupInstallers;
  /** ISO timestamp to stamp as appliedAt. Defaults to `new Date().toISOString()`. */
  now?: string;
}

export interface ApplyTeamSetupStep {
  name: string;
  status: "done" | "skipped" | "failed";
  detail?: string;
}

export interface ApplyTeamSetupReport {
  ok: boolean;
  changed: boolean;
  steps: ApplyTeamSetupStep[];
  missingAgents: string[];
  error?: string;
}

interface AppliedStamp {
  exportedAt: string;
  appliedAt: string;
  schemaVersion: number;
  /** sha256 hex of the roster as applied (computeRosterHash, src/core/teamSetup.ts). */
  rosterHash: string;
  /** Whether this apply seeded routing.json from the manifest (true only on
   *  the first apply on a clone, before routing.json exists locally). */
  routingSeeded: boolean;
}

function manifestPath(root: string): string {
  return path.join(root, ".claude", "tycoon-team.json");
}

function appliedStampPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "team-setup-applied.json");
}

function routingProfilePath(root: string): string {
  return path.join(root, ".claude", "tycoon", "routing.json");
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (raw === "") return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readAppliedStamp(root: string): AppliedStamp | null {
  const parsed = readJsonSafe(appliedStampPath(root));
  if (!parsed || typeof parsed.exportedAt !== "string" || typeof parsed.appliedAt !== "string") {
    return null;
  }
  return {
    exportedAt: parsed.exportedAt,
    appliedAt: parsed.appliedAt,
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : TEAM_MANIFEST_SCHEMA_VERSION,
    rosterHash: typeof parsed.rosterHash === "string" ? parsed.rosterHash : "",
    routingSeeded: typeof parsed.routingSeeded === "boolean" ? parsed.routingSeeded : false,
  };
}

/**
 * Writes `content` to `destPath` via a temp file in the SAME directory
 * followed by `renameSync`, so a crash/interrupt mid-write never leaves a
 * truncated routing.json / applied-stamp — same pattern teamSetupHost.ts's
 * `exportTeamSetup` uses for tycoon-team.json.
 */
function writeFileAtomic(destPath: string, content: string): void {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, destPath);
}

function writeAppliedStamp(root: string, stamp: AppliedStamp): void {
  writeFileAtomic(appliedStampPath(root), `${JSON.stringify(stamp, null, 2)}\n`);
}

/**
 * Sanitizes a caught error for a report field: an fs error's `.message`
 * embeds absolute paths, which must never reach the report (see
 * ApplyTeamSetupReport's no-absolute-path contract). Keeps only the error
 * code (e.g. "EACCES") when present, else a fixed phrase, plus the
 * project-relative path that was being written — never `e.message`.
 */
function sanitizeFsError(e: unknown, root: string, absPath: string): string {
  const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : "unknown error";
  const rel = path.relative(root, absPath).split(path.sep).join("/");
  return `${code}: ${rel}`;
}

/**
 * Same sanitization as {@link sanitizeFsError} but for a caught error from an
 * opaque injected installer call (hooks/opencodeConfig/mcp), where no single
 * file path is known here — code or fixed phrase only, never `e.message`.
 */
function sanitizeInstallerError(e: unknown): string {
  const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : "installer threw";
  return code;
}

/** Splits a "vendor/model" fallback-chain label back into a routing.json fallback slot. */
function fallbackLabelToSlot(label: string): Record<string, unknown> {
  const idx = label.indexOf("/");
  if (idx === -1) return { model: label };
  return { vendor: label.slice(0, idx), model: label.slice(idx + 1) };
}

/**
 * Merges only the team-managed fields (vendor/model/fallbackChain/costClass)
 * of `manifestRouting` into `existingSlot`, preserving every other local-only
 * field (mcpServer, tools, endpointEnv, credentialEnv, useDefaultFallback,
 * and any field this module doesn't know about) untouched. Returns the new
 * slot plus whether anything actually changed, so the caller can skip the
 * write on a true no-op.
 */
function mergeManagedRoutingFields(
  existingSlot: Record<string, unknown> | undefined,
  managed: TeamManifestRouting
): { slot: Record<string, unknown>; changed: boolean } {
  const base = existingSlot ? { ...existingSlot } : {};
  const desiredFallback = managed.fallbackChain.map(fallbackLabelToSlot);

  const next: Record<string, unknown> = { ...base };
  let changed = false;

  if (managed.vendor !== undefined) {
    if (base.vendor !== managed.vendor) changed = true;
    next.vendor = managed.vendor;
  } else if (Object.prototype.hasOwnProperty.call(base, "vendor")) {
    // Manifest carries no vendor for this slot — leave any local value alone.
  }

  if (managed.model !== undefined) {
    if (base.model !== managed.model) changed = true;
    next.model = managed.model;
  }

  if (managed.costClass !== undefined) {
    if (base.costModelClass !== managed.costClass) changed = true;
    next.costModelClass = managed.costClass;
  }

  if (JSON.stringify(base.fallback ?? []) !== JSON.stringify(desiredFallback)) {
    changed = true;
  }
  next.fallback = desiredFallback;

  return { slot: next, changed };
}

/**
 * Pure orchestration: reads and validates the manifest, then drives the
 * injected installers. Never throws — every failure path returns
 * `{ ok: false, error }`. The returned report never contains an absolute
 * path or env var value (routing.json fields carry only vendor/model/
 * fallback/cost-class names, never secrets — see routingProfile.ts's
 * `credentialEnv`, which this module never reads or writes).
 */
export function applyTeamSetup(opts: ApplyTeamSetupOptions): ApplyTeamSetupReport {
  const { root, installers } = opts;
  const steps: ApplyTeamSetupStep[] = [];
  const missingAgents: string[] = [];

  let manifestText: string;
  try {
    manifestText = fs.readFileSync(manifestPath(root), "utf8");
  } catch (e) {
    return {
      ok: false,
      changed: false,
      steps: [],
      missingAgents: [],
      error: `no team manifest found: ${sanitizeFsError(e, root, manifestPath(root))}`,
    };
  }

  const parsed = parseTeamManifest(manifestText);
  if (!parsed.ok) {
    return {
      ok: false,
      changed: false,
      steps: [],
      missingAgents: [],
      error: `${parsed.field}: ${parsed.reason}`,
    };
  }
  const manifest: TeamManifest = parsed.manifest;

  // (2) Validate roster ids before building any path from them.
  for (const entry of manifest.roster) {
    if (!ROSTER_ID_PATTERN.test(entry.id)) {
      return {
        ok: false,
        changed: false,
        steps: [],
        missingAgents: [],
        error: `roster entry id "${entry.id}" does not match the allowed agent-id pattern`,
      };
    }
  }

  // Idempotency pre-check: has this exact exportedAt already been applied?
  // If so, skip every write — routing.json is never re-touched by a repeat
  // apply (see the roster-authoritative/routing-is-a-reference decision
  // below), so exportedAt alone is sufficient.
  const priorStamp = readAppliedStamp(root);
  const alreadyApplied = priorStamp !== null && priorStamp.exportedAt === manifest.exportedAt;
  if (alreadyApplied) {
    return { ok: true, changed: false, steps: [{ name: "apply", status: "skipped", detail: "already applied; no changes" }], missingAgents: [] };
  }

  // (3) Seed missing agent files for known roster ids.
  for (const entry of manifest.roster) {
    const result = installers.seedAgent(entry);
    if (result.ok) {
      steps.push({ name: `seedAgent:${entry.id}`, status: "done", detail: result.detail });
    } else {
      missingAgents.push(entry.id);
      steps.push({ name: `seedAgent:${entry.id}`, status: "failed", detail: result.detail ?? "unknown agent id" });
    }
  }

  // (4) Seed routing.json from the manifest ONLY on a fresh clone where it
  // does not exist yet. The roster is authoritative; routing.json is a
  // local reference the user is free to edit afterward — once it exists,
  // apply never touches it again, even when the manifest's vendor/model
  // changed (decision, 2026-09-15).
  const routingPath = routingProfilePath(root);
  const routingFileExists = fs.existsSync(routingPath);
  // "Kept" only when the file exists AND parses as a JSON object; an empty
  // or unparsable file is treated the same as absent (review nit).
  const existingRoutingParsed = routingFileExists ? readJsonSafe(routingPath) : null;
  const routingIsReadableObject = existingRoutingParsed !== null;
  let routingSeeded = false;
  if (!routingIsReadableObject) {
    const nextAgents: Record<string, unknown> = {};
    let nextOrchestrator: Record<string, unknown> | undefined;
    for (const [agentId, managed] of Object.entries(manifest.routing)) {
      const merged = mergeManagedRoutingFields(undefined, managed);
      if (agentId === "orchestrator") {
        nextOrchestrator = merged.slot;
      } else {
        nextAgents[agentId] = merged.slot;
      }
    }
    try {
      const nextProfile: Record<string, unknown> = { version: 1, agents: nextAgents };
      if (nextOrchestrator !== undefined) {
        nextProfile.orchestrator = nextOrchestrator;
      }
      writeFileAtomic(routingPath, `${JSON.stringify(nextProfile, null, 2)}\n`);
      steps.push({
        name: "routing",
        status: "done",
        detail: routingFileExists ? "seeded: local routing file was unreadable" : "seeded routing from manifest",
      });
      routingSeeded = true;
    } catch (e) {
      steps.push({ name: "routing", status: "failed", detail: sanitizeFsError(e, root, routingPath) });
    }
  } else {
    steps.push({ name: "routing", status: "skipped", detail: "local routing kept" });
  }

  // (5) Install hooks (portable installer, both hosts must provide this).
  try {
    const result = installers.installHooks();
    steps.push({ name: "hooks", status: result.ok ? "done" : "failed", detail: result.detail });
  } catch (e) {
    steps.push({ name: "hooks", status: "failed", detail: sanitizeInstallerError(e) });
  }

  // (5b) Regenerate opencode config, if this host has that installer.
  if (installers.regenerateOpencodeConfig) {
    try {
      const result = installers.regenerateOpencodeConfig();
      steps.push({ name: "opencodeConfig", status: result.ok ? "done" : "failed", detail: result.detail });
    } catch (e) {
      steps.push({ name: "opencodeConfig", status: "failed", detail: sanitizeInstallerError(e) });
    }
  } else {
    steps.push({ name: "opencodeConfig", status: "skipped", detail: "no opencode config installer bound on this host" });
  }

  // (5c) Apply MCP catalog choices, if this host has that installer.
  if (installers.applyMcp) {
    try {
      const result = installers.applyMcp(manifest.mcp);
      steps.push({ name: "mcp", status: result.ok ? "done" : "failed", detail: result.detail });
    } catch (e) {
      steps.push({ name: "mcp", status: "failed", detail: sanitizeInstallerError(e) });
    }
  } else {
    steps.push({ name: "mcp", status: "skipped", detail: "no MCP catalog installer bound on this host" });
  }

  // (6) Applied-stamp — only when nothing above failed (unknown roster ids
  // included, via the seedAgent "failed" steps pushed above). A failed apply
  // must leave any prior stamp untouched so drift keeps re-prompting.
  const failedBeforeStamp = steps.some((s) => s.status === "failed");
  const appliedAt = opts.now ?? new Date().toISOString();
  if (failedBeforeStamp) {
    steps.push({ name: "stamp", status: "skipped", detail: "apply had failures; stamp left untouched" });
  } else {
    try {
      writeAppliedStamp(root, {
        exportedAt: manifest.exportedAt,
        appliedAt,
        schemaVersion: manifest.schemaVersion,
        rosterHash: computeRosterHash(manifest.roster),
        routingSeeded,
      });
      steps.push({ name: "stamp", status: "done" });
    } catch (e) {
      steps.push({ name: "stamp", status: "failed", detail: sanitizeFsError(e, root, appliedStampPath(root)) });
    }
  }

  const anyFailed = steps.some((s) => s.status === "failed");
  const anyDone = steps.some((s) => s.status === "done");
  return {
    ok: !anyFailed,
    changed: anyDone,
    steps,
    missingAgents,
  };
}
