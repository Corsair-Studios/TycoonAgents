/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * p68-t1: pure keyword-routing health model + fixer, lifted out of
 * `agentKeywordDefaults.ts`/`diagnosticReport.ts`'s scattered per-signal
 * checks into one module both the Agents-screen "doctor" (panel.ts) and the
 * diagnostic report can share so they can never disagree.
 *
 * No fs/vscode imports here — callers (panel.ts, standalone/src/server.mjs
 * via the compiled `out/src/core/keywordHealth.js`) own reading
 * `.claude/agents/*.md` and `agent-keywords.json` and pass the parsed shape
 * in.
 */

import {
  DEFAULT_AGENT_KEYWORDS,
  reconcileAgentKeywords,
  type ReconcileAgentInput,
} from "../host/vscode/agentKeywordDefaults";

/** Kinds of keyword-routing findings {@link computeKeywordHealth} can report. */
export type KeywordFindingKind =
  | "no_keywords"
  | "dangling_ref"
  | "pending_reconcile"
  | "multi_word_segment"
  | "prose_pattern"
  | "duplicate_keyword"
  | "wildcard_first";

/** A fix descriptor: what `normalizeAgentKeywords` would do about a finding. */
export interface KeywordFindingFix {
  kind: "reconcile" | "split_segment" | "drop_segment" | "dedupe" | "reorder";
}

export interface KeywordFinding {
  agentId: string;
  kind: KeywordFindingKind;
  detail: string;
  fix?: KeywordFindingFix;
}

/** A segment longer than this many words is prose, not a routing token. */
const PROSE_WORD_LIMIT = 3;
/** A pattern longer than this many chars is prose, regardless of word count per segment. */
const PROSE_CHAR_LIMIT = 200;

const WILDCARD_ID = "primary-agent";

function splitPattern(pattern: string): string[] {
  return pattern
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Compute every keyword-routing finding for the current roster + config.
 * Reuses {@link reconcileAgentKeywords} (preview form) for the dangling-ref /
 * pending-reconcile / no-keywords bullets so this can never disagree with
 * what `_ensureAgentKeywordsSeeded`'s auto-heal (and the diagnostic report's
 * roster signals) would actually do.
 */
