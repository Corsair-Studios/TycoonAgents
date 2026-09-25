# Hermes-inspired Capabilities

**Status:** Post-launch — not scheduled
**Audience:** solo devs and small teams (indie/UGC games, web apps)

## Problem / Opportunity

TycoonAgents currently runs plans through a human-in-the-loop orchestrator/specialist
model (`.claude/tycoon/plan.json`, gate events, the panel) but has no way to (1) learn
from its own completed work, (2) run itself on a timer without a human present, (3)
route through OpenRouter's large model catalog as a first-class vendor, (4) notify or
approve gates from a phone when the user is away from the machine, or (5) treat a
Hermes-style agent as an interchangeable harness host the way Claude Code, OpenCode
(Experimental), and Codex (Experimental) already are (`src/core/providerSelection.ts:23`). Hermes Agent
(github.com/NousResearch/hermes-agent, MIT, checked 2026-09-25) ships several of these
capabilities natively — agentskills.io-compatible skills, natural-language cron, a
30+ platform notification gateway with pairing codes — and its shape is a useful
reference even where TycoonAgents' own implementation will differ.

This PRD scopes five independent, shippable-alone features inspired by that surface
area. None are scheduled; this document exists so the `project-plan` skill can
decompose whichever features get picked up later.

## Target Users

Solo developers and small teams building indie/UGC games and web apps who already use
TycoonAgents' orchestrator/specialist delegation model in VS Code or the standalone
app. These users run unattended or semi-unattended work sessions, want the system to
get better over time without hand-tuning routing keywords, and want to be reachable
away from their desk instead of watching a plan gate pending.

## Goals & Success Metrics

No telemetry pipeline currently tracks agent-success patterns, scheduled-job outcomes,
or notification delivery — this section proposes what each feature should track once
built.

- **F1 Learned skills:** number of proposed skills/keyword diffs surfaced per week;
  acceptance rate of proposals in the panel; zero proposals containing secrets or
  absolute paths (verified by the `check:paths-style` scan).
- **F2 Scheduled jobs:** jobs run on schedule vs. missed; token spend per job vs. its
  cap; results delivered to the panel within one tick of job completion.
