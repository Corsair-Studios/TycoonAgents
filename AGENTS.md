# AGENTS.md

<!-- TYCOON-MANAGED:START -->
# Project Instructions

## MANDATORY: Use Delegation for All Work

Delegate all implementation, searching, and exploration via the task tool (`@agent-name`) — direct tool use breaks the visualization and costs ~5x more per token on an Opus orchestrator (more in practice — the orchestrator re-reads its large context every turn).

### You MUST use the task tool (`@agent-name`) to delegate:

| Task Type | Delegate To | agent name | model | Keywords to Include |
|-----------|-------------|---------------|-------|---------------------|
| File searching, code lookup, grep/glob | search-retrieval | Explore | haiku | search, retrieval, find, look, where |
| Code implementation, editing, bug fixes, refactoring | coding-specialist | general-purpose | sonnet | implement, code, fix, bug, refactor, create |
| Test authoring, specs, coverage | testing-specialist | general-purpose | sonnet | test, spec, vitest, jest, coverage, unit |
| VS Code extension API, webview, panel, lifecycle | vscode-integration | general-purpose | sonnet | vscode, extension, webview, panel, lifecycle |
| Webview canvas scene, layout, CSS, animation | ux-ui-designer | general-purpose | sonnet | ux, ui, design, canvas, layout, css, animation |
| Agent lifecycle/event monitoring, hook-record mapping | workspace-monitor | general-purpose | sonnet | monitor, lifecycle, event, hook, activity, track |

> **Note:** Explicit agent names (e.g., `agent name: "coding-specialist"`) take priority over Claude built-in types for routing. When you use an explicit agent name, the task is routed directly to that agent regardless of keyword matching.

### What You Can Do Directly:
- Read a specific file (if you know the exact path)
- Communicate with the user
- Make high-level architectural decisions
- Coordinate between agents
- Review completed work

### What You MUST NOT Do Directly:
- **NEVER use Grep or Glob directly** - ALWAYS delegate to search-retrieval (uses Haiku, ~5x cheaper per token than Opus)
- **NEVER Edit or Write files directly** - delegate to coding-specialist
- **NEVER make multiple tool calls to explore the codebase** - delegate exploration tasks

## MANDATORY: Always Delegate Searches

**Searching is expensive.** Using Grep/Glob on Opus costs ~5x more per token than delegating to a search agent (which uses Haiku), and more in practice given the orchestrator's large context. This is not optional - you MUST delegate all file searches:

Always route searches through the task tool (`@agent-name`) to the Explore/haiku agent — never call Grep or Glob yourself.

Even for "quick" searches, delegate. The cost savings are significant and the overhead is minimal.

