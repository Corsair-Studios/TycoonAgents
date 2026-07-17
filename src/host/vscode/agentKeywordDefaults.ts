/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { REGULAR_AGENTS, LEAD_AGENTS, REVIEWER_AGENTS, type PackAgent } from "./packCatalog";
import { setKeywordPattern } from "./agentConfig";

/** An agent id paired with its parsed body keywords (see {@link parseAgentKeywords}). */
export interface ReconcileAgentInput {
  id: string;
  keywords: string | null;
}

function toKeywordMap(agents: PackAgent[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of agents) {
    map[a.id] = a.keywords;
  }
  return map;
}

/**
 * Default routing keywords for every built-in agent id TycoonAgents can
 * install, used to backfill `.claude/tycoon/agent-keywords.json` entries
 * that are missing or empty (which the settings UI renders as an inert
 * `kw1|kw2|kw3` placeholder and disables keyword routing for that agent).
 *
 * The core roster (`REGULAR_AGENTS`/`LEAD_AGENTS`/`REVIEWER_AGENTS`,
 * defined in `./packCatalog`) is spread in directly so these values can
 * never drift from what a fresh install/repair actually writes via
 * `buildAgentMarkdown`/`_installAgentFiles`.
 *
 * The optional capability-pack agents below (verse-expert, uefn-auditor,
 * web-qa, godot, unity, roblox, blender) are installed from
 * `media/packs/catalog.json` — a JSON asset outside the TypeScript build
 * graph, so it can't be imported here. These literals are copied verbatim
 * from that file; keep them in sync if catalog.json's `keywords` change.
 */
export const DEFAULT_AGENT_KEYWORDS: Record<string, string> = {
  ...toKeywordMap(REGULAR_AGENTS),
  ...toKeywordMap(LEAD_AGENTS),
  ...toKeywordMap(REVIEWER_AGENTS),
  "verse-expert": "verse|uefn|fortnite|device|island|creative|digest",
  "uefn-auditor": "verse|uefn|fortnite|verse-audit|verse-review|verse-lint",
  "web-qa": "playwright|browser|ui|qa|screenshot|accessibility|e2e|web",
  godot: "godot|gdscript|scene|node|signal|tscn|gdextension",
  unity: "unity|csharp|monobehaviour|prefab|gameobject|scene",
  roblox: "roblox|luau|studio|datamodel|instance|service|rojo",
  blender: "blender|modeling|materials|shading|animation|python|bpy|geometry|render",
};

/**
 * Seed missing/empty keyword entries in an agent-keywords config for every
 * id in `installedAgentIds` that has a known default. Pure (no fs/vscode) —
 * unit-testable, and reused by both the panel-open auto-heal
 * (`_ensureAgentKeywordsSeeded`) and `_handleInstallHooks`.
 *
 * Rules:
 * - An id whose config entry is ABSENT, or whose `pattern` is empty/
 *   whitespace-only, is a seeding candidate.
 * - A candidate is filled ONLY if `defaults[id]` exists and is non-empty.
 * - An existing NON-EMPTY pattern is NEVER overwritten.
 * - An id with no default (custom/user-authored agent) is left untouched.
 * - `fallback_agent` and any other top-level/agent keys are preserved
 *   (delegated to `setKeywordPattern`, which never mutates its input).
 *
 * Returns the (possibly new) config object and a `changed` flag so callers
 * can skip an unnecessary file write.
 */
export function seedMissingAgentKeywords(
  config: Record<string, any>,
  installedAgentIds: string[],
  defaults: Record<string, string> = DEFAULT_AGENT_KEYWORDS
): { config: Record<string, any>; changed: boolean } {
  const safeConfig: Record<string, any> =
    config !== null && typeof config === "object" ? config : {};
  const existingAgents: Record<string, any> =
    typeof safeConfig.agents === "object" && safeConfig.agents !== null ? safeConfig.agents : {};

  let cfg = safeConfig;
  let changed = false;

  for (const id of installedAgentIds) {
    const entry = existingAgents[id];
    const existingPattern = entry && typeof entry.pattern === "string" ? entry.pattern : "";
    if (existingPattern.trim() !== "") {
      continue; // never overwrite a non-empty existing value
    }
    const def = defaults[id];
    if (def === undefined || def.trim() === "") {
      continue; // no known default -> leave untouched
    }
    cfg = setKeywordPattern(cfg, id, def);
    changed = true;
  }

  return { config: cfg, changed };
}

