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
import { buildTeamManifest, validateTeamManifest, serializeTeamManifest } from "../../core/teamSetup";

export interface ExportTeamSetupOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  version: string;
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
      return { id: a.id, backend: a.backend, fallbackChain: fallbackChainOf(slot) };
    });
    const orchestrator = routingView.orchestrator.id
      ? {
          id: routingView.orchestrator.id,
          backend: routingView.orchestrator.backend,
          fallbackChain: fallbackChainOf(resolveOrchestratorSlot(profile)),
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
