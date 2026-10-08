/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Backend } from "../../core/agentBackend";

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
   * the change to the review agent (`reviewer`, or `uefn-auditor` on a UEFN
   * roster) for a correctness/quality pass.
   * Defaults to `true` when the key is absent from execution.json (on by
   * default) — see {@link readExecutionConfig}.
   */
  reviewEnabled?: boolean;
  /**
   * Optional "Session Journal" entry count: how many recent prompts the
   * `.claude/session-journal.json` rolling journal keeps. `0` means the feature is OFF; the default is `3`.
   * Valid range is an integer `0`-`5`; anything
   * else is coerced to `3` — see {@link readExecutionConfig}.
   */
  sessionJournalEntries?: number;
  /**
   * Optional "Project Plan" feature flag. NOTE: this is panel.ts's
   * `projectPlanEnabled` flag (see `readProjectPlanEnabled`/
   * `writeProjectPlanEnabled` there), stored in the SAME execution.json file
   * but read/written directly via raw JSON rather than through this typed
   * config — it is NOT part of `readExecutionConfig`/`writeExecutionConfig`'s
   * round-trip. It's declared here only as documentation of the shared file;
   * {@link renderDelegationDoctrine}'s `projectPlanEnabled` param is what
   * actually drives doctrine rendering, and panel.ts passes it in directly
   * via its own `readProjectPlanEnabled(root)` read.
   */
  projectPlanEnabled?: boolean;
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
  /**
   * Pre-formatted "Vendor / model" column value (e.g.
   * `Anthropic · anthropic/sonnet` or `OpenAI · openai/gpt-5.4-mini
   * (subscription)`) — see {@link formatVendorModelLabel}. Optional: a
   * caller supplying rows without backend info (or an older caller not yet
   * updated) gets the claude-native default label rendered instead, so
   * every row still shows a value.
   */
  vendorLabel?: string;
}

/**
 * Vendor display name for a backend's `vendor` field. Known vendors get a
 * proper-cased display name (`anthropic` -> `Anthropic`, `openai` ->
 * `OpenAI`); anything else is title-cased from the raw string so an unknown
 * future vendor still renders reasonably instead of blank.
 */
function vendorDisplayName(vendor: string): string {
  switch (vendor.toLowerCase()) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    default:
      return vendor.length > 0 ? vendor[0].toUpperCase() + vendor.slice(1) : vendor;
  }
}

/**
 * Format a resolved {@link Backend} (from
 * `parseAgentBackend(readAgentFrontmatter(agentFileText))`) into the
 * roster table's "Vendor / model" column value:
 * `<Vendor> · <vendor/model>` with a trailing `(subscription)` or `(local)`
 * cost-class marker — `(metered)` is the default and is omitted since it's
 * the common case for claude-native agents.
 *
 * Examples:
 * - claude-native, metered -> `Anthropic · anthropic/sonnet`
 * - openai-compatible, subscription -> `OpenAI · openai/gpt-5.4-mini (subscription)`
 */
export function formatVendorModelLabel(backend: Backend): string {
  const vendor = vendorDisplayName(backend.vendor);
  const suffix = backend.costModelClass === "metered" ? "" : ` (${backend.costModelClass})`;
  return `${vendor} · ${backend.model}${suffix}`;
}

/**
 * Fallback roster used when no project-specific agent list is supplied to
 * {@link renderDelegationDoctrine} (or the supplied list is empty) — e.g. a
 * bare/fresh install with no `.claude/agents` directory yet. Mirrors the
 * previous hardcoded table exactly so a bare install still gets sensible
 * defaults.
 */
const DEFAULT_VENDOR_LABEL = "Anthropic · anthropic/sonnet";

