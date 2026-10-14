/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Shared, host-agnostic helper for the Settings screen's per-agent route
// fields and routing-visibility block (plan task p18-t1). Consumed by both
// src/host/vscode/panel.ts and standalone/src/server.mjs's settings payload
// builders — no `vscode` import anywhere in this module, so it compiles to
// out/src/core/agentSettingsRoute.js and can be require()'d directly from
// the standalone's vscode-free process (same posture as routingHostOps.ts).
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { buildRoutingView, saveRoutingProfile } from "./routingHostOps";
import type { RoutingProvenance } from "./routingHostOps";
import { loadRoutingProfile } from "./routingProfile";
import type { RoutingProfile, RoutingSlot } from "./routingProfile";
import { readUseMultipleLlms } from "./providerSelection";
import { shortFromModelId } from "../host/vscode/agentConfig";
import { readAgentFrontmatter } from "./agentBackend";
import { describeHarnessDefault } from "./harnessModelDefaults";
import type { HarnessDefaultInfo } from "./harnessModelDefaults";

export type ClaudeTier = "fable" | "opus" | "sonnet" | "haiku";

export interface AgentRouteInfo {
  resolvedModel: string | null;
  vendor: string | null;
  costModelClass: string | null;
  claudeTier: ClaudeTier | null;
  routeSource: RoutingProvenance;
  handWrittenBackend: boolean;
  /** `tycoon_relay` bridge server (e.g. "codex") when the agent file is a managed relay, else null. Display only. */
  relayServer: string | null;
  /** Codex harness only: the model this agent runs on when it has no explicit
   *  choice (display only, never written to routing.json). null otherwise. */
  harnessDefault: HarnessDefaultInfo | null;
}

const CLAUDE_TIERS: readonly ClaudeTier[] = ["fable", "opus", "sonnet", "haiku"];

function isClaudeTier(v: string | undefined): v is ClaudeTier {
  return v !== undefined && (CLAUDE_TIERS as readonly string[]).includes(v);
}

/**
 * Derive a ClaudeTier from a resolved model id/alias, or null for anything
 * that isn't a recognized Claude family (including undefined/empty models).
 * Reuses shortFromModelId's case-insensitive substring match, which already
 * handles bare aliases ("sonnet"), "anthropic/<alias>" ("anthropic/sonnet"),
 * and full ids with or without an "anthropic/" prefix (e.g.
 * "claude-sonnet-4-6", "anthropic/claude-fable-5-1",
 * "claude-haiku-4-5-20251001").
 */
export function claudeTierFromModel(model: string | null | undefined): ClaudeTier | null {
  if (model === null || model === undefined || model.trim() === "") return null;
  const short = shortFromModelId(model);
  return isClaudeTier(short) ? short : null;
}

/**
 * True when the agent's OWN file declares a model itself — either a bare
 * top-level `model:` alias or a `backend:` block — as opposed to a file with
 * neither, which routing.json's `defaults` slot is meant to fill in.
 * buildRoutingView's `provenance` alone can't distinguish this case: today's
 * resolveAgentSlot() (src/core/routingProfile.ts, out of this task's owned
 * files) lets `defaults` sweep in ANY agent without a hand-written
 * `backend:` block, bare-alias agents included, and reports "default"
 * provenance for it. For this task's contract an agent that carries its own
 * alias must still read as routeSource "frontmatter" (not swept, not
 * counted in routedAgentCount) — so this helper re-reads the raw frontmatter
 * directly rather than trusting provenance in that one case.
 */
function hasOwnModelDeclaration(root: string, agentId: string): boolean {
  try {
    const content = fs.readFileSync(path.join(root, ".claude", "agents", `${agentId}.md`), "utf8");
    const fm = readAgentFrontmatter(content);
    if (fm["backend"] !== undefined && fm["backend"] !== null) return true;
    return typeof fm["model"] === "string" && fm["model"].trim() !== "";
  } catch {
    return false;
  }
}

function readFrontmatterModel(root: string, agentId: string): string | null {
  try {
    const content = fs.readFileSync(path.join(root, ".claude", "agents", `${agentId}.md`), "utf8");
    const m = readAgentFrontmatter(content)["model"];
    return typeof m === "string" && m.trim() !== "" ? m.trim() : null;
  } catch {
    return null;
  }
}

