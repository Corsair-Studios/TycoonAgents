# Delegation Reliability — Repro Notes (Session 2)

Companion evidence for the Tycoon Agents PM's upstream bug report to the
Claude Code team. This documents a **second, independent reproduction** of the
Task-tool delegation failures, observed while building the economy dashboard
in the `sw-roguelike-dashboard` project on 2026-07-21.

## Root cause (agreed, upstream — not TycoonAgents)
The failure lives in **Claude Code's Task tool**, not the TycoonAgents
extension. Four missing guarantees:
1. Sub-agents do **not block on their own nested children** — a worker can
   spawn a nested exploration sub-agent and return before it resolves.
2. **No synchronous mode** — no way to force a dispatched task to run to
   completion inline.
3. **No notification dedup** — a single task emits multiple, sometimes
   long-delayed, `task-notification` events; superseded/reader sub-agents
   surface as the writer task "finishing."
4. **No file locking** between an original sub-agent and a *resumed* instance
   of it — both can mutate the same file concurrently.

## Failure modes observed this session
1. **False-completion / no-op returns.** Writer tasks returned a terminal
   message like *"running in the background, I'll report when done"* or
   *"I'll wait for it to complete"* with **zero file writes**. Verified by
   immediate filesystem check — target files absent. Hit repeatedly on:
   economy schema (migration 005), the Verse importer, and the economy API
   endpoints (each needed 2–3 dispatches; several never wrote at all).
2. **Duplicate / stale notifications.** Single dispatched tasks emitted
   multiple `task-notification`s across later turns, some referencing
   *reference-reading* sub-agents (e.g. "Read economy API convention files")
   rather than the requested writer.
3. **Concurrent-edit regression.** While the orchestrator was verifying
   `api/economy/item-curve.js`, a **resumed background sub-agent** edited the
   same file and changed the cumulative-cost logic
   (`if (level >= 1) cumulative += cost` → unconditional), introducing a real
   semantic bug (level-0 start state counted as spent). Caught only by
   re-reading the file directly, not by trusting the notification.

## Signals for diagnosis
- Stalls exit **cleanly** (no thrown error) — points to a premature-return /
  delegation-recursion lifecycle bug, not a crash.
- **Non-deterministic**: the *same* prompt succeeded on a later attempt →
  scheduling/timing issue, not a bad prompt.
- The mandatory review-gate fan-out (writer → reviewer → reader sub-agents)
  **amplified** the stale-notification noise and the race surface.

## Repro artifacts (in this session's workspace)
- **Task transcripts** (131 files, per-task JSONL):
  `…/tasks/*.output`
  Confirmed stall-signature files:
  `a9b1824ff1d49e51a.output`, `abecfc4b65675e814.output`,
  `ac1e6c3caec199306.output`, `af520d3aa097b9087.output`
  (grep pattern: `"running in the background"` / `"wait for it to complete"`)
- **Tycoon activity log:** `.claude/tycoon/activity.jsonl` (~204 KB) — full
  dispatch→notification timeline.

## Suggested questions for the Claude Code team
1. Should a sub-agent ever return "running in background" as its *terminal*
   message, or must it block until its own children resolve?
2. Any guard against an original + resumed sub-agent mutating the same file
   concurrently?
3. Can `task-notification` events be de-duplicated by task-id + generation?
4. Does auto-review fan-out need a concurrency cap?

## Mitigation used (both sessions, independently)
When delegation stalled, the orchestrator **stopped the stalled agents,
applied the edits directly** (the justified "delegation mechanism is broken"
exception), then had the change **independently reviewed** before shipping.
No delivered work was corrupted — every result was verified against the live
DB and the running app, and the correctness-critical code (economy
formulas/API) was hand-written and tested.
