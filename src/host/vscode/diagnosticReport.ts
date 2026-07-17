/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { ContextBudget } from "./contextBudget";

/**
 * "Generate diagnostic report" (bug-report) feature — a SANITIZED Markdown
 * snapshot of a project's TycoonAgents health signals the user can review
 * and hand to the maintainer (Discord/email/etc.). This module is
 * deliberately PURE: no fs/vscode access, no network, no runtime AI, and no
 * `Date.now()` calls — every timestamp is injected by the caller — so it is
 * fully unit-testable and its output is fully deterministic for a given
 * input. `panel.ts`'s `_handleGenerateDiagnostic` does all the actual
 * gathering (fs reads, vscode.env) and hands the results in here as a plain
 * data object.
 *
 * CONSTRAINT: the returned Markdown must never contain an absolute
 * filesystem path or an obvious secret/token. `buildDiagnosticReport` runs
 * its ENTIRE assembled output through {@link sanitize} as the final step, so
 * even a caller that accidentally embeds a raw path/token in one of the
 * gathered fields gets scrubbed before this function returns — sanitize is
 * the single guarantee point, not something each section has to remember to
 * apply individually.
 */

// ---------------------------------------------------------------------------
// sanitize()
// ---------------------------------------------------------------------------

/** Known absolute-path roots to fold into stable placeholders before redaction. */
export interface SanitizeRoots {
  /** The workspace/project root (e.g. `_projectRoot()`), if resolved. */
  projectRoot?: string | null;
  /** The user's home directory (`os.homedir()`), if known. */
  homeDir?: string | null;
  /** The extension's install directory, if known. */
  extensionDir?: string | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex that matches `rootPath` in `text` regardless of which slash
 * style (`/` or `\`) was used to join its segments, case-insensitively
 * (Windows paths are case-insensitive). Returns null for an empty/root-less
 * path so callers can skip a no-op replace.
 */
function pathRegex(rootPath: string): RegExp | null {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  // Guard against a degenerate root (empty, "/", or a bare drive letter like
  // "C:") — folding one of those in would produce a near-empty pattern that
  // over-redacts unrelated substrings across the whole report.
  if (trimmed === "" || /^[A-Za-z]:$/.test(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/).filter((s) => s !== "");
  if (segments.length === 0) return null;
  const pattern = segments.map(escapeRegExp).join("[\\\\/]+");
  return new RegExp(pattern, "gi");
}

/** Redact any leftover Windows-style absolute path (`C:\...` or `C:/...`) not already folded into a known root. */
const WINDOWS_PATH_FALLBACK_RE = /\b[A-Za-z]:[\\/][^\s"'`)]+/g;

/**
 * Redact any leftover Unix-style absolute path — single-segment (`/tmp`,
 * `/root`) or multi-segment (`/usr/local/bin`) — not already folded into a
 * known root. `sanitize` is a public-sharing safety boundary, so this errs
 * toward over-redaction: it matches `/segment(/segment)*` wherever a `/`
 * starts at a boundary (start-of-string, whitespace, a quote, `(`, or `=`).
 * That boundary requirement is what keeps ordinary prose slashes intact
 * ("and/or", "read/write" — the `/` there is preceded by a letter, not a
 * boundary char) while still catching `(/local/path)` markdown links and
 * `PATH=/usr/bin` env-style mentions. It also means a `/` preceded by
 * another `/` never starts a match, so `https://example.com/path` survives
 * untouched (each of its slashes is preceded by `:` or another `/`).
 */
