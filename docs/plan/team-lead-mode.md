# Team Lead Mode — Executable Upgrade Plan

**Status:** Complete. Phase 1 shipped (0.0.173). Phase 2 implemented. Phase 3
implemented (hierarchy telemetry — hook parentId/tier capture, provider
mapping, metrics panel team rollup). Phase 4 implemented (per-mode
measurement — hook delegationMode stamping, `computeDelegationModeStats`,
metrics panel "Delegation stats" section).

## Summary

Team Lead Mode is an opt-in delegation topology chosen at install and switchable
later in Settings. It has two modes:

- **Flat (default).** The orchestrator briefs specialist workers directly.
- **Team Leads.** Persistent lead agents (`build-lead`, `quality-lead`) own
  domains, brief and verify the workers under them, and report compressed
  results back up to the orchestrator.

### Design rules

- **Depth is capped at 2.** The chain never exceeds
  `orchestrator → lead → worker`. Leads do not spawn leads.
- **Leads own the full loop.** A lead is responsible for decomposition,
  briefing, verification, and upward reporting for its domain — it does not
  merely relay tasks.
- **Contracts live in files, not conversation.** Task specs and interface
  contracts are written to `docs/plan/*.md` so they survive context resets and
  are readable by any agent, not just the ones present when they were agreed.
- **No team self-certifies.** Verification of a domain's output is never done
  by the same team that produced it.
- **Leads activate only at scale.** Team leads engage only when a plan fans
  out to roughly 3+ tasks per domain. Small tasks stay direct (orchestrator →
  worker) even when Team Leads mode is selected.

## Honest user-facing copy

This copy is used verbatim in the UI (setup view and Settings panel):

> **Delegation style**
>
> **Flat (recommended for most projects)** — The orchestrator briefs
> specialist workers directly. Lowest token cost, fastest for small-to-medium
> tasks.
>
> **Team Leads** — Adds persistent lead agents that manage domain teams
> (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a
> coordination hop. Pays off on large builds from design docs — many features
> across many files — where it reduces orchestrator context churn,
> re-briefing, and mid-build context loss. If you mostly do focused fixes,
> stay Flat.
>
> You can change this anytime in Settings. Switching updates this project's
> agent roster and delegation instructions.

## Phase 1 (this phase)

- Setup-view delegation-style radio (Flat / Team Leads).
- Persist the choice to `.claude/tycoon/execution.json` as
  `{"delegation_mode":"flat"|"team_leads"}`.
- New `delegationDoctrine` module renders delegation instructions into the
  target project's `CLAUDE.md`, written between managed markers so the rest
  of the user's `CLAUDE.md` is left untouched.
- Lead agent definitions:
  - `build-lead` — owns the coding, ux-ui, and vscode-integration workers.
  - `quality-lead` — owns the testing and workspace-monitor workers.
  - `search-retrieval` stays flat — it is never routed through a lead.
  - Lead agent `.md` files carry `tier: lead` frontmatter so tooling (e.g.
    the ready-test) can identify and special-case them.

## Phase 2

- Add the same delegation-style radio to the Settings panel (not just setup).
- A `setDelegationMode` host handler that idempotently adds/removes the lead
  `.md` files and rewrites the managed `CLAUDE.md` section when the mode
  changes.
- The ready-test excludes agents with `tier: lead` frontmatter so it does not
  double-spawn work through a lead and its workers.

## Phase 3 (implemented)

- Hierarchy telemetry: the hook script (`hooks/tycoon-claude-hook.cjs`) records
  `parentId` from its active-agent stack at spawn time (whoever is on top of
  the stack when a `Task`/`Agent` spawn fires) and `tier` from the spawned
  agent's `.md` frontmatter, alongside the existing `model` field.
- `mapHookRecord` (`src/providers/claude-code/mapHookRecord.ts`) passes both
  through into the `WorkerSpawned` normalized event; `src/core/state.ts`
  carries them onto `AgentMetric` (`tier`, `parentId`) so they reach the
  webview in the existing `state` postMessage payload untouched — no changes
  needed in `claudeCodeProvider.ts` or `panel.ts`, since both already forward
  objects generically.
- The metrics panel (`media/main.js` `renderMetrics`/`buildMetricsRow`) rolls
  workers up under a `tier: "lead"` entry when at least one visible worker's
  `parentId` matches it: a chevron toggles between individual rows and a
  collapsed "team" aggregate row (summed tokens/tasks/time, tagged `team`).
  Expand/collapse state persists per-lead-id via the existing
  `vscode.getState()/setState()` webview-state mechanism. Projects with no
  leads, and workers whose `parentId` doesn't resolve to a visible lead,
  render exactly as before — zero visual change.
- **Concurrency caveat (accepted limitation):** parent attribution comes from
  a stack-based inference (whoever was on top of the active-agent stack when
  a spawn fired), not a ground-truth trace. When two agents spawn workers at
  the same time, the stack can interleave and misattribute a worker to the
  wrong lead. This is documented, not silently patched with guesswork — see
  the Risks section below.
- Backward compatibility: records written by hook versions predating this
  change simply omit `parentId`/`tier`; every layer treats them as optional
  and falls through to today's flat rendering (`mapHookRecord`,
  `applyEvent`'s `WorkerSpawned` case, and `renderMetrics` all guard with
  `?? `/`||` defaults, never throw on absence).