/**
 * Extract the routing pattern declared in an agent .md's body
 * `## Keywords (for task routing)` section (the exact header
 * {@link buildAgentMarkdown} in `./packCatalog` emits), tolerant of a bare
 * `## Keywords` header with no trailing "(for task routing)".
 *
 * Collects every non-empty line after the header up to (but not including)
 * the next `##` heading or EOF, trims each, and joins them with a single
 * space (buildAgentMarkdown always emits exactly one line, but this stays
 * tolerant of a hand-wrapped multi-line pattern). Returns `null` when the
 * header is absent or its body is empty/whitespace-only. Pure (no
 * fs/vscode) — this is the single source of truth for "what keywords does
 * this agent file itself declare", used both to seed a missing routing
 * entry with the agent's REAL keywords (rather than a hardcoded default)
 * and to judge routing drift in the diagnostic report.
 */
export function parseAgentKeywords(markdown: string): string | null {
  const lines = markdown.split(/\r\n|\n/);
  const headerIdx = lines.findIndex((l) => /^##\s*Keywords\b/i.test(l.trim()));
  if (headerIdx === -1) {
    return null;
  }

  const contentLines: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^##\s/.test(trimmed)) {
      break; // next section
    }
    if (trimmed === "") {
      continue; // skip blank lines within the section
    }
    contentLines.push(trimmed);
  }

  const joined = contentLines.join(" ").trim();
  return joined === "" ? null : joined;
}

/**
 * Reconcile an agent-keywords config against the CURRENT set of installed
 * agents, non-destructively:
 *
 * - DROP every config entry whose id has no matching agent in `agents`
 *   (a phantom left behind by a deleted/renamed `.claude/agents/<id>.md` —
 *   these can win a keyword match and route to a file that no longer
 *   exists, a silent routing failure). Recorded in `dropped`.
 * - ADD an entry for every agent id NOT already present in the config,
 *   preferring that agent's own parsed body keywords
 *   ({@link parseAgentKeywords}'s `keywords` field) over
 *   `DEFAULT_AGENT_KEYWORDS[id]`, and skipping ids with neither. Recorded
 *   in `added` (only ids that actually got a value).
 * - NEVER overwrites an existing config entry, even an empty one — that's
 *   `seedMissingAgentKeywords`'s job, and preserves a user's manual edits
 *   (including a deliberately-blanked pattern) unconditionally.
 *
 * New entries use the exact same shape `setKeywordPattern` writes
 * (`{ pattern }`), so a subsequent `setKeywordPattern` call on the same id
 * behaves identically whether the entry came from reconcile or the
 * settings UI.
 *
 * Deterministic and idempotent: existing keys keep their original
 * insertion order (minus any dropped), newly-added keys are appended in
 * `agents` order, and a config with no phantoms/gaps against `agents` is
 * returned as-is (`dropped`/`added` both empty) — so
 * `reconcileAgentKeywords(reconcileAgentKeywords(x, agents).config, agents)`
 * always yields the same config with empty `dropped`/`added`. Pure (no
 * fs/vscode).
 */
export function reconcileAgentKeywords(
  config: Record<string, any>,
  agents: ReconcileAgentInput[],
  defaults: Record<string, string> = DEFAULT_AGENT_KEYWORDS
): { config: Record<string, any>; dropped: string[]; added: string[] } {
  const safeConfig: Record<string, any> =
    config !== null && typeof config === "object" ? config : {};
  const existingAgents: Record<string, any> =
    typeof safeConfig.agents === "object" && safeConfig.agents !== null ? safeConfig.agents : {};

  const agentIdSet = new Set(agents.map((a) => a.id));
  const dropped: string[] = [];
  const added: string[] = [];

  // Preserve existing insertion order, dropping phantoms.
  const nextAgents: Record<string, any> = {};
  for (const id of Object.keys(existingAgents)) {
    if (!agentIdSet.has(id)) {
      dropped.push(id);
      continue;
    }
    nextAgents[id] = existingAgents[id];
  }

  // Append entries for agents with no config entry at all, in agents[] order.
  for (const agent of agents) {
    if (Object.prototype.hasOwnProperty.call(nextAgents, agent.id)) {
      continue; // never overwrite an existing entry (even an empty one)
    }
    const bodyKeywords = agent.keywords && agent.keywords.trim() !== "" ? agent.keywords.trim() : undefined;
    const value = bodyKeywords ?? defaults[agent.id];
    if (value === undefined || value.trim() === "") {
      continue; // nothing to seed with -> leave absent
    }
    nextAgents[agent.id] = { pattern: value };
    added.push(agent.id);
  }

  if (dropped.length === 0 && added.length === 0) {
    return { config: safeConfig, dropped, added };
  }

  return {
    config: { ...safeConfig, agents: nextAgents },
    dropped,
    added,
  };
}
