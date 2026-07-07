# Team Lead Mode — Executable Upgrade Plan

**Status:** Phase 1 shipped (0.0.173). Phase 2 implemented. Phase 3 implemented
(hierarchy telemetry — hook parentId/tier capture, provider mapping, metrics
panel team rollup).

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

## Phase 4

- Measurement: track tokens-per-task and rework counts per delegation mode in
  the metrics panel.
- Once real numbers are collected, replace the estimated "10-20% more tokens"
  figure in the honest user-facing copy with measured numbers.

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
