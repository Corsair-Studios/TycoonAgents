/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Host-agnostic "Export team setup" implementation (plan task p48-t3),
// shared by the VS Code extension (panel.ts) and the standalone server
// (standalone/src/teamSetupMessages.mjs, which requires the tsc-compiled
// out/src/host/vscode/teamSetupHost.js). No `vscode` import anywhere in
// this module or its transitive dependencies — same posture as
// routingHostOps.ts / mcpCatalog.ts, both used below.
//
// Reads roster (loadAgentRoster), routing (buildRoutingView), skills
// (.claude/skills/* directory names), mcp (.mcp.json's mcpServers keys),
// and delegation (readExecutionConfig) — then hands everything to the pure
// assembleTeamSetupInput()/buildTeamManifest()/validateTeamManifest() chain
// and writes .claude/tycoon-team.json at the project root (NOT under
// .claude/tycoon/). Never writes env var values, absolute paths, or
// secrets into the manifest or the returned result.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";

import { loadAgentRoster } from "../../providers/claude-code/agentRoster";
import { buildRoutingView } from "../../core/routingHostOps";
import {
  loadRoutingProfile,
  resolveAgentSlot,
  resolveOrchestratorSlot,
  hasHandWrittenBackendBlock,
  type RoutingSlot,
} from "../../core/routingProfile";
import { readExecutionConfig } from "./delegationDoctrine";
import { assembleTeamSetupInput } from "../../core/teamSetupAssemble";
import { buildTeamManifest, validateTeamManifest, serializeTeamManifest, type TeamHarnessId } from "../../core/teamSetup";

const TEAM_HARNESS_IDS: readonly TeamHarnessId[] = ["claude-code", "codex", "opencode"];

/** Narrows an arbitrary already-resolved effective-harness string (e.g.
 *  describeProviderSelection().effective, which is a bare ProviderId string)
 *  to a TeamHarnessId, or undefined when it isn't one of the three known
 *  ids — never throws, so an export is never blocked by an unrecognized
 *  harness value. */
function asTeamHarnessId(harness: string | undefined): TeamHarnessId | undefined {
  return harness !== undefined && (TEAM_HARNESS_IDS as readonly string[]).includes(harness) ? (harness as TeamHarnessId) : undefined;
}
import {
  applyTeamSetup as applyTeamSetupCore,
  type ApplyTeamSetupReport,
  type StepResult,
  type TeamSetupInstallers,
} from "../../core/teamSetupApply";
import { buildAgentMarkdown, agentMarkdownTier, REGULAR_AGENTS, LEAD_AGENTS, REVIEWER_AGENTS, FOREIGN_LLM_AGENTS, type PackAgent } from "./packCatalog";
import { parseTeamManifest } from "../../core/teamSetup";
import {
  buildTeamReadiness,
  createDefaultProbes,
  formatReadinessReport,
  type TeamReadinessReport,
} from "../../core/teamReadiness";
import {
  mergeTycoonHooks,
  mergeManagedSubagentDepthEnv,
  syncRuntimeFile,
  cleanupForeignHookArtifacts,
  RUNTIME_HOOK_FILES,
} from "./hookInstall";

export interface ExportTeamSetupOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Effective harness the caller already resolved (e.g. via
   *  describeProviderSelection({cwd:root}).effective) — recorded on the
   *  manifest as-is when it is a recognized TeamHarnessId. Omitted when the
   *  caller doesn't have one, in which case the manifest carries no
   *  `harness` field. */
  harness?: string;
}

export interface ExportTeamSetupResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Formats a RoutingSlot as the 'vendor/model' string used by "(fb)" chain rendering. */
function fallbackSlotLabel(slot: RoutingSlot): string {
  const vendor = slot.vendor ?? "";
  const model = slot.model ?? "";
  if (vendor && model) return `${vendor}/${model}`;
  return model || vendor || "";
}

/**
 * Ordered 'vendor/model' fallback chain for one resolved RoutingSlot, straight
 * from routing.json's own `fallback` array (RoutingSlot.fallback) — no
 * resolveAgentSlot merging beyond what already applies to `slot` itself.
 * Empty only when the slot truly carries no fallback entries.
 */
