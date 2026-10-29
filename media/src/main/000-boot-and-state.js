// Part: 00-boot-and-state
// Boot loader progress/reveal, metrics tab/scope state, project plan section rendering, menu/modal open-close helpers.
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Canvas renderer and panel controller for TycoonAgents webview.
// Receives WorldState from the VS Code extension host via postMessage.

(function () {
  const vscode = acquireVsCodeApi();

  // ── One-time legacy rebirth-cache purge (bug fix: Reset session metrics /
  // reload / upgrade leaking stale badge+build state across sessions) ──────
  // The host is now the authoritative source of scoped badge/build/rebirth
  // state (sent as rebirth_state on THEME_INITIALIZED). A pre-existing
  // per-workspace `rebirth` blob in getState() may be leaked/unscoped from
  // before scoping was introduced. Drop it ONCE per workspace, before the
  // rehydration path (below, on THEME_INITIALIZED) ever reads
  // getState().rebirth as a fallback — guarded by rebirthCacheV2 so it only
  // runs the first time and never interferes with normal persistence after.
  try {
    const _st0 = vscode.getState() || {};
    if (!_st0.rebirthCacheV2) {
      if (_st0.rebirth) delete _st0.rebirth;
      _st0.rebirthCacheV2 = true;
      vscode.setState(_st0);
    }
  } catch (e) { /* best-effort */ }

  // ── Boot loader overlay ────────────────────────────────────────────────
  // Markup lives in the INITIAL HTML (panel.ts _getHtmlForWebview + inline
  // styling in media/style.css) so it paints before this script even runs.
  // From here we only advance/hide it against real boot milestones:
  //   script booted (below)              → 15%  "Connecting…"
  //   THEME_INITIALIZED received         → 45%  "Loading theme…"
  //   background image decoded (onload)  → 75%  "Preparing scene…"
  //   sprite frames ready (render loop)  → 75-99% smoothed, then 100% "Ready"
  // Failsafes: hidden instantly if the onboarding/no-theme setup screen is
  // shown (showSetup()), and a hard 12s timeout in case milestones stall.
  const bootLoaderEl      = /** @type {HTMLElement} */ (document.getElementById("boot-loader"));
  const bootLoaderFillEl  = /** @type {HTMLElement} */ (document.getElementById("boot-loader-fill"));
  const bootLoaderLabelEl = /** @type {HTMLElement} */ (document.getElementById("boot-loader-label"));
  let bootLoaderPct = 0;
  let bootLoaderDone = false;
  /** Set by bootLoaderHideNow (onboarding/setup took over) — never revive. */
  let bootLoaderSuppressed = false;
  /** Pending fade-end timer from bootLoaderComplete, cancellable by revive. */
  let bootLoaderHideTimer = null;
  const bootLoaderStartTs = Date.now();
  /** Revive window: a completion may only be reversed this soon after boot. */
  const BOOT_LOADER_REVIVE_WINDOW_MS = 1000;

  /** setTimeout that won't keep a Node/test process alive; no-op in real browsers where timers are plain numbers. */
  function unrefTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    if (id && typeof id.unref === "function") id.unref();
    return id;
  }

  /** Advance the boot loader toward pct (monotonic — never regresses). */
  function bootLoaderSetProgress(pct, label) {
    if (!bootLoaderEl || bootLoaderDone) return;
    bootLoaderPct = Math.max(bootLoaderPct, pct);
    if (bootLoaderFillEl) bootLoaderFillEl.style.width = bootLoaderPct + "%";
    if (bootLoaderLabelEl && label) bootLoaderLabelEl.textContent = label;
  }

  /** Fill to 100%, fade out (~320ms), then remove from layout. */
  function bootLoaderComplete() {
    if (!bootLoaderEl || bootLoaderDone) return;
    bootLoaderDone = true;
    bootLoaderPct = 100;
    if (bootLoaderFillEl) bootLoaderFillEl.style.width = "100%";
    if (bootLoaderLabelEl) bootLoaderLabelEl.textContent = "Ready";
    bootLoaderEl.classList.add("boot-loader--fade");
    bootLoaderHideTimer = unrefTimeout(() => {
      bootLoaderHideTimer = null;
      if (bootLoaderEl) bootLoaderEl.setAttribute("hidden", "");
    }, 320);
  }

  /** Hide instantly, no fade — used when onboarding/setup takes over, or an error surfaces during boot. */
  function bootLoaderHideNow() {
    if (!bootLoaderEl || bootLoaderDone) return;
    bootLoaderDone = true;
    bootLoaderSuppressed = true;
    bootLoaderEl.classList.remove("boot-loader--fade");
    bootLoaderEl.setAttribute("hidden", "");
  }

  /**
   * Reverse a completion that raced a late THEME_INITIALIZED: if a transient
   * no-theme verdict (THEME_NONE, or the stage-loading window timing out)
   * completed the overlay and the real theme arrives a beat later, re-show it
   * at full opacity — but only while it's still mid-fade, or within
   * BOOT_LOADER_REVIVE_WINDOW_MS of boot (a mid-session re-show would jar).
   * Never revives over onboarding/setup (bootLoaderSuppressed).
   */
  function bootLoaderRevive() {
    if (!bootLoaderEl || !bootLoaderDone || bootLoaderSuppressed) return;
    const stillFading = !bootLoaderEl.hasAttribute("hidden");
    const withinBootWindow = Date.now() - bootLoaderStartTs < BOOT_LOADER_REVIVE_WINDOW_MS;
    if (!stillFading && !withinBootWindow) return;
    if (bootLoaderHideTimer !== null) {
      clearTimeout(bootLoaderHideTimer);
      bootLoaderHideTimer = null;
    }
    bootLoaderDone = false;
    bootLoaderEl.classList.remove("boot-loader--fade");
    bootLoaderEl.removeAttribute("hidden");
    // Roll the bar back from the forced 100% to the theme milestone so the
    // ongoing 45→99% progress updates read sensibly again.
    bootLoaderPct = Math.min(bootLoaderPct, 45);
    if (bootLoaderFillEl) bootLoaderFillEl.style.width = bootLoaderPct + "%";
    if (bootLoaderLabelEl) bootLoaderLabelEl.textContent = "Loading theme…";
  }

  bootLoaderSetProgress(15, "Connecting…");
  unrefTimeout(bootLoaderComplete, 12000);
  // Safety cap: if the host never answers with THEME_INITIALIZED/THEME_NONE at
  // all, don't leave the stage's theme state stuck 'pending' forever (which
  // would otherwise hold the plain dark fill indefinitely once bootLoaderComplete's
  // 12s hard timeout above force-hides the loader). Fall back to the 'none'
  // verdict so the stage hands off to the normal no-theme placeholder scene.
  unrefTimeout(() => {
    if (themeStageState === "pending") {
      console.warn("TycoonAgents: theme state still pending after 15s, falling back to 'none'");
      themeStageState = "none";
    }
  }, 15000);

  // ── Resize handle: drag to control metrics panel height ─────────

  const metricsPanelEl = /** @type {HTMLElement} */ (document.getElementById("metrics-panel"));
  const resizeHandleEl = /** @type {HTMLElement} */ (document.getElementById("resize-handle"));

  // ── Project Plan (optional feature) — hosted as a tab next to Metrics ──
  const metricsBodyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-body"));
  const metricsTabsEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tabs"));
  const metricsTabBtnEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tab-btn"));
  const planTabBtnEl = /** @type {HTMLElement} */ (document.getElementById("plan-tab-btn"));
  const projectPlanBodyEl = /** @type {HTMLElement} */ (document.getElementById("project-plan-body"));
  // Delegation tab (promoted out of #metrics-body into its own peer panel).
  const delegationTabBtnEl = /** @type {HTMLElement} */ (document.getElementById("delegation-tab-btn"));
  const delegationStatsBodyEl = /** @type {HTMLElement} */ (document.getElementById("delegation-stats"));
  // Metrics tab scope toggle (0.0.528): "This session" vs "All time" — see
  // setMetricsScope()/updateMetricsScopeUI() and currentScopeMetrics().
  const metricsScopeSessionEl = /** @type {HTMLInputElement} */ (document.getElementById("metrics-scope-session"));
  const metricsScopeAllEl = /** @type {HTMLInputElement} */ (document.getElementById("metrics-scope-all"));
  const metricsScopeCaptionEl = /** @type {HTMLElement} */ (document.getElementById("metrics-scope-caption"));
  const metricsColTokensEl = /** @type {HTMLElement} */ (document.getElementById("metrics-col-tokens"));

  // The #metrics-table "Tokens/min" column header (static HTML in panel.ts) now
  // shows a dimensionless cost-ratio-vs-orchestrator lens instead — relabel it
  // from here so the header stays in sync without touching panel.ts.
  (function relabelMetricsStatusColumnHeader() {
    const th = document.querySelector("#metrics-table thead th:nth-child(2)");
    if (th) {
      th.textContent = "Model";
      th.title = "The model each agent runs on. Hover a pill for the full model id, billing type and, where it applies, a price estimate against the orchestrator's model. The bar behind it shows tasks completed, relative to the agent with the most.";
    }
  })();

  /** Whether the user's project has the optional Project Plan feature turned on (from PLAN_STATE.enabled). Default false so nothing new shows unless the host confirms it's on. */
  let projectPlanEnabled = false;
  /** Last plan snapshot from PLAN_STATE.plan (null = feature off, or on with no plan.json yet). @type {null|{version:number,title:string,phases:Array<Object>,tasks:Array<Object>,currentPhaseId:(string|null),currentTaskId:(string|null)}} */
  let currentProjectPlan = null;
  /** Completed-and-approved plans the host has archived (PLAN_STATE.archivedPlans, 0.0.340+), newest-first as sent — never re-sorted here. Always an array (host sends [] when disabled/no-root/none archived yet); defensively defaulted again on receipt in case a standalone host omits the field. @type {Array<{id:string,title:string,phaseCount:number,taskCount:number,doneCount:number,skippedCount:number,archivedAt:number}>} */
  let currentArchivedPlans = [];
  /** Whether plan.json parsed successfully (from PLAN_STATE.planReadable). `undefined` from an older/standalone host means "readable" (back-compat), so this is never left as anything but a boolean. */
  let currentPlanReadable = true;
  /** Parse/read error message for a corrupt plan.json (PLAN_STATE.planError), shown in the corrupt-state card. Empty string when not applicable. */
  let currentPlanError = "";
  /** Whether the host found a restorable backup of plan.json (PLAN_STATE.hasBackup) to offer via the "Restore last good" button. */
  let currentPlanHasBackup = false;
  /** Which tab is visible in the metrics panel: "metrics" (default), "plan", or "delegation". The plan tab is only offered while projectPlanEnabled is true; the delegation tab only while delegationStatsHasData is true. Restored from webview state so it survives reloads. */
  let activeMetricsTab = "metrics";
  /** Whether the Delegation tab currently has anything worth showing — set by renderDelegationStats() from state.modeStats + lastMetrics. Gates the Delegation tab button the same way projectPlanEnabled gates the Project Plan button, so the bar never offers an empty panel. */
  let delegationStatsHasData = false;
  /** Reference to the Settings screen's Project Plan checkbox, kept live so a PLAN_STATE update can sync its checked state without a full renderSettings() re-render. */
  let projectPlanCheckboxEl = null;

  /**
   * Which array the Metrics tab's TABLE currently displays: "all" (cumulative
   * — totals since the last metrics reset) or "session" (current Claude Code
   * session only). DEFAULT "all" so upgrading users see the exact same
   * numbers they always have — see currentScopeMetrics()/setMetricsScope().
   * Deliberately separate from `lastMetrics`, which always stays the
   * CUMULATIVE array — the Delegation tab, Settings agent rows, and the
   * roster-strip chips all read `lastMetrics` directly and must never change
   * just because the Metrics tab's own scope toggle was flipped (see Part 3
   * of the 0.0.528 session-scoping work: the Delegation tab states its own
   * scope but has no toggle).
   */
  let metricsScope = "all";
  /**
   * Last `sessionMetrics` payload from MSG.STATE (0.0.528, see panel.ts's
   * _postStateUpdate): `{available:true,sessionId,agentMetrics}` when the
   * current session has been identified, or `{available:false,reason}`
   * otherwise. Starts unavailable so the "This session" radio is disabled
   * until the first state push confirms otherwise — never renders a
   * fabricated "0 tokens this session".
   */
  let lastSessionMetrics = { available: false, reason: "Waiting for the first state update…" };
  /** Advisory-only threshold (ms): how long with no agent activity before the active task card shows a "may be stalled" note. Deterministic, no AI involved — purely a staleness signal off state.lastActivityAt. Overridable at runtime via window.TYCOON_STALL_MS (set by tests, or by a host-injected setting) so the value need not be hardcoded per install. */
  const DEFAULT_STALL_MS = 20 * 60 * 1000;
  const STALL_MS = (typeof window !== "undefined" && typeof window.TYCOON_STALL_MS === "number" && window.TYCOON_STALL_MS > 0)
    ? window.TYCOON_STALL_MS
    : DEFAULT_STALL_MS;
  /** Last computed isPlanStalled() result, used by the 1s ticker to re-render the plan section only when the stall state actually flips (not every tick). */
  let lastPlanStallState = false;

  (function restoreActiveMetricsTab() {
    const saved = vscode.getState();
    if (saved && (saved.activeMetricsTab === "plan" || saved.activeMetricsTab === "delegation")) {
      activeMetricsTab = saved.activeMetricsTab;
    }
  })();

  /** Persist the active metrics tab into the same webview state blob used for metricsHeight/rosterOrder/teamExpanded/etc. */
  function saveActiveMetricsTab() {
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, activeMetricsTab });
  }

  /**
   * No-op kept for its existing call sites (tab switch, plan re-render,
   * resize-drag). Used to pixel-lock #project-plan-body's height to
   * #metrics-body's natural (often much shorter) height on every call, which
   * capped the plan list to a short scroll box and left dead space below it
   * down to #metrics-panel's actual bottom edge — a layout bug. Fixed by
   * letting CSS handle it instead: .project-plan-body is now flex:1
   * min-height:0 (see media/style.css), so it stretches to fill whatever
   * height #metrics-panel already has on its own, with no JS involved.
   */
  function syncProjectPlanBodyHeight() {}

  /**
   * Reflect (activeMetricsTab, projectPlanEnabled, delegationStatsHasData)
   * onto the tab bar + content visibility. The whole tab bar is hidden only
   * when NEITHER the Plan nor the Delegation tab has anything to offer —
   * per the gating requirement, never a lone/empty tab bar with just
   * "Metrics" in it. When only one of the two optional tabs is available,
   * the bar shows with that one button (its sibling button individually
   * hidden) alongside Metrics.
   */
  function updateMetricsTabsUI() {
    if (!metricsTabsEl || !metricsBodyEl || !projectPlanBodyEl || !delegationStatsBodyEl) return;
    const showPlanTab = projectPlanEnabled;
    const showDelegationTab = delegationStatsHasData;
    if (!showPlanTab && !showDelegationTab) {
      metricsTabsEl.hidden = true;
      metricsBodyEl.hidden = false;
      projectPlanBodyEl.hidden = true;
      delegationStatsBodyEl.hidden = true;
      return;
    }
    metricsTabsEl.hidden = false;
    if (planTabBtnEl) planTabBtnEl.hidden = !showPlanTab;
    if (delegationTabBtnEl) delegationTabBtnEl.hidden = !showDelegationTab;
    // Fall back to Metrics if the active tab points at a panel that just
    // became unavailable (feature toggled off / data disappeared).
    if (activeMetricsTab === "plan" && !showPlanTab) activeMetricsTab = "metrics";
    if (activeMetricsTab === "delegation" && !showDelegationTab) activeMetricsTab = "metrics";
    const onPlan = activeMetricsTab === "plan";
    const onDelegation = activeMetricsTab === "delegation";
    const onMetrics = !onPlan && !onDelegation;
    metricsBodyEl.hidden = !onMetrics;
    projectPlanBodyEl.hidden = !onPlan;
    delegationStatsBodyEl.hidden = !onDelegation;
    if (metricsTabBtnEl) {
      metricsTabBtnEl.classList.toggle("metrics-tab-btn--active", onMetrics);
      metricsTabBtnEl.setAttribute("aria-selected", String(onMetrics));
    }
    if (planTabBtnEl) {
      planTabBtnEl.classList.toggle("metrics-tab-btn--active", onPlan);
      planTabBtnEl.setAttribute("aria-selected", String(onPlan));
    }
    if (delegationTabBtnEl) {
      delegationTabBtnEl.classList.toggle("metrics-tab-btn--active", onDelegation);
      delegationTabBtnEl.setAttribute("aria-selected", String(onDelegation));
    }
  }

  /** Switch the visible metrics-panel tab and persist the choice. */
  function setActiveMetricsTab(tab) {
    activeMetricsTab = tab === "plan" ? "plan" : tab === "delegation" ? "delegation" : "metrics";
    saveActiveMetricsTab();
    syncProjectPlanBodyHeight();
    updateMetricsTabsUI();
  }

  if (metricsTabBtnEl) metricsTabBtnEl.addEventListener("click", () => setActiveMetricsTab("metrics"));
  if (planTabBtnEl) planTabBtnEl.addEventListener("click", () => setActiveMetricsTab("plan"));
  if (delegationTabBtnEl) delegationTabBtnEl.addEventListener("click", () => setActiveMetricsTab("delegation"));

  // Paint the correct initial state before the first PLAN_STATE reply arrives
  // (projectPlanEnabled defaults false, so this just hides the tab bar).
  updateMetricsTabsUI();

  // ── Metrics tab scope toggle: "This session" vs "All time" (0.0.528) ──
  // Fixes the bug class where a correct-but-unlabelled cumulative token total
  // read as "this session" to a reasonable user. See renderMetrics()/
  // renderMetricsTable() below for how metricsScope actually changes what's
  // painted; lastMetrics (the cumulative array used by the Delegation tab,
  // Settings agent rows, and roster-strip chips) is never affected by this
  // toggle.

  /**
   * The agentMetrics array the Metrics table should display right now, per
   * `metricsScope`. Falls back to the cumulative array (`lastMetrics`)
   * whenever "session" is selected but unavailable — updateMetricsScopeUI()
   * is responsible for flipping metricsScope back to "all" in that case, so
   * this is a defensive fallback, not the primary guard.
   */
  function currentScopeMetrics() {
    if (
      metricsScope === "session" &&
      lastSessionMetrics &&
      lastSessionMetrics.available &&
      Array.isArray(lastSessionMetrics.agentMetrics)
    ) {
      return lastSessionMetrics.agentMetrics;
    }
    return lastMetrics;
  }

  /**
   * Reflect (metricsScope, lastSessionMetrics) onto the toggle radios, the
   * Tokens column header, and the always-visible scope caption. The active
   * scope is stated in TWO places at once (header + caption) — never only
   * implied by which radio happens to be checked — and "This session" is
   * disabled with a reason (not hidden, not shown with fabricated zeros)
   * whenever lastSessionMetrics.available is false.
   */
  function updateMetricsScopeUI() {
    const available = !!(lastSessionMetrics && lastSessionMetrics.available);
    const reason = (lastSessionMetrics && lastSessionMetrics.reason) || "Session data isn't available yet.";

    // If session scope just became unavailable while selected, fall back to
    // "all" rather than leaving the table on a scope that can no longer be
    // reflected honestly.
    if (!available && metricsScope === "session") {
      metricsScope = "all";
    }

    if (metricsScopeSessionEl) {
      metricsScopeSessionEl.disabled = !available;
      metricsScopeSessionEl.title = available ? "" : reason;
      metricsScopeSessionEl.checked = metricsScope === "session";
    }
    if (metricsScopeAllEl) {
      metricsScopeAllEl.checked = metricsScope === "all";
    }
    if (metricsColTokensEl) {
      metricsColTokensEl.textContent = "Tokens";
      metricsColTokensEl.title =
        "Billed context tokens summed over every turn (input, output, cache writes). Cache reads are shown separately and cost about a tenth of input. " +
        (metricsScope === "session"
          ? "Scope: this session only."
          : "Scope: all time, since the last metrics reset.");
      metricsColTokensEl.setAttribute(
        "aria-label",
        metricsScope === "session" ? "Tokens used this session" : "Tokens used all time"
      );
    }
    if (metricsScopeCaptionEl) {
      metricsScopeCaptionEl.textContent =
        metricsScope === "session"
          ? "Showing this session only — activity from the current Claude Code session (sessionId " +
            (lastSessionMetrics.sessionId || "unknown") +
            ")."
          : "Showing all time — totals since the last metrics reset." +
            (available ? "" : " (\"This session\" is unavailable: " + reason + ")");
    }
  }

  /** Switch the Metrics table's scope and re-render it immediately. */
  function setMetricsScope(scope) {
    metricsScope = scope === "session" ? "session" : "all";
    updateMetricsScopeUI();
    renderMetricsTable(currentScopeMetrics());
  }

  if (metricsScopeSessionEl) {
    metricsScopeSessionEl.addEventListener("change", () => {
      if (metricsScopeSessionEl.checked) setMetricsScope("session");
    });
  }
  if (metricsScopeAllEl) {
    metricsScopeAllEl.addEventListener("change", () => {
      if (metricsScopeAllEl.checked) setMetricsScope("all");
    });
  }
  // Paint the initial (disabled, "all") state before the first MSG.STATE push.
  updateMetricsScopeUI();

  /** True when an earlier phase (lower num) still has a pending gate — mirrors src/host/vscode/projectPlan.ts's isPhaseUnblocked for read-only "locked" styling. No state is mutated client-side; the host is the source of truth. */
  function isProjectPlanPhaseLocked(plan, phase) {
    return plan.phases.some((p) => p.num < phase.num && p.gate !== "approved");
  }

  /** @param {string} status @returns {string} */
  function projectPlanTaskStatusLabel(status) {
    switch (status) {
      case "pending": return "Pending";
      case "active": return "Active";
      case "verifying": return "Verifying";
      case "done": return "Done";
      case "needs_fix": return "Needs fix";
      case "skipped": return "Skipped";
      case "blocked": return "Blocked";
      default: return String(status || "");
    }
  }

  /**
   * Format a past epoch ms timestamp as a short relative "quiet for" string
   * ("just now", "3 min", "1 hr 12 min"), never a bare clock time — a bare
   * clock reads as "recent" hours after the fact once the user's mental
   * clock has moved on. Falls back to an absolute local time (with the date
   * when it isn't today) only as a parenthetical, and only when the caller
   * asks for it via `withAbsolute`.
   * @param {number} sinceMs @param {boolean} [withAbsolute]
   */
  function formatQuietFor(sinceMs, withAbsolute) {
    const deltaMs = Math.max(0, Date.now() - sinceMs);
    const minutes = Math.floor(deltaMs / 60000);
    let rel;
    if (minutes < 1) {
      rel = "just now";
    } else if (minutes < 60) {
      rel = minutes + " min";
    } else {
      const hrs = Math.floor(minutes / 60);
      const mins = minutes % 60;
      rel = hrs + " hr" + (mins > 0 ? " " + mins + " min" : "");
    }
    if (!withAbsolute) return rel;
    const d = new Date(sinceMs);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const abs = sameDay ? d.toLocaleTimeString() : d.toLocaleString();
    return rel + " (since " + abs + ")";
  }

  /** Build an OVERRIDE_TASK action button that posts immediately on click (no confirmation gate). @param {string} label @param {"approve"|"retry"|"skip"} action @param {string} taskId */
  function buildProjectPlanTaskButton(label, action, taskId) {
    const btn = document.createElement("button");
    btn.className = "skill-btn plan-task-btn plan-task-btn--" + action;
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      vscode.postMessage({ type: "OVERRIDE_TASK", taskId, action });
    });
    return btn;
  }

  /**
   * Build a Retry/Skip button that, when the task is still "active", does
   * NOT post OVERRIDE_TASK on click — it replaces the actions row with an
   * inline confirm (text + "<Label> anyway" + "Cancel"), following the same
   * no-window.confirm pattern as confirmThemePlanOverwrite
   * (010-modals-badges-rebirth.js): `window.confirm` is unreliable/a no-op
   * in the sandboxed VS Code webview (no `allow-modals` on the iframe), so
   * a real dialog can silently never appear, leaving the click looking like
   * a no-op. Cancel restores the original actions row untouched.
   * @param {string} label @param {"retry"|"skip"} action @param {import("../../../src/core/state").ProjectPlanTask} task @param {HTMLElement} actionsEl the actions row to swap content in/out of
   */
  function buildProjectPlanConfirmButton(label, action, task, actionsEl) {
    const btn = document.createElement("button");
    btn.className = "skill-btn plan-task-btn plan-task-btn--" + action;
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (task.status !== "active") {
        btn.disabled = true;
        vscode.postMessage({ type: "OVERRIDE_TASK", taskId: task.id, action });
        return;
      }
      const originalChildren = Array.from(actionsEl.childNodes);
      const verb = action === "retry" ? "retrying may start duplicate work" : "skipping may abandon in-progress work";

      const confirmWrap = document.createElement("div");
      confirmWrap.className = "plan-task-confirm";
      const note = document.createElement("span");
      note.className = "plan-task-confirm-note";
      note.textContent = "This task is still marked active — " + verb + ". ";
      confirmWrap.appendChild(note);

      const proceedBtn = document.createElement("button");
      proceedBtn.type = "button";
      proceedBtn.className = "skill-btn plan-task-btn plan-task-btn--" + action;
      proceedBtn.textContent = label + " anyway";
      proceedBtn.addEventListener("click", () => {
        proceedBtn.disabled = true;
        cancelBtn.disabled = true;
        vscode.postMessage({ type: "OVERRIDE_TASK", taskId: task.id, action });
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "skill-btn secondary plan-task-btn plan-task-btn--cancel";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => {
        actionsEl.replaceChildren(...originalChildren);
      });

      confirmWrap.appendChild(proceedBtn);
      confirmWrap.appendChild(cancelBtn);
      actionsEl.replaceChildren(confirmWrap);
    });
    return btn;
  }

  /** Deterministic (no AI) advisory check: true only when the plan is on, readable, has an active task, and the host-reported state.lastActivityAt is older than STALL_MS. Guards every access so a malformed/older-host state can never throw. */
  function isPlanStalled() {
    try {
      if (!projectPlanEnabled) return false;
      if (currentPlanReadable === false) return false;
      if (!currentProjectPlan || !Array.isArray(currentProjectPlan.tasks)) return false;
      const hasActiveTask = currentProjectPlan.tasks.some((t) => t && t.status === "active");
      if (!hasActiveTask) return false;
      if (!state || typeof state.lastActivityAt !== "number") return false;
      return Date.now() - state.lastActivityAt > STALL_MS;
    } catch (_e) {
      return false;
    }
  }

  /** Build one task card (title, status badge, verify attempts, collapsible detail/acceptance criteria, contextual action buttons). */
  function buildProjectPlanTaskCard(task) {
    const card = document.createElement("div");
    card.className = "plan-task-card";
    card.dataset.taskId = task.id;

    const head = document.createElement("div");
    head.className = "plan-task-head";

    const title = document.createElement("span");
    title.className = "plan-task-title";
    title.textContent = task.title || task.id;
    head.appendChild(title);

    const badge = document.createElement("span");
    badge.className = "plan-status-badge plan-status-badge--" + task.status;
    badge.textContent = projectPlanTaskStatusLabel(task.status);
    head.appendChild(badge);

    if (task.verifyAttempts > 0) {
      const attempts = document.createElement("span");
      attempts.className = "plan-task-attempts";
      attempts.textContent = "verify ×" + task.verifyAttempts;
      head.appendChild(attempts);
    }

    card.appendChild(head);

    if (task.detail || (task.acceptanceCriteria && task.acceptanceCriteria.length)) {
      const details = document.createElement("details");
      details.className = "plan-task-details";
      const summary = document.createElement("summary");
      summary.textContent = "Details";
      details.appendChild(summary);
      if (task.detail) {
        const detailP = document.createElement("p");
        detailP.className = "plan-task-detail";
        detailP.textContent = task.detail;
        details.appendChild(detailP);
      }
      if (task.acceptanceCriteria && task.acceptanceCriteria.length) {
        const ul = document.createElement("ul");
        ul.className = "plan-task-criteria";
        for (const criterion of task.acceptanceCriteria) {
          const li = document.createElement("li");
          li.textContent = criterion;
          ul.appendChild(li);
        }
        details.appendChild(ul);
      }
      card.appendChild(details);
    }

    if (task.status === "active" && isPlanStalled()) {
      const stallNote = document.createElement("div");
      stallNote.className = "plan-stall-note";
      // Activity is tracked per-project, not per-task (no reliable taskId on
      // hook records yet — see mapHookRecord.ts), so the note says so rather
      // than implying this specific task went quiet.
      stallNote.textContent =
        "⏸ Quiet for " + formatQuietFor(state.lastActivityAt) +
        " (project-wide) — agents may still be working. Check the terminal before retrying. " +
        "Ask Claude to \"resume the project plan\", or run /project-plan.";
      card.appendChild(stallNote);
    }

    const actions = document.createElement("div");
    actions.className = "plan-task-actions";
    const showRetrySkip = task.status === "active" || task.status === "verifying"
      || task.status === "needs_fix" || task.status === "blocked";
    const showApprove = task.status === "needs_fix";
    if (showApprove) actions.appendChild(buildProjectPlanTaskButton("Approve", "approve", task.id));
    if (showRetrySkip) {
      actions.appendChild(buildProjectPlanConfirmButton("Retry", "retry", task, actions));
      actions.appendChild(buildProjectPlanConfirmButton("Skip", "skip", task, actions));
    }
    if (actions.childElementCount > 0) card.appendChild(actions);

    return card;
  }

  /** Build the corrupt-plan warning card shown instead of phase/task cards when currentPlanReadable is false. Never renders stale task cards from the last-known-good `currentProjectPlan` — a finished task frozen mid-render (e.g. "active" with Retry/Skip) would be misleading once the host can no longer confirm the file's real state. */
  function buildProjectPlanCorruptCard() {
    const card = document.createElement("div");
    card.className = "plan-corrupt-card";

    const heading = document.createElement("div");
    heading.className = "plan-corrupt-heading";
    heading.textContent = "⚠ Plan file unreadable";
    card.appendChild(heading);

    const body = document.createElement("p");
    body.className = "plan-corrupt-body";
    body.textContent = ".claude/tycoon/plan.json is corrupt and couldn't be parsed.";
    card.appendChild(body);

    if (currentPlanError) {
      const errorP = document.createElement("p");
      errorP.className = "plan-corrupt-error";
      errorP.textContent = currentPlanError;
      card.appendChild(errorP);
    }

    const guidance = document.createElement("p");
    guidance.className = "plan-corrupt-guidance";
    guidance.textContent = "Ask Claude to \"resume the project plan\", or run /project-plan — it will repair and rewrite the file. Or restore the last good copy.";
    card.appendChild(guidance);

    if (currentPlanHasBackup) {
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "skill-btn plan-corrupt-restore-btn";
      restoreBtn.type = "button";
      restoreBtn.textContent = "Restore last good";
      restoreBtn.addEventListener("click", () => {
        restoreBtn.disabled = true;
        vscode.postMessage({ type: "RESTORE_PLAN_BACKUP" });
      });
      card.appendChild(restoreBtn);
    }

    return card;
  }

  /** Rebuild the Project Plan tab content from (projectPlanEnabled, currentProjectPlan). Falls back to the Metrics tab and hides the tab bar entirely when the feature is off. */
  function renderProjectPlanSection() {
    if (!projectPlanBodyEl) return;
    if (!projectPlanEnabled) {
      projectPlanBodyEl.innerHTML = "";
      if (activeMetricsTab === "plan") {
        setActiveMetricsTab("metrics"); // also refreshes tab bar/content visibility
      } else {
        updateMetricsTabsUI();
      }
      return;
    }
    updateMetricsTabsUI();
    projectPlanBodyEl.innerHTML = "";

    if (currentPlanReadable === false) {
      // Corrupt/stalled state: render the warning card only. Do NOT fall
      // through to the normal phase/task rendering below — currentProjectPlan
      // still holds the last-known-good snapshot, and rendering it here would
      // show stale task cards (e.g. a finished task frozen as "active" with
      // live Retry/Skip buttons) as if they reflected the real file.
      projectPlanBodyEl.appendChild(buildProjectPlanCorruptCard());
      syncProjectPlanBodyHeight();
      return;
    }

    const plan = currentProjectPlan;
    if (!plan) {
      const empty = document.createElement("p");
      empty.className = "plan-empty";
      empty.textContent = "No plan yet — generate one with the project-plan skill.";
      projectPlanBodyEl.appendChild(empty);
      renderArchivedPlansSection();
      syncProjectPlanBodyHeight();
      return;
    }

    const tasksById = {};
    for (const t of plan.tasks) tasksById[t.id] = t;

    const phases = plan.phases.slice().sort((a, b) => a.num - b.num);
    for (const phase of phases) {
      const phaseEl = document.createElement("div");
      phaseEl.className = "plan-phase";
      const locked = isProjectPlanPhaseLocked(plan, phase);
      if (locked) phaseEl.classList.add("plan-phase--locked");

      const phaseHead = document.createElement("div");
      phaseHead.className = "plan-phase-head";
      const phaseTitle = document.createElement("span");
      phaseTitle.className = "plan-phase-title";
      phaseTitle.textContent = `Phase ${phase.num}: ${phase.name}`;
      phaseHead.appendChild(phaseTitle);
      const gateBadge = document.createElement("span");
      gateBadge.className = "plan-gate-badge plan-gate-badge--" + phase.gate;
      gateBadge.textContent = phase.gate === "approved" ? "Approved" : "Pending";
      phaseHead.appendChild(gateBadge);
      if (locked) {
        const lockBadge = document.createElement("span");
        lockBadge.className = "plan-lock-badge";
        lockBadge.textContent = "Locked";
        phaseHead.appendChild(lockBadge);
      }
      phaseEl.appendChild(phaseHead);

      if (phase.goal) {
        const goalEl = document.createElement("div");
        goalEl.className = "plan-phase-goal";
        goalEl.textContent = phase.goal;
        phaseEl.appendChild(goalEl);
      }

      const tasksWrap = document.createElement("div");
      tasksWrap.className = "plan-phase-tasks";
      for (const taskId of phase.taskIds) {
        const task = tasksById[taskId];
        if (task) tasksWrap.appendChild(buildProjectPlanTaskCard(task));
      }
      phaseEl.appendChild(tasksWrap);

      const allTasksDone = phase.taskIds.every((tid) => {
        const t = tasksById[tid];
        return t && (t.status === "done" || t.status === "skipped");
      });
      if (phase.gate === "pending") {
        const approveBtn = document.createElement("button");
        approveBtn.className = "skill-btn plan-approve-phase-btn";
        approveBtn.type = "button";
        approveBtn.textContent = "Approve phase";
        approveBtn.disabled = !allTasksDone;
        approveBtn.addEventListener("click", () => {
          approveBtn.disabled = true;
          vscode.postMessage({ type: "APPROVE_PHASE", phaseId: phase.id });
        });
        phaseEl.appendChild(approveBtn);
      }

      projectPlanBodyEl.appendChild(phaseEl);
    }

    // Stats footer: phase-gate progress + task status breakdown.
    if (plan.phases.length > 0 || plan.tasks.length > 0) {
      const approvedPhases = plan.phases.filter((p) => p.gate === "approved").length;
      const statusCounts = {};
      for (const t of plan.tasks) statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      const statusOrder = ["done", "active", "verifying", "pending", "needs_fix", "blocked", "skipped"];
      const statusLabel = { done: "done", active: "active", verifying: "verifying", pending: "pending", needs_fix: "needs-fix", blocked: "blocked", skipped: "skipped" };
      const parts = [];
      for (const s of statusOrder) {
        if (statusCounts[s]) parts.push(`${statusCounts[s]} ${statusLabel[s]}`);
      }

      const footer = document.createElement("div");
      footer.className = "plan-stats-footer";

      const phasesLine = document.createElement("div");
      phasesLine.className = "plan-stats-line";
      phasesLine.textContent = `Phases: ${approvedPhases}/${plan.phases.length} approved`;
      footer.appendChild(phasesLine);

      const tasksLine = document.createElement("div");
      tasksLine.className = "plan-stats-line";
      tasksLine.textContent = `Tasks: ${plan.tasks.length} total` + (parts.length ? ` · ${parts.join(" · ")}` : "");
      footer.appendChild(tasksLine);

      projectPlanBodyEl.appendChild(footer);
    }

    renderArchivedPlansSection();
    syncProjectPlanBodyHeight();
  }

  /** Format an ArchivedPlanSummary.archivedAt (epoch ms, possibly fractional) as a compact local date + time string. Returns "" for a missing/invalid value so a malformed entry degrades to just its summary line instead of throwing or printing "Invalid Date". */
  function formatArchivedPlanDate(archivedAt) {
    const ms = typeof archivedAt === "number" ? archivedAt : Number(archivedAt);
    if (!Number.isFinite(ms)) return "";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    const datePart = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${datePart} ${timePart}`;
  }

  /** Compact "N phases · N tasks · N done[ · N skipped]" summary for one archived plan entry. The skipped clause is omitted entirely when skippedCount is 0 (per spec — don't clutter the common all-done case). */
  function formatArchivedPlanSummary(entry) {
    const phaseCount = Number(entry.phaseCount) || 0;
    const taskCount = Number(entry.taskCount) || 0;
    const doneCount = Number(entry.doneCount) || 0;
    const skippedCount = Number(entry.skippedCount) || 0;
    let summary = `${phaseCount} phase${phaseCount === 1 ? "" : "s"} · ${taskCount} task${taskCount === 1 ? "" : "s"} · ${doneCount} done`;
    if (skippedCount > 0) summary += ` · ${skippedCount} skipped`;
    return summary;
  }

  /** Append the read-only "Archived Plans" section (PLAN_STATE.archivedPlans, 0.0.340+) to projectPlanBodyEl. Renders NOTHING (no heading, no container) when the list is empty, so the plan tab is visually unchanged for every project until its first plan is archived. Entries are rendered in the order received (host already sorts newest-first) — never re-sorted or reversed here. Must be called only from renderProjectPlanSection(), after projectPlanBodyEl.innerHTML has been cleared for this render pass and while projectPlanEnabled is true. */
  function renderArchivedPlansSection() {
    if (!projectPlanBodyEl) return;
    const archived = Array.isArray(currentArchivedPlans) ? currentArchivedPlans : [];
    if (archived.length === 0) return;

    const section = document.createElement("div");
    section.className = "plan-archived-section";

    const heading = document.createElement("div");
    heading.className = "plan-archived-heading";
    heading.textContent = "Archived Plans";
    section.appendChild(heading);

    const list = document.createElement("div");
    list.className = "plan-archived-list";
    for (const entry of archived) {
      if (!entry) continue;
      const row = document.createElement("div");
      row.className = "plan-archived-row";

      const titleEl = document.createElement("div");
      titleEl.className = "plan-archived-title";
      // textContent only — never innerHTML — so a title containing "<"/"&" can't break rendering.
      titleEl.textContent = entry.title != null ? String(entry.title) : "Untitled plan";
      row.appendChild(titleEl);

      const metaEl = document.createElement("div");
      metaEl.className = "plan-archived-meta";
      const dateStr = formatArchivedPlanDate(entry.archivedAt);
      const summaryStr = formatArchivedPlanSummary(entry);
      metaEl.textContent = dateStr ? `${dateStr} · ${summaryStr}` : summaryStr;
      row.appendChild(metaEl);

      list.appendChild(row);
    }
    section.appendChild(list);
    projectPlanBodyEl.appendChild(section);
  }

  /** Sync the Settings-screen checkbox (if currently rendered) to projectPlanEnabled. */
  function syncProjectPlanSettingsToggle() {
    if (projectPlanCheckboxEl) projectPlanCheckboxEl.checked = projectPlanEnabled;
  }

  const MIN_METRICS_PX = 44;   // header must always stay visible

  /** Apply a metrics panel height in px, clamped to valid range. */
  function applyMetricsHeight(px) {
    const clamped = Math.max(MIN_METRICS_PX, Math.min(px, window.innerHeight));
    metricsPanelEl.style.setProperty("height", `${clamped}px`);
    return clamped;
  }

  /** Persist the current metrics height into webview state. */
  function saveMetricsHeight(px) {
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, metricsHeight: px });
  }

  // Restore saved height before first render to avoid a layout flash.
  (function restoreSavedHeight() {
    const saved = vscode.getState();
    if (saved && typeof saved.metricsHeight === "number") {
      applyMetricsHeight(saved.metricsHeight);
    }
  })();

  // Re-clamp saved px height if the window is resized (e.g. sidebar width change).
  window.addEventListener("resize", () => {
    const saved = vscode.getState();
    if (saved && typeof saved.metricsHeight === "number") {
      applyMetricsHeight(saved.metricsHeight);
    }
  });

  // Pointer-drag on the resize handle.
  resizeHandleEl.addEventListener("pointerdown", (e) => {
    resizeHandleEl.setPointerCapture(e.pointerId);
    resizeHandleEl.classList.add("dragging");

    function onMove(ev) {
      // Metrics height = distance from pointer to bottom of viewport.
      const px = window.innerHeight - ev.clientY;
      applyMetricsHeight(px);
      syncProjectPlanBodyHeight();
    }

    function onUp(ev) {
      const px = window.innerHeight - ev.clientY;
      const clamped = applyMetricsHeight(px);
      saveMetricsHeight(clamped);
      syncProjectPlanBodyHeight();
      resizeHandleEl.classList.remove("dragging");
      resizeHandleEl.removeEventListener("pointermove", onMove);
      resizeHandleEl.removeEventListener("pointerup", onUp);
    }

    resizeHandleEl.addEventListener("pointermove", onMove);
    resizeHandleEl.addEventListener("pointerup", onUp);
  });

  // ── Hamburger menu: scaffold for future panel actions ───────────

  const menuBtnEl     = /** @type {HTMLElement} */ (document.getElementById("menu-btn"));
  const menuPopoverEl = /** @type {HTMLElement} */ (document.getElementById("menu-popover"));

  function openMenu() {
    menuPopoverEl.removeAttribute("hidden");
    menuBtnEl.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    menuPopoverEl.setAttribute("hidden", "");
    menuBtnEl.setAttribute("aria-expanded", "false");
  }

  menuBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuPopoverEl.hasAttribute("hidden")) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  // Close on click outside.
  document.addEventListener("click", (e) => {
    if (!menuPopoverEl.hasAttribute("hidden") &&
        !menuPopoverEl.contains(/** @type {Node} */ (e.target)) &&
        e.target !== menuBtnEl) {
      closeMenu();
    }
  });

  // ── Modal helpers (generic: works for any modal element) ────────

  /**
   * Open a modal element and focus its close button.
   * @param {HTMLElement} modalEl
   * @param {HTMLElement} closeBtnEl
   */
  function openModal(modalEl, closeBtnEl) {
    modalEl.removeAttribute("hidden");
    closeBtnEl.focus();
  }

  /**
   * Close a modal element and return focus to the menu button.
   * @param {HTMLElement} modalEl
   */
  function closeModal(modalEl) {
    modalEl.setAttribute("hidden", "");
    menuBtnEl.focus();
  }

  // ── About modal ─────────────────────────────────────────────────

  const aboutModalEl  = /** @type {HTMLElement} */ (document.getElementById("about-modal"));
  const aboutBackdrop = /** @type {HTMLElement} */ (document.getElementById("about-backdrop"));
  const modalCloseBtn = /** @type {HTMLElement} */ (document.getElementById("modal-close"));
  const menuAboutBtn  = /** @type {HTMLElement} */ (document.getElementById("menu-about"));

  menuAboutBtn.addEventListener("click", () => {
    closeMenu();
    openModal(aboutModalEl, modalCloseBtn);
  });

  modalCloseBtn.addEventListener("click", () => {
    closeModal(aboutModalEl);
  });

  aboutBackdrop.addEventListener("click", () => {
    closeModal(aboutModalEl);
  });

  // ── Skills modal ─────────────────────────────────────────────────

  const skillsModalEl   = /** @type {HTMLElement} */ (document.getElementById("skills-modal"));
  const skillsBackdrop  = /** @type {HTMLElement} */ (document.getElementById("skills-backdrop"));
  const skillsCloseBtn  = /** @type {HTMLElement} */ (document.getElementById("skills-modal-close"));
  const menuCatalogBtn  = /** @type {HTMLElement} */ (document.getElementById("menu-catalog"));
  const skillsListEl    = /** @type {HTMLElement} */ (document.getElementById("skills-list"));

  // ── Catalog tabs (Skills / MCP / Packs) ───────────────────────────
  const tabSkillsBtn = /** @type {HTMLElement} */ (document.getElementById("tab-skills"));
  const tabMcpBtn    = /** @type {HTMLElement} */ (document.getElementById("tab-mcp"));
  const tabPacksBtn  = /** @type {HTMLElement} */ (document.getElementById("tab-packs"));
  // Same one-liner the VS Code host shows as a toast after a local-scope install.
  const NEW_CHAT_HINT = "Start a new Claude chat to load the newly installed MCP servers.";
  const MCP_APPROVAL_NOTE =
    "Claude Code will ask you once to approve the TycoonAgents servers (tycoon, codex, claude-worker, gemini). Choose Approve so delegation can use them.";

  const mcpListEl    = /** @type {HTMLElement} */ (document.getElementById("mcp-list"));
  const packsListEl  = /** @type {HTMLElement} */ (document.getElementById("packs-list"));

  // Tracks whether each catalog has been fetched yet (lazy-load on first view).
  let mcpLoaded = false;
  let packsLoaded = false;

  /**
   * Switch the active catalog tab. The three tabs (skills/mcp/packs) are
   * mutually exclusive — exactly one list is visible at a time.
   * @param {"skills"|"mcp"|"packs"} tab
   */
  function showCatalogTab(tab) {
    /** @type {Array<[HTMLElement|null, HTMLElement|null, string]>} */
    const tabs = [
      [tabSkillsBtn, skillsListEl, "skills"],
      [tabMcpBtn, mcpListEl, "mcp"],
      [tabPacksBtn, packsListEl, "packs"],
    ];
    for (const [btn, list, key] of tabs) {
      const isActive = key === tab;
      if (list) {
        if (isActive) list.removeAttribute("hidden");
        else list.setAttribute("hidden", "");
      }
      if (btn) {
        btn.classList.toggle("catalog-tab--active", isActive);
        btn.setAttribute("aria-selected", String(isActive));
      }
    }
    if (tab === "mcp" && !mcpLoaded) {
      mcpLoaded = true;
      vscode.postMessage({ type: "getMcp" });
    }
    if (tab === "packs" && !packsLoaded) {
      packsLoaded = true;
      vscode.postMessage({ type: "getPacks" });
    }
  }

  if (tabSkillsBtn) {
    tabSkillsBtn.addEventListener("click", () => showCatalogTab("skills"));
  }
  if (tabMcpBtn) {
    tabMcpBtn.addEventListener("click", () => showCatalogTab("mcp"));
  }
  if (tabPacksBtn) {
    tabPacksBtn.addEventListener("click", () => showCatalogTab("packs"));
  }

  if (menuCatalogBtn) {
    menuCatalogBtn.addEventListener("click", () => {
      closeMenu();
      openModal(skillsModalEl, skillsCloseBtn);
      showCatalogTab("packs");
      vscode.postMessage({ type: "getSkills" });
    });
  }

  skillsCloseBtn.addEventListener("click", () => {
    closeModal(skillsModalEl);
  });

  skillsBackdrop.addEventListener("click", () => {
    closeModal(skillsModalEl);
  });

  // Close on Escape — modals take priority; skills modal checked first since
  // it was opened more recently, then about modal, then menu.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (themeBuilderShellModal && !themeBuilderShellModal.hasAttribute("hidden")) {
        closeModal(themeBuilderShellModal);
      } else if (themeSwitchConfirmModalEl && !themeSwitchConfirmModalEl.hasAttribute("hidden")) {
        closeThemeSwitchConfirmModal();
        selectedThemeId = themeSwitchConfirmPreviousId;
        renderThemesList(lastThemesList);
      } else if (resetConfirmModalEl && !resetConfirmModalEl.hasAttribute("hidden")) {
        closeResetConfirmModal();
      } else if (badgeDetailModalEl && !badgeDetailModalEl.hasAttribute("hidden")) {
        closeBadgeDetail();
      } else if (badgeModalEl && !badgeModalEl.hasAttribute("hidden")) {
        closeModal(badgeModalEl);
      } else if (!skillsModalEl.hasAttribute("hidden")) {
        closeModal(skillsModalEl);
      } else if (!aboutModalEl.hasAttribute("hidden")) {
        closeModal(aboutModalEl);
      } else if (!menuPopoverEl.hasAttribute("hidden")) {
        closeMenu();
        menuBtnEl.focus();
      }
    }
  });

  // ── Badge HUD + modal (lower-right silhouette badge icon) ────────────
  // Badges unlock from gameplay counters (buildBuiltCount / rivalsEvictedCount,
  // see updateBadgeUnlocks() below, called every render frame). The HUD button
  // shows how many are unlocked; clicking it opens a panel listing all badges
  // for the current theme (locked = silhouette + progress, unlocked = icon).

  const badgeHudBtn       = /** @type {HTMLElement|null} */ (document.getElementById("badge-hud-btn"));
  const badgeHudCountEl   = badgeHudBtn ? /** @type {HTMLElement|null} */ (badgeHudBtn.querySelector(".badge-hud-count")) : null;
  // Rebirth trophy row: a SIBLING of #badge-hud-btn (see panel.ts), not a
  // child — it must never inherit .badge-hud's positioning context (that's
  // where .badge-hud-dot's top/right offsets live). Updated by
  // updateTrophyRow() below, itself only called from the exact spots
  // rebirthCount changes (doRebirth, THEME_INITIALIZED restore, Reset) —
  // never from the animation loop.
  const trophyRowEl       = /** @type {HTMLElement|null} */ (document.getElementById("trophy-row"));
  // Last count rendered into the HUD; -1 means "not yet shown" so the very
  // first paint (and a rebirth reset, which only ever decreases the count)
  // never trigger the celebratory pop below — only genuine new unlocks do.
  let badgeHudLastCount   = -1;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let badgeHudPopTimer    = null;
  const badgeModalEl      = /** @type {HTMLElement|null} */ (document.getElementById("badge-modal"));
  const badgeBackdropEl   = /** @type {HTMLElement|null} */ (document.getElementById("badge-backdrop"));
  const badgeModalCloseEl = /** @type {HTMLElement|null} */ (document.getElementById("badge-modal-close"));
  const badgeListEl       = /** @type {HTMLElement|null} */ (document.getElementById("badge-list"));

  // Persistent "new achievement" indicator: unlike the transient 600ms pop
  // above, this stays lit (CSS .has-unseen on badgeHudBtn, see style.css)
  // until the player actually opens the badge panel. Persisted through the
  // same vscode.getState()/setState() blob used elsewhere in this file (e.g.
  // metricsHeight, rosterOrder) so an unlock earned right before closing the
  // webview is still flagged as unseen on the next reload.
  let badgeHudUnseen = !!((vscode.getState() || {}).badgeHudUnseen);
  if (badgeHudBtn && badgeHudUnseen) badgeHudBtn.classList.add("has-unseen");

  function persistBadgeHudUnseen(value) {
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, badgeHudUnseen: value });
  }

  // ── Per-badge "new achievement" dots (theme-scoped) ───────────────────────
  // Extends the single aggregate HUD dot above into a dot on each individual
  // NEWLY-unlocked badge card inside the achievements panel, cleared once the
  // player opens the panel (renderBadgePanel draws the dots for that final
  // viewing first — see the badge-hud click handler below). Two maps, keyed
  // by theme_id, persisted through the same vscode.getState()/setState() blob:
  //   badgeUnseenByTheme[themeId] -> badge_ids unlocked but not yet viewed.
  //   badgeKnownByTheme[themeId]  -> badge_ids already accounted for (the
  //     baseline used to detect genuinely NEW unlocks vs. ones the player has
  //     already earned/seen before this feature or in an earlier session —
  //     see THEME_INITIALIZED, which seeds these on first load of a theme so
  //     already-unlocked badges never retroactively grow a dot).
  // unseenBadgeIds/knownBadgeIds are the WORKING sets for the theme currently
  // on stage (currentBadgeThemeId, declared below alongside unlockedBadgeIds).
  let badgeUnseenByTheme = (vscode.getState() || {}).badgeUnseenByTheme || {};
  let badgeKnownByTheme = (vscode.getState() || {}).badgeKnownByTheme || {};
  /** @type {Set<string>} */
  let unseenBadgeIds = new Set();
  /** @type {Set<string>} */
  let knownBadgeIds = new Set();

  function persistBadgePerBadgeState() {
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, badgeUnseenByTheme, badgeKnownByTheme });
  }

  /** Light up the persistent dot for a genuinely new, not-yet-viewed unlock. */
  function setBadgeHudUnseen() {
    badgeHudUnseen = true;
    if (badgeHudBtn) badgeHudBtn.classList.add("has-unseen");
    persistBadgeHudUnseen(true);
  }

  /** Clear the persistent dot — called when the player opens the badge panel. */
  function clearBadgeHudUnseen() {
    if (!badgeHudUnseen) return;
    badgeHudUnseen = false;
    if (badgeHudBtn) badgeHudBtn.classList.remove("has-unseen");
    persistBadgeHudUnseen(false);
  }

  if (badgeHudBtn) {
    badgeHudBtn.addEventListener("click", () => {
      clearBadgeHudUnseen();
      // Draw the panel FIRST (so the per-badge dots earned since the last
      // open are actually visible for this viewing), THEN mark them seen —
      // reordering this would clear unseenBadgeIds before renderBadgePanel
      // reads it and the dots would never appear.
      renderBadgePanel();
      if (currentBadgeThemeId) {
        unseenBadgeIds = new Set();
        badgeUnseenByTheme[currentBadgeThemeId] = [];
        persistBadgePerBadgeState();
      }
      if (badgeModalEl) openModal(badgeModalEl, badgeModalCloseEl || badgeHudBtn);
    });
  }
  if (badgeModalCloseEl) {
    badgeModalCloseEl.addEventListener("click", () => {
      if (badgeModalEl) closeModal(badgeModalEl);
    });
  }
  if (badgeBackdropEl) {
    badgeBackdropEl.addEventListener("click", () => {
      if (badgeModalEl) closeModal(badgeModalEl);
    });
  }

  // ── Handbook launcher (lower-left book icon) ──────────────────────────
  // Always-visible DOM overlay pinned to the bottom-left of #stage-area —
  // the visual counterweight to the badge HUD medallion in the bottom-right.
  // Built entirely here (not in panel.ts) since nothing else currently
  // occupies that corner (the old nav-polygon debug hint was removed — see
  // the comment near walkable_nav_polygon below). Clicking it asks the host
  // to open the handbook; the host-side OPEN_HANDBOOK handler is owned by a
  // separate task.
  (function setupHandbookLauncher() {
    const stageAreaEl = document.getElementById("stage-area");
    if (!stageAreaEl) return;
    const btn = document.createElement("button");
    btn.id = "handbook-hud-btn";
    btn.className = "handbook-hud";
    btn.type = "button";
    btn.setAttribute("aria-label", "Open the TycoonAgents Handbook");
    btn.title = "Open the TycoonAgents Handbook";
    btn.innerHTML =
      '<svg class="handbook-hud-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M12 5.7c-1.7-1.25-4.1-1.9-6.3-1.9-.66 0-1.2.55-1.2 1.2v11.7c0 .66.54 1.15 1.2 1.15 2.05 0 4.3.5 5.8 1.55.3.2.7.2 1 0 1.5-1.05 3.75-1.55 5.8-1.55.66 0 1.2-.49 1.2-1.15V5c0-.65-.54-1.2-1.2-1.2-2.2 0-4.6.65-6.3 1.9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="M12 5.7v13.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
      '</svg>';
    btn.addEventListener("click", () => {
      vscode.postMessage({ type: "OPEN_HANDBOOK" });
    });
    stageAreaEl.appendChild(btn);
  })();

  /**
   * Refresh the lower-right badge HUD button: visible only when the current
   * theme declares >=1 badge; count text = number unlocked so far.
   */
  function updateBadgeHud() {
    if (!badgeHudBtn) return;
    if (!themeBadges || themeBadges.length === 0) {
      badgeHudBtn.setAttribute("hidden", "");
      return;
    }
    badgeHudBtn.removeAttribute("hidden");
    const count = unlockedBadgeIds.size;
    if (badgeHudCountEl) badgeHudCountEl.textContent = String(count);
    // Brief pop when the count goes up (new badge earned); skipped on first
    // paint and on rebirth resets, which only ever lower the count.
    if (badgeHudLastCount >= 0 && count > badgeHudLastCount) {
      badgeHudBtn.classList.remove("badge-hud-pop");
      // Force reflow so re-adding the class restarts the animation even if
      // two unlocks land within the same 600ms window.
      void badgeHudBtn.offsetWidth;
      badgeHudBtn.classList.add("badge-hud-pop");
      if (badgeHudPopTimer) clearTimeout(badgeHudPopTimer);
      badgeHudPopTimer = setTimeout(() => {
        badgeHudBtn.classList.remove("badge-hud-pop");
        badgeHudPopTimer = null;
      }, 650);
      // Same guard as the pop above (skips first paint / rebirth resets, which
      // only ever lower the count) — light the persistent dot for a genuinely
      // new, not-yet-viewed unlock.
      setBadgeHudUnseen();
    }
    // Per-badge dots: reconcile on EVERY call, not just growth — a SHRINK of
    // unlockedBadgeIds (doRebirth filters it down to rebirth_* ids;
    // handleMetricsReset zeroes it entirely) must resync knownBadgeIds DOWN
    // too. Previously this whole block lived inside the `count >
    // badgeHudLastCount` guard above, so a shrink left knownBadgeIds stale
    // and oversized — a badge re-earned after a rebirth/reset was already
    // "known" and never lit a dot again. Anything in unlockedBadgeIds not yet
    // in knownBadgeIds is a genuinely new unlock (see THEME_INITIALIZED for
    // how knownBadgeIds is baselined so pre-existing unlocks never
    // retroactively grow a dot); anything left in unseenBadgeIds that is no
    // longer in unlockedBadgeIds is an orphan (its badge was wiped out from
    // under it by a shrink) and is dropped so it can never render a dot for
    // an id that isn't unlocked anymore.
    if (currentBadgeThemeId) {
      const newIds = [...unlockedBadgeIds].filter((id) => !knownBadgeIds.has(id));
      for (const id of newIds) unseenBadgeIds.add(id);
      const prevUnseenSize = unseenBadgeIds.size;
      unseenBadgeIds = new Set([...unseenBadgeIds].filter((id) => unlockedBadgeIds.has(id)));
      const orphanDropped = unseenBadgeIds.size !== prevUnseenSize;
      const knownSizeChanged = knownBadgeIds.size !== unlockedBadgeIds.size;
      knownBadgeIds = new Set(unlockedBadgeIds);
      // Only persist when something actually changed — avoid a setState on
      // every no-op render-loop tick.
      if (newIds.length > 0 || orphanDropped || knownSizeChanged) {
        badgeUnseenByTheme[currentBadgeThemeId] = [...unseenBadgeIds];
        badgeKnownByTheme[currentBadgeThemeId] = [...knownBadgeIds];
        persistBadgePerBadgeState();
      }
    }
    badgeHudLastCount = count;
  }

  // Individual cups render up to this many; beyond it the row collapses to
  // one cup + "×N" so a committed player's uncapped rebirthCount (the LATE
  // requirement tier keeps rolling forever past rebirth 6) never grows the
  // row's width past this point.
  const MAX_TROPHY_CUPS = 8;

  // Single source of truth for the cup glyph — one bowl + two handles + stem
  // + base, same gold-gradient/near-black-stroke material language as the
  // badge medal (compare panel.ts's badgeHudGoldGrad). The gradient itself
  // is defined ONCE in panel.ts (id="trophyCupGoldGrad", a hidden defs-only
  // sprite sibling of #badge-hud-btn) and referenced here via fill:url(#...)
  // so every cup instance shares it instead of repeating a <linearGradient>
  // per copy. Every cup is IDENTICAL regardless of rebirth tier — cups are a
  // counter, not a palette indicator, so they deliberately do NOT pick up
  // the Rebirth 6 gold-palette upgrade (see getActivePartyPalette).
  const TROPHY_CUP_SVG = '<svg class="trophy-cup" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    '<path d="M5 4 C2 4 2 9 5 9" fill="none" stroke="#141418" stroke-width="1.4" stroke-linecap="round" />' +
    '<path d="M15 4 C18 4 18 9 15 9" fill="none" stroke="#141418" stroke-width="1.4" stroke-linecap="round" />' +
    '<path d="M5 3 H15 V7 A5 5 0 0 1 5 7 Z" fill="url(#trophyCupGoldGrad)" stroke="#141418" stroke-width="1.2" stroke-linejoin="round" />' +
    '<rect x="9" y="12" width="2" height="3" fill="url(#trophyCupGoldGrad)" stroke="#141418" stroke-width="0.75" />' +
    '<rect x="6" y="15" width="8" height="2" rx="0.6" fill="url(#trophyCupGoldGrad)" stroke="#141418" stroke-width="1" stroke-linejoin="round" />' +
    '</svg>';

  /**
   * Minimal HTML-attribute escape for the trophy cup `title` values below.
   * Those strings are always static/generated (never user or filesystem
   * data — see rebirthTierTooltip), but they're spliced into an innerHTML
   * string rather than set via the DOM `.title` property, so `&` and `"`
   * still need escaping to stay attribute-safe (e.g. the R1 tooltip's
   * "rack & ranged weapons").
   */
  function escapeHtmlAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Hover text for a single completed-rebirth cup: "Rebirth N" plus, for
   * tiers that granted a perk, an em-dash summary of that perk. Tier numbers
   * are derived from the same UNLOCK constants that gate the corresponding
   * preview line (~1902-1940) and current-bonus line above, so the tooltip
   * can never drift out of sync with the actual gates. Rebirth 1's weapons
   * rack has no named constant — its real gate is the literal `>= 1` in
   * buildSeededQueue — so it's a literal 1 here too, matching how the
   * preview list (rebirthUnlockPreviews) already treats it. The turret tier
   * text also covers the stand-up huddle, since HUDDLE_UNLOCK_REBIRTH
   * currently coincides with TURRET_UNLOCK_REBIRTH; the gold-palette tier
   * text likewise covers the sparring exhibition, since SPARRING_UNLOCK_REBIRTH
   * currently coincides with GOLD_PALETTE_UNLOCK_REBIRTH — both are separate
   * tunable constants that happen to share a tier today. Tiers past the
   * highest named constant fall back to the bare "Rebirth N" form.
   */
  function rebirthTierTooltip(tier) {
    const perkByTier = {
      1: "unlocked the weapons rack & ranged weapons",
      [TURRET_UNLOCK_REBIRTH]: "unlocked the defensive turret & stand-up huddles",
      [DANCE_PARTY_UNLOCK_REBIRTH]: "unlocked the disco dance party",
      [DANCE_OFF_UNLOCK_REBIRTH]: "unlocked the dance-off",
      [VICTORY_LAP_UNLOCK_REBIRTH]: "upgraded the victory lap",
      [GOLD_PALETTE_UNLOCK_REBIRTH]: "unlocked the gold party palette & agent sparring exhibitions",
    };
    const perk = perkByTier[tier];
    return perk ? `Rebirth ${tier} — ${perk}` : `Rebirth ${tier}`;
  }

  /**
   * Rebirth trophy row: one bare gold cup per completed rebirth, stacking
   * right-to-left immediately left of the badge medal, collapsing to a
   * single cup + "×N" past MAX_TROPHY_CUPS. Reads module-scope rebirthCount
   * directly — no new state, no persistence — and is only ever called from
   * the exact points rebirthCount changes (doRebirth, THEME_INITIALIZED
   * restore, Reset), never per animation frame. At 0 rebirths the row is
   * left empty (`.trophy-row:empty` in style.css hides it entirely).
   *
   * Each cup carries its tooltip as an SVG `<title>` CHILD ELEMENT (first
   * child inside the <svg>) naming the rebirth it represents, so hovering it
   * surfaces what that tier unlocked (rebirthTierTooltip above). Chromium
   * (VS Code webviews) does NOT honor a plain `title` HTML ATTRIBUTE on
   * inline SVG — only the nested <title> element triggers the native
   * tooltip — so that's the mechanism used here, not an attribute. Cups are
   * built low-tier-first (tier 1, 2, 3, ...) and appended in that order; the
   * row is a normal (non-reversed) flex container anchored by its RIGHT edge
   * next to the badge medal, so the LAST-appended cup — the highest tier —
   * lands rightmost/closest to the medal, and tier 1 lands leftmost/farthest
   * from it. Markup per cup is byte-identical to the old TROPHY_CUP_SVG
   * repeat() output aside from the added <title> child, so appearance is
   * unchanged (aria-hidden="true" already suppresses it from the a11y tree;
   * that's fine, the tooltip is a hover nicety, not a screen-reader label).
   */
  function trophyCupSvgWithTitle(titleText) {
    return TROPHY_CUP_SVG.replace(
      '<svg class="trophy-cup" viewBox="0 0 20 20" aria-hidden="true" focusable="false">',
      `<svg class="trophy-cup" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><title>${escapeHtmlAttr(titleText)}</title>`
    );
  }

  function updateTrophyRow() {
    if (!trophyRowEl) return;
    if (rebirthCount <= 0) {
      trophyRowEl.innerHTML = "";
      return;
    }
    if (rebirthCount <= MAX_TROPHY_CUPS) {
      let html = "";
      for (let tier = 1; tier <= rebirthCount; tier++) {
        html += trophyCupSvgWithTitle(rebirthTierTooltip(tier));
      }
      trophyRowEl.innerHTML = html;
    } else {
      trophyRowEl.innerHTML = trophyCupSvgWithTitle(rebirthTierTooltip(rebirthCount)) +
        '<span class="trophy-row-count">×' + rebirthCount + '</span>';
    }
  }

  /**
   * Check current PER-CYCLE progress (lifetime counters minus the baseline
   * captured at the last rebirth, or 0/0/0 if never rebirthed) against each
   * theme badge's threshold and unlock any newly-earned ones. themeBadges is
   * a small array (a handful of entries) so this is cheap enough to call every
   * render frame. unlockedBadgeIds only ever grows within a rebirth cycle —
   * it is cleared by doRebirth().
   */
  function updateBadgeUnlocks() {
    if (!themeBadges || themeBadges.length === 0) return;
    const effBuilt = cycleObjectsBuilt;
    const effEvicted = cycleRivalsEvicted;
    const effTasks = (state.completedTasks || 0) - rebirthBaseline.tasks;
    const effPeak = cyclePeakActive;
    // OBJECTS_BUILT_POST_REBIRTH (e.g. reborn_builder) only counts once the
    // player has rebirthed at least once; before that it's pinned to 0 so the
    // badge can never unlock on a first-ever cycle.
    const effBuiltPostRebirth = rebirthCount >= 1 ? effBuilt : 0;
    const objectCount = themeBuildables.length;
    let changed = false;
    for (const b of themeBadges) {
      if (!b || !b.badge_id || unlockedBadgeIds.has(b.badge_id)) continue;
      let eff = 0;
      switch (b.trigger_type) {
        case "OBJECTS_BUILT": eff = effBuilt; break;
        case "RIVALS_EVICTED": eff = effEvicted; break;
        case "TASKS_COMPLETED": eff = effTasks; break;
        case "AGENTS_ACTIVE": eff = effPeak; break;
        // REBIRTH_COUNT (rebirth_1/2/3): lifetime rebirthCount, never baseline-
        // adjusted and never wiped — these badges are permanent milestones.
        case "REBIRTH_COUNT": eff = rebirthCount; break;
        case "OBJECTS_BUILT_POST_REBIRTH": eff = effBuiltPostRebirth; break;
        default: continue;
      }
      // Clamp OBJECTS_BUILT-flavored thresholds to this theme's actual
      // buildable count so a capstone badge tuned for a bigger theme still
      // unlocks on smaller ones.
      const t = (b.trigger_type === "OBJECTS_BUILT" || b.trigger_type === "OBJECTS_BUILT_POST_REBIRTH")
        ? Math.min(b.threshold, objectCount)
        : b.threshold;
      const met = eff >= t;
      if (met) {
        unlockedBadgeIds.add(b.badge_id);
        changed = true;
        // Persist the newly-earned unlock on the host, scoped to this theme,
        // so it survives across sessions. Badges seeded from a prior session
        // are already in unlockedBadgeIds before this loop runs, so this only
        // fires for genuinely new unlocks.
        if (currentBadgeThemeId) {
          vscode.postMessage({ type: "BADGE_UNLOCKED", payload: { theme_id: currentBadgeThemeId, badge_id: b.badge_id } });
        }
      }
    }
    if (changed) updateBadgeHud();
  }

  /**
   * Rebuild #badge-list from themeBadges + unlockedBadgeIds. Unlocked badges
   * show their icon (themeImages[frameKey][0]) at full color plus description;
   * locked badges show a silhouette (CSS grayscale/dark filter, or a generic
   * badge shape if art isn't loaded) plus a "n / threshold" progress line.
   */
  /**
   * Plain-language explanation of how a badge is earned, derived from its
   * trigger_type/threshold, plus its description and a note when it's part of
   * the current rebirth requirement. Guards missing fields so it never throws.
   */
  function badgeExplanation(b) {
    if (!b) return "";
    const threshold = (b && typeof b.threshold === "number") ? b.threshold : 0;
    let sentence;
    switch (b && b.trigger_type) {
      case "OBJECTS_BUILT": sentence = `Awarded for building ${threshold} object(s).`; break;
      case "RIVALS_EVICTED": sentence = `Awarded for evicting ${threshold} rival(s).`; break;
      case "TASKS_COMPLETED": sentence = `Awarded for completing ${threshold} task(s).`; break;
      case "AGENTS_ACTIVE": sentence = `Awarded for having ${threshold} agents active at once.`; break;
      case "REBIRTH_COUNT": sentence = `Awarded for reaching Rebirth ×${threshold}.`; break;
      case "OBJECTS_BUILT_POST_REBIRTH": sentence = `Awarded for building ${threshold} object(s) in a single cycle, after at least one Rebirth.`; break;
      default: sentence = `Awarded for building ${threshold} object(s).`; break;
    }
    const parts = [sentence];
    if (b && b.description) parts.push(String(b.description));
    if (b && b.badge_id && requiredRebirthBadgeIds.indexOf(b.badge_id) >= 0) {
      parts.push("Required for your next Rebirth.");
    }
    if (b && b.trigger_type === "REBIRTH_COUNT") {
      parts.push("This badge is permanent — it persists through every Rebirth.");
    }
    return parts.join(" ");
  }

  /**
   * Compact, event-accurate title for a badge slot, derived ONLY from the
   * canonical trigger_type + threshold (mirrors badgeExplanation's cases).
   * Deliberately does NOT use display_name: that field is overwritten with
   * themed flavor text on rename (themeService SET_THEME_ITEM_NAMES) and is
   * already the editable value, so it is not a stable event descriptor.
   * Returns null on a null/invalid badge or an unknown/missing trigger_type
   * so callers cleanly fall back to a plain slot label. Pure, no side effects.
   */
  function badgeEventTitle(bd) {
    if (!bd || !bd.trigger_type || typeof bd.threshold !== "number") return null;
    const t = bd.threshold;
    switch (bd.trigger_type) {
      case "OBJECTS_BUILT": return "Build " + t + " Objects";
      case "RIVALS_EVICTED": return "Evict " + t + " Rivals";
      case "TASKS_COMPLETED": return "Complete " + t + " Tasks";
      case "AGENTS_ACTIVE": return t + " Agents Active";
      case "REBIRTH_COUNT": return "Reach Rebirth ×" + t;
      case "OBJECTS_BUILT_POST_REBIRTH": return "Build " + t + " Objects (post-rebirth)";
      default: return null;
    }
  }

  /**
   * Current per-cycle progress line for a locked badge, e.g. "3 / 10 built".
   * Measured within the current rebirth cycle (baseline-adjusted) so both the
   * grid card and the detail popup agree with updateBadgeUnlocks(). Guards
   * missing fields so it never throws.
   */
  function badgeProgressText(b) {
    if (!b) return "";
    let eff = 0, unit = "";
    let threshold = b.threshold || 0;
    switch (b.trigger_type) {
      case "RIVALS_EVICTED": eff = cycleRivalsEvicted; unit = "evicted"; break;
      case "TASKS_COMPLETED": eff = (state.completedTasks || 0) - rebirthBaseline.tasks; unit = "tasks"; break;
      case "AGENTS_ACTIVE": eff = cyclePeakActive; unit = "active"; break;
      // REBIRTH_COUNT (rebirth_1/2/3): progress is lifetime rebirthCount itself,
      // e.g. "1 / 2 rebirths".
      case "REBIRTH_COUNT": eff = rebirthCount; unit = "rebirths"; break;
      case "OBJECTS_BUILT_POST_REBIRTH":
        eff = rebirthCount >= 1 ? cycleObjectsBuilt : 0;
        threshold = Math.min(threshold, themeBuildables.length);
        unit = "built";
        break;
      default:
        eff = cycleObjectsBuilt;
        threshold = Math.min(threshold, themeBuildables.length);
        unit = "built";
        break;
    }
    return Math.min(Math.max(eff, 0), threshold) + " / " + threshold + " " + unit;
  }

  /**
   * Resolve a badge's icon frame src ("frames.json#<key>" → themeImages[key][0]).
   * Returns null when no art is loaded, so callers can fall back to a shape.
   */
  function badgeFrameSrc(b) {
    const frameKey = (b && typeof b.icon_asset === "string" && b.icon_asset.indexOf("#") >= 0)
      ? b.icon_asset.split("#")[1]
      : null;
    const frames = frameKey ? themeImages[frameKey] : null;
    return (frames && frames[0] && frames[0].src) ? frames[0].src : null;
  }

  // ── Badge detail popup (large icon + status + explanation) ───────────
  // A single reusable modal, built lazily and appended to <body>, that layers
  // ABOVE #badge-modal. Populated per-badge by openBadgeDetail(); closed via
  // the × button, backdrop click, or Escape.
  /** @type {HTMLElement|null} */ let badgeDetailModalEl = null;
  /** @type {HTMLElement|null} */ let badgeDetailIconEl = null;
  /** @type {HTMLElement|null} */ let badgeDetailNameEl = null;
  /** @type {HTMLElement|null} */ let badgeDetailRebirthEl = null;
  /** @type {HTMLElement|null} */ let badgeDetailStatusEl = null;
  /** @type {HTMLElement|null} */ let badgeDetailExplainEl = null;

  function closeBadgeDetail() {
    if (badgeDetailModalEl) badgeDetailModalEl.setAttribute("hidden", "");
    // Return focus to the badges dialog we layered over, if it's still open.
    try {
      if (badgeModalCloseEl && badgeModalEl && !badgeModalEl.hasAttribute("hidden")) {
        badgeModalCloseEl.focus();
      }
    } catch (_e) { /* noop */ }
  }

  function buildBadgeDetailModal() {
    if (badgeDetailModalEl) return;
    const modal = document.createElement("div");
    modal.id = "badge-detail-modal";
    modal.setAttribute("hidden", "");

    const backdrop = document.createElement("div");
    backdrop.className = "badge-detail-backdrop";
    backdrop.addEventListener("click", closeBadgeDetail);
    modal.appendChild(backdrop);

    const dialog = document.createElement("div");
    dialog.className = "badge-detail-dialog";

    const closeBtn = document.createElement("button");
    closeBtn.className = "badge-detail-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closeBadgeDetail);
    dialog.appendChild(closeBtn);

    badgeDetailIconEl = document.createElement("div");
    badgeDetailIconEl.className = "badge-detail-icon";
    dialog.appendChild(badgeDetailIconEl);

    badgeDetailNameEl = document.createElement("div");
    badgeDetailNameEl.className = "badge-detail-name";
    dialog.appendChild(badgeDetailNameEl);

    badgeDetailRebirthEl = document.createElement("div");
    badgeDetailRebirthEl.className = "badge-rebirth-tag badge-detail-rebirth";
    badgeDetailRebirthEl.textContent = "REBIRTH";
    badgeDetailRebirthEl.title = "This badge is required for your next Rebirth. Earn the marked badges to unlock Rebirth.";
    badgeDetailRebirthEl.setAttribute("hidden", "");
    dialog.appendChild(badgeDetailRebirthEl);

    badgeDetailStatusEl = document.createElement("div");
    badgeDetailStatusEl.className = "badge-detail-status";
    dialog.appendChild(badgeDetailStatusEl);

    badgeDetailExplainEl = document.createElement("div");
    badgeDetailExplainEl.className = "badge-detail-explain";
    dialog.appendChild(badgeDetailExplainEl);

    modal.appendChild(dialog);
    document.body.appendChild(modal);
    badgeDetailModalEl = modal;
  }

  /**
   * Populate and show the badge detail popup for badge `b`. Works for both
   * earned and locked badges: earned → "Earned" status + explanation; locked →
   * per-cycle progress + how-to-earn explanation. Guards missing fields.
   */
  function openBadgeDetail(b) {
    if (!b) return;
    buildBadgeDetailModal();
    if (!badgeDetailModalEl) return;
    const unlocked = unlockedBadgeIds.has(b.badge_id);
    const isRebirth = requiredRebirthBadgeIds.indexOf(b.badge_id) >= 0;

    // Large icon (or generic shape); silhouette when locked.
    if (badgeDetailIconEl) {
      while (badgeDetailIconEl.firstChild) badgeDetailIconEl.removeChild(badgeDetailIconEl.firstChild);
      badgeDetailIconEl.className = "badge-detail-icon";
      const src = badgeFrameSrc(b);
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        if (!unlocked) img.className = "badge-card-icon-silhouette";
        badgeDetailIconEl.appendChild(img);
      } else {
        badgeDetailIconEl.classList.add("badge-detail-icon--generic");
        if (!unlocked) badgeDetailIconEl.classList.add("badge-card-icon-silhouette");
      }
      badgeDetailIconEl.classList.toggle("badge-detail-icon--unlocked", unlocked);
    }

    if (badgeDetailNameEl) badgeDetailNameEl.textContent = b.display_name || b.badge_id;

    if (badgeDetailRebirthEl) {
      if (isRebirth) badgeDetailRebirthEl.removeAttribute("hidden");
      else badgeDetailRebirthEl.setAttribute("hidden", "");
    }

    if (badgeDetailStatusEl) {
      badgeDetailStatusEl.classList.toggle("badge-detail-status--earned", unlocked);
      badgeDetailStatusEl.classList.toggle("badge-detail-status--locked", !unlocked);
      badgeDetailStatusEl.textContent = unlocked
        ? "Earned ✓"
        : badgeProgressText(b);
    }

    if (badgeDetailExplainEl) badgeDetailExplainEl.textContent = badgeExplanation(b);

    badgeDetailModalEl.removeAttribute("hidden");
    // Focus the close button so Escape/Enter behave predictably.
    try {
      const btn = badgeDetailModalEl.querySelector(".badge-detail-close");
      if (btn) /** @type {HTMLElement} */ (btn).focus();
    } catch (_e) { /* noop */ }
  }

  // ── Reset-confirm modal (in-panel replacement for the removed native
  // VS Code showWarningMessage confirm) ────────────────────────────────
  // A single reusable modal, built lazily and appended to <body>, mirroring
  // the About modal's backdrop/dialog/hidden-attribute mechanism so it opens
  // and closes exactly the same way (openModal/closeModal use the same
  // "hidden" attribute toggle). Closed via Cancel, backdrop click, or
  // Escape (see the shared keydown handler below); "Reset" posts
  // resetMetrics to the host then closes.
  /** @type {HTMLElement|null} */ let resetConfirmModalEl = null;
  /** @type {HTMLElement|null} */ let resetConfirmMessageEl = null;
  /** @type {HTMLElement|null} */ let resetConfirmCancelBtn = null;

  function closeResetConfirmModal() {
    if (resetConfirmModalEl) resetConfirmModalEl.setAttribute("hidden", "");
  }

  function buildResetConfirmModal() {
    if (resetConfirmModalEl) return;

    const modal = document.createElement("div");
    modal.id = "reset-confirm-modal";
    modal.setAttribute("hidden", "");

    const backdrop = document.createElement("div");
    backdrop.id = "reset-confirm-backdrop";
    backdrop.addEventListener("click", closeResetConfirmModal);
    modal.appendChild(backdrop);

    const dialog = document.createElement("div");
    dialog.id = "reset-confirm-dialog";

    const title = document.createElement("div");
    title.id = "reset-confirm-title";
    title.textContent = "Reset session stats?";
    dialog.appendChild(title);

    resetConfirmMessageEl = document.createElement("p");
    resetConfirmMessageEl.id = "reset-confirm-message";
    dialog.appendChild(resetConfirmMessageEl);

    const actions = document.createElement("div");
    actions.className = "reset-confirm-actions";

    resetConfirmCancelBtn = document.createElement("button");
    resetConfirmCancelBtn.type = "button";
    resetConfirmCancelBtn.className = "skill-btn settings-btn";
    resetConfirmCancelBtn.textContent = "Cancel";
    resetConfirmCancelBtn.addEventListener("click", closeResetConfirmModal);
    actions.appendChild(resetConfirmCancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "skill-btn settings-btn danger-btn";
    confirmBtn.textContent = "Reset";
    confirmBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "resetMetrics" });
      closeResetConfirmModal();
    });
    actions.appendChild(confirmBtn);

    dialog.appendChild(actions);
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    resetConfirmModalEl = modal;
  }

  /**
   * Show the in-panel "reset session stats" confirmation. Mirrors the
   * wording the host's showWarningMessage used to show (see the removed
   * confirmMessage in panel.ts _handleResetMetrics).
   */
  function showResetConfirmModal() {
    buildResetConfirmModal();
    if (!resetConfirmModalEl || !resetConfirmMessageEl) return;
    resetConfirmMessageEl.textContent =
      currentThemePlan && currentThemePlan.display_name
        ? `Reset stats for "${currentThemePlan.display_name}" in this project? This clears its badges, build progress, and rebirth for this project only — other themes and projects are unaffected. This can't be undone.`
        : "Reset session metrics? This can't be undone.";
    resetConfirmModalEl.removeAttribute("hidden");
    try {
      if (resetConfirmCancelBtn) resetConfirmCancelBtn.focus();
    } catch (_e) { /* noop */ }
  }

  // ── Theme-switch confirm modal (issue #28: in-panel replacement for the
  // host's native VS Code showWarningMessage confirm) ─────────────────────
  // The host still decides WHETHER a warning is needed (it owns the
  // per-project persisted badge counts via shouldWarnOnThemeSwitch —
  // progressScope.ts — the webview has no live view of that data). When a
  // warning is needed the host sends CONFIRM_THEME_SWITCH instead of
  // switching immediately; this modal shows the same wording the host's
  // showWarningMessage used to show, and only on "Switch theme" does the
  // webview post SELECT_THEME_CONFIRMED to tell the host to actually
  // proceed. Cancelling closes the modal and reverts the optimistic
  // selectedThemeId locally — no host round-trip needed, since the host
  // never touched anything yet. Built the same lazy way as
  // resetConfirmModalEl, mirroring its backdrop/dialog/hidden mechanism.
  /** @type {HTMLElement|null} */ let themeSwitchConfirmModalEl = null;
  /** @type {HTMLElement|null} */ let themeSwitchConfirmMessageEl = null;
  /** @type {HTMLElement|null} */ let themeSwitchConfirmCancelBtn = null;
  /** Theme id still actually loaded — restored on cancel. */
  let themeSwitchConfirmPreviousId = "";

