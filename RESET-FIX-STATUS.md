# Status: "Reset session metrics" still not clearing badges/builds — why the current fix is necessary but insufficient

## TL;DR
The webview-side fix to `handleMetricsReset` is present and looks correct. It is
**not enough on its own**, and in the reporter's environment the reset failed for
two operational reasons:
1. The fix is only running in the F5 **Extension Development Host** (source =
   0.0.243). The **installed & active** extension is **0.0.242**, which has the
   OLD reset code. Any normal window ran the un-fixed path.
2. The host-side truncation never ran against the panel's activity log — it is
   still **18,560 lines**. Because the badges/builds are re-derived by the HOST
   from that log, they get re-sent to the webview and overwrite the webview's
   local clear on the very next payload / reload.

## Verified state of the code (good)
`media/main.js` `handleMetricsReset(msg)` (~L8141) now, on `msg.ok`, clears:
`unlockedBadgeIds`, `cycleObjectsBuilt`, `cycleRivalsEvicted`, `cyclePeakActive`,
`rebirthCount`, `rebirthBaseline`, `buildBuiltCount`, `buildCurrentProgress`;
purges `vscode.getState().rebirth` via `setState`; and re-renders
(`renderBadgePanel`, `renderRebirthPanel`, `updateBadgeHud`). This correctly
fixes the display + reload-rehydration path. Keep it.

`resolveProjectRoot()` (src/host/vscode/progressScope.ts ~L172) is also correct
(prefers the open workspace; only honors `CLAUDE_PROJECT_DIR` when it matches an
open folder). Keep it.

## Why reset still failed (root causes)

### A. Version / window split (verified)
- `~/.vscode/extensions` contains `0.0.240`, `0.0.241`, `0.0.242`, `0.0.48`.
  `extensions.json` active = **0.0.242**. **There is no 0.0.243 installed.**
- "Seeing v0.0.243" = the Extension Development Host running source, a separate
  window that does NOT change what installed/normal windows use.
- Net: the reset (and projectRoot) fixes only take effect in the dev-host window.
  A Reset clicked in any normal window runs 0.0.242's old metrics-table-only
  reset → badges/builds survive.

### B. Host truncation didn't run against the panel's log (verified symptom)
- `_handleResetMetrics()` (src/host/vscode/panel.ts ~L3615) is supposed to
  `fs.writeFileSync(activityPath, "")`. The panel's log
  `D:\ACode\TycoonAgents\.claude\tycoon\activity.jsonl` is still **18,560 lines**
  — it was never truncated.
- Panel state is **per VS Code window**. Reset only affects the window it's
  clicked in. If Reset was clicked in a different window than the one showing the
  badges (or the modal confirm was dismissed), no truncation happened.

### C. The display-only clear can't hold while the log survives (design)
- Badges/built objects are **derived by the host** from `activity.jsonl`
  (completed-task count drives build progression; badge unlocks derive from
  milestones) and pushed to the webview. If the log is not truncated AND the
  per-scope host stores are not cleared, the next host payload re-populates the
  webview after `handleMetricsReset` cleared it locally. So the webview fix is
  necessary but the **host reset must also actually run and succeed**.

## What to complete / verify in the fix
1. **Package + install — don't validate via dev-host only.**
   Bump version → `vsce package` → `code --install-extension <vsix> --force` →
   FULL restart of VS Code. Confirm the ☰ menu shows the new version **in a
   normal window**, not just the F5 host.
2. **Confirm `_handleResetMetrics` truncates the right log.**
   With the projectRoot fix in place, verify the resolved root equals the panel
   window's workspace, and that `fs.writeFileSync(activityPath, "")` executes
   (add a log line / status ack). Guard the ordering so the roster re-seed and
   any live hook appends can't immediately refill it with stale-derived state.
3. **Confirm the host clears its per-scope durable stores.**
   `_handleResetMetrics` should `removeProjectThemeEntry` for `scopeKey|themeId`
   from badge-unlocks / build-progress / rebirth stores (it does today) so the
   next theme-init does NOT re-send stale unlocks. Verify this runs and that the
   scope key uses the corrected root.
4. **Keep the webview `handleMetricsReset` clear** as belt-and-suspenders for the
   immediate visual + reload path.

## Repro / verification checklist
- [ ] New version actually INSTALLED (in `~/.vscode/extensions`, active in
      `extensions.json`), not just running in the F5 host.
- [ ] Open the target project in a normal window; ☰ shows the new version.
- [ ] Click Settings → Danger zone → Reset session metrics **in that same
      window**; confirm the modal.
- [ ] `.claude/tycoon/activity.jsonl` for that project drops to ~0 lines.
- [ ] Badge medal + built objects go to 0 immediately.
- [ ] Reload the window: still 0 (no rehydration from setState or host stores).

## Environment observed
- Reporter's panel window workspace = `D:\ACode\TycoonAgents` (the plugin's own
  source dir); its `activity.jsonl` = 18,560 lines / ~1,580 completions = the
  "20 badges" + full room. This is that dev project's own accumulated history.
- `D:\Vignetta App` had no tycoon workspace state at all — the panel was never
  open in that window, so none of the reinstall/reload/reset attempts aimed at
  "that project" could have affected the badges.