const DEFAULT_ROSTER_ROWS: DoctrineRosterAgent[] = [
  { id: "coding-specialist", taskTypes: "Implementation, editing, bug fixes, refactoring", vendorLabel: DEFAULT_VENDOR_LABEL },
  { id: "testing-specialist", taskTypes: "Test authoring, specs, coverage", vendorLabel: DEFAULT_VENDOR_LABEL },
  { id: "vscode-integration", taskTypes: "VS Code extension API, webview, panel, lifecycle", vendorLabel: DEFAULT_VENDOR_LABEL },
  { id: "ux-ui-designer", taskTypes: "Webview canvas scene, layout, CSS, animation", vendorLabel: DEFAULT_VENDOR_LABEL },
  { id: "workspace-monitor", taskTypes: "Agent lifecycle/event monitoring, hook-record mapping", vendorLabel: DEFAULT_VENDOR_LABEL },
  { id: "search-retrieval", taskTypes: "File searching, code lookup, grep/glob (runs on haiku)", vendorLabel: "Anthropic · anthropic/haiku" },
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
  const lines = rows.map((a) => `| ${a.id} | ${a.taskTypes} | ${a.vendorLabel ?? DEFAULT_VENDOR_LABEL} |`);
  return `## Specialist roster\n\n| Specialist | Task types | Vendor / model |\n| --- | --- | --- |\n${lines.join("\n")}`;
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

/**
 * Resolve the roster's review-pass agent id: `reviewer` when present, else
 * `uefn-auditor` when present AND `uefn` is true (the UEFN roster's "Verse
 * Auditor", which REPLACES `reviewer` on a UEFN project), else `undefined`
 * when neither applies. `uefn` defaults to `false` so a non-UEFN project
 * that merely has the UEFN pack installed does not get routed to
 * `uefn-auditor` for review. Mirrors {@link resolveEditId}'s pattern so
 * {@link renderReviewSection} never hardcodes `reviewer` regardless of what's
 * actually installed for this project.
 */
function resolveReviewId(rows: DoctrineRosterAgent[], uefn = false): string | undefined {
  const rowFor = (id: string) => rows.find((r) => r.id === id);
  return (rowFor("reviewer") ?? (uefn ? rowFor("uefn-auditor") : undefined))?.id;
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

### Narrow exceptions: a known-path read, and answering a quick question

The ONLY reads you may do directly are a SINGLE, specific, already-known
file path. Use this test: can you name the exact file path RIGHT NOW,
without searching to find it? If yes, read it. If you would have to grep,
glob, or scan a directory to locate it first, that is exploration — delegate
it to search-retrieval, which runs on Haiku, the cheapest model available.

Reading three or more files to answer one question is a survey, not a
lookup. Delegate it.

You may also ANSWER A ONE-OFF QUESTION directly. When the user asks
something you can settle in a sentence or two from one or two known files,
answer it — spawning a worker to fetch a single fact costs more than the
fact is worth, because you pay to write the brief and to spin the worker up,
and save nothing. Delegation is for WORK, not for ANSWERS. The moment a
question turns into a task — several files, a change, an audit, a
comparison — it stops being a quick question and gets delegated.

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
  orchestrator's model instead of the cheapest one (roughly 5x the
  per-token cost when the orchestrator is Opus — and more in practice,
  since the orchestrator re-reads its large accumulated context on every
  turn while a worker starts fresh) and hides the work from the
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

### PROPORTIONALITY

Delegation does not license scope creep. When the user names the exact
file(s) and the task is mechanical — copy, move, rename, or a small localized
edit — the assigned worker touches ONLY those named files: no greps beyond
them, no exploratory reads, no reference-catalog consultation, no codebase
surveys. Delegation still applies (the work still goes to the right
specialist), but the brief handed to that specialist must scope the task to
the named files, and finishing verification runs against the changed files
only — not the whole repo. Example: "Copy the retry logic from a.verse to
b.verse" means read those two files, make the edit, verify those two —
nothing else.

### The Fallback Rule

When a task does not clearly match any specialist's keywords, delegate it to
the Fallback Agent (Sonnet) — do NOT do it yourself on the orchestrator. The
Fallback Agent's presence in the work log is also a signal to refine keyword
routing, but in the meantime it still runs on a cheaper model than the
orchestrator's, so routing unmatched work there saves real
credits and keeps every task visible in the delegation visualization. Doing
unmatched work yourself — on the orchestrator's model, the most expensive one
you have configured — is the single most expensive mistake you can make
here.

Brief every delegated agent precisely:
- Exact file paths (not glob patterns)
- Key symbol names (functions, classes, variables relevant to the task)
- Decisions already made (architecture, patterns established, approaches
  ruled out)
- Success criteria (what "done" looks like)

Require every delegated agent to report back in under 250 words: what
changed (file:line), verification result, open issues.

A report must state its actual sample size or coverage limit whenever it
differs from what was asked — an honest smaller result is acceptable; an
overclaimed one is a failure.

A report opens with the outcome — what changed and whether it verified —
never with restated context or process narration. It stays plain prose plus
file:line: no headings, no decorative bullets, no flattery or
self-assessment adjectives, since every word lands in the orchestrator's
context at the most expensive model's price. Delegated work stays at the
scope the brief asked for — a worker that notices adjacent cleanup,
refactoring, or documentation work names it in one line under open issues
instead of doing it.

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
 * Renders a section clarifying WHO the doctrine's "you" refers to: the
 * ORCHESTRATOR, not a spawned sub-agent. Root-cause fix for recursive
 * delegation loops — every other section in this file addresses the
 * orchestrator with no signal telling a spawned worker it is a LEAF (that
 * leaf rule previously existed only in packCatalog.ts's
 * `WORKING_DISCIPLINE_BODY`, appended to generated agent files, never in this
 * CLAUDE.md doctrine). Two variants: DIRECT mode has no team-lead carve-out
 * (every spawned worker is unconditionally a leaf); TEAM_LEADS mode carves
 * out an explicitly-briefed team lead, whose own workers are the leaves.
 * Inserted immediately after the mode section (DIRECT_SECTION /
 * renderTeamLeadsSection) and before {@link VERIFICATION_SECTION} in
 * {@link renderDelegationDoctrine}.
 */
function renderWorkerLeafSection(mode: DelegationMode): string {
  if (mode === "team_leads") {
    return `## Who "you" means in this file — orchestrator and team leads

Every rule above is addressed to the ORCHESTRATOR, the top-level agent
talking to the user. If you were spawned as a sub-agent, the delegation
mandates above are not yours — UNLESS your brief explicitly designates you
a TEAM LEAD. Team leads may delegate to their own workers; their workers
are leaves. Scope rules still bind everyone: touch only what your brief
names.

If you are a spawned worker and NOT a designated team lead, you are a LEAF:

- Do the assigned task YOURSELF — reads, searches, greps, and edits — with
  your own tools. Do NOT spawn Task or sub-agents. There is no delegation
  below you.
- The "NEVER grep/read/edit yourself" rules above are the opposite of your
  job. Searching and editing directly is exactly what you were spawned to
  do, and doing it is correct, not a violation.
- Never end your turn reporting work as "running in the background" — finish
  it or report failure.
- If the assigned work genuinely cannot finish inside one tool call, split
  it into bounded sequential calls run to completion in THIS SAME turn —
  using the harness's own chunking knobs (sample-size env vars, batch
  flags) and an explicit per-call timeout (the Bash tool accepts up to 10
  minutes). Ending the turn to "wait", or spawning a helper to do it, are
  both violations; chunking in-turn is the only sanctioned move.
- Never delete a temp or evidence file until, in this same turn, you have
  verified ON DISK that its durable destination (a doc comment, a report
  file, a commit) already holds the data it captured.
- Open your report with the outcome — what changed and whether it
  verified. Never start with restated context, process narration, or
  throat-clearing.
- Keep your report plain prose plus file:line: no headings, no
  bullet-theater, no flattery or self-assessment adjectives. Every word
  costs orchestrator context at the most expensive model's price — spend
  it on substance only.
- Deliver exactly what the brief asked, at the scope it asked. Do not
  widen into cleanup, refactoring, documentation, or adjacent features —
  name anything adjacent worth doing in one line under open issues instead
  of doing it.

A worker that delegates instead of working creates a chain of agents that
each wait on the next, burning tokens while nothing gets done. If a
Task-tool prompt spawned you and no brief made you a team lead, you are not
an orchestrator. Do the work.`;
  }
  return `## Who "you" means in this file — orchestrator only

Every rule above is addressed to the ORCHESTRATOR, the top-level agent
talking to the user. If you were spawned as a sub-agent — a specialist, a
worker, an Explore agent, anything launched via the Task tool — the
delegation mandates above are not yours. Scope rules still bind you: touch
only what your brief names.

If you are a spawned worker, you are a LEAF:

- Do the assigned task YOURSELF — reads, searches, greps, and edits — with
  your own tools. Do NOT spawn Task or sub-agents. There is no delegation
  below you.
- The "NEVER grep/read/edit yourself" rules above are the opposite of your
  job. Searching and editing directly is exactly what you were spawned to
  do, and doing it is correct, not a violation.
- Never end your turn reporting work as "running in the background" — finish
  it or report failure.
- If the assigned work genuinely cannot finish inside one tool call, split
  it into bounded sequential calls run to completion in THIS SAME turn —
  using the harness's own chunking knobs (sample-size env vars, batch
  flags) and an explicit per-call timeout (the Bash tool accepts up to 10
  minutes). Ending the turn to "wait", or spawning a helper to do it, are
  both violations; chunking in-turn is the only sanctioned move.
- Never delete a temp or evidence file until, in this same turn, you have
  verified ON DISK that its durable destination (a doc comment, a report
  file, a commit) already holds the data it captured.
- Open your report with the outcome — what changed and whether it
  verified. Never start with restated context, process narration, or
  throat-clearing.
- Keep your report plain prose plus file:line: no headings, no
  bullet-theater, no flattery or self-assessment adjectives. Every word
  costs orchestrator context at the most expensive model's price — spend
  it on substance only.
- Deliver exactly what the brief asked, at the scope it asked. Do not
  widen into cleanup, refactoring, documentation, or adjacent features —
  name anything adjacent worth doing in one line under open issues instead
  of doing it.

A worker that delegates instead of working creates a chain of agents that
each wait on the next, burning tokens while nothing gets done. If a
Task-tool prompt spawned you, you are not the orchestrator. Do the work.`;
}

/**
 * Optional "Review pass" framing (composes with either base mode — appended
 * regardless of whether the orchestrator is briefing workers directly or
 * routing through team leads). A SINGLE review gate: one round of
 * review-requested fixes, never an unbounded approve/reject loop. A function
 * (not a static string) so the review-agent references can name the
 * project's actual review target (`reviewer` or, on a UEFN roster,
 * `uefn-auditor`) instead of hardcoding `reviewer` regardless of what's
 * actually installed — mirrors {@link renderTeamLeadsSection}'s use of
 * {@link resolveEditId}.
 *
 * `reviewAgentId`, when supplied, wins outright — it's the caller's
 * (panel.ts's) direct read of the FULL installed agent set, computed BEFORE
 * `_buildDoctrineRoster`'s tier-based exclusion strips `reviewer`/lead rows
 * out of `rosterAgents` (that exclusion is intentional: those agents get
 * their own doctrine sections rather than a "delegate to X" roster row, but
 * it also means `rosterAgents` alone can never prove `reviewer` is
 * installed). When `reviewAgentId` is omitted (e.g. a caller with no better
 * source, or a unit test), this falls back to {@link resolveReviewId} against
 * `rosterAgents` — which only ever succeeds for `uefn-auditor` in practice,
 * since `reviewer` is always tier-excluded from that same array. Absent
 * both, renders a generic "the review agent" phrase — never a hardcoded id
 * missing from the roster.
 *
 * NOTE: "The user is the final reviewer" refers to the HUMAN, not the
 * review agent, and is intentionally left untouched by this substitution.
 */
function renderReviewSection(
  rosterAgents: DoctrineRosterAgent[] | undefined,
  reviewAgentId?: string,
  uefn = false
): string {
  const reviewId = reviewAgentId ?? resolveReviewId(resolveRosterRows(rosterAgents), uefn);
  const reviewAgentPhrase = reviewId ? `the \`${reviewId}\` agent` : "the review agent";
  const reviewAgentPhraseCap = reviewId ? `The \`${reviewId}\` agent's` : "The review agent's";
  const reviewAgentPossessive = reviewId ? `the \`${reviewId}\` agent's` : "the review agent's";

  return `## Review pass (enabled)

Before the orchestrator reports a specialist's task as done, it routes the
change to ${reviewAgentPhrase} for a correctness and quality pass: read the
diff, check it against the task's intent and acceptance criteria, and flag
bugs, regressions, or quality issues.

If ${reviewAgentPhrase} requires changes, the orchestrator sends them back to the
original specialist to fix, then re-checks with ${reviewAgentPhrase} once more. This
is a single review gate, not an open-ended loop — after that one round of
fixes the orchestrator reports the outcome rather than cycling further. The
review stays a single pass, not a fan-out: if you are ${reviewAgentPhrase},
do not spawn further sub-agents. The orchestrator does not start the review
while writers touching the same files are still in flight.

${reviewAgentPhraseCap} pass is a quality assist, not a sign-off: it catches bugs and
regressions BEFORE the change reaches the user, so the human reviews cleaner
work. The user is the final reviewer — the orchestrator surfaces the
reviewed change for the user to approve and never treats ${reviewAgentPossessive}
pass as final acceptance.

### Review model tiering (added 2026-09-06)

The review pass above is unchanged. This subsection only fixes which model the orchestrator uses for each review call:

- First-pass review of a change that touches src/core, hosts (panel.ts, standalone/src/server.mjs), hooks/, scripts/, secrets or routing files, or anything security-relevant → the review agent on Sonnet.
- First-pass review of a change limited to CSS, labels, copy, docs, or tests → the review agent on Haiku.
- The single re-check after the one permitted round of fixes → a read-only Haiku pass (Explore) verifying the specific findings landed; it does not re-review the whole change.
- The orchestrator never skips the review pass because a change looks small; tiering changes the model, not whether the pass runs.`;
}

/**
 * Optional "Session Journal" framing (composes with either base mode and the
 * review pass — appended last). Mirrors {@link renderReviewSection}'s
 * on/off-by-value shape: {@link renderDelegationDoctrine} pushes this only
 * when the caller's `sessionJournalEntries` count is `> 0`, so a project that
 * has never enabled the feature (the default, `0`) never renders it.
 */
function renderSessionJournalSection(entries: number): string {
  return `## Session Journal

A rolling journal of the last ${entries} prompts is maintained at \`.claude/session-journal.json\`.

**At the start of each session:** read it to recover context from previous sessions.

**At the end of each response:** find the last entry whose \`summary\` is \`null\` and set it to 1-2 sentences (under 150 characters) describing what was accomplished.

The hook appends entries and trims to the last ${entries} automatically.`;
}

/**
 * Optional "Project Plan routing" framing (composes with either base mode —
 * appended when the caller's `projectPlanEnabled` is `true`; mirrors
 * {@link renderReviewSection}/{@link renderSessionJournalSection}'s
 * on/off-by-value shape). Fixes the bug where a large-feature/GDD/PRD
 * request got routed to the edit-target specialist as a doc-writing task
 * (via the PREAMBLE's general "any file edit or creation ... → specialist"
 * rule) and produced a free-form markdown plan nothing ever reads, instead
 * of a REGISTERED plan the panel can track. This section OVERRIDES that
 * general rule for plan-shaped requests — without an explicit override, the
 * preamble rule wins again and the bug returns.
 */
const PROJECT_PLAN_SECTION = `## Project Plan routing (feature enabled)

A request for a large multi-phase feature, a GDD, a PRD, a milestone/sprint/
delivery plan, or "plan this project" MUST go through the \`project-plan\`
skill, not a specialist. This OVERRIDES the general "any file edit or
creation, including docs and markdown → specialist" rule above for
plan-shaped requests — the plan skill takes precedence, or that rule wins
again and reproduces this exact bug.

Writing a free-form markdown plan (e.g. \`docs/project-plan.md\`) does NOT
create a plan: the panel never reads it, no phases or gates exist, and no
human checkpoints fire.

The \`project-plan\` skill decomposes work into a REGISTERED plan at
\`.claude/tycoon/plan.json\`, with phases, tasks, and human gates the panel
tracks. When a design doc is involved, the \`design-doc\` skill's
milestone-plan template is written to be consumed by \`project-plan\`:
produce or locate the design doc first, then decompose it into plan.json via
the skill — never hand-write plan.json.

Resuming: if \`.claude/tycoon/plan.json\` already exists, re-read it and
continue from its recorded position — do not re-decompose an existing plan
unless the user explicitly asks to re-plan.`;

/**
 * Orchestrator-side verification discipline, always included in the doctrine
 * (independent of the review gate). Mitigates a Claude Code Task-tool
 * limitation: sub-agents don't block on nested children and can return
 * premature "running in the background" narration with no writes,
 * task-notifications aren't de-duplicated, and there is no file locking
 * between an original and a resumed sub-agent editing the same file.
 */
const VERIFICATION_SECTION = `## A "completed" notification is not proof — verify on disk

A sub-agent reporting done — or "running in the background", or narration with
no concrete file:line changes — does NOT mean the work landed. Before recording
a task as done, the orchestrator READS the changed files on disk itself; if
nothing changed, it treats the task as failed and re-dispatches it.

The orchestrator re-reads a file from disk immediately before verifying or
building on it — a resumed or background sub-agent may have edited it after its
first report, so cached content can be stale. File ownership stays DISJOINT
across concurrent workers (the harness does not lock files); the orchestrator
never runs two writers on the same file at once.

Before re-dispatching a task a previous agent failed, kill any processes that
agent left running (process trees, stale PID files) — a superseded lineage
must never keep writing into shared files after its replacement starts. After
any denied or abandoned spawn, treat the task as NOT done regardless of what
the agent's report claimed.`;

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
 *
 * `reviewAgentId` (optional) is the caller's direct read of which review
 * agent is actually installed (`reviewer` or `uefn-auditor`) — see
 * {@link renderReviewSection}'s doc comment for why this can't reliably be
 * derived from `rosterAgents` alone (that array has `reviewer` tier-excluded
 * by `panel.ts`'s `_buildDoctrineRoster`). Only affects output when
 * `reviewEnabled` is true; ignored otherwise.
 *
 * `sessionJournalEntries` (default `3`, matching execution.json's default;
 * `0` = OFF) appends {@link renderSessionJournalSection} last, only when `> 0`.
 *
 * `projectPlanEnabled` (default `false`, matching a fresh/never-toggled read
 * of panel.ts's `projectPlanEnabled` flag as `false`) appends
 * {@link PROJECT_PLAN_SECTION} — after the review/session-journal sections,
 * same append-last shape — only when `true`. NOTE: unlike `reviewEnabled`
 * and `sessionJournalEntries`, this flag is NOT part of `ExecutionConfig`'s
 * own default (panel.ts seeds `projectPlanEnabled` ON for fresh installs via
 * `seedProjectPlanEnabledDefault`, a decision made at the panel layer, not
 * here) — callers must read panel.ts's actual on-disk value and pass it in
 * explicitly rather than relying on this function's own default.
 *
 * `uefn` (default `false`) is passed through to {@link renderReviewSection}
 * / {@link resolveReviewId} and only matters when `reviewAgentId` is
 * omitted: it gates whether an installed `uefn-auditor` may be used as the
 * review-pass fallback, so a non-UEFN project that merely has the UEFN pack
 * installed does not get routed to Verse Auditor for review.
 */
export function renderDelegationDoctrine(
  mode: DelegationMode,
  reviewEnabled = true,
  rosterAgents?: DoctrineRosterAgent[],
  reviewAgentId?: string,
  sessionJournalEntries = 3,
  projectPlanEnabled = false,
  uefn = false
): string {
  const modeSection = mode === "team_leads" ? renderTeamLeadsSection(rosterAgents) : DIRECT_SECTION;
  const parts = [
    renderPreamble(rosterAgents),
    renderRosterTable(rosterAgents),
    modeSection,
    renderWorkerLeafSection(mode),
    VERIFICATION_SECTION,
  ];
  if (reviewEnabled) {
    parts.push(renderReviewSection(rosterAgents, reviewAgentId, uefn));
  }
  if (sessionJournalEntries > 0) {
    parts.push(renderSessionJournalSection(sessionJournalEntries));
  }
  if (projectPlanEnabled) {
    parts.push(PROJECT_PLAN_SECTION);
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
const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = { delegation_mode: "flat", reviewEnabled: true, sessionJournalEntries: 3 };

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
        sessionJournalEntries:
          typeof parsed.sessionJournalEntries === "number" &&
          Number.isInteger(parsed.sessionJournalEntries) &&
          parsed.sessionJournalEntries >= 0 &&
          parsed.sessionJournalEntries <= 5
            ? parsed.sessionJournalEntries
            : 3,
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
