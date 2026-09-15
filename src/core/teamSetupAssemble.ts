/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Host-neutral assembler for TeamManifestInput (plan task p48-t3). Pure over
// injected values/readers so both hosts (src/host/vscode/panel.ts,
// standalone/src/server.mjs) can build the same manifest from their own
// already-loaded state without this module touching `fs` or `vscode`
// itself. See src/core/teamSetup.ts for buildTeamManifest/validate/
// serialize; this module only produces its input.
//
// Sourcing (see each host's call site for the concrete reads):
//   - roster        -> loadAgentRoster(agentsDir) (src/providers/claude-code/agentRoster)
//   - routing        -> buildRoutingView({root, env}).agents (src/core/routingHostOps),
//                        via each agent's resolved Backend
//   - requiredEnv    -> the union of endpointEnv/apiKeyEnv names collected while
//                        building `routing`, probed with probeEnv() for setAtExport
//                        (env-var/local-store PRESENCE only — never a value)
//   - skills         -> directory names under .claude/skills/
//   - mcp            -> keys of .mcp.json's mcpServers (or its top-level object)
//   - delegation     -> readExecutionConfig(claudeDir).delegation_mode + a
//                        caller-supplied parallelLimit (no persisted store for
//                        this yet; callers pass CLAUDE.md's documented default)
//   - planPointer    -> ".claude/tycoon/plan.json" when the caller says it exists
// ---------------------------------------------------------------------------

import type { Backend } from "./agentBackend";
import type { EnvProbeEntry } from "./routingHostOps";
import type {
  TeamManifestDelegation,
  TeamManifestInput,
  TeamManifestRequiredEnv,
  TeamManifestRosterEntry,
  TeamManifestRouting,
} from "./teamSetup";

export interface TeamSetupAssembleRosterEntry {
  id: string;
  name: string;
}

export interface TeamSetupAssembleRoutingAgent {
  id: string;
  backend: Backend;
  /** Ordered 'vendor/model' fallback chain from the agent's resolved routing
   *  slot (see RoutingSlot.fallback in src/core/routingProfile.ts) — empty
   *  only when the slot truly has none. */
  fallbackChain: string[];
  /** Env var NAMES (never values) this agent's OWN primary slot requires —
   *  its endpointEnv/apiKeyEnv names only. Omit/empty when the primary slot
   *  needs no env. Readiness checks only THIS agent's own list, never the
   *  manifest-wide requiredEnv union. */
  envNames?: string[];
  /** Env var NAMES per fallback chain entry, keyed by that entry's label as
   *  it appears in `fallbackChain`. */
  fallbackEnvNames?: Record<string, string[]>;
}

export interface TeamSetupAssembleInput {
  /** Agent id + display name pairs — from loadAgentRoster(). */
  roster: TeamSetupAssembleRosterEntry[];
  /** One resolved Backend per agent — from buildRoutingView(...).agents. */
  routingAgents: TeamSetupAssembleRoutingAgent[];
  /** Optional resolved orchestrator backend — from buildRoutingView(...).orchestrator. */
  orchestrator?: {
    id: string;
    backend: Backend;
    fallbackChain: string[];
    envNames?: string[];
    fallbackEnvNames?: Record<string, string[]>;
  };
  /**
   * Presence-only probe (never a value) for every endpointEnv/apiKeyEnv name
   * collected across routingAgents + orchestrator — from routingHostOps'
   * probeEnv(). Callers build this with the SAME env-name set the routing
   * view itself collected, so requiredEnv and routing never disagree.
   */
  envProbe: Record<string, EnvProbeEntry>;
  /** Skill directory names under .claude/skills/. */
  skills: string[];
  /** MCP catalog ids configured in .mcp.json's mcpServers. */
  mcp: string[];
  delegation: TeamManifestDelegation;
  /** Present only when .claude/tycoon/plan.json exists on disk. */
  planPointer?: string;
}

function backendToRouting(
  backend: Backend,
  fallbackChain: string[],
  envNames?: string[],
  fallbackEnvNames?: Record<string, string[]>,
): TeamManifestRouting {
  const out: TeamManifestRouting = { fallbackChain: [...fallbackChain] };
  if (backend.vendor !== undefined) out.vendor = backend.vendor;
  if (backend.model !== undefined) out.model = backend.model;
  if (backend.costModelClass !== undefined) out.costClass = backend.costModelClass;
  if (envNames && envNames.length > 0) out.envNames = [...envNames];
  if (fallbackEnvNames && Object.keys(fallbackEnvNames).length > 0) {
    out.fallbackEnvNames = Object.fromEntries(Object.entries(fallbackEnvNames).map(([k, v]) => [k, [...v]]));
  }
  return out;
}

function envEntryToRequired(name: string, entry: EnvProbeEntry): TeamManifestRequiredEnv {
  return { name, setAtExport: Boolean(entry.env || entry.stored) };
}

/**
 * Pure assembler: turns already-loaded host state into a TeamManifestInput
 * ready for teamSetup.ts's buildTeamManifest(). Never reads disk/env itself
 * and never carries an env var's VALUE — only its name and a boolean
 * presence flag (setAtExport), sourced from routingHostOps.probeEnv().
 */
export function assembleTeamSetupInput(input: TeamSetupAssembleInput): TeamManifestInput {
  const roster: TeamManifestRosterEntry[] = input.roster.map((r) => ({ id: r.id, displayName: r.name }));

  const routing: Record<string, TeamManifestRouting> = {};
  for (const agent of input.routingAgents) {
    routing[agent.id] = backendToRouting(agent.backend, agent.fallbackChain, agent.envNames, agent.fallbackEnvNames);
  }
  if (input.orchestrator) {
    routing[input.orchestrator.id || "orchestrator"] = backendToRouting(
      input.orchestrator.backend,
      input.orchestrator.fallbackChain,
      input.orchestrator.envNames,
      input.orchestrator.fallbackEnvNames,
    );
  }

  const requiredEnv: TeamManifestRequiredEnv[] = Object.keys(input.envProbe).map((name) =>
    envEntryToRequired(name, input.envProbe[name]),
  );

  return {
    roster,
    routing,
    requiredEnv,
    skills: [...input.skills],
    mcp: [...input.mcp],
    delegation: { mode: input.delegation.mode, parallelLimit: input.delegation.parallelLimit },
    ...(input.planPointer !== undefined ? { planPointer: input.planPointer } : {}),
  };
}
