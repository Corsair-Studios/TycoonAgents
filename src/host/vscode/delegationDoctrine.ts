/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The two supported delegation topologies (Team Lead Mode, Phase 1).
 * See docs/plan/team-lead-mode.md for the full design.
 */
export const DELEGATION_MODES = ["flat", "team_leads"] as const;

/** One of the values in {@link DELEGATION_MODES}. */
export type DelegationMode = (typeof DELEGATION_MODES)[number];

/** Shape of `.claude/tycoon/execution.json`. */
export interface ExecutionConfig {
  delegation_mode: DelegationMode;
  /**
   * Optional "Review pass" toggle (composes with either delegation_mode):
   * before the orchestrator reports a specialist's task as done, it routes
   * the change to the `reviewer` agent for a correctness/quality pass.
   * Defaults to `true` when the key is absent from execution.json (on by
   * default) — see {@link readExecutionConfig}.
   */
  reviewEnabled?: boolean;
}

/** Markers wrapping the managed delegation section inside a project's CLAUDE.md. */
export const DELEGATION_SECTION_START = "<!-- tycoon:delegation -->";
export const DELEGATION_SECTION_END = "<!-- /tycoon:delegation -->";

/**
 * Instructions shared by both delegation modes: delegate implementation via
 * the Task tool, route search to Explore/haiku agents, brief precisely, cap
 * reports at 250 words, and never let a change be verified by the agent that
 * authored it.
 */
const PREAMBLE = `## Delegation

Delegate implementation work to specialist agents via the Task tool rather
than doing it inline. Search tasks (file/code lookup, grep/glob) always go to
Explore agents running on the haiku model.

Brief every delegated agent precisely:
- Exact file paths (not glob patterns)
- Key symbol names (functions, classes, variables relevant to the task)
- Decisions already made (architecture, patterns established, approaches
  ruled out)
- Success criteria (what "done" looks like)

Require every delegated agent to report back in under 250 words: what
changed (file:line), verification result, open issues.

A change is always verified by someone other than the agent that authored
it, never self-certified by the agent that wrote it.`;

/** Specialist roster shared by both modes (see .claude/agents/*.md). */
const ROSTER_TABLE = `## Specialist roster

| Specialist | Task types |
| --- | --- |
| coding-specialist | Implementation, editing, bug fixes, refactoring |
| testing-specialist | Test authoring, specs, coverage |
| vscode-integration | VS Code extension API, webview, panel, lifecycle |
| ux-ui-designer | Webview canvas scene, layout, CSS, animation |
| workspace-monitor | Agent lifecycle/event monitoring, hook-record mapping |
| search-retrieval | File searching, code lookup, grep/glob (runs on haiku) |`;

/** Direct-mode specific framing: the orchestrator briefs workers itself. */
const DIRECT_SECTION = `## Direct delegation (current mode)

The orchestrator briefs specialist workers directly — there is no
intermediate layer between the orchestrator and the worker doing the task.`;

/**
 * Team-Leads-mode specific framing: large multi-feature work routes through
 * persistent lead agents that own decomposition, briefing, verification, and
 * upward reporting for their domain.
 */
const TEAM_LEADS_SECTION = `## Team Leads delegation (current mode)

Everything in Direct delegation still applies. Additionally, for large
multi-feature work — roughly 3+ tasks in a domain — route through a team
lead instead of briefing workers directly:

- **build-lead** owns the coding-specialist, ux-ui-designer, and
  vscode-integration workers.
- **quality-lead** owns the testing-specialist and workspace-monitor
  workers.
- **search-retrieval** stays direct and is never routed through a team lead.

A team lead decomposes its domain's work, briefs its workers, verifies their
results, and reports compressed results back up to the orchestrator.

Depth never exceeds orchestrator -> team lead -> worker. A team lead does
not spawn other team leads.

Task specs and interface contracts are written to docs/plan/*.md files
rather than left in conversation — team leads read and update those files
as the source of truth for their domain's work.

No team certifies its own work: verification of a domain's output is done
by a different lead or by the orchestrator, never by the team that produced
it.

Small tasks (below the roughly-3-task threshold) skip team leads entirely
and go straight from the orchestrator to the worker, same as Direct mode.`;

/**
 * Optional "Review pass" framing (composes with either base mode — appended
 * regardless of whether the orchestrator is briefing workers directly or
 * routing through team leads). A SINGLE review gate: one round of
 * reviewer-requested fixes, never an unbounded approve/reject loop.
 */
const REVIEW_SECTION = `## Review pass (enabled)

Before the orchestrator reports a specialist's task as done, it routes the
change to the \`reviewer\` agent for a correctness and quality pass: read the
diff, check it against the task's intent and acceptance criteria, and flag
bugs, regressions, or quality issues.

If the reviewer requires changes, the orchestrator sends them back to the
original specialist to fix, then re-checks with the reviewer once more. This
is a single review gate, not an open-ended loop — after that one round of
fixes the orchestrator reports the outcome rather than cycling further.

The reviewer's pass is a quality assist, not a sign-off: it catches bugs and
regressions BEFORE the change reaches the user, so the human reviews cleaner
work. The user is the final reviewer — the orchestrator surfaces the
reviewed change for the user to approve and never treats the reviewer
agent's pass as final acceptance.`;

