---
name: tycoon-diagnose
description: >
  Deep, AI-reasoned diagnosis of this project's own TycoonAgents / Claude Code
  configuration — CLAUDE.md managed blocks, .claude/agents/*.md consistency,
  keyword routing, MCP servers, and hooks — producing a sanitized Markdown
  report the user can review and send to the TycoonAgents maintainer. Use when
  the user runs /tycoon-diagnose, or asks to "diagnose my tycoon config",
  "check my Claude Code config", "audit my agents", or "why isn't delegation
  working".
---

# Tycoon Diagnose

A deep, reasoned audit of **this project's own** generated Claude Code
configuration — the files TycoonAgents (and any other generator) has written
into `CLAUDE.md`, `.claude/agents/`, and related config. It finds
inconsistencies, dangling references, duplication, and mis-fit templates, and
writes them up as a Markdown report: a TL;DR, then per-finding sections
(severity, `file:line` evidence, root cause, recommended fix), a
verified-good section for anything checked and found consistent, and a
closing priority-summary table (see Step 4 for the exact structure).

**This is not the same thing as the in-app diagnostic button** in the
TycoonAgents panel. That button runs deterministic, non-AI checks inside the
extension itself (which makes zero runtime AI calls, by design). This skill
is the deep-reasoning companion: it runs entirely inside *your* Claude Code
session, reads your files, and reasons about them the way a careful human
reviewer would. It makes no network calls and sends nothing anywhere — it
only writes a local report file for you to read and decide whether to share.

## Step 0 — Detect project type

Before judging whether config fits the project, know what the project is.
Check for (existence is enough, don't parse contents):

- `**/*.verse`, `*.uproject`, `*.uefnproject` → UEFN / Verse project
- `**/*.gd`, `project.godot` → Godot project
- `**/*.cs` + `*.csproj`/`*.sln` with Unity-style folders → Unity project
- `package.json` with a `src/`, `**/*.tsx`, `**/*.css` layout → web/TS project
- more than one of the above can be true (e.g. a web-based tool alongside a
  UEFN project) — note all that apply, don't force a single label

Keep this classification in mind for Step 1's coding-standards check.

## Step 1 — Read and analyze CLAUDE.md

Read the project's `CLAUDE.md` in full, with line numbers, and check for:

1. **Legacy or foreign managed blocks.** Search for any
   `<!-- <ns>:begin ... --> ... <!-- <ns>:end -->`-style marker pair whose
   namespace isn't `tycoon`. Each one is either legacy config carried over
   from a prior setup (another Claude Code project's generator, or a
   previous plugin entirely) or a currently-installed other tool's own
   managed block — flag it as a **legacy/foreign block worth reviewing for
   removal**. TycoonAgents' own managed markers are
   `<!-- tycoon:delegation -->` / `<!-- /tycoon:delegation -->` and
   `<!-- tycoon:coderules -->` / `<!-- /tycoon:coderules -->` — a
   non-`tycoon` block surviving alongside (or instead of) those means either
   a migration didn't run cleanly on this machine/checkout, or another tool
   is actively writing into this same CLAUDE.md. Note which namespace(s) are
   present and whether their content contradicts each other (e.g. two
   different delegation rosters).
2. **Duplicated delegation rules.** Look for the same rule or sentence
   appearing more than once — inside `CLAUDE.md` alone, and across
   `CLAUDE.md` + `.claude/agents/*.md`. Known repeat offenders to check by
   name: the "~40x cheaper" claim, the "NEVER use Grep or Glob directly"
   rule, and the "What You Can/Cannot Do Directly" bullet lists. Record every
   occurrence with its file and line number. Distinguish *load-bearing*
   repetition (the same mandatory rule reinforced inside a single block,
   which is fine and should stay) from *incidental* duplication (two
   generators independently restating the same rule in different blocks,
   which is bloat).
3. **Dangling agent references.** Collect every agent id/name mentioned in
   any routing table or delegation prose in `CLAUDE.md` (e.g. a "Specialist
   roster" table's left column). For each one, check whether
   `.claude/agents/<name>.md` exists. List every reference with **no**
   matching file — these are routing targets that can never resolve.
4. **Garbled or empty template output.** Look for: section headers
   (`## ...`) immediately followed by another header or EOF with no body
   text between them (an unfilled template section); bullets that mix a
   first-person role description with a delegation instruction in one line,
   or nest bold markers incorrectly (`**...**...**`) — a sign a template
   variable got substituted into the wrong slot.
5. **Off-domain coding-standards table.** If a coding-standards table (rows
   keyed by path pattern, e.g. `src/game/**`, `**/*.tsx`, `**/*.css`,
   `package.json`, `tsconfig*.json`) exists in a `tycoon:coderules`-style
   block, cross-check its path patterns against Step 0's project type. Flag
   rows whose patterns don't match anything that exists in this project
   (e.g. a `**/*.tsx` row in a UEFN/Verse-only project), and note whether any
   row IS relevant (e.g. a Verse/GDScript row) so the finding is precise
   about what's dead weight vs. what fits.

## Step 2 — Enumerate `.claude/agents/*.md`

For every agent file found:

- `fileId` = filename without `.md`
- Parse the first `# H1` heading
- Parse any explicit id/name in frontmatter or body (if the file declares one
  separately from its filename)
- Check membership in `.claude/tycoon/agent-keywords.json` (if present) —
  does a key match `fileId`?

Flag, per agent, any of:

- **filename / H1 / referenced-id / keyword-map-key mismatch** — the classic
  failure mode is a file like `uefn-auditor.md` whose H1 reads
  `# Verse Auditor` while other files reference it as `verse-auditor`; all
  four of {filename, H1, references elsewhere, keyword-map key} should agree
  on one id.
- **no routing keywords** — an agent with no entry (or an empty entry) in
  `agent-keywords.json`, meaning keyword-based delegation can never select
  it.
- **referenced nowhere** — an agent file that exists but isn't mentioned in
  any routing table in `CLAUDE.md` (may be intentional, e.g. a fallback or
  coordinator role — note it, don't assume it's a bug).
- **missing `## Report Format` section** (p21-t8) — check whether the file
  contains a heading matching `## Report Format` (case-insensitive,
  whitespace-tolerant). If none is present, flag the file by name in this
  finding. This is a **read-only check**: never add, edit, or reword this
  section in any agent file — list the file names that lack it in the
  sanitized report and let the user (or a coding-specialist task they
  approve) add it. List every offending filename; don't just count them.
  A deterministic helper for this specific check, `findAgentsMissingReportFormat`
  in `checkReportFormat.mjs` (same directory as this file), is available if
  you want to run it instead of eyeballing headings — it only reads files
  and returns filenames, it never writes.

Do **not** flag large agent files as bloat by size alone — a big file that
carries genuine reference/domain knowledge (API syntax, error catalogs,
engine-specific patterns) is legitimately large and length there is
justified. Only flag duplication *within* such a file (e.g. a summary table
that restates, verbatim, content explained in full later in the same file).

## Step 3 — Inspect supporting config

- **`.claude/tycoon/agent-keywords.json`** — valid JSON? Do its keys map 1:1
  onto the agent files from Step 2 (no keys for agents that don't exist, no
  agents missing a key)?
  **Every `pattern` must be a pipe-separated list of single words (`word|word`).
  Markdown (`**Primary:**`) and prose segments are ignored by hooks, and multi-word
  segments never match.** Report any pattern that is empty, not a string, or
  contains markdown/prose as a CRITICAL routing issue.
- **Deliberate wording, do not flag:** the "Fallback Agent" wording in the managed
  delegation block is intentional and maps to `fallback_agent` in
  `agent-keywords.json` (displayed as Wildcard Agent). The "Coding standards by
  path" rows are documented starting defaults, not context-fit problems; at most
  mention once that they can be tuned. Never trim delegation language.
- **`.mcp.json`** (workspace root) — list configured servers. If a
  `powertools`, `uefn-bridge` (or `uefn`) entry exists, check for a stray `env` block (a
  known legacy misconfiguration pointed servers at a directory the Python
  bridge never wrote to — see the `uefn-bridge` skill's install notes).
  Report server names only; never print token/secret values found in this
  file (see Step 4).
- **`.claude/settings.local.json`** — confirm the hooks TycoonAgents relies
  on are present and wired (session-journal writer, agent-activity logger,
  team-idle/completion hooks per `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`).
  Note any hook entry that references a script path that doesn't exist on
  disk.

## Step 4 — Produce the report

Write a single Markdown report, structured like this: a TL;DR, an
Environment summary, one section per finding (title, severity, `file:line`
evidence, root cause, recommended fix), a verified-good section, and a
closing priority-summary table.

```
# TycoonAgents Config Diagnosis — <project name>

**For:** TycoonAgents maintainer
**From:** A project using TycoonAgents
**Subject:** One-line summary of the overall config health.

## TL;DR
- 3-6 bullets, most severe first.

## Environment
- Detected project type(s) (Step 0)
- Managed markers found in CLAUDE.md, with line numbers
- Files enumerated (agent count, keyword-map presence, mcp servers found)

## Finding 1 — <title> (SEVERITY)
Evidence (file:line, quoted snippet), root cause, impact, recommended fix.

## Finding 2 — ...
...

## Verified-good (no action needed)
- Anything checked and found consistent — say so explicitly, don't only
  report problems.

## Priority summary

| # | Finding | Severity | Root cause |
|---|---------|----------|------------|
| 1 | ... | CRITICAL/DESIGN/BLOAT/QUALITY/CONTEXT FIT | ... |
```

Use severities consistently: **CRITICAL** (breaks delegation/routing),
**DESIGN** (works but is structurally wrong, e.g. hardcoded roster),
**BLOAT** (redundant content, no functional break), **QUALITY** (cosmetic —
garbled text, empty sections), **CONTEXT FIT** (correct in general, wrong for
this project type). Every finding needs at least one `file:line` anchor —
don't assert a problem you can't point to.

If Steps 1-3 found nothing wrong in a category, say so under
"Verified-good" rather than omitting the section — an empty report section
is itself useful signal that the config is healthy there.

## Step 5 — Sanitize before writing

The report leaves the user's control only if *they* choose to share it, so
scrub it as you write:

- **No absolute filesystem paths.** Replace them with `${PROJECT_ROOT}`-style
  or `~`-relative paths in every evidence snippet and file reference.
- **No secrets.** Never copy an API key, token, or credential value into the
  report. If `.mcp.json`, `.claude/settings.local.json`, or any config file
  contains a field that looks like a secret (`apiKey`, `token`, `Authorization`,
  a long opaque string), report only that the field **exists** (e.g. "`env.OPENAI_API_KEY`
  is set") — never its value, and never quote surrounding context that might
  leak it.
- **Do not open `.env` files or any file whose name implies credentials.**
  If one exists, note its presence and exclusion, nothing more.

## Step 6 — Save and hand off

1. Ensure `.claude/tycoon/` exists (create if missing).
2. Write the finished report to `.claude/tycoon/tycoon-diagnose-report.md`,
   overwriting any previous run.
3. Tell the user, explicitly, in chat:
   - The report was written locally to `.claude/tycoon/tycoon-diagnose-report.md`
     and nothing was sent anywhere — this skill makes no network calls.
   - **They should review it before sharing it with anyone** (maintainer,
     issue tracker, teammate) — re-check that no path or secret slipped
     through the sanitization pass, since the model doing the writing can
     miss things a second pair of eyes won't.
   - If they want it filed as an issue or sent somewhere, that is a
     deliberate action *they* take (e.g. pasting it into a GitHub issue) —
     this skill does not do that for them.

## Non-goals

- Never edits `CLAUDE.md`, `.claude/agents/*.md`, or any other config file —
  this is a read-only diagnostic. If the user wants fixes applied after
  reading the report, that's a separate, explicit follow-up request.
- Never makes a network call, never auto-files an issue, never emails or
  posts the report anywhere.
- Not a replacement for the in-app deterministic diagnostic button — treat
  the two as complementary: the button catches structural/schema breakage
  fast without a model call; this skill catches the subtler judgment calls
  (does this table fit this project, is this bullet garbled, is this roster
  internally consistent).
