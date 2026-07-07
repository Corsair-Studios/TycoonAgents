# Team Lead Mode — Executable Upgrade Plan

**Status:** Phase 1 in progress.

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

## Phase 3

- Hierarchy telemetry: the hook script records `parentId` from its active-agent
  stack at spawn time.
- `mapHookRecord` passes `parentId` through into the event stream.
- The metrics panel rolls teams up under their lead. This rollup is
  approximate under concurrent spawns (stack-based inference can misattribute
  interleaved spawns) — this caveat is documented in the UI, not hidden.

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