const UNIX_PATH_FALLBACK_RE = /(?<=^|[\s"'`(=])\/[^\s"'`)]+/g;

/** Long hex strings (32+ chars) — hashes, raw API keys, etc. */
const LONG_HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
/** OpenAI-style secret keys. */
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
/** GitHub-style tokens (ghp_/gho_/ghu_/ghs_/ghr_). */
const GH_TOKEN_RE = /\bgh[oprsu]_[A-Za-z0-9]{10,}\b/g;

/**
 * Replace absolute paths under known roots with stable placeholders
 * (`${PROJECT_ROOT}`, `~`, `${EXTENSION_DIR}`), fall back to generic
 * path-shaped redaction for anything left over, then redact obvious
 * secrets/tokens. Order matters: the most specific/longest root
 * (projectRoot, often nested under extensionDir/homeDir) is folded first so
 * a shorter root's replacement never masks a longer one still present in
 * the text. Pure, defensive — never throws; a bad/empty root is just a
 * no-op for that step.
 */
export function sanitize(text: string, roots: SanitizeRoots = {}): string {
  if (typeof text !== "string" || text === "") return text ?? "";
  let out = text;

  try {
    if (roots.projectRoot) {
      const re = pathRegex(roots.projectRoot);
      if (re) out = out.replace(re, "${PROJECT_ROOT}");
    }
  } catch {
    /* best-effort */
  }
  try {
    if (roots.extensionDir) {
      const re = pathRegex(roots.extensionDir);
      if (re) out = out.replace(re, "${EXTENSION_DIR}");
    }
  } catch {
    /* best-effort */
  }
  try {
    if (roots.homeDir) {
      const re = pathRegex(roots.homeDir);
      if (re) out = out.replace(re, "~");
    }
  } catch {
    /* best-effort */
  }

  // Generic fallback so ANY remaining absolute path (not one of the known
  // roots above) is still stripped — this is the guarantee, not just the
  // known-root convenience.
  try {
    out = out.replace(WINDOWS_PATH_FALLBACK_RE, "<path>");
  } catch {
    /* best-effort */
  }
  try {
    out = out.replace(UNIX_PATH_FALLBACK_RE, "<path>");
  } catch {
    /* best-effort */
  }

  // Obvious secrets/tokens.
  try {
    out = out.replace(SK_TOKEN_RE, "[REDACTED]");
    out = out.replace(GH_TOKEN_RE, "[REDACTED]");
    out = out.replace(LONG_HEX_RE, "[REDACTED]");
  } catch {
    /* best-effort */
  }

  return out;
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface DiagnosticHookInfo {
  installed: boolean;
  /** Epoch ms of the last activity.jsonl write, or null if never/unavailable. */
  lastActivityAt: number | null;
}

export interface DiagnosticHookHealth {
  healthy: boolean;
  issueCount: number;
}

export interface DiagnosticDelegation {
  mode: string;
  reviewEnabled: boolean;
}

export interface DiagnosticDoctrine {
  foreignBlocks?: Array<{ namespace: string; lines: number }>;
}

export interface DiagnosticRoster {
  /** Agent ids found on disk under `.claude/agents/*.md`. */
  agentIds: string[];
  /** Agent ids present as keys in `agent-keywords.json`'s `agents` map. */
  keywordIds: string[];
  /** Keyword-map ids with no corresponding agent file — the dangling-reference (phantom) bug class. */
  danglingKeywordRefs: string[];
  /**
   * Agent files with genuinely no way to route by keyword: the json pattern
   * is empty/absent AND a reconcile has nothing to fill it with either (no
   * body `## Keywords` section, no known default). Inert routing that needs
   * a human to add keywords.
   */
  agentsWithNoKeywords: string[];
  /**
   * Agent files whose json entry is missing/empty but whose body already
   * declares `## Keywords` (or has a known default) — the next auto-heal
   * (panel open with hooks installed) will fill these in automatically.
   * Distinct from `agentsWithNoKeywords`: these are drift, not dead ends.
   * Optional so older callers/fixtures built before this field existed
   * still type-check; treated as `[]` when absent.
   */
  agentsPendingReconcile?: string[];
}

export interface DiagnosticEngineChip {
  id: string;
  label: string;
  state: string;
  detail: string;
}

export interface DiagnosticUefn {
  detected: boolean;
  signals: string[];
  uefnInstalled: boolean;
  bridgeSetUp: boolean;
}

export interface DiagnosticEngines {
  chips: DiagnosticEngineChip[];
  uefn: DiagnosticUefn | null;
  mcpServerIds: string[];
}

/**
 * Everything `buildDiagnosticReport` needs. Every field beyond `timestamp`
 * and `roots` is optional/nullable — a gather step the host couldn't
 * complete (missing file, no workspace, read error) is passed as
 * `null`/`undefined` and renders as "n/a" rather than throwing.
 */
export interface DiagnosticReportInput {
  /** ISO-8601 timestamp for the report header, injected by the caller (never `Date.now()` inside this module). */
  timestamp: string;
  roots: SanitizeRoots;
  extensionVersion?: string | null;
  platform?: string | null;
  hostAppName?: string | null;
  hostAppHost?: string | null;
  hook?: DiagnosticHookInfo | null;
  hookHealth?: DiagnosticHookHealth | null;
  delegation?: DiagnosticDelegation | null;
  doctrine?: DiagnosticDoctrine | null;
  contextBudget?: ContextBudget | null;
  roster?: DiagnosticRoster | null;
  engines?: DiagnosticEngines | null;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const NA = "n/a";

function line(label: string, value: string): string {
  return `- **${label}:** ${value}`;
}

function fmtBool(v: boolean | undefined | null, whenTrue: string, whenFalse: string): string {
  if (v === undefined || v === null) return NA;
  return v ? whenTrue : whenFalse;
}

function fmtTimestamp(epochMs: number | null | undefined): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "never";
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return "never";
  }
}

function fmtList(items: string[] | undefined | null, empty = "none"): string {
  if (!items || items.length === 0) return empty;
  return items.map((i) => `\`${i}\``).join(", ");
}

function section(title: string, bodyLines: string[]): string {
  const body = bodyLines.length > 0 ? bodyLines.join("\n") : `_${NA}_`;
  return `## ${title}\n\n${body}`;
}

/** Run `render` and fall back to a single "n/a" line if it throws — the "never throw" guarantee per-section. */
function safeSection(title: string, render: () => string[]): string {
  try {
    return section(title, render());
  } catch {
    return section(title, []);
  }
}

// ---------------------------------------------------------------------------
// buildDiagnosticReport()
// ---------------------------------------------------------------------------

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const safeInput = input ?? ({} as DiagnosticReportInput);
  const roots = safeInput.roots ?? {};

  const header = `# TycoonAgents Diagnostic Report\n\nGenerated: ${safeInput.timestamp ?? NA}`;

  const environment = safeSection("Environment", () => [
    line("Extension version", safeInput.extensionVersion || NA),
    line("Platform", safeInput.platform || NA),
    line("Host application", safeInput.hostAppName || NA),
    ...(safeInput.hostAppHost ? [line("Host variant", safeInput.hostAppHost)] : []),
  ]);

  const hookHealth = safeSection("Hook Health", () => {
    const hook = safeInput.hook;
    const health = safeInput.hookHealth;
    const rows: string[] = [];
    rows.push(line("Hook installed", hook ? fmtBool(hook.installed, "yes", "no") : NA));
    rows.push(line("Last activity", hook ? fmtTimestamp(hook.lastActivityAt) : NA));
    rows.push(
      line(
        "Diagnosed health",
        health ? (health.healthy ? "healthy — no issues detected" : `${health.issueCount} issue(s) detected`) : NA,
      ),
    );
    return rows;
  });

  const delegation = safeSection("Delegation & Review", () => {
    const d = safeInput.delegation;
    if (!d) return [line("Delegation mode", NA), line("Review pass", NA)];
    return [
      line("Delegation mode", d.mode || NA),
      line("Review pass", fmtBool(d.reviewEnabled, "enabled", "disabled")),
    ];
  });

  const doctrineHealth = safeSection("Doctrine Health (CLAUDE.md)", () => {
    const doc = safeInput.doctrine;
    if (!doc) return [line("Legacy/foreign managed blocks", NA)];
    const rows: string[] = [];
    if (doc.foreignBlocks && doc.foreignBlocks.length > 0) {
      rows.push(line("Legacy/foreign managed blocks", `${doc.foreignBlocks.length} found`));
      for (const block of doc.foreignBlocks) {
        rows.push(`  - \`${block.namespace}:*\`: ${block.lines} lines`);
      }
    } else {
      rows.push(line("Legacy/foreign managed blocks", "none"));
    }
    return rows;
  });

  const contextBudget = safeSection("Context Budget", () => {
    const budget = safeInput.contextBudget;
    if (!budget) return [];
    const rows: string[] = [];
    rows.push(
      line(
        "CLAUDE.md",
        budget.claudeMd ? `${budget.claudeMd.tokens} tokens (${budget.claudeMd.grade})` : "not found",
      ),
    );
    rows.push(line("Agents total", `${budget.agentsTotalTokens} tokens across ${budget.agents.length} file(s)`));
    rows.push(line("Overall grade", budget.overall || NA));
    if (budget.agents.length > 0) {
      rows.push("");
      rows.push("| File | Tokens | Grade |");
      rows.push("| --- | --- | --- |");
      for (const f of budget.agents) {
        rows.push(`| ${f.name} | ${f.tokens} | ${f.grade} |`);
      }
    }
    return rows;
  });

  const roster = safeSection("Agent Roster Consistency", () => {
    const r = safeInput.roster;
    if (!r) return [];
    const rows: string[] = [
      line("Agents on disk", `${r.agentIds.length} (${fmtList(r.agentIds)})`),
      line("Keyword-routed agents", `${r.keywordIds.length} (${fmtList(r.keywordIds)})`),
    ];
    if (r.danglingKeywordRefs.length > 0) {
      rows.push(
        line(
          "Dangling keyword references",
          `${r.danglingKeywordRefs.length} — routing entries with NO agent file: ${fmtList(r.danglingKeywordRefs)}`,
        ),
      );
    } else {
      rows.push(line("Dangling keyword references", "none"));
    }
    if (r.agentsWithNoKeywords.length > 0) {
      rows.push(
        line(
          "Agents with no keywords",
          `${r.agentsWithNoKeywords.length} — inert routing: ${fmtList(r.agentsWithNoKeywords)}`,
        ),
      );
    } else {
      rows.push(line("Agents with no keywords", "none"));
    }
    const pendingReconcile = r.agentsPendingReconcile ?? [];
    if (pendingReconcile.length > 0) {
      rows.push(
        line(
          "Agents pending keyword reconcile",
          `${pendingReconcile.length} — will auto-heal on next panel open: ${fmtList(pendingReconcile)}`,
        ),
      );
    } else {
      rows.push(line("Agents pending keyword reconcile", "none"));
    }
    return rows;
  });

  const engines = safeSection("Engine & UEFN", () => {
    const e = safeInput.engines;
    if (!e) return [];
    const rows: string[] = [];
    if (e.chips.length > 0) {
      rows.push(line("Detected engines", e.chips.map((c) => `${c.label} (${c.state})`).join(", ")));
    } else {
      rows.push(line("Detected engines", "none"));
    }
    if (e.uefn) {
      rows.push(
        line(
          "UEFN project",
          e.uefn.detected ? `detected (${fmtList(e.uefn.signals, "no signals")})` : "not detected",
        ),
      );
      rows.push(line("UEFN installed locally", fmtBool(e.uefn.uefnInstalled, "yes", "no")));
      rows.push(line("UEFN bridge set up", fmtBool(e.uefn.bridgeSetUp, "yes", "no")));
    } else {
      rows.push(line("UEFN project", NA));
    }
    rows.push(line("Configured MCP servers", fmtList(e.mcpServerIds)));
    return rows;
  });

  const parts = [header, environment, hookHealth, delegation, doctrineHealth, contextBudget, roster, engines];

  const markdown = parts.join("\n\n") + "\n";

  // Final guarantee pass: strip any absolute path / obvious secret that
  // slipped into any field above, regardless of section.
  return sanitize(markdown, roots);
}