## Phase 4 (implemented)

- **Hook stamping.** `hooks/tycoon-claude-hook.cjs` reads
  `.claude/tycoon/execution.json` once per process (`readDelegationMode`,
  cached in a module-level variable — a hook invocation is one event, so this
  just avoids redundant reads within that single call) and stamps
  `delegationMode: "flat"|"team_leads"` onto every activity record it writes.
  Defensive like every other frontmatter/config read in this file: missing
  file, missing dir, or invalid/unrecognized JSON all fall back to `"flat"`,
  never throws. Historical records keep the mode they were recorded under —
  toggling the setting later does not rewrite past records, which is the
  point: it lets before/after comparisons work.
- **Provider/state passthrough.** `HookRecord.delegationMode` (optional,
  `src/providers/claude-code/hookRecord.ts`) flows through `mapHookRecord`
  onto `WorkerSpawned` and `SessionStop` normalized events, then onto
  `AgentMetric.delegationMode` in `src/core/state.ts` (set at spawn time for
  workers, at each Stop for the orchestrator).
- **Aggregation.** `computeDelegationModeStats(agentMetrics)` in
  `src/core/state.ts` is a pure function (no fs/vscode access, unit-tested
  directly) that buckets agents by `delegationMode` (missing =&gt; `"flat"`)
  and produces, per mode with at least one agent: `completedTasks`,
  `totalTokens`, `activeMs`, plus `leadTokens`/`teamTokens`/
  `leadOverheadPct` — tokens spent by `tier==="lead"` agents as a percentage
  of "team" tokens (the lead plus every agent whose `parentId` points at
  it). Agents in Team Leads mode that skipped a lead (small-task direct
  delegation, permitted by doctrine) are excluded from that denominator —
  they were never part of a team. `panel.ts` calls this on every state push
  (`_withModeStats`, folded into the existing `_applyTimeAdjustments`
  pipeline) and attaches the result as `state.modeStats`, which flows to the
  webview through the same generic `state` postMessage Phase 3 already used
  — no new message type.
- **Metrics panel.** `media/main.js` `renderDelegationStats()` renders a
  "Delegation stats" section under the metrics table: one row per mode with
  data (tasks, tokens, tokens/task; team_leads additionally shows "lead
  overhead: X% of team tokens"), a "measured this workspace" caption, and
  stays hidden entirely when there's no data yet. If only one mode has data,
  only that row renders — no zeroed placeholder for the other mode.
- **Scope decision: rework counts dropped.** The original Phase 4 sketch
  called for tracking "rework counts" per mode alongside tokens-per-task.
  Hook records carry no task identity (no correlation id linking a task's
  initial attempt to a later re-do of the same work) — the only way to infer
  "rework" would be heuristics like "this agent got respawned again soon
  after its last stop," which is guesswork, not measurement. Rather than
  ship a fabricated number next to real measured ones, this metric is
  dropped from Phase 4. If task identity is added to the hook/event schema
  later, rework tracking can be revisited as its own follow-up.
- Once enough real usage accumulates, the install screen's estimated
  "10-20% more tokens" copy (the "Honest user-facing copy" section above,
  rendered from `src/host/vscode/panel.ts`'s setup-view HTML) can be
  revisited against the measured `leadOverheadPct` — left as a future edit,
  not part of this phase, since one workspace's early numbers aren't a
  reliable replacement for a range claim.

## Risks

- **`CLAUDE.md` is user-owned.** Only the content between the managed markers
  (`<!-- tycoon:delegation -->` / `<!-- /tycoon:delegation -->`) is ever
  touched. Content outside the markers is preserved byte-for-byte.
- **Ready-test double-spawn.** Without the `tier: lead` filter, the ready-test
  could spawn both a lead and the workers it would delegate to, double
  counting activity. The filter (Phase 2) prevents this.
- **Approximate hierarchy inference.** Parent attribution from an
  active-agent stack is an approximation, not a ground truth trace — it can
  misattribute under concurrent/interleaved spawns. This is a known,
  documented limitation, not a bug to silently "fix" with guesswork.