- **F3 OpenRouter preset:** time to add an OpenRouter model to a routing chain (should
  match the Grok/xAI preset's setup time); correct cost-class metering; no OpenRouter
  request sent without `OPENROUTER_API_KEY` resolved via the local env value store.
- **F4 Phone approvals/alerts:** gate-to-notification latency; approval nonce replay
  attempts blocked (should be 100%); zero secrets/code/absolute paths appearing in
  outbound messages (spot-checked).
- **F5 Hermes host (Experimental):** spike exit criteria answered (see Open Questions);
  if pursued, parity of a smoke-test plan run against the existing Claude Code host.

## Core Features

All five are independent and shippable alone. Suggested build order: F3, F4, F1, F2,
F5 — F3 and F4 have the fewest unknowns and highest immediate value; F1 and F2 build on
existing plan/activity data; F5 is gated on a spike and comes last.

### F1 — Learned skills (planned)

After work finishes, analyze completed plan tasks (`task.status` in
`.claude/tycoon/plan.json`, enum `pending|active|verifying|done|needs_fix|skipped|blocked`)
and the activity log (`.claude/tycoon/activity.jsonl`, shaped by `HookRecord` in
`src/providers/claude-code/hookRecord.ts`) to spot repeated successful patterns —
sequences of tasks that consistently reach `done` without a `needs_fix` detour.

- Propose new `SKILL.md` files in the agentskills.io format — the same format Claude
  Code and Hermes use. `.claude/skills/tycoon-ready-test/SKILL.md` is the in-repo
  reference for shape and frontmatter.
- Propose routing-keyword updates by extending the keyword doctor: add a new
  `KeywordFindingKind` variant in `src/core/keywordHealth.ts:26` and reuse the existing
  `normalizeAgentKeywords` / "Fix all" flow rather than inventing a parallel one.
- Every proposal is a diff the user approves in the panel. Nothing is auto-applied —
  this is a hard requirement, not a default.
- The analysis itself runs as a delegated task on a cheap model via the existing
  routing — never the orchestrator. It is triggered manually or by a scheduled job
  (F2), not inline during a live session.
- Guardrails: exclude tasks whose status is `needs_fix`, `skipped`, or `blocked`, and
  exclude any plan run that was later reverted. Run the existing `check:paths-style`
  scan against every proposed skill/keyword diff before it reaches the panel, to catch
  secrets or absolute paths captured from the activity log.

**Reuses:** `.claude/tycoon/plan.json`, `.claude/tycoon/activity.jsonl`,
`src/providers/claude-code/hookRecord.ts`, `src/core/keywordHealth.ts`, the panel diff
UI, the existing cheap-model delegation routing, `check:paths-style`.

### F2 — Scheduled jobs (planned)

Timed tasks: a nightly ready test (`tycoon-ready-test` skill), a weekly pricing
refresh (`update-pricing` skill), a plan-status digest, and F1's learned-skills
analysis.

- **Where jobs run:** the standalone app is a long-running process
  (`standalone/src/server.mjs`) and is the natural home for an in-process scheduler.
  The VS Code extension only runs while VS Code is open and already has `setInterval`
  polling in `src/providers/claude-code/claudeCodeProvider.ts` — a job scheduler there
  would only fire during open-editor windows, so VS Code-only jobs need to be framed as
  best-effort, not guaranteed-cadence. As an alternative or supplement, an OS scheduler
  (Windows Task Scheduler, cron) can invoke `node standalone/src/cli.mjs ...` directly,
  which works even when neither host app is open — this should be documented as a
  supported option, not just an in-app scheduler.
- Jobs are defined in a project file, e.g. `.claude/tycoon/schedules.json`, with no
  secrets — only job name, cadence, target skill/command, and cost cap.
- Missed-run policy: if the process wasn't running at the scheduled time, decide
  whether to run once on next start (catch-up) or skip to the next scheduled slot —
  default should be skip, to avoid surprise token spend after a long-idle period.
- Cost caps per job, enforced before dispatch, not just logged after.
- Results delivered to the panel, and optionally forwarded to F4's notification
  channels when the job is marked notify-worthy.
- Jobs that spend tokens require an explicit per-job opt-in at creation time — no job
  runs against a paid model by default.

**Reuses:** `standalone/src/server.mjs`, `standalone/src/cli.mjs`,
`src/providers/claude-code/claudeCodeProvider.ts`'s polling pattern, the
`tycoon-ready-test` and `update-pricing` skills, the panel's results feed, F4 (optional).

### F3 — OpenRouter as a first-class Routing vendor preset (planned)

Add OpenRouter as a vendor preset reusing the existing custom endpoint / OpenAI-compatible
transport, following the path the xAI/Grok preset took: commit `55acd0b`, the vendor
list in `media/src/main/100-slot-editor-settings.js`, and the preset logic in
`src/core/routingProfile.ts`.

- Facts: base URL `https://openrouter.ai/api/v1`; auth header
  `Authorization: Bearer OPENROUTER_API_KEY`; model ids are `vendor/model` strings.
- Secrets stay out of the project: the API key is stored via the local env value store
  (`src/core/localEnvStore.ts`), which persists secrets in app-data `secrets/` and only
  ever writes the env var *name* into project files.
- OpenRouter has its own fallback mechanism — a `models` array in priority order that
  OpenRouter itself walks server-side. **Recommendation:** TycoonAgents' own fallback
  chain (`(fb)`/`(dfb)` chain and default-fallback labels) stays the source of truth for
  routing decisions and UI. OpenRouter's `models` array is optional sugar a user can set
  within a single OpenRouter slot for extra resilience inside that one hop — it is not a
  substitute for our chain, and our chain does not attempt to populate or read it
  automatically in the first cut.
- **Attribution caveat:** because OpenRouter can silently serve a different model than
  requested (via its own fallback), our `(fb)`/`(dfb)` labels only ever reflect our own
  chain's routing decision, not which model actually executed. Billing and the
  model-name shown in our metrics may not match the model that truly served the
  request. This must be surfaced in the UI/docs, not just this PRD.
- Metrics: cost class is metered (token-based billing passed through from OpenRouter),
  with a UI note on the model-name attribution caveat above.

**Reuses:** `src/core/localEnvStore.ts`, `src/core/routingProfile.ts`, the custom
endpoint/OpenAI-compatible transport, `media/src/main/100-slot-editor-settings.js`
vendor list, existing cost-class metering.

### F4 — Approvals and alerts from the phone (planned)

Deliver plan gate events, stall notices, theme generation results, and scheduled-job
results to a phone, and let the user approve/reject a gate from there.

- **Events:** plan gate pending and approve/reject; the stall notice
  (`isPlanStalled()` in `media/src/main/000-boot-and-state.js:561`, consumed at
  `:628` when an active task is stalled); theme generation completion or failure
  (`src/extension/themeService.ts`, `src/extension/imageGenerationError.ts` — note:
  the brief's originally-cited path `themeService.ts` at repo root does not exist;
  the actual file lives under `src/extension/`); job results from F2.
- **Channels:** Telegram, Discord, Slack.
- **Design:** outbound-only connection from the user's machine — no inbound port, no
  Corsair relay by default. Telegram bot long-polling, the Discord gateway websocket,
  and Slack Socket Mode all satisfy this without opening any port.
- Bot tokens live in the local env value store (`src/core/localEnvStore.ts`), never in
  the project.
- **Pairing:** a one-time pairing code shown in the panel, then a per-user allowlist —
  the same pattern Hermes uses (pairing codes with a 1-hour expiry, plus allowlists).
- **Wiring into the existing gate path:** an approval from a phone writes a gate event
  to `.claude/tycoon/gate-events.jsonl`, which the hook already reads and forwards to
  the orchestrator via `additionalContext`
  (`hooks/tycoon-claude-hook.cjs:99-117`, with the source tagged `"phone"`). This reuses
  the existing gate approval path end-to-end; it does not create a parallel one.
- **Security:** approval buttons carry signed, single-use, short-expiry nonces bound to
  the gate id and plan revision, so a stale or intercepted message can't replay an
  approval against a different plan state. Approving is only possible for the paired
  user. Message content never includes secrets, code, or absolute paths — events are
  summarized (task name, plan phase) before being sent out. Include an audit log of
  who approved what and when, plus a kill switch to revoke all pairings instantly.
- **Optional/later:** a Corsair-hosted relay for users who can't run a background
  process continuously. This trades the outbound-only, no-relay privacy property for
  convenience — flag this trade-off explicitly to the user before offering it, and keep
  it opt-in and off by default.

**Reuses:** `.claude/tycoon/gate-events.jsonl` and `hooks/tycoon-claude-hook.cjs`'s
existing read/forward path, `src/core/localEnvStore.ts`, `media/src/main/000-boot-and-state.js`'s
stall detection, `src/extension/themeService.ts` / `imageGenerationError.ts`, F2's job
results.

### F5 — Hermes Agent as a harness host (Experimental, spike-gated, last)

Treat Hermes Agent as a fourth harness host alongside `claude-code`, `opencode`
(Experimental), and `codex` (Experimental) (`src/core/providerSelection.ts:23`,
`PROVIDER_IDS`). A new host requires a
record mapper registered via `src/core/mappingRegistry.ts`, an activity tailer, a
hook/installer, and an `(Experimental)` label per the project's existing convention for
new hosts.

**Known Hermes facts** (checked 2026-09-25 against github.com/NousResearch/hermes-agent
and hermes-agent.nousresearch.com/docs):
- MIT license, implemented in Python plus Node.
- Latest release v0.21.5 on 2026-09-24, fast release cadence.
- Skills are agentskills.io-compatible (same format F1 proposes skills in).
- Cron via natural language, the CLI, and a tool, delivering results to chat or files.
- A gateway for 30+ platforms with allowlists, pairing codes, and `/approve` and
  `/deny` commands — directly analogous to F4's design.
- OpenRouter/OpenAI/custom endpoint support, MCP client support, and subagents.

**Unknowns — these become the spike's exit criteria (UNVERIFIED until answered):**
- Whether Hermes exposes lifecycle hooks, event callbacks, or a structured session log
  that a `HookRecord`-style mapper could tail (UNVERIFIED).
- Whether a server/daemon mode exists, comparable to `standalone/src/server.mjs`.
- How Hermes subagents map onto TycoonAgents' existing specialist roster.
- How CLAUDE.md/AGENTS.md doctrine would be delivered to a Hermes-run agent.
- Windows maturity — TycoonAgents runs on `win32`; Hermes' Windows support level is
  unverified.

**Fallback if no hooks exist:** consume Hermes through MCP, or treat it as a routing
target (an OpenAI-compatible-style endpoint) rather than a full host with its own
activity tailer.

**Reuses (if built):** `src/core/providerSelection.ts`, `src/core/mappingRegistry.ts`,
the existing hook/installer pattern from the Claude Code/OpenCode/Codex hosts.

## User Flows

- **F1:** user finishes several plan runs → triggers (manually, or via F2 nightly job)
  a learned-skills analysis → panel shows a diff of a proposed `SKILL.md` and/or a
  `KeywordFindingKind` fix → user reviews and approves or rejects in the panel → on
  approval, the file is written; on rejection, nothing changes.
- **F2:** user (or an install step) adds a job to `.claude/tycoon/schedules.json` with a
  cost cap and opt-in flag → standalone server (or OS scheduler invoking the CLI) fires
  the job at the scheduled time → result posted to the panel, optionally forwarded to
  F4.
- **F3:** user opens Routing settings, picks the OpenRouter preset, pastes/confirms an
  `OPENROUTER_API_KEY` (stored via the local env value store), picks a `vendor/model`
  id → the slot is usable in a routing chain like any other vendor.
- **F4:** user opens the panel, generates a pairing code, enters it in their
  Telegram/Discord/Slack bot chat within the 1-hour expiry → allowlisted → subsequent
  gate-pending events arrive as a message with an approve/deny action carrying a
  signed nonce → tapping approve writes to `gate-events.jsonl` → the hook picks it up on
  its next read exactly as it would a panel approval.
- **F5 (if built):** user selects Hermes as the active provider for a project →
  TycoonAgents' installer wires Hermes' hook/log output into the mapping registry →
  plan tasks dispatch through Hermes' CLI/server instead of Claude Code's.

## Non-Functional Requirements

- **No secrets in the project** for any feature — F1 proposals, F2 job definitions,
  F3 routing config, and F4 pairing/tokens all store secrets exclusively via the local
  env value store's app-data `secrets/` location; only env var *names* ever appear in
  project files or the panel.
- **Experimental labeling is kept**, not removed, for F5 and for any newly-labeled
  Experimental surface F3/F4 introduce, matching the existing OpenCode/Codex
  convention.
- **The orchestrator delegates; features never make the orchestrator do the work** —
  F1's analysis, F2's job execution, and any Hermes-side work in F5 must run as
  delegated tasks on appropriately cheap models, never inline on the orchestrator.
- **Standalone and VS Code parity:** F2 is the main parity risk — the standalone app
  can run jobs continuously while VS Code-only jobs only fire when the editor is open;
  this asymmetry must be documented in-product, not silently accepted. F1, F3, and F4
  should work identically in both hosts since they depend on shared `src/core/` state
  rather than host-specific polling.
- **Security:** F4's nonce signing/expiry and allowlist enforcement are hard
  requirements, not nice-to-haves, since they gate real plan actions. F1's
  `check:paths-style` scan is a hard gate before any proposal reaches the panel.
- **Reliability:** F2's missed-run policy and cost caps must be enforced before
  dispatch, not just logged after the fact.

## Tech Stack

- Existing TypeScript/Node core (`src/core/**`), VS Code extension host
  (`src/providers/claude-code/**`, `src/extension/**`), and standalone Node process
  (`standalone/src/server.mjs`, `standalone/src/cli.mjs`).
- Panel UI in `media/src/main/**` (vanilla JS, numbered-file convention).
- Hooks in `hooks/*.cjs` (CommonJS, no build step) bridging Claude Code's own hook
  system to `.claude/tycoon/*.jsonl` files.
- F3 reuses the existing OpenAI-compatible HTTP transport — no new HTTP client needed.
- F4 needs new outbound integrations: Telegram Bot API (long-polling), Discord gateway
  client, Slack Socket Mode client — each a new dependency, none requiring an inbound
  port.
- F5, if pursued, likely needs a Python-aware process wrapper since Hermes is Python
  plus Node, unlike the existing all-Node hosts.

## Milestones & Scope

Nothing here is scheduled. Suggested order for whenever this is picked up:

1. **F3 — OpenRouter preset.** Smallest surface area, reuses the most existing code,
   lowest risk.
2. **F4 — Phone approvals/alerts.** High user value, reuses the existing gate-event
   path end-to-end; main new work is the notification channels and nonce security.
3. **F1 — Learned skills.** Depends on stable plan/activity data already in place;
   main new work is the analysis job and the panel diff/approval UI.
4. **F2 — Scheduled jobs.** Benefits from F1 already existing as a thing to schedule,
   but is independently shippable; the standalone-vs-VS Code parity question needs a
   decision before building.
5. **F5 — Hermes host (Experimental).** Gated on a spike answering the Open Questions
   below; comes last regardless of the other four's order.

## Non-Goals

- Not replacing the existing harness hosts (Claude Code, OpenCode, Codex) — F5 adds a
  fourth option, it does not deprecate the others.
- Not auto-applying F1's learned skills or keyword changes — every proposal requires
  explicit panel approval.
- Not building a hosted SaaS agent or a Corsair-run always-on relay as the default for
  F4 — the default is outbound-only from the user's own machine; a hosted relay is an
  explicitly-flagged, opt-in later addition.
- Not making OpenRouter's own `models`-array fallback the primary routing mechanism —
  TycoonAgents' own fallback chain remains authoritative.

## Risks & Open Questions

- **F1:** learning from a small sample size (a solo dev's history) risks proposing
  overfit skills; needs a minimum-occurrence threshold before proposing anything.
- **F2:** the standalone-vs-VS Code parity gap could confuse users who set up a job in
  VS Code expecting nightly execution — needs explicit UI messaging about where each
  job actually runs.
- **F3:** OpenRouter's per-request model attribution ambiguity (UNVERIFIED how
  granular the OpenRouter response's model field is in practice) — needs to be
  confirmed against the live API response before shipping the metrics note as fact
  rather than caveat.
- **F4:** default-relay-off is a hard requirement; any future hosted relay needs a
  separate privacy review before shipping, not bundled into this PRD's approval.
- **F5 (UNVERIFIED):** whether Hermes exposes lifecycle hooks or a structured session
  log; whether a server/daemon mode exists; how its subagents map onto the existing
  roster; how CLAUDE.md/AGENTS.md doctrine would be delivered; Windows maturity. All
  five must be answered by a spike before any implementation work starts.

## Dependencies

- F1 depends on `.claude/tycoon/plan.json`'s task-status enum staying stable and on
  `HookRecord`'s activity log shape in `src/providers/claude-code/hookRecord.ts`.
- F1's routing-keyword proposals depend on `KeywordFindingKind` in
  `src/core/keywordHealth.ts:26` remaining the single source of truth for keyword
  health findings.
- F2 depends on a decision about where the canonical scheduler lives (standalone vs.
  OS-scheduler-invoked CLI) before job definitions in `schedules.json` can be finalized.
- F2's learned-skills job depends on F1 existing, though F2 itself is shippable without
  it (only that one job type would be deferred).
- F3 depends on the local env value store (`src/core/localEnvStore.ts`) and the
  existing custom-endpoint transport remaining unchanged.
- F4 depends on the existing gate-events path (`hooks/tycoon-claude-hook.cjs:99-117`)
  and on the local env value store for bot tokens.
- F5 depends on F1's skills format (agentskills.io) if Hermes-authored skills are ever
  meant to interoperate with TycoonAgents' own learned skills.

## How this becomes a plan later

When one or more of these features is scheduled, run the `project-plan` skill against
this document to decompose the selected feature(s) into a registered plan in
`.claude/tycoon/plan.json`, with phases, tasks, and human gates. Do not hand-write
`plan.json` from this PRD directly — the skill owns the decomposition.