export function computeKeywordHealth(
  agents: ReconcileAgentInput[],
  config: Record<string, any>,
  defaults: Record<string, string> = DEFAULT_AGENT_KEYWORDS
): KeywordFinding[] {
  const findings: KeywordFinding[] = [];
  const safeConfig: Record<string, any> = config !== null && typeof config === "object" ? config : {};
  const existingAgents: Record<string, any> =
    typeof safeConfig.agents === "object" && safeConfig.agents !== null ? safeConfig.agents : {};

  const { dropped, added } = reconcileAgentKeywords(safeConfig, agents, defaults);

  for (const id of dropped) {
    findings.push({
      agentId: id,
      kind: "dangling_ref",
      detail: `agent-keywords.json has an entry for "${id}" but no matching .claude/agents/${id}.md file exists.`,
      fix: { kind: "reconcile" },
    });
  }
  for (const id of added) {
    findings.push({
      agentId: id,
      kind: "pending_reconcile",
      detail: `"${id}" has no agent-keywords.json entry yet; the next reconcile will seed one.`,
      fix: { kind: "reconcile" },
    });
  }

  const addedSet = new Set(added);
  for (const agent of agents) {
    const entry = existingAgents[agent.id];
    const pattern = entry && typeof entry.pattern === "string" ? entry.pattern.trim() : "";
    if (pattern !== "") continue;
    if (addedSet.has(agent.id)) continue; // reconcile would fix this
    findings.push({
      agentId: agent.id,
      kind: "no_keywords",
      detail: `"${agent.id}" has no routing keywords and no default/body fallback — inert routing.`,
    });
  }

  // ---- segment-level scan over existing config entries -------------------
  const tokenOwners = new Map<string, string[]>(); // token -> agentIds in config insertion order
  const configIds = Object.keys(existingAgents);

  for (const id of configIds) {
    const entry = existingAgents[id];
    const pattern = typeof entry?.pattern === "string" ? entry.pattern : "";
    if (pattern.trim() === "") continue;

    if (pattern.length > PROSE_CHAR_LIMIT) {
      findings.push({
        agentId: id,
        kind: "prose_pattern",
        detail: `"${id}"'s pattern is ${pattern.length} chars (over ${PROSE_CHAR_LIMIT}) — looks like prose, not tokens.`,
        fix: { kind: "drop_segment" },
      });
    }

    for (const segment of splitPattern(pattern)) {
      if (/\s/.test(segment)) {
        const words = segment.split(/\s+/).filter(Boolean);
        if (words.length > PROSE_WORD_LIMIT) {
          findings.push({
            agentId: id,
            kind: "prose_pattern",
            detail: `"${id}" segment "${segment}" is ${words.length} words — reads as prose, dropped by the fixer.`,
            fix: { kind: "drop_segment" },
          });
        } else {
          findings.push({
            agentId: id,
            kind: "multi_word_segment",
            detail: `"${id}" segment "${segment}" contains whitespace and can never match a single-word token.`,
            fix: { kind: "split_segment" },
          });
        }
        continue;
      }
      const token = segment.toLowerCase();
      const owners = tokenOwners.get(token) ?? [];
      owners.push(id);
      tokenOwners.set(token, owners);
    }

    // wildcard_first: primary-agent present before a still-later specialist.
    if (id === WILDCARD_ID) {
      const idx = configIds.indexOf(id);
      const hasLaterSpecialist = configIds.slice(idx + 1).some((laterId) => laterId !== WILDCARD_ID);
      if (hasLaterSpecialist) {
        findings.push({
          agentId: id,
          kind: "wildcard_first",
          detail: `"${WILDCARD_ID}" is listed before specialist agents — on a tied score it would steal the match.`,
          fix: { kind: "reorder" },
        });
      }
    }
  }

  for (const [token, owners] of tokenOwners) {
    if (owners.length <= 1) continue;
    const uniqueOwners = Array.from(new Set(owners));
    if (uniqueOwners.length <= 1) continue;
    findings.push({
      agentId: uniqueOwners[0],
      kind: "duplicate_keyword",
      detail: `token "${token}" appears in ${uniqueOwners.join(", ")} — "${uniqueOwners[0]}" wins ties (config order).`,
      fix: { kind: "dedupe" },
    });
  }

  return findings;
}

/**
 * Fix everything {@link computeKeywordHealth} can find automatically:
 * reconcile (drop dangling refs / add missing entries), seed no-keyword
 * entries from body/defaults, then per-pattern: split multi-word segments
 * into single tokens, drop prose segments, dedupe tokens (keeps first
 * occurrence's order), and move `primary-agent` last so it never steals a
 * tie. Idempotent — a second call on its own output makes no further
 * changes. Pure (no fs/vscode); callers own the write + `.bak`.
 */
