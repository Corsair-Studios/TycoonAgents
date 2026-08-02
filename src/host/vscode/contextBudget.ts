/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

export type BudgetGrade = "ok" | "warn" | "high";

export interface BudgetFile {
  name: string;
  tokens: number;
  grade: BudgetGrade;
}

export interface ContextBudget {
  claudeMd: BudgetFile | null;      // null if no CLAUDE.md
  agents: BudgetFile[];
  perPromptTokens: number;          // = claudeMd tokens (loaded every prompt), 0 if none
  agentsTotalTokens: number;
  overall: BudgetGrade;             // = claudeMd grade if present, else worst agent grade, else "ok"
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
  agents: Array<{ name: string; content: string }>
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

  return { claudeMd, agents: agentFiles, perPromptTokens, agentsTotalTokens, overall };
}