function readRelayServer(root: string, agentId: string): string | null {
  try {
    const content = fs.readFileSync(path.join(root, ".claude", "agents", `${agentId}.md`), "utf8");
    const v = readAgentFrontmatter(content)["tycoon_relay"];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Per-agent route fields for the Settings screen, keyed by agent id. Built
 * from buildRoutingView(root) so both hosts agree on precedence/provenance
 * with the Routing screen itself.
 */
export function describeAgentRoutes(root: string, opts: { harness?: string } = {}): Record<string, AgentRouteInfo> {
  const harness = opts.harness ?? "";
  const view = buildRoutingView({ root, env: process.env });
  const out: Record<string, AgentRouteInfo> = {};
  for (const agent of view.agents) {
    const resolvedModel = agent.backend.model && agent.backend.model.trim() !== "" ? agent.backend.model : null;
    // "explicit" always wins outright (an agents[id] entry in routing.json).
    // "default" only counts as a real route when the agent has no model of
    // its own to fall back to — otherwise it's the agent's own frontmatter
    // route, coincidentally matching what defaults would have picked.
    const routeSource: RoutingProvenance =
      agent.provenance === "default" && hasOwnModelDeclaration(root, agent.id) ? "frontmatter" : agent.provenance;
    // Codex harness: an agent with no explicit choice runs on a Codex model
    // (src/core/harnessModelDefaults.ts). Surface vendor/billing honestly;
    // the underlying frontmatter/route fields stay as they are on disk.
    const harnessDefault =
      harness.toLowerCase() === "codex" && agent.id !== "orchestrator"
        ? describeHarnessDefault(harness, {
            frontmatterModel: readFrontmatterModel(root, agent.id),
            backendVendor: agent.handWrittenBackend ? agent.backend.vendor : null,
            backendMcpServer: agent.handWrittenBackend ? agent.backend.mcpServer ?? null : null,
            routingSlot: agent.provenance === "frontmatter" ? null : { vendor: agent.backend.vendor, model: agent.backend.model },
          })
        : null;
    out[agent.id] = {
      resolvedModel,
      vendor: harnessDefault ? harnessDefault.vendor : agent.backend.vendor ?? null,
      costModelClass: harnessDefault ? "subscription" : agent.backend.costModelClass ?? null,
      claudeTier: claudeTierFromModel(resolvedModel),
      routeSource,
      handWrittenBackend: agent.handWrittenBackend,
      relayServer: readRelayServer(root, agent.id),
      harnessDefault,
    };
  }
  return out;
}

export type RoutingVisibilityReason = "harness-opencode" | "per-agent" | "hidden";

export interface RoutingVisibility {
  visible: boolean;
  reason: RoutingVisibilityReason;
  /** Kept for wire/API compatibility (the Settings screen's "Use multiple
   *  LLMs" checkbox still reads this) — no longer factors into `visible`.
   *  See p20-t1: visibility is now driven by harness + actual per-agent
   *  routes, not this toggle. */
  useMultipleLlms: boolean;
  profileActive: boolean;
  routedAgentCount: number;
}

/**
 * Whether/why the Routing screen should surface itself from Settings, plus
 * the counters the panel needs to explain that state to the user.
 * `effectiveHarness` is the caller's already-resolved provider id (e.g. from
 * describeProviderSelection/resolveProviderId) — this helper does not
 * re-resolve it.
 */
export function describeRoutingVisibility(root: string, effectiveHarness: string): RoutingVisibility {
  const useMultipleLlms = readUseMultipleLlms(root);
  const harnessOpencode = effectiveHarness === "opencode";

  const view = buildRoutingView({ root, env: process.env });
  const profileActive =
    (view.profile !== null && Object.keys(view.profile.agents ?? {}).length > 0) ||
    Boolean(view.defaults?.model && view.defaults.model.trim() !== "");
  const routes = describeAgentRoutes(root);
  const routedAgentCount = view.agents.filter((a) => routes[a.id]?.routeSource !== "frontmatter").length;

  const visible = harnessOpencode || routedAgentCount > 0;
  const reason: RoutingVisibilityReason = harnessOpencode ? "harness-opencode" : routedAgentCount > 0 ? "per-agent" : "hidden";

  return { visible, reason, useMultipleLlms, profileActive, routedAgentCount };
}

export interface OverrideAgentToClaudeTierResult {
  handled: boolean;
  ok: boolean;
  errors: string[];
}

/**
 * Make a Settings-screen tier-radio click win over a non-frontmatter route:
 * when the agent currently resolves via routing.json (provenance "explicit"
 * or "default"), write/merge an explicit `{ vendor: "anthropic", model:
 * <tier> }` entry for that agent into the profile via saveRoutingProfile
 * (preserving every other agent and the defaults slot), returning
 * handled:true. When the agent's route is pure frontmatter (provenance
 * "frontmatter") — or the agent id is unknown — returns handled:false so the
 * caller falls back to setFrontmatterModel as it did before this task.
 *
 * `scriptsDir` defaults to `root` (the standalone's own layout, where the
 * generator scripts live under `<root>/scripts/`); the VS Code host should
 * pass its extension install root explicitly, matching how it already calls
 * saveRoutingProfile directly (see panel.ts's _handleSaveRouting).
 */
export interface OverrideAgentToClaudeTierOptions {
  /** TycoonAgents install root that contains scripts/ (see saveRoutingProfile /
   *  resolveGeneratorScripts). Defaults to `root` (the standalone's own
   *  layout); the VS Code host must pass its extension install root. */
  scriptsDir?: string;
  /** Effective harness of the caller (the OpenCode generator runs only under "opencode"). */
  effectiveHarness?: string;
}

export async function overrideAgentToClaudeTier(
  root: string,
  agentId: string,
  tier: ClaudeTier,
  options: OverrideAgentToClaudeTierOptions = {},
): Promise<OverrideAgentToClaudeTierResult> {
  const view = buildRoutingView({ root, env: process.env });
  const agent = view.agents.find((a) => a.id === agentId);
  const routeSource = agent
    ? agent.provenance === "default" && hasOwnModelDeclaration(root, agentId)
      ? "frontmatter"
      : agent.provenance
    : "frontmatter";

  if (!agent || routeSource === "frontmatter") {
    return { handled: false, ok: true, errors: [] };
  }

  const { profile: existing } = loadRoutingProfile(root);
  const base: RoutingProfile = existing ?? { version: 1, agents: {} };
  const nextSlot: RoutingSlot = { vendor: "anthropic", model: tier };
  const nextProfile: RoutingProfile = {
    ...base,
    version: 1,
    agents: { ...base.agents, [agentId]: nextSlot },
  };

  const scriptsDir = options.scriptsDir ?? root;
  const result = saveRoutingProfile({ root, profile: nextProfile, scriptsDir, effectiveHarness: options.effectiveHarness });
  return { handled: true, ok: result.ok, errors: result.errors };
}

export interface ClearAgentRouteOptions {
  /** See OverrideAgentToClaudeTierOptions.scriptsDir — defaults to `root`. */
  scriptsDir?: string;
  /** Effective harness of the caller (the OpenCode generator runs only under "opencode"). */
  effectiveHarness?: string;
}

export interface ClearAgentRouteResult {
  /** false when there was nothing to clear (no profile, or no agents[agentId]
   *  entry) — no write happened. */
  handled: boolean;
  ok: boolean;
  errors: string[];
}

/**
 * Remove `agentId`'s explicit entry from routing.json's `agents` map (p20-t1),
 * letting it fall back to `defaults`/frontmatter/alias, then re-run the
 * generators via saveRoutingProfile so the managed backend block is
 * stripped (or the hand-written backup restored) the same way
 * apply-routing-profile.mjs's existing unapply path already does for any
 * profile save. Only that one agent's slot is touched — `defaults`,
 * `orchestrator`, and every other agent entry are preserved verbatim. If
 * removing the last agent leaves an empty `agents` map, the (now-empty)
 * profile is still saved rather than deleting routing.json outright.
 */
export async function clearAgentRoute(
  root: string,
  agentId: string,
  options: ClearAgentRouteOptions = {},
): Promise<ClearAgentRouteResult> {
  const { profile: existing } = loadRoutingProfile(root);
  if (!existing || !existing.agents || !(agentId in existing.agents)) {
    return { handled: false, ok: true, errors: [] };
  }

  const nextAgents = { ...existing.agents };
  delete nextAgents[agentId];
  const nextProfile: RoutingProfile = { ...existing, version: existing.version, agents: nextAgents };

  const scriptsDir = options.scriptsDir ?? root;
  const result = saveRoutingProfile({ root, profile: nextProfile, scriptsDir, effectiveHarness: options.effectiveHarness });
  return { handled: true, ok: result.ok, errors: result.errors };
}