function fallbackChainOf(slot: RoutingSlot | null): string[] {
  if (!slot || !slot.fallback) return [];
  return slot.fallback.map(fallbackSlotLabel).filter((s) => s.length > 0);
}

/** Env var NAMES (never values) a single RoutingSlot itself requires — its own endpointEnv/credentialEnv, names only. */
function slotEnvNames(slot: RoutingSlot | null | undefined): string[] {
  if (!slot) return [];
  const names: string[] = [];
  if (slot.endpointEnv) names.push(slot.endpointEnv);
  if (slot.credentialEnv) names.push(slot.credentialEnv);
  return names;
}

/**
 * Env var names per fallback chain entry, keyed by the SAME "vendor/model"
 * label fallbackChainOf() produces for that entry (fallbackSlotLabel), so
 * teamReadiness.ts can look a fallback's env names up by the label already
 * in fallbackChain. Entries with no endpointEnv/credentialEnv are omitted.
 */
function fallbackEnvNamesOf(slot: RoutingSlot | null): Record<string, string[]> | undefined {
  if (!slot || !slot.fallback) return undefined;
  const out: Record<string, string[]> = {};
  for (const fb of slot.fallback) {
    const label = fallbackSlotLabel(fb);
    if (!label) continue;
    const names = slotEnvNames(fb);
    if (names.length > 0) out[label] = names;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * parallelLimit has no persisted execution-config field anywhere in src/ —
 * confirmed by grep (only CLAUDE.md's/AGENTS.md's hand-authored "Parallel
 * agent limit: N" prose under "## Execution Settings" states it; nothing
 * generates or reads that line back). Last resort: parse it out of the
 * project's own CLAUDE.md. `fromClaudeMd` on the result says whether this
 * path was used.
 */
function readParallelLimitFromClaudeMd(root: string): { value: number; fromClaudeMd: boolean } {
  const fallback = { value: 2, fromClaudeMd: false };
  try {
    const text = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    const match = text.match(/Parallel agent limit\*{0,2}:\s*(\d+)/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) return { value: n, fromClaudeMd: true };
    }
  } catch {
    /* no CLAUDE.md, or unreadable — keep default */
  }
  return fallback;
}

function listSkillIds(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, ".claude", "skills"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listMcpIds(root: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    const servers = (parsed && typeof parsed === "object" ? (parsed.mcpServers ?? parsed) : {}) as Record<
      string,
      unknown
    >;
    return Object.keys(servers);
  } catch {
    return [];
  }
}

function planPointerIfExists(root: string): string | undefined {
  const planPath = path.join(root, ".claude", "tycoon", "plan.json");
  try {
    return fs.existsSync(planPath) ? ".claude/tycoon/plan.json" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assemble and write .claude/tycoon-team.json. Never throws — every failure
 * (including validateTeamManifest rejecting the assembled manifest) is
 * reported via the returned `{ ok: false, error }` shape, with `error`
 * naming the validator's offending field but never echoing a value.
 */
export function exportTeamSetup(opts: ExportTeamSetupOptions): ExportTeamSetupResult {
  const { root, env } = opts;
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    const roster = loadAgentRoster(agentsDir).map((a) => ({ id: a.id, name: a.name }));

    const routingView = buildRoutingView({ root, env, agentsDir });

    // Fallback chains: read straight from the parsed routing.json (the same
    // loadRoutingProfile/resolveAgentSlot/resolveOrchestratorSlot loader
    // panel.ts's routing view uses under the hood) rather than extending
    // routingHostOps — buildRoutingView's RoutingAgentView doesn't carry the
    // slot's `fallback` array, only the flattened Backend.
    const { profile } = loadRoutingProfile(root);
    const routingAgents = routingView.agents.map((a) => {
      let handWrittenBackend = false;
      try {
        handWrittenBackend = hasHandWrittenBackendBlock(fs.readFileSync(path.join(agentsDir, `${a.id}.md`), "utf8"));
      } catch {
        /* missing/unreadable agent file => not hand-written */
      }
      const slot = resolveAgentSlot(profile, a.id, { hasHandWrittenBackend: handWrittenBackend });
      return {
        id: a.id,
        backend: a.backend,
        fallbackChain: fallbackChainOf(slot),
        envNames: slotEnvNames(slot),
        fallbackEnvNames: fallbackEnvNamesOf(slot),
      };
    });
    const orchestratorSlot = resolveOrchestratorSlot(profile);
    const orchestrator = routingView.orchestrator.id
      ? {
          id: routingView.orchestrator.id,
          backend: routingView.orchestrator.backend,
          fallbackChain: fallbackChainOf(orchestratorSlot),
          envNames: slotEnvNames(orchestratorSlot),
          fallbackEnvNames: fallbackEnvNamesOf(orchestratorSlot),
        }
      : undefined;

    const execCfg = readExecutionConfig(path.join(root, ".claude"));
    const parallelLimit = readParallelLimitFromClaudeMd(root);

    const input = assembleTeamSetupInput({
      roster,
      routingAgents,
      orchestrator,
      envProbe: routingView.envProbe,
      skills: listSkillIds(root),
      mcp: listMcpIds(root),
      delegation: {
        mode: execCfg.delegation_mode,
        parallelLimit: parallelLimit.value,
      },
      planPointer: planPointerIfExists(root),
      harness: asTeamHarnessId(opts.harness),
    });

    const manifest = buildTeamManifest(input, { now: new Date().toISOString(), version: opts.version });
    const validation = validateTeamManifest(manifest);
    if (!validation.ok) {
      return { ok: false, error: `${validation.field}: ${validation.reason}` };
    }

    const relPath = path.join(".claude", "tycoon-team.json");
    const absPath = path.join(root, relPath);
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    // Write-temp-then-rename: a crash/interrupt mid-write leaves the temp
    // file orphaned, never a truncated tycoon-team.json.
    const tmpPath = path.join(dir, `.tycoon-team.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, serializeTeamManifest(manifest), "utf8");
    fs.renameSync(tmpPath, absPath);
    return { ok: true, path: relPath.split(path.sep).join("/") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// "Apply team setup" (p49-t1, PRD Milestone 2). Host-agnostic — binds real
// installers (agent seeding from packCatalog.ts, the portable hook install
// from hookInstall.ts) over the pure src/core/teamSetupApply.ts orchestrator.
// No `vscode` import: `hookSourceDir` (the directory holding the bundled
// tycoon-claude-hook.cjs + companion runtime files) is passed in by the
// caller, since only the caller knows whether that's the VS Code extension's
// bundled `hooks/` dir or the standalone repo's `hooks/` dir.
// ---------------------------------------------------------------------------

export interface ApplyTeamSetupHostOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Absolute path to the directory containing tycoon-claude-hook.cjs and
   *  its companion runtime files (agentBackend.js, modelAliases.js, etc). */
  hookSourceDir: string;
  delegationMode?: "flat" | "team_leads";
  /** Bound by the caller when this host has an opencode config installer;
   *  omitted (reported "skipped") otherwise. */
  regenerateOpencodeConfig?: (() => StepResult) | null;
  /** Bound by the caller when this host can apply MCP catalog choices
   *  (VS Code only today); omitted (reported "skipped") otherwise. */
  applyMcp?: ((ids: string[]) => StepResult) | null;
}

function agentCatalogLookup(): Map<string, PackAgent> {
  const map = new Map<string, PackAgent>();
  for (const a of [...REGULAR_AGENTS, ...LEAD_AGENTS, ...REVIEWER_AGENTS, ...FOREIGN_LLM_AGENTS]) {
    map.set(a.id, a);
  }
  return map;
}

/**
 * Seeds (or refreshes) one roster entry's agent `.md` file, mirroring
 * panel.ts's `_installAgentFiles` per-file logic: an unknown id is reported
 * `{ ok: false }` (never fabricated), a foreign same-named file with a
 * different tier is left untouched, and an existing file of the right tier
 * is only rewritten when its generated content actually differs.
 */
function seedAgentFile(root: string, catalog: Map<string, PackAgent>, entry: { id: string }): StepResult {
  const agent = catalog.get(entry.id);
  if (!agent) {
    return { ok: false, detail: "not in this host's agent catalog" };
  }
  try {
    const agentsDir = path.join(root, ".claude", "agents");
    const agentPath = path.join(agentsDir, `${agent.id}.md`);
    fs.mkdirSync(agentsDir, { recursive: true });
    if (!fs.existsSync(agentPath)) {
      fs.writeFileSync(agentPath, buildAgentMarkdown(agent));
      return { ok: true, detail: "created" };
    }
    const existing = fs.readFileSync(agentPath, "utf8");
    let existingTier: string | undefined;
    try {
      existingTier = agentMarkdownTier(existing);
    } catch {
      existingTier = undefined;
    }
    if (existingTier !== agent.tier) {
      return { ok: true, detail: "foreign file with this id left untouched" };
    }
    const desired = buildAgentMarkdown(agent);
    if (existing !== desired) {
      fs.writeFileSync(agentPath, desired);
      return { ok: true, detail: "refreshed" };
    }
    return { ok: true, detail: "unchanged" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Portable hook install: syncs the runtime hook files and merges the
 * TycoonAgents hook slots + managed subagent-depth env into
 * `.claude/settings.local.json`, exactly as panel.ts's `_handleInstallHooks`
 * does (steps 1-6), minus the VS Code-only agent/skill/CLAUDE.md wiring
 * that isn't part of "install hooks". The hook command itself
 * (`node .claude/tycoon/tycoon-claude-hook.cjs`) is already project-relative
 * (see panel.ts's `_buildHookCommand`), so no vscode.Uri is needed here.
 */
function installPortableHooks(root: string, hookSourceDir: string, delegationMode: "flat" | "team_leads"): StepResult {
  try {
    const claudeDir = path.join(root, ".claude");
    const tycoonDir = path.join(claudeDir, "tycoon");
    fs.mkdirSync(tycoonDir, { recursive: true });
    cleanupForeignHookArtifacts(claudeDir);

    for (const fileName of RUNTIME_HOOK_FILES) {
      const src = path.join(hookSourceDir, fileName);
      if (fs.existsSync(src)) {
        syncRuntimeFile(src, path.join(tycoonDir, fileName));
      }
    }

    const hookCommand = "node .claude/tycoon/tycoon-claude-hook.cjs";
    const settingsPath = path.join(claudeDir, "settings.local.json");
    let existing: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw !== "") {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      }
    } catch {
      /* missing/invalid => default {} */
    }
    const mergedHooks = mergeTycoonHooks(existing, hookCommand);
    const merged = mergeManagedSubagentDepthEnv(mergedHooks, delegationMode === "team_leads" ? "2" : "1");
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Binds real installers over `applyTeamSetup` (src/core/teamSetupApply.ts)
 * and runs it. Shared by panel.ts's `_handleApplyTeamSetup` and the
 * standalone's `handleApplyTeamSetupStandalone` — both pass their own
 * `hookSourceDir` and, where they have one, their own
 * `regenerateOpencodeConfig`/`applyMcp` installer.
 */
export function applyTeamSetupHost(opts: ApplyTeamSetupHostOptions): ApplyTeamSetupReport {
  const catalog = agentCatalogLookup();
  const delegationMode = opts.delegationMode ?? "flat";
  const installers: TeamSetupInstallers = {
    seedAgent: (entry) => seedAgentFile(opts.root, catalog, entry),
    installHooks: () => installPortableHooks(opts.root, opts.hookSourceDir, delegationMode),
    regenerateOpencodeConfig: opts.regenerateOpencodeConfig ?? null,
    applyMcp: opts.applyMcp ?? null,
  };
  return applyTeamSetupCore({ root: opts.root, env: opts.env, version: opts.version, installers });
}

// ---------------------------------------------------------------------------
// Readiness + drift (plan task p50-t2). Both are read-only: neither writes
// .claude/tycoon-team.json, routing.json, nor the applied stamp.
// ---------------------------------------------------------------------------

export interface BuildTeamReadinessHostOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  probeReachability?: boolean;
  /** "vscode" (default) or "standalone" — forwarded to createDefaultProbes' hostKind option. */
  hostKind?: "vscode" | "standalone";
  /** Standalone-only: execFileSync-shaped seam (argv arrays only), forwarded to createDefaultProbes. */
  execSeam?: (command: string) => string;
}

export interface BuildTeamReadinessHostResult {
  ok: boolean;
  report?: TeamReadinessReport;
  text?: string;
  error?: string;
}

/** Strips anything that looks like an absolute filesystem path (drive-letter or /Users//home/ style) from a detail string, replacing it with "<path>". */
function sanitizeDetailPaths(detail: string): string {
  return detail
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s"']+/g, "<path>");
}

function sanitizeReadinessReport(report: TeamReadinessReport): TeamReadinessReport {
  return {
    ...report,
    agents: report.agents.map((a) => ({
      ...a,
      detail: sanitizeDetailPaths(a.detail),
      ...(a.reachability ? { reachability: { ...a.reachability, detail: sanitizeDetailPaths(a.reachability.detail) } } : {}),
    })),
    harness: {
      ...report.harness,
      installed: Object.fromEntries(
        Object.entries(report.harness.installed).map(([id, status]) => [id, { ...status, detail: sanitizeDetailPaths(status.detail) }]),
      ) as TeamReadinessReport["harness"]["installed"],
    },
  };
}

/**
 * Reads .claude/tycoon-team.json, builds a TeamReadinessReport via
 * createDefaultProbes(), and returns both the structured report and its
 * plain-text rendering (formatReadinessReport). Detail strings are
 * sanitized for absolute paths before returning — see sanitizeDetailPaths.
 */
export async function buildTeamReadinessHost(opts: BuildTeamReadinessHostOptions): Promise<BuildTeamReadinessHostResult> {
  let manifestText: string;
  try {
    manifestText = fs.readFileSync(path.join(opts.root, ".claude", "tycoon-team.json"), "utf8");
  } catch {
    return { ok: false, error: "No team manifest found. Export team setup first." };
  }
  const parsed = parseTeamManifest(manifestText);
  if (!parsed.ok) {
    return { ok: false, error: `${parsed.field}: ${parsed.reason}` };
  }
  const probes = createDefaultProbes({
    root: opts.root,
    env: opts.env,
    hostKind: opts.hostKind ?? "vscode",
    ...(opts.execSeam ? { execSeam: opts.execSeam } : {}),
  });
  const report = await buildTeamReadiness(parsed.manifest, probes, { probeReachability: !!opts.probeReachability });
  const sanitized = sanitizeReadinessReport(report);
  return { ok: true, report: sanitized, text: formatReadinessReport(sanitized) };
}

export interface TeamSetupDriftResult {
  hasManifest: boolean;
  drift: boolean;
  manifestExportedAt?: string;
  appliedExportedAt?: string;
}

/**
 * Compares .claude/tycoon-team.json's `exportedAt` against
 * .claude/tycoon/team-setup-applied.json's `exportedAt` — embedded date
 * fields only, never file mtimes. `drift` is true when a manifest exists
 * and either no stamp exists or the stamped exportedAt differs.
 */
export function getTeamSetupDriftHost(root: string): TeamSetupDriftResult {
  let manifestText: string;
  try {
    manifestText = fs.readFileSync(path.join(root, ".claude", "tycoon-team.json"), "utf8");
  } catch {
    return { hasManifest: false, drift: false };
  }
  const parsed = parseTeamManifest(manifestText);
  if (!parsed.ok) {
    return { hasManifest: false, drift: false };
  }
  const manifestExportedAt = parsed.manifest.exportedAt;

  let appliedExportedAt: string | undefined;
  try {
    const raw = fs.readFileSync(path.join(root, ".claude", "tycoon", "team-setup-applied.json"), "utf8").trim();
    if (raw !== "") {
      const stampParsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof stampParsed.exportedAt === "string") appliedExportedAt = stampParsed.exportedAt;
    }
  } catch {
    /* missing/invalid stamp => no appliedExportedAt */
  }

  const drift = appliedExportedAt === undefined || appliedExportedAt !== manifestExportedAt;
  return { hasManifest: true, drift, manifestExportedAt, ...(appliedExportedAt !== undefined ? { appliedExportedAt } : {}) };
}