### What You MUST Delegate
- **You write clean, focused, tested code.** - delegate to coding-specialist
- **Search Retrieval tasks** - delegate to search-retrieval
- **You write and maintain tests for TycoonAgents (the `test/` suite, e.g** - delegate to testing-specialist
- **Ux Ui Designer tasks** - delegate to ux-ui-designer
- **Vscode Integration tasks** - delegate to vscode-integration
- **Workspace Monitor tasks** - delegate to workspace-monitor

### Why This Matters

Bypassing the task tool (`@agent-name`) means the visualization misses the agent and the work runs on Opus at ~5x the per-token cost (more in practice, since the orchestrator re-reads its large context every turn).

### Model & Cost Routing

- **Read-only verification → Haiku.** Any task that only reads/inspects (confirm a fix landed, check package or build output, re-audit, summarize a file) MUST use `agent name: "Explore"` with `model: "haiku"` — even when it isn't a "search". Reserve sonnet workers for tasks that write code or require judgment.
- **Implementation and creative work → Sonnet** via the delegation table above.

### Worker Report Caps

- Instruct every delegated agent to report back in **under 250 words**, structured as: what changed (with file:line), verification results, open issues.
- Verbose agent reports land in the orchestrator's context at Opus prices — request the summary length explicitly in every Task prompt.

### Team Patterns

- **Audit team** — repo scanner (Explore/haiku) ∥ artifact/package scanner (general-purpose/sonnet); merge findings afterward.
- **Feature team** — coding-specialist ∥ testing-specialist; define interface contract in BOTH prompts, keep file ownership disjoint (src/ vs tests/).
- **Release team** — packager (sonnet) builds, then verifier (Explore/haiku) independently inspects; never let the packager verify its own output.
- **Background agents** — run long builds/packaging via background tasks while a foreground agent continues other work.

## Before You Delegate

Subagents start cold — brief them precisely. Include:
- **Exact file paths** (not glob patterns)
- **Key symbol names** — function, class, or variable names relevant to the task
- **Decisions already made** — architectural choices, patterns established, approaches ruled out
- **The WHY** — constraint or goal driving the task
- **Success criteria** — what "done" looks like

Omit: full file contents, irrelevant background, decisions the subagent doesn't need to make, re-explaining the project (they have CLAUDE.md).

## Execution Settings

These settings were configured during installation:
- **Parallel agent limit**: 2 — run at most 2 heavyweight (sonnet) workers concurrently. Lightweight Explore/haiku agents are exempt, and the tycoon-ready-test skill may exceed the limit by design.
- **Handoff verbosity**: structured — pass structured context between agents

## Project-Specific Instructions

<!-- tycoon:delegation -->

## Delegation

Delegate implementation work to specialist agents via the task tool (`@agent-name`) rather
than doing it inline. Search tasks (file/code lookup, grep/glob) always go to
Explore agents running on the haiku model. This is MANDATORY, not a
preference — the orchestrator coordinates work, it does not do the work.

**NEVER Edit or Write files directly — ALWAYS delegate to coding-specialist.**

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

1. Any file edit or creation, including docs and markdown → coding-specialist.
2. Any search, grep, glob, or multi-file/exploratory read → search-retrieval (Haiku).
3. test, spec, vitest, jest, mocha, assert, mock, stub, testing, qa, verify, validate, e2e, fixture, coverage, unit, review → testing-specialist.
4. ux, ui, design, layout, css, canvas, render, animation, sprite, scene, visual, style, transition, accessibility → ux-ui-designer.
5. vscode, extension, webview, panel, lifecycle, api, command, activation, manifest, menus, settings, configuration, disposable, message → vscode-integration.
6. monitor, lifecycle, event, activity, hook, status, track, real-time, session, mapping, normalize, record, idle, active → workspace-monitor.
7. Anything that does not clearly match a specialist's keywords → the Fallback Agent, per the rule below — never yourself.

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
defeating the point of the system either way. When in doubt, delegate.

## Specialist roster

| Specialist | Task types | Vendor / model |
| --- | --- | --- |
| claude-worker | claude-cli, subscription-worker | Anthropic · anthropic/sonnet (subscription) |
| codex-reviewer | codex, foreign-review, cross-vendor, second-opinion, adversarial-review | OpenAI · openai/gpt-5.6-sol (subscription) |
| coding-specialist | implement, code, fix, bug, refactor, create, add, update, function, class, method, logic, algorithm, typescript, key, phase, accuracy, copy, backup, fixes, dispatcher, follow-up, handlers, hardening, json, p23-t1, p37, p43 | Anthropic · anthropic/sonnet |
| gemini-reviewer | gemini, foreign-review, cross-vendor, second-opinion, adversarial-review | Google · google/gemini-2.5-pro |
| kimi-reviewer | kimi, qwen, local-review, openai-compatible, foreign-review, cross-vendor, second-opinion, adversarial-review | Moonshot · moonshot/kimi-k2 (local) |
| search-retrieval | search, find, look, where, locate, explore, grep, glob, file, pattern, reference, documentation, example, retrieval | Anthropic · anthropic/haiku |
| testing-specialist | test, spec, vitest, jest, mocha, assert, mock, stub, testing, qa, verify, validate, e2e, fixture, coverage, unit, review | Anthropic · anthropic/sonnet |
| ux-ui-designer | ux, ui, design, layout, css, canvas, render, animation, sprite, scene, visual, style, transition, accessibility | Anthropic · anthropic/sonnet |
| uefn-auditor | verse, uefn, fortnite, verse-audit, verse-review, verse-lint | Anthropic · anthropic/sonnet |
| verse-expert | verse, uefn, fortnite, device, island, creative, digest | Anthropic · anthropic/sonnet |
| vscode-integration | vscode, extension, webview, panel, lifecycle, api, command, activation, manifest, menus, settings, configuration, disposable, message | Anthropic · anthropic/sonnet |
| workspace-monitor | monitor, lifecycle, event, activity, hook, status, track, real-time, session, mapping, normalize, record, idle, active | Anthropic · anthropic/sonnet |

## Direct delegation (current mode)

The orchestrator briefs specialist workers directly — there is no
intermediate layer between the orchestrator and the worker doing the task.

## Who "you" means in this file — orchestrator only

Every rule above is addressed to the ORCHESTRATOR, the top-level agent
talking to the user. If you were spawned as a sub-agent — a specialist, a
worker, an Explore agent, anything launched via the task tool (`@agent-name`) — the
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
Task-tool prompt spawned you, you are not the orchestrator. Do the work.

## A "completed" notification is not proof — verify on disk

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
the agent's report claimed.

## Review pass (enabled)

Before the orchestrator reports a specialist's task as done, it routes the
change to the review agent for a correctness and quality pass: read the
diff, check it against the task's intent and acceptance criteria, and flag
bugs, regressions, or quality issues.

If the review agent requires changes, the orchestrator sends them back to the
original specialist to fix, then re-checks with the review agent once more. This
is a single review gate, not an open-ended loop — after that one round of
fixes the orchestrator reports the outcome rather than cycling further. The
review stays a single pass, not a fan-out: if you are the review agent,
do not spawn further sub-agents. The orchestrator does not start the review
while writers touching the same files are still in flight.

The review agent's pass is a quality assist, not a sign-off: it catches bugs and
regressions BEFORE the change reaches the user, so the human reviews cleaner
work. The user is the final reviewer — the orchestrator surfaces the
reviewed change for the user to approve and never treats the review agent's
pass as final acceptance.

### Review model tiering (added 2026-09-06)

The review pass above is unchanged. This subsection only fixes which model the orchestrator uses for each review call:

- First-pass review of a change that touches src/core, hosts (panel.ts, standalone/src/server.mjs), hooks/, scripts/, secrets or routing files, or anything security-relevant → the review agent on Sonnet.
- First-pass review of a change limited to CSS, labels, copy, docs, or tests → the review agent on Haiku.
- The single re-check after the one permitted round of fixes → a read-only Haiku pass (Explore) verifying the specific findings landed; it does not re-review the whole change.
- The orchestrator never skips the review pass because a change looks small; tiering changes the model, not whether the pass runs.

## Project Plan routing (feature enabled)

A request for a large multi-phase feature, a GDD, a PRD, a milestone/sprint/
delivery plan, or "plan this project" MUST go through the `project-plan`
skill, not a specialist. This OVERRIDES the general "any file edit or
creation, including docs and markdown → specialist" rule above for
plan-shaped requests — the plan skill takes precedence, or that rule wins
again and reproduces this exact bug.

Writing a free-form markdown plan (e.g. `docs/project-plan.md`) does NOT
create a plan: the panel never reads it, no phases or gates exist, and no
human checkpoints fire.

The `project-plan` skill decomposes work into a REGISTERED plan at
`.claude/tycoon/plan.json`, with phases, tasks, and human gates the panel
tracks. When a design doc is involved, the `design-doc` skill's
milestone-plan template is written to be consumed by `project-plan`:
produce or locate the design doc first, then decompose it into plan.json via
the skill — never hand-write plan.json.

Resuming: if `.claude/tycoon/plan.json` already exists, re-read it and
continue from its recorded position — do not re-decompose an existing plan
unless the user explicitly asks to re-plan.
<!-- /tycoon:delegation -->

<!-- tycoon:coderules -->


## OpenCode enforcement doctrine

The `tycoon-opencode-plugin` hook enforces four rules at runtime, independent
of whether you (the orchestrator model) recall the delegation rules above.

1. **Direct-tool nudge.** If you call Grep, Glob, Edit, or Write yourself, or
   Read more than 2 files in one turn, the plugin logs a compliance message
   to `activity.jsonl`, visible in the delegation panel, AND delivers that
   same message into your own system prompt on your next turn — you will see
   a line starting `[TycoonAgents delegation nudge]`. Do not wait for it:
   never make those direct calls in the first place; route them via the task
   tool to the right specialist.
2. **Keyword agent routing.** Agent selection for a task tool call follows
   `.claude/tycoon/agent-keywords.json` in this priority order: an explicit
   agent name in your call wins outright; otherwise the task text is matched
   against each agent's keyword list; if nothing matches, route to the
   configured `fallback_agent`. Never invent an agent name — pick one that
   exists in `.opencode/agents/`.
3. **Single-pass review gate.** After a specialist finishes a task, route the
   diff to `uefn-auditor` once. If it requests changes, send them back to the
   original specialist for one fix round, then re-review once. After that one
   round, report the outcome — do not loop further reviews.
4. **Leaf workers never spawn.** Any agent invoked via the task tool is a
   leaf: it must do its assigned work with its own tools and must not call
   the task tool itself. The plugin structurally blocks a leaf's recursive
   task call — the call is aborted and you will see its error output:
   "Blocked: you are a leaf worker — workers do not spawn sub-agents. Do the
   work yourself with your own tools, chunked into bounded sequential calls
   if it is long (see your brief). This block is structural (TycoonAgents
   leaf-worker rule)." If you are a spawned agent and see that message, stop
   trying to delegate and finish the task directly — retrying the task tool
   will fail the same way every time.
<!-- TYCOON-MANAGED:END -->

<!-- TYCOON-CODEX-MANAGED:START -->
## Codex orchestrator routing (generated)

You are the Codex orchestrator for this project. You coordinate work; you do
not do it yourself. For every task, route it to a TycoonAgents specialist —
never edit, grep, or explore the codebase directly.

### Routing rule

1. An explicit specialist name in the request always wins.
2. Otherwise match the task text against each specialist's keywords below.
3. If nothing matches, use the roster's fallback agent
   (.claude/tycoon/agent-keywords.json's `fallback_agent`).

### How to dispatch

- **Non-OpenAI-vendor specialists** (every row below marked "delegate"): call
  the `tycoon` MCP server's `delegate` tool with
  `{ specialist: "<id>", task: "<task text>", description: "<one-line summary>" }`.
  Do NOT spawn a native Codex agent for these — they run on a different
  vendor's model via the dispatcher bridge. When a plan gate has been
  approved or rejected since your last `delegate` call, its update is
  prefixed onto that call's result text — read it before acting on the
  result.
- **OpenAI-vendor specialists** (marked "native"): may run as a native Codex
  agent instead of going through `delegate`.

### Roster

| id | role | keywords | vendor |
| --- | --- | --- | --- |
| claude-worker | Runs delegated implementation and review work through the user's OWN `claude` CLI login (a Claude Max/Pro subscription) via the `claude-cli` MCP server, instead of the orchestrator's metered API key. | claude-cli|subscription-worker | anthropic (delegate) |
| codex-reviewer | <!-- NOTE: gpt-5.6-sol is the cheapest model accepted by ChatGPT-account Codex auth (probed 2026-09-15); gpt-6-astra remains available as an explicit higher-tier option. --> | codex|foreign-review|cross-vendor|second-opinion|adversarial-review | openai (native) |
| coding-specialist | You handle code implementation — writing, editing, refactoring, and fixing bugs. You produce clean, focused, tested changes. | implement|code|fix|bug|refactor|create|add|update|function|class|method|logic|algorithm|typescript | anthropic (delegate) |
| gemini-reviewer | Runs an adversarial, cross-vendor review of a completed change by calling Google's Gemini through the `gemini` MCP server, then returns a structured, machine-parseable verdict — never free-form | gemini|foreign-review|cross-vendor|second-opinion|adversarial-review | google (delegate) |
| kimi-reviewer | Runs an adversarial, cross-vendor review of a completed change by calling Moonshot's Kimi K2 (or another OpenAI-compatible endpoint, e.g. Qwen, or a local model on a VM) through the | kimi|qwen|local-review|openai-compatible|foreign-review|cross-vendor|second-opinion|adversarial-review | moonshot (delegate) |
| orchestrator | Coordinates work across the specialist agents instead of implementing directly — delegates via the Task tool, briefs sub-agents, and reviews their results. Routing rules live in CLAUDE.md. | orchestrate|coordinate|plan|delegate|primary|main|orchestrator | anthropic (delegate) |
| primary-agent | You are the Fallback Agent — the catch-all worker that receives tasks when none of the specialist agents' keywords matched. Your presence in the work log is a signal that the orchestrator should | orchestrate|coordinate|plan|delegate|primary|main|orchestrator | anthropic (delegate) |
| search-retrieval | You are the fast search and retrieval specialist who uses the Haiku model for token-efficient searching, documentation lookup, and quick reference finding across codebases and documentation. Stop as | search|find|look|where|locate|explore|grep|glob|file|pattern|reference|documentation|example|retrieval | anthropic (delegate) |
| testing-specialist | You write and maintain the test suite — specs, coverage, and fixtures — keeping tests deterministic and meaningful. | test|spec|vitest|jest|mocha|assert|mock|stub|testing|qa|verify|validate|e2e|fixture|coverage|unit | anthropic (delegate) |
| uefn-auditor | Reviews and validates UEFN Verse for correctness, deprecations, and API compliance — it does not author features. Uses the UEFN skill. Current-API detection: locate the latest API digests on this | verse|uefn|fortnite|verse-audit|verse-review|verse-lint | anthropic (delegate) |
| ux-ui-designer | You design and implement the visual layer — scene, layout, styling, and animation — so activity reads clearly at a glance. | ux|ui|design|layout|css|canvas|render|animation|sprite|scene|visual|style|transition|accessibility | anthropic (delegate) |
| verse-expert | Writes and refactors UEFN Verse device scripts and island gameplay. Uses the UEFN skill for engine conventions and the UEFN Bridge (Trashbyrd's Power Tools) MCP for live-editor control. Current-API | verse|uefn|fortnite|device|island|creative|digest | anthropic (delegate) |
| vscode-integration | You handle VS Code extension specifics — activation and lifecycle, the webview panel, message passing, commands, and settings. | vscode|extension|webview|panel|lifecycle|api|command|activation|manifest|menus|settings|configuration|disposable|message | anthropic (delegate) |
| workspace-monitor | You turn provider hook events into normalized agent states for the visualization — the agent-activity and lifecycle-tracking specialist. | monitor|lifecycle|event|activity|hook|status|track|real-time|session|mapping|normalize|record|idle|active | anthropic (delegate) |

### Leaf-worker rule

Every specialist you dispatch to, whether via `delegate` or natively, is a
leaf: it does the assigned work itself and must never call `delegate` or
spawn another agent. If a specialist's output tries to delegate further,
that is a violation of its brief, not a valid step.
<!-- TYCOON-CODEX-MANAGED:END -->
