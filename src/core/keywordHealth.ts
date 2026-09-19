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
  kind: "reconcile" | "split_segment" | "drop_segment" | "dedupe" | "reorder" | "remove_from_wildcard";
}

/**
 * warning: counts toward the card header/count and gets an amber signal.
 * info: harmless overlap (e.g. two specialists sharing a token) — collapsed
 * under "Shared keywords" in the UI, never counted, never amber.
 */
export type KeywordFindingSeverity = "warning" | "info";

export interface KeywordFinding {
  agentId: string;
  kind: KeywordFindingKind;
  severity: KeywordFindingSeverity;
  detail: string;
  fix?: KeywordFindingFix;
}

/** A segment longer than this many words is prose, not a routing token. */
const PROSE_WORD_LIMIT = 3;
/** A pattern longer than this many chars is prose, regardless of word count per segment. */
const PROSE_CHAR_LIMIT = 200;

const WILDCARD_ID = "primary-agent";
/**
 * Placeholder token normalizeAgentKeywords writes into primary-agent's
 * pattern when stripping specialist-owned tokens would leave it empty (the
 * wildcard is the catch-all; its pattern only ever matters for ties, so an
 * empty pattern is avoided purely to keep the config file shape valid).
 * Never treated as a real routing token by the duplicate scan below.
 */
const WILDCARD_PLACEHOLDER_TOKEN = "fallback";

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
      severity: "warning",
      detail: `agent-keywords.json has an entry for "${id}" but no matching .claude/agents/${id}.md file exists.`,
      fix: { kind: "reconcile" },
    });
  }
  for (const id of added) {
    findings.push({
      agentId: id,
      kind: "pending_reconcile",
      severity: "warning",
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
      severity: "warning",
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
        severity: "warning",
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
            severity: "warning",
            detail: `"${id}" segment "${segment}" is ${words.length} words — reads as prose, dropped by the fixer.`,
            fix: { kind: "drop_segment" },
          });
        } else {
          findings.push({
            agentId: id,
            kind: "multi_word_segment",
            severity: "warning",
            detail: `"${id}" segment "${segment}" contains whitespace and can never match a single-word token.`,
            fix: { kind: "split_segment" },
          });
        }
        continue;
      }
      const token = segment.toLowerCase();
      // Skip the wildcard's own empty-pattern placeholder (see
      // normalizeAgentKeywords step 3b) from duplicate-scan bookkeeping —
      // it isn't a real routing token, so a specialist legitimately owning
      // the word "fallback" must never trip a duplicate_keyword finding.
      if (id === WILDCARD_ID && token === WILDCARD_PLACEHOLDER_TOKEN) continue;
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
          severity: "warning",
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
    // Overlap involving the wildcard is a real routing bug (the wildcard is
    // a catch-all and should never own a token a specialist owns) — warning
    // with a fix. Overlap between two specialists is harmless/expected
    // (both legitimately answer to the word) — informational, uncounted,
    // no fix.
    const involvesWildcard = uniqueOwners.includes(WILDCARD_ID);
    findings.push({
      agentId: uniqueOwners[0],
      kind: "duplicate_keyword",
      severity: involvesWildcard ? "warning" : "info",
      detail: `token "${token}" appears in ${uniqueOwners.join(", ")} — "${uniqueOwners[0]}" wins ties (config order).`,
      fix: involvesWildcard ? { kind: "remove_from_wildcard" } : undefined,
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

  // 3b) The wildcard is only ever a catch-all: strip any token it shares
  // with a specialist so it never steals a match that already has an owner
  // (mirrors the "warning" duplicate_keyword finding's fix descriptor,
  // remove_from_wildcard).
  if (Object.prototype.hasOwnProperty.call(normalizedAgents, WILDCARD_ID)) {
    const specialistTokens = new Set<string>();
    for (const id of Object.keys(normalizedAgents)) {
      if (id === WILDCARD_ID) continue;
      const pattern = typeof normalizedAgents[id]?.pattern === "string" ? normalizedAgents[id].pattern : "";
      for (const seg of splitPattern(pattern)) specialistTokens.add(seg.toLowerCase());
    }
    const wildcardEntry = normalizedAgents[WILDCARD_ID];
    const wildcardPattern = typeof wildcardEntry?.pattern === "string" ? wildcardEntry.pattern : "";
    if (wildcardPattern !== "") {
      const keptTokens = splitPattern(wildcardPattern).filter((t) => !specialistTokens.has(t.toLowerCase()));
      // Stripping every specialist-owned token can leave the wildcard with
      // no pattern at all — fall back to the documented placeholder token
      // rather than an empty string, to keep the config file shape valid.
      // It never matches for real (see computeKeywordHealth's skip above);
      // it only exists so the wildcard still has *some* pattern on record.
      const finalTokens = keptTokens.length > 0 ? keptTokens : [WILDCARD_PLACEHOLDER_TOKEN];
      normalizedAgents[WILDCARD_ID] = { ...wildcardEntry, pattern: finalTokens.join("|") };
    }
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
