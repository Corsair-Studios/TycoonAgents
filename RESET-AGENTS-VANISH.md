# Bug: "Reset session metrics" makes all agents vanish from the panel metrics area

## Severity
Medium — reset now wipes the agent roster from the metrics table instead of
leaving it seeded with zeroed stats. Regression surfaced alongside the world-
state reset fix.

## Root cause: race between the host re-seed and the webview's metrics clear

Both the host and the webview try to own the metrics display during reset, and
the webview's clear runs LAST, clobbering the host's fresh roster.

Sequence during `_handleResetMetrics()` (src/host/vscode/panel.ts ~L3694):

1. `this._runtime.reset()` -> `runtime.onChange` (panel.ts L265) fires ->
   `postMessage({ type: MSG.STATE, state })` with an EMPTY roster.
2. Re-seed loop `this._runtime.ingest({ type: "WorkerRegistered", ... })` for
   each agent from `loadAgentRoster(root/.claude/agents)` -> each ingest fires
   `onChange` -> `postMessage(MSG.STATE)` — the final one carries the FULL roster
   with zeroed stats. **At this point the agents are correctly on screen.**
3. Host posts `MSG.METRICS_RESET { ok: true }` — LAST.

Webview processes those messages in order:
- `MSG.STATE` (empty) -> render empty
- `MSG.STATE` (roster) -> render agents  ✅
- `MSG.METRICS_RESET` -> `handleMetricsReset()` (media/main.js ~L8141) runs:
      lastMetrics = [];
      renderMetrics([]);
      renderDelegationStats([]);
  -> **blanks the metrics table that step 2 just populated.** ❌  Agents vanish.

The metrics table is authoritatively driven by `MSG.STATE` (host runtime). The
webview's own `lastMetrics = [] / renderMetrics([])` is redundant AND arrives
after the re-seed, so it wins and leaves the table empty.

## Fix (preferred — webview)
In `handleMetricsReset()` remove the metrics-table clear; let `MSG.STATE` from
the host's `runtime.reset()` + roster re-seed drive the table (it already leaves
the roster with zeroed stats). Keep the world/badge-state clear and
`renderSettings()`.

    function handleMetricsReset(msg) {
      if (msg.ok) {
        // DO NOT clear the metrics table here — the host has already reset the
        // runtime and re-seeded the roster; MSG.STATE drives this area and
        // arrives before this ack. Clearing here races with and clobbers it.
        // (removed: lastMetrics = []; renderMetrics([]); renderDelegationStats([]);)
        renderSettings();
        // ...existing world/badge/rebirth reset + setState purge stays...
      } else if (dangerStatusEl) {
        ...
      }
    }

## Alternative fix (host)
Post `MSG.METRICS_RESET` BEFORE `this._runtime.reset()` + re-seed, so the final
`MSG.STATE` (roster) is the last message the webview receives and wins. Less
clean — it relies on message ordering rather than removing the double-owner.

## Secondary check (separate failure mode)
The re-seed reads `loadAgentRoster(path.join(root, ".claude", "agents"))` where
`root = this._projectRoot()`. If the resolved root has no `.claude/agents`
(e.g., a workspace that isn't a Claude project), the roster is empty and the
table is legitimately blank after reset. Verify the resolved root matches the
panel window's project and contains the agent files; consider logging/warning
when `loadAgentRoster` returns empty during reset.

## Verification
- [ ] With agents visible, Reset -> metrics table shows the SAME agents with
      0 tasks / 0 tokens / 0 time (NOT empty).
- [ ] Badges/build objects still reset to 0 (world-state fix intact).
- [ ] Reload window -> roster present, stats still 0.
- [ ] Reset in a workspace WITH `.claude/agents` re-seeds; note behavior in one
      without (expected empty).
