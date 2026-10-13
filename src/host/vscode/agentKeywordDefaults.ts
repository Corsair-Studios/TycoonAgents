/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";
import { REGULAR_AGENTS, refreshSupersededKeywordsBody, SUPERSEDED_DEFAULT_KEYWORDS, LEAD_AGENTS, REVIEWER_AGENTS, FOREIGN_LLM_AGENTS, type PackAgent } from "./packCatalog";
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
 * The core roster (`REGULAR_AGENTS`/`LEAD_AGENTS`/`REVIEWER_AGENTS`) and the
 * opt-in foreign-LLM pack roster (`FOREIGN_LLM_AGENTS`: codex-reviewer,
 * gemini-reviewer, kimi-reviewer, claude-worker — see `./packCatalog`) are
 * spread in directly so these values can never drift from what a fresh
 * install/repair actually writes via `buildAgentMarkdown`/`_installAgentFiles`.
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
  ...toKeywordMap(FOREIGN_LLM_AGENTS),
  "verse-expert": "verse|uefn|fortnite|device|island|creative|digest",
  "uefn-auditor": "auditor|lint|deprecation|deprecated|compliance",
  "web-qa": "playwright|browser|qa|screenshot|accessibility|e2e|web",
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

  // Appended entries must not land after the catch-all: config order breaks
  // score ties, so primary-agent always stays last.
  if (added.length > 0 && Object.prototype.hasOwnProperty.call(nextAgents, "primary-agent")) {
    const catchAll = nextAgents["primary-agent"];
    delete nextAgents["primary-agent"];
    nextAgents["primary-agent"] = catchAll;
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

/**
 * Known-prior default keyword patterns TycoonAgents used to ship, keyed by
 * agent id, for ids whose `DEFAULT_AGENT_KEYWORDS` value has since changed.
 * `reconcileAgentKeywords`/`seedMissingAgentKeywords` deliberately never
 * overwrite an existing non-empty entry, so a project seeded under an older
 * version stays pinned to a stale default forever — this table is the
 * allowlist {@link migrateSupersededKeywords} uses to prove a value is a
 * fossilized OLD default (safe to bump forward) rather than a user's own
 * customization (never touched).
 *
 * Current known supersessions (both dropped a token that could never match
 * — "test plan" is multi-word, the routing matcher only ever compares
 * single words; "verify"/"quality" on `reviewer` collided with
 * `quality-lead`'s tokens):
 * - `quality-lead`: prior `"quality|verify|test plan|acceptance|audit"` ->
 *   current `DEFAULT_AGENT_KEYWORDS["quality-lead"]`
 *   (`"quality|verify|acceptance|audit"`, see `LEAD_AGENTS` in
 *   `./packCatalog`).
 * - `reviewer`: prior `"review|verify|approve|correctness|quality|regression"`
 *   -> current `DEFAULT_AGENT_KEYWORDS["reviewer"]`
 *   (`"review|approve|correctness|regression"`, see `REVIEWER_AGENTS` in
 *   `./packCatalog`).
 *
 * - `uefn-auditor`: prior `"verse|uefn|fortnite|verse-audit|verse-review|verse-lint"`
 *   (shared verse/uefn/fortnite with `verse-expert`, and the hyphenated
 *   segments can never match a single word) -> current
 *   `DEFAULT_AGENT_KEYWORDS["uefn-auditor"]`.
 *
 * Add a new entry here whenever a shipped default pattern changes, so an
 * existing installed project can migrate forward instead of staying pinned
 * to the value it happened to be seeded with.
 */

/**
 * Bump ONLY provably-stale default keyword patterns forward to the current
 * default, for the small set of managed lead/reviewer agent ids in
 * {@link SUPERSEDED_DEFAULT_KEYWORDS}. This exists because
 * `reconcileAgentKeywords`/`seedMissingAgentKeywords` never overwrite an
 * existing entry (by design — preserving a user's customization always
 * wins), which means a project seeded under an older version keeps a
 * fossilized default forever with no path forward.
 *
 * An id's entry is migrated only when its `pattern` is an EXACT match for
 * one of that id's known prior defaults AND differs from the current
 * default — any other value (a user's custom pattern, a pattern that's
 * already current, or a pattern that doesn't match any known-prior value)
 * is left completely untouched. Pure (no fs/vscode), deterministic, and
 * idempotent: a second pass finds every migrated entry already equal to
 * its current default and changes nothing.
 *
 * Returns the (possibly new) config object and a `changed` flag so callers
 * can skip an unnecessary file write, matching the calling convention of
 * `seedMissingAgentKeywords`/`reconcileAgentKeywords`.
 */
export function migrateSupersededKeywords(
  config: Record<string, any>,
  defaults: Record<string, string> = DEFAULT_AGENT_KEYWORDS
): { config: Record<string, any>; changed: boolean } {
  const safeConfig: Record<string, any> =
    config !== null && typeof config === "object" ? config : {};
  const existingAgents: Record<string, any> =
    typeof safeConfig.agents === "object" && safeConfig.agents !== null ? safeConfig.agents : {};

  let nextAgents = existingAgents;
  let changed = false;

  for (const id of Object.keys(SUPERSEDED_DEFAULT_KEYWORDS)) {
    const entry = existingAgents[id];
    if (!entry || typeof entry.pattern !== "string") continue;

    const currentDefault = defaults[id];
    if (currentDefault === undefined || entry.pattern === currentDefault) continue; // no default, or already current

    const priorPatterns = SUPERSEDED_DEFAULT_KEYWORDS[id];
    if (!priorPatterns.includes(entry.pattern)) continue; // not a known-prior default -> leave untouched (custom value)

    if (nextAgents === existingAgents) {
      nextAgents = { ...existingAgents };
    }
    nextAgents[id] = { ...entry, pattern: currentDefault };
    changed = true;
  }

  if (!changed) {
    return { config: safeConfig, changed: false };
  }

  return { config: { ...safeConfig, agents: nextAgents }, changed: true };
}

/**
 * Rewrite only the `## Keywords (for task routing)` body line of each
 * `<agentsDir>/*.md` whose line exactly equals a superseded default for that
 * agent id (see {@link SUPERSEDED_DEFAULT_KEYWORDS}) to the current default.
 * Edited bodies, symlinks and unknown ids are untouched; line endings are
 * preserved. Returns the ids rewritten.
 */
export function migrateSupersededAgentBodies(
  agentsDir: string,
  defaults: Record<string, string> = DEFAULT_AGENT_KEYWORDS
): string[] {
  const written: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(agentsDir);
  } catch {
    return written;
  }
  for (const file of names) {
    if (!file.endsWith(".md")) continue;
    const id = file.replace(/\.md$/, "");
    if (!SUPERSEDED_DEFAULT_KEYWORDS[id] || defaults[id] === undefined) continue;
    try {
      const filePath = path.join(agentsDir, file);
      if (fs.lstatSync(filePath).isSymbolicLink()) continue;
      const content = fs.readFileSync(filePath, "utf8");
      const next = refreshSupersededKeywordsBody(content, id, defaults[id]);
      if (next === null) continue;
      fs.writeFileSync(filePath, next, "utf8");
      written.push(id);
    } catch {
      // best-effort
    }
  }
  return written;
}
