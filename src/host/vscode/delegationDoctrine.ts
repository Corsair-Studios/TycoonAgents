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
 * One row of the "Specialist roster" table: a real delegation target for
 * this project. `id` MUST be the agent's FILE id (the `.claude/agents/<id>.md`
 * basename minus extension) — that's the only string the Task tool can
 * actually route to, so a roster row keyed on anything else would be a
 * dangling reference — a roster row naming an agent with no corresponding
 * file on disk, which can never resolve when the orchestrator tries to
 * delegate to it.
 */
export interface DoctrineRosterAgent {
  id: string;
  /** Task-routing description shown in the "Task types" column. */
  taskTypes: string;
}

/**
 * Fallback roster used when no project-specific agent list is supplied to
 * {@link renderDelegationDoctrine} (or the supplied list is empty) — e.g. a
 * bare/fresh install with no `.claude/agents` directory yet. Mirrors the
 * previous hardcoded table exactly so a bare install still gets sensible
 * defaults.
 */
const DEFAULT_ROSTER_ROWS: DoctrineRosterAgent[] = [
  { id: "coding-specialist", taskTypes: "Implementation, editing, bug fixes, refactoring" },
  { id: "testing-specialist", taskTypes: "Test authoring, specs, coverage" },
  { id: "vscode-integration", taskTypes: "VS Code extension API, webview, panel, lifecycle" },
  { id: "ux-ui-designer", taskTypes: "Webview canvas scene, layout, CSS, animation" },
  { id: "workspace-monitor", taskTypes: "Agent lifecycle/event monitoring, hook-record mapping" },
  { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob (runs on haiku)" },
];

/**
 * Resolve the effective roster rows for a render call: the caller-supplied
 * `agents` when non-empty, else {@link DEFAULT_ROSTER_ROWS}. Shared by
 * {@link renderRosterTable} (the visible table) and {@link renderPreamble}
 * (which names specific agents in prose) so both always agree on which ids
 * actually exist for this render — never naming an agent in prose that the
 * table itself doesn't list.
 */
function resolveRosterRows(agents: DoctrineRosterAgent[] | undefined): DoctrineRosterAgent[] {
  return agents !== undefined && agents.length > 0 ? agents : DEFAULT_ROSTER_ROWS;
}

/**
 * Render the "Specialist roster" table body. Pure — the caller (panel.ts's
 * `_buildDoctrineRoster`) is responsible for reading `.claude/agents/*.md`
 * and `.claude/tycoon/agent-keywords.json` off disk and supplying the
 * resolved `agents` list; this function never touches fs/vscode. Falls back
 * to {@link DEFAULT_ROSTER_ROWS} when `agents` is undefined or empty.
 */
function renderRosterTable(agents: DoctrineRosterAgent[] | undefined): string {
  const rows = resolveRosterRows(agents);
  const lines = rows.map((a) => `| ${a.id} | ${a.taskTypes} |`);
  return `## Specialist roster\n\n| Specialist | Task types |\n| --- | --- |\n${lines.join("\n")}`;
}

/**
 * Render the PREAMBLE shared by both delegation modes: a hard, non-optional
 * NEVER/ALWAYS mandate against direct edits and direct multi-file
 * exploration, a narrow one-file-lookup read exception, a MANDATORY
 * DELEGATION RULES checklist, the Fallback Rule (route keyword-unmatched
 * work to the Fallback Agent instead of doing it on the orchestrator),
 * briefing requirements, a 250-word report cap, and the
 * never-self-certified verification rule.
 *
 * `rosterAgents` is threaded through from {@link renderDelegationDoctrine}
 * so this text can never name an agent id absent from this render's actual
 * roster (the same dangling-reference hazard {@link DoctrineRosterAgent}'s
 * doc comment describes): `coding-specialist` and the
 * testing/ux/vscode/workspace specialists are only named by id when
 * {@link resolveRosterRows} shows them actually present — anything absent
 * falls back to a generic phrase pointing at the roster table below instead.
 * The edit/implementation target specifically resolves to `coding-specialist`
 * when present, else `verse-expert` when present (a UEFN roster withholds
 * `coding-specialist` and installs `verse-expert` as its Verse-writing
 * implementer instead — see `workerAgentsForProject`/`UEFN_CONFLICT_AGENT_IDS`
 * in `./packCatalog`), else the generic phrase when neither is present.
 * `search-retrieval` is the one specialist id always named directly: it is
 * installed for every project type (see `workerAgentsForProject` in
 * `./packCatalog`), so naming it can never dangle.
 */
/**
 * Resolve the roster's edit/implementation target id: `coding-specialist`
 * when present, else `verse-expert` when present (the UEFN roster's
 * Verse-writing implementer, which REPLACES coding-specialist on a UEFN
 * project), else `undefined` when neither is installed. Shared by
 * {@link renderPreamble} and {@link renderTeamLeadsSection} so both name the
 * same agent (or fall back to the same generic phrasing) instead of one of
 * them independently hardcoding `coding-specialist`.
 */
function resolveEditId(rows: DoctrineRosterAgent[]): string | undefined {
  const rowFor = (id: string) => rows.find((r) => r.id === id);
  return (rowFor("coding-specialist") ?? rowFor("verse-expert"))?.id;
}

function renderPreamble(rosterAgents: DoctrineRosterAgent[] | undefined): string {
  const rows = resolveRosterRows(rosterAgents);
  const rowFor = (id: string) => rows.find((r) => r.id === id);

  const editId = resolveEditId(rows);
  const editTarget = editId ?? "the appropriate specialist (see the roster below)";

  const checklist: string[] = [];
  checklist.push(
    editId
      ? `Any file edit or creation, including docs and markdown → ${editId}.`
      : "Any file edit or creation, including docs and markdown → the appropriate specialist (see the roster below)."
  );
  checklist.push("Any search, grep, glob, or multi-file/exploratory read → search-retrieval (Haiku).");
  for (const id of ["testing-specialist", "ux-ui-designer", "vscode-integration", "workspace-monitor"]) {
    const row = rowFor(id);
    if (row) checklist.push(`${row.taskTypes} → ${row.id}.`);
  }
  checklist.push(
    "Anything that does not clearly match a specialist's keywords → the Fallback Agent, per the rule below — never yourself."
  );
  const checklistBody = checklist.map((line, i) => `${i + 1}. ${line}`).join("\n");

  return `## Delegation

Delegate implementation work to specialist agents via the Task tool rather
than doing it inline. Search tasks (file/code lookup, grep/glob) always go to
Explore agents running on the haiku model. This is MANDATORY, not a
preference — the orchestrator coordinates work, it does not do the work.

**NEVER Edit or Write files directly — ALWAYS delegate to ${editTarget}.**

**NEVER grep, glob, search, or read across multiple files to understand the
code yourself — ALWAYS delegate to search-retrieval (Haiku).**

### The one narrow exception: a trivial known-path read

The ONLY reads you may do directly are a SINGLE, specific, already-known
file path that is a one-second lookup — nothing to figure out, nothing to
correlate across files. Anything deeper — multiple files, understanding how
something works, auditing, exploring, or any read you'd have to stop and
think about — MUST go to search-retrieval instead. search-retrieval runs on
Haiku, the cheapest model available, so pushing even "quick" digging there
instead of doing it yourself is close to free by comparison.

Still explicitly fine to do directly: talking to the user, making
high-level architectural decisions, coordinating agents, and VERIFYING work
a specialist already finished.

### What you MUST NOT do yourself — delegate it

- Exploring, searching, reading across multiple files, auditing, or
  DESCRIBING the codebase (grep/glob, or reading several files to understand
  how the project works) — delegate to the search-retrieval agent (Explore,
  haiku). This applies EVEN WHEN the final deliverable is only documentation
  or markdown: understanding the code well enough to write about it is
  search/retrieval work. Doing it yourself runs that exploration on the
  expensive model (roughly 40x the cost) and hides the work from the
  visualization.
- Editing or creating files, including docs and markdown — delegate to the
  appropriate specialist.

"Reviewing your team's results" means VERIFYING a specialist's completed
work against the task — it does NOT mean exploring or reading the codebase
yourself. A request to describe, document, review, or audit a project
STARTS by delegating the exploration to search-retrieval; you synthesize
the findings afterward.

### MANDATORY DELEGATION RULES

You MUST delegate:

${checklistBody}

### The Fallback Rule

When a task does not clearly match any specialist's keywords, delegate it to
the Fallback Agent (Sonnet) — do NOT do it yourself on the orchestrator. The
Fallback Agent's presence in the work log is also a signal to refine keyword
routing, but in the meantime it still runs on a model roughly a fifth the
cost of the orchestrator's, so routing unmatched work there saves real
credits and keeps every task visible in the delegation visualization. Doing
unmatched work yourself — on the most expensive model in the system — is the
single most expensive mistake you can make here.

Brief every delegated agent precisely:
- Exact file paths (not glob patterns)
- Key symbol names (functions, classes, variables relevant to the task)
- Decisions already made (architecture, patterns established, approaches
  ruled out)
- Success criteria (what "done" looks like)

Require every delegated agent to report back in under 250 words: what
changed (file:line), verification result, open issues.

A change is always verified by someone other than the agent that authored
it, never self-certified by the agent that wrote it.

### When in doubt, delegate

Doing work directly runs it on the orchestrator's expensive model instead of
a cheap specialist, and hides the work from the delegation visualization —
defeating the point of the system either way. When in doubt, delegate.`;
}

/** Direct-mode specific framing: the orchestrator briefs workers itself. */
const DIRECT_SECTION = `## Direct delegation (current mode)

The orchestrator briefs specialist workers directly — there is no
intermediate layer between the orchestrator and the worker doing the task.`;

/**
 * Team-Leads-mode specific framing: large multi-feature work routes through
 * persistent lead agents that own decomposition, briefing, verification, and
 * upward reporting for their domain. A function (not a static string) so the
 * build-lead line can name the roster's actual edit/implementation target
 * (`coding-specialist` or, on a UEFN roster, `verse-expert`) via the same
 * {@link resolveEditId} resolution {@link renderPreamble} uses, instead of
 * hardcoding `coding-specialist` regardless of what's actually installed.
 */
function renderTeamLeadsSection(rosterAgents: DoctrineRosterAgent[] | undefined): string {
  const editId = resolveEditId(resolveRosterRows(rosterAgents));
  const buildLeadTarget = editId ?? "appropriate specialist (see the roster below)";
  return `## Team Leads delegation (current mode)

Everything in Direct delegation still applies. Additionally, for large
multi-feature work — roughly 3+ tasks in a domain — route through a team
lead instead of briefing workers directly:

- **build-lead** owns the ${buildLeadTarget}, ux-ui-designer, and
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
}

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
 *
 * `rosterAgents` (optional) supplies the project's ACTUAL delegation
 * targets for the "Specialist roster" table instead of the hardcoded
 * default (see {@link DEFAULT_ROSTER_ROWS}) — omit it, or pass `[]`, to get
 * the default roster. Also threaded into {@link renderPreamble} so the
 * PREAMBLE's prose never names an agent id absent from this same roster.
 */
export function renderDelegationDoctrine(
  mode: DelegationMode,
  reviewEnabled = true,
  rosterAgents?: DoctrineRosterAgent[]
): string {
  const modeSection = mode === "team_leads" ? renderTeamLeadsSection(rosterAgents) : DIRECT_SECTION;
  const parts = [renderPreamble(rosterAgents), renderRosterTable(rosterAgents), modeSection];
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
