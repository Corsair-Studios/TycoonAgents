/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import {
  REGULAR_AGENTS,
  LEAD_AGENTS,
  REVIEWER_AGENTS,
  FOREIGN_LLM_AGENTS,
  buildAgentMarkdown,
  agentMarkdownHasTycoonMarker,
  type PackAgent,
} from "./packCatalog";

export type BudgetGrade = "ok" | "warn" | "high";

export interface BudgetFile {
  name: string;
  tokens: number;
  grade: BudgetGrade;
}

/**
 * "Review for trimming" gate. The button is disabled on a fresh install
 * (nothing user-authored to trim) and enabled only when ANY of these holds.
 * All token counts use {@link estimateTokens}.
 */
export const TRIM_REVIEW_THRESHOLDS = {
  /** CLAUDE.md tokens OUTSIDE TycoonAgents' managed `<!-- tycoon:* -->` blocks. */
  userClaudeMdTokens: 1500,
  /** Per-prompt total (whole CLAUDE.md) high bar. */
  perPromptTokens: 12000,
  /** Tokens a pack-installed agent file carries beyond its catalog rendering. */
  agentAdditionTokens: 500,
} as const;

export const TRIM_REVIEW_DISABLED_TIP =
  "Nothing to trim yet \u2014 these are TycoonAgents' own setup files.";

/** Prompt copied by the button. The protection clause comes first. */
export const TRIM_REVIEW_PROMPT =
  "Do not modify, reword, condense, or remove any TycoonAgents-managed block in CLAUDE.md (everything between <!-- tycoon:NAME --> and <!-- /tycoon:NAME --> markers, e.g. tycoon:delegation and tycoon:coderules), nor those comment markers, nor any delegation or routing language anywhere in CLAUDE.md, AGENTS.md or .claude/agents/*.md \u2014 TycoonAgents uses them to locate and repair its sections, and trimming that content breaks agent delegation. " +
  "Only review the user's OWN additions: text in CLAUDE.md outside the managed blocks, and content a user added to .claude/agents/*.md beyond the installed pack body. Flag verbose, duplicated, or non-essential lines there and propose a tighter rewrite that preserves every behavioral rule. " +
  "Do NOT edit any file directly: list the proposed changes (with a before/after token estimate and the specific cuts) and wait for my approval before applying anything. " +
  "A large reference/knowledge agent can be intentionally large; do not flag a file just because of its size.";

export interface TrimReview {
  enabled: boolean;
  /** Tooltip for the button. */
  tip: string;
  userClaudeMdTokens: number;
  agentAdditionTokens: number;
  prompt: string;
  /** Set by hosts without a clipboard bridge (standalone): the page copies itself. */
  clientCopy?: boolean;
}

/** Remove every `<!-- tycoon:NAME -->...<!-- /tycoon:NAME -->` managed block. */
export function stripManagedBlocks(content: string): string {
  const closed = content.replace(/<!--\s*tycoon:([\w-]+)\s*-->[\s\S]*?<!--\s*\/tycoon:\1\s*-->/g, "");
  // An orphan open marker (damaged file) strips to EOF so it cannot enable the button.
  return closed.replace(/<!--\s*tycoon:[\w-]+\s*-->[\s\S]*$/, "");
}

/** Agent markdown without its leading `---` frontmatter block. */
function agentBody(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return m ? content.slice(m[0].length) : content;
}

const ALL_CATALOG_AGENTS: PackAgent[] = [
  ...REGULAR_AGENTS,
  ...LEAD_AGENTS,
  ...REVIEWER_AGENTS,
  ...FOREIGN_LLM_AGENTS,
];

export interface ContextBudget {
  claudeMd: BudgetFile | null;      // null if no CLAUDE.md
  agents: BudgetFile[];
  perPromptTokens: number;          // = claudeMd tokens (loaded every prompt), 0 if none
  agentsTotalTokens: number;
  overall: BudgetGrade;             // = claudeMd grade if present, else worst agent grade, else "ok"
  trimReview: TrimReview;
}

/** Rough token estimate: 1 token ≈ 4 chars. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Grade CLAUDE.md: ok <8000, warn <16000, high >=16000.
 *
 * CLAUDE.md is in a class of its own and is deliberately graded on a
 * separate, much higher scale than agent files: it carries the whole
 * delegation doctrine and project instructions, is expected to be the
 * heavy file, and is loaded on every prompt (not just per sub-agent
 * spawn). A default TycoonAgents install ships a ~2.3k-token CLAUDE.md;
 * these thresholds are set well above that so the shipped baseline reads
 * green with lots of headroom, and only flag files that are genuinely,
 * unusually large.
 */