export function normalizeAgentKeywords(
  config: Record<string, any>,
  agents: ReconcileAgentInput[],
  defaults: Record<string, string> = DEFAULT_AGENT_KEYWORDS
): { config: Record<string, any>; changed: boolean } {
  const safeConfig: Record<string, any> = config !== null && typeof config === "object" ? config : {};

  // 1) Drop dangling refs / add missing entries (body keywords, else defaults).
  const { config: reconciled } = reconcileAgentKeywords(safeConfig, agents, defaults);

  // 2) Seed present-but-empty entries from defaults.
  const existingAfterReconcile: Record<string, any> =
    typeof reconciled.agents === "object" && reconciled.agents !== null ? reconciled.agents : {};
  const seededAgents: Record<string, any> = { ...existingAfterReconcile };
  for (const agent of agents) {
    const entry = seededAgents[agent.id];
    const pattern = entry && typeof entry.pattern === "string" ? entry.pattern : "";
    if (pattern.trim() !== "") continue;
    const bodyKeywords = agent.keywords && agent.keywords.trim() !== "" ? agent.keywords.trim() : undefined;
    const def = bodyKeywords ?? defaults[agent.id];
    if (def === undefined || def.trim() === "") continue;
    seededAgents[agent.id] = { ...(entry ?? {}), pattern: def };
  }

  // 3) Normalize every pattern: split multi-word segments, drop prose, dedupe.
  const normalizedAgents: Record<string, any> = {};
  for (const id of Object.keys(seededAgents)) {
    const entry = seededAgents[id];
    const pattern = typeof entry?.pattern === "string" ? entry.pattern : "";
    if (pattern.trim() === "") {
      normalizedAgents[id] = entry;
      continue;
    }

    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const segment of splitPattern(pattern)) {
      if (/\s/.test(segment)) {
        const words = segment.split(/\s+/).filter(Boolean);
        if (words.length > PROSE_WORD_LIMIT || segment.length > PROSE_CHAR_LIMIT) {
          continue; // prose -> dropped
        }
        for (const w of words) {
          const token = w.trim();
          if (token === "" || seen.has(token.toLowerCase())) continue;
          seen.add(token.toLowerCase());
          tokens.push(token);
        }
        continue;
      }
      if (segment.length > PROSE_CHAR_LIMIT) continue; // single long "segment" -> prose, dropped
      if (seen.has(segment.toLowerCase())) continue;
      seen.add(segment.toLowerCase());
      tokens.push(segment);
    }

    normalizedAgents[id] = { ...entry, pattern: tokens.join("|") };
  }

  // 4) Move primary-agent last (never steals a tie against a specialist).
  const orderedIds = Object.keys(normalizedAgents).filter((id) => id !== WILDCARD_ID);
  if (Object.prototype.hasOwnProperty.call(normalizedAgents, WILDCARD_ID)) {
    orderedIds.push(WILDCARD_ID);
  }
  const finalAgents: Record<string, any> = {};
  for (const id of orderedIds) {
    finalAgents[id] = normalizedAgents[id];
  }

  const nextConfig = { ...reconciled, agents: finalAgents };
  const changed = JSON.stringify(nextConfig) !== JSON.stringify(safeConfig);

  return { config: nextConfig, changed };
}

/** One raw activity record shape this module needs — a structural subset of HookRecord. */
export interface WildcardTaskRecord {
  event?: string;
  workerId?: string;
  routingMethod?: string;
  sessionId?: string;
  description?: string;
  agentDescription?: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with", "at", "by", "from",
  "is", "are", "be", "this", "that", "it", "as", "into", "check", "run", "task",
]);

/**
 * Count Task spawns this session that landed on `primary-agent` via keyword
 * scoring (`routingMethod === "keyword"`), and the most frequent description
 * tokens among them that aren't already present in any agent's pattern
 * (`knownTokens`, lowercase) — a signal of what phrasing to add a keyword
 * for. Pure; callers (panel.ts) own reading/filtering activity.jsonl by
 * current sessionId before calling this.
 */
export function computeWildcardStats(
  records: WildcardTaskRecord[],
  knownTokens: Set<string>,
  limit = 8
): { wildcardTasksThisSession: number; unmatchedWords: string[] } {
  let count = 0;
  const freq = new Map<string, number>();

  for (const r of records) {
    if (r.workerId !== WILDCARD_ID || r.routingMethod !== "keyword") continue;
    count++;
    const text = `${r.description ?? ""} ${r.agentDescription ?? ""}`.toLowerCase();
    const words = text.split(/[^a-z0-9-]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
    const seenInThisRecord = new Set<string>();
    for (const w of words) {
      if (knownTokens.has(w)) continue;
      if (seenInThisRecord.has(w)) continue;
      seenInThisRecord.add(w);
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }

  const unmatchedWords = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);

  return { wildcardTasksThisSession: count, unmatchedWords };
}