/**
 * Render the CLAUDE.md section body for a delegation mode. Pure (no
 * fs/vscode access), so this is unit-testable. The returned string does NOT
 * include the `<!-- tycoon:delegation -->` markers — use
 * {@link upsertDelegationSection} to splice it into a CLAUDE.md.
 *
 * `reviewEnabled` (default `true`, matching execution.json's default)
 * composes with either mode: when true, {@link REVIEW_SECTION} is appended
 * after the mode-specific section; when false, it's omitted entirely.
 */
export function renderDelegationDoctrine(mode: DelegationMode, reviewEnabled = true): string {
  const modeSection = mode === "team_leads" ? TEAM_LEADS_SECTION : DIRECT_SECTION;
  const parts = [PREAMBLE, ROSTER_TABLE, modeSection];
  if (reviewEnabled) {
    parts.push(REVIEW_SECTION);
  }
  return parts.join("\n\n");
}

/**
 * Splice `sectionBody` into `existingContent` between the managed
 * `<!-- tycoon:delegation -->` / `<!-- /tycoon:delegation -->` markers.
 *
 * - `existingContent` null/empty -> produce a minimal new CLAUDE.md (a
 *   heading followed by the marked section).
 * - Markers already present -> replace ONLY the span between them
 *   (inclusive of the markers themselves); everything outside the span is
 *   preserved byte-for-byte.
 * - Content present but no markers -> append the marked section at the end,
 *   separated from existing content by a blank line. Existing content is
 *   preserved byte-for-byte.
 *
 * Idempotent: calling this twice with the same `sectionBody` on the result
 * of the first call produces an identical string. Pure (no fs/vscode
 * access).
 */
export function upsertDelegationSection(
  existingContent: string | null,
  sectionBody: string
): string {
  const body = sectionBody.replace(/\s+$/, "");
  const block = `${DELEGATION_SECTION_START}\n${body}\n${DELEGATION_SECTION_END}`;

  if (existingContent === null || existingContent.length === 0) {
    return `# Project Instructions\n\n${block}\n`;
  }

  const startIdx = existingContent.indexOf(DELEGATION_SECTION_START);
  const endIdx = existingContent.indexOf(DELEGATION_SECTION_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + DELEGATION_SECTION_END.length);
    return `${before}${block}${after}`;
  }

  // No markers found: append at the end, separated by exactly one blank line.
  const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
  return `${existingContent}${separator}${block}\n`;
}

/** Default execution config used when none has been written yet. */
const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = { delegation_mode: "flat", reviewEnabled: true };

/** Resolve the path to `<claudeDirPath>/tycoon/execution.json`. */
function executionConfigPath(claudeDirPath: string): string {
  return path.join(claudeDirPath, "tycoon", "execution.json");
}

/**
 * Read `.claude/tycoon/execution.json`. Tolerant of a missing file, a
 * missing directory, or invalid JSON — all of those fall back to the
 * default (`{ delegation_mode: "flat", reviewEnabled: true }`) rather than
 * throwing. Each field is resolved independently (not all-or-nothing): a
 * file that only ever had `reviewEnabled` written to it (e.g. via
 * `writeExecutionConfig(dir, { reviewEnabled: false })` before
 * `delegation_mode` was ever persisted) still reads back that value, with
 * `delegation_mode` falling back to `"flat"`.
 *
 * `reviewEnabled` defaults to `true` whenever the key is absent/non-boolean
 * on disk — the Review pass is on by default, so a project that has never
 * touched the toggle (or predates it) reads as enabled.
 */
export function readExecutionConfig(claudeDirPath: string): ExecutionConfig {
  try {
    const raw = fs.readFileSync(executionConfigPath(claudeDirPath), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return {
        delegation_mode: DELEGATION_MODES.includes(parsed.delegation_mode) ? parsed.delegation_mode : "flat",
        reviewEnabled: typeof parsed.reviewEnabled === "boolean" ? parsed.reviewEnabled : true,
      };
    }
  } catch {
    // Missing file, missing dir, invalid JSON, etc. -> use the default.
  }
  return { ...DEFAULT_EXECUTION_CONFIG };
}

/**
 * Write `.claude/tycoon/execution.json`, creating the `.claude/tycoon`
 * directory if it doesn't exist yet.
 *
 * NOTE: this file is shared with panel.ts's `projectPlanEnabled` flag (see
 * `writeProjectPlanEnabled`), so this performs a read-modify-write merge —
 * `config` is spread over whatever is already on disk — rather than
 * overwriting the whole file. A missing/unreadable/corrupt existing file is
 * treated as `{}`. `config` is a partial patch (e.g. `{ reviewEnabled }`
 * alone, without `delegation_mode`) so callers can update either field
 * independently without clobbering the other.
 */
export function writeExecutionConfig(
  claudeDirPath: string,
  config: Partial<ExecutionConfig>
): void {
  const configPath = executionConfigPath(claudeDirPath);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing file, missing dir, invalid JSON, etc. -> merge onto {}.
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...config }, null, 2));
}
