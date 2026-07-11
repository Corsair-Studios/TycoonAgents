/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { REGULAR_AGENTS, LEAD_AGENTS, REVIEWER_AGENTS, type PackAgent } from "./packCatalog";
import { setKeywordPattern } from "./agentConfig";

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