export function gradeClaudeMd(tokens: number): BudgetGrade {
  if (tokens < 8000) return "ok";
  if (tokens < 16000) return "warn";
  return "high";
}

/**
 * Grade a single agent file: ok <2000, warn <4000, high >=4000.
 *
 * Agent definitions should stay small and focused — unlike CLAUDE.md they
 * only load per sub-agent spawn, and each one should describe a narrow
 * role, not accumulate a knowledge base. A few thousand tokens IS worth
 * flagging here. A legitimately large REFERENCE/knowledge agent (e.g. a
 * domain-expert agent with a big fact table) is a valid exception to that
 * norm, not a bug — shipped reference agents like uefn-auditor.md
 * (~5.8k) and verse-expert.md (~5.4k) will grade "high" under this scale,
 * and that's intended: the Settings UI labels warn/high agent rows as
 * "(large — reference agents can be intentionally large)" so it reads as
 * information, not as a defect.
 */
export function gradeAgent(tokens: number): BudgetGrade {
  if (tokens < 2000) return "ok";
  if (tokens < 4000) return "warn";
  return "high";
}

/** Compute the full ContextBudget from raw file contents. Defensive — never throws. */
export function buildContextBudget(
  claudeMdContent: string | null,
  agents: Array<{ name: string; content: string }>,
  catalog: PackAgent[] = ALL_CATALOG_AGENTS
): ContextBudget {
  let claudeMd: BudgetFile | null = null;
  if (claudeMdContent !== null) {
    const tokens = estimateTokens(claudeMdContent);
    claudeMd = { name: "CLAUDE.md", tokens, grade: gradeClaudeMd(tokens) };
  }

  const agentFiles: BudgetFile[] = (agents ?? []).map((a) => {
    const tokens = estimateTokens(a.content ?? "");
    return { name: a.name, tokens, grade: gradeAgent(tokens) };
  });

  const perPromptTokens = claudeMd ? claudeMd.tokens : 0;
  const agentsTotalTokens = agentFiles.reduce((sum, f) => sum + f.tokens, 0);

  let overall: BudgetGrade = "ok";
  if (claudeMd) {
    overall = claudeMd.grade;
  } else if (agentFiles.length > 0) {
    const grades: BudgetGrade[] = ["ok", "warn", "high"];
    let worst = 0;
    for (const f of agentFiles) {
      const idx = grades.indexOf(f.grade);
      if (idx > worst) worst = idx;
    }
    overall = grades[worst];
  }

  const userClaudeMdTokens =
    claudeMdContent !== null ? estimateTokens(stripManagedBlocks(claudeMdContent).trim()) : 0;
  let agentAdditionTokens = 0;
  for (const a of agents ?? []) {
    const content = a.content ?? "";
    if (!agentMarkdownHasTycoonMarker(content)) continue;
    const def = catalog.find((c) => `${c.id}.md` === a.name);
    if (!def) continue;
    const m = /^\s*tycoon_pack\s*:\s*(\S+)\s*$/m.exec(content);
    // Compare BODIES only: frontmatter (model, backend, disallowedTools,
    // tycoon_pack, routing-generated keys) is TycoonAgents-managed.
    const expected = estimateTokens(agentBody(buildAgentMarkdown(def, m ? m[1] : undefined)));
    // Per file: the largest single-file excess counts, not the sum.
    agentAdditionTokens = Math.max(agentAdditionTokens, estimateTokens(agentBody(content)) - expected);
  }
  const enabled =
    userClaudeMdTokens > TRIM_REVIEW_THRESHOLDS.userClaudeMdTokens ||
    perPromptTokens > TRIM_REVIEW_THRESHOLDS.perPromptTokens ||
    agentAdditionTokens > TRIM_REVIEW_THRESHOLDS.agentAdditionTokens;
  const trimReview: TrimReview = {
    enabled,
    tip: enabled
      ? "Copies a prompt asking Claude to propose trims to your own additions for your approval. TycoonAgents' managed blocks and delegation language are left untouched."
      : TRIM_REVIEW_DISABLED_TIP,
    userClaudeMdTokens,
    agentAdditionTokens,
    prompt: TRIM_REVIEW_PROMPT,
  };

  return { claudeMd, agents: agentFiles, perPromptTokens, agentsTotalTokens, overall, trimReview };
}
