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

/** Grade CLAUDE.md: ok <2000, warn <4000, high >=4000. */
export function gradeClaudeMd(tokens: number): BudgetGrade {
  if (tokens < 2000) return "ok";
  if (tokens < 4000) return "warn";
  return "high";
}

/** Grade a single agent file: ok <800, warn <1500, high >=1500. */
export function gradeAgent(tokens: number): BudgetGrade {
  if (tokens < 800) return "ok";
  if (tokens < 1500) return "warn";
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
