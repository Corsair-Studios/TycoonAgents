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

  // ── Resize handle: drag to control metrics panel height ─────────

  const metricsPanelEl = /** @type {HTMLElement} */ (document.getElementById("metrics-panel"));
  const resizeHandleEl = /** @type {HTMLElement} */ (document.getElementById("resize-handle"));

  // ── Project Plan (optional feature) — hosted as a tab next to Metrics ──
  const metricsBodyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-body"));
  const metricsTabsEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tabs"));
  const metricsTabBtnEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tab-btn"));
  const planTabBtnEl = /** @type {HTMLElement} */ (document.getElementById("plan-tab-btn"));
  const projectPlanBodyEl = /** @type {HTMLElement} */ (document.getElementById("project-plan-body"));

  // The #metrics-table "Tokens/min" column header (static HTML in panel.ts) now
  // shows an estimated $/min burn rate instead — relabel it from here so the
  // header stays in sync without touching panel.ts.
  (function relabelMetricsStatusColumnHeader() {
    const th = document.querySelector("#metrics-table thead th:nth-child(2)");
    if (th) th.textContent = "Est. $/min";
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
  /** Which tab is visible in the metrics panel: "metrics" (default) or "plan". Only meaningful while projectPlanEnabled is true. Restored from webview state so it survives reloads. */
  let activeMetricsTab = "metrics";
  /** Reference to the Settings screen's Project Plan checkbox, kept live so a PLAN_STATE update can sync its checked state without a full renderSettings() re-render. */
  let projectPlanCheckboxEl = null;
  /** Advisory-only threshold (ms): how long with no agent activity before the active task card shows a "may be stalled" note. Deterministic, no AI involved — purely a staleness signal off state.lastActivityAt. */
  const STALL_MS = 5 * 60 * 1000;
  /** Last computed isPlanStalled() result, used by the 1s ticker to re-render the plan section only when the stall state actually flips (not every tick). */
  let lastPlanStallState = false;

  (function restoreActiveMetricsTab() {
    const saved = vscode.getState();
    if (saved && saved.activeMetricsTab === "plan") activeMetricsTab = "plan";
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

  /** Reflect (activeMetricsTab, projectPlanEnabled) onto the tab bar + content visibility. The whole tab bar (not just the Plan tab) is hidden when the feature is off, per the gating requirement — no lone/empty tab bar. */
  function updateMetricsTabsUI() {
    if (!metricsTabsEl || !metricsBodyEl || !projectPlanBodyEl) return;
    if (!projectPlanEnabled) {
      metricsTabsEl.hidden = true;
      metricsBodyEl.hidden = false;
      projectPlanBodyEl.hidden = true;
      return;
    }
    metricsTabsEl.hidden = false;
    const onPlan = activeMetricsTab === "plan";
    metricsBodyEl.hidden = onPlan;
    projectPlanBodyEl.hidden = !onPlan;
    if (metricsTabBtnEl) {
      metricsTabBtnEl.classList.toggle("metrics-tab-btn--active", !onPlan);
      metricsTabBtnEl.setAttribute("aria-selected", String(!onPlan));
    }
    if (planTabBtnEl) {
      planTabBtnEl.classList.toggle("metrics-tab-btn--active", onPlan);
      planTabBtnEl.setAttribute("aria-selected", String(onPlan));
    }
  }

  /** Switch the visible metrics-panel tab and persist the choice. */
  function setActiveMetricsTab(tab) {
    activeMetricsTab = tab === "plan" ? "plan" : "metrics";
    saveActiveMetricsTab();
    syncProjectPlanBodyHeight();
    updateMetricsTabsUI();
  }

  if (metricsTabBtnEl) metricsTabBtnEl.addEventListener("click", () => setActiveMetricsTab("metrics"));
  if (planTabBtnEl) planTabBtnEl.addEventListener("click", () => setActiveMetricsTab("plan"));

  // Paint the correct initial state before the first PLAN_STATE reply arrives
  // (projectPlanEnabled defaults false, so this just hides the tab bar).
  updateMetricsTabsUI();

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

  /** Build an OVERRIDE_TASK action button. @param {string} label @param {"approve"|"retry"|"skip"} action @param {string} taskId */
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
      stallNote.textContent =
        "⏸ No agent activity since " + new Date(state.lastActivityAt).toLocaleTimeString() +
        " — this task may be stalled. Ask Claude to resume the plan.";
      card.appendChild(stallNote);
    }

    const actions = document.createElement("div");
    actions.className = "plan-task-actions";
    const showRetrySkip = task.status === "active" || task.status === "verifying"
      || task.status === "needs_fix" || task.status === "blocked";
    const showApprove = task.status === "needs_fix";
    if (showApprove) actions.appendChild(buildProjectPlanTaskButton("Approve", "approve", task.id));
    if (showRetrySkip) {
      actions.appendChild(buildProjectPlanTaskButton("Retry", "retry", task.id));
      actions.appendChild(buildProjectPlanTaskButton("Skip", "skip", task.id));
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
    guidance.textContent = "Ask Claude to repair and resume the plan (the plan skill will rewrite the whole file), or restore the last good copy.";
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
      showCatalogTab("skills");
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
      if (resetConfirmModalEl && !resetConfirmModalEl.hasAttribute("hidden")) {
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

  function renderBadgePanel() {
    if (!badgeListEl) return;
    renderRebirthPanel();
    while (badgeListEl.firstChild) badgeListEl.removeChild(badgeListEl.firstChild);
    if (!themeBadges || themeBadges.length === 0) {
      const empty = document.createElement("div");
      empty.className = "badge-empty";
      empty.textContent = "This theme has no badges yet.";
      badgeListEl.appendChild(empty);
      return;
    }
    for (const b of themeBadges) {
      if (!b || !b.badge_id) continue;
      const unlocked = unlockedBadgeIds.has(b.badge_id);
      const isRebirth = requiredRebirthBadgeIds.indexOf(b.badge_id) >= 0;
      const card = document.createElement("div");
      card.className = "badge-card" + (unlocked ? " badge-card--unlocked" : " badge-card--locked") +
        (isRebirth ? " badge-card--rebirth" : "");

      const iconWrap = document.createElement("div");
      iconWrap.className = "badge-card-icon";
      // icon_asset looks like "frames.json#achievement_3" — the frame key is
      // the part after '#'; the image is themeImages[frameKey][0] if loaded.
      const frameKey = (typeof b.icon_asset === "string" && b.icon_asset.indexOf("#") >= 0)
        ? b.icon_asset.split("#")[1]
        : null;
      const frames = frameKey ? themeImages[frameKey] : null;
      if (frames && frames[0] && frames[0].src) {
        const img = document.createElement("img");
        img.src = frames[0].src;
        img.alt = "";
        if (!unlocked) img.className = "badge-card-icon-silhouette";
        iconWrap.appendChild(img);
      } else {
        iconWrap.classList.add("badge-card-icon--generic");
        if (!unlocked) iconWrap.classList.add("badge-card-icon-silhouette");
      }
      card.appendChild(iconWrap);

      // Per-badge "new achievement" dot: only for unlocked badges the player
      // hasn't opened the panel to see yet (unseenBadgeIds, cleared by the
      // badge-hud click handler AFTER this render so it's visible for this
      // final viewing). Mirrors the HUD's aggregate dot visually.
      if (unlocked && unseenBadgeIds.has(b.badge_id)) {
        const dot = document.createElement("div");
        dot.className = "badge-card-dot";
        card.appendChild(dot);
      }

      const info = document.createElement("div");
      info.className = "badge-card-info";
      const name = document.createElement("div");
      name.className = "badge-card-name";
      name.textContent = b.display_name || b.badge_id;
      info.appendChild(name);

      if (isRebirth) {
        const rebirthTag = document.createElement("div");
        rebirthTag.className = "badge-rebirth-tag";
        rebirthTag.textContent = "REBIRTH";
        rebirthTag.title = "This badge is required for your next Rebirth. Earn the marked badges to unlock Rebirth.";
        info.appendChild(rebirthTag);
      }

      if (unlocked) {
        const desc = document.createElement("div");
        desc.className = "badge-card-desc";
        desc.textContent = b.description || "";
        info.appendChild(desc);
      } else {
        const progress = document.createElement("div");
        progress.className = "badge-card-progress";
        // Progress is measured WITHIN the current rebirth cycle (baseline-adjusted),
        // matching updateBadgeUnlocks() so the displayed count never shows a
        // false lifetime total that's already past threshold post-rebirth.
        progress.textContent = badgeProgressText(b);
        info.appendChild(progress);
      }

      card.appendChild(info);

      // Clicking a card opens a full-size popup with the large icon, earned/
      // locked status, and a plain-language explanation (see openBadgeDetail).
      card.style.cursor = "pointer";
      card.addEventListener("click", () => openBadgeDetail(b));

      badgeListEl.appendChild(card);
    }
  }

  /**
   * Persist rebirth state HOST-SIDE, keyed by currentBadgeThemeId (per-theme,
   * per-project — matches unlocked_badge_ids' scoping). Previously this also
   * wrote an UNSCOPED `rebirth` blob into the webview's own vscode.setState()
   * cache, shared across every theme in the workspace; that blob was read as a
   * fallback in the THEME_INITIALIZED handler whenever a theme had no host
   * rebirth_state yet (i.e. a FRESH theme), which leaked the previously
   * loaded theme's rebirth count and unlocked badges into it. The host post
   * below was already correctly per-theme, so the unscoped local write was
   * dropped rather than fixed — nothing reads `getState().rebirth` anymore
   * (see the one-time legacy purge near the top of this file, which still
   * deletes any pre-existing blob from before this fix for migrating users).
   * cyclePeakActive is intentionally NOT persisted (brief C1: high-water mark
   * for the CURRENT session only).
   * D4: also persists rackInsertIndex + rangedPermanentlyUnlocked so the
   * weapons-rack queue position and the permanent ranged-combat unlock both
   * survive reloads and future rebirths, mirroring rebirthCount/baseline/etc.
   */
  function persistRebirth() {
    // Also persist host-side (per theme) so the rebirth requirement survives
    // webview disposal/reload — vscode.setState() alone is lost on teardown,
    // which caused requiredRebirthBadgeIds to re-roll on every reload.
    if (currentBadgeThemeId) {
      vscode.postMessage({
        type: "SAVE_REBIRTH_STATE",
        payload: {
          theme_id: currentBadgeThemeId,
          state: {
            count: rebirthCount,
            baseline: rebirthBaseline,
            required: requiredRebirthBadgeIds,
            cycleBuilt: cycleObjectsBuilt,
            cycleEvicted: cycleRivalsEvicted,
            rackInsertIndex: rackInsertIndex,
            rangedUnlocked: rangedPermanentlyUnlocked,
          },
        },
      });
    }
  }

  /**
   * Pick 3 distinct random badge_ids from themeBadges as the next rebirth's
   * requirement gate. Uses fewer than 3 if the theme doesn't have that many.
   * Draws from the tier pool matching the CURRENT rebirthCount (see
   * rebirthTierPool()) so the requirement gets harder with each Rebirth.
   */
  function rollRebirthRequirement() {
    const ids = (themeBadges || []).map((b) => b && b.badge_id).filter(Boolean);
    // Draw only from the curated tier pool intersected with this theme's
    // badges; if the theme has none of the tier's pool badges, fall back to
    // the full badge set so rebirth never becomes impossible.
    const tierPool = rebirthTierPool(rebirthCount);
    const restricted = ids.filter((id) => tierPool.indexOf(id) >= 0);
    const pool = (restricted.length > 0 ? restricted : ids).slice();
    const picked = [];
    const n = Math.min(3, pool.length);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    requiredRebirthBadgeIds = picked;
  }

  /** True iff a rebirth requirement has been rolled and every required badge is unlocked. */
  function canRebirth() {
    return requiredRebirthBadgeIds.length > 0 &&
      requiredRebirthBadgeIds.every((id) => unlockedBadgeIds.has(id));
  }

  /**
   * Advance the prestige cycle: bump rebirthCount (drives the ranged-weapon +
   * build-speed bonuses, see D1/D2), re-baseline the per-cycle badge counters
   * to the CURRENT lifetime totals (so badges must be re-earned from here),
   * wipe unlockedBadgeIds (EXCEPT rebirth_* milestone badges, which are
   * permanent and survive every Rebirth), roll a fresh 3-badge requirement
   * from the tier matching the new rebirthCount, and persist. Deliberately
   * does NOT touch buildBuiltCount/rivalsEvictedCount/agent metrics/HUD —
   * those are lifetime and keep counting through rebirth.
   */
  function doRebirth() {
    rebirthCount++;
    // D3/D4: the weapons rack (build_order 0 / rackObjectId) is withheld from
    // buildQueue entirely until the player's first rebirth (see
    // buildSeededQueue). Now that rebirthCount is >=1, insert it immediately
    // AFTER the current build position (buildBuiltCount + 1, clamped to the
    // queue bounds) so the rack becomes the VERY NEXT build once the
    // in-progress object finishes — not appended to the end. The chosen
    // index is captured into rackInsertIndex and persisted (persistRebirth
    // below) so buildSeededQueue reproduces the same position on every
    // future reload. Idempotent — a no-op on every rebirth after the first,
    // since indexOf finds it already queued (guards against double-insert).
    if (rackObjectId && buildQueue.indexOf(rackObjectId) === -1) {
      rackInsertIndex = Math.max(0, Math.min(buildBuiltCount + 1, buildQueue.length));
      buildQueue.splice(rackInsertIndex, 0, rackObjectId);
    }
    rebirthBaseline = { built: buildBuiltCount, evicted: rivalsEvictedCount, tasks: (state.completedTasks || 0) };
    cycleObjectsBuilt = 0;
    cycleRivalsEvicted = 0;
    cyclePeakActive = 0;
    unlockedBadgeIds = new Set([...unlockedBadgeIds].filter((id) => id.indexOf("rebirth_") === 0));
    rollRebirthRequirement();
    rebirthConfirmPending = false;
    persistRebirth();
    // buildBuiltCount itself is deliberately NOT reset by rebirth (it's a
    // lifetime counter — see comment above), but persist it here too so the
    // rebirth-reset path always leaves a fresh save on the host, matching
    // every other rebirth-state field persisted just above.
    saveBuildProgress();
    // Durably clear the host-side badge unlocks we just wiped locally, so the
    // host doesn't re-send stale unlocks on the next theme init (which would
    // un-reset this rebirth). persistRebirth() above already saved the fresh
    // requirement/count host-side.
    if (currentBadgeThemeId) {
      vscode.postMessage({
        type: "REBIRTH_RESET_BADGES",
        payload: { theme_id: currentBadgeThemeId },
      });
    }
    // Ranged combat is deliberately NOT unlocked directly here — it unlocks
    // ONLY via the build-latch (see ~computeBuildState/rangedUnlocked latch)
    // once the rack is actually built, which the rebirth above just made
    // possible by appending rackObjectId onto buildQueue.
    updateBadgeHud();
    renderBadgePanel();
    // Cosmetic celebration — must never break the rebirth itself.
    celebrateRebirth();
  }

  /** Timer handle so rapid rebirths reset the announcement auto-hide. */
  let _rebirthAnnounceTimer = 0;

  /**
   * Lazily build (once) and reveal the centered rebirth announcement banner,
   * re-triggering its pop-in animation on every call. Auto-hides after ~3.5s.
   * @param {number} count    the new rebirthCount
   * @param {number} buildPct build-speed bonus percentage
   */
  function showRebirthAnnouncement(count, buildPct) {
    try {
      let el = /** @type {HTMLElement|null} */ (document.getElementById("rebirth-announce"));
      if (!el) {
        el = document.createElement("div");
        el.id = "rebirth-announce";
        el.className = "rebirth-announce";
        const head = document.createElement("div");
        head.className = "rebirth-announce-head";
        const sub = document.createElement("div");
        sub.className = "rebirth-announce-sub";
        el.appendChild(head);
        el.appendChild(sub);
        document.body.appendChild(el);
      }
      const head = el.querySelector(".rebirth-announce-head");
      const sub = el.querySelector(".rebirth-announce-sub");
      if (head) head.textContent = "REBIRTH ×" + count;
      if (sub) sub.textContent = "Weapons rack now buildable · Build speed +" + buildPct + "%";
      el.removeAttribute("hidden");
      // Reset + force reflow so the pop-in animation replays on repeat rebirths.
      el.classList.remove("is-visible");
      void el.offsetWidth;
      el.classList.add("is-visible");
      if (_rebirthAnnounceTimer) clearTimeout(_rebirthAnnounceTimer);
      _rebirthAnnounceTimer = setTimeout(function () {
        const cur = document.getElementById("rebirth-announce");
        if (cur) {
          cur.classList.remove("is-visible");
          cur.setAttribute("hidden", "");
        }
        _rebirthAnnounceTimer = 0;
      }, 3500);
    } catch (_e) { /* cosmetic only */ }
  }

  /**
   * Fire the full rebirth celebration: dismiss the badge modal so the player
   * sees the stage, burst confetti, and show the announcement banner. Every
   * step is guarded — the celebration must never break the rebirth.
   */
  function celebrateRebirth() {
    try { if (badgeModalEl) closeModal(badgeModalEl); } catch (_e) { /* noop */ }
    try { spawnConfetti(); } catch (_e) { /* noop */ }
    try {
      const pct = Math.round((Math.pow(1.2, rebirthCount) - 1) * 100);
      showRebirthAnnouncement(rebirthCount, pct);
    } catch (_e) { /* noop */ }
  }

  /**
   * Rebuild the Rebirth section that sits directly above #badge-list inside
   * #badge-dialog. Built purely from JS (no src/ HTML changes) — the section
   * root is created once (id="rebirth-panel") and inserted as badgeListEl's
   * previous sibling, then its contents are cleared + rebuilt every call so
   * it always reflects live rebirthCount/requiredRebirthBadgeIds/unlocks.
   */
  function renderRebirthPanel() {
    if (!badgeListEl || !badgeListEl.parentElement) return;
    let panel = /** @type {HTMLElement|null} */ (document.getElementById("rebirth-panel"));
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "rebirth-panel";
      panel.className = "rebirth-panel";
      badgeListEl.parentElement.insertBefore(panel, badgeListEl);
    }
    while (panel.firstChild) panel.removeChild(panel.firstChild);

    // Only meaningful once the theme has badges to prestige against.
    if (!themeBadges || themeBadges.length === 0) {
      panel.setAttribute("hidden", "");
      return;
    }
    panel.removeAttribute("hidden");

    // NOTE: rendering must NEVER roll the requirement. A render-time re-roll here
    // was a key cause of the requirement changing on reload (it fired whenever a
    // restore hadn't yet populated requiredRebirthBadgeIds). Rolling now happens
    // ONLY on first-time/invalid restore (THEME_INITIALIZED requiredStillValid)
    // and in doRebirth(). If requiredRebirthBadgeIds is empty here, we simply
    // render an empty requirement list without mutating state.

    const head = document.createElement("div");
    head.className = "rebirth-head";
    const title = document.createElement("div");
    title.className = "rebirth-title";
    title.textContent = `Rebirth ×${rebirthCount}`;
    const rebirthTip = "Rebirth resets your earned badges so you can earn them again — but you keep your agent metrics and gain permanent, stacking bonuses (ranged weapons, faster building). Each Rebirth's required badges get harder than the last. Earn the required badges below to unlock it.";
    title.title = rebirthTip;
    const info = document.createElement("span");
    info.className = "rebirth-info";
    info.textContent = "ⓘ";
    info.title = rebirthTip;
    title.appendChild(info);
    head.appendChild(title);
    if (rebirthCount > 0) {
      const pct = Math.round((Math.pow(1.2, rebirthCount) - 1) * 100);
      const bonus = document.createElement("div");
      bonus.className = "rebirth-bonus";
      bonus.textContent = `Ranged weapons · Build speed +${pct}%`;
      head.appendChild(bonus);
    }
    panel.appendChild(head);

    const reqLabel = document.createElement("div");
    reqLabel.className = "rebirth-req-label";
    reqLabel.textContent = "Rebirth Requirements";
    reqLabel.title = "Earn all of these badges to unlock your next Rebirth. They change only when you Rebirth or reset.";
    panel.appendChild(reqLabel);

    const reqList = document.createElement("div");
    reqList.className = "rebirth-req-list";
    for (const id of requiredRebirthBadgeIds) {
      const badge = themeBadges.find((b) => b && b.badge_id === id);
      const earned = unlockedBadgeIds.has(id);
      const row = document.createElement("div");
      row.className = "rebirth-req" + (earned ? " earned" : "");
      const mark = document.createElement("span");
      mark.className = "rebirth-req-mark";
      mark.textContent = earned ? "✓" : "○";
      row.appendChild(mark);
      const label = document.createElement("span");
      label.className = "rebirth-req-name";
      label.textContent = (badge && (badge.display_name || badge.badge_id)) || id;
      const bName = (badge && (badge.display_name || badge.badge_id)) || id;
      const bDesc = (badge && badge.description) ? " — " + badge.description : "";
      label.title = bName + bDesc + " (" + (earned ? "Earned" : "Not yet earned") + ")";
      row.appendChild(label);
      reqList.appendChild(row);
    }
    panel.appendChild(reqList);

    if (rebirthConfirmPending) {
      const confirm = document.createElement("div");
      confirm.className = "rebirth-confirm";
      const msg = document.createElement("div");
      msg.className = "rebirth-confirm-msg";
      msg.textContent = "Rebirth resets your earned badges (your agent metrics and any Rebirth badges are kept). Continue?";
      confirm.appendChild(msg);
      const row = document.createElement("div");
      row.className = "rebirth-confirm-actions";
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "rebirth-btn";
      confirmBtn.textContent = "Confirm";
      confirmBtn.addEventListener("click", () => { doRebirth(); });
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "rebirth-btn rebirth-btn--secondary";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => { rebirthConfirmPending = false; renderBadgePanel(); });
      row.appendChild(confirmBtn);
      row.appendChild(cancelBtn);
      confirm.appendChild(row);
      panel.appendChild(confirm);
    } else {
      const btn = document.createElement("button");
      btn.className = "rebirth-btn";
      btn.textContent = "Rebirth";
      const enabled = canRebirth();
      if (!enabled) btn.setAttribute("disabled", "");
      btn.title = enabled
        ? "Rebirth now: resets your earned badges (agent metrics are kept) and grants permanent, stacking bonuses — ranged weapons and faster building each time you Rebirth."
        : "Earn all required badges first.";
      btn.addEventListener("click", () => {
        if (!canRebirth()) return;
        rebirthConfirmPending = true;
        renderBadgePanel();
      });
      panel.appendChild(btn);
    }
  }

  // ── Skills list install-button handler (event delegation) ────────

  skillsListEl.addEventListener("click", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    const removeBtn = /** @type {HTMLElement|null} */ (
      target.closest("[data-remove-skill-id]")
    );
    if (removeBtn && !removeBtn.hasAttribute("disabled")) {
      const id = removeBtn.getAttribute("data-remove-skill-id");
      // Host shows its own native confirmation before removing.
      removeBtn.textContent = "Removing…";
      removeBtn.setAttribute("disabled", "");
      vscode.postMessage({ type: "removeSkill", id });
      return;
    }

    const btn = /** @type {HTMLElement|null} */ (
      target.closest("[data-skill-id]")
    );
    if (!btn || btn.hasAttribute("disabled")) return;
    const id = btn.getAttribute("data-skill-id");
    btn.textContent = "Installing…";
    btn.setAttribute("disabled", "");
    vscode.postMessage({ type: "installSkill", id });
  });

  // ── MCP list install-button handler (event delegation) ───────────

  if (mcpListEl) {
    mcpListEl.addEventListener("click", (e) => {
      const target = /** @type {HTMLElement} */ (e.target);

      const removeBtn = /** @type {HTMLElement|null} */ (
        target.closest("[data-remove-mcp-id]")
      );
      if (removeBtn && !removeBtn.hasAttribute("disabled")) {
        const rid = removeBtn.getAttribute("data-remove-mcp-id");
        // Host shows its own native confirmation before removing.
        removeBtn.textContent = "Removing…";
        removeBtn.setAttribute("disabled", "");
        vscode.postMessage({ type: "removeMcp", id: rid });
        return;
      }

      const btn = /** @type {HTMLElement|null} */ (
        target.closest("[data-mcp-id]")
      );
      if (!btn || btn.hasAttribute("disabled")) return;
      const id = btn.getAttribute("data-mcp-id");

      // Confirmation for third-party MCP servers happens HOST-side via a native
      // modal (window.confirm is unreliable in VS Code webviews — it can
      // silently return false). We pass thirdParty so the host can prompt.
      const server = lastMcpServers.find((s) => s && s.id === id);

      btn.textContent = "Installing…";
      btn.setAttribute("disabled", "");
      vscode.postMessage({
        type: "installMcp",
        id,
        thirdParty: !!(server && server.thirdParty),
      });
    });
  }

  // ── Packs list install-button handler (event delegation) ─────────

  if (packsListEl) {
    packsListEl.addEventListener("click", (e) => {
      const target = /** @type {HTMLElement} */ (e.target);

      const removeBtn = /** @type {HTMLElement|null} */ (
        target.closest("[data-remove-pack-id]")
      );
      if (removeBtn && !removeBtn.hasAttribute("disabled")) {
        const rid = removeBtn.getAttribute("data-remove-pack-id");
        // Host shows its own native confirmation before removing.
        removeBtn.textContent = "Removing…";
        removeBtn.setAttribute("disabled", "");
        vscode.postMessage({ type: "removePack", id: rid });
        return;
      }

      const btn = /** @type {HTMLElement|null} */ (
        target.closest("[data-pack-id]")
      );
      if (!btn || btn.hasAttribute("disabled")) return;
      const id = btn.getAttribute("data-pack-id");

      // Confirmation for third-party packs happens HOST-side via a native modal
      // (window.confirm is unreliable in VS Code webviews — it can silently
      // return false). We pass thirdParty + disclosures so the host can prompt.
      const pack = lastPacks.find((p) => p && p.id === id);
      const disclosures = (pack && Array.isArray(pack.disclosures)) ? pack.disclosures : [];

      btn.textContent = "Installing…";
      btn.setAttribute("disabled", "");
      vscode.postMessage({
        type: "installPack",
        id,
        thirdParty: !!(pack && pack.thirdParty),
        disclosures,
      });
    });
  }

  // ── Setup / install overlay ──────────────────────────────────────

  const setupViewEl    = /** @type {HTMLElement} */ (document.getElementById("setup-view"));
  const appEl          = /** @type {HTMLElement} */ (document.getElementById("app"));
  const setupStatusEl  = /** @type {HTMLElement} */ (document.getElementById("setup-status"));
  const installHooksBtn = /** @type {HTMLElement} */ (document.getElementById("install-hooks-btn"));
  const setupErrorEl   = /** @type {HTMLElement} */ (document.getElementById("setup-error"));
  const setupConfigEl  = /** @type {HTMLElement} */ (document.getElementById("setup-config"));
  const setupBackBtn   = /** @type {HTMLElement} */ (document.getElementById("setup-back-btn"));
  // Pre-install delegation-style choice (Team Lead Mode, Phase 1). Once hooks
  // are installed, the ongoing control is the "Delegation style" section
  // rendered inside #setup-config by renderSettings() (Phase 2) — this
  // static picker is hidden then so the two controls never show at once.
  const delegationModeGroupEl = /** @type {HTMLElement} */ (document.getElementById("delegation-mode-group"));
  const menuSettingsBtn = /** @type {HTMLElement} */ (document.getElementById("menu-settings"));
  const menuThemesBtn   = /** @type {HTMLElement} */ (document.getElementById("menu-themes"));
  
  // Themes Modal Elements
  const themesModalEl       = /** @type {HTMLElement} */ (document.getElementById("themes-modal"));
  const themesModalCloseBtn = /** @type {HTMLElement} */ (document.getElementById("themes-modal-close"));
  const themesFooterCloseBtn = /** @type {HTMLElement} */ (document.getElementById("themes-footer-close"));
  const tabThemePicker      = /** @type {HTMLElement} */ (document.getElementById("tab-theme-picker"));
  const tabThemeBuilder     = /** @type {HTMLElement} */ (document.getElementById("tab-theme-builder"));
  const themePickerList     = /** @type {HTMLElement} */ (document.getElementById("theme-picker-list"));
  const themeBuilderPanel   = /** @type {HTMLElement} */ (document.getElementById("theme-builder-panel"));
  const themePickerGrid     = /** @type {HTMLElement} */ (document.getElementById("theme-picker-grid"));
  const themePickerStatus   = /** @type {HTMLElement} */ (document.getElementById("theme-picker-status"));
  const themeSelectedSection = /** @type {HTMLElement} */ (document.getElementById("theme-selected-section"));
  const themeSelectedHeading = /** @type {HTMLElement} */ (document.getElementById("theme-selected-heading"));
  const themeSelectedRoster  = /** @type {HTMLElement} */ (document.getElementById("theme-selected-roster"));
  const themeImportBtn      = /** @type {HTMLButtonElement} */ (document.getElementById("theme-import-btn"));
  const themePromptInput    = /** @type {HTMLInputElement} */ (document.getElementById("theme-prompt-input"));
  const themeGenerateBtn    = /** @type {HTMLElement} */ (document.getElementById("theme-generate-btn"));
  const themePlanEditor     = /** @type {HTMLElement} */ (document.getElementById("theme-plan-editor"));
  const themePlanName       = /** @type {HTMLInputElement} */ (document.getElementById("theme-plan-name"));
  const themePlanDirection  = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-direction"));
  const themePlanCharacters = /** @type {HTMLElement} */ (document.getElementById("theme-plan-characters"));
  const themePlanEnvironment = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-environment"));
  const themePlanEnemies    = /** @type {HTMLElement} */ (document.getElementById("theme-plan-enemies"));
  const themePlanDecorSlots = /** @type {HTMLElement} */ (document.getElementById("theme-plan-decor-slots"));
  const themePlanObjectsSlots = /** @type {HTMLElement} */ (document.getElementById("theme-plan-objects-slots"));
  const themePlanCrateDesc  = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-crate-desc"));
  const themePlanPoofDesc   = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-poof-desc"));
  const themePlanProjectileDesc = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-projectile-desc"));
  const themePlanExpressionsSlots = /** @type {HTMLElement} */ (document.getElementById("theme-plan-expressions-slots"));
  const themePlanAchievementsSlots = /** @type {HTMLElement} */ (document.getElementById("theme-plan-achievements-slots"));
  const themePlanValidation = /** @type {HTMLElement} */ (document.getElementById("theme-plan-validation"));
  const themePauseForReview = /** @type {HTMLInputElement} */ (document.getElementById("theme-pause-for-review"));
  const themeStartGenerationBtn = /** @type {HTMLButtonElement} */ (document.getElementById("theme-start-generation-btn"));
  const themeBuildStatus    = /** @type {HTMLElement} */ (document.getElementById("theme-build-status"));
  const themeBuildActions   = /** @type {HTMLElement} */ (document.getElementById("theme-build-actions"));
  const themeReviewImagesBtn = /** @type {HTMLElement} */ (document.getElementById("theme-review-images-btn"));
  const themeImageProvider  = /** @type {HTMLSelectElement} */ (document.getElementById("theme-image-provider"));
  const themeApiKeyInput    = /** @type {HTMLInputElement} */ (document.getElementById("theme-api-key-input"));
  const themeApiKeyLabel    = /** @type {HTMLElement} */ (document.getElementById("theme-api-key-label"));
  const themeApiKeySave     = /** @type {HTMLElement} */ (document.getElementById("theme-api-key-save"));
  const themeApiKeyStatus   = /** @type {HTMLElement} */ (document.getElementById("theme-api-key-status"));
  const themeImageReview    = /** @type {HTMLElement} */ (document.getElementById("theme-image-review"));
  const themeImageReviewTitle = /** @type {HTMLElement} */ (document.getElementById("theme-image-review-title"));
  const themeImageReviewSummary = /** @type {HTMLElement} */ (document.getElementById("theme-image-review-summary"));
  const themeImageReviewList = /** @type {HTMLElement} */ (document.getElementById("theme-image-review-list"));
  const themeReviewResumeGeneration = /** @type {HTMLButtonElement} */ (document.getElementById("theme-review-resume-generation"));
  const themeReviewStopGeneration = /** @type {HTMLButtonElement} */ (document.getElementById("theme-review-stop-generation"));
  const themeApproveAll = /** @type {HTMLButtonElement} */ (document.getElementById("theme-approve-all"));
  const themeOpenImagesFolder = /** @type {HTMLElement} */ (document.getElementById("theme-open-images-folder"));
  const themeHealthCheckBtn = /** @type {HTMLButtonElement} */ (document.getElementById("theme-health-check-btn"));
  const themeHealthResults  = /** @type {HTMLElement} */ (document.getElementById("theme-health-results"));
  const themeImageLightbox = /** @type {HTMLElement} */ (document.getElementById("theme-image-lightbox"));
  const themeImageLightboxBackdrop = /** @type {HTMLElement} */ (document.getElementById("theme-image-lightbox-backdrop"));
  const themeImageLightboxClose = /** @type {HTMLButtonElement} */ (document.getElementById("theme-image-lightbox-close"));
  const themeImageLightboxTitle = /** @type {HTMLElement} */ (document.getElementById("theme-image-lightbox-title"));
  const themeImageLightboxImage = /** @type {HTMLImageElement} */ (document.getElementById("theme-image-lightbox-image"));
  const themeBuilderRoot = /** @type {HTMLElement} */ (document.getElementById("theme-builder-root"));
  const themesDialog = /** @type {HTMLElement} */ (document.getElementById("themes-dialog"));
  const themesScrollEl = /** @type {HTMLElement} */ (document.getElementById("themes-scroll"));
  let reviewThemeId = "";
  /** @type {Array<any>} Last received THEMES_LIST payload, for re-render on selection change. */
  let lastThemesList = [];
  let currentThemePlan = null;
  let themeGenerationRunning = false;
  let themeGenerationStopping = false;
  let themeImageSettingsLoaded = false;
  let themeProviderConfigured = { gemini: false, openai: false };
  let themeImageLightboxTrigger = null;
  const themeReviewBusyItems = new Map();
  /** True while a SET_THEME_CREATIVE_DIRECTION save is in flight. Whole-theme
   * (not per-item, unlike themeReviewBusyItems) since there is exactly one
   * Creative Direction editor per theme — see buildThemeReviewCreativeDirectionSection. */
  let themeReviewCreativeDirectionBusy = false;
  /** Per-item Set of {"names","descriptions"} outstanding replies for the
   * merged "Names & descriptions" editor's single Apply click — see
   * buildThemeReviewNamesDescriptionsSection. */
  const themeReviewNamesDescriptionsPending = new Map();
  /** Sticky per-item retry sanitizer warning ("your notes looked like a full
   * prompt..."), keyed by item id. Set when a THEME_IMAGE_RETRY_STATE reply
   * carries `payload.warning`; cleared only when the user starts a new retry
   * for that item — it must survive the busy → progress → done sequence and
   * the full-list re-render that happens along the way. */
  const themeReviewRetryWarnings = new Map();
  /** The review-card "Upload" button awaiting a host result (for busy reset). */
  let pendingUploadBtn = null;
  /** Maps a theme-review item's `kind` to the REGENERATE_BOARD board string.
   * Kinds absent from this map (e.g. emote_atlas) don't get a per-card
   * Regenerate button — that board isn't independently regenerable. */
  const THEME_REVIEW_BOARD_BY_KIND = {
    character_atlas: "agents",
    rival_atlas: "enemy",
    object_atlas: "objects",
    environment: "environment",
    background_decor_atlas: "decor",
    expression_atlas: "expressions",
    achievement_atlas: "achievements",
  };
  /** item_id values with an in-flight REGENERATE_BOARD request from a review card. */
  const themeBoardRegenBusyItems = new Set();

  // Tracks whether the setup screen was reached via Settings (vs. first-run
  // install). When opened from Settings we stay on the screen even once the
  // hooks are installed, to show the (Phase 2) config + a Back button.
  let openedFromSettings = false;

  /** Tracks last uefnDetected state from checkInstall. */
  let lastUefnDetected = false;
  /** Tracks last uefnBridgeSetUp state from checkInstall (the .mcp.json
   *  uefn-bridge entry check panel.ts's _uefnBridgeEntry computes) — lets
   *  the "set up UEFN" prompt stop reappearing once it's already done. */
  let lastUefnBridgeSetUp = false;

  // 2-step first-run setup wizard state. "not-installed" (Step 1, default) ->
  // "optionals" (Step 2, entered only after a fresh install-hooks click in
  // THIS session) -> "done" (user clicked "Done - set up a theme"). Kept
  // separate from openedFromSettings/installed so a RETURNING session where
  // hooks were already installed before the panel loaded goes straight to
  // showMain() as before, instead of re-showing the wizard every reopen.
  let setupStage = "not-installed";
  /** True only after the user clicks "Install hooks" in THIS webview session. */
  let justInstalled = false;
  /** Namespaces the user has clicked "Remove" for (foreignManagedBlocks
   *  entries) in THIS webview session — lets renderSetupOptionals/
   *  renderSettings show a "✓ Removed legacy config block `ns:*`"
   *  confirmation for that namespace instead of just silently dropping the
   *  row once it flips out of info.foreignManagedBlocks. */
  let managedBlockRemovalRequested = new Set();

  /**
   * Show the full-bleed setup overlay; hide the live app view.
   * @param {{hideBootLoader?: boolean}} [opts] Pass `hideBootLoader: false` for
   *   the transient "we don't know the install/theme state yet" default shown
   *   at boot (below) — that call is NOT onboarding taking over, it's just the
   *   safe blank state until checkInstall resolves, and is almost always
   *   immediately replaced by showMain(). Killing the boot loader there was
   *   the bug: every panel open called showSetup() synchronously before any
   *   host response arrived, instantly hiding the overlay and leaving the
   *   bare placeholder scene visible while the real theme loaded underneath.
   */
  function showSetup(opts) {
    setupViewEl.removeAttribute("hidden");
    appEl.setAttribute("hidden", "");
    // Onboarding/install (or an install error) genuinely taking over — the
    // boot loader would otherwise sit on top of it (or behind it, forever).
    if (!opts || opts.hideBootLoader !== false) bootLoaderHideNow();
  }

  /** Show the live app view; hide the setup overlay. */
  function showMain() {
    setupViewEl.setAttribute("hidden", "");
    appEl.removeAttribute("hidden");
  }

  /**
   * React to an install-state push from the host.
   * @param {{installed:boolean, busy?:boolean, error?:string}} info
   */
  function handleInstallState(info) {
    // The pre-install delegation chooser's visibility is derived from install
    // state on EVERY path through this handler: hidden unless this exact
    // update says hooks are NOT installed (the only state where choosing a
    // mode at install time makes sense). It ships hidden in the HTML, so a
    // reload on an installed project never flashes it; installed projects
    // change mode via the "Delegation style" section renderSettings() builds
    // inside #setup-config instead.
    delegationModeGroupEl.setAttribute("hidden", "");

    if (info && info.busy) {
      showSetup();
      setupStatusEl.textContent = "Installing…";
      installHooksBtn.removeAttribute("hidden");
      installHooksBtn.setAttribute("disabled", "");
      installHooksBtn.textContent = "Installing…";
      setupErrorEl.setAttribute("hidden", "");
      setupConfigEl.setAttribute("hidden", "");
      setupBackBtn.setAttribute("hidden", "");
      return;
    }

    if (info && info.installed === false) {
      showSetup();
      setupStatusEl.textContent =
        "The TycoonAgents hook isn't installed yet. Install it to start visualizing agent activity.";
      installHooksBtn.removeAttribute("hidden");
      installHooksBtn.removeAttribute("disabled");
      installHooksBtn.textContent = "Install hooks";
      setupConfigEl.setAttribute("hidden", "");
      setupBackBtn.setAttribute("hidden", "");
      delegationModeGroupEl.removeAttribute("hidden");
      if (info.error) {
        setupErrorEl.textContent = info.error;
        setupErrorEl.removeAttribute("hidden");
      } else {
        setupErrorEl.setAttribute("hidden", "");
      }
      return;
    }

    // installed === true — the delegation-mode choice now lives in the
    // "Delegation style" section rendered inside #setup-config (Settings),
    // not this pre-install picker (hidden above, like every non-fresh path).
    if (openedFromSettings) {
      showSetup();
      setupStatusEl.textContent = "Hooks installed ✓";
      installHooksBtn.setAttribute("hidden", "");
      setupConfigEl.removeAttribute("hidden");
      setupBackBtn.removeAttribute("hidden");
      if (info && info.error) {
        setupErrorEl.textContent = info.error;
        setupErrorEl.removeAttribute("hidden");
        installHooksBtn.removeAttribute("hidden");
        installHooksBtn.removeAttribute("disabled");
        installHooksBtn.textContent = "Install hooks";
      } else {
        setupErrorEl.setAttribute("hidden", "");
      }
    } else if (setupStage === "done") {
      // A stray/duplicate installState push after the wizard was already
      // dismissed (Done clicked) should not reopen it.
      showMain();
    } else if (justInstalled || setupStage === "optionals") {
      // Step 2 (Optionals): STAY on the setup screen instead of switching to
      // the main app immediately. This used to be an unconditional
      // showMain(), which hid the whole screen before the UEFN card
      // (renderUefnPrompt, appended into #setup-card) — or any other
      // optional action — ever had a chance to render.
      setupStage = "optionals";
      showSetup();
      setupStatusEl.textContent = "Hooks installed ✓";
      installHooksBtn.setAttribute("hidden", "");
      if (info && info.error) {
        setupErrorEl.textContent = info.error;
        setupErrorEl.removeAttribute("hidden");
      } else {
        setupErrorEl.setAttribute("hidden", "");
      }
      renderSetupOptionals(info);
    } else {
      // Hooks were already installed before this webview session started
      // (a returning user reopening the panel) — go straight to the main
      // view, exactly like before this feature existed. The wizard only
      // appears right after a live "Install hooks" click.
      showMain();
    }
  }

  installHooksBtn.addEventListener("click", () => {
    justInstalled = true;
    const teamLeadsRadio = /** @type {HTMLInputElement|null} */ (
      document.getElementById("delegation-mode-team-leads")
    );
    const delegation_mode = teamLeadsRadio && teamLeadsRadio.checked ? "team_leads" : "flat";
    vscode.postMessage({ type: "installHooks", delegation_mode });
    // installHooks always turns the Review pass on by default (see
    // panel.ts's _handleInstallHooks). If the pre-install checkbox was
    // unchecked, follow up with a setReviewEnabled(false) — messages are
    // processed in order, so this lands right after install completes.
    const reviewPassCheckbox = /** @type {HTMLInputElement|null} */ (
      document.getElementById("review-pass-checkbox")
    );
    if (reviewPassCheckbox && !reviewPassCheckbox.checked) {
      vscode.postMessage({ type: "setReviewEnabled", enabled: false });
    }
  });

  menuSettingsBtn.addEventListener("click", () => {
    closeMenu();
    // If the Step-2 Optionals wizard is still mounted (e.g. reached Settings
    // via the hamburger menu instead of clicking through the wizard), remove
    // it first so it doesn't stay visibly stacked on top of the Settings
    // panel underneath. See removeSetupOptionalsNodes().
    removeSetupOptionalsNodes();
    setupStage = "done";
    openedFromSettings = true;
    showSetup();
    vscode.postMessage({ type: "checkInstall" });
    vscode.postMessage({ type: "getSettings" });
  });

  if (menuThemesBtn) {
    menuThemesBtn.addEventListener("click", () => {
      closeMenu();
      themePickerList.removeAttribute("hidden");
      themeBuilderPanel.setAttribute("hidden", "");
      openModal(themesModalEl, themesModalCloseBtn);
      vscode.postMessage({ type: 'LIST_THEMES' });
    });
  }

  if (themesModalCloseBtn) {
    themesModalCloseBtn.addEventListener("click", () => closeModal(themesModalEl));
  }

  if (themesFooterCloseBtn) {
    themesFooterCloseBtn.addEventListener("click", () => closeModal(themesModalEl));
  }

  if (themeImportBtn) {
    themeImportBtn.addEventListener("click", () => {
      themeImportBtn.disabled = true;
      if (themePickerStatus) {
        themePickerStatus.textContent = "Choose a theme .zip file...";
        themePickerStatus.classList.remove("theme-picker-status--error");
      }
      vscode.postMessage({ type: "IMPORT_THEME" });
    });
  }

  if (tabThemePicker && tabThemeBuilder) {
    tabThemePicker.addEventListener("click", () => {
      themePickerList.removeAttribute("hidden");
      themeBuilderPanel.setAttribute("hidden", "");
      tabThemeBuilder.focus();
      vscode.postMessage({ type: 'LIST_THEMES' });
    });

    tabThemeBuilder.addEventListener("click", () => {
      themeBuilderPanel.removeAttribute("hidden");
      themePickerList.setAttribute("hidden", "");
      tabThemePicker.focus();
      if (themeImageReview) themeImageReview.setAttribute("hidden", "");
      if (themeBuilderRoot) {
        if (themePlanEditor && !themePlanEditor.hasAttribute("hidden")) themeBuilderRoot.setAttribute("hidden", "");
        else themeBuilderRoot.removeAttribute("hidden");
      }

      // Boot up the theme builder canvas when the tab is first visited
      const root = document.getElementById("theme-builder-root");
      if (root && typeof window.initThemeBuilder === "function") {
        window.initThemeBuilder(root);
      }
      vscode.postMessage({ type: 'GET_THEME_IMAGE_SETTINGS' });
    });
  }

  function selectedThemeImageProvider() {
    return themeImageProvider && themeImageProvider.value === "gemini" ? "gemini" : "openai";
  }

  function updateThemeApiKeyUi(message, isError) {
    const provider = selectedThemeImageProvider();
    const providerLabel = provider === "openai" ? "OpenAI" : "Google Gemini";
    if (themeApiKeyLabel) themeApiKeyLabel.textContent = providerLabel + " API key";
    if (themeApiKeyInput) {
      themeApiKeyInput.placeholder = themeProviderConfigured[provider]
        ? "Key stored - paste to replace"
        : "Paste a key to save securely";
    }
    if (themeApiKeyStatus) {
      themeApiKeyStatus.textContent = message || (themeProviderConfigured[provider]
        ? providerLabel + " key is configured."
        : providerLabel + " key is not configured.");
      themeApiKeyStatus.style.color = isError
        ? "var(--vscode-errorForeground)"
        : "var(--vscode-descriptionForeground)";
    }
  }

  if (themeImageProvider) {
    themeImageProvider.addEventListener("change", () => updateThemeApiKeyUi("", false));
  }

  if (themeApiKeySave) {
    themeApiKeySave.addEventListener("click", () => {
      const provider = selectedThemeImageProvider();
      const apiKey = themeApiKeyInput ? themeApiKeyInput.value.trim() : "";
      if (!apiKey && !themeProviderConfigured[provider]) {
        updateThemeApiKeyUi("Paste an API key before saving.", true);
        return;
      }
      themeApiKeySave.setAttribute("disabled", "");
      themeApiKeySave.textContent = "Saving...";
      vscode.postMessage({
        type: 'SAVE_THEME_IMAGE_SETTINGS',
        payload: { provider, api_key: apiKey },
      });
    });
  }

  if (themeGenerateBtn && themePromptInput) {
    themeGenerateBtn.addEventListener("click", () => {
      const prompt = themePromptInput.value.trim();
      if (!prompt) return;
      const imageProvider = selectedThemeImageProvider();
      if (themeImageSettingsLoaded && !themeProviderConfigured[imageProvider]) {
        updateThemeApiKeyUi("Add and save an API key before generating.", true);
        return;
      }
      
      themeGenerateBtn.setAttribute("disabled", "");
      themeGenerateBtn.textContent = "Planning...";
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "AI is filling the theme slots...";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      
      vscode.postMessage({
        type: 'PLAN_THEME',
        payload: { prompt, image_provider: imageProvider },
      });
    });
  }

  // Fixed expression slot labels for the theme-plan generation form. Mirrors
  // the identical local const inside themeReviewDescriptionRows (used by the
  // POST-generation review editor) — kept as a separate small const here
  // rather than hoisting/sharing, since the two editors are otherwise
  // unrelated code paths and this list is small & effectively immutable
  // (gameplay maps expression events by slot position, see themePlan.ts).
  const THEME_PLAN_FIXED_EXPRESSION_LABELS = [
    "Love", "Idea / discovery spark", "Anger", "Team action / rally",
    "Thumbs up", "Music", "Sleep / low-energy zzz", "Dazed / hit",
  ];

  const THEME_PLAN_OBJECT_COUNT = 21;
  const THEME_PLAN_EXPRESSION_COUNT = 8;
  const THEME_PLAN_ACHIEVEMENT_COUNT = 25;
  const THEME_PLAN_CHARACTER_COUNT = 16;
  const THEME_PLAN_ENEMY_COUNT = 4;
  // Mirrors DECOR_BOARD_LAYOUT in src/extension/themePlan.ts: 4 sittable
  // seats (slot 0 = leader's throne) + 4 static props + 1 animated item.
  const THEME_PLAN_DECOR_COUNT = 9;
  const THEME_PLAN_DECOR_SEAT_COUNT = 4;
  const THEME_PLAN_DECOR_STATIC_COUNT = 4;

  /**
   * Renders `opts.count` per-slot rows into `container`, each with a 2-digit
   * index, a name (editable input, or read-only text when opts.nameReadOnly),
   * and an appearance/description textarea. Used by the theme-plan GENERATION
   * form (pre-generation) for objects/expressions/achievements, mirroring the
   * name+description block shape the POST-generation review editor already
   * uses (see themeReviewNamesDescriptionsRows) without sharing its DOM —
   * that editor works off per-atlas review items, this one off the flat
   * ThemePlan arrays.
   * @param {HTMLElement} container
   * @param {string[]} names
   * @param {string[]} descriptions
   * @param {{count:number, groupName:string, nameReadOnly?:boolean, lockedNote?:(index:number)=>(string|null), contextLine?:(index:number)=>(string|null), renderRowExtra?:(rowEl:HTMLElement, index:number)=>void}} opts
   */
  function renderPlanSlotsWithDesc(container, names, descriptions, opts) {
    if (!container) return;
    container.innerHTML = "";
    const count = opts.count;
    const groupName = opts.groupName;
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement("div");
      row.className = "theme-plan-slot-row";

      const nameLine = document.createElement("label");
      nameLine.className = "theme-plan-slot";
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      nameLine.appendChild(number);
      if (opts.nameReadOnly) {
        const nameText = document.createElement("span");
        nameText.className = "theme-plan-slot-name-readonly";
        nameText.textContent = (names && names[index]) || "";
        nameLine.appendChild(nameText);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.value = (names && names[index]) || "";
        input.dataset.planGroup = groupName;
        input.dataset.planIndex = String(index);
        input.dataset.planField = "name";
        nameLine.appendChild(input);
      }
      row.appendChild(nameLine);

      const desc = document.createElement("textarea");
      desc.className = "theme-plan-slot-desc";
      desc.rows = 2;
      desc.placeholder = "Appearance / description (optional)";
      desc.value = (descriptions && descriptions[index]) || "";
      desc.dataset.planGroup = groupName;
      desc.dataset.planIndex = String(index);
      desc.dataset.planField = "desc";
      row.appendChild(desc);

      const note = typeof opts.lockedNote === "function" ? opts.lockedNote(index) : null;
      if (note) {
        const noteEl = document.createElement("div");
        noteEl.className = "theme-plan-slot-note";
        noteEl.textContent = note;
        row.appendChild(noteEl);
      }

      const ctx = typeof opts.contextLine === "function" ? opts.contextLine(index) : null;
      if (ctx) {
        const ctxEl = document.createElement("div");
        ctxEl.className = "theme-plan-slot-context";
        ctxEl.textContent = ctx;
        row.appendChild(ctxEl);
      }

      if (typeof opts.renderRowExtra === "function") {
        opts.renderRowExtra(row, index);
      }

      container.appendChild(row);
    }
  }

  function renderThemePlan(plan) {
    currentThemePlan = plan;
    if (themePlanName) themePlanName.value = plan.display_name || "";
    if (themePlanDirection) themePlanDirection.value = plan.creative_direction || "";
    if (themePlanEnvironment) themePlanEnvironment.value = plan.environment || "";
    renderPlanSlotsWithDesc(themePlanCharacters, plan.characters || [], plan.character_descriptions || [], {
      count: THEME_PLAN_CHARACTER_COUNT,
      groupName: "characters",
      contextLine: (index) => (index === 0 ? "Leader (orchestrator)" : null),
    });
    renderPlanSlotsWithDesc(themePlanEnemies, plan.enemies || [], plan.enemy_descriptions || [], {
      count: THEME_PLAN_ENEMY_COUNT,
      groupName: "enemies",
      renderRowExtra: (rowEl, index) => {
        const currentStyle = (plan.enemy_attack_styles && plan.enemy_attack_styles[index]) || "melee";
        const select = document.createElement("select");
        select.className = "theme-plan-slot-attack";
        select.dataset.planGroup = "enemies";
        select.dataset.planIndex = String(index);
        select.dataset.planField = "attack";
        const meleeOpt = document.createElement("option");
        meleeOpt.value = "melee";
        meleeOpt.textContent = "Melee";
        const rangedOpt = document.createElement("option");
        rangedOpt.value = "ranged";
        rangedOpt.textContent = "Ranged";
        select.appendChild(meleeOpt);
        select.appendChild(rangedOpt);
        select.value = currentStyle === "ranged" ? "ranged" : "melee";
        rowEl.appendChild(select);
      },
    });
    renderPlanSlotsWithDesc(themePlanDecorSlots, plan.decor || [], plan.decor_descriptions || [], {
      count: THEME_PLAN_DECOR_COUNT,
      groupName: "decor",
      contextLine: (index) => {
        if (index < THEME_PLAN_DECOR_SEAT_COUNT) {
          return index === 0 ? "Seat 1 — Leader's throne (sittable)" : `Seat ${index + 1} (sittable)`;
        }
        if (index < THEME_PLAN_DECOR_SEAT_COUNT + THEME_PLAN_DECOR_STATIC_COUNT) return "Static decor";
        return "Animated decor";
      },
    });
    renderPlanSlotsWithDesc(themePlanObjectsSlots, plan.objects || [], plan.object_descriptions || [], {
      count: THEME_PLAN_OBJECT_COUNT,
      groupName: "objects",
      lockedNote: (index) => (index === 0
        ? "Building this unlocks ranged weapons — rename/redescribe freely, but slot 1 always stays the weapons rack."
        : null),
      contextLine: (index) => (index >= THEME_PLAN_OBJECT_COUNT - 2
        ? "Animated — this object gets a 4-frame idle loop, so make it motion-friendly (blinking lights, a spinning part, etc.)"
        : null),
    });
    if (themePlanCrateDesc) themePlanCrateDesc.value = plan.crate_description || "";
    if (themePlanPoofDesc) themePlanPoofDesc.value = plan.poof_description || "";
    if (themePlanProjectileDesc) themePlanProjectileDesc.value = plan.projectile_description || "";
    renderPlanSlotsWithDesc(themePlanExpressionsSlots, THEME_PLAN_FIXED_EXPRESSION_LABELS, plan.expression_descriptions || [], {
      count: THEME_PLAN_EXPRESSION_COUNT,
      groupName: "expressions",
      nameReadOnly: true,
    });
    renderPlanSlotsWithDesc(themePlanAchievementsSlots, plan.achievements || [], plan.achievement_descriptions || [], {
      count: THEME_PLAN_ACHIEVEMENT_COUNT,
      groupName: "achievements",
    });
    if (themePlanValidation) themePlanValidation.textContent = "";
    if (themePlanEditor) themePlanEditor.removeAttribute("hidden");
    if (themeImageReview) themeImageReview.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
  }

  /**
   * Collects per-slot name+description pairs rendered by
   * renderPlanSlotsWithDesc. Reads name/desc by data-plan-field rather than
   * DOM position so it works whether or not a name input is present
   * (nameReadOnly groups have no name input — see collectEditedThemePlan's
   * expressions handling, which ignores the `names` return and only uses
   * `descriptions`).
   * Also collects an optional per-row attack-style selector (`[data-plan-field="attack"]`,
   * appended via opts.renderRowExtra) into `attackStyles`; entries are `undefined`
   * when a row has no such selector, so groups that don't use renderRowExtra
   * (objects/expressions/achievements) are unaffected.
   * @param {HTMLElement} container
   * @returns {{names: string[], descriptions: string[], attackStyles: (string|undefined)[]}}
   */
  function collectPlanSlotsWithDesc(container) {
    const names = [];
    const descriptions = [];
    const attackStyles = [];
    if (!container) return { names, descriptions, attackStyles };
    const rows = Array.from(container.querySelectorAll(".theme-plan-slot-row"));
    rows.forEach((row) => {
      const nameInput = row.querySelector('[data-plan-field="name"]');
      names.push(nameInput ? nameInput.value.trim() : "");
      const descInput = row.querySelector('[data-plan-field="desc"]');
      descriptions.push(descInput ? descInput.value.trim() : "");
      const attackInput = row.querySelector('[data-plan-field="attack"]');
      attackStyles.push(attackInput ? attackInput.value : undefined);
    });
    return { names, descriptions, attackStyles };
  }

  function collectEditedThemePlan() {
    const characterSlots = collectPlanSlotsWithDesc(themePlanCharacters);
    const characters = characterSlots.names;
    const characterFilled = characters.filter(Boolean).length;
    if (characters.length !== THEME_PLAN_CHARACTER_COUNT || characterFilled !== THEME_PLAN_CHARACTER_COUNT) {
      throw new Error(`Characters needs all ${THEME_PLAN_CHARACTER_COUNT} filled slots (currently ${characterFilled}).`);
    }

    const enemySlots = collectPlanSlotsWithDesc(themePlanEnemies);
    const enemies = enemySlots.names;
    const enemyFilled = enemies.filter(Boolean).length;
    if (enemies.length !== THEME_PLAN_ENEMY_COUNT || enemyFilled !== THEME_PLAN_ENEMY_COUNT) {
      throw new Error(`Enemies needs all ${THEME_PLAN_ENEMY_COUNT} filled slots (currently ${enemyFilled}).`);
    }
    const enemyAttackStyles = enemySlots.attackStyles.map((style) => (style === "ranged" ? "ranged" : "melee"));

    const decorSlots = collectPlanSlotsWithDesc(themePlanDecorSlots);
    const decor = decorSlots.names;
    const decorFilled = decor.filter(Boolean).length;
    if (decor.length !== THEME_PLAN_DECOR_COUNT || decorFilled !== THEME_PLAN_DECOR_COUNT) {
      throw new Error(`Decor needs all ${THEME_PLAN_DECOR_COUNT} named slots (currently ${decorFilled}).`);
    }

    const displayName = themePlanName ? themePlanName.value.trim() : "";
    const creativeDirection = themePlanDirection ? themePlanDirection.value.trim() : "";
    const environment = themePlanEnvironment ? themePlanEnvironment.value.trim() : "";
    if (!displayName || !creativeDirection || !environment) throw new Error("Theme name, creative direction, and environment are required.");

    const objectSlots = collectPlanSlotsWithDesc(themePlanObjectsSlots);
    const objects = objectSlots.names;
    const objectFilled = objects.filter(Boolean).length;
    if (objects.length !== THEME_PLAN_OBJECT_COUNT || objectFilled !== THEME_PLAN_OBJECT_COUNT) {
      throw new Error(`Objects needs all ${THEME_PLAN_OBJECT_COUNT} named slots (currently ${objectFilled}).`);
    }

    const achievementSlots = collectPlanSlotsWithDesc(themePlanAchievementsSlots);
    const achievements = achievementSlots.names;
    const achievementFilled = achievements.filter(Boolean).length;
    if (achievements.length !== THEME_PLAN_ACHIEVEMENT_COUNT || achievementFilled !== THEME_PLAN_ACHIEVEMENT_COUNT) {
      throw new Error(`Achievement badges needs all ${THEME_PLAN_ACHIEVEMENT_COUNT} named slots (currently ${achievementFilled}).`);
    }

    const expressionSlots = collectPlanSlotsWithDesc(themePlanExpressionsSlots);

    return {
      ...currentThemePlan,
      theme_id: "",
      display_name: displayName,
      creative_direction: creativeDirection,
      characters,
      character_descriptions: characterSlots.descriptions,
      environment,
      enemies,
      enemy_descriptions: enemySlots.descriptions,
      enemy_attack_styles: enemyAttackStyles,
      decor,
      decor_descriptions: decorSlots.descriptions,
      objects,
      object_descriptions: objectSlots.descriptions,
      crate_description: themePlanCrateDesc ? themePlanCrateDesc.value.trim() : "",
      poof_description: themePlanPoofDesc ? themePlanPoofDesc.value.trim() : "",
      projectile_description: themePlanProjectileDesc ? themePlanProjectileDesc.value.trim() : (currentThemePlan.projectile_description || undefined),
      expressions: THEME_PLAN_FIXED_EXPRESSION_LABELS.slice(),
      expression_descriptions: expressionSlots.descriptions,
      achievements,
      achievement_descriptions: achievementSlots.descriptions,
    };
  }

  function requestThemeGenerationStop() {
    if (!themeGenerationRunning || themeGenerationStopping) return;
    themeGenerationStopping = true;
    if (themeStartGenerationBtn) {
      themeStartGenerationBtn.disabled = true;
      themeStartGenerationBtn.textContent = "Stopping...";
    }
    if (themeReviewStopGeneration) {
      themeReviewStopGeneration.disabled = true;
      themeReviewStopGeneration.textContent = "Stopping...";
    }
    vscode.postMessage({ type: 'CANCEL_THEME_GENERATION' });
  }

  function disableThemeRetryButtons() {
    if (!themeImageReviewList) return;
    for (const button of themeImageReviewList.querySelectorAll(".theme-review-retry")) {
      button.disabled = true;
    }
  }

  if (themePauseForReview) {
    themePauseForReview.addEventListener("change", () => {
      vscode.postMessage({
        type: 'SET_THEME_PAUSE_FOR_REVIEW',
        payload: { pause_for_review: themePauseForReview.checked },
      });
      if (themeGenerationRunning && themeBuildStatus) {
        if (!themePauseForReview.checked) disableThemeRetryButtons();
        themeBuildStatus.textContent = themePauseForReview.checked
          ? "Approval pauses are on. The next completed image will wait for review."
          : "Approval pauses are off. Generation will continue automatically.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
    });
  }

  if (themeStartGenerationBtn) {
    themeStartGenerationBtn.addEventListener("click", () => {
      if (themeGenerationRunning) {
        requestThemeGenerationStop();
        return;
      }
      try {
        const imageProvider = selectedThemeImageProvider();
        if (themeImageSettingsLoaded && !themeProviderConfigured[imageProvider]) {
          updateThemeApiKeyUi("Add and save an API key before generating.", true);
          return;
        }
        const plan = collectEditedThemePlan();
        currentThemePlan = plan;
        themeGenerationRunning = true;
        themeGenerationStopping = false;
        reviewThemeId = "";
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Stop generation";
        if (themeGenerateBtn) themeGenerateBtn.setAttribute("disabled", "");
        if (themePlanValidation) themePlanValidation.textContent = "";
        if (themeBuildActions) themeBuildActions.setAttribute("hidden", "");
        if (themeBuildStatus) {
          themeBuildStatus.textContent = themePauseForReview?.checked === false
            ? "Preparing 23 image generations..."
            : "Preparing the first image. Generation will pause for approval after each one.";
          themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
        }
        vscode.postMessage({
          type: 'GENERATE_THEME',
          payload: {
            plan,
            image_provider: imageProvider,
            pause_for_review: themePauseForReview?.checked !== false,
          },
        });
      } catch (error) {
        if (themePlanValidation) themePlanValidation.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  }

  if (themeReviewStopGeneration) {
    themeReviewStopGeneration.addEventListener("click", requestThemeGenerationStop);
  }

  if (themeReviewResumeGeneration) {
    themeReviewResumeGeneration.addEventListener("click", () => {
      if (!reviewThemeId || themeGenerationRunning) return;
      const imageProvider = selectedThemeImageProvider();
      if (themeImageSettingsLoaded && !themeProviderConfigured[imageProvider]) {
        updateThemeApiKeyUi("Add and save an API key before resuming.", true);
        return;
      }
      themeGenerationRunning = true;
      themeGenerationStopping = false;
      themeReviewResumeGeneration.hidden = true;
      themeReviewResumeGeneration.disabled = true;
      if (themeReviewStopGeneration) {
        themeReviewStopGeneration.hidden = false;
        themeReviewStopGeneration.disabled = false;
        themeReviewStopGeneration.textContent = "Stop generation";
      }
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Resuming unfinished image generations...";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      vscode.postMessage({
        type: 'GENERATE_THEME',
        payload: {
          resume_theme_id: reviewThemeId,
          image_provider: imageProvider,
          pause_for_review: themePauseForReview?.checked !== false,
        },
      });
    });
  }

  if (themeApproveAll) {
    themeApproveAll.addEventListener("click", () => {
      if (!reviewThemeId) return;
      themeApproveAll.disabled = true;
      themeApproveAll.textContent = "Approving...";
      vscode.postMessage({
        type: 'APPROVE_ALL_THEME_IMAGES',
        payload: { theme_id: reviewThemeId },
      });
    });
  }

  if (themeReviewImagesBtn) {
    themeReviewImagesBtn.addEventListener("click", () => {
      showThemeImageReview(reviewThemeId);
    });
  }

  if (themeOpenImagesFolder) {
    themeOpenImagesFolder.addEventListener("click", () => openThemeImages(reviewThemeId));
  }

  if (themeHealthCheckBtn) {
    themeHealthCheckBtn.addEventListener("click", () => {
      if (!reviewThemeId) return;
      themeHealthCheckBtn.disabled = true;
      themeHealthCheckBtn.textContent = "Checking…";
      if (themeHealthResults) {
        themeHealthResults.hidden = false;
        themeHealthResults.textContent = "";
        const pending = document.createElement("div");
        pending.className = "theme-health-row theme-health-pending";
        pending.textContent = "Running theme health check…";
        themeHealthResults.appendChild(pending);
      }
      vscode.postMessage({
        type: 'RUN_THEME_HEALTH_CHECK',
        payload: { theme_id: reviewThemeId },
      });
    });
  }

  function renderThemeHealthResult(payload) {
    if (themeHealthCheckBtn) {
      themeHealthCheckBtn.disabled = false;
      themeHealthCheckBtn.textContent = "Check theme health";
    }
    if (!themeHealthResults) return;
    themeHealthResults.hidden = false;
    themeHealthResults.textContent = "";
    const issues = Array.isArray(payload && payload.issues) ? payload.issues : [];
    if (payload && payload.error && issues.length === 0) {
      const row = document.createElement("div");
      row.className = "theme-health-row theme-health-error";
      row.textContent = "Health check failed: " + String(payload.error);
      themeHealthResults.appendChild(row);
      return;
    }
    if (issues.length === 0) {
      const row = document.createElement("div");
      row.className = "theme-health-row theme-health-ok";
      row.textContent = "No issues found ✓";
      themeHealthResults.appendChild(row);
      return;
    }
    issues.forEach((issue) => {
      const severity = issue && issue.severity === "warning" ? "warning" : "error";
      const row = document.createElement("div");
      row.className = "theme-health-row theme-health-" + severity;
      const tag = document.createElement("span");
      tag.className = "theme-health-severity";
      tag.textContent = severity === "warning" ? "WARN" : "ERROR";
      row.appendChild(tag);
      const text = document.createElement("span");
      text.className = "theme-health-message";
      const entity = issue && (issue.entity || issue.key)
        ? " (" + [issue.entity, issue.key].filter(Boolean).join(" · ") + ")"
        : "";
      text.textContent = (issue && issue.message ? String(issue.message) : "Unknown issue") + entity;
      row.appendChild(text);
      themeHealthResults.appendChild(row);
    });
  }

  function openThemeImages(themeId) {
    if (!themeId) return;
    vscode.postMessage({ type: 'OPEN_THEME_IMAGES', payload: { theme_id: themeId } });
  }

  function openThemeImageLightbox(imageSrc, label, trigger) {
    if (!themeImageLightbox || !themeImageLightboxImage) return;
    themeImageLightboxTrigger = trigger;
    themeImageLightboxImage.src = imageSrc;
    themeImageLightboxImage.alt = label;
    if (themeImageLightboxTitle) themeImageLightboxTitle.textContent = label;
    themeImageLightbox.removeAttribute("hidden");
    themeImageLightboxClose?.focus();
  }

  function closeThemeImageLightbox() {
    if (!themeImageLightbox || themeImageLightbox.hasAttribute("hidden")) return;
    themeImageLightbox.setAttribute("hidden", "");
    if (themeImageLightboxImage) {
      themeImageLightboxImage.removeAttribute("src");
      themeImageLightboxImage.alt = "";
    }
    themeImageLightboxTrigger?.focus();
    themeImageLightboxTrigger = null;
  }

  themeImageLightboxClose?.addEventListener("click", closeThemeImageLightbox);
  themeImageLightboxBackdrop?.addEventListener("click", closeThemeImageLightbox);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && themeImageLightbox && !themeImageLightbox.hasAttribute("hidden")) {
      event.stopImmediatePropagation();
      closeThemeImageLightbox();
    }
  });

  function showThemeImageReview(themeId) {
    if (!themeId) return;
    reviewThemeId = themeId;
    themePickerList.setAttribute("hidden", "");
    themeBuilderPanel.removeAttribute("hidden");
    if (themePlanEditor) themePlanEditor.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
    if (themeImageReview) themeImageReview.removeAttribute("hidden");
    if (themeImageReviewList) themeImageReviewList.textContent = "Loading generated images...";
    if (themeApproveAll) {
      themeApproveAll.disabled = true;
      themeApproveAll.textContent = "Approve all";
    }
    vscode.postMessage({ type: 'GET_THEME_IMAGE_SETTINGS' });
    vscode.postMessage({ type: 'GET_THEME_IMAGE_REVIEW', payload: { theme_id: themeId } });
  }

  function captureThemeReviewUiState() {
    const drafts = new Map();
    if (themeImageReviewList) {
      for (const card of themeImageReviewList.querySelectorAll("[data-item-id]")) {
        const itemId = card.getAttribute("data-item-id");
        if (!itemId) continue;
        const names = {};
        for (const input of card.querySelectorAll(".theme-review-names-input")) {
          const rowId = input.getAttribute("data-row-id");
          if (rowId) names[rowId] = input.value;
        }
        const descriptions = {};
        for (const textarea of card.querySelectorAll(".theme-review-descriptions-input")) {
          const rowId = textarea.getAttribute("data-row-id");
          if (rowId) descriptions[rowId] = textarea.value;
        }
        drafts.set(itemId, {
          feedback: card.querySelector(".theme-review-feedback")?.value || "",
          characterName: card.querySelector(".theme-review-name-input")?.value || "",
          // Single merged section now — namesOpen drives the one <details>
          // (the old, separate descriptionsOpen flag is retired). The Creative
          // Direction section moved out of per-item cards entirely (0.0.362 —
          // now a single always-visible panel at the top of the review), so
          // there is no per-card open/closed state left to capture for it.
          namesOpen: Boolean(card.querySelector(".theme-review-names-descriptions-details")?.open),
          names,
          descriptions,
        });
      }
    }
    return {
      drafts,
      scrollTop: themesScrollEl?.scrollTop || 0,
    };
  }

  /**
   * Board-row metadata for the theme review screen's inline "Names" editor.
   * Manifest display_names drive board regeneration prompts (see
   * buildReplacementPrompt/objectRowsForItem/decorRowsForItem/rivalRowsForItem
   * in themeService.ts), so this is the ONLY supported way to rename buildable
   * objects, decor items, and rivals — the old Stage Editor "✎ Rename" buttons
   * were removed because window.prompt() is disabled in VS Code webviews and
   * silently no-ops. Character boards already have a working single-item
   * rename ("Character name" / Save name, RENAME_THEME_CHARACTER) and are
   * intentionally left out of this batch editor.
   * @param {any} item a THEME_IMAGE_REVIEW review item
   * @returns {Array<{rowId: string, itemKind: "object"|"decor"|"rival"|"badge", label: string, original: string}>}
   */
  function themeReviewNameRows(item) {
    if (item.kind === "object_atlas" && Array.isArray(item.object_rows)) {
      // v3 object pipeline (themeImageReviewState.ts ThemeObjectBoardRow):
      // board `objects_01` is exactly OBJECT_BOARD1_STATIC_COUNT (16)
      // `object_static` rows (Object 1..16); board `objects_02` is the fixed
      // 7-entry order [object_anim, object_anim, poof, object_static,
      // object_static, object_static, crate] — 2 animated (row 1-2), a poof
      // one-shot (row 3), 3 static objects + a crate (row 4).
      // Labels use the global object number, not the humanized object_id,
      // since the id is immutable and a humanized-id label would read as
      // "the old name" forever once renamed via this editor.
      // `poof`/`crate` rows carry no object_id/display_name and aren't
      // renameable (SET_THEME_ITEM_NAMES's item_kind enum has no 'poof' or
      // 'crate' case — see messages.ts), so they're filtered out here same
      // as any other row missing an object_id; this is NOT a fixed
      // rows-per-board chunk boundary, it mirrors OBJECT_BOARD1_STATIC_COUNT
      // (the host's own board-1/board-2 split point in themeAssetPrompts.ts).
      // Board 2's row array is in CELL order (anim, anim, poof, static x3,
      // crate), but its true global spec order (themeObjectSpecs) is board-2
      // statics (17-19) THEN animated (20-21) — see objectSpecs slicing in
      // reviewSynthesisItems (themeService.ts): board2StaticSpecs is
      // objectSpecs[16..19), animatedSpecs is objectSpecs[19..21). So the
      // number is derived per-kind (independent static/anim counters), not
      // from array position, to match the board-2 label ("Objects 17-21 (3
      // static + 2 animated)") and avoid a 17/18 vs 20/21 swap.
      const OBJECT_BOARD1_STATIC_COUNT = 16;
      const OBJECT_BOARD2_STATIC_COUNT = 3;
      const boardMatch = /objects_(\d+)/.exec(item.id || "");
      const boardNumber = boardMatch ? Number(boardMatch[1]) || 1 : 1;
      let staticIndex = 0;
      let animIndex = 0;
      // Board 2's row array is in CELL order (anim, anim, static x3), not
      // numeric order (statics are 17-19, animated are 20-21 — see the
      // globalNumber derivation below, which is the SAME value used for both
      // the displayed label and this sort key so a row can never show one
      // number while sorting as another). Sort ascending by that global
      // number so the editor lists 17, 18, 19, 20, 21 — the build order —
      // instead of the board's cell order. This is a no-op on board 1, whose
      // rows are already produced in ascending 1-16 order.
      return item.object_rows
        .filter((row) => row && (row.kind === "object_static" || row.kind === "object_anim") && row.object_id)
        .map((row) => {
          let globalNumber;
          if (boardNumber <= 1) {
            staticIndex += 1;
            globalNumber = staticIndex;
          } else if (row.kind === "object_static") {
            staticIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + staticIndex;
          } else {
            animIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + OBJECT_BOARD2_STATIC_COUNT + animIndex;
          }
          return {
            rowId: row.object_id,
            itemKind: "object",
            globalNumber,
            label:
              "Object " +
              globalNumber +
              (row.is_ranged_rack ? " (Weapons Rack)" : "") +
              (row.kind === "object_anim" ? " (animated)" : ""),
            original: row.display_name || "",
          };
        })
        .sort((a, b) => a.globalNumber - b.globalNumber);
    }
    if (item.kind === "background_decor_atlas" && Array.isArray(item.decor_rows)) {
      const rows = [];
      let seatIndex = 0;
      let decorIndex = 0;
      for (const row of item.decor_rows) {
        if (!row || !row.decor_id) continue;
        if (row.kind === "seat") {
          seatIndex += 1;
          rows.push({
            rowId: row.decor_id,
            itemKind: "decor",
            label: "Seat " + seatIndex + (seatIndex === 1 ? " (Leader's Throne)" : ""),
            original: row.display_name || "",
          });
        } else if (row.kind === "decor") {
          decorIndex += 1;
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Decor " + decorIndex, original: row.display_name || "" });
        } else if (row.kind === "decor_anim") {
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Animated decor", original: row.display_name || "" });
        }
        // Projectile rows are intentionally excluded — no display_name, not user-facing.
      }
      return rows;
    }
    if (item.kind === "rival_atlas" && Array.isArray(item.rival_rows)) {
      // Positional labels ("Rival 1"..), same reasoning as the object rows above.
      let rivalIndex = 0;
      return item.rival_rows
        .filter((row) => row && row.rival_id)
        .map((row) => {
          rivalIndex += 1;
          return {
            rowId: row.rival_id,
            itemKind: "rival",
            label: "Rival " + rivalIndex,
            original: row.display_name || "",
          };
        });
    }
    if (item.kind === "achievement_atlas" && Array.isArray(item.achievement_names)) {
      // Themed, positional badge names (Badge 1..25). Posts item_kind "badge",
      // rowId achievement_<index> — see applyThemeItemNameChanges' badge branch.
      // Enrich each slot label with the event the badge rewards, derived from
      // the manifest badge at the SAME index (themeBadges === manifest.badges,
      // populated where manifest is applied) via badgeEventTitle — which reads
      // the canonical trigger_type + threshold, NOT display_name (that gets
      // overwritten with themed flavor text on rename). The "Badge N" prefix is
      // kept so existing UX/tests that match it still hold; the " — <title>"
      // suffix is purely additive context. Fully guarded: a missing/short
      // themeBadges, or a badge with no trigger_type/threshold, cleanly falls
      // back to plain "Badge N".
      const badges = Array.isArray(themeBadges) ? themeBadges : [];
      return item.achievement_names.map((name, index) => {
        const bd = badges[index] || null;
        const eventTitle = bd ? badgeEventTitle(bd) : null;
        return {
          rowId: "achievement_" + index,
          itemKind: "badge",
          label: "Badge " + (index + 1) + (eventTitle ? " — " + eventTitle : ""),
          original: name || "",
        };
      });
    }
    return [];
  }

  /**
   * Board-row metadata for the theme review screen's inline "Descriptions"
   * editor (0.0.265's per-item visual_description text, added 0.0.266). Unlike
   * themeReviewNameRows, this INCLUDES the character_atlas card (one row, the
   * board's own item.id/character_description) since character descriptions
   * have no other edit surface — the existing "Character name" field only
   * covers the name. Descriptions live in plan.json
   * (character_descriptions/object_descriptions/decor_descriptions/
   * enemy_descriptions), never the manifest — see SET_THEME_ITEM_DESCRIPTIONS
   * and applyThemeItemDescriptionChanges in themeService.ts.
   * @param {any} item a THEME_IMAGE_REVIEW review item
   * @returns {Array<{rowId: string, itemKind: "object"|"decor"|"rival"|"character", label: string, original: string}>}
   */
  function themeReviewDescriptionRows(item) {
    if (item.kind === "character_atlas") {
      return [{
        rowId: item.id,
        itemKind: "character",
        label: "Visual description",
        original: item.character_description || "",
      }];
    }
    if (item.kind === "object_atlas" && Array.isArray(item.object_rows)) {
      // v3 object pipeline — see the matching comment in themeReviewNameRows
      // above for the full board-1/board-2 layout and the per-kind global
      // numbering (board 2 statics are 17-19, animated are 20-21).
      const OBJECT_BOARD1_STATIC_COUNT = 16;
      const OBJECT_BOARD2_STATIC_COUNT = 3;
      const boardMatch = /objects_(\d+)/.exec(item.id || "");
      const boardNumber = boardMatch ? Number(boardMatch[1]) || 1 : 1;
      let staticIndex = 0;
      let animIndex = 0;
      // See the matching sort comment in themeReviewNameRows: board 2's row
      // array is in CELL order (anim, anim, static x3), so sort ascending by
      // the same globalNumber used for the label to list 17-19 then 20-21
      // (build order). No-op on board 1 (already 1-16 in order). crate/poof
      // are pushed onto `rows` AFTER this sort, so they stay last.
      const rows = item.object_rows
        .filter((row) => row && (row.kind === "object_static" || row.kind === "object_anim") && row.object_id)
        .map((row) => {
          let globalNumber;
          if (boardNumber <= 1) {
            staticIndex += 1;
            globalNumber = staticIndex;
          } else if (row.kind === "object_static") {
            staticIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + staticIndex;
          } else {
            animIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + OBJECT_BOARD2_STATIC_COUNT + animIndex;
          }
          return {
            rowId: row.object_id,
            itemKind: "object",
            globalNumber,
            label:
              "Object " +
              globalNumber +
              (row.is_ranged_rack ? " (Weapons Rack)" : "") +
              (row.kind === "object_anim" ? " (animated)" : ""),
            original: row.visual_description || "",
          };
        })
        .sort((a, b) => a.globalNumber - b.globalNumber);
      // Object board 2 also carries the single REQUIRED build crate and
      // build-completion poof effect (v3 object pipeline — see
      // buildObjectBoard2Prompt in themeAssetPrompts.ts). Unlike every other
      // row above, these are description-ONLY (no name row — see
      // themeReviewNameRows, which deliberately omits 'crate'/'poof' from
      // SET_THEME_ITEM_NAMES' item_kind enum) and are never renamed or
      // removed; only their appearance is editable. They only exist on
      // board 2 (the board whose item carries crate_description/
      // poof_description), never board 1.
      if (boardNumber >= 2) {
        rows.push({ rowId: "crate", itemKind: "crate", label: "Build crate (required)", original: item.crate_description || "" });
        rows.push({ rowId: "poof", itemKind: "poof", label: "Build poof effect (required)", original: item.poof_description || "" });
      }
      return rows;
    }
    if (item.kind === "background_decor_atlas" && Array.isArray(item.decor_rows)) {
      const rows = [];
      let seatIndex = 0;
      let decorIndex = 0;
      for (const row of item.decor_rows) {
        if (!row || !row.decor_id) continue;
        if (row.kind === "seat") {
          seatIndex += 1;
          rows.push({
            rowId: row.decor_id,
            itemKind: "decor",
            label: "Seat " + seatIndex + (seatIndex === 1 ? " (Leader's Throne)" : ""),
            original: row.visual_description || "",
          });
        } else if (row.kind === "decor") {
          decorIndex += 1;
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Decor " + decorIndex, original: row.visual_description || "" });
        } else if (row.kind === "decor_anim") {
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Animated decor", original: row.visual_description || "" });
        }
      }
      // The ranged-weapon-fire projectile FX (row 4, four frames) is describe-only —
      // like crate/poof on the object board, it has no display_name and is never
      // renamed or removed (see themeReviewNameRows, which omits 'projectile' from
      // SET_THEME_ITEM_NAMES' item_kind enum). Its appearance lives in the single
      // plan.projectile_description field, not a decor row id.
      rows.push({ rowId: "projectile", itemKind: "projectile", label: "Ranged projectile (required)", original: item.projectile_description || "" });
      return rows;
    }
    if (item.kind === "rival_atlas" && Array.isArray(item.rival_rows)) {
      let rivalIndex = 0;
      return item.rival_rows
        .filter((row) => row && row.rival_id)
        .map((row) => {
          rivalIndex += 1;
          return {
            rowId: row.rival_id,
            itemKind: "rival",
            label: "Rival " + rivalIndex,
            original: row.visual_description || "",
          };
        });
    }
    if (item.kind === "expression_atlas") {
      // Expression APPEARANCE descriptions — positional, rowId expression_<index>,
      // item_kind "expression" (see applyThemeItemDescriptionChanges' expression
      // branch). The 8 expression LABELS are FIXED semantic hooks (love, idea,
      // anger, …) and are NOT editable — only the per-cell appearance text is.
      // There is deliberately NO name row for expressions (themeReviewNameRows
      // has no expression case), so this description-only row is unioned in as
      // descRow with a read-only label. item.expression_names carries the fixed
      // labels (plan.expressions === FIXED_EXPRESSION_LABELS); fall back to the
      // hardcoded list if it's absent.
      const FIXED_EXPRESSION_LABELS = [
        "Love", "Idea / discovery spark", "Anger", "Team action / rally",
        "Thumbs up", "Music", "Sleep / low-energy zzz", "Dazed / hit",
      ];
      const names = Array.isArray(item.expression_names) ? item.expression_names : [];
      const descriptions = Array.isArray(item.expression_descriptions) ? item.expression_descriptions : [];
      const rows = [];
      for (let i = 0; i < 8; i += 1) {
        const label = names[i] || FIXED_EXPRESSION_LABELS[i] || ("Expression " + (i + 1));
        rows.push({
          rowId: "expression_" + i,
          itemKind: "expression",
          label: "Expression " + (i + 1) + ": " + label,
          original: descriptions[i] || "",
        });
      }
      return rows;
    }
    if (item.kind === "achievement_atlas" && Array.isArray(item.achievement_names)) {
      // Badge APPEARANCE descriptions — positional, rowId achievement_<index>,
      // item_kind "badge" (see applyThemeItemDescriptionChanges' badge branch).
      // These share rowIds with the badge NAME rows (themeReviewNameRows), so
      // themeReviewNamesDescriptionsRows merges each badge's name input and this
      // description textarea into one block. Kept separate from the name/title so
      // a user's appearance text no longer has to be crammed into the title.
      // Label matches the name rows (Badge N — <event>) via badgeEventTitle.
      const badges = Array.isArray(themeBadges) ? themeBadges : [];
      const descriptions = Array.isArray(item.achievement_descriptions) ? item.achievement_descriptions : [];
      return item.achievement_names.map((name, index) => {
        const bd = badges[index] || null;
        const eventTitle = bd ? badgeEventTitle(bd) : null;
        return {
          rowId: "achievement_" + index,
          itemKind: "badge",
          label: "Badge " + (index + 1) + (eventTitle ? " — " + eventTitle : ""),
          original: descriptions[index] || "",
        };
      });
    }
    return [];
  }

  /**
   * Unions themeReviewNameRows(item) and themeReviewDescriptionRows(item) by
   * rowId (== the underlying object_id/decor_id/rival_id/achievement row id/
   * character item.id) so the merged "Names & descriptions" editor can render
   * one block per item with the name input directly above its description
   * textarea. Preserves the row-set asymmetry from the two sources instead of
   * papering over it: badge rows have nameRow only (no description column for
   * achievements), character rows have descRow only (name lives in the
   * separate "Character name" / RENAME_THEME_CHARACTER widget), and
   * object/decor/rival rows have both. Order follows themeReviewNameRows
   * first (covers the common both-rows case), then appends any
   * description-only rows (character) not already seen.
   * @param {any} item a THEME_IMAGE_REVIEW review item
   * @returns {Array<{rowId: string, label: string, nameRow: object|null, descRow: object|null}>}
   */
  function themeReviewNamesDescriptionsRows(item) {
    const nameRows = themeReviewNameRows(item);
    const descRows = themeReviewDescriptionRows(item);
    const nameById = new Map(nameRows.map((row) => [row.rowId, row]));
    const descById = new Map(descRows.map((row) => [row.rowId, row]));
    const orderedIds = [];
    const seen = new Set();
    for (const row of nameRows) {
      if (seen.has(row.rowId)) continue;
      seen.add(row.rowId);
      orderedIds.push(row.rowId);
    }
    for (const row of descRows) {
      if (seen.has(row.rowId)) continue;
      seen.add(row.rowId);
      orderedIds.push(row.rowId);
    }
    return orderedIds.map((rowId) => {
      const nameRow = nameById.get(rowId) || null;
      const descRow = descById.get(rowId) || null;
      return { rowId, label: (nameRow || descRow).label, nameRow, descRow };
    });
  }

  /**
   * Builds the single, merged "Names & descriptions" editor: one block per
   * unioned row (see themeReviewNamesDescriptionsRows) with the name <input>
   * directly above the description <textarea> — omitting whichever field the
   * row doesn't carry (badges: name only; characters: description only). One
   * "Apply" button gathers CHANGED fields from both kinds and posts
   * SET_THEME_ITEM_NAMES / SET_THEME_ITEM_DESCRIPTIONS (existing payload
   * shapes, unchanged) — either, or both, depending on what actually changed.
   * Collapsed by default; open state is persisted the same way the old
   * separate sections did (captureThemeReviewUiState() reads
   * .theme-review-names-descriptions-details.open into savedDraft.namesOpen —
   * the old, now-retired descriptionsOpen flag no longer exists). Returns
   * null when the item's kind carries no nameable or describable rows.
   * @param {any} item
   * @param {{names?: Record<string,string>, descriptions?: Record<string,string>}|undefined} savedDraft
   * @param {boolean} busy true while a previous Apply for this board is in flight
   * @param {boolean} disabledForGeneration true while an unrelated active generation run blocks edits
   */
  function buildThemeReviewNamesDescriptionsSection(item, savedDraft, busy, disabledForGeneration) {
    const rows = themeReviewNamesDescriptionsRows(item);
    if (!rows.length) return null;
    const section = document.createElement("div");
    section.className = "theme-review-names-descriptions";
    const details = document.createElement("details");
    details.className = "theme-review-names-descriptions-details";
    details.open = Boolean(savedDraft?.namesOpen);
    const summary = document.createElement("summary");
    summary.textContent = "Names & descriptions";
    details.appendChild(summary);
    details.addEventListener("toggle", () => {
      if (savedDraft) savedDraft.namesOpen = details.open;
    });
    const hint = document.createElement("div");
    hint.className = "theme-review-names-descriptions-hint";
    hint.textContent = "Descriptions are optional — leave blank to let the image generator work from the name alone.";
    details.appendChild(hint);
    const grid = document.createElement("div");
    grid.className = "theme-review-names-descriptions-grid";
    const inputsDisabled = busy || disabledForGeneration;
    const nameInputs = [];
    const descInputs = [];
    for (const row of rows) {
      // The build crate and poof effect are required for every theme (never
      // renamed or removed) — flag that once, right before the first of the
      // two rows, so it reads as a note about them specifically rather than
      // a blanket statement at the top of the whole editor.
      if (row.rowId === "crate") {
        const requiredNote = document.createElement("div");
        requiredNote.className = "theme-review-names-descriptions-hint";
        requiredNote.textContent = "The build crate and poof effect below are required for every theme — you can describe their appearance, but not rename or remove them.";
        grid.appendChild(requiredNote);
      }
      const rowEl = document.createElement("div");
      rowEl.className = "theme-review-names-descriptions-row";
      const labelEl = document.createElement("span");
      labelEl.className = "theme-review-names-descriptions-label";
      labelEl.textContent = row.label;
      rowEl.appendChild(labelEl);
      if (row.nameRow) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "theme-review-name-input theme-review-names-input";
        input.maxLength = 60;
        input.placeholder = "Name";
        input.dataset.rowId = row.nameRow.rowId;
        input.dataset.itemKind = row.nameRow.itemKind;
        input.dataset.original = row.nameRow.original;
        const draftValue = savedDraft?.names && Object.prototype.hasOwnProperty.call(savedDraft.names, row.nameRow.rowId)
          ? savedDraft.names[row.nameRow.rowId]
          : row.nameRow.original;
        input.value = draftValue;
        input.disabled = inputsDisabled;
        rowEl.appendChild(input);
        nameInputs.push(input);
      }
      if (row.descRow) {
        const textarea = document.createElement("textarea");
        textarea.className = "theme-review-description-input theme-review-descriptions-input";
        textarea.rows = 2;
        textarea.maxLength = 400;
        textarea.placeholder = "Optional appearance description…";
        textarea.dataset.rowId = row.descRow.rowId;
        textarea.dataset.itemKind = row.descRow.itemKind;
        textarea.dataset.original = row.descRow.original;
        const draftValue = savedDraft?.descriptions && Object.prototype.hasOwnProperty.call(savedDraft.descriptions, row.descRow.rowId)
          ? savedDraft.descriptions[row.descRow.rowId]
          : row.descRow.original;
        textarea.value = draftValue;
        textarea.disabled = inputsDisabled;
        rowEl.appendChild(textarea);
        descInputs.push(textarea);
      }
      grid.appendChild(rowEl);
    }
    details.appendChild(grid);
    const applyBtn = document.createElement("button");
    applyBtn.className = "skill-btn theme-review-names-descriptions-apply";
    applyBtn.type = "button";
    applyBtn.textContent = busy ? "Saving..." : "Apply";
    const statusEl = document.createElement("div");
    statusEl.className = "theme-review-names-descriptions-status";
    const dirtyNameChanges = () => nameInputs
      .map((input) => ({ input, trimmed: input.value.trim().replace(/\s+/g, " ") }))
      .filter(({ input, trimmed }) => trimmed && trimmed.length <= 60 && trimmed !== input.dataset.original);
    // Unlike names, a description edit is dirty (and valid) even when the new
    // value is blank — clearing a description is a legitimate change.
    const dirtyDescriptionChanges = () => descInputs
      .map((input) => ({ input, trimmed: input.value.trim() }))
      .filter(({ input, trimmed }) => trimmed.length <= 400 && trimmed !== input.dataset.original);
    const updateApplyState = () => {
      applyBtn.disabled = inputsDisabled
        || (dirtyNameChanges().length === 0 && dirtyDescriptionChanges().length === 0);
    };
    for (const input of nameInputs) input.addEventListener("input", updateApplyState);
    for (const input of descInputs) input.addEventListener("input", updateApplyState);
    updateApplyState();
    applyBtn.addEventListener("click", () => {
      const nameChanges = [];
      for (const input of nameInputs) {
        const trimmed = input.value.trim().replace(/\s+/g, " ");
        if (!trimmed || trimmed.length > 60 || trimmed === input.dataset.original) {
          // Empty/whitespace/too-long edits are rejected client-side — revert
          // to the last known-good value instead of blocking the rest.
          input.value = input.dataset.original;
          continue;
        }
        nameChanges.push({ item_kind: input.dataset.itemKind, id: input.dataset.rowId, name: trimmed });
      }
      const descriptionChanges = [];
      for (const input of descInputs) {
        const trimmed = input.value.trim();
        if (trimmed.length > 400 || trimmed === input.dataset.original) {
          if (trimmed.length > 400) input.value = input.dataset.original;
          continue;
        }
        descriptionChanges.push({ item_kind: input.dataset.itemKind, id: input.dataset.rowId, description: trimmed });
      }
      if (!nameChanges.length && !descriptionChanges.length) {
        updateApplyState();
        return;
      }
      for (const input of nameInputs) input.disabled = true;
      for (const input of descInputs) input.disabled = true;
      applyBtn.disabled = true;
      applyBtn.textContent = "Saving...";
      statusEl.textContent = "";
      statusEl.classList.remove("theme-review-error");
      // Both messages can be in flight at once (host handles each
      // independently and resyncs with its own fresh THEME_IMAGE_REVIEW +
      // *_RESULT reply) — track which of the two this Apply actually sent so
      // the single button/inputs only re-enable once ALL of them have
      // settled (see applyThemeItemNamesResult/applyThemeItemDescriptionsResult).
      const pending = new Set();
      if (nameChanges.length) pending.add("names");
      if (descriptionChanges.length) pending.add("descriptions");
      themeReviewNamesDescriptionsPending.set(item.id, pending);
      themeReviewBusyItems.set(item.id, "names_descriptions");
      if (nameChanges.length) {
        vscode.postMessage({
          type: "SET_THEME_ITEM_NAMES",
          payload: { theme_id: reviewThemeId, board_id: item.id, changes: nameChanges },
        });
      }
      if (descriptionChanges.length) {
        vscode.postMessage({
          type: "SET_THEME_ITEM_DESCRIPTIONS",
          payload: { theme_id: reviewThemeId, board_id: item.id, changes: descriptionChanges },
        });
      }
    });
    details.appendChild(applyBtn);
    // Badge board only: restore canonical default badge TITLES, moving any custom
    // title the user typed into the badge's appearance description (host-side —
    // see resetThemeBadgeNames). The host shows a native modal confirm (webview
    // confirm() is a no-op) and reposts the review, which rebuilds this card and
    // clears the transient "Resetting…" state — so no separate result handler is
    // needed here.
    if (item.kind === "achievement_atlas") {
      const resetBtn = document.createElement("button");
      resetBtn.className = "skill-btn theme-review-reset-badge-names";
      resetBtn.type = "button";
      resetBtn.textContent = "Reset names to default";
      resetBtn.title = "Restore every badge's default title. Any custom title you typed is moved into that badge's appearance description so the art keeps it.";
      resetBtn.disabled = inputsDisabled;
      resetBtn.addEventListener("click", () => {
        resetBtn.disabled = true;
        resetBtn.textContent = "Resetting…";
        vscode.postMessage({
          type: "RESET_THEME_BADGE_NAMES",
          payload: { theme_id: reviewThemeId },
        });
      });
      details.appendChild(resetBtn);
    }
    details.appendChild(statusEl);
    section.appendChild(details);
    return section;
  }

  /**
   * Builds the post-generation "Creative Direction" panel: a single,
   * whole-theme textarea for ThemePlan.creative_direction (the art seed
   * themePlanCreativeDirection() threads into EVERY board's image prompt).
   * Rendered exactly once, as a dedicated section at the TOP of the theme
   * review — above every board card — rather than nested inside the
   * environment/background card, so the theme's original/current creative
   * direction is immediately visible instead of hidden behind a click.
   * Always visible (no collapsible <details>): a heading, the prefilled
   * textarea, the warning, and Save.
   * Posts SET_THEME_CREATIVE_DIRECTION on Save; the reply (THEME_CREATIVE_DIRECTION_RESULT)
   * is handled by applyThemeCreativeDirectionResult. Saving re-grounds any board
   * regenerated/retried from now on — it never touches already-generated art.
   * @param {string} themeId
   * @param {string|undefined} currentDirection the plan's current creative_direction (THEME_IMAGE_REVIEW payload)
   * @param {boolean} busy true while a previous Save for this theme is in flight
   */
  function buildThemeReviewCreativeDirectionSection(themeId, currentDirection, busy) {
    const section = document.createElement("div");
    section.className = "theme-review-names-descriptions theme-review-creative-direction-panel";

    const heading = document.createElement("h3");
    heading.className = "theme-review-creative-direction-heading";
    heading.textContent = "Creative direction";
    section.appendChild(heading);

    const textarea = document.createElement("textarea");
    textarea.className = "theme-review-creative-direction-input";
    textarea.rows = 4;
    textarea.value = currentDirection || "";
    textarea.dataset.original = currentDirection || "";
    textarea.disabled = busy;
    section.appendChild(textarea);

    const warning = document.createElement("div");
    warning.className = "theme-review-feedback-hint theme-review-custom-warning";
    warning.textContent = "Rewrites the creative direction for the whole theme. This re-grounds any board you regenerate or retry from now on — it does NOT change art you've already generated until you regenerate it.";
    section.appendChild(warning);

    const statusEl = document.createElement("div");
    statusEl.className = "theme-review-names-descriptions-status theme-review-creative-direction-status";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "skill-btn theme-review-creative-direction-save";
    saveBtn.textContent = busy ? "Saving…" : "Save creative direction";
    saveBtn.disabled = busy;
    saveBtn.addEventListener("click", () => {
      const value = textarea.value.trim();
      if (!value) {
        statusEl.textContent = "Creative direction cannot be empty.";
        statusEl.classList.add("theme-review-error");
        return;
      }
      themeReviewCreativeDirectionBusy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      textarea.disabled = true;
      statusEl.textContent = "";
      statusEl.classList.remove("theme-review-error");
      vscode.postMessage({
        type: "SET_THEME_CREATIVE_DIRECTION",
        payload: { theme_id: themeId, creative_direction: value },
      });
    });
    section.appendChild(saveBtn);
    section.appendChild(statusEl);
    return section;
  }

  /** Handles a THEME_CREATIVE_DIRECTION_RESULT reply: re-enables the editor and
   * shows a brief saved/failed confirmation. There is exactly one Creative
   * Direction section per theme (the dedicated panel at the top of the theme
   * review, above every board card), so this simply finds it by class rather
   * than matching a per-item id like the names/descriptions handlers above. */
  function applyThemeCreativeDirectionResult(payload) {
    themeReviewCreativeDirectionBusy = false;
    if (!themeImageReviewList) return;
    const textarea = themeImageReviewList.querySelector(".theme-review-creative-direction-input");
    if (!textarea) return;
    const saveBtn = themeImageReviewList.querySelector(".theme-review-creative-direction-save");
    const statusEl = themeImageReviewList.querySelector(".theme-review-creative-direction-status");
    textarea.disabled = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save creative direction";
    }
    if (statusEl) {
      if (payload.ok) {
        if (payload.creative_direction !== undefined) {
          textarea.value = payload.creative_direction;
          textarea.dataset.original = payload.creative_direction;
        }
        statusEl.textContent = "Creative direction saved ✓";
        statusEl.classList.remove("theme-review-error");
      } else {
        statusEl.textContent = "Save failed: " + (payload.error || "Unknown error.");
        statusEl.classList.add("theme-review-error");
      }
    }
  }

  /** Re-enables every name/description input plus the shared Apply button for
   * one merged editor once ALL pending SET_THEME_ITEM_NAMES/
   * SET_THEME_ITEM_DESCRIPTIONS replies for that board have settled. Called
   * from applyThemeItemNamesResult/applyThemeItemDescriptionsResult instead of
   * each handler only touching its own field kind, since the two share a
   * single Apply button that must not re-enable until BOTH are done. */
  function finalizeThemeReviewNamesDescriptions(card) {
    if (!card) return;
    const applyBtn = card.querySelector(".theme-review-names-descriptions-apply");
    for (const input of card.querySelectorAll(".theme-review-names-input")) input.disabled = false;
    for (const input of card.querySelectorAll(".theme-review-descriptions-input")) input.disabled = false;
    if (applyBtn) {
      applyBtn.textContent = "Apply";
      applyBtn.disabled = true;
    }
  }

  /** Handles a THEME_ITEM_DESCRIPTIONS_RESULT reply. Mirrors
   * applyThemeItemNamesResult: the host posts a fresh THEME_IMAGE_REVIEW (full
   * card rebuild reflecting the resynced prompt/rows — see
   * resyncDescriptionReviewItems in themeService.ts) immediately before this
   * message, so this only needs to patch the description fields plus status
   * text. The merged editor's single Apply button/inputs only get re-enabled
   * (via finalizeThemeReviewNamesDescriptions) once themeReviewNamesDescriptionsPending
   * shows no more outstanding names/descriptions replies for this board —
   * SET_THEME_ITEM_NAMES may still be in flight from the same Apply click. */
  function applyThemeItemDescriptionsResult(payload) {
    const boardId = payload.board_id || "";
    const pending = themeReviewNamesDescriptionsPending.get(boardId);
    if (pending) pending.delete("descriptions");
    const stillPending = Boolean(pending && pending.size);
    if (!stillPending) {
      themeReviewNamesDescriptionsPending.delete(boardId);
      themeReviewBusyItems.delete(boardId);
    }
    if (!themeImageReviewList) return;
    const cards = themeImageReviewList.querySelectorAll("[data-item-id]");
    for (const card of cards) {
      if (card.getAttribute("data-item-id") !== boardId) continue;
      const statusEl = card.querySelector(".theme-review-names-descriptions-status");
      const inputs = card.querySelectorAll(".theme-review-descriptions-input");
      const appliedById = new Map((payload.applied || []).map((change) => [change.id, change.description]));
      const rejectedById = new Map((payload.rejected || []).map((rejection) => [rejection.id, rejection.reason]));
      for (const input of inputs) {
        const rowId = input.getAttribute("data-row-id");
        if (rowId && appliedById.has(rowId)) {
          const nextDescription = appliedById.get(rowId);
          input.value = nextDescription;
          input.dataset.original = nextDescription;
        } else if (rowId && rejectedById.has(rowId)) {
          input.value = input.dataset.original;
        }
      }
      if (!stillPending) finalizeThemeReviewNamesDescriptions(card);
      if (statusEl) {
        if (payload.error) {
          statusEl.textContent = "Save failed: " + payload.error;
          statusEl.classList.add("theme-review-error");
        } else if (rejectedById.size) {
          const reasons = Array.from(rejectedById.values()).join(" ");
          statusEl.textContent = appliedById.size
            ? (appliedById.size + " description(s) saved; " + rejectedById.size + " rejected: " + reasons)
            : (reasons || "Descriptions were not saved.");
          statusEl.classList.toggle("theme-review-error", !appliedById.size);
        } else if (appliedById.size) {
          statusEl.textContent = "Descriptions saved ✓";
          statusEl.classList.remove("theme-review-error");
        }
      }
    }
  }

  /** Handles a THEME_ITEM_NAMES_RESULT reply. The host posts a fresh
   * THEME_IMAGE_REVIEW (full card rebuild, reflecting the resynced prompt/rows —
   * see resyncRenamedReviewItems in themeService.ts) immediately before this
   * message, so this only needs to patch the name fields plus status text —
   * labels are positional (see themeReviewNameRows) and never go stale. See
   * applyThemeItemDescriptionsResult for why the shared Apply button/inputs
   * only re-enable once themeReviewNamesDescriptionsPending is empty for this
   * board (a merged Apply click can have a SET_THEME_ITEM_DESCRIPTIONS reply
   * still outstanding). */
  function applyThemeItemNamesResult(payload) {
    const boardId = payload.board_id || "";
    const pending = themeReviewNamesDescriptionsPending.get(boardId);
    if (pending) pending.delete("names");
    const stillPending = Boolean(pending && pending.size);
    if (!stillPending) {
      themeReviewNamesDescriptionsPending.delete(boardId);
      themeReviewBusyItems.delete(boardId);
    }
    if (!themeImageReviewList) return;
    const cards = themeImageReviewList.querySelectorAll("[data-item-id]");
    for (const card of cards) {
      if (card.getAttribute("data-item-id") !== boardId) continue;
      const statusEl = card.querySelector(".theme-review-names-descriptions-status");
      const inputs = card.querySelectorAll(".theme-review-names-input");
      const appliedById = new Map((payload.applied || []).map((change) => [change.id, change.name]));
      const rejectedById = new Map((payload.rejected || []).map((rejection) => [rejection.id, rejection.reason]));
      for (const input of inputs) {
        const rowId = input.getAttribute("data-row-id");
        if (rowId && appliedById.has(rowId)) {
          const nextName = appliedById.get(rowId);
          input.value = nextName;
          input.dataset.original = nextName;
        } else if (rowId && rejectedById.has(rowId)) {
          input.value = input.dataset.original;
        }
      }
      if (!stillPending) finalizeThemeReviewNamesDescriptions(card);
      if (statusEl) {
        if (payload.error) {
          statusEl.textContent = "Save failed: " + payload.error;
          statusEl.classList.add("theme-review-error");
        } else if (rejectedById.size) {
          // Surface the server's per-row reason (e.g. 'Unknown rival "x".') instead of
          // a generic message, so a future id/kind mismatch is diagnosable from the UI.
          const reasons = Array.from(rejectedById.values()).join(" ");
          statusEl.textContent = appliedById.size
            ? (appliedById.size + " name(s) saved; " + rejectedById.size + " rejected: " + reasons)
            : (reasons || "Names were not saved.");
          statusEl.classList.toggle("theme-review-error", !appliedById.size);
        } else if (appliedById.size) {
          statusEl.textContent = "Names saved ✓";
          statusEl.classList.remove("theme-review-error");
        }
      }
    }
  }

  // Tracks the single open review-board right-click menu so a second right-click
  // (or any dismissal) always tears down the previous one first.
  let themeReviewContextMenuEl = null;
  let themeReviewContextMenuCleanup = null;

  function closeThemeReviewContextMenu() {
    if (themeReviewContextMenuCleanup) {
      try { themeReviewContextMenuCleanup(); } catch (_e) { /* ignore */ }
      themeReviewContextMenuCleanup = null;
    }
    if (themeReviewContextMenuEl && themeReviewContextMenuEl.parentNode) {
      themeReviewContextMenuEl.parentNode.removeChild(themeReviewContextMenuEl);
    }
    themeReviewContextMenuEl = null;
  }

  /**
   * Minimal one-item ("Open file location") right-click menu for a review board
   * card. Positioned at the cursor, dismissed on outside click, Escape, scroll,
   * or resize. Clicking the item posts REVEAL_THEME_IMAGE for the given board so
   * the host reveals its saved image file in the OS explorer. Fully guarded —
   * only opens for a card that carries an item id.
   * @param {number} clientX
   * @param {number} clientY
   * @param {string} itemId
   */
  function openThemeReviewContextMenu(clientX, clientY, itemId) {
    if (!itemId || !reviewThemeId) return;
    closeThemeReviewContextMenu();
    const menu = document.createElement("div");
    menu.className = "theme-review-context-menu";
    menu.style.cssText = "position:fixed;z-index:9999;min-width:150px;padding:4px;"
      + "background:var(--vscode-menu-background,#252526);"
      + "color:var(--vscode-menu-foreground,#ccc);"
      + "border:1px solid var(--vscode-menu-border,rgba(255,255,255,0.15));"
      + "border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,0.4);font-size:12px;";
    const openItem = document.createElement("button");
    openItem.type = "button";
    openItem.textContent = "Open file location";
    openItem.style.cssText = "display:block;width:100%;text-align:left;padding:5px 10px;"
      + "background:transparent;border:none;color:inherit;cursor:pointer;border-radius:3px;font-size:12px;";
    openItem.addEventListener("mouseenter", () => {
      openItem.style.background = "var(--vscode-menu-selectionBackground,rgba(255,255,255,0.12))";
    });
    openItem.addEventListener("mouseleave", () => { openItem.style.background = "transparent"; });
    openItem.addEventListener("click", () => {
      closeThemeReviewContextMenu();
      vscode.postMessage({
        type: "REVEAL_THEME_IMAGE",
        payload: { theme_id: reviewThemeId, item_id: itemId },
      });
    });
    menu.appendChild(openItem);
    document.body.appendChild(menu);
    themeReviewContextMenuEl = menu;

    // Clamp within the viewport so the menu never overflows off-screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(clientX, Math.max(0, window.innerWidth - rect.width - 4));
    const top = Math.min(clientY, Math.max(0, window.innerHeight - rect.height - 4));
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    const onOutside = (event) => { if (!menu.contains(event.target)) closeThemeReviewContextMenu(); };
    const onKey = (event) => { if (event.key === "Escape") closeThemeReviewContextMenu(); };
    // Defer the outside-click binding a tick so the originating right-click's
    // trailing events don't immediately dismiss the fresh menu.
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside, true);
      document.addEventListener("contextmenu", onOutside, true);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", closeThemeReviewContextMenu, true);
    window.addEventListener("resize", closeThemeReviewContextMenu, true);
    themeReviewContextMenuCleanup = () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("contextmenu", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", closeThemeReviewContextMenu, true);
      window.removeEventListener("resize", closeThemeReviewContextMenu, true);
    };
  }

  function renderThemeImageReview(payload) {
    if (!themeImageReview || !themeImageReviewList) return;
    // Clear/hide any stale health-check results from a previous manual click
    // so they don't linger over a new generation/review render — the health
    // panel is re-populated only by an explicit RUN_THEME_HEALTH_CHECK.
    if (themeHealthResults) {
      themeHealthResults.hidden = true;
      themeHealthResults.textContent = "";
    }
    // Host updates can arrive while the user is editing a different card. Keep
    // those local drafts and the review position instead of treating every
    // update as a brand-new panel.
    const reviewUiState = captureThemeReviewUiState();
    themeImageReview.removeAttribute("hidden");
    if (themePlanEditor) themePlanEditor.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
    themeImageReviewList.innerHTML = "";
    if (payload.error) {
      if (themeApproveAll) themeApproveAll.disabled = true;
      const error = document.createElement("div");
      error.className = "theme-review-empty theme-review-error";
      error.textContent = "Could not load generated images: " + payload.error;
      themeImageReviewList.appendChild(error);
      return;
    }

    // Dedicated Creative Direction section: a single, always-visible panel at
    // the TOP of the review, above every board card. Rendered exactly once per
    // render pass regardless of item count/kind (even with zero items or no
    // environment board) since the list is fully rebuilt from scratch above —
    // prepending it fresh here can never duplicate it.
    themeImageReviewList.appendChild(
      buildThemeReviewCreativeDirectionSection(
        reviewThemeId,
        payload.creative_direction,
        themeReviewCreativeDirectionBusy,
      ),
    );

    const items = Array.isArray(payload.items) ? payload.items : [];
    const waitingForReviewItemId = payload.waiting_for_review_item_id || "";
    const accepted = items.filter((item) => item.status === "accepted").length;
    const rejected = items.filter((item) => item.status === "rejected").length;
    const blocked = items.filter((item) => Boolean(item.generation_error)).length;
    const unfinished = items.filter((item) => item.generated !== true).length;
    const allGenerated = items.length > 0 && items.every((item) => Boolean(item.image_src));
    const allApproved = items.length > 0 && accepted === items.length;
    const activeGenerationItemId = payload.generation_active && !waitingForReviewItemId
      ? items.find((item) => item.generated !== true)?.id || ""
      : "";
    themeGenerationRunning = Boolean(payload.generation_active);
    if (themePauseForReview && typeof payload.pause_for_review === "boolean") {
      themePauseForReview.checked = payload.pause_for_review;
    }
    if (themeImageReviewTitle) {
      themeImageReviewTitle.textContent = (payload.display_name || "Theme") + " images";
    }
    if (themeImageReviewSummary) {
      themeImageReviewSummary.classList.remove("theme-review-error");
      themeImageReviewSummary.textContent = items.length
        ? `${accepted} accepted · ${rejected} rejected · ${blocked} blocked · ${items.length - accepted - rejected - blocked} pending`
        : (payload.generation_active ? "Waiting for the first image..." : "No generated images found.");
    }
    if (themeReviewStopGeneration) {
      themeReviewStopGeneration.hidden = !payload.generation_active;
      themeReviewStopGeneration.disabled = themeGenerationStopping;
      themeReviewStopGeneration.textContent = themeGenerationStopping ? "Stopping..." : "Stop generation";
    }
    if (themeReviewResumeGeneration) {
      themeReviewResumeGeneration.hidden = Boolean(payload.generation_active) || unfinished === 0;
      themeReviewResumeGeneration.disabled = Boolean(payload.generation_active);
      themeReviewResumeGeneration.textContent = unfinished === 1
        ? "Resume 1 generation"
        : `Resume ${unfinished} generations`;
      themeReviewResumeGeneration.title = unfinished > 0
        ? "Continue from the first unfinished image without regenerating completed work."
        : "Every image generation is complete.";
    }
    if (themeApproveAll) {
      themeApproveAll.disabled = Boolean(payload.generation_active) || !allGenerated || allApproved;
      themeApproveAll.textContent = allApproved ? "All approved" : "Approve all";
      themeApproveAll.title = allApproved
        ? "Every theme image is approved."
        : payload.generation_active || !allGenerated
          ? "Available after every theme image has finished generating."
          : `Approve all ${items.length} theme images.`;
    }

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "theme-review-empty";
      empty.textContent = payload.generation_active
        ? "Generation is running. Images will appear here as they finish."
        : "No generated images are available for this theme.";
      themeImageReviewList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const isCurrentReviewGate = waitingForReviewItemId === item.id;
      const card = document.createElement("article");
      card.className = "theme-review-card theme-review-card--" + item.status
        + (isCurrentReviewGate ? " theme-review-card--current" : "")
        + (item.generation_error ? " theme-review-card--blocked" : "");
      card.dataset.itemId = item.id;
      // Right-click a board card → minimal "Open file location" menu that reveals
      // this board's saved image file in the OS explorer (see openThemeReviewContextMenu).
      if (item.id) {
        card.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openThemeReviewContextMenu(event.clientX, event.clientY, item.id);
        });
      }

      const preview = item.image_src ? document.createElement("button") : document.createElement("div");
      preview.className = "theme-review-preview" + (item.image_src ? "" : " theme-review-preview--missing");
      if (item.kind === "character_atlas") preview.classList.add("theme-review-preview--character");
      if (item.image_src) {
        preview.type = "button";
        preview.setAttribute("aria-label", `View full-size image of ${item.label}`);
        const previewImage = document.createElement("img");
        previewImage.src = item.image_src;
        previewImage.alt = item.label;
        preview.appendChild(previewImage);
        preview.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openThemeImageLightbox(item.image_src, item.label, preview);
        });
      } else if (item.generation_error) {
        preview.textContent = "Generation blocked";
      } else {
        // Not-yet-generated board: render a clearly-labeled placeholder so it
        // reads as "this board hasn't been generated" rather than a broken image.
        preview.classList.add("theme-review-preview--placeholder-board");
        const placeholderBoard = THEME_REVIEW_BOARD_BY_KIND[item.kind]
          || item.kind.replace(/_/g, " ");
        const placeholderBox = document.createElement("div");
        placeholderBox.style.cssText = "display:flex;flex-direction:column;align-items:center;"
          + "justify-content:center;gap:4px;width:100%;height:100%;min-height:96px;box-sizing:border-box;"
          + "padding:8px;text-align:center;background:rgba(255,0,255,0.14);border:2px dashed #ff33ff;color:#ff33ff;";
        const placeholderKind = document.createElement("div");
        placeholderKind.style.cssText = "font-weight:700;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;";
        placeholderKind.textContent = `${placeholderBoard} board — not generated`;
        const placeholderLabel = document.createElement("div");
        placeholderLabel.style.cssText = "font-size:11px;opacity:0.85;";
        placeholderLabel.textContent = item.label;
        placeholderBox.appendChild(placeholderKind);
        placeholderBox.appendChild(placeholderLabel);
        preview.appendChild(placeholderBox);
      }

      const body = document.createElement("div");
      body.className = "theme-review-card-body";
      const heading = document.createElement("div");
      heading.className = "theme-review-card-heading";
      const title = document.createElement("h4");
      title.textContent = item.label;
      const status = document.createElement("span");
      status.className = "theme-review-status theme-review-status--"
        + (item.generation_error ? "blocked" : item.status);
      status.textContent = item.generation_error ? "blocked" : item.status;
      heading.appendChild(title);
      heading.appendChild(status);

      const meta = document.createElement("div");
      meta.className = "theme-review-meta";
      meta.textContent = `${item.kind.replace(/_/g, " ")} · revision ${item.revision}`;

      let generationError = null;
      if (item.generation_error) {
        generationError = document.createElement("div");
        generationError.className = "theme-review-generation-error";
        const errorMessage = document.createElement("strong");
        errorMessage.textContent = item.generation_error.message
          || "This image request was blocked. Revise its instructions and retry.";
        generationError.appendChild(errorMessage);
        const errorHelp = document.createElement("span");
        errorHelp.textContent = item.generation_error.request_id
          ? `Revise the creative direction below and retry. Request ID: ${item.generation_error.request_id}`
          : "Revise the creative direction below and retry.";
        generationError.appendChild(errorHelp);
      }

      let characterNameInput = null;
      let renameBtn = null;
      let nameRow = null;
      if (item.kind === "character_atlas") {
        nameRow = document.createElement("label");
        nameRow.className = "theme-review-name-row";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = "Character name";
        characterNameInput = document.createElement("input");
        characterNameInput.className = "theme-review-name-input";
        characterNameInput.type = "text";
        characterNameInput.maxLength = 80;
        const savedDraft = reviewUiState.drafts.get(item.id);
        characterNameInput.value = savedDraft?.characterName || item.subject || item.label || "";
        characterNameInput.disabled = Boolean(payload.generation_active && !isCurrentReviewGate);
        renameBtn = document.createElement("button");
        renameBtn.className = "skill-btn theme-review-rename";
        renameBtn.type = "button";
        renameBtn.textContent = "Save name";
        renameBtn.disabled = true;
        const updateRenameState = () => {
          const nextName = characterNameInput.value.trim().replace(/\s+/g, " ");
          renameBtn.disabled = characterNameInput.disabled || !nextName || nextName === item.subject;
        };
        characterNameInput.addEventListener("input", updateRenameState);
        characterNameInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !renameBtn.disabled) {
            event.preventDefault();
            renameBtn.click();
          }
        });
        renameBtn.addEventListener("click", () => {
          const nextName = characterNameInput.value.trim().replace(/\s+/g, " ");
          if (!nextName) {
            characterNameInput.focus();
            characterNameInput.setAttribute("aria-invalid", "true");
            return;
          }
          characterNameInput.removeAttribute("aria-invalid");
          characterNameInput.disabled = true;
          renameBtn.disabled = true;
          renameBtn.textContent = "Saving...";
          themeReviewBusyItems.set(item.id, "rename");
          vscode.postMessage({
            type: 'RENAME_THEME_CHARACTER',
            payload: { theme_id: reviewThemeId, item_id: item.id, name: nextName },
          });
        });
        if (themeReviewBusyItems.get(item.id) === "rename") {
          characterNameInput.disabled = true;
          renameBtn.disabled = true;
          renameBtn.textContent = "Saving...";
        }
        nameRow.appendChild(nameLabel);
        nameRow.appendChild(characterNameInput);
        nameRow.appendChild(renameBtn);
      }

      const decisionRow = document.createElement("div");
      decisionRow.className = "theme-review-actions";
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "skill-btn theme-review-accept";
      acceptBtn.textContent = "Keep";
      acceptBtn.disabled = !item.image_src
        || themeReviewBusyItems.has(item.id)
        || (payload.generation_active && !isCurrentReviewGate);
      acceptBtn.addEventListener("click", () => {
        acceptBtn.disabled = true;
        if (isCurrentReviewGate) disableThemeRetryButtons();
        acceptBtn.textContent = "Keeping...";
        vscode.postMessage({
          type: 'SET_THEME_IMAGE_REVIEW_STATUS',
          payload: { theme_id: reviewThemeId, item_id: item.id, status: 'accepted' },
        });
      });
      decisionRow.appendChild(acceptBtn);
      if (item.kind === "character_atlas") {
        const normalizeBtn = document.createElement("button");
        normalizeBtn.className = "skill-btn theme-review-normalize";
        normalizeBtn.type = "button";
        normalizeBtn.dataset.idleText = "Normalize size";
        normalizeBtn.textContent = "Normalize size";
        normalizeBtn.disabled = !item.image_src || Boolean(payload.generation_active && !isCurrentReviewGate);
        normalizeBtn.title = "Regenerate this character, then fit every frame to the shared production scale.";
        if (themeReviewBusyItems.get(item.id) === "normalize") {
          normalizeBtn.disabled = true;
          normalizeBtn.textContent = "Regenerating...";
        }
        normalizeBtn.addEventListener("click", () => {
          normalizeBtn.disabled = true;
          normalizeBtn.textContent = "Regenerating...";
          acceptBtn.disabled = true;
          themeReviewBusyItems.set(item.id, "normalize");
          vscode.postMessage({
            type: 'NORMALIZE_THEME_CHARACTER',
            payload: {
              theme_id: reviewThemeId,
              item_id: item.id,
              image_provider: selectedThemeImageProvider(),
            },
          });
        });
        decisionRow.appendChild(normalizeBtn);
      }

      // Manual replacement: upload an image from disk for this specific asset.
      const uploadBtn = document.createElement("button");
      uploadBtn.className = "skill-btn theme-review-upload";
      uploadBtn.type = "button";
      uploadBtn.dataset.idleText = "Upload";
      uploadBtn.textContent = "Upload";
      uploadBtn.title = item.kind === "character_atlas"
        ? "Replace this character with a 512×512 atlas image from your computer (it will be re-sliced)."
        : "Replace this image with one from your computer.";
      uploadBtn.disabled = Boolean(payload.generation_active && !isCurrentReviewGate);
      uploadBtn.addEventListener("click", () => {
        uploadBtn.disabled = true;
        uploadBtn.textContent = "Uploading…";
        pendingUploadBtn = uploadBtn;
        vscode.postMessage({
          type: 'UPLOAD_THEME_IMAGE',
          payload: {
            theme_id: reviewThemeId,
            item_id: item.id,
            image_provider: selectedThemeImageProvider(),
          },
        });
      });
      decisionRow.appendChild(uploadBtn);

      const feedback = document.createElement("textarea");
      feedback.className = "theme-review-feedback";
      feedback.rows = 3;
      feedback.placeholder = item.generation_error
        ? "Replace the blocked creative direction with neutral, non-graphic visual instructions."
        : "Optional: describe what should change. Leave blank to just reroll.";
      const savedDraft = reviewUiState.drafts.get(item.id);
      if (savedDraft) feedback.value = savedDraft.feedback;
      // Guided notes are APPENDED as revision notes on top of the freshly-rebuilt
      // structured prompt (mode 'augment' — selectThemeImageRetryPrompt), never
      // sent as the entire prompt. Hidden for blocked items, whose notes DO fully
      // replace the flagged prompt (see blockedEmptyHint below), where this
      // reassurance would be misleading.
      const feedbackHint = document.createElement("div");
      feedbackHint.className = "theme-review-feedback-hint";
      feedbackHint.textContent = "Notes only — don't paste a full prompt; layout and art rules are added automatically. Leave blank to reroll unchanged.";
      feedbackHint.hidden = Boolean(item.generation_error);
      // Blocked items are the one narrow recovery case where notes DO become the
      // entire replacement prompt (mode 'custom') — the previous prompt was
      // flagged, so there is no safe structured base left to append onto.
      // Required (non-empty) only for this path; normal retry/augment notes stay
      // optional. No other UI path can trigger 'custom'.
      const blockedEmptyHint = document.createElement("div");
      blockedEmptyHint.className = "theme-review-feedback-hint theme-review-custom-warning";
      blockedEmptyHint.textContent = "Add replacement notes for this blocked image before retrying.";
      blockedEmptyHint.hidden = true;
      // Object/decor/rival board rows are always drawn from the manifest's
      // buildable_objects / decor_objects / roster_rivals display names, and
      // per-item visual descriptions (0.0.265) replace the manual "retry with
      // notes" loop for steering appearance — this merged editor (0.0.266
      // split it into two sections; re-merged here into one) is the only way
      // to rename rows, and edit + regenerate descriptions here instead of
      // typing free-text notes into the feedback box below every time.
      const namesDescriptionsSection = buildThemeReviewNamesDescriptionsSection(
        item,
        savedDraft,
        themeReviewBusyItems.get(item.id) === "names_descriptions",
        Boolean(payload.generation_active && !isCurrentReviewGate),
      );
      const retryRow = document.createElement("div");
      retryRow.className = "theme-review-retry-row";
      // Single retry action — no mode dropdown. 'retry' rebuilds the structured
      // prompt fresh from the current plan (names & descriptions); when the user
      // types notes they are APPENDED as revision notes on top of that same
      // fresh structured prompt ('augment' — selectThemeImageRetryPrompt), never
      // sent as the whole prompt. The one exception is a blocked image
      // (item.generation_error), whose notes fully replace the flagged prompt
      // ('custom') since there's no safe structured base left to append onto —
      // see the effectiveMode computation in the click handler below. No other
      // path can reach 'custom'.
      const retryBtn = document.createElement("button");
      retryBtn.className = "skill-btn theme-review-retry";
      const retryIdleText = item.image_src || item.generation_error ? "Retry image" : "Generate image";
      retryBtn.dataset.idleText = retryIdleText;
      const retryBusy = themeReviewBusyItems.get(item.id) === "retry";
      retryBtn.textContent = retryBusy || item.id === activeGenerationItemId
        ? "Generating..."
        : payload.generation_active && !item.image_src && !isCurrentReviewGate
          ? "Queued"
          : retryIdleText;
      // An inactive run may leave a valid review item without an image. Let the
      // user recover that checkpoint directly; during an active run, only the
      // exact item paused at the review gate may issue a replacement request.
      const retryBtnBaseDisabled = retryBusy || Boolean(payload.generation_active && !isCurrentReviewGate);
      retryBtn.disabled = retryBtnBaseDisabled;
      retryBtn.title = !item.image_src && !payload.generation_active
        ? "Generate this unfinished image using the notes above."
        : payload.generation_active && !isCurrentReviewGate
          ? "This image is generating or queued in the active run."
          : "Generate a replacement using the notes above.";
      retryBtn.addEventListener("click", () => {
        const notes = feedback.value.trim();
        // Blocked items always fully replace the flagged prompt ('custom');
        // otherwise notes present -> 'augment' (appended onto the freshly-
        // rebuilt structured prompt), notes empty -> plain re-roll ('retry').
        // No UI path here can ever send 'custom' for a normal (non-blocked) item.
        const effectiveMode = item.generation_error ? "custom" : (notes ? "augment" : "retry");
        if (effectiveMode !== "retry" && !notes) {
          feedback.focus();
          feedback.setAttribute("aria-invalid", "true");
          return;
        }
        feedback.removeAttribute("aria-invalid");
        retryBtn.disabled = true;
        retryBtn.textContent = "Generating...";
        themeReviewBusyItems.set(item.id, "retry");
        themeReviewRetryWarnings.delete(item.id);
        retryWarning.textContent = "";
        retryWarning.hidden = true;
        vscode.postMessage({
          type: 'RETRY_THEME_IMAGE',
          payload: {
            theme_id: reviewThemeId,
            item_id: item.id,
            feedback: notes,
            mode: effectiveMode,
            image_provider: selectedThemeImageProvider(),
            character_name: characterNameInput ? characterNameInput.value.trim() : undefined,
          },
        });
      });
      const updateFeedbackState = () => {
        // Only a blocked item requires non-empty notes before it can be retried
        // (its notes fully replace the flagged prompt); normal retry/augment
        // notes stay optional.
        const blockedNeedsNotes = Boolean(item.generation_error) && !feedback.value.trim();
        blockedEmptyHint.hidden = !blockedNeedsNotes;
        retryBtn.disabled = retryBtnBaseDisabled || blockedNeedsNotes;
      };
      feedback.addEventListener("input", updateFeedbackState);
      updateFeedbackState();
      // Re-slice re-runs slicing on the saved raw atlas with no image-API cost.
      // Only available when the theme saved its original atlas (older themes did not).
      let resliceBtn = null;
      if (item.has_raw_atlas) {
        resliceBtn = document.createElement("button");
        resliceBtn.className = "skill-btn theme-review-reslice";
        resliceBtn.type = "button";
        resliceBtn.dataset.idleText = "Re-slice";
        const resliceBusy = themeReviewBusyItems.get(item.id) === "reslice";
        resliceBtn.textContent = resliceBusy ? "Re-slicing…" : "Re-slice";
        resliceBtn.disabled = themeReviewBusyItems.has(item.id)
          || Boolean(payload.generation_active && !isCurrentReviewGate);
        resliceBtn.title = "Re-slice this board from its saved original image — applies the latest slicing fixes without regenerating (no image-generation cost).";
        resliceBtn.addEventListener("click", () => {
          resliceBtn.disabled = true;
          resliceBtn.textContent = "Re-slicing…";
          themeReviewBusyItems.set(item.id, "reslice");
          vscode.postMessage({
            type: 'RESLICE_THEME_IMAGE',
            payload: { theme_id: reviewThemeId, item_id: item.id },
          });
        });
      }
      const retryStatus = document.createElement("div");
      retryStatus.className = "theme-review-retry-status";
      const retryWarning = document.createElement("div");
      retryWarning.className = "theme-review-retry-warning";
      const persistedRetryWarning = themeReviewRetryWarnings.get(item.id) || "";
      retryWarning.textContent = persistedRetryWarning;
      retryWarning.hidden = !persistedRetryWarning;
      retryRow.appendChild(retryBtn);
      if (resliceBtn) retryRow.appendChild(resliceBtn);

      body.appendChild(heading);
      body.appendChild(meta);
      if (generationError) body.appendChild(generationError);
      if (nameRow) body.appendChild(nameRow);
      if (namesDescriptionsSection) body.appendChild(namesDescriptionsSection);
      body.appendChild(decisionRow);
      body.appendChild(feedback);
      body.appendChild(feedbackHint);
      body.appendChild(blockedEmptyHint);
      body.appendChild(retryRow);
      body.appendChild(retryStatus);
      body.appendChild(retryWarning);
      card.appendChild(preview);
      card.appendChild(body);
      themeImageReviewList.appendChild(card);
    }
    if (themesScrollEl) themesScrollEl.scrollTop = reviewUiState.scrollTop;
  }

  function renderThemesList(themes) {
    if (!themePickerGrid) return;
    themePickerGrid.innerHTML = "";
    
    if (!themes || themes.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.style.color = "var(--vscode-descriptionForeground)";
      emptyMsg.textContent = "No saved themes yet.";
      themePickerGrid.appendChild(emptyMsg);
      return;
    }
    
    let selectedThemeName = "";

    for (const theme of themes) {
      const isSelected = selectedThemeId && theme.theme_id === selectedThemeId;
      const row = document.createElement("div");
      row.className = "theme-picker-row" + (isSelected ? " theme-picker-row--selected" : "");

      const themeName = theme.display_name || theme.theme_id;
      if (isSelected) selectedThemeName = themeName;

      const btn = document.createElement("button");
      btn.className = "skill-btn theme-picker-select" + (isSelected ? " theme-picker-select--active" : "");
      const nameLabel = document.createElement("span");
      nameLabel.textContent = themeName;
      const approvalLabel = document.createElement("span");
      approvalLabel.className = "theme-picker-approval" + (theme.export_ready ? " theme-picker-approval--ready" : "");
      approvalLabel.textContent = theme.export_ready
        ? "Ready to export"
        : theme.total
          ? `${theme.accepted}/${theme.total} approved`
          : "Review required";
      btn.appendChild(nameLabel);
      // Selected badge
      if (isSelected) {
        const badge = document.createElement("span");
        badge.className = "theme-selected-badge";
        badge.textContent = "Selected";
        btn.appendChild(badge);
      }
      btn.appendChild(approvalLabel);
      btn.addEventListener("click", () => {
        selectedThemeId = theme.theme_id;
        vscode.postMessage({ type: 'SELECT_THEME', payload: { theme_id: theme.theme_id } });
        // Refresh the list so the selected highlight updates immediately
        renderThemesList(lastThemesList);
      });

      const reviewBtn = document.createElement("button");
      reviewBtn.className = "skill-btn";
      reviewBtn.textContent = "Review images";
      reviewBtn.addEventListener("click", () => {
        showThemeImageReview(theme.theme_id);
      });

      const exportBtn = document.createElement("button");
      exportBtn.className = "skill-btn";
      exportBtn.type = "button";
      exportBtn.textContent = "Export .zip";
      exportBtn.disabled = !theme.export_ready;
      exportBtn.dataset.exportReady = String(Boolean(theme.export_ready));
      exportBtn.title = theme.export_ready
        ? `Export ${themeName} as a .zip file`
        : `Approve every theme image before exporting (${theme.accepted || 0}/${theme.total || 0} approved)`;
      exportBtn.dataset.themeExportId = theme.theme_id;
      exportBtn.addEventListener("click", () => {
        exportBtn.disabled = true;
        if (themePickerStatus) {
          themePickerStatus.textContent = `Exporting ${themeName}...`;
          themePickerStatus.classList.remove("theme-picker-status--error");
        }
        vscode.postMessage({ type: "EXPORT_THEME", payload: { theme_id: theme.theme_id } });
      });

      const sizeLabel = document.createElement("span");
      sizeLabel.className = "theme-picker-size";
      sizeLabel.textContent = formatThemeDiskSize(theme.size_bytes);
      sizeLabel.title = `${Number(theme.size_bytes || 0).toLocaleString()} bytes on disk`;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "skill-btn theme-delete-btn";
      deleteBtn.type = "button";
      deleteBtn.title = `Delete ${themeName}`;
      deleteBtn.setAttribute("aria-label", `Delete ${themeName}`);
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 12H8L7 9Zm3 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z"/></svg>';
      deleteBtn.addEventListener("click", () => {
        deleteBtn.setAttribute("disabled", "");
        if (themePickerStatus) {
          themePickerStatus.textContent = `Waiting to delete ${themeName}…`;
          themePickerStatus.classList.remove("theme-picker-status--error");
        }
        vscode.postMessage({ type: 'DELETE_THEME', payload: { theme_id: theme.theme_id } });
      });

      row.appendChild(btn);
      row.appendChild(reviewBtn);
      row.appendChild(exportBtn);
      row.appendChild(sizeLabel);
      row.appendChild(deleteBtn);
      themePickerGrid.appendChild(row);
    }

    // ── Selected-theme section (Change: reorganized IA) ─────────────────────
    // The roster order strip is scoped to the CURRENTLY SELECTED theme, so it
    // lives in its own section headed with that theme's name — separate from
    // the theme library above (list + Import .zip / Theme Builder), which act
    // on the library as a whole, not the selection.
    if (themeSelectedRoster) themeSelectedRoster.innerHTML = "";
    if (rosterOrder.length > 0 && themeSelectedSection && themeSelectedHeading && themeSelectedRoster) {
      themeSelectedSection.removeAttribute("hidden");
      themeSelectedHeading.textContent = selectedThemeName
        ? `Selected theme — ${selectedThemeName}`
        : "Selected theme";

      const rosterHeading = document.createElement("div");
      rosterHeading.className = "modal-roster-heading";
      rosterHeading.textContent = "Character roster order";
      themeSelectedRoster.appendChild(rosterHeading);

      const rosterNote = document.createElement("div");
      rosterNote.className = "modal-roster-note";
      rosterNote.textContent = "Drag to reorder. The sequence maps agent slots to characters on stage.";
      themeSelectedRoster.appendChild(rosterNote);

      const rosterBody = document.createElement("div");
      rosterBody.className = "modal-roster-body";

      let modalDragId = null;

      for (const [rosterIdx, charId] of rosterOrder.entries()) {
        const slots = themeImages[charId];
        const thumbImg = slots && (slots[16] || slots[0]);

        const thumb = document.createElement("div");
        thumb.className = "roster-thumb";
        thumb.dataset.charId = charId;
        thumb.draggable = true;
        thumb.title = charId;

        if (thumbImg) {
          const imgEl = document.createElement("img");
          imgEl.src = thumbImg.src;
          imgEl.width = 88;
          imgEl.height = 88;
          imgEl.draggable = false;
          imgEl.style.pointerEvents = "none";
          thumb.appendChild(imgEl);
        } else {
          thumb.textContent = charId.slice(0, 2).toUpperCase();
        }

        // Slot-number badge (current displayed position, 1-based)
        const charLabel = document.createElement("div");
        charLabel.className = "modal-roster-char-label";
        charLabel.textContent = String(rosterIdx + 1);
        thumb.appendChild(charLabel);

        thumb.addEventListener("dragstart", function (e) {
          modalDragId = charId;
          thumb.classList.add("roster-thumb--dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", charId);
          }
        });

        thumb.addEventListener("dragend", function () {
          thumb.classList.remove("roster-thumb--dragging");
          modalDragId = null;
          rosterBody.querySelectorAll(".roster-thumb--over").forEach(function (el) {
            el.classList.remove("roster-thumb--over");
          });
        });

        thumb.addEventListener("dragover", function (e) {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          if (modalDragId && modalDragId !== charId) {
            thumb.classList.add("roster-thumb--over");
          }
        });

        thumb.addEventListener("dragleave", function () {
          thumb.classList.remove("roster-thumb--over");
        });

        thumb.addEventListener("drop", function (e) {
          e.preventDefault();
          thumb.classList.remove("roster-thumb--over");
          if (!modalDragId || modalDragId === charId) return;

          const fromIdx = rosterOrder.indexOf(modalDragId);
          const toIdx = rosterOrder.indexOf(charId);
          if (fromIdx === -1 || toIdx === -1) return;
          rosterOrder.splice(fromIdx, 1);
          rosterOrder.splice(toIdx, 0, modalDragId);

          const prev = vscode.getState() || {};
          vscode.setState({ ...prev, rosterOrder: rosterOrder.slice() });

          // Also rebuild the stage strip (now a no-op since it's removed from stage)
          buildRosterStrip();
          // Re-render the modal roster
          renderThemesList(lastThemesList);
        });

        rosterBody.appendChild(thumb);
      }

      themeSelectedRoster.appendChild(rosterBody);
    } else if (themeSelectedSection) {
      themeSelectedSection.setAttribute("hidden", "");
    }
  }

  function formatThemeDiskSize(bytes) {
    const value = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length);
    const scaled = value / Math.pow(1024, exponent);
    return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[exponent - 1]}`;
  }

  /** Close/return from the settings (setup) screen — mirrors the Back button. */
  function closeSettingsScreen() {
    openedFromSettings = false;
    showMain();
  }

  setupBackBtn.addEventListener("click", closeSettingsScreen);

  // Inject a sticky white-X close button into the setup card header, matching
  // the other modals (#skills-modal-close / #themes-modal-close). Wired to the
  // same close action as the Back button. Created once at startup.
  (function injectSettingsCloseBtn() {
    const card = document.getElementById("setup-card");
    if (!card || document.getElementById("settings-modal-close")) return;
    const closeBtn = document.createElement("button");
    closeBtn.id = "settings-modal-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close settings");
    closeBtn.textContent = "✕"; // ✕
    closeBtn.addEventListener("click", closeSettingsScreen);
    card.insertBefore(closeBtn, card.firstChild);
  })();

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("stage"));
  const ctx = canvas.getContext("2d");

  // Move canvas into #stage-area so CSS position:absolute;inset:0 fills it correctly
  (function repositionCanvas() {
    const sa = document.getElementById("stage-area");
    if (sa && canvas.parentElement !== sa) {
      sa.insertBefore(canvas, sa.firstChild);
    }
  })();

  // ── Theme character rendering ────────────────────────────────────────────
  // ATLAS_CLIPS mirrors src/extension/themePlan.ts exactly — keep in sync.
  const ATLAS_CLIPS = {
    walk:      { frames: [0, 1, 2, 3, 4],  fps: 10, loop: true,  flippable: true },
    idle:      { frames: [16],              fps: 0,  loop: true,  flippable: false, hold: true },
    sit:       { frames: [15],              fps: 0,  loop: true,  flippable: true,  hold: true },
    melee:     { frames: [10, 11],         fps: 12, loop: false, flippable: true },
    build:     { frames: [5, 6, 7, 8],     fps: 6,  loop: true,  flippable: true },
    tool_idle: { frames: [9],              fps: 0,  loop: true,  flippable: true,  hold: true },
    shoot:     { frames: [12, 13],         fps: 3,  loop: true,  flippable: true,  pingpong: false },
    dance:     { frames: [17, 18, 19],     fps: 6,  loop: true,  flippable: false, pingpong: true },
    cheer:     { frames: [19],             fps: 0,  loop: true,  flippable: false, hold: true },
    point:     { frames: [9],              fps: 0,  loop: true,  flippable: true,  hold: true },
    signal:    { frames: [19],             fps: 0,  loop: true,  flippable: false, hold: true },
    // Idle ambient combat (cosmetic hit-reaction): a brief block/flinch pose.
    // Frame 14 is this block clip's OWN dedicated dodge/flinch frame (no longer
    // part of the melee clip). Played as a one-shot emote override
    // (see playEmote / charEntry.emoteClip) exactly like point/signal —
    // characters take NO damage, this is purely visual.
    block:     { frames: [14],             fps: 6,  loop: false, flippable: true },
  };

  // RIVAL_CLIPS mirrors the src copy exactly (a test enforces byte parity).
  // Enemies (rivals) use a COMPACT 5-frame sprite: [walk0, walk1,
  // attack0, attack1, attack2]. Enemies only WALK or ATTACK.
  const RIVAL_CLIPS = {
    walk:   { frames: [0, 1],    fps: 8, loop: true,  flippable: true },
    attack: { frames: [2, 3, 4], fps: 8, loop: false, flippable: true },
  };

  // OBJECT_CLIPS mirrors src/extension/themePlan.ts buildable-object clips — keep in sync.
  const OBJECT_CLIPS = {
    object_idle: { frames: [0, 1, 2, 3], fps: 5,  loop: true },
    crate:       { frames: [0],          fps: 0,  loop: true, hold: true },
    poof:        { frames: [0, 1, 2, 3], fps: 12, loop: false },
  };
  const OBJECT_ANIM_PROXIMITY_NATIVE = 64; // native px (533x751 space): an agent within this starts an animated object's loop
  const OBJECT_ANIM_LINGER_SEC = 1.0;      // keep looping this long after the last agent leaves, then freeze to frame 0

  // ── Cosmetic damage-smoke overlay (Phase 1) ──────────────────────────────
  // Purely visual: a built object under sustained rival attack emits a rising,
  // fading poof-sprite smoke column. NO gameplay effect (no build pause, no
  // un-building, no damage). See objectSmoke / updateObjectSmoke / drawObjectSmoke.
  const SMOKE_ATTACK_DELAY = 0.5;   // s of continuous attack before an object starts smoking
  const SMOKE_SCALE = 0.30;         // smoke puff size as a fraction of the object's poof baseSize
  const SMOKE_PUFFS = 2;            // overlapping rising puffs for a continuous column
  const SMOKE_CYCLE = 1.2;          // s for one puff to rise + fade
  const SMOKE_RISE_NATIVE = 26;     // how far (native px, pre-scale) a puff drifts up over one cycle
  const SMOKE_MAX_ALPHA = 0.55;     // peak opacity of a puff
  const SMOKE_FADEOUT = 0.4;        // s to fade the whole column out once the attack stops
  // ── Extinguish / Repair (Phase 2) ────────────────────────────────────────
  // Damage is now PERSISTENT: once a built object has been attacked past
  // SMOKE_ATTACK_DELAY it is marked `damaged` and keeps smoking (intensity
  // held at 1, never auto-decays) until USER characters repair it. An IDLE,
  // non-combat character routed to a smoking object plays the build clip
  // there to accrue repair progress. NO build/gameplay state change beyond
  // the smoke overlay itself. See assignExtinguishers / updateExtinguishProgress
  // and the movement-loop hooks.
  const REPAIR_BASE = 5.0;           // s to repair with ONE character
  const REPAIR_MIN = 1.0;            // floor — repair time never drops below this, however many characters
  const EXTINGUISH_MAX_ASSIGN = 3;   // max characters routed to one smoking object
  const EXTINGUISH_SMOKE_MIN = 0.5;  // smoke intensity at/above which an object "needs" repairing
  const EXTINGUISH_ARRIVE_EPS = 24;  // native px: within this of a repairer's OWN stand spot counts as "arrived"
  const EXTINGUISH_STAND_RADIUS = 28; // native px: ring radius around the object each repairer stands at (distinct per-slot spot, no pile-up)

  /** Theme data set by THEME_INITIALIZED */
  let themeLoaded = false;
  /** @type {Record<string, string[]>} raw frames per character (slot → data-URI) */
  let themeFramesRaw = {};
  /** @type {Record<string, HTMLImageElement[]>} preloaded Image objects per character */
  let themeImages = {};
  /** @type {HTMLImageElement|null} background environment image */
  let themeBackgroundImg = null;
  /** @type {Record<string, {action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}>} */
  let workerAnimStates = {};

  // ── Facing direction tracking (Feature 1) ───────────────────────────────
  /** Previous canvas x position per worker id, for movement-based facing. */
  /** @type {Record<string, number>} */
  const workerPrevX = {};
  /** Per-worker facing flag: true = facing left (mirrored). Default false (right). */
  /** @type {Record<string, boolean>} */
  const workerFacingLeft = {};
  /** Deadzone in pixels — movements smaller than this are ignored to avoid flicker. */
  const FACING_EPS = 0.1;

  // ── Roster order (Feature 2) ─────────────────────────────────────────────
  /**
   * Ordered array of character IDs reflecting the current roster order.
   * Populated/restored when a theme is loaded.
   * @type {string[]}
   */
  let rosterOrder = [];
  /** Whether the roster strip is collapsed. */
  let rosterCollapsed = false;

  // ── Per-agent character map (Change 1: 1:1 agentMetrics visualization) ──
  /**
   * Webview-side character state keyed by agent.id.
   * Each entry tracks position, animation state, and facing direction
   * so agents without a live worker still animate independently.
   * @type {Record<string, {x: number, y: number, animState: {action:string,frameIndex:number,direction:number,elapsed:number,completed:boolean}, facingLeft: boolean, prevX: number}>}
   */
  let agentCharMap = {};

  /** Selected theme id, updated on SELECT_THEME post and THEME_INITIALIZED message. */
  let selectedThemeId = "";

  // ── Isometric floor / walkable polygon state ─────────────────────────────
  /** Default walkable nav polygon in native 533x751 coordinate space (trapezoid). */
  const DEFAULT_WALKABLE_POLY = [[267,4],[529,135],[529,611],[267,747],[4,612],[4,137]];
  /** Native canvas dimensions matching the walkable polygon coords. */
  const DEFAULT_NATIVE_W = 533;
  const DEFAULT_NATIVE_H = 751;
  /** Current walkable polygon (native coords). Reset on each THEME_INITIALIZED. */
  let walkablePolygon = DEFAULT_WALKABLE_POLY.map((p) => p.slice());
  let walkableNativeW = DEFAULT_NATIVE_W;
  let walkableNativeH = DEFAULT_NATIVE_H;

  // ── Per-theme stage tuning (read from manifest.viewport, persisted by host) ──
  /** Overall character sprite scale multiplier (1 = default 64px sprite). */
  let themeCharacterScale = 1;
  /** Overall build-prop/object scale multiplier. */
  let themeObjectScale = 1;
  /**
   * Master "overall scale": scales the background rect AND every asset
   * (objects, characters, decor, enemies, polygon) together. Per-asset
   * scales (effectiveCharScale/effectiveObjScale) stack on top of this.
   */
  let themeOverallScale = 1;
  /**
   * Whole-scene fit-down factor, recomputed every render() frame from the
   * ACTUAL canvas size vs. the theme's fixed native footprint (533x751 by
   * default, scaled by themeOverallScale). The background is drawn at its
   * native size, top-anchored and never stretched (see "Fixed-size
   * background" below) — but that means a stage-area panel shorter/narrower
   * than the native footprint (a handlebar-dragged-tall metrics panel, a
   * narrow sidebar) previously let the canvas silently clip anything beyond
   * its own bounds. Deep-placed, scaled-up decor/objects (Stage Editor
   * composition puts big foreground props low in the native scene) lost
   * their bottoms this way, while wandering agents only passed through that
   * zone transiently and looked fine. Always <=1 (never scales UP past the
   * theme's authored size); folded into bgW/bgH AND every entity's
   * depthScale so the whole scene shrinks together with no distortion.
   */
  let sceneFitScale = 1;
  /** Per-character scale overrides, keyed by character/frame id. */
  let themeCharScaleOverrides = {};
  /** Per-object scale overrides, keyed by buildable object id. */
  let themeObjScaleOverrides = {};
  /** Constant fallback scale for decor sprites (reuses object-scale approach). Declared here (moved up from the decor section below) so it's available for themeDecorScale's initializer, which runs earlier in module-init order. */
  const DECOR_SCALE = 1;
  /** Overall rival sprite scale multiplier (mirrors themeCharacterScale for enemies). */
  let themeRivalScale = 1;
  /** Per-rival scale overrides, keyed by rival_id (mirrors themeObjScaleOverrides). */
  let themeRivalScaleOverrides = {};
  /** Overall decor sprite scale multiplier (mirrors themeRivalScale for decor; default DECOR_SCALE). */
  let themeDecorScale = DECOR_SCALE;
  /** Per-decor scale overrides, keyed by decor_id (mirrors themeRivalScaleOverrides). */
  let themeDecorScaleOverrides = {};
  /** Effective character scale for a given character/frame id. */
  function effectiveCharScale(charId) {
    const o = themeCharScaleOverrides[charId];
    return (typeof o === "number" && o > 0) ? o : themeCharacterScale;
  }
  /** Effective rival scale for a given rival_id. */
  function effectiveRivalScale(rivalId) {
    const o = themeRivalScaleOverrides[rivalId];
    return (typeof o === "number" && o > 0) ? o : themeRivalScale;
  }
  /**
   * Effective decor scale for a given decor_id: the GLOBAL "Decor scale"
   * slider (themeDecorScale) composed MULTIPLICATIVELY with an optional
   * per-decor override (treated as a multiplier on top of the global,
   * defaulting to 1 = "no adjustment" when absent). Mirrors effectiveObjScale
   * below (same bug, same fix) — a present override used to REPLACE the
   * global outright, so any decor item WITHOUT an override was the only kind
   * that tracked the global slider ("scale-decor slider only affects a
   * couple of items"). Legacy saved overrides (pre-this-fix) were absolute
   * final scales; they are migrated to multipliers once at theme load
   * (divided by the then-current global) so existing stage tunings render
   * unchanged the moment they're loaded — see the THEME_INITIALIZED handler.
   */
  function effectiveDecorScale(decorId) {
    const o = themeDecorScaleOverrides[decorId];
    const mult = (typeof o === "number" && o > 0) ? o : 1;
    return themeDecorScale * mult;
  }

  // ── Phase 2a: build loop state ───────────────────────────────────────────
  /** Buildable objects from manifest, sorted by build_order. @type {Array<object>} */
  let themeBuildables = [];
  /** Badges declared by the current theme's manifest. @type {Array<{badge_id:string,display_name:string,description:string,trigger_type:'OBJECTS_BUILT'|'RIVALS_EVICTED',threshold:number,icon_asset:string}>} */
  let themeBadges = [];
  /** Whether the theme's viewport declares crate/poof asset keys. */
  let themeHasCrateAsset = false;
  let themeHasPoofAsset = false;
  /**
   * Per-object runtime animation/phase state, keyed by object_id.
   * phase: 'unbuilt' | 'active' | 'poof' | 'idle'
   * @type {Record<string, {phase: string, animState: object, progress: number}>}
   */
  let objectAnimMap = {};
  /**
   * Cosmetic damage-smoke state per built object, keyed by object_id.
   * underAttack: seconds of continuous attack accumulated; intensity: 0..1
   * column opacity/scale factor; anim: seconds elapsed, drives the rising loop.
   * damaged: true once the object has taken a full SMOKE_ATTACK_DELAY of
   * attack — while true, intensity is held at 1 and never auto-decays, so
   * the object keeps smoking (even after the attacking rival leaves/dies)
   * until repaired. Created lazily the first frame an object is under
   * attack; deleted only on repair completion. Purely visual — never
   * affects build/attack logic.
   * @type {Record<string, {underAttack:number, intensity:number, anim:number, damaged?:boolean, extinguishProgress?:number}>}
   */
  const objectSmoke = {};
  /**
   * Per-object idle-animation fps/loop overrides declared in the manifest
   * (buildable_objects[].anim_fps / anim_loop), keyed by object_id. Mirrors
   * decorAnimMap's per-decor fps/loop capture below. Only the object_idle
   * clip is overridable — crate/poof timings always come from OBJECT_CLIPS.
   * Reset/populated at THEME_INITIALIZED alongside themeBuildables.
   * @type {Record<string, {fps:number, loop:boolean}>}
   */
  let objectAnimParams = {};
  /** Stable per-object native placement, keyed by object_id: {nx, ny}. Computed once at THEME_INITIALIZED. */
  let objectPlacement = {};
  /** Generated (non-override) placement per object_id: {nx, ny} — used to revert a Stage-Editor move. */
  let objectHomePlacement = {};
  /** Stage-Editor position overrides, object_id -> normalized [x,y] (0..1). Loaded from manifest.viewport. */
  let themeObjAnchorOverrides = {};
  /** Stage-Editor position overrides, decor_id -> normalized [x,y] (0..1); [-1,-1] = hidden. */
  let themeDecorAnchorOverrides = {};
  /** Stage-Editor horizontal-flip overrides, decor_id -> true when flipped. Loaded from manifest.viewport.decor_flip_overrides. */
  let themeDecorFlipOverrides = {};
  /** Stage-Editor horizontal-flip overrides, object_id -> true when flipped. Loaded from manifest.viewport.object_flip_overrides. */
  let themeObjFlipOverrides = {};
  /**
   * Non-destructive Stage-Editor HIDE set for decor, decor_id -> present when
   * hidden. Distinct from the [-1,-1] anchor-hide sentinel above: hidden decor
   * here keeps its live placement (position/scale untouched) — it's simply
   * excluded from normal-play drawing/hit-testing, and shown at reduced
   * opacity in Edit-Stage "show all objects" mode so it can be found again.
   * Loaded from manifest.viewport.decor_hidden (a string[] on the wire;
   * kept as a Set at runtime for O(1) toggle/lookup).
   * @type {Set<string>}
   */
  let themeDecorHidden = new Set();

  // ── Background Decor + Sitting ──────────────────────────────────────────
  /** Decor objects from manifest.decor_objects (read-only). @type {Array<object>} */
  let themeDecor = [];
  /**
   * Stable per-decor native placement + sit-point, keyed by decor_id:
   * { nx, ny, sitNx, sitNy, sittable }. Computed once at THEME_INITIALIZED.
   * @type {Record<string, {nx:number, ny:number, sitNx:number, sitNy:number, sittable:boolean}>}
   */
  let decorPlacement = {};
  /**
   * Per-decor animation state (for animated decor with anim_fps), keyed by
   * decor_id: { frameIndex, elapsed, direction, completed, fps, loop }.
   * @type {Record<string, {frameIndex:number, elapsed:number, direction:number, completed:boolean, fps:number, loop:boolean}>}
   */
  let decorAnimMap = {};
  /**
   * Seat occupancy, keyed by decor_id → occupying agent id (or null/absent when
   * free). Ensures at most one seated character per sittable decor.
   * @type {Record<string, string|null>}
   */
  let seatOccupancy = {};
  /** Default sit-anchor offset (normalized scene-space) when a seat omits sit_anchor. */
  const DEFAULT_SIT_ANCHOR = [0, -0.03];
  /**
   * Normalized downward offset (of walkableNativeH) applied to a seat's sit
   * point on top of its horizontal sit_anchor. Canvas Y increases downward,
   * so a POSITIVE value seats the character onto the chair (rather than
   * floating above it) AND makes the seated character's depth-sort ny
   * exceed the seat's ny, so it draws in front of (not behind) the seat.
   * Tune visually.
   */
  const SEAT_SIT_DROP = 0.02;
  /**
   * Seat-lift geometry, scale-invariant in BOTH chair and character scale.
   * The chair draws foot-anchored at chairSpriteSize = 64 * chairDepth *
   * chairScale (drawDecor); the seated character draws foot-anchored at
   * spriteSize = 64 * depthScale * effectiveCharScale(charId). SEAT_SURFACE_FRAC
   * is how far up the chair's own sprite its painted seat surface sits;
   * SEAT_CONTACT_FRAC is how far up the character's own sprite its
   * seat-contact (butt) point sits. Raise = SEAT_SURFACE_FRAC * chairSpriteSize
   * - SEAT_CONTACT_FRAC * spriteSize, clamped to >= 0. Unlike the old
   * (chairScale - 1) form, this is NON-ZERO at default scale 1 — it's what
   * lifts the body onto the seat instead of leaving it anchored at the
   * chair's floor base. Tune visually if seated chars sit slightly high/low.
   */
  const SEAT_SURFACE_FRAC = 0.5; // chair's seat-surface height as a fraction of the chair sprite (raise = seat higher)
  const SEAT_CONTACT_FRAC = 0.2; // character's seat-contact (butt) height as a fraction of its own sprite
  /**
   * Horizontal canvas-px nudge applied to a seated character's draw position
   * for better chair alignment: shifted RIGHT when its seat is not flipped,
   * mirrored to the LEFT when the seat IS flipped horizontally. Cosmetic
   * draw-time only — never affects logical position or depth sort.
   */
  const SEAT_SEATED_NUDGE_PX = 4;
  /** Chance, per idle wander-decision, that an idle agent goes to sit on a free seat. */
  const SIT_CHANCE = 0.05;
  /**
   * Leader-throne tunables (Feature: leader-throne). "Leader" = the
   * roster-slot-0 character — see isLeaderEntry. An idle leader should
   * spend MOST of its idle time on the throne, so it gets a much higher
   * sit chance than everyone else, plus a longer dwell (LEADER_SIT_DWELL_MULT
   * below) once seated so it lingers instead of popping up and down.
   */
  const LEADER_SIT_CHANCE = 0.6;
  /** How long (seconds) a character stays seated before standing up. */
  const SIT_SECONDS = 12;
  /** Multiplier applied to SIT_SECONDS for the leader's throne dwell time. */
  const LEADER_SIT_DWELL_MULT = 2;
  /** How close (native px) to a seat's sit-point before the agent is "seated". */
  const SIT_ARRIVED_EPS = 4;
  /**
   * Effective object scale for a given buildable object id: the GLOBAL
   * "Object scale" slider (themeObjectScale) composed MULTIPLICATIVELY with
   * an optional per-object override (treated as a multiplier on top of the
   * global, defaulting to 1 = "no adjustment" when absent).
   *
   * Previously a present override REPLACED the global outright, so any
   * object WITHOUT an override was the only one that tracked the global
   * slider — reported as "the scale-objects slider only affects one object."
   * Legacy saved overrides (pre-this-fix) were absolute final scales; they
   * are migrated to multipliers once at theme load (divided by the
   * then-current global) so existing stage tunings render unchanged the
   * moment they're loaded — see the THEME_INITIALIZED handler.
   */
  function effectiveObjScale(objId) {
    const o = themeObjScaleOverrides[objId];
    const mult = (typeof o === "number" && o > 0) ? o : 1;
    return themeObjectScale * mult;
  }
  /** Native build-progress units one completed coding task contributes. Tunable. */
  const UNITS_PER_TASK = 34;
  /**
   * One-at-a-time paced build queue (replaces proportional-fill from
   * completedTasks). A stable random permutation of themeBuildables'
   * object_ids, seeded per-theme so it doesn't reshuffle every frame.
   * @type {string[]}
   */
  let buildQueue = [];
  /** Count of queue entries fully built so far (index into buildQueue). */
  let buildBuiltCount = 0;
  /** Debounce timer handle for persisting buildBuiltCount to the host (see saveBuildProgress). */
  let buildProgressSaveTimer = 0;
  /**
   * Debounced persist of buildBuiltCount to the host (750ms), so rapid
   * consecutive builds don't spam postMessage. Posted under selectedThemeId
   * (the theme currently loaded on stage — mirrors saveStageTuning's
   * theme_id source). No-ops if no theme is loaded.
   */
  function saveBuildProgress() {
    if (!selectedThemeId) return;
    if (buildProgressSaveTimer) clearTimeout(buildProgressSaveTimer);
    buildProgressSaveTimer = setTimeout(() => {
      buildProgressSaveTimer = 0;
      vscode.postMessage({
        type: "saveBuildProgress",
        payload: { themeId: selectedThemeId, builtCount: buildBuiltCount },
      });
    }, 750);
  }
  /** Count of rival agents successfully evicted (fled offscreen and pruned) this theme session. */
  let rivalsEvictedCount = 0;
  /**
   * DURABLE per-rebirth-cycle badge counters. Unlike buildBuiltCount/
   * rivalsEvictedCount (per-theme-session build-loop counters reset to 0 on
   * every THEME_INITIALIZED), these persist host-side in the rebirth-state
   * store and are RESTORED on reload — they only reset on rebirth / user reset.
   * Badge progress (OBJECTS_BUILT / RIVALS_EVICTED) reads these so earned-badge
   * progress bars don't snap back to 0 after a webview reload.
   */
  let cycleObjectsBuilt = 0;
  let cycleRivalsEvicted = 0;
  /**
   * Set of badge_id strings unlocked for the current theme. Seeded from the
   * host's persisted per-theme unlocks on THEME_INITIALIZED (payload.unlocked_badge_ids),
   * then only ever grows within the session as new badges are earned.
   * @type {Set<string>}
   */
  let unlockedBadgeIds = new Set();
  /** theme_id of the theme currently loaded on stage, captured at THEME_INITIALIZED — used to tag BADGE_UNLOCKED posts to the host. @type {string|null} */
  let currentBadgeThemeId = null;

  // ── Rebirth prestige mechanic (all webview-side; survives reload via
  // vscode state, but NEVER touches buildBuiltCount/rivalsEvictedCount/agent
  // metrics directly — see doRebirth()). Badges measure progress WITHIN the
  // current rebirth cycle via the baselines below, since the underlying
  // lifetime counters persist through rebirth. ──────────────────────────────
  /** Number of times the player has rebirthed. Drives ranged-weapon + build-speed bonuses. */
  let rebirthCount = 0;
  /** Lifetime-counter snapshot captured at the moment of the last rebirth (or 0/0/0 if never). */
  let rebirthBaseline = { built: 0, evicted: 0, tasks: 0 };
  /** High-water mark of concurrently-active agents observed since the last rebirth (not persisted). */
  let cyclePeakActive = 0;
  /** 3 badge_ids (from themeBadges) that must ALL be unlocked before the next rebirth is allowed. @type {string[]} */
  let requiredRebirthBadgeIds = [];
  /** True while the two-step Rebirth button confirm prompt is showing. */
  let rebirthConfirmPending = false;
  /**
   * Tiered rebirth-gate pools, selected by rebirthCount at roll time (see
   * rollRebirthRequirement()) so each successive Rebirth demands a harder set
   * of badges. Thresholds are checked against buildDefaultBadges() (themeMigration.ts).
   *
   * SLIDING WINDOW, not a cumulative union: each tier is its own bounded pool,
   * so the easiest badges drop OUT as rebirthCount climbs instead of piling up
   * forever. This replaces an earlier 3-tier scheme whose top tier included
   * task_500 ("Unstoppable", 500 tasks) starting at rebirthCount >= 2 — that
   * walled players at their 2nd rebirth on an extreme badge far too early.
   *
   *   EARLY (rebirthCount 0,1,2 — gates rebirths 1-3): capped at build<=10,
   *     evict<=75, task<=50, crew_3/6. Easy-to-mid badges only.
   *   MID (rebirthCount 3,4,5 — gates rebirths 4-6): build_6..13, evict_20..100,
   *     task_50/150, crew_6, reborn_builder. Drops build_1/evict_1/evict_5/
   *     evict_10/task_1/crew_3 — trivial by this point.
   *   LATE (rebirthCount >= 6 — gates rebirths 7+): build_10/13, evict_50..100,
   *     task_150/500, reborn_builder. Only the hardest per-cycle badges remain;
   *     task_500 first appears here, once players have the throughput for it.
   *
   * rebirth_* badges are NEVER included in any tier: they're permanent
   * (rebirthCount-gated, never wiped) so putting one in a requirement pool
   * would make it trivially/permanently satisfied after the first Rebirth.
   */
  const REBIRTH_TIER_EARLY = [
    "build_1", "build_3", "build_6", "build_10",
    "evict_1", "evict_5", "evict_10", "evict_20", "evict_35", "evict_50", "evict_75",
    "task_1", "task_10", "task_50",
    "crew_3", "crew_6",
  ];
  const REBIRTH_TIER_MID = [
    "build_6", "build_10", "build_13",
    "evict_20", "evict_35", "evict_50", "evict_75", "evict_100",
    "task_50", "task_150",
    "crew_6", "reborn_builder",
  ];
  const REBIRTH_TIER_LATE = [
    "build_10", "build_13",
    "evict_50", "evict_75", "evict_100",
    "task_150", "task_500",
    "reborn_builder",
  ];
  /** Pick the tier pool to draw the next requirement from, based on rebirthCount. */
  function rebirthTierPool(count) {
    if (count <= 2) return REBIRTH_TIER_EARLY;
    if (count <= 5) return REBIRTH_TIER_MID;
    return REBIRTH_TIER_LATE;
  }
  // NOTE: rebirthCount/rebirthBaseline/requiredRebirthBadgeIds are restored
  // from the HOST's per-theme rebirth_state payload inside the
  // THEME_INITIALIZED handler, not here — requiredRebirthBadgeIds must be validated
  // against the CURRENT theme's themeBadges (badge_ids aren't shared across
  // themes), which isn't populated until a theme actually loads. cyclePeakActive
  // is intentionally never restored (always starts at 0).

  /** Progress (0..1) of the current active (buildQueue[buildBuiltCount]) object. */
  let buildCurrentProgress = 0;
  /**
   * Seconds for ONE agent to fully build the FIRST object. Build time ramps
   * ADDITIVELY (gentle linear slope) per object index: object i takes
   * FIRST_BUILD_SECONDS + i * BUILD_SECONDS_PER_OBJECT per-agent seconds
   * (object 0 = 360s / 6 min, object 1 = 420s / 7 min, … + rebirth speed
   * bonus, ÷ number of builders). N agents building the SAME active object
   * make it N× faster (builderCount factor preserved).
   */
  const FIRST_BUILD_SECONDS = 360;
  /** Extra per-agent seconds added per object index — the gentle ramp slope. */
  const BUILD_SECONDS_PER_OBJECT = 60;
  /**
   * Per-frame count: number of ACTIVE agents currently AT the active build
   * target's standoff spot actually building it (clip "build", i.e.
   * isBuilding && !isMoving). Reset each frame before the agent loop,
   * incremented once per builder during the agent loop, read by
   * updateBuildProgress() next frame.
   */
  let buildProgressBuilderCount = 0;
  /**
   * Ids of the ACTIVE agents that were actually building the current active
   * object this frame (mirrors buildProgressBuilderCount's membership). Rebuilt
   * each frame in the agent loop and reset (emptied) where
   * buildProgressBuilderCount is reset to 0. Read by completeBuildIfReady() to
   * make the contributing builders celebrate when the object completes.
   * @type {string[]}
   */
  let currentBuildContributors = [];
  /**
   * Minimum horizontal movement (native px) required to update an agent's or
   * enemy's movement-derived facing. Below this, facing is held so a
   * near-vertical mover doesn't rapid-flip left/right every frame.
   */
  const FACING_DEADZONE = 0.5;

  /**
   * Larger horizontal deadzone (native px) used for TARGET-facing during
   * combat: when an enemy holds position and attacks an agent (or an agent
   * engages an enemy) that is nearly directly above/below it, the tiny
   * frame-to-frame horizontal jitter would flip the sprite left/right every
   * frame (an in-place mirror-blur). Only re-face the target once the
   * horizontal offset clears this band; otherwise keep the current facing.
   */
  const ATTACK_FACING_DEADZONE = 4;

  /**
   * object_id of the "ranged weapon rack" — the buildable with build_order 0
   * (themeBuildables[0] after the ascending build_order sort). Captured at
   * THEME_INITIALIZED; null if the theme has no buildables. Building THIS
   * object is what unlocks ranged combat.
   * @type {string|null}
   */
  let rackObjectId = null;
  /**
   * Session-scoped latch: once the rack object is fully built, ALL characters
   * permanently switch from melee to ranged (shoot) combat for the rest of
   * the session. Seeded from rangedPermanentlyUnlocked at THEME_INITIALIZED
   * (see below) so it starts true from boot once previously earned; the
   * per-frame latch (~L11667) is a same-session fallback that still detects
   * an already-built rack even without the persisted flag.
   */
  let rangedUnlocked = false;
  /**
   * D4: durable flag — once ranged combat is earned (rack built after the
   * player's first rebirth), it stays unlocked PERMANENTLY, surviving
   * reloads AND every future rebirth. Mirrors the existing rebirth
   * persistence mechanism (persistRebirth: vscode.setState()'s `rebirth`
   * blob + host-side SAVE_REBIRTH_STATE), and is restored at
   * THEME_INITIALIZED alongside rebirthCount/rebirthBaseline/etc. Flips true
   * once, at the ranged-unlock latch (~L11667); doRebirth() never resets it.
   * @type {boolean}
   */
  let rangedPermanentlyUnlocked = false;
  /**
   * D4: the buildQueue index the weapons rack is inserted at — captured once
   * (at the moment rebirthCount first becomes >=1, see doRebirth) as
   * `buildBuiltCount + 1` so the rack becomes the very next build once the
   * in-progress object finishes. Persisted alongside rebirthCount (same
   * mechanism as rangedPermanentlyUnlocked above) so buildSeededQueue can
   * reproduce the IDENTICAL index on every future reload — recomputing from
   * the live, ever-growing buildBuiltCount on each load would keep relocating
   * the rack forward instead of leaving it where it was actually queued.
   * null until a rebirth has queued the rack.
   * @type {number|null}
   */
  let rackInsertIndex = null;

  /**
   * Deterministic string hash → 32-bit int (for seeding the build queue
   * shuffle so it's stable across frames but varies per theme).
   * @param {string} str
   */
  function seededHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  /**
   * Small deterministic PRNG (mulberry32) for the seeded build-queue shuffle.
   * @param {number} seed
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Build a stable random permutation of themeBuildables' object_ids, seeded
   * by theme_id so the same theme always yields the same build order (no
   * reshuffling every frame/reload).
   *
   * D3: the weapons rack (build_order 0, i.e. buildables[0].object_id — same
   * convention as rackObjectId) is ALWAYS excluded from the shuffle pool
   * itself, then spliced back in at `rackInsertIndex` iff rebirthCount >= 1.
   * Filtering it out BEFORE shuffling (rather than shuffling everything and
   * removing it after) keeps the relative order of every OTHER object
   * identical regardless of rebirthCount, so queue positions — and therefore
   * buildBuiltCount's already-built prefix — stay stable across the
   * pre→post-rebirth transition and any later reload (see doRebirth D3 /
   * THEME_INITIALIZED's rebirth peek).
   * D4: rackInsertIndex is the PERSISTED index captured once at the moment
   * of the first rebirth (doRebirth: buildBuiltCount + 1 at that time), so
   * the rack lands at the same stable position on every reload instead of
   * being recomputed from the live (ever-growing) buildBuiltCount. When
   * absent (legacy saves with rebirthCount >= 1 predating this field), falls
   * back to appending at the very end — the old behavior.
   * @param {Array<object>} buildables
   * @param {string} themeId
   * @param {number} [rebirthCount] number of completed rebirths; the rack
   *   stays out of the pool entirely while this is < 1.
   * @param {number|null} [rackInsertIndex] persisted splice index for the
   *   rack; null/undefined falls back to appending at the end.
   * @returns {string[]}
   */
  function buildSeededQueue(buildables, themeId, rebirthCount, rackInsertIndex) {
    const rackId = buildables.length > 0 ? buildables[0].object_id : null;
    const pool = rackId !== null ? buildables.filter((o) => o.object_id !== rackId) : buildables;
    const ids = pool.map((o) => o.object_id);
    const rand = mulberry32(seededHash(String(themeId || "")));
    // Fisher-Yates shuffle using the seeded PRNG.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    }
    if (rackId !== null && (rebirthCount || 0) >= 1) {
      const idx = (typeof rackInsertIndex === "number" && rackInsertIndex >= 0)
        ? Math.max(0, Math.min(rackInsertIndex, ids.length))
        : ids.length;
      ids.splice(idx, 0, rackId);
    }
    return ids;
  }

  // ── Phase 2b: enemy / EVICT mode state ───────────────────────────────────
  /** Seconds between enemy spawn waves (manifest.viewport.enemy_config.spawn_interval_seconds). */
  let enemySpawnIntervalSec = 45;
  /** Formats a spawn-interval second count as "45s" or "20m" / "20m 30s" for the stage editor label. */
  function formatEnemySpawnInterval(sec) {
    const total = Math.round(sec);
    if (total < 60) return total + "s";
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s === 0 ? m + "m" : m + "m " + s + "s";
  }
  /** 'all' = every rival spawns each wave; 'random' = a random 1..N subset. */
  let enemyCountMode = "random";
  /** Rival roster from manifest.roster_rivals: [{rival_id, name, atlas_asset}]. */
  let themeRivals = [];
  /** Playable roster from manifest.roster_agents: [{slot_id, name, ...}]. Retained for the per-character scale override list. */
  let themeRosterAgents = [];
  /** Seconds elapsed since the last wave was cleared/started. */
  let enemySpawnElapsed = 0;

  // ── Idle festivity: solo dance + rare conga line (native-space, no host telemetry) ──
  /** Chance, per idle wander-decision, that an idle agent breaks into a solo dance. */
  const DANCE_CHANCE = 0.06;
  /** How long (seconds) a solo dance lasts — randomized 2–3s per dance. */
  const DANCE_SECONDS_MIN = 2, DANCE_SECONDS_MAX = 3;
  /** Seconds between dance-frame swaps (manual frame mixer). */
  const DANCE_FRAME_SWAP = 0.35;
  /** Chance, per idle wander-decision, that an idle agent throws in a rare playful "point" emote. */
  const POINT_CHANCE = 0.01;
  /** Minimum seconds between one agent's playful "point" emotes (rate limit). */
  const EMOTE_COOLDOWN_SEC = 20;

  // ── Expression bubbles (rare, meaningful — see showExpression) ─────────
  /** Minimum seconds between one agent's expression bubbles (shared rate limit). */
  const BUBBLE_COOLDOWN_SEC = 60;
  /** Chance, on an idle→active transition, of a brief "idea" bubble. */
  const IDEA_CHANCE = 0.02;
  /** Chance, on transitioning into a seated pose, of a brief "sleep" bubble. */
  const SLEEP_CHANCE = 0.02;
  /** Per-second probability (multiplied by delta) of a rare playful "love"
   * bubble; heart is intentionally rare. Also requires proximity to another
   * idle-still agent — see LOVE_NEAR_NATIVE_SQ below. */
  const LOVE_CHANCE = 0.02;
  /** Native-space squared distance under which two idle-still agents count as
   * "cozy" for the love-bubble proximity gate (agents are ~34 native units
   * apart per MIN_AGENT_SEP_NATIVE, so 60 is a comfortably close threshold). */
  const LOVE_NEAR_NATIVE_SQ = 60 * 60;
  /** Chance a build-celebration/victory dancer also shows a "thumbs-up" bubble. */
  const HAPPY_BUBBLE_CHANCE = 0.5;
  /** Chance, on an idle→engaged (combat) transition, of a brief "anger" bubble. */
  const ANGER_CHANCE = 0.05;
  /** Seconds an evicted rival shows the "dazed/hit" (expression 7) bubble as it flees. */
  const HURT_EXPR_SEC = 1.8;
  /** Persistent lead "team active" bubble (expression 3): minimum on-screen
   * time in ms, and how long (ms) of that floor is spent as the rainbow
   * attention burst before settling to a solid pulsing green — see
   * charEntry.teamActive/teamActiveSince and drawTeamBubble. */
  const TEAM_BUBBLE_MIN_MS = 2000;
  const TEAM_BUBBLE_BURST_MS = 2000;

  /** True while a conga line is snaking around the perimeter. */
  let congaActive = false;
  /** Seconds remaining in the current conga run. */
  let congaTimeLeft = 0;
  /** Accumulator (seconds) toward the next conga eligibility check. */
  let congaCheckTimer = 0;
  /** Cooldown (seconds) remaining before another conga may start. */
  let congaCooldown = 0;
  /** Perimeter waypoints (native coords) the leader follows. */
  let congaWaypoints = [];
  /** Stable agent-id order forming the line (index 0 = leader). */
  let congaOrder = [];
  /** Leader's current target waypoint index into congaWaypoints. */
  let congaWaypointIdx = 0;
  /** Seconds between conga eligibility rolls. */
  const CONGA_CHECK_SECONDS = 60;
  /** Chance per eligibility check that a conga starts (~once per ~10h). */
  const CONGA_CHANCE = 0.0015;
  /** How long (seconds) a conga run lasts. */
  const CONGA_SECONDS = 25;
  /** Cooldown (seconds) after a conga ends before another may start. */
  const CONGA_COOLDOWN_SECONDS = 3600;
  /** Latest per-frame agent list, exposed so debug hotkeys can act off-loop. */
  let lastAgentList = [];
  /** Trailing distance (native px) each follower keeps behind the one ahead. */
  const CONGA_TRAIL = 36;
  /** Seconds between synchronized conga stop-and-cheer celebrations. */
  const CONGA_CHEER_INTERVAL = 3;
  /** Seconds the whole conga line holds the cheer pose (≈2 frames). */
  const CONGA_CHEER_HOLD = 0.25;
  /** Countdown to the next synchronized conga cheer (reset each celebration). */
  let congaCheerTimer = 0;
  /** Remaining hold time for the current synchronized conga cheer (>0 = holding). */
  let congaCheerHold = 0;
  /**
   * Currently alive enemies. Each: {instance_id, rival_id, nx, ny, hp, maxHp,
   * facingLeft, animState, targetAgentId}.
   * @type {Array<object>}
   */
  let activeEnemies = [];
  /** Monotonic counter for enemy instance ids. */
  let enemyInstanceCounter = 0;
  /**
   * Change C: whether the current theme provides a projectile FX asset. Set in
   * THEME_INITIALIZED from manifest.viewport.projectile_asset presence AND the
   * loaded themeImages['projectile'] frames. When false, ranged attackers play
   * their shoot clip but NO projectile is spawned/drawn (graceful fallback for
   * older themes without the 4-frame projectile sprite).
   */
  let themeHasProjectile = false;
  /**
   * Change C: live ranged-fire projectiles. Each:
   * {fromNx, fromNy, toNx, toNy, t, ny}. Spawned by ranged agent shots and by
   * enemy ranged attacks; advanced + drawn per frame; removed when the blast
   * finishes. Purely visual (no damage — combat damage is applied at fire
   * time in the existing agent/enemy engage code).
   * @type {Array<{fromNx:number,fromNy:number,toNx:number,toNy:number,t:number,ny:number}>}
   */
  let activeProjectiles = [];
  /** Native px/sec effective speed of a projectile (flight time ~= dist/this). */
  const PROJECTILE_FLIGHT_SEC = 0.25;
  /** Extra "hold" time (seconds) the blast frame lingers after t reaches 1. */
  const PROJECTILE_BLAST_HOLD = 0.12;
  /**
   * Rotation (radians) added to the computed travel-direction angle before
   * drawing a projectile. The projectile art's rest orientation points RIGHT
   * (angle 0), so 0 is correct for that art. If a theme's projectile sprite
   * is drawn pointing in a different rest direction, adjust here (e.g.
   * ±Math.PI/2 for art that points up/down, Math.PI for art that points left).
   */
  const PROJECTILE_ART_ANGLE_OFFSET = 0;
  /**
   * Fraction of walkableNativeH that a projectile's IMPACT (target) point is
   * raised above the target's BASE (feet) position, so shots read as landing
   * at roughly the target's center mass instead of the ground. The ORIGIN
   * side no longer uses this flat fraction — see PROJECTILE_ORIGIN_HEIGHT_FRAC,
   * which is expressed relative to the shooter's own rendered sprite height
   * instead (stays correct across character scale/depth/sceneFitScale; a flat
   * fraction of walkableNativeH does not). Tunable.
   */
  const PROJECTILE_GUN_HEIGHT_FRAC = 0.06;
  /**
   * Fraction of the SHOOTER's own rendered sprite height that a projectile's
   * spawn origin is raised above the shooter's BASE (feet) position — shots
   * now leave from just above the sprite's vertical center (0.55 = 55% up;
   * 0.8 read as firing from the head, 0.7 still too high per playtest) rather
   * than the midsection. Computed by each spawnProjectile call site from that
   * shooter's actual depthScale/scale/sceneFitScale (mirrors the existing
   * muzzle-forward X push, which does the same canvas-px→native-px
   * conversion for width), so it stays correct across character scales,
   * depth projection, and sceneFitScale rather than being a hardcoded pixel
   * offset. Tunable.
   */
  const PROJECTILE_ORIGIN_HEIGHT_FRAC = 0.55;
  /**
   * How far the projectile's spawn ORIGIN is pushed toward the shooter's
   * leading edge (in the facing direction) as a fraction of the shooter's
   * drawn half-width, converted to native space (0 = spawn at center X,
   * unchanged from before; 1 = spawn exactly at the sprite's edge). Applied
   * identically to agents and rivals so shots read as leaving the gun on the
   * far side of the shooter rather than its horizontal middle. Aim/travel
   * toward the target is unaffected — only the origin X moves.
   */
  const PROJECTILE_MUZZLE_FRAC = 0.9;
  /** Native px distance at which a non-fleeing enemy fires a ranged shot. */
  const ENEMY_RANGED_RANGE = 120;
  /** Seconds between an enemy's ranged/melee attack "hits" (cadence, not per-frame). */
  const ENEMY_ATTACK_INTERVAL = 1.0;
  /** Seconds between projectile spawns per ranged shooter (throttle). */
  const PROJECTILE_SPAWN_INTERVAL = 0.5;
  /** Per-enemy max HP (native combat tuning — no host telemetry involved). */
  const ENEMY_MAX_HP = 100;
  /** Damage per second an engaged agent deals to its target enemy. */
  const AGENT_DPS = 40;
  /** Native px distance at which an agent switches from walk to melee/shoot. */
  const ENEMY_ENGAGE_RANGE = 36;
  /**
   * Native px engage distance once RANGED combat is unlocked (the ranged
   * weapon rack — build_order 0 — has been fully built). Larger than the
   * melee range so ranged fighters stand back and shoot instead of closing
   * to melee distance.
   */
  const RANGED_ENGAGE_RANGE = 110;
  /**
   * Max |dy|/|dx| grade (~15%) allowed for a ranged shot. Above this the
   * shooter is considered too vertically misaligned with its target and
   * walks to align (vertically) instead of firing this frame.
   */
  const MAX_SHOT_SLOPE = 0.15;
  /** Native px/second enemy walk-in speed. */
  const ENEMY_WALK_SPEED = 40;
  /**
   * Hysteresis margin (native px) added to the range boundaries so a moving
   * target hovering right at ENEMY_RANGED_RANGE / ENEMY_ENGAGE_RANGE doesn't
   * flip the enemy between walk<->attack every frame (which reset the walk
   * clip and produced a "walking-in-place" jitter). Once attacking, the enemy
   * keeps attacking until the target drifts beyond range + this margin.
   */
  const ENEMY_RANGE_HYSTERESIS = 30;
  /**
   * Walk-cycle hysteresis, expressed as fractions of a FULL-SPEED step this
   * frame (ENEMY_WALK_SPEED * delta) so it is frame-rate independent, unlike a
   * raw-px threshold. An enemy begins playing its walk cycle only once it moves
   * at least _HI of a full step (clearly progressing) and stops the cycle only
   * once it drops below _LO of a full step (arrived / blocked / boundary
   * slide). Between the two it keeps its current walking state, so a stopped
   * enemy never flip-flops advance/freeze frame-to-frame — which previously
   * stuttered its legs between walk poses in place.
   */
  const ENEMY_WALK_MOVE_RATIO_HI = 0.55;
  const ENEMY_WALK_MOVE_RATIO_LO = 0.25;
  /**
   * Target STICKINESS margin (native px). A combatant (enemy chasing an agent,
   * or agent engaging an enemy) keeps its CURRENT target until some other
   * candidate is closer than the current target by MORE than this margin.
   * Without this, an enemy roughly between two near-equidistant agents re-picks
   * a different target every frame → its facing flips and, in walk mode, it
   * steps toward one then the other → visible in-place jitter/blur. The range
   * hysteresis and ATTACK_FACING_DEADZONE don't help because each agent sits
   * far to one side.
   */
  const TARGET_SWITCH_MARGIN = 30;
  /**
   * Idle ambient combat: cosmetic hit-reaction (block/flinch pose, see
   * ATLAS_CLIPS.block) rate-limit. A random cooldown in this range is drawn
   * each time a character's block reaction fires, so it reads as an
   * occasional flinch rather than a fixed metronome. Purely visual — no
   * damage, no eviction.
   */
  const HIT_REACT_COOLDOWN_MIN = 2;
  const HIT_REACT_COOLDOWN_MAX = 4;
  /** Duration (seconds) the block/flinch pose holds before returning to the normal engage clip. */
  const HIT_REACT_HOLD_SEC = 0.4;

  /**
   * Cosmetic "dazed on damage" state machine tunables. When an IDLE agent
   * takes a combat hit (see the hit-react block above), it becomes dazed:
   * shows the dazed expression bubble, stops fighting, and retreats to an
   * available seat; charEntry.dazePhase drives it (null | "retreat" |
   * "seated"). Purely cosmetic — never touches damage/eviction outcomes.
   * An ACTIVE agent instantly drops/never enters daze (see the isActive
   * override in the per-agent loop).
   */
  const DAZE_EXPR_INDEX = 7;
  /** Seconds a dazed agent stays seated before recovering to normal idle. */
  const DAZE_SEATED_RECOVER_SEC = 3;
  /** Safety cap (seconds): if no seat ever opens up while retreating, give up and recover in place. */
  const DAZE_SAFETY_MAX_SEC = 10;
  /** Post-recovery immunity window (seconds) before the same agent can be dazed again. */
  const DAZE_REENTRY_COOLDOWN_SEC = 4;

  // ── Stage editor (live polygon + scale tuning) ───────────────────────────
  /** True while the "Edit Stage" overlay is active. */
  let editStageMode = false;
  /**
   * Edit-Stage only: when true, show EVERY buildable + decor (including unbuilt
   * buildables and hidden/unplaced decor) so they can be pre-positioned/scaled.
   * When false, edit mode shows only the current playfield view (built
   * buildables + currently-placed decor). Default true = prior edit behavior.
   * Ignored outside edit mode (each render/hit gate ANDs with editStageMode).
   */
  let stageShowAllObjects = true;
  /**
   * Edit-Stage only: when true, draw the amber walkable/boundary polygon
   * overlay. Toggleable so it can be hidden when it obscures objects being
   * placed. Default true = prior edit behavior. Ignored outside edit mode
   * (the draw gate ANDs with editStageMode).
   */
  let showBoundaryPolygon = true;
  /** Index of the polygon vertex currently being dragged, or -1. */
  let dragVertexIndex = -1;
  /** Index of the polygon vertex under the cursor (for hover highlight), or -1. */
  let hoverVertexIndex = -1;
  /** Id of the scene object (buildable/decor) currently being dragged, or null. */
  let dragObjectId = null;
  /** Type of the dragged scene object: "buildable" | "decor" | null. */
  let dragObjectType = null;
  /** Type of the scene object currently under the cursor (hover, not drag): "buildable" | "decor" | null. Drives the cursor style AND is the F-flip hotkey's primary target (see the keydown handler) so hover+F works without a prior click/dropdown selection. */
  let hoverSceneObjType = null;
  /** Id of the scene object currently under the cursor (hover, not drag), or null. */
  let hoverSceneObjId = null;
  /** Last drawn background rect (canvas px) — lets mouse handlers map canvas<->native. */
  let lastBgX = 0, lastBgY = 0, lastBgW = 1, lastBgH = 1;
  /**
   * Play-mode hover-tooltip hit-list (Feature: hover tooltips). Rebuilt from
   * scratch every render() frame — reset at the top of render(), then each
   * hoverable sprite (character, buildable object, rival — decor is
   * deliberately excluded) pushes its own on-screen hit box as it's drawn, so
   * this always matches exactly what's currently painted. Each entry:
   * { x0, y0, x1, y1 } canvas-px hit box, `yFront` (the sprite's foot y, used
   * to pick the front-most sprite when boxes overlap), `kind`
   * ("character"|"object"|"rival"), and `name` (+ `role` for characters).
   * Consumed only by the play-mode mousemove/mouseleave listeners below
   * (gated on !editStageMode) — edit-mode hit-testing uses the separate
   * sceneObjectAt()/vertexAt() helpers and is unaffected.
   * @type {Array<{x0:number,y0:number,x1:number,y1:number,yFront:number,kind:string,name:string,role?:string}>}
   */
  let hoverTargets = [];
  /** Character id selected in the per-character override control. */
  let editSelectedCharId = "";
  /** Buildable object_id selected in the per-object override control. */
  let editSelectedObjId = "";
  /** Rival rival_id selected in the per-rival override control. */
  let editSelectedRivalId = "";
  /** Decor decor_id selected in the per-decor override control. */
  let editSelectedDecorId = "";
  /**
   * Which kind of item the F-flip hotkey targets: "buildable" | "decor" | null.
   * This is the same "current item" concept the scale sliders act on
   * (editSelectedObjId/editSelectedDecorId) — set whenever the user picks an
   * item, either by clicking it on the canvas (which also drives a drag) or
   * via the per-object/per-decor override dropdown. null means nothing is
   * currently selected, so F is a no-op.
   */
  let editFlipTargetKind = null;

  // ── Stage loading progress (a bar replaces placeholders while loading) ────
  const LOADING_TIMEOUT_MS = 6000;
  /** performance.now() when we began waiting for the stage to load. */
  let themeLoadStartTs = 0;
  /** Set true on THEME_NONE (host confirmed there's no theme to load yet —
   *  fresh install) so the loading window ends immediately instead of idling
   *  out LOADING_TIMEOUT_MS, and the boot loader hands off to the no-theme
   *  placeholder scene the instant it actually renders. */
  let noThemeSignaled = false;
  // ── Boot-loader all-clear telemetry ──────────────────────────────────────
  // The loading signal (_load.ready, 95% of frames decoded) leads the actual
  // canvas paint: entities whose CURRENT animation frame hasn't decoded yet
  // are withheld from the frame (never placeholder-drawn — see the sprite
  // draw paths). The overlay stays fully opaque until render() reports, per
  // frame, that the decoded theme background was drawn AND no entity was
  // withheld while its art was still decoding — for BOOT_THEMED_FRAMES_MIN
  // consecutive frames AND BOOT_THEMED_HOLD_MS since the first such frame
  // (whichever is later). Failsafes (setup hide, THEME_NONE, 12s hard
  // timeout) bypass this.
  const BOOT_THEMED_FRAMES_MIN = 5;
  const BOOT_THEMED_HOLD_MS = 250;
  /** This frame drew the decoded theme background (set at the bg drawImage). */
  let bootFrameThemeBgDrawn = false;
  /** This frame WITHHELD an entity whose art is STILL DECODING (img exists
   *  but !complete). Missing/errored art (no img, or complete with
   *  naturalWidth 0) is that entity's permanent no-render state and
   *  deliberately does NOT set this — it must never hold the loader hostage. */
  let bootFrameSpritePending = false;
  /** Consecutive fully-themed frames painted (resets on any regression). */
  let bootThemedFrames = 0;
  /** nowMs() of the first frame in the current consecutive themed run. */
  let bootFirstThemedFrameTs = 0;
  function nowMs() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  /** Progress over the theme background + character frames: { ready, frac }. */
  function themeLoadProgress() {
    if (!themeLoaded) return { ready: false, frac: 0 };
    let total = 0, done = 0;
    const bgOk = !themeBackgroundImg || (themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0);
    if (themeBackgroundImg) { total++; if (themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0) done++; }
    for (const id in themeImages) {
      const arr = themeImages[id];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const im = arr[i];
        if (!im) continue;
        total++;
        if (im.complete && im.naturalWidth > 0) done++;
      }
    }
    const frac = total > 0 ? done / total : 0;
    return { ready: total > 0 && bgOk && frac >= 0.95, frac };
  }
  /** True when every image queued for the current theme has SETTLED — decoded
   *  or errored. Stricter than themeLoadProgress().ready (which passes at 95%
   *  decoded, letting stick-figure fallbacks flash while stragglers decode).
   *  An errored <img> has complete=true (naturalWidth 0), so missing art
   *  counts as settled and can never hang the boot loader's all-clear. */
  function themeImagesAllSettled() {
    if (themeBackgroundImg && !themeBackgroundImg.complete) return false;
    for (const id in themeImages) {
      const arr = themeImages[id];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const im = arr[i];
        if (im && !im.complete) return false;
      }
    }
    return true;
  }

  /** Convert a mouse event to canvas-pixel coords (accounts for CSS scaling). */
  function canvasMouse(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? canvas.width / rect.width : 1;
    const sy = rect.height > 0 ? canvas.height / rect.height : 1;
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
  }
  /** Inverse of nativeToCanvas using the last drawn background rect. */
  function canvasToNative(mx, my) {
    return [
      (mx - lastBgX) * (walkableNativeW / lastBgW),
      (my - lastBgY) * (walkableNativeH / lastBgH),
    ];
  }
  /** Index of the polygon vertex within rPx canvas px of (mx,my), else -1. */
  function vertexAt(mx, my, rPx) {
    for (let i = 0; i < walkablePolygon.length; i++) {
      const [vx, vy] = nativeToCanvas(walkablePolygon[i][0], walkablePolygon[i][1], lastBgX, lastBgY, lastBgW, lastBgH);
      const dx = vx - mx, dy = vy - my;
      if (dx * dx + dy * dy <= rPx * rPx) return i;
    }
    return -1;
  }
  /** Index of the edge whose midpoint is within rPx of (mx,my), else -1. */
  function edgeMidAt(mx, my, rPx) {
    for (let i = 0; i < walkablePolygon.length; i++) {
      const a = walkablePolygon[i];
      const b = walkablePolygon[(i + 1) % walkablePolygon.length];
      const [cxm, cym] = nativeToCanvas((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, lastBgX, lastBgY, lastBgW, lastBgH);
      const dx = cxm - mx, dy = cym - my;
      if (dx * dx + dy * dy <= rPx * rPx) return i;
    }
    return -1;
  }

  /**
   * Display-only fallback native placement for a decor that has no real
   * decorPlacement entry (hidden via the [-1,-1] sentinel, or unplaced). Used
   * ONLY in Edit-Stage "show all objects" mode so hidden/unplaced decor can be
   * seen, selected, moved and scaled. Never persisted — moving a decor writes a
   * real anchor override which un-hides it. Places at the decor's declared
   * normalized anchor when recoverable, else spreads it across a central band
   * (by index) so multiple hidden decor don't all stack.
   * @param {object} decor @param {number} index position in themeDecor
   * @returns {{nx:number, ny:number, sitNx:number, sitNy:number, sittable:boolean, fallback:boolean}}
   */
  function decorFallbackPlacement(decor, index) {
    const a = decor && decor.anchor_coord;
    let nx, ny;
    if (Array.isArray(a) && a.length >= 2 &&
        typeof a[0] === "number" && typeof a[1] === "number" &&
        !(a[0] < 0 && a[1] < 0)) {
      const c = clampToSceneBounds(a[0] * walkableNativeW, a[1] * walkableNativeH);
      nx = c[0]; ny = c[1];
    } else {
      const n = Math.max(1, themeDecor.length);
      const t = (index + 0.5) / n;
      nx = (0.2 + 0.6 * t) * walkableNativeW;
      ny = 0.5 * walkableNativeH;
    }
    return { nx, ny, sitNx: nx, sitNy: ny, sittable: !!(decor && decor.is_sittable), fallback: true };
  }

  /** True when Edit-Stage show-all is active (unbuilt/hidden items are visible). */
  function showAllActive() {
    return editStageMode && stageShowAllObjects;
  }

  /**
   * Nearest draggable scene object (buildable or decor) whose drawn center is
   * within rPx canvas px of (mx,my), else null. Uses the same native->canvas
   * transform the objects are drawn with so hit-testing matches the sprite.
   * Hit-testing is gated to match visibility: unbuilt buildables and
   * hidden/unplaced decor are only selectable when show-all is active.
   */
  function sceneObjectAt(mx, my, rPx) {
    let best = null;
    let bestD = rPx * rPx;
    const showAll = showAllActive();
    for (let i = 0; i < themeBuildables.length; i++) {
      const objId = themeBuildables[i].object_id;
      const p = objectPlacement[objId];
      if (!p) continue;
      const oe = objectAnimMap[objId];
      if (oe && oe.phase === "unbuilt" && !showAll) continue;
      const [cx, cy] = nativeToCanvas(p.nx, p.ny, lastBgX, lastBgY, lastBgW, lastBgH);
      const dx = cx - mx, dy = cy - my, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = { type: "buildable", id: objId }; }
    }
    for (let i = 0; i < themeDecor.length; i++) {
      const id = themeDecor[i].decor_id;
      if (id == null) continue;
      // H-hidden decor is only selectable in show-all mode (the "bring it
      // back" path) — outside that it's not drawn, so it must not be clickable.
      if (themeDecorHidden.has(id) && !showAll) continue;
      let p = decorPlacement[id];
      if (!p) {
        if (showAll) p = decorFallbackPlacement(themeDecor[i], i);
        else continue;
      }
      const [cx, cy] = nativeToCanvas(p.nx, p.ny, lastBgX, lastBgY, lastBgW, lastBgH);
      const dx = cx - mx, dy = cy - my, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = { type: "decor", id: id }; }
    }
    return best;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!editStageMode) return;
    const [mx, my] = canvasMouse(e);
    // A boundary vertex is only grabbable while the boundary overlay is
    // actually shown (showBoundaryPolygon) — otherwise it's invisible but was
    // still draggable, letting the user blindly drag the walkable polygon.
    const vi = showBoundaryPolygon ? vertexAt(mx, my, 11) : -1;
    if (vi >= 0) { dragVertexIndex = vi; e.preventDefault(); return; }
    // Otherwise start dragging a buildable/decor object under the cursor.
    const hit = sceneObjectAt(mx, my, 20);
    if (hit) {
      dragObjectType = hit.type;
      dragObjectId = hit.id;
      // Clicking/dragging an item also makes it the F-flip hotkey's target —
      // same "current item" concept the scale sliders use.
      editFlipTargetKind = hit.type;
      // Auto-select the picked object/decor in its per-item override control
      // so the scale slider you'd want next is already pointed at it.
      if (hit.type === "buildable" && stageEditEls.obj) {
        editSelectedObjId = hit.id;
        stageEditEls.obj.value = hit.id;
        syncObjOverrideSlider();
      } else if (hit.type === "decor" && stageEditEls.decor) {
        editSelectedDecorId = hit.id;
        stageEditEls.decor.value = hit.id;
        syncDecorOverrideSlider();
      }
      e.preventDefault();
    }
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!editStageMode) return;
    const [mx, my] = canvasMouse(e);
    // Defensive: if visibility is toggled off mid-drag, stop moving the
    // vertex (mirrors the mousedown pickup gate above).
    if (dragVertexIndex >= 0 && showBoundaryPolygon) {
      const [nx, ny] = canvasToNative(mx, my);
      walkablePolygon[dragVertexIndex] = [
        Math.max(0, Math.min(walkableNativeW, nx)),
        Math.max(0, Math.min(walkableNativeH, ny)),
      ];
    } else if (dragObjectId) {
      // Drag a buildable/decor object: cursor -> native -> clamp -> store as a
      // normalized override; also move the live placement so the sprite
      // tracks the cursor this frame. Buildables must stay reachable, so
      // they're clamped to the walkable nav polygon; decor is pure scenery
      // and is free to go anywhere in the scene, only bounded by the
      // background rectangle.
      const [nx, ny] = canvasToNative(mx, my);
      const cl = dragObjectType === "buildable"
        ? clampToPolygon(nx, ny, walkablePolygon)
        : clampToSceneBounds(nx, ny);
      const normX = Math.max(0, Math.min(1, cl[0] / walkableNativeW));
      const normY = Math.max(0, Math.min(1, cl[1] / walkableNativeH));
      if (dragObjectType === "buildable") {
        themeObjAnchorOverrides[dragObjectId] = [normX, normY];
        const p = objectPlacement[dragObjectId];
        if (p) { p.nx = cl[0]; p.ny = cl[1]; }
      } else {
        // Writing a real normalized anchor here also clears the hidden [-1,-1]
        // sentinel (it's overwritten), so a hidden/animated decor un-hides the
        // moment it's dragged.
        themeDecorAnchorOverrides[dragObjectId] = [normX, normY];
        let p = decorPlacement[dragObjectId];
        if (!p) {
          // Materialize a fallback-shown decor (hidden [-1,-1] or unplaced,
          // visible only via decorFallbackPlacement in show-all mode) into a
          // real placement so the move is live AND persists. Seed from its
          // current fallback position, then the update below moves it.
          const idx = themeDecor.findIndex((x) => x && x.decor_id === dragObjectId);
          const d0 = idx >= 0 ? themeDecor[idx] : null;
          const fb = decorFallbackPlacement(d0, idx >= 0 ? idx : 0);
          p = decorPlacement[dragObjectId] = {
            nx: fb.nx, ny: fb.ny, sitNx: fb.sitNx, sitNy: fb.sitNy, sittable: fb.sittable,
          };
          if (d0 && d0.is_sittable && !Object.prototype.hasOwnProperty.call(seatOccupancy, dragObjectId)) {
            seatOccupancy[dragObjectId] = null;
          }
        }
        p.nx = cl[0]; p.ny = cl[1];
        // Keep a seat's sit-point under the moved seat.
        const d = themeDecor.find((x) => x.decor_id === dragObjectId);
        const sit = d && Array.isArray(d.sit_anchor) && d.sit_anchor.length >= 2 ? d.sit_anchor : DEFAULT_SIT_ANCHOR;
        const sn = clampToPolygon(cl[0] + sit[0] * walkableNativeW, cl[1] + sit[1] * walkableNativeH, walkablePolygon);
        p.sitNx = sn[0]; p.sitNy = sn[1];
      }
    } else {
      hoverVertexIndex = vertexAt(mx, my, 11);
      const overObj = hoverVertexIndex < 0 && sceneObjectAt(mx, my, 20);
      canvas.style.cursor = hoverVertexIndex >= 0 ? "grab" : (overObj ? "move" : "default");
      // Track the hovered scene object (independent of drag) so the F-to-flip
      // decor shortcut knows what's under the cursor.
      hoverSceneObjType = overObj ? overObj.type : null;
      hoverSceneObjId = overObj ? overObj.id : null;
    }
  });
  canvas.addEventListener("mouseleave", () => {
    hoverSceneObjType = null;
    hoverSceneObjId = null;
  });
  window.addEventListener("mouseup", () => {
    if (dragVertexIndex >= 0) dragVertexIndex = -1;
    if (dragObjectId) { dragObjectId = null; dragObjectType = null; }
  });
  canvas.addEventListener("dblclick", (e) => {
    if (!editStageMode) return;
    const [mx, my] = canvasMouse(e);
    const ei = edgeMidAt(mx, my, 14);
    if (ei >= 0) {
      const a = walkablePolygon[ei];
      const b = walkablePolygon[(ei + 1) % walkablePolygon.length];
      walkablePolygon.splice(ei + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      e.preventDefault();
    }
  });
  canvas.addEventListener("contextmenu", (e) => {
    if (!editStageMode) return;
    e.preventDefault();
    const [mx, my] = canvasMouse(e);
    const vi = vertexAt(mx, my, 11);
    if (vi >= 0 && walkablePolygon.length > 3) {
      walkablePolygon.splice(vi, 1);
      hoverVertexIndex = -1;
      return;
    }
    // Right-click an object: buildables revert to their generated spot; decor
    // is hidden (persisted via the [-1,-1] sentinel).
    const hit = sceneObjectAt(mx, my, 20);
    if (hit) {
      if (hit.type === "buildable") {
        delete themeObjAnchorOverrides[hit.id];
        const home = objectHomePlacement[hit.id];
        if (home && objectPlacement[hit.id]) { objectPlacement[hit.id].nx = home.nx; objectPlacement[hit.id].ny = home.ny; }
      } else {
        themeDecorAnchorOverrides[hit.id] = [-1, -1];
        delete decorPlacement[hit.id];
        if (Object.prototype.hasOwnProperty.call(seatOccupancy, hit.id)) delete seatOccupancy[hit.id];
      }
    }
  });

  // ── Play-mode hover tooltips (Feature: hover tooltips) ────────────────────
  // Names a CHARACTER (+ its agent role), a built/in-progress buildable
  // OBJECT, or a RIVAL on mouseover — decor is deliberately excluded. Reads
  // hoverTargets, the per-frame hit-list built during render() (see its
  // declaration near lastBgX above and the push sites in the depthList
  // draw loop). Entirely separate from the edit-mode mousemove/mouseleave
  // listeners above (each guards on editStageMode in the opposite
  // direction), so neither interferes with the other.
  const stageTooltipEl = document.createElement("div");
  stageTooltipEl.id = "stage-tooltip";
  stageTooltipEl.hidden = true;
  (document.getElementById("stage-area") || canvas.parentElement || document.body).appendChild(stageTooltipEl);

  function hideStageTooltip() {
    stageTooltipEl.hidden = true;
  }

  /**
   * Populate + position the hover tooltip near the cursor.
   * @param {{kind:string, name:string, role?:string}} target
   * @param {number} clientX @param {number} clientY viewport coords (e.clientX/Y)
   */
  function showStageTooltip(target, clientX, clientY) {
    stageTooltipEl.innerHTML = "";
    const nameEl = document.createElement("div");
    nameEl.className = "stage-tooltip-name";
    nameEl.textContent = target.name || "";
    stageTooltipEl.appendChild(nameEl);
    if (target.kind === "character") {
      const roleEl = document.createElement("div");
      roleEl.className = "stage-tooltip-role";
      roleEl.textContent = target.role || "";
      stageTooltipEl.appendChild(roleEl);
    }
    stageTooltipEl.hidden = false;

    // Position relative to #stage-area (the tooltip's own offsetParent),
    // offset from the cursor, then clamped so it never overflows the stage's
    // right/bottom edge. clientX/clientY (not canvas px) are used here since
    // the tooltip lives in normal CSS layout space, not canvas-internal
    // resolution (which can differ from the canvas's on-screen CSS size).
    const stageArea = stageTooltipEl.parentElement;
    const rect = stageArea.getBoundingClientRect();
    const OFFSET = 14;
    let left = clientX - rect.left + OFFSET;
    let top = clientY - rect.top + OFFSET;
    const tw = stageTooltipEl.offsetWidth;
    const th = stageTooltipEl.offsetHeight;
    if (left + tw > rect.width) left = Math.max(0, clientX - rect.left - tw - OFFSET);
    if (top + th > rect.height) top = Math.max(0, clientY - rect.top - th - OFFSET);
    stageTooltipEl.style.left = `${left}px`;
    stageTooltipEl.style.top = `${top}px`;
  }

  canvas.addEventListener("mousemove", (e) => {
    // Edit-mode has its own mousemove handler above (and its own hover/drag
    // hit-testing) — this listener is play-mode only.
    if (editStageMode) return;
    const [mx, my] = canvasMouse(e);
    let best = null;
    let bestFront = -Infinity;
    for (let i = 0; i < hoverTargets.length; i++) {
      const t = hoverTargets[i];
      if (mx < t.x0 || mx > t.x1 || my < t.y0 || my > t.y1) continue;
      // Front-most (largest yFront = closest to camera / last drawn) wins
      // when hit boxes overlap.
      if (t.yFront >= bestFront) { bestFront = t.yFront; best = t; }
    }
    if (best) showStageTooltip(best, e.clientX, e.clientY);
    else hideStageTooltip();
  });
  canvas.addEventListener("mouseleave", () => hideStageTooltip());

  // ── Stage editor control panel (built lazily, toggled with edit mode) ─────
  let stageEditPanel = null;
  const stageEditEls = {};
  function buildStageEditPanel() {
    if (stageEditPanel) return;
    const stageAreaEl = document.getElementById("stage-area") || document.body;
    const wrap = document.createElement("div");
    wrap.id = "stage-edit-panel";
    wrap.className = "se-panel";
    wrap.setAttribute("hidden", "");
    wrap.innerHTML =
      '<div class="se-header"><span id="se-h" class="se-title">⚙ Edit Stage</span></div>' +
      '<div class="se-body">' +
        '<div class="se-section">' +
          '<div class="se-section-title">Scene</div>' +
          '<div class="se-row"><span class="se-label">Overall scale</span><span class="se-value"><span id="se-ov-val">1.00</span></span></div>' +
          '<input id="se-ov" class="se-range" type="range" min="0.5" max="3" step="0.05" value="1">' +
        '</div>' +
        '<div class="se-section">' +
          '<div class="se-section-title">Characters</div>' +
          '<div class="se-row"><span class="se-label">Character scale</span><span class="se-value"><span id="se-cs-val">1.00</span></span></div>' +
          '<input id="se-cs" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
          '<div class="se-override">' +
            '<div class="se-override-label">Per-character override</div>' +
            '<select id="se-char" class="se-select"></select>' +
            '<input id="se-co" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
            '<button id="se-co-clear" class="se-clear" type="button">clear override</button>' +
          '</div>' +
        '</div>' +
        '<div class="se-section">' +
          '<button id="se-show-all" class="se-btn se-btn-ghost" type="button">Show current view only</button>' +
          '<div class="se-sublabel">Toggle to reveal every buildable + decor (even unbuilt/hidden) for placing &amp; scaling.</div>' +
          '<button id="se-toggle-boundary" class="se-btn se-btn-ghost" type="button">Hide boundary</button>' +
          '<div class="se-sublabel">Toggle the amber walkable/boundary polygon overlay (hide it when it obscures objects).</div>' +
        '</div>' +
        '<div class="se-section">' +
          '<div class="se-section-title">Objects</div>' +
          '<div class="se-row"><span class="se-label">Object scale</span><span class="se-value"><span id="se-os-val">1.00</span></span></div>' +
          '<input id="se-os" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
          '<div class="se-override">' +
            '<div class="se-override-label">Per-object override</div>' +
            '<select id="se-obj" class="se-select"></select>' +
            '<input id="se-oo" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
            '<button id="se-oo-clear" class="se-clear" type="button">clear override</button>' +
          '</div>' +
        '</div>' +
        '<div class="se-section">' +
          '<div class="se-section-title">Rivals</div>' +
          '<div class="se-row"><span class="se-label">Rival scale</span><span class="se-value"><span id="se-rs-val">1.00</span></span></div>' +
          '<input id="se-rs" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
          '<div class="se-override">' +
            '<div class="se-override-label">Per-rival override</div>' +
            '<select id="se-rival" class="se-select"></select>' +
            '<input id="se-ro" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
            '<button id="se-ro-clear" class="se-clear" type="button">clear override</button>' +
          '</div>' +
        '</div>' +
        '<div class="se-section">' +
          '<div class="se-section-title">Decor</div>' +
          '<div class="se-row"><span class="se-label">Decor scale</span><span class="se-value"><span id="se-ds-val">1.00</span></span></div>' +
          '<input id="se-ds" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
          '<div class="se-override">' +
            '<div class="se-override-label">Per-decor override</div>' +
            '<select id="se-decor" class="se-select"></select>' +
            '<input id="se-do" class="se-range" type="range" min="0.3" max="3" step="0.05" value="1">' +
            '<button id="se-do-clear" class="se-clear" type="button">clear override</button>' +
            '<button id="se-decor-hide" class="se-clear se-decor-hide-btn" type="button">Hide</button>' +
          '</div>' +
        '</div>' +
        '<div class="se-section">' +
          '<div class="se-section-title">Enemies</div>' +
          '<div class="se-row"><span class="se-label">Spawn interval</span><span class="se-value"><span id="se-ei-val">45s</span></span></div>' +
          '<input id="se-ei" class="se-range" type="range" min="10" max="1200" step="5" value="45">' +
          '<div class="se-sublabel">Enemy count mode</div>' +
          '<select id="se-ecm" class="se-select"><option value="random">random</option><option value="all">all</option></select>' +
        '</div>' +
        '<div id="se-hint" class="se-hint">Polygon: drag points · dbl-click edge to add · right-click to remove.<br>Objects/decor: drag to move · right-click to reset (decor: hide) · select/drag + F to flip · decor: H or Hide button to hide/unhide (non-destructive)</div>' +
      '</div>' +
      '<div class="se-footer">' +
        '<button id="se-save" class="se-btn se-btn-primary" type="button">Save</button>' +
        '<button id="se-done" class="se-btn se-btn-secondary" type="button">Done</button>' +
      '</div>' +
      '<div id="se-status" class="se-status"></div>';
    stageAreaEl.appendChild(wrap);
    stageEditPanel = wrap;
    stageEditEls.cs = wrap.querySelector("#se-cs");
    stageEditEls.csVal = wrap.querySelector("#se-cs-val");
    stageEditEls.char = wrap.querySelector("#se-char");
    stageEditEls.co = wrap.querySelector("#se-co");
    stageEditEls.coClear = wrap.querySelector("#se-co-clear");
    stageEditEls.os = wrap.querySelector("#se-os");
    stageEditEls.osVal = wrap.querySelector("#se-os-val");
    stageEditEls.ov = wrap.querySelector("#se-ov");
    stageEditEls.ovVal = wrap.querySelector("#se-ov-val");
    stageEditEls.obj = wrap.querySelector("#se-obj");
    stageEditEls.oo = wrap.querySelector("#se-oo");
    stageEditEls.ooClear = wrap.querySelector("#se-oo-clear");
    stageEditEls.rs = wrap.querySelector("#se-rs");
    stageEditEls.rsVal = wrap.querySelector("#se-rs-val");
    stageEditEls.rival = wrap.querySelector("#se-rival");
    stageEditEls.ro = wrap.querySelector("#se-ro");
    stageEditEls.roClear = wrap.querySelector("#se-ro-clear");
    stageEditEls.ds = wrap.querySelector("#se-ds");
    stageEditEls.dsVal = wrap.querySelector("#se-ds-val");
    stageEditEls.decor = wrap.querySelector("#se-decor");
    stageEditEls.do_ = wrap.querySelector("#se-do");
    stageEditEls.doClear = wrap.querySelector("#se-do-clear");
    stageEditEls.decorHideBtn = wrap.querySelector("#se-decor-hide");
    stageEditEls.ei = wrap.querySelector("#se-ei");
    stageEditEls.eiVal = wrap.querySelector("#se-ei-val");
    stageEditEls.ecm = wrap.querySelector("#se-ecm");
    stageEditEls.save = wrap.querySelector("#se-save");
    stageEditEls.done = wrap.querySelector("#se-done");
    stageEditEls.status = wrap.querySelector("#se-status");
    stageEditEls.showAll = wrap.querySelector("#se-show-all");
    stageEditEls.toggleBoundary = wrap.querySelector("#se-toggle-boundary");

    // Wire controls.
    if (stageEditEls.showAll) {
      const syncShowAllLabel = () => {
        stageEditEls.showAll.textContent = stageShowAllObjects
          ? "Show current view only"
          : "Show all objects (place & scale)";
      };
      syncShowAllLabel();
      stageEditEls.showAll.addEventListener("click", () => {
        // Flip the flag; the render loop + hit-test read it each frame, so a
        // label refresh is all that's needed here (redraw is automatic).
        stageShowAllObjects = !stageShowAllObjects;
        syncShowAllLabel();
      });
    }
    if (stageEditEls.toggleBoundary) {
      const syncBoundaryLabel = () => {
        stageEditEls.toggleBoundary.textContent = showBoundaryPolygon
          ? "Hide boundary"
          : "Show boundary";
      };
      syncBoundaryLabel();
      stageEditEls.toggleBoundary.addEventListener("click", () => {
        // Flip the flag; the polygon draw gate reads it each frame, so a label
        // refresh is all that's needed here (redraw is automatic).
        showBoundaryPolygon = !showBoundaryPolygon;
        syncBoundaryLabel();
      });
    }
    stageEditEls.cs.addEventListener("input", () => {
      themeCharacterScale = parseFloat(stageEditEls.cs.value) || 1;
      stageEditEls.csVal.textContent = themeCharacterScale.toFixed(2);
    });
    stageEditEls.ov.addEventListener("input", () => {
      themeOverallScale = parseFloat(stageEditEls.ov.value) || 1;
      stageEditEls.ovVal.textContent = themeOverallScale.toFixed(2);
    });
    stageEditEls.os.addEventListener("input", () => {
      themeObjectScale = parseFloat(stageEditEls.os.value) || 1;
      stageEditEls.osVal.textContent = themeObjectScale.toFixed(2);
    });
    stageEditEls.char.addEventListener("change", () => {
      editSelectedCharId = stageEditEls.char.value;
      syncOverrideSlider();
    });
    stageEditEls.co.addEventListener("input", () => {
      if (!editSelectedCharId) return;
      themeCharScaleOverrides[editSelectedCharId] = parseFloat(stageEditEls.co.value) || 1;
    });
    stageEditEls.coClear.addEventListener("click", () => {
      if (editSelectedCharId) delete themeCharScaleOverrides[editSelectedCharId];
      syncOverrideSlider();
    });
    stageEditEls.obj.addEventListener("change", () => {
      editSelectedObjId = stageEditEls.obj.value;
      editFlipTargetKind = "buildable";
      syncObjOverrideSlider();
    });
    stageEditEls.oo.addEventListener("input", () => {
      if (!editSelectedObjId) return;
      themeObjScaleOverrides[editSelectedObjId] = parseFloat(stageEditEls.oo.value) || 1;
    });
    stageEditEls.ooClear.addEventListener("click", () => {
      if (editSelectedObjId) delete themeObjScaleOverrides[editSelectedObjId];
      syncObjOverrideSlider();
    });
    stageEditEls.rs.addEventListener("input", () => {
      themeRivalScale = parseFloat(stageEditEls.rs.value) || 1;
      stageEditEls.rsVal.textContent = themeRivalScale.toFixed(2);
    });
    stageEditEls.rival.addEventListener("change", () => {
      editSelectedRivalId = stageEditEls.rival.value;
      syncRivalOverrideSlider();
    });
    stageEditEls.ro.addEventListener("input", () => {
      if (!editSelectedRivalId) return;
      themeRivalScaleOverrides[editSelectedRivalId] = parseFloat(stageEditEls.ro.value) || 1;
    });
    stageEditEls.roClear.addEventListener("click", () => {
      if (editSelectedRivalId) delete themeRivalScaleOverrides[editSelectedRivalId];
      syncRivalOverrideSlider();
    });
    stageEditEls.ds.addEventListener("input", () => {
      themeDecorScale = parseFloat(stageEditEls.ds.value) || DECOR_SCALE;
      stageEditEls.dsVal.textContent = themeDecorScale.toFixed(2);
    });
    stageEditEls.decor.addEventListener("change", () => {
      editSelectedDecorId = stageEditEls.decor.value;
      editFlipTargetKind = "decor";
      syncDecorOverrideSlider();
      syncDecorHideButton();
    });
    stageEditEls.do_.addEventListener("input", () => {
      if (!editSelectedDecorId) return;
      themeDecorScaleOverrides[editSelectedDecorId] = parseFloat(stageEditEls.do_.value) || 1;
    });
    stageEditEls.doClear.addEventListener("click", () => {
      if (editSelectedDecorId) delete themeDecorScaleOverrides[editSelectedDecorId];
      syncDecorOverrideSlider();
    });
    if (stageEditEls.decorHideBtn) {
      stageEditEls.decorHideBtn.addEventListener("click", () => {
        if (!editSelectedDecorId) return;
        toggleDecorHidden(editSelectedDecorId);
        syncDecorHideButton();
        refreshDecorDropdownLabels();
      });
    }
    stageEditEls.ei.addEventListener("input", () => {
      enemySpawnIntervalSec = parseFloat(stageEditEls.ei.value) || 45;
      stageEditEls.eiVal.textContent = formatEnemySpawnInterval(enemySpawnIntervalSec);
    });
    stageEditEls.ecm.addEventListener("change", () => {
      enemyCountMode = stageEditEls.ecm.value === "all" ? "all" : "random";
    });
    stageEditEls.save.addEventListener("click", saveStageTuning);
    stageEditEls.done.addEventListener("click", exitEditStage);
  }
  function syncOverrideSlider() {
    const ov = themeCharScaleOverrides[editSelectedCharId];
    stageEditEls.co.value = String(typeof ov === "number" && ov > 0 ? ov : themeCharacterScale);
  }
  function syncObjOverrideSlider() {
    const ov = themeObjScaleOverrides[editSelectedObjId];
    // Overrides now compose as a multiplier on top of the global "Object
    // scale" slider (see effectiveObjScale), so the neutral/no-override
    // starting position is 1 — not the current global value.
    stageEditEls.oo.value = String(typeof ov === "number" && ov > 0 ? ov : 1);
  }
  function syncRivalOverrideSlider() {
    const ov = themeRivalScaleOverrides[editSelectedRivalId];
    stageEditEls.ro.value = String(typeof ov === "number" && ov > 0 ? ov : themeRivalScale);
  }
  function syncDecorOverrideSlider() {
    const ov = themeDecorScaleOverrides[editSelectedDecorId];
    // Overrides now compose as a multiplier on top of the global "Decor
    // scale" slider (see effectiveDecorScale), so the neutral/no-override
    // starting position is 1 — not the current global value.
    stageEditEls.do_.value = String(typeof ov === "number" && ov > 0 ? ov : 1);
  }
  /**
   * Label for a decor's per-decor override dropdown entry — appends
   * " (hidden)" when the decor is currently H-hidden, so the list shows
   * hide state at a glance (spec item 5).
   * @param {object} d a themeDecor entry
   */
  function decorOptionLabel(d) {
    const base = (d && (d.display_name || d.decor_id)) || "";
    return d && d.decor_id != null && themeDecorHidden.has(d.decor_id) ? base + " (hidden)" : base;
  }
  /** Refresh the per-decor dropdown's option labels in place (hide-state suffix) without disturbing the current selection. */
  function refreshDecorDropdownLabels() {
    if (!stageEditEls.decor) return;
    for (const opt of stageEditEls.decor.options) {
      const d = themeDecor.find((x) => x && x.decor_id === opt.value);
      if (d) opt.textContent = decorOptionLabel(d);
    }
  }
  /** Sync the Hide/Unhide button's label + enabled state to the currently selected decor. */
  function syncDecorHideButton() {
    if (!stageEditEls.decorHideBtn) return;
    const hidden = editSelectedDecorId ? themeDecorHidden.has(editSelectedDecorId) : false;
    stageEditEls.decorHideBtn.textContent = hidden ? "Unhide" : "Hide";
    stageEditEls.decorHideBtn.disabled = !editSelectedDecorId;
  }
  function enterEditStage() {
    if (!themeLoaded) return;
    buildStageEditPanel();
    editStageMode = true;
    // Play-mode-only hover tooltip must not linger once edit mode takes over.
    hideStageTooltip();
    // No item is selected yet — F is a no-op until the user picks one.
    editFlipTargetKind = null;
    // Build the per-character override list strictly from the playable roster
    // (manifest.roster_agents), keyed "agent_"+slot_id to match effectiveCharScale/
    // themeImages. Never fall back to Object.keys(themeImages) — that set also
    // contains object_/rival_/crate/poof/badge_/expression_ keys.
    let charOptions;
    if (themeRosterAgents.length) {
      charOptions = themeRosterAgents
        .filter((a) => a && a.slot_id != null)
        .map((a) => ({ id: "agent_" + a.slot_id, label: a.name || ("agent_" + a.slot_id) }));
    } else {
      charOptions = rosterOrder
        .filter((id) => typeof id === "string" && id.startsWith("agent_"))
        .map((id) => ({ id, label: id }));
    }
    stageEditEls.char.innerHTML = "";
    for (const opt of charOptions) {
      const optEl = document.createElement("option");
      optEl.value = opt.id;
      optEl.textContent = opt.label;
      stageEditEls.char.appendChild(optEl);
    }
    editSelectedCharId = (charOptions[0] && charOptions[0].id) || "";
    stageEditEls.cs.value = String(themeCharacterScale);
    stageEditEls.csVal.textContent = themeCharacterScale.toFixed(2);
    stageEditEls.os.value = String(themeObjectScale);
    stageEditEls.osVal.textContent = themeObjectScale.toFixed(2);
    stageEditEls.ov.value = String(themeOverallScale);
    stageEditEls.ovVal.textContent = themeOverallScale.toFixed(2);
    stageEditEls.ei.value = String(enemySpawnIntervalSec);
    stageEditEls.eiVal.textContent = formatEnemySpawnInterval(enemySpawnIntervalSec);
    stageEditEls.ecm.value = enemyCountMode;
    syncOverrideSlider();
    // Per-object override list: every buildable object from the loaded theme.
    const objOptions = themeBuildables.map((o) => ({
      id: o.object_id,
      label: o.display_name || o.object_id,
    }));
    stageEditEls.obj.innerHTML = "";
    for (const opt of objOptions) {
      const optEl = document.createElement("option");
      optEl.value = opt.id;
      optEl.textContent = opt.label;
      stageEditEls.obj.appendChild(optEl);
    }
    editSelectedObjId = (objOptions[0] && objOptions[0].id) || "";
    syncObjOverrideSlider();
    stageEditEls.rs.value = String(themeRivalScale);
    stageEditEls.rsVal.textContent = themeRivalScale.toFixed(2);
    // Per-rival override list: every rival from the loaded theme's roster_rivals.
    const rivalOptions = themeRivals
      .filter((r) => r && r.rival_id)
      .map((r) => ({ id: r.rival_id, label: r.name || r.rival_id }));
    stageEditEls.rival.innerHTML = "";
    for (const opt of rivalOptions) {
      const optEl = document.createElement("option");
      optEl.value = opt.id;
      optEl.textContent = opt.label;
      stageEditEls.rival.appendChild(optEl);
    }
    editSelectedRivalId = (rivalOptions[0] && rivalOptions[0].id) || "";
    syncRivalOverrideSlider();
    stageEditEls.ds.value = String(themeDecorScale);
    stageEditEls.dsVal.textContent = themeDecorScale.toFixed(2);
    // Per-decor override list: every decor object from the loaded theme.
    // Labels get a " (hidden)" suffix for H-hidden decor (decorOptionLabel).
    const decorOptions = themeDecor
      .filter((d) => d && d.decor_id != null)
      .map((d) => ({ id: d.decor_id, label: decorOptionLabel(d) }));
    stageEditEls.decor.innerHTML = "";
    for (const opt of decorOptions) {
      const optEl = document.createElement("option");
      optEl.value = opt.id;
      optEl.textContent = opt.label;
      stageEditEls.decor.appendChild(optEl);
    }
    editSelectedDecorId = (decorOptions[0] && decorOptions[0].id) || "";
    syncDecorOverrideSlider();
    syncDecorHideButton();
    stageEditEls.status.textContent = "";
    stageEditPanel.removeAttribute("hidden");
  }
  function exitEditStage() {
    editStageMode = false;
    dragVertexIndex = -1;
    hoverVertexIndex = -1;
    dragObjectId = null;
    dragObjectType = null;
    hoverSceneObjType = null;
    hoverSceneObjId = null;
    editFlipTargetKind = null;
    canvas.style.cursor = "default";
    if (stageEditPanel) stageEditPanel.setAttribute("hidden", "");
  }
  function saveStageTuning() {
    if (!selectedThemeId) {
      if (stageEditEls.status) stageEditEls.status.textContent = "No theme selected.";
      return;
    }
    const normPoly = walkablePolygon.map((p) => [
      +(p[0] / walkableNativeW).toFixed(5),
      +(p[1] / walkableNativeH).toFixed(5),
    ]);
    // Prune stale per-object/per-rival overrides down to keys that still exist
    // in the current theme, so removed objects/rivals don't leave defunct
    // override values persisted forever. Pruned COPIES only — the live state
    // maps (themeObjScaleOverrides/themeRivalScaleOverrides) are left as-is.
    const validObjIds = new Set(themeBuildables.map((o) => o.object_id));
    const prunedObjScaleOverrides = {};
    for (const k of Object.keys(themeObjScaleOverrides)) {
      if (validObjIds.has(k)) prunedObjScaleOverrides[k] = themeObjScaleOverrides[k];
    }
    const validRivalIds = new Set(themeRivals.map((r) => r.rival_id));
    const prunedRivalScaleOverrides = {};
    for (const k of Object.keys(themeRivalScaleOverrides)) {
      if (validRivalIds.has(k)) prunedRivalScaleOverrides[k] = themeRivalScaleOverrides[k];
    }
    const validDecorIds = new Set(themeDecor.map((d) => d.decor_id));
    const prunedDecorScaleOverrides = {};
    for (const k of Object.keys(themeDecorScaleOverrides)) {
      if (validDecorIds.has(k)) prunedDecorScaleOverrides[k] = themeDecorScaleOverrides[k];
    }
    // Same pruning for the F-flip overrides: only keys for items that still
    // exist in the current theme are worth persisting.
    const prunedObjFlipOverrides = {};
    for (const k of Object.keys(themeObjFlipOverrides)) {
      if (validObjIds.has(k)) prunedObjFlipOverrides[k] = themeObjFlipOverrides[k];
    }
    const prunedDecorFlipOverrides = {};
    for (const k of Object.keys(themeDecorFlipOverrides)) {
      if (validDecorIds.has(k)) prunedDecorFlipOverrides[k] = themeDecorFlipOverrides[k];
    }
    // Same pruning for the H-hide set: only ids for decor that still exist in
    // the current theme are worth persisting. Serialized as an array on the
    // wire (decor_hidden), converted back to a Set on load.
    const prunedDecorHidden = [];
    for (const id of themeDecorHidden) {
      if (validDecorIds.has(id)) prunedDecorHidden.push(id);
    }
    vscode.postMessage({
      type: "SAVE_STAGE_TUNING",
      payload: {
        theme_id: selectedThemeId,
        walkable_nav_polygon: normPoly,
        character_scale: themeCharacterScale,
        object_scale: themeObjectScale,
        overall_scale: themeOverallScale,
        character_scale_overrides: themeCharScaleOverrides,
        object_scale_overrides: prunedObjScaleOverrides,
        rival_scale: themeRivalScale,
        rival_scale_overrides: prunedRivalScaleOverrides,
        decor_scale: themeDecorScale,
        decor_scale_overrides: prunedDecorScaleOverrides,
        object_anchor_overrides: themeObjAnchorOverrides,
        decor_anchor_overrides: themeDecorAnchorOverrides,
        object_flip_overrides: prunedObjFlipOverrides,
        decor_flip_overrides: prunedDecorFlipOverrides,
        decor_hidden: prunedDecorHidden,
        enemy_config: {
          spawn_interval_seconds: enemySpawnIntervalSec,
          count_mode: enemyCountMode,
        },
      },
    });
    if (stageEditEls.status) stageEditEls.status.textContent = "Saving…";
  }

  // Inject an "Edit Stage" item into the hamburger menu.
  (function injectEditStageMenuItem() {
    if (typeof menuPopoverEl === "undefined" || !menuPopoverEl) return;
    const btn = document.createElement("button");
    btn.className = "menu-item";
    btn.id = "menu-edit-stage";
    btn.type = "button";
    btn.textContent = "Edit Stage";
    const about = document.getElementById("menu-about");
    if (about && about.parentElement === menuPopoverEl) menuPopoverEl.insertBefore(btn, about);
    else menuPopoverEl.appendChild(btn);
    btn.addEventListener("click", () => {
      if (typeof closeMenu === "function") closeMenu();
      enterEditStage();
    });
  })();

  // Escape exits the stage editor.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editStageMode) exitEditStage();
    // F flips an Edit-Stage buildable/decor horizontally. Target priority:
    // (1) the object currently being dragged, (2) the object under the
    // cursor right now (hoverSceneObjType/hoverSceneObjId — kept live by the
    // mousemove handler above via sceneObjectAt, the same hit-test the click
    // handler uses), (3) the last explicit click/dropdown selection
    // (editFlipTargetKind + editSelectedObjId/editSelectedDecorId). This
    // makes hover+F always work instead of requiring a prior click. Never
    // hijacks F outside edit mode, off a text input (mirrors the debug-hotkey
    // guard below), or when nothing is dragged/hovered/selected.
    if ((e.key === "f" || e.key === "F") && editStageMode) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const kind = dragObjectId
        ? dragObjectType
        : hoverSceneObjType
          ? hoverSceneObjType
          : editFlipTargetKind;
      const id = dragObjectId
        ? dragObjectId
        : hoverSceneObjType
          ? hoverSceneObjId
          : kind === "buildable" ? editSelectedObjId : kind === "decor" ? editSelectedDecorId : null;
      if (kind === "buildable" && id) {
        if (themeObjFlipOverrides[id]) delete themeObjFlipOverrides[id];
        else themeObjFlipOverrides[id] = true;
        e.preventDefault();
      } else if (kind === "decor" && id) {
        if (themeDecorFlipOverrides[id]) delete themeDecorFlipOverrides[id];
        else themeDecorFlipOverrides[id] = true;
        e.preventDefault();
      }
    }
    // H toggles the non-destructive HIDE state of the CURRENT Edit-Stage
    // target — same drag→hover→selection priority as F-flip above, but
    // decor-only (buildable objects are gameplay progression, not hideable
    // in v1 — see toggleDecorHidden). Mirrors the F handler's guards exactly.
    if ((e.key === "h" || e.key === "H") && editStageMode) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      // Same target resolution as F (drag > hover > last explicit
      // selection), except H has no editFlipTargetKind fallback since decor
      // is the only hideable kind — falling through to "decor" lets the
      // last dropdown selection (editSelectedDecorId) still work when
      // nothing is being dragged or hovered.
      const kind = dragObjectId
        ? dragObjectType
        : hoverSceneObjType
          ? hoverSceneObjType
          : "decor";
      const id = dragObjectId
        ? dragObjectId
        : hoverSceneObjType
          ? hoverSceneObjId
          : editSelectedDecorId;
      if (kind === "decor" && id) {
        toggleDecorHidden(id);
        syncDecorHideButton();
        refreshDecorDropdownLabels();
        e.preventDefault();
      }
    }
  });

  /**
   * Ray-cast point-in-polygon test (native coord space).
   * @param {number} x @param {number} y @param {number[][]} poly
   * @returns {boolean}
   */
  function isPointInPolygon(x, y, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * If (x,y) is outside poly, pull it toward the centroid until inside.
   * Works in native polygon coordinate space.
   * @param {number} x @param {number} y @param {number[][]} poly
   * @returns {number[]} [cx, cy] guaranteed inside poly
   */
  function clampToPolygon(x, y, poly) {
    if (isPointInPolygon(x, y, poly)) return [x, y];
    // Compute centroid
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p[0]; cy += p[1]; }
    cx /= poly.length; cy /= poly.length;
    // Step from (x,y) toward centroid in increments
    const steps = 40;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const tx = x + (cx - x) * t;
      const ty = y + (cy - y) * t;
      if (isPointInPolygon(tx, ty, poly)) return [tx, ty];
    }
    return [cx, cy];
  }

  /**
   * Clamp (x,y) to the scene/background rectangle in native px — i.e. keep it
   * on-canvas without requiring it to be inside the walkable nav polygon.
   * Used for decor, which is pure scenery and may sit anywhere in the scene
   * (against walls, up high, etc.), unlike buildables which must stay
   * reachable and are clamped with clampToPolygon.
   * @param {number} x @param {number} y
   * @returns {number[]} [cx, cy] clamped to [0,walkableNativeW]x[0,walkableNativeH]
   */
  function clampToSceneBounds(x, y) {
    return [
      Math.max(0, Math.min(walkableNativeW, x)),
      Math.max(0, Math.min(walkableNativeH, y)),
    ];
  }

  /**
   * Map a native-coord point to canvas pixel coords.
   * @param {number} nx @param {number} ny
   * @param {number} bgX @param {number} bgY @param {number} bgW @param {number} bgH
   * @returns {number[]} [canvasX, canvasY]
   */
  function nativeToCanvas(nx, ny, bgX, bgY, bgW, bgH) {
    return [
      bgX + nx * (bgW / walkableNativeW),
      bgY + ny * (bgH / walkableNativeH),
    ];
  }

  /**
   * Pick a random point inside the walkable polygon (rejection sample).
   * @param {number[][]} poly
   * @returns {number[]} [x, y] in native coords
   */
  function randomInsidePoly(poly) {
    // Compute bbox
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    for (let attempts = 0; attempts < 60; attempts++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);
      if (isPointInPolygon(x, y, poly)) return [x, y];
    }
    // Fallback: centroid
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p[0]; cy += p[1]; }
    return [cx / poly.length, cy / poly.length];
  }

  /**
   * 12 preset home slots spread across the floor polygon bounding box
   * in a 3-row diagonal grid layout.
   * Returned as [u,v] fractions (0..1) within the polygon bbox.
   * @type {number[][]}
   */
  const ISO_SLOT_UVS = [
    // Row 0 (back)
    [0.25, 0.15], [0.50, 0.15], [0.75, 0.15],
    // Row 1 (mid)
    [0.15, 0.45], [0.40, 0.45], [0.60, 0.45], [0.85, 0.45],
    // Row 2 (front)
    [0.25, 0.72], [0.50, 0.72], [0.75, 0.72],
    // Extra front
    [0.38, 0.88], [0.62, 0.88],
  ];

  /**
   * Compute a stable native home position for slot index i.
   * Maps ISO_SLOT_UVS fraction into polygon bbox then clamps inside polygon.
   * @param {number} i
   * @param {number[][]} poly
   * @returns {number[]} [nx, ny]
   */
  function isoSlotHome(i, poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const uv = ISO_SLOT_UVS[i % ISO_SLOT_UVS.length];
    const nx = minX + uv[0] * (maxX - minX);
    const ny = minY + uv[1] * (maxY - minY);
    return clampToPolygon(nx, ny, poly);
  }

  /**
   * Deterministic auto-distribute slots for buildable objects, used when a
   * theme's anchor_coord values are all equal/missing (currently always the
   * case — generated anchors are [0.5,0.5]). Offset from ISO_SLOT_UVS's
   * pattern so objects don't visually stack on agent home slots. Up to 13
   * objects fit without wrapping; beyond that the pattern repeats.
   * Returned as [u,v] fractions (0..1) within the polygon bbox.
   * @type {number[][]}
   */
  const OBJECT_SLOT_UVS = [
    [0.12, 0.20], [0.34, 0.10], [0.58, 0.12], [0.82, 0.22],
    [0.10, 0.42], [0.30, 0.55], [0.50, 0.40], [0.70, 0.55], [0.90, 0.42],
    [0.18, 0.78], [0.42, 0.85], [0.62, 0.78], [0.86, 0.85],
  ];

  /**
   * Compute a stable native placement for buildable-object slot index i.
   * Maps OBJECT_SLOT_UVS fraction into polygon bbox then clamps inside polygon.
   * @param {number} i
   * @param {number[][]} poly
   * @returns {number[]} [nx, ny]
   */
  function objectSlotHome(i, poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const uv = OBJECT_SLOT_UVS[i % OBJECT_SLOT_UVS.length];
    const nx = minX + uv[0] * (maxX - minX);
    const ny = minY + uv[1] * (maxY - minY);
    return clampToPolygon(nx, ny, poly);
  }

  /** Wander speed in native px / second. */
  const WANDER_SPEED = 45;
  /** How long (seconds) an agent waits before picking a new wander destination. */
  const WANDER_INTERVAL_MIN = 3;
  const WANDER_INTERVAL_MAX = 8;
  /** Radius (native px) around home for wander destination jitter (active agents). */
  const WANDER_RADIUS = 80;
  /** How close (native px) to destination before agent is considered arrived. */
  const WANDER_ARRIVED_EPS = 3;
  /**
   * Resume-walking threshold (native px), used WITH WANDER_ARRIVED_EPS as a
   * hysteresis band: once an agent is "settled" (arrived), it does not start
   * walking again until pushed out past this larger radius. A bare
   * `dist > WANDER_ARRIVED_EPS` check has no hysteresis, so a tiny per-frame
   * nudge (agent-separation pass, clamp rounding, a shifted build standoff
   * side) that crosses the 3px line flips movement on/off every frame — the
   * rapid position/facing "vibrate" bug. See charEntry.settled below.
   */
  const WANDER_RESUME_EPS = WANDER_ARRIVED_EPS + 6;
  /** Min real per-frame movement (native px) to count as actually moving (not boundary-stuck jitter). */
  const WANDER_STUCK_EPS = 0.25;
  /** Min intended horizontal component (native px) before movement updates facing (deadzone). */
  const WANDER_FACING_NATIVE_EPS = 2;
  /** Min center-to-center native distance kept between non-seated agents. */
  const MIN_AGENT_SEP_NATIVE = 34;
  /** How strongly overlapping agents are pushed apart per frame (0..1, gentle). */
  const AGENT_SEP_STRENGTH = 0.5;

  /**
   * Create a fresh animation state object.
   * @param {string} action
   */
  function createAnimState(action) {
    return { action, frameIndex: 0, direction: 1, elapsed: 0, completed: false };
  }

  /**
   * Create an "object_idle" animation state, optionally carrying a per-object
   * fps/loop override captured from the manifest (objectAnimParams — see
   * decorAnimMap for the equivalent decor pattern). When the object declares
   * no anim_fps, the state carries no fps/loop and advanceObjectAnim falls
   * back to the OBJECT_CLIPS.object_idle defaults. Crate/poof states are
   * never created via this helper, so their timing is always OBJECT_CLIPS-driven.
   * @param {string} objId
   */
  function createObjectIdleAnimState(objId) {
    const s = createAnimState("object_idle");
    const p = objectAnimParams[objId];
    if (p) {
      s.fps = p.fps;
      s.loop = p.loop;
    }
    return s;
  }

  /**
   * Advance an animation state by deltaSeconds; mirrors animationPlayback.ts logic.
   * @param {{action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}} s
   * @param {number} delta
   */
  function advanceAnim(s, delta) {
    const clip = ATLAS_CLIPS[s.action] || ATLAS_CLIPS.idle;
    if (clip.hold || clip.frames.length <= 1 || clip.fps <= 0) {
      s.frameIndex = 0;
      return;
    }
    if (s.completed || !Number.isFinite(delta) || delta <= 0) return;
    s.elapsed += delta;
    const dur = 1 / clip.fps;
    while (s.elapsed >= dur && !s.completed) {
      s.elapsed -= dur;
      const n = clip.frames.length;
      if (clip.pingpong) {
        s.frameIndex += s.direction;
        if (s.frameIndex >= n - 1) {
          s.frameIndex = n - 1;
          if (clip.loop) s.direction = -1; else s.completed = true;
        } else if (s.frameIndex <= 0) {
          s.frameIndex = 0;
          s.direction = 1;
        }
      } else {
        s.frameIndex += 1;
        if (s.frameIndex >= n) {
          if (clip.loop) s.frameIndex = 0;
          else { s.frameIndex = n - 1; s.completed = true; }
        }
      }
    }
  }

  /**
   * Return the atlas slot index for the current frame of an animation state.
   * @param {{action:string, frameIndex:number}} s
   */
  function currentSlot(s) {
    const clip = ATLAS_CLIPS[s.action] || ATLAS_CLIPS.idle;
    return clip.frames[Math.min(s.frameIndex, clip.frames.length - 1)];
  }

  /**
   * Advance an object animation state by deltaSeconds, using OBJECT_CLIPS
   * instead of ATLAS_CLIPS. Mirrors advanceAnim's logic exactly so behavior
   * stays consistent (loop/hold/pingpong/completed semantics).
   * @param {{action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}} s
   * @param {number} delta
   */
  function advanceObjectAnim(s, delta) {
    const clip = OBJECT_CLIPS[s.action] || OBJECT_CLIPS.object_idle;
    // Only the object_idle clip is per-object overridable (crate/poof always
    // use their fixed OBJECT_CLIPS timing). createObjectIdleAnimState stashes
    // fps/loop onto idle states when the manifest declares anim_fps for that
    // object — mirrors decorAnimMap/advanceDecorAnim's per-decor override.
    const hasOverride = s.action === "object_idle" && typeof s.fps === "number";
    const fps = hasOverride ? s.fps : clip.fps;
    const loop = hasOverride ? s.loop !== false : clip.loop;
    if (clip.hold || clip.frames.length <= 1 || fps <= 0) {
      s.frameIndex = 0;
      return;
    }
    if (s.completed || !Number.isFinite(delta) || delta <= 0) return;
    s.elapsed += delta;
    const dur = 1 / fps;
    while (s.elapsed >= dur && !s.completed) {
      s.elapsed -= dur;
      const n = clip.frames.length;
      if (clip.pingpong) {
        s.frameIndex += s.direction;
        if (s.frameIndex >= n - 1) {
          s.frameIndex = n - 1;
          if (loop) s.direction = -1; else s.completed = true;
        } else if (s.frameIndex <= 0) {
          s.frameIndex = 0;
          s.direction = 1;
        }
      } else {
        s.frameIndex += 1;
        if (s.frameIndex >= n) {
          if (loop) s.frameIndex = 0;
          else { s.frameIndex = n - 1; s.completed = true; }
        }
      }
    }
  }

  /**
   * Return the OBJECT_CLIPS slot index for the current frame of an object
   * animation state.
   * @param {{action:string, frameIndex:number}} s
   */
  function currentObjectSlot(s) {
    const clip = OBJECT_CLIPS[s.action] || OBJECT_CLIPS.object_idle;
    return clip.frames[Math.min(s.frameIndex, clip.frames.length - 1)];
  }

  /**
   * Advance an ENEMY (rival) animation state by deltaSeconds, using RIVAL_CLIPS
   * instead of ATLAS_CLIPS. Mirrors advanceAnim's logic exactly (loop/hold/
   * pingpong/completed semantics) but over the compact 5-frame rival clip set.
   * Enemy action is only ever "walk" or "attack".
   * @param {{action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}} s
   * @param {number} delta
   */
  function advanceRivalAnim(s, delta) {
    const clip = RIVAL_CLIPS[s.action] || RIVAL_CLIPS.walk;
    if (clip.hold || clip.frames.length <= 1 || clip.fps <= 0) {
      s.frameIndex = 0;
      return;
    }
    if (s.completed || !Number.isFinite(delta) || delta <= 0) return;
    s.elapsed += delta;
    const dur = 1 / clip.fps;
    while (s.elapsed >= dur && !s.completed) {
      s.elapsed -= dur;
      const n = clip.frames.length;
      if (clip.pingpong) {
        s.frameIndex += s.direction;
        if (s.frameIndex >= n - 1) {
          s.frameIndex = n - 1;
          if (clip.loop) s.direction = -1; else s.completed = true;
        } else if (s.frameIndex <= 0) {
          s.frameIndex = 0;
          s.direction = 1;
        }
      } else {
        s.frameIndex += 1;
        if (s.frameIndex >= n) {
          if (clip.loop) s.frameIndex = 0;
          else { s.frameIndex = n - 1; s.completed = true; }
        }
      }
    }
  }

  /**
   * Return the RIVAL_CLIPS frame index (0-4) for the current frame of an enemy
   * animation state. Clamps to the clip's own length.
   * @param {{action:string, frameIndex:number}} s
   */
  function currentRivalSlot(s) {
    const clip = RIVAL_CLIPS[s.action] || RIVAL_CLIPS.walk;
    return clip.frames[Math.min(s.frameIndex, clip.frames.length - 1)];
  }

  /**
   * Advance an animated-decor state by deltaSeconds. Decor uses its own fps/loop
   * (captured per-decor from the manifest) over a fixed 4-frame cycle. Static
   * decor (no anim_fps) never enters here. Never throws on bad input.
   * @param {{frameIndex:number, elapsed:number, direction:number, completed:boolean, fps:number, loop:boolean}} s
   * @param {number} delta
   * @param {number} frameCount number of available frames for this decor
   */
  function advanceDecorAnim(s, delta, frameCount) {
    const n = Math.max(1, frameCount);
    if (n <= 1 || !s || s.fps <= 0) { if (s) s.frameIndex = 0; return; }
    if (s.completed || !Number.isFinite(delta) || delta <= 0) return;
    s.elapsed += delta;
    const dur = 1 / s.fps;
    while (s.elapsed >= dur && !s.completed) {
      s.elapsed -= dur;
      s.frameIndex += 1;
      if (s.frameIndex >= n) {
        if (s.loop) s.frameIndex = 0;
        else { s.frameIndex = n - 1; s.completed = true; }
      }
    }
  }

  // (drawPlaceholderTile removed: manifest entries with missing frames now
  // render nothing — the theme health check is the "needs art" surface.)

  /**
   * Draw one buildable object at canvas point (cx, cy) using its current
   * objectAnimMap phase. Mirrors the agent draw pattern (foot-anchored,
   * depth-scaled). Draws nothing when art is missing/still decoding, and
   * never throws on missing art.
   * @param {object} obj buildable object manifest entry (object_id, ...)
   * @param {{phase:string, animState:object|null, progress:number}} entry per-object runtime state
   * @param {number} cx @param {number} cy canvas coords (object anchor, ground point)
   * @param {number} depthScale
   */
  function drawBuildableObject(obj, entry, cx, cy, depthScale) {
    // Normally hidden until it becomes the active build target; in Edit Stage
    // mode, unbuilt objects fall through and are drawn as idle final art below
    // (no crate/progress-bar) so per-object scaling/position is visible.
    if (entry.phase === "unbuilt" && !editStageMode) return;

    const objId = obj.object_id;
    const baseSize = Math.round(64 * depthScale * effectiveObjScale(objId));
    // The pre-build CRATE has ONE constant default size, unaffected by the
    // target object's PER-OBJECT scale override (Stage Editor per-object
    // scales go up to 3x — without this split, a crate at a heavily-scaled
    // site would balloon/shrink to match the object it's about to become).
    // depthScale/sceneFitScale (folded into depthScale by the caller) stay —
    // those are spatial correctness, not per-object styling. The GLOBAL
    // "Object scale" slider (themeObjectScale) still applies: it's treated
    // the same as every other global scale knob (theme-wide, not per-site),
    // so a user dialing all objects up/down plausibly wants crates to follow
    // suit. Only the per-object override is dropped from the crate's size.
    const crateSize = Math.round(64 * depthScale * themeObjectScale);

    if (entry.phase === "active") {
      const crateSlots = themeImages.crate;
      const crateImg = entry.animState && crateSlots ? crateSlots[currentObjectSlot(entry.animState)] : null;
      if (!crateImg || !crateImg.complete || crateImg.naturalWidth === 0) {
        // Crate art missing or still decoding — draw NOTHING (no placeholder
        // tile, no floating progress bar); the crate pops in on its first
        // ready frame. Still-decoding art keeps the boot loader opaque.
        if (crateImg && !crateImg.complete) bootFrameSpritePending = true;
        return;
      }
      ctx.drawImage(crateImg, cx - crateSize / 2, cy - crateSize, crateSize, crateSize);
      // Change 2: progress/health bar for the ACTIVE crate — since the build
      // queue guarantees exactly one active object at a time, this bar is
      // always visible while building. Clamp barY so it never clips off the
      // top of the canvas (e.g. tall objects near the top of the stage).
      // Sized off crateSize (matches the crate actually drawn above), not
      // the per-object baseSize.
      const barW = Math.max(24, crateSize * 0.9);
      const barH = 6;
      const barX = cx - barW / 2;
      const barY = Math.max(2, cy - crateSize - 14);
      ctx.save();
      // Background track.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(barX, barY, barW, barH);
      // Filled portion (entry.progress, 0..1).
      ctx.fillStyle = "#ffc107";
      ctx.fillRect(barX, barY, barW * Math.max(0, Math.min(1, entry.progress)), barH);
      ctx.strokeStyle = "rgba(255,255,255,0.65)";
      ctx.lineWidth = 1;
      ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
      ctx.restore();
      return;
    }

    if (entry.phase === "poof") {
      const poofSlots = themeImages.poof;
      const poofImg = entry.animState && poofSlots ? poofSlots[currentObjectSlot(entry.animState)] : null;
      if (poofImg && poofImg.complete && poofImg.naturalWidth > 0) {
        ctx.drawImage(poofImg, cx - baseSize / 2, cy - baseSize, baseSize, baseSize);
        return;
      }
      // No poof art — fall through to drawing the finished object immediately.
    }

    if (entry.phase === "poof" || entry.phase === "idle" || (entry.phase === "unbuilt" && editStageMode)) {
      const objSlots = themeImages["object_" + objId];
      const slotIdx = entry.animState ? currentObjectSlot(entry.animState) : 0;
      // v3 object pipeline: every STATIC object (board 1's 16 + board 2's 3)
      // loads ONE frame (objSlots.length === 1), but object_idle's clip still
      // cycles slotIdx 0..3 — without the modulo, objSlots[1..3] are
      // undefined and the object flickers to nothing 3 frames out of 4.
      // Board 2's 2 ANIMATED objects load 4 frames, so slotIdx % 4 is a
      // no-op there.
      const objImg = (objSlots && objSlots.length) ? objSlots[slotIdx % objSlots.length] : null;
      if (objImg && objImg.complete && objImg.naturalWidth > 0) {
        if (themeObjFlipOverrides && themeObjFlipOverrides[objId]) {
          // Same mirror pattern as drawDecor/character flip: translate to the
          // right edge of the target box, scale(-1,1), then draw with local
          // x=0 so the mirrored sprite lands in the identical on-screen box
          // (flip is around the sprite's own vertical centerline, not cx).
          ctx.save();
          ctx.translate(cx + baseSize / 2, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(objImg, 0, cy - baseSize, baseSize, baseSize);
          ctx.restore();
        } else {
          ctx.drawImage(objImg, cx - baseSize / 2, cy - baseSize, baseSize, baseSize);
        }
      } else if (objImg && !objImg.complete) {
        // Object art still decoding — draw nothing (pops in when ready) and
        // keep the boot loader opaque. Permanently missing art also renders
        // nothing (the theme health check flags it).
        bootFrameSpritePending = true;
      }
    }

    // Cosmetic damage-smoke overlay (Phase 1): draw AFTER the object's normal
    // art for ANY object with a live smoke entry, regardless of phase. Only
    // built (idle-phase) objects ever accrue a smoke entry, so this runs at the
    // function tail where those objects land. Fully guarded — never throws.
    try { drawObjectSmoke(objId, cx, cy, baseSize, ctx); } catch (e) {}
  }

  /**
   * Cosmetic damage-smoke bookkeeping (Phase 1). Once per frame, AFTER enemy
   * targeting is resolved and buildState is derived, but BEFORE the object draw
   * pass. Ramps a smoke column on any BUILT object currently being raided by a
   * live, non-fleeing rival, and fades it back out when the attack stops.
   * NOTE: buildState is local to render(), so the built-id Set is passed in as
   * `builtIds` (the real in-scope name is buildState.builtIds at the call site).
   * Reads activeEnemies (en.targetKind/targetObjId/fleeing) — the same signal
   * the raid-targeting code uses — but mutates nothing outside objectSmoke.
   * @param {number} delta seconds since last frame
   * @param {Set<string>} builtIds fully-built object ids (buildState.builtIds)
   */
  function updateObjectSmoke(delta, builtIds) {
    try {
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      // Perf early-out: with no active enemies (nothing new can start
      // smoking) and no existing smoke entries (nothing left to fade), the
      // whole function is a no-op — skip the per-frame Set/Object.keys work
      // below. A `for...in` presence check avoids allocating an array just to
      // test emptiness. Still runs whenever smoke exists (to fade it) or
      // enemies are present (to spawn/ramp it).
      if (!Array.isArray(activeEnemies) || activeEnemies.length === 0) {
        let hasSmoke = false;
        for (const _oid in objectSmoke) { hasSmoke = true; break; }
        if (!hasSmoke) return;
      }
      // 1. Built objIds engaged by a live, non-fleeing rival (same signal as
      //    the raid-targeting block: targetKind === 'object' + truthy
      //    targetObjId + not fleeing + membership in the already-built set).
      const engaged = new Set();
      if (builtIds && builtIds.size > 0 && Array.isArray(activeEnemies)) {
        for (const en of activeEnemies) {
          if (!en || en.fleeing) continue;
          if (en.targetKind !== "object") continue;
          const oid = en.targetObjId;
          if (!oid || !builtIds.has(oid)) continue;
          engaged.add(oid);
        }
      }
      // 2. Under-attack objects: accumulate, then ramp intensity toward 1 once
      //    past the delay. Lazily create the entry on first engaged frame. Once
      //    the delay is crossed the object becomes PERSISTENTLY `damaged`:
      //    intensity latches to 1 and stops ramping (no visual need to keep
      //    animating it upward — it's already fully smoking).
      for (const oid of engaged) {
        let s = objectSmoke[oid];
        if (!s) s = objectSmoke[oid] = { underAttack: 0, intensity: 0, anim: 0, damaged: false, extinguishProgress: 0 };
        s.underAttack += delta;
        if (s.underAttack >= SMOKE_ATTACK_DELAY) {
          if (!s.damaged) s.damaged = true;
          s.intensity = 1;
        }
        s.anim += delta; // 4. advance the rising loop
      }
      // 3. Not under attack this frame: a `damaged` object stays smoking
      //    PERSISTENTLY (no auto-decay/delete) until a repair completes in
      //    updateExtinguishProgress — only its rising-loop anim still advances.
      //    Undamaged objects (attack stopped before the delay elapsed) still
      //    fade out and delete as before.
      for (const oid of Object.keys(objectSmoke)) {
        if (engaged.has(oid)) continue;
        const s = objectSmoke[oid];
        if (!s) { delete objectSmoke[oid]; continue; }
        s.underAttack = 0;
        if (s.damaged) {
          s.intensity = 1;      // held — repair (updateExtinguishProgress) is the only way to clear this
          s.anim += delta;      // keep the column rising while it waits for repair
          continue;
        }
        s.intensity -= delta / SMOKE_FADEOUT;
        if (s.intensity <= 0) { delete objectSmoke[oid]; continue; }
        s.anim += delta; // keep the column rising while it fades out
      }
    } catch (e) { /* cosmetic only — never let smoke bookkeeping throw */ }
  }

  /**
   * Draw the cosmetic smoke column for one object, reusing the poof sprite as a
   * rising, fading, looped puff stack anchored just above the object top. Fully
   * guarded so one bad frame (missing poof art, no entry) can never throw inside
   * render(). Coordinate convention matches drawBuildableObject's poof draw:
   * the object spans (cy - baseSize) .. cy, so smoke sits above cy - baseSize.
   * @param {string} objId
   * @param {number} cx @param {number} cy object anchor (ground point), canvas px
   * @param {number} baseSize object draw size in canvas px
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawObjectSmoke(objId, cx, cy, baseSize, ctx) {
    try {
      const s = objectSmoke[objId];
      if (!s || s.intensity <= 0) return;
      const poof = OBJECT_CLIPS.poof;
      const poofSlots = themeImages.poof;
      if (!poof || !poof.frames || !poof.frames.length) return;
      if (!poofSlots || !poofSlots.length) return;
      const frames = poof.frames;
      const fi = ((Math.floor(s.anim * poof.fps) % frames.length) + frames.length) % frames.length;
      const poofImg = poofSlots[frames[fi]]; // same slot lookup as the poof draw (~drawBuildableObject)
      if (!poofImg || !poofImg.complete || poofImg.naturalWidth === 0) return;
      const size = baseSize * SMOKE_SCALE;
      if (!(size > 0)) return;
      // Rise reads on-screen when scaled by the object's on-screen size
      // (baseSize/64 ≈ depthScale·objScale), so distant objects smoke smaller.
      const riseScale = baseSize / 64;
      for (let i = 0; i < SMOKE_PUFFS; i++) {
        const phase = ((s.anim / SMOKE_CYCLE) + i / SMOKE_PUFFS) % 1; // 0..1 rising progress
        const riseY = phase * SMOKE_RISE_NATIVE * riseScale;
        const alpha = SMOKE_MAX_ALPHA * (1 - phase) * s.intensity;    // fade as it rises + overall intensity
        if (alpha <= 0) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        // Emission point is the object's visual CENTER (cy - baseSize/2), not
        // its top edge: offset by half the puff sprite so the puff is
        // vertically centered there before riseY animates it drifting upward.
        ctx.drawImage(poofImg, cx - size / 2, cy - baseSize / 2 - size / 2 - riseY, size, size);
        ctx.restore();
      }
    } catch (e) { /* cosmetic only — one bad frame must not break render() */ }
  }

  /**
   * Extinguish assignment pre-pass (Phase 2). Once per frame, AFTER
   * updateObjectSmoke and BEFORE the character movement loop. Routes idle,
   * eligible characters to smoking objects that still "need" extinguishing,
   * capped at EXTINGUISH_MAX_ASSIGN per object. Reads charEntry.extinguishEligible
   * (published by the movement loop last frame — a 1-frame lag is fine for a
   * cosmetic effect) and charEntry.nx/ny; writes only charEntry.extinguishTargetId.
   * Fully guarded — never throws.
   */
  function assignExtinguishers() {
    try {
      // 1. Smoking objects that still need work (have a known placement).
      const needy = new Set();
      for (const oid in objectSmoke) {
        const s = objectSmoke[oid];
        if (s && s.intensity >= EXTINGUISH_SMOKE_MIN && objectPlacement[oid]) needy.add(oid);
      }
      // 2. Release stale assignments; track which ring-slot indices survivors
      //    already occupy per object, so a newly-assigned repairer never gets
      //    handed the same stand spot as one already en route/arrived there.
      const occupiedIdx = {};
      for (const aid in agentCharMap) {
        const ce = agentCharMap[aid];
        if (!ce) continue;
        const tid = ce.extinguishTargetId;
        if (tid == null) continue;
        if (!needy.has(tid) || ce.extinguishEligible === false) {
          ce.extinguishTargetId = null;
          ce.extinguishStandIdx = -1;
          continue;
        }
        if (!occupiedIdx[tid]) occupiedIdx[tid] = new Set();
        if (typeof ce.extinguishStandIdx === "number" && ce.extinguishStandIdx >= 0) {
          occupiedIdx[tid].add(ce.extinguishStandIdx);
        }
      }
      // 3. Fill each needy object up to capacity with nearest unassigned eligible
      //    chars, handing each new assignee the lowest free ring-slot index
      //    (0..EXTINGUISH_MAX_ASSIGN-1). The movement loop turns this index into
      //    a distinct stand position around the object (see the extinguish-
      //    destination block below), so repairers spread out instead of piling
      //    on the exact same point.
      for (const oid of needy) {
        const p = objectPlacement[oid];
        if (!p) continue;
        const used = occupiedIdx[oid] || (occupiedIdx[oid] = new Set());
        while (used.size < EXTINGUISH_MAX_ASSIGN) {
          let bestId = null, bestDist = Infinity;
          for (const aid in agentCharMap) {
            const ce = agentCharMap[aid];
            if (!ce) continue;
            if (ce.extinguishTargetId != null) continue;
            if (ce.extinguishEligible === false) continue;
            if (typeof ce.nx !== "number" || typeof ce.ny !== "number") continue;
            const dx = p.nx - ce.nx, dy = p.ny - ce.ny;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestId = aid; }
          }
          if (bestId == null) break;
          let idx = 0;
          while (used.has(idx)) idx++;
          agentCharMap[bestId].extinguishTargetId = oid;
          agentCharMap[bestId].extinguishStandIdx = idx;
          used.add(idx);
        }
      }
    } catch (e) { /* cosmetic only — never let extinguish assignment throw */ }
  }

  /**
   * Extinguish progress accrual (Phase 2). Once per frame, AFTER the character
   * movement loop (positions settled). Tallies ARRIVED, non-fighting characters
   * per smoking object; more characters extinguish faster. On completion the
   * object's smoke is force-cleared (entry deleted) and its characters released.
   * Combat always wins: a character fighting a rival (combatTargetInstanceId set)
   * does not count. Fully guarded — never throws.
   * @param {number} delta seconds since last frame
   */
  function updateExtinguishProgress(delta) {
    try {
      if (!Number.isFinite(delta) || delta < 0) delta = 0;
      // 1. Active extinguishers per objId: arrived AND not fighting a rival.
      const active = {};
      for (const aid in agentCharMap) {
        const ce = agentCharMap[aid];
        if (!ce) continue;
        const tid = ce.extinguishTargetId;
        if (tid == null) continue;
        if (ce.combatTargetInstanceId) continue; // peeled off to fight a rival
        const p = objectPlacement[tid];
        if (!p) continue;
        if (typeof ce.nx !== "number" || typeof ce.ny !== "number") continue;
        // Measure against THIS repairer's own ring stand spot (set by the
        // movement loop this same frame), not the raw object center — with
        // distinct per-slot stand positions, arrival is per-spot.
        const tx = (typeof ce.extinguishStandNx === "number") ? ce.extinguishStandNx : p.nx;
        const ty = (typeof ce.extinguishStandNy === "number") ? ce.extinguishStandNy : p.ny;
        const dx = tx - ce.nx, dy = ty - ce.ny;
        if (Math.sqrt(dx * dx + dy * dy) > EXTINGUISH_ARRIVE_EPS) continue;
        active[tid] = (active[tid] || 0) + 1;
      }
      // 2. Accrue for objects with >=1 active repairer; force-clear on complete.
      //    Duration is recomputed EVERY frame from the CURRENT count of arrived,
      //    non-combat repairers (`k`, tallied fresh above), so progress rescales
      //    live as characters join/leave: dur = max(REPAIR_MIN, REPAIR_BASE / k).
      //    Floored at REPAIR_MIN regardless of k — never faster than 1s.
      for (const oid in objectSmoke) {
        const s = objectSmoke[oid];
        if (!s) continue;
        const k = active[oid] || 0;
        if (k < 1) continue; // no accrual with zero repairers (progress holds)
        const dur = Math.max(REPAIR_MIN, REPAIR_BASE / k);
        s.extinguishProgress = (s.extinguishProgress || 0) + delta / dur;
        if (s.extinguishProgress >= 1) {
          // Repair complete: clear the persistent damage flag and remove the
          // smoke entry entirely; release every assigned character.
          s.damaged = false;
          s.intensity = 0;
          s.underAttack = 0;
          s.extinguishProgress = 0;
          for (const aid in agentCharMap) {
            const ce = agentCharMap[aid];
            if (ce && ce.extinguishTargetId === oid) ce.extinguishTargetId = null;
          }
          delete objectSmoke[oid]; // updateObjectSmoke recreates (undamaged) on re-attack
        }
      }
    } catch (e) { /* cosmetic only — never let extinguish accrual throw */ }
  }

  /**
   * Draw one background-decor sprite, foot-anchored at canvas point (cx, cy)
   * and depth-scaled like buildable objects. Static decor uses frame 0;
   * animated decor uses its per-decor anim frame. Skips gracefully (no draw,
   * no throw) when the decor's frames are missing.
   * @param {object} decor decor manifest entry (decor_id, ...)
   * @param {number} cx @param {number} cy canvas coords (decor anchor, ground point)
   * @param {number} depthScale
   */
  function drawDecor(decor, cx, cy, depthScale) {
    const decorId = decor.decor_id;
    if (decorId == null) return;
    const slots = themeImages["decor_" + decorId];
    const baseSize = Math.round(64 * depthScale * effectiveDecorScale(decorId));
    // Missing art entirely: draw nothing (no placeholder tile) — the theme
    // health check flags decor that still needs art generated.
    if (!slots || slots.length === 0) return;
    const anim = decorAnimMap[decorId];
    let slotIdx = 0;
    if (anim) slotIdx = Math.min(anim.frameIndex, slots.length - 1);
    const img = slots[slotIdx] || slots[0];
    if (!img || !img.complete || img.naturalWidth === 0) {
      // Still-decoding decor keeps the boot loader opaque; it pops in when
      // ready. Errored art (complete, naturalWidth 0) never holds the loader.
      if (img && !img.complete) bootFrameSpritePending = true;
      return;
    }
    const flipped = !!(themeDecorFlipOverrides && themeDecorFlipOverrides[decorId]);
    if (flipped) {
      // Same mirror pattern as the character draw: translate to the right
      // edge of the target box, scale(-1,1), then draw with local x=0 so the
      // mirrored sprite lands in the identical on-screen box.
      ctx.save();
      ctx.translate(cx + baseSize / 2, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, cy - baseSize, baseSize, baseSize);
      ctx.restore();
    } else {
      ctx.drawImage(img, cx - baseSize / 2, cy - baseSize, baseSize, baseSize);
    }
  }

  /**
   * Map a worker state string to an ATLAS_CLIPS action name.
   * @param {string} workerState
   */
  function workerStateToClip(workerState) {
    switch (workerState) {
      case "walk":
      case "arrive":   return "walk";
      case "build":
      case "haul":     return "build";
      case "survey":   return "tool_idle";
      case "celebrate":return "cheer";
      case "leave":    return "walk";
      default:         return "idle";
    }
  }

  // ── Magenta de-fringe (load-time cleanup for EXISTING themes) ─────────
  // Frames ship as transparent PNGs (background keyed out at slice time), but a
  // residual MAGENTA/PINK HALO can remain on anti-aliased sprite edges the
  // slicer's threshold missed. We strip only the boundary halo: opaque pixels
  // that are magenta-dominant AND touch an already-transparent pixel. This is
  // an edge-flood, so interior legit magenta/purple/skin colors are untouched.
  // Runs ONCE per frame at theme load (not per-frame in render), on an
  // offscreen canvas, and always yields a normal fully-loaded HTMLImageElement
  // (so existing .complete/.naturalWidth/drawImage usage stays valid).

  // Cap to avoid pathological getImageData cost on oversized frames.
  const DEFRINGE_MAX_DIM = 1024;
  const DEFRINGE_ITERATIONS = 3;

  /** @param {number} r @param {number} g @param {number} b */
  function isMagentaDominant(r, g, b) {
    // Catch the pink/magenta halo (high R & B, suppressed G) while sparing
    // normal skin/red/purple: require green clearly below both R and B, and
    // R/B reasonably balanced (a true magenta, not a pure red or pure blue).
    return g < r - 40 && g < b - 40 && r > 110 && b > 110 && Math.abs(r - b) < 110;
  }

  /**
   * Given a fully-loaded raw Image, return a cleaned data-URL with the magenta
   * edge-fringe removed. Returns null on any failure (caller keeps the raw img).
   * @param {HTMLImageElement} rawImg
   * @returns {string | null}
   */
  function defringeImageToDataURL(rawImg) {
    try {
      const w = rawImg.naturalWidth;
      const h = rawImg.naturalHeight;
      if (!w || !h || w > DEFRINGE_MAX_DIM || h > DEFRINGE_MAX_DIM) return null;
      const cvs = document.createElement("canvas");
      cvs.width = w;
      cvs.height = h;
      const octx = cvs.getContext("2d");
      if (!octx) return null;
      octx.drawImage(rawImg, 0, 0, w, h);
      // getImageData on a same-origin data-URI won't taint the canvas.
      const imgData = octx.getImageData(0, 0, w, h);
      const data = imgData.data;
      let changedAny = false;
      // GLOBAL strong-chroma pass FIRST: kill EVERY pixel matching the slicer's
      // strong isChromaMagenta test — including ENCLOSED background gaps (between
      // legs/arms) that never touch a transparent edge, so the edge-adjacency
      // flood below could never reach them. The strong test spares legit
      // pink/purple/skin art (only near-pure keyed magenta qualifies).
      for (let gi = 0; gi < data.length; gi += 4) {
        if (data[gi + 3] === 0) continue; // already transparent
        const r = data[gi], g = data[gi + 1], b = data[gi + 2];
        if (r >= 180 && b >= 180 && g <= 90 && (r - g) >= 120 && (b - g) >= 120 && Math.abs(r - b) <= 80) {
          data[gi + 3] = 0;
          changedAny = true;
        }
      }
      for (let iter = 0; iter < DEFRINGE_ITERATIONS; iter++) {
        // Collect pixels to clear this pass, then apply — so newly-cleared
        // pixels only expand the boundary on the NEXT iteration (stable flood).
        const toClear = [];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (data[i + 3] === 0) continue; // already transparent
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (!isMagentaDominant(r, g, b)) continue;
            // Adjacent (8-neighbour) to any already-transparent pixel?
            let touchesTransparent = false;
            for (let dy = -1; dy <= 1 && !touchesTransparent; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                if (data[(ny * w + nx) * 4 + 3] === 0) { touchesTransparent = true; break; }
              }
            }
            if (touchesTransparent) toClear.push(i);
          }
        }
        if (toClear.length === 0) break;
        for (let k = 0; k < toClear.length; k++) data[toClear[k] + 3] = 0;
        changedAny = true;
      }
      if (!changedAny) return null; // nothing to clean; keep the raw image
      octx.putImageData(imgData, 0, 0);
      return cvs.toDataURL("image/png");
    } catch (_err) {
      return null; // never crash the load path; caller falls back to raw
    }
  }

  /**
   * Load a single sprite frame, de-fringing it once loaded. Returns an Image
   * placeholder immediately (kept in themeImages); if cleanup succeeds we swap
   * its src to the cleaned data-URL so the STORED drawable stays a normal,
   * fully-loaded HTMLImageElement. On any failure we keep the raw frame.
   * @param {string} src
   * @returns {HTMLImageElement}
   */
  function loadDefringedFrame(src) {
    const stored = new Image();
    const raw = new Image();
    raw.onload = () => {
      const cleanedUrl = defringeImageToDataURL(raw);
      // Assigning src (raw or cleaned) fires stored.onload → stays "complete".
      stored.src = cleanedUrl || src;
    };
    raw.onerror = () => { stored.src = src; }; // fall back to the raw frame
    raw.src = src;
    return stored;
  }

  /**
   * Preload all character sprite images from raw frames data.
   * @param {Record<string, string[]>} rawFrames
   */
  function preloadThemeImages(rawFrames) {
    themeImages = {};
    themeBackgroundImg = null;
    // NOTE: environment_background is a full scene (not a chroma sprite), so it
    // is NEVER de-fringed — load it verbatim.
    const bgFrames = rawFrames["environment_background"];
    if (bgFrames && bgFrames[0]) {
      const bgImg = new Image();
      const onBgSettled = () => bootLoaderSetProgress(75, "Preparing scene…");
      bgImg.onload = onBgSettled;
      bgImg.onerror = onBgSettled; // don't let a bad image stall the boot loader
      bgImg.src = bgFrames[0];
      themeBackgroundImg = bgImg;
    }
    for (const [charId, slots] of Object.entries(rawFrames)) {
      if (charId === "environment_background") continue;
      // All sprite frame keys (agents, rivals, objects, decor, crate, poof)
      // get the magenta edge-defringe.
      themeImages[charId] = slots.map((src) => loadDefringedFrame(src));
    }
  }

  /** @type {{ sessionActive: boolean; workers: Record<string, { id: string; role?: string; state: string }>; completedTasks: number }} */
  let state = { sessionActive: false, workers: {}, completedTasks: 0 };
  let idleFreezeMs = 180000, sanityCapMs = 900000;

  // ── Single source of truth for "is this agent active?" ───────────────
  // Both the agent-metrics panel and the canvas character scene MUST use
  // this exact helper so the two views can never diverge. It mirrors
  // idleFreezeMs (sourced from state.idleFreezeMs, default 180000ms/180s)
  // so a freshly-reassigned threshold is honored everywhere immediately.
  function isMetricsAgentActive(agent) {
    const status = ((agent && agent.status) || "idle").toLowerCase();
    if (status !== "active") return false;
    const frozen = (agent.lastActivityAt != null) && (Date.now() - agent.lastActivityAt > idleFreezeMs);
    return !frozen;
  }

  // Stable insertion-order tracking so x positions don't jump
  /** @type {string[]} */
  const workerOrder = [];

  let frame = 0;
  let lastFrameTime = 0;
  // Set true the frame we skip work while hidden; render() checks this on the
  // next visible frame to reset the delta baseline instead of clamping a
  // (still-huge, but now safely small) jump computed from a stale timestamp.
  let wasHiddenLastFrame = false;

  // Pre-rendered active-agent glow dots (perf: change 3). shadowBlur rasterizes
  // a blur live on every draw call; instead we bake the blurred dot once per
  // distinct (quantized) radius into an offscreen canvas and drawImage it each
  // frame. Keyed by radius since depthScale (camera-distance perspective)
  // makes the dot size vary continuously per agent — see getActiveGlowCanvas.
  /** @type {Map<number, {canvas: HTMLCanvasElement, pad: number}>} */
  const activeGlowCache = new Map();
  const ACTIVE_GLOW_COLOR = "#39ff14";
  const ACTIVE_GLOW_BLUR = 5;
  /**
   * Return an offscreen canvas containing the active-indicator glow dot
   * pre-rendered with the exact same shadowColor/shadowBlur/fillStyle as the
   * original live-drawn dot, sized with enough padding that the blur is never
   * clipped. Cached per quantized radius so it is computed once and reused.
   * @param {number} radius
   */
  function getActiveGlowCanvas(radius) {
    const key = Math.round(radius * 10) / 10; // 0.1px buckets — visually identical to live draw
    let entry = activeGlowCache.get(key);
    if (entry) return entry;
    const pad = Math.ceil(key + ACTIVE_GLOW_BLUR * 2 + 2);
    const size = pad * 2;
    const off = document.createElement("canvas");
    off.width = size;
    off.height = size;
    const octx = off.getContext("2d");
    octx.save();
    octx.shadowColor = ACTIVE_GLOW_COLOR;
    octx.shadowBlur = ACTIVE_GLOW_BLUR;
    octx.fillStyle = ACTIVE_GLOW_COLOR;
    octx.beginPath();
    octx.arc(pad, pad, key, 0, Math.PI * 2);
    octx.fill();
    octx.restore();
    entry = { canvas: off, pad: pad };
    activeGlowCache.set(key, entry);
    return entry;
  }

  // ── Rebirth confetti particle system ──────────────────────────────────────
  // Populated by spawnConfetti() (fired from the Rebirth celebration) and
  // advanced/drawn each frame by updateAndDrawConfetti() near the END of the
  // render loop so particles land on top of the scene. Empty array ⇒ no-op.
  /** @type {Array<{x:number,y:number,vx:number,vy:number,g:number,rot:number,vrot:number,size:number,color:string,ttl:number,life:number}>} */
  let confettiParticles = [];
  const CONFETTI_PALETTE = ["#ffc107", "#ffd76a", "#ffffff", "#39ff14", "#ff5da2", "#4fc3ff"];

  /**
   * Burst a fresh set of confetti from the top of the canvas.
   * @param {number} [count]
   */
  function spawnConfetti(count) {
    const n = (typeof count === "number" && count > 0) ? count : 140;
    const w = (canvas && canvas.width) || 533;
    for (let i = 0; i < n; i++) {
      const ttl = 150 + Math.floor(Math.random() * 60); // ~2.5–3.5s @ 60fps
      confettiParticles.push({
        x: Math.random() * w,
        y: -10 - Math.random() * 40,
        vx: (Math.random() - 0.5) * 3.2,
        vy: 1.5 + Math.random() * 3.0,
        g: 0.05 + Math.random() * 0.04,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.35,
        size: 4 + Math.random() * 5,
        color: CONFETTI_PALETTE[(Math.random() * CONFETTI_PALETTE.length) | 0],
        ttl: ttl,
        life: ttl,
      });
    }
  }

  /**
   * Advance + draw confetti in canvas pixel space (same space the scene uses:
   * 0..canvas.width, 0..canvas.height). Cheap no-op when the array is empty.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} h  canvas height (for off-screen culling)
   */
  function updateAndDrawConfetti(ctx, h) {
    if (!confettiParticles.length) return;
    const bottom = (typeof h === "number" ? h : ((canvas && canvas.height) || 751)) + 20;
    for (let i = confettiParticles.length - 1; i >= 0; i--) {
      const p = confettiParticles[i];
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      p.ttl--;
      if (p.ttl <= 0 || p.y > bottom) {
        confettiParticles.splice(i, 1);
        continue;
      }
      const fade = p.ttl < 40 ? Math.max(0, p.ttl / 40) : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
  }

  function resize() {
    // Keep the canvas backing-store resolution in lockstep with its CSS
    // display size. If they drift, the browser stretches the rendered bitmap
    // (distorting the fixed-size background) and the layout math (bgX/bgY,
    // nativeToCanvas, nav-poly) computes against the wrong w/h.
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw <= 0 || ch <= 0) return; // not laid out yet; skip until it is
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
  }

  window.addEventListener("resize", resize);
  // The metrics handlebar resizes the #stage container WITHOUT firing a window
  // 'resize' event, so observe the canvas element directly to catch those drags
  // (and the initial layout settling) and re-sync the backing store.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  }
  resize();

  // Tell the extension we're ready; it will push the current state back
  themeLoadStartTs = nowMs(); // begin the stage-loading window
  vscode.postMessage({ type: "ready" });

  // Initial state: keep the setup overlay up until we hear back about install
  // status, so we never flash the live view before knowing the hook exists.
  // Don't hide the boot loader here — this is a transient "unknown yet"
  // default (about to be replaced by showMain() once checkInstall/theme
  // load resolve), not real onboarding taking over the panel.
  showSetup({ hideBootLoader: false });
  setupStatusEl.textContent = "Checking installation…";
  installHooksBtn.setAttribute("hidden", "");
  setupErrorEl.setAttribute("hidden", "");
  setupConfigEl.setAttribute("hidden", "");
  setupBackBtn.setAttribute("hidden", "");
  vscode.postMessage({ type: "checkInstall" });

  // Ask the host for current engine connection status immediately.
  vscode.postMessage({ type: "getEngineStatus" });

  // Ask the host for the optional Project Plan state. No-ops on the host
  // side (PLAN_STATE comes back with enabled:false, plan:null) when the
  // feature isn't turned on or there's no workspace.
  vscode.postMessage({ type: "REQUEST_PLAN" });

  // ── Engine connection chips (upper-left overlay) ─────────────────

  const engineChipsEl = document.createElement("div");
  engineChipsEl.id = "engine-chips";
  engineChipsEl.setAttribute("hidden", "");
  // Append into #stage-area so it shares the same positioning context.
  const stageAreaEl = document.getElementById("stage-area");
  if (stageAreaEl) {
    stageAreaEl.appendChild(engineChipsEl);
  }

  // Dot visual per chip state:
  //  connected  - live MCP probe succeeded: green glow (existing)
  //  configured - stdio MCP entry present, unprobed: solid green, no glow
  //  ready      - pack/skill installed, no MCP configured: neutral/blue dot
  //  offline    - MCP configured but probe failed/timed out: amber (existing)
  //  setup      - project detected, nothing installed: gray
  var ENGINE_CHIP_STATE_CLASS = {
    connected: "engine-chip-dot--connected",
    configured: "engine-chip-dot--configured",
    ready: "engine-chip-dot--ready",
    offline: "engine-chip-dot--offline",
    setup: "engine-chip-dot--setup",
  };

  /**
   * Rebuild the engine chip row from a chips array.
   * @param {Array<{id:string, label:string, state:"connected"|"configured"|"ready"|"offline"|"setup", detail:string}>} chips
   */
  function renderEngineChips(chips) {
    // Remove all existing chips
    while (engineChipsEl.firstChild) {
      engineChipsEl.removeChild(engineChipsEl.firstChild);
    }

    if (!chips || chips.length === 0) {
      engineChipsEl.setAttribute("hidden", "");
      return;
    }

    engineChipsEl.removeAttribute("hidden");

    for (const chip of chips) {
      const pill = document.createElement("div");
      pill.className = "engine-chip";
      if (chip.detail) {
        pill.title = chip.detail;
      }

      const dot = document.createElement("span");
      var stateClass = ENGINE_CHIP_STATE_CLASS[chip.state] || "engine-chip-dot--setup";
      dot.className = "engine-chip-dot " + stateClass;

      const label = document.createElement("span");
      label.className = "engine-chip-label";
      label.textContent = chip.label;

      pill.appendChild(dot);
      pill.appendChild(label);
      engineChipsEl.appendChild(pill);
    }
  }

  /** Skill catalog ids offered as pre-install-optional chips. "unreal-engine"
   *  is the real media/skills/catalog.json id; engine DETECTION (engineChips
   *  from computeEngineChips) reports it as "unreal" — normalized below. */
  var SETUP_SKILL_CHIPS = [
    { id: "playwright", label: "Playwright" },
    { id: "godot", label: "Godot" },
    { id: "unity", label: "Unity" },
    { id: "unreal-engine", label: "Unreal Engine" },
    { id: "uefn", label: "UEFN" },
  ];

  /**
   * Remove the Step-2 Optionals wizard's DOM (both card halves, the UEFN
   * card, and the "already set up" confirmation line) if still mounted.
   * Called before navigating to Settings — via the hamburger menu's
   * Settings item or the wizard's own "Advanced tuning" link — so the
   * wizard doesn't stay visibly stacked on top of the Settings panel
   * underneath (#setup-config lives in the same #setup-card container).
   * A no-op if the wizard was never rendered this session.
   */
  function removeSetupOptionalsNodes() {
    ["setup-optionals-top", "setup-optionals-bottom", "uefn-prompt-card", "uefn-bridge-setup-confirm"].forEach(
      function (id) {
        const el = document.getElementById(id);
        if (el) el.remove();
      }
    );
  }

  /**
   * Render Setup Wizard Step 2 (Optionals) inside #setup-card, once hooks
   * finish installing. Stays mounted (does NOT call showMain()) until the
   * user clicks "Done - set up a theme". Idempotent: removes/rebuilds its
   * own two card halves each call so a repeated installState push doesn't
   * duplicate anything.
   *
   * Renders in two pieces (top: confirmation/gitignore/skill chips, bottom:
   * advanced-tuning link/Done button) with the UEFN card (renderUefnPrompt)
   * appended between them, so DOM order matches the wizard spec regardless
   * of whether UEFN is detected: confirmation -> optional gitignore ->
   * skill chips -> [UEFN card] -> advanced link -> Done.
   *
   * @param {{engineChips?: Array<{id:string,label:string,state:string,detail:string}>, uefnDetected?: boolean, uefnSignals?: string[], foreignManagedBlocks?: Array<{namespace:string,lines:number}>}} info
   */
  function renderSetupOptionals(info) {
    const setupCard = document.getElementById("setup-card");
    if (!setupCard) return;

    const existingTop = document.getElementById("setup-optionals-top");
    if (existingTop) existingTop.remove();
    const existingBottom = document.getElementById("setup-optionals-bottom");
    if (existingBottom) existingBottom.remove();

    // ── Top half: confirmation, gitignore checkbox, skill chips ──────
    const top = document.createElement("div");
    top.id = "setup-optionals-top";
    top.className = "setup-optionals-card";

    const confirmEl = document.createElement("p");
    confirmEl.className = "setup-optionals-confirm";
    confirmEl.textContent = "Hooks installed ✓";
    top.appendChild(confirmEl);

    const optionalHeading = document.createElement("div");
    optionalHeading.className = "setup-optionals-heading";
    optionalHeading.textContent = "Optional setup";
    top.appendChild(optionalHeading);

    const gitignoreLabel = document.createElement("label");
    gitignoreLabel.className = "setup-optionals-checkbox-row";
    const gitignoreCheckbox = document.createElement("input");
    gitignoreCheckbox.type = "checkbox";
    gitignoreCheckbox.id = "setup-gitignore-checkbox";
    // Opt-in only, unchecked by default (explicit user decision).
    gitignoreCheckbox.checked = false;
    gitignoreLabel.appendChild(gitignoreCheckbox);
    const gitignoreText = document.createElement("span");
    // Project-neutral label: the host writes .gitignore always, and also
    // .p4ignore on a detected UEFN/Perforce project (see panel.ts
    // _handleAddGitignoreEntries) since Perforce never reads .gitignore.
    gitignoreText.textContent =
      info && info.uefnDetected
        ? "Add tycoon logs to ignore file (.gitignore + .p4ignore for UEFN/Perforce)"
        : "Add tycoon logs to ignore file";
    gitignoreLabel.appendChild(gitignoreText);
    top.appendChild(gitignoreLabel);

    // ── Legacy/foreign managed CLAUDE.md block removal (opt-in, safe) ──
    // One row per detected non-tycoon managed block — a
    // `<!-- <ns>:begin -->...<!-- <ns>:end -->` region that is either
    // legacy config carried over from a prior setup (another Claude Code
    // project's generator, or a previous plugin) or a currently-installed
    // other tool's own block (see panel.ts _handleCheckInstall /
    // legacyDoctrine.ts detectForeignManagedBlocks). Each Remove button IS
    // the user's confirm for THAT namespace — the host never auto-deletes
    // any of these.
    const wizardForeignBlocks = info && Array.isArray(info.foreignManagedBlocks) ? info.foreignManagedBlocks : [];
    wizardForeignBlocks.forEach(function (block) {
      const ns = block.namespace;
      const legacyRow = document.createElement("div");
      legacyRow.id = "setup-managed-block-row-" + ns;
      legacyRow.className = "setup-optionals-checkbox-row";
      const legacyBtn = document.createElement("button");
      legacyBtn.id = "setup-remove-managed-block-btn-" + ns;
      legacyBtn.className = "skill-btn";
      const lineNote = typeof block.lines === "number" && block.lines > 0 ? " (" + block.lines + " lines)" : "";
      legacyBtn.textContent = "Remove legacy config block `" + ns + ":*`" + lineNote + " from CLAUDE.md";
      legacyBtn.addEventListener("click", function () {
        legacyBtn.setAttribute("disabled", "");
        legacyBtn.textContent = "Removing…";
        managedBlockRemovalRequested.add(ns);
        vscode.postMessage({ type: "removeManagedBlock", namespace: ns });
      });
      legacyRow.appendChild(legacyBtn);
      top.appendChild(legacyRow);
    });
    managedBlockRemovalRequested.forEach(function (ns) {
      const stillPresent = wizardForeignBlocks.some(function (b) {
        return b.namespace === ns;
      });
      if (!stillPresent) {
        const legacyConfirm = document.createElement("p");
        legacyConfirm.id = "setup-managed-block-confirm-" + ns;
        legacyConfirm.className = "setup-optionals-confirm";
        legacyConfirm.textContent = "✓ Removed legacy config block `" + ns + ":*`";
        top.appendChild(legacyConfirm);
      }
    });

    const skillsHeading = document.createElement("div");
    skillsHeading.className = "setup-optionals-heading";
    skillsHeading.textContent = "Skills & packages";
    top.appendChild(skillsHeading);

    const chipsRow = document.createElement("div");
    chipsRow.id = "setup-skill-chips";
    chipsRow.className = "setup-skill-chips";

    var detectedIds = {};
    var chips = (info && info.engineChips) || [];
    for (var ci = 0; ci < chips.length; ci++) {
      var cid = chips[ci].id === "unreal" ? "unreal-engine" : chips[ci].id;
      detectedIds[cid] = true;
    }
    if (info && info.uefnDetected) detectedIds["uefn"] = true;

    SETUP_SKILL_CHIPS.forEach(function (def) {
      const pill = document.createElement("div");
      pill.className = "engine-chip setup-skill-chip";
      pill.dataset.skillChipId = def.id;
      pill.title = def.label;

      const dot = document.createElement("span");
      dot.className = "engine-chip-dot engine-chip-dot--setup";

      const label = document.createElement("span");
      label.className = "engine-chip-label";
      label.textContent = def.label;

      pill.appendChild(dot);
      pill.appendChild(label);
      if (detectedIds[def.id]) {
        pill.classList.add("setup-skill-chip--checked");
      }
      // Selection state only — installed on "Done", not on click.
      pill.addEventListener("click", function () {
        pill.classList.toggle("setup-skill-chip--checked");
      });
      chipsRow.appendChild(pill);
    });
    top.appendChild(chipsRow);

    setupCard.appendChild(top);

    // ── UEFN card / already-set-up confirmation, appended between the two
    //    halves so it lands after the skill chips and before the advanced
    //    link/Done button. The outer installState handler skips its own
    //    renderUefnPrompt call whenever this optionals path just ran (see
    //    the "installState" message handler) so it's never rendered twice.
    const existingUefnConfirm = document.getElementById("uefn-bridge-setup-confirm");
    if (existingUefnConfirm) existingUefnConfirm.remove();
    if (info && info.uefnDetected) {
      if (info.uefnBridgeSetUp) {
        // UEFN setup already ran (the .mcp.json uefn-bridge entry is
        // present) — show a static confirmation instead of the redundant
        // "Yes, set up UEFN" button.
        const existingUefnCard = document.getElementById("uefn-prompt-card");
        if (existingUefnCard) existingUefnCard.remove();
        const confirm = document.createElement("p");
        confirm.id = "uefn-bridge-setup-confirm";
        confirm.className = "setup-optionals-confirm";
        confirm.textContent = "✓ UEFN bridge already set up";
        setupCard.appendChild(confirm);
      } else {
        renderUefnPrompt(info.uefnSignals || []);
      }
    } else {
      const existingUefnCard = document.getElementById("uefn-prompt-card");
      if (existingUefnCard) existingUefnCard.remove();
    }

    // ── Bottom half: advanced-tuning link, Done button ───────────────
    const bottom = document.createElement("div");
    bottom.id = "setup-optionals-bottom";
    bottom.className = "setup-optionals-card";

    const advancedLink = document.createElement("a");
    advancedLink.href = "#";
    advancedLink.className = "setup-optionals-advanced-link";
    advancedLink.textContent = "Advanced tuning (models, keyword routing, plan, design docs) lives in Settings →";
    advancedLink.addEventListener("click", function (e) {
      e.preventDefault();
      closeMenu();
      // Leaving the wizard for Settings — remove the Step-2 Optionals nodes
      // (this card, its sibling half, and the UEFN card/confirmation) so
      // they don't stay visibly stacked on top of the Settings panel.
      removeSetupOptionalsNodes();
      // The user has moved past the wizard by choosing this link; mark it
      // done so a later stray installState push (e.g. after Back) goes
      // straight to showMain() instead of re-rendering the wizard.
      setupStage = "done";
      openedFromSettings = true;
      showSetup();
      vscode.postMessage({ type: "checkInstall" });
      vscode.postMessage({ type: "getSettings" });
    });
    bottom.appendChild(advancedLink);

    // Explicit finalize gate: the ONLY way the wizard leaves the setup
    // screen after "Install hooks". The user must review/select the
    // optionals above (gitignore, UEFN card, skill chips) and then click
    // this button on purpose — there is no auto-dismiss on install.
    const continueBtn = document.createElement("button");
    continueBtn.id = "setup-optionals-done-btn";
    continueBtn.className = "skill-btn setup-optionals-continue-btn";
    continueBtn.textContent = "Continue to TycoonAgents";
    continueBtn.addEventListener("click", function () {
      const checkedChips = chipsRow.querySelectorAll(".setup-skill-chip--checked");
      checkedChips.forEach(function (el) {
        const id = el.dataset.skillChipId;
        if (id) vscode.postMessage({ type: "installSkill", id });
      });
      if (gitignoreCheckbox.checked) {
        vscode.postMessage({ type: "addGitignoreEntries" });
      }
      setupStage = "done";
      showMain();
      themePickerList.removeAttribute("hidden");
      themeBuilderPanel.setAttribute("hidden", "");
      openModal(themesModalEl, themesModalCloseBtn);
      vscode.postMessage({ type: "LIST_THEMES" });
    });
    bottom.appendChild(continueBtn);

    setupCard.appendChild(bottom);
  }

  /**
   * Render the UEFN project detected card inside #setup-card.
   * Called when checkInstall response carries uefnDetected:true.
   * @param {string[]} signals
   */
  function renderUefnPrompt(signals) {
    // Remove any existing card first (idempotent)
    const existing = document.getElementById("uefn-prompt-card");
    if (existing) existing.remove();

    const setupCard = document.getElementById("setup-card");
    if (!setupCard) return;

    const card = document.createElement("div");
    card.id = "uefn-prompt-card";
    card.className = "uefn-prompt-card";

    const heading = document.createElement("h2");
    heading.className = "uefn-prompt-heading";
    heading.textContent = "UEFN project detected";
    card.appendChild(heading);

    const body = document.createElement("p");
    body.className = "uefn-prompt-body";
    body.id = "uefn-prompt-body";
    body.textContent = "This looks like a UEFN project. Set up the Verse Expert and Auditor agents and stage the UEFN bridge (uefn_bridge.py into Content/Python)?";
    card.appendChild(body);

    const btnRow = document.createElement("div");
    btnRow.className = "uefn-prompt-btns";

    const yesBtn = document.createElement("button");
    yesBtn.className = "skill-btn";
    yesBtn.id = "uefn-yes-btn";
    yesBtn.textContent = "Yes, set up UEFN";
    yesBtn.addEventListener("click", function () {
      yesBtn.setAttribute("disabled", "");
      notNowBtn.setAttribute("disabled", "");
      body.textContent = "Setting up…";
      vscode.postMessage({ type: "setupUefnProject" });
    });

    const notNowBtn = document.createElement("button");
    notNowBtn.className = "skill-btn";
    notNowBtn.id = "uefn-notnow-btn";
    notNowBtn.textContent = "Not now";
    notNowBtn.addEventListener("click", function () {
      card.remove();
    });

    btnRow.appendChild(yesBtn);
    btnRow.appendChild(notNowBtn);
    card.appendChild(btnRow);

    setupCard.appendChild(card);
  }

  /**
   * Handle the uefnSetupDone message from the host.
   * @param {{ok:boolean, results?:{pack:string, bridge:"staged"|"exists", engineFound?:boolean, locations?:Array<{label:string,dir:string,staged:number,updated:number,unchanged:number,error?:string}>}, error?:string}} msg
   */
  function handleUefnSetupDone(msg) {
    const card = document.getElementById("uefn-prompt-card");
    if (!card) return;
    const body = document.getElementById("uefn-prompt-body");
    const btns = card.querySelector(".uefn-prompt-btns");
    if (btns) btns.remove();
    if (msg.ok && msg.results) {
      const r = msg.results;
      const lines = [];
      lines.push("UEFN setup complete:");
      lines.push("Agents: Verse Expert + Auditor installed");
      lines.push("Skill: uefn");
      lines.push("MCP: uefn-bridge");
      if (r.locations && r.locations.length) {
        lines.push("Bridge staged to:");
        r.locations.forEach(function (loc) {
          if (loc.error) {
            lines.push("  " + loc.label + " (write failed): " + loc.error);
          } else {
            lines.push(
              "  " + loc.label + ": " + loc.staged + " new, " + loc.updated + " updated, " + loc.unchanged + " unchanged"
            );
          }
        });
        if (r.engineFound === false) {
          lines.push("  ⚠ Fortnite engine Python dir not found — tools may not load until copied there.");
        }
      } else {
        lines.push("Content/Python (bridge + tools): " + r.bridge);
      }
      if (body) body.textContent = lines.join("\n");
    } else {
      if (body) body.textContent = "Setup failed: " + (msg.error || "unknown error");
    }
  }

  window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    const msg = event.data;
    if (msg && msg.type === "THEME_IMAGE_SETTINGS") {
      const payload = msg.payload || {};
      if (payload.error) {
        if (themeApiKeySave) {
          themeApiKeySave.removeAttribute("disabled");
          themeApiKeySave.textContent = "Save";
        }
        updateThemeApiKeyUi("Could not save the API key: " + payload.error, true);
      } else {
        themeImageSettingsLoaded = true;
        themeProviderConfigured = {
          gemini: Boolean(payload.providers?.gemini?.configured),
          openai: Boolean(payload.providers?.openai?.configured),
        };
        if (themeImageProvider && (payload.provider === "gemini" || payload.provider === "openai")) {
          themeImageProvider.value = payload.provider;
        }
        if (themeApiKeyInput) themeApiKeyInput.value = "";
        if (themeApiKeySave) {
          themeApiKeySave.removeAttribute("disabled");
          themeApiKeySave.textContent = "Save";
        }
        updateThemeApiKeyUi(payload.saved ? "API key settings saved securely." : "", false);
      }
    } else if (msg && msg.type === "THEMES_LIST") {
      lastThemesList = msg.payload?.themes || msg.themes || [];
      renderThemesList(lastThemesList);
      if (themePickerStatus) {
        const deleteError = msg.payload?.delete_error;
        themePickerStatus.textContent = deleteError
          ? "Could not delete theme: " + deleteError
          : msg.payload?.deleted_theme_id
            ? "Theme deleted."
            : "";
        themePickerStatus.classList.toggle("theme-picker-status--error", Boolean(deleteError));
      }
    } else if (msg && msg.type === "THEME_EXPORT_RESULT") {
      const payload = msg.payload || {};
      const exportButton = themePickerGrid?.querySelector(`[data-theme-export-id="${payload.theme_id || ""}"]`);
      if (exportButton) exportButton.disabled = exportButton.dataset.exportReady !== "true";
      if (themePickerStatus) {
        themePickerStatus.textContent = payload.error
          ? "Could not export theme: " + payload.error
          : payload.cancelled
            ? ""
            : `${payload.display_name || "Theme"} exported.`;
        themePickerStatus.classList.toggle("theme-picker-status--error", Boolean(payload.error));
      }
    } else if (msg && msg.type === "BOARD_REGENERATED") {
      // Fired from a theme-review card's Regenerate button. The review isn't
      // guaranteed to still be open/rendered when this arrives, so every DOM
      // lookup below is optional and this no-ops gracefully if the card is gone.
      const payload = msg.payload || {};
      const regenItemId = payload.item_id;
      if (regenItemId) themeBoardRegenBusyItems.delete(regenItemId);
      const regenCard = regenItemId && themeImageReviewList
        ? themeImageReviewList.querySelector(`[data-item-id="${regenItemId}"]`)
        : null;
      if (regenCard) {
        const regenBtn = /** @type {HTMLButtonElement|null} */ (regenCard.querySelector(".theme-review-regenerate"));
        const regenStatus = /** @type {HTMLElement|null} */ (regenCard.querySelector(".theme-review-regen-status"));
        if (regenBtn) {
          regenBtn.disabled = false;
          regenBtn.textContent = "Regenerate";
        }
        if (regenStatus) {
          regenStatus.textContent = payload.ok
            ? `✓ ${payload.board || "Board"} board regenerated`
            : `⚠ Regen failed: ${payload.error || "Unknown error"}`;
          regenStatus.classList.toggle("theme-review-regen-status--error", !payload.ok);
        }
      }
      // On success the host re-posts THEME_IMAGE_REVIEW, which re-renders this
      // card with the fresh art — no SELECT_THEME re-post needed here.
    } else if (msg && msg.type === "THEME_IMPORT_RESULT") {
      const payload = msg.payload || {};
      if (themeImportBtn) themeImportBtn.disabled = false;
      if (themePickerStatus) {
        themePickerStatus.textContent = payload.error
          ? "Could not import theme: " + payload.error
          : payload.cancelled
            ? ""
            : `${payload.display_name || "Theme"} ${payload.replaced ? "replaced" : "imported"}.`;
        themePickerStatus.classList.toggle("theme-picker-status--error", Boolean(payload.error));
      }
    } else if (msg && msg.type === "THEME_APPROVE_ALL_RESULT") {
      const payload = msg.payload || {};
      if (themeApproveAll) {
        themeApproveAll.disabled = false;
        themeApproveAll.textContent = "Approve all";
      }
      if (themeImageReviewSummary && payload.error) {
        themeImageReviewSummary.textContent = "Could not approve all: " + payload.error;
        themeImageReviewSummary.classList.add("theme-review-error");
      }
    } else if (msg && msg.type === "THEME_HEALTH_CHECK_RESULT") {
      renderThemeHealthResult(msg.payload || {});
    } else if (msg && msg.type === "THEME_PLAN_READY") {
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      renderThemePlan(msg.payload?.plan || {});
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Review and edit the AI-filled slots, then generate the images.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
    } else if (msg && msg.type === "THEME_PLAN_ERROR") {
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Error: " + (msg.payload?.message || "Theme planning failed.");
        themeBuildStatus.style.color = "var(--vscode-errorForeground)";
      }
    } else if (msg && msg.type === "THEME_GENERATION_PROGRESS") {
      if (themeBuildStatus) {
        themeBuildStatus.textContent = msg.payload?.message || msg.message || "Working...";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
    } else if (msg && msg.type === "THEME_REVIEW_READY") {
      const readyThemeId = msg.payload?.theme_id;
      if (readyThemeId) {
        reviewThemeId = readyThemeId;
        if (themeBuildActions) themeBuildActions.removeAttribute("hidden");
        showThemeImageReview(readyThemeId);
      }
    } else if (msg && msg.type === "THEME_IMAGE_REVIEW") {
      if (msg.payload?.theme_id) reviewThemeId = msg.payload.theme_id;
      renderThemeImageReview(msg.payload || {});
    } else if (msg && (msg.type === "THEME_IMAGE_RETRY_STATE"
        || msg.type === "THEME_CHARACTER_RENAME_STATE"
        || msg.type === "THEME_CHARACTER_NORMALIZE_STATE")) {
      const itemId = msg.payload?.item_id;
      if (itemId) {
        if (msg.payload?.busy) {
          themeReviewBusyItems.set(itemId, msg.type === "THEME_IMAGE_RETRY_STATE"
            ? "retry"
            : msg.type === "THEME_CHARACTER_RENAME_STATE"
              ? "rename"
              : "normalize");
        } else {
          themeReviewBusyItems.delete(itemId);
        }
        // Sticky: only ever set from a message that actually carries a
        // warning. Progress/completion messages with no warning field must
        // not clear it — the notice should survive the whole retry cycle.
        if (msg.type === "THEME_IMAGE_RETRY_STATE" && msg.payload?.warning) {
          themeReviewRetryWarnings.set(itemId, msg.payload.warning);
        }
      }
      const cards = themeImageReviewList ? themeImageReviewList.querySelectorAll("[data-item-id]") : [];
      for (const card of cards) {
        if (card.getAttribute("data-item-id") !== itemId) continue;
        const retryBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-retry"));
        const resliceBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-reslice"));
        const renameBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-rename"));
        const normalizeBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-normalize"));
        const nameInput = /** @type {HTMLInputElement|null} */ (card.querySelector(".theme-review-name-input"));
        const acceptBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-accept"));
        const statusEl = /** @type {HTMLElement|null} */ (card.querySelector(".theme-review-retry-status"));
        const warningEl = /** @type {HTMLElement|null} */ (card.querySelector(".theme-review-retry-warning"));
        if (warningEl && msg.type === "THEME_IMAGE_RETRY_STATE") {
          const warningText = themeReviewRetryWarnings.get(itemId) || "";
          warningEl.textContent = warningText;
          warningEl.hidden = !warningText;
        }
        if (acceptBtn) acceptBtn.disabled = Boolean(msg.payload?.busy);
        if (retryBtn && msg.type === "THEME_IMAGE_RETRY_STATE") {
          retryBtn.disabled = Boolean(msg.payload?.busy);
          retryBtn.textContent = msg.payload?.busy
            ? "Generating..."
            : retryBtn.dataset.idleText || "Retry image";
        }
        if (resliceBtn && msg.type === "THEME_IMAGE_RETRY_STATE") {
          resliceBtn.disabled = Boolean(msg.payload?.busy);
          resliceBtn.textContent = msg.payload?.busy
            ? "Re-slicing…"
            : resliceBtn.dataset.idleText || "Re-slice";
        }
        if (normalizeBtn && msg.type === "THEME_CHARACTER_NORMALIZE_STATE") {
          normalizeBtn.disabled = Boolean(msg.payload?.busy);
          normalizeBtn.textContent = msg.payload?.busy
            ? "Regenerating..."
            : normalizeBtn.dataset.idleText || "Normalize size";
        }
        if (renameBtn && msg.type === "THEME_CHARACTER_RENAME_STATE") {
          renameBtn.disabled = Boolean(msg.payload?.busy) || !msg.payload?.error;
          renameBtn.textContent = msg.payload?.busy ? "Saving..." : "Save name";
        }
        if (nameInput && msg.type === "THEME_CHARACTER_RENAME_STATE") {
          nameInput.disabled = Boolean(msg.payload?.busy);
        }
        if (statusEl) {
          statusEl.textContent = msg.payload?.error || msg.payload?.message || "";
          statusEl.classList.toggle("theme-review-error", Boolean(msg.payload?.error));
        }
      }
    } else if (msg && msg.type === "THEME_GENERATION_ERROR") {
      themeGenerationRunning = false;
      themeGenerationStopping = false;
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Error: " + (msg.payload?.message || msg.message || "Unknown error");
        themeBuildStatus.style.color = "var(--vscode-errorForeground)";
      }
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeStartGenerationBtn) {
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Generate images";
      }
      if (themeReviewStopGeneration) themeReviewStopGeneration.hidden = true;
    } else if (msg && msg.type === "THEME_GENERATION_CANCELLED") {
      themeGenerationRunning = false;
      themeGenerationStopping = false;
      const cancelledThemeId = msg.payload?.theme_id;
      if (cancelledThemeId) {
        reviewThemeId = cancelledThemeId;
        if (themeBuildActions) themeBuildActions.removeAttribute("hidden");
      }
      if (themeBuildStatus) {
        themeBuildStatus.textContent = msg.payload?.message || "Generation stopped.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeStartGenerationBtn) {
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Generate images";
      }
      if (themeReviewStopGeneration) themeReviewStopGeneration.hidden = true;
    } else if (msg && msg.type === "THEME_INITIALIZED") {
      // A theme is definitively arriving — clear any earlier no-theme verdict
      // (a transient THEME_NONE, or the stage-loading window having timed out
      // before the host answered). Without this reset, a stale noThemeSignaled
      // forced loadingActive false for the WHOLE incoming load, disabling the
      // loading-bar suppression and completing the boot loader instantly. If
      // that stale verdict already completed the overlay moments ago, revive
      // it at full opacity so nothing placeholder peeks through.
      noThemeSignaled = false;
      bootThemedFrames = 0;
      bootFirstThemedFrameTs = 0;
      bootLoaderRevive();
      bootLoaderSetProgress(45, "Loading theme…");
      const completedGeneration = themeGenerationRunning;
      themeGenerationRunning = false;
      themeGenerationStopping = false;
      if (themeStartGenerationBtn) {
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Generate images";
      }
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeReviewStopGeneration) themeReviewStopGeneration.hidden = true;
      if (completedGeneration && themeBuildStatus && themeBuildStatus.textContent.indexOf("Error") !== 0) {
        themeBuildStatus.textContent = "Theme generated successfully.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      const initializedThemeId = msg.payload?.manifest?.theme_id;
      if (initializedThemeId) {
        reviewThemeId = initializedThemeId;
        // Track which theme is currently loaded on stage (auto-loaded = selected)
        selectedThemeId = initializedThemeId;
        if (themeBuildActions) themeBuildActions.removeAttribute("hidden");
      }
      // Load theme character sprites for the stage canvas
      if (msg.payload?.frames && typeof msg.payload.frames === "object") {
        themeFramesRaw = msg.payload.frames;
        themeLoadStartTs = nowMs(); // restart the loading window for this theme's frames
        preloadThemeImages(themeFramesRaw);
        themeLoaded = true;
        // Reset per-worker animation/facing states so they start fresh
        workerAnimStates = {};
        agentCharMap = {};
        // Capture walkable floor polygon from manifest (native coord space)
        const vp = msg.payload?.manifest?.viewport;
        const rawPoly = vp && Array.isArray(vp.walkable_nav_polygon) && vp.walkable_nav_polygon.length >= 3
          ? vp.walkable_nav_polygon
          : null;
        if (rawPoly) {
          // The generator stores walkable_nav_polygon as NORMALIZED 0..1
          // fractions of the background, while native_width/height describe the
          // source image (e.g. 1280x720). If we scaled normalized coords by
          // native_width they'd collapse to a ~1px cluster at the image origin
          // (every agent + the nav overlay stacked in the top-left corner).
          // Detect that case and convert the polygon into the SAME canonical
          // native pixel space (533x751) used by the default polygon and the
          // pixel-tuned wander constants, so mapping AND movement both work.
          const cleaned = rawPoly
            .filter((p) => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]))
            .map((p) => [p[0], p[1]]);
          if (cleaned.length < 3) {
            // Degenerate after cleaning — fall back to the default floor.
            walkablePolygon = DEFAULT_WALKABLE_POLY.map((p) => p.slice());
            walkableNativeW = DEFAULT_NATIVE_W;
            walkableNativeH = DEFAULT_NATIVE_H;
          } else {
            const isNormalized = cleaned.every(
              (p) => Math.abs(p[0]) <= 1.5 && Math.abs(p[1]) <= 1.5
            );
            if (isNormalized) {
              walkablePolygon = cleaned.map((p) => [p[0] * DEFAULT_NATIVE_W, p[1] * DEFAULT_NATIVE_H]);
              walkableNativeW = DEFAULT_NATIVE_W;
              walkableNativeH = DEFAULT_NATIVE_H;
            } else {
              walkablePolygon = cleaned;
              walkableNativeW = (vp.native_width && vp.native_width > 0) ? vp.native_width : DEFAULT_NATIVE_W;
              walkableNativeH = (vp.native_height && vp.native_height > 0) ? vp.native_height : DEFAULT_NATIVE_H;
            }
          }
        } else {
          walkablePolygon = DEFAULT_WALKABLE_POLY.map((p) => p.slice());
          walkableNativeW = DEFAULT_NATIVE_W;
          walkableNativeH = DEFAULT_NATIVE_H;
        }
        // Per-theme scale tuning (optional manifest fields; default 1 / empty).
        themeCharacterScale = (vp && typeof vp.character_scale === "number" && vp.character_scale > 0) ? vp.character_scale : 1;
        themeObjectScale = (vp && typeof vp.object_scale === "number" && vp.object_scale > 0) ? vp.object_scale : 1;
        themeOverallScale = (vp && typeof vp.overall_scale === "number" && vp.overall_scale > 0) ? vp.overall_scale : 1;
        themeCharScaleOverrides = (vp && vp.character_scale_overrides && typeof vp.character_scale_overrides === "object") ? vp.character_scale_overrides : {};
        // Per-object overrides are stored on disk as MULTIPLIERS on top of
        // the global "Object scale" slider (see effectiveObjScale — the UI
        // writes them directly as multipliers, neutral/no-override = 1).
        // Load them as-is; do NOT divide by themeObjectScale here — that was
        // a one-time legacy migration for pre-multiplier absolute-scale
        // saves, but running it on every load re-divides the already-correct
        // stored multiplier each time the theme loads, shrinking it toward 0
        // over repeated reloads/updates (the saved value gets written back
        // to disk via saveStageTuning, compounding the shrink).
        {
          const rawObjOverrides = (vp && vp.object_scale_overrides && typeof vp.object_scale_overrides === "object") ? vp.object_scale_overrides : {};
          themeObjScaleOverrides = {};
          for (const k of Object.keys(rawObjOverrides)) {
            const v = rawObjOverrides[k];
            if (typeof v === "number" && v > 0) themeObjScaleOverrides[k] = v;
          }
        }
        themeRivalScale = (vp && typeof vp.rival_scale === "number" && vp.rival_scale > 0) ? vp.rival_scale : 1;
        themeRivalScaleOverrides = (vp && vp.rival_scale_overrides && typeof vp.rival_scale_overrides === "object") ? Object.assign({}, vp.rival_scale_overrides) : {};
        themeDecorScale = (vp && typeof vp.decor_scale === "number" && vp.decor_scale > 0) ? vp.decor_scale : DECOR_SCALE;
        // Per-decor overrides are stored on disk as MULTIPLIERS on top of the
        // global "Decor scale" slider (see effectiveDecorScale — identical
        // rationale to the per-object load just above: load the stored
        // multiplier as-is, do NOT divide by themeDecorScale here, or the
        // already-correct value gets re-divided (and re-saved) on every
        // load, shrinking toward 0 over repeated reloads/updates.
        {
          const rawDecorOverrides = (vp && vp.decor_scale_overrides && typeof vp.decor_scale_overrides === "object") ? vp.decor_scale_overrides : {};
          themeDecorScaleOverrides = {};
          for (const k of Object.keys(rawDecorOverrides)) {
            const v = rawDecorOverrides[k];
            if (typeof v === "number" && v > 0) themeDecorScaleOverrides[k] = v;
          }
        }

        // ── Phase 2a: capture buildable objects + resolve stable placement ──
        const manifest = msg.payload?.manifest;
        themeBuildables = Array.isArray(manifest?.buildable_objects)
          ? manifest.buildable_objects.slice().sort((a, b) => (a.build_order || 0) - (b.build_order || 0))
            // Legacy manifests pad buildable_objects to 21 entries, ~10 of which
            // are art-less PLACEHOLDERS (no generated frames until the object
            // board is regenerated). Drop them from the in-game build queue so
            // they don't build as invisible/empty objects. themeImages is
            // populated synchronously by preloadThemeImages above (the .map at
            // its assignment creates the frame array immediately, only pixels
            // load async), so themeImages["object_<id>"] is a non-empty array
            // for real objects and absent/empty for placeholders by this point.
            // Placeholders stay renameable in the Theme Builder and become
            // buildable automatically once their art is regenerated. If a theme
            // legitimately has ZERO object art yet, the filtered list is empty
            // and the build queue is empty — correct (nothing to build).
            .filter((obj) => (themeImages["object_" + obj.object_id]?.length || 0) > 0)
          : [];
        themeHasCrateAsset = !!(vp && vp.crate_asset);
        themeHasPoofAsset = !!(vp && vp.poof_asset);
        // Per-object idle fps/loop overrides (mirrors decorAnimMap below) —
        // reset every theme load so a previous theme's overrides don't leak.
        objectAnimParams = {};
        themeBuildables.forEach((obj) => {
          if (typeof obj.anim_fps === "number" && obj.anim_fps > 0) {
            objectAnimParams[obj.object_id] = { fps: obj.anim_fps, loop: obj.anim_loop !== false };
          }
        });
        // Reset per-object runtime phase/anim state for the new theme.
        objectAnimMap = {};
        // ── Phase: one-at-a-time paced build queue (Change 1) ──────────
        // Stable random permutation seeded by theme_id — deterministic per
        // theme, doesn't reshuffle on re-render.
        // D3: peek the persisted rebirth count BEFORE building the queue (the
        // full rebirth restore happens further below) so buildQueue already
        // reflects the correct pre/post-first-rebirth composition — the rack
        // must never appear in the queue while rebirthCount is still < 1 (see
        // buildSeededQueue).
        {
          // Scoped to the HOST's per-theme rebirth_state only — a fresh theme's
          // null must never fall back to the webview's local getState() cache
          // (that blob is a separate per-workspace scratch value, no longer
          // written with rebirth data; see persistRebirth's doc comment).
          const _peekedRebirth = msg.payload.rebirth_state || null;
          const _peekedRebirthCount = (_peekedRebirth && typeof _peekedRebirth.count === "number") ? _peekedRebirth.count : 0;
          // D4: also peek the persisted rack-splice index so the rack lands
          // at the SAME stable position it was queued at on the rebirth that
          // introduced it (see buildSeededQueue/doRebirth) rather than being
          // recomputed from the live buildBuiltCount on every reload.
          const _peekedRackInsertIndex = (_peekedRebirth && typeof _peekedRebirth.rackInsertIndex === "number") ? _peekedRebirth.rackInsertIndex : null;
          buildQueue = buildSeededQueue(themeBuildables, initializedThemeId, _peekedRebirthCount, _peekedRackInsertIndex);
        }
        // Restore persisted build progress (host-provided) instead of always
        // starting a fresh reload/update at 0 — clamp to the queue length in
        // case the theme's buildable list shrank since the value was saved.
        {
          const rawSavedProgress = (msg.payload && typeof msg.payload.savedBuildProgress === "number") ? msg.payload.savedBuildProgress : 0;
          buildBuiltCount = Math.max(0, Math.min(buildQueue.length, rawSavedProgress));
        }
        buildCurrentProgress = 0;
        // Reconstruct the visual built state for the restored count: mark the
        // first buildBuiltCount queued objects' anim entries as already-idle
        // (fully built), matching how the per-frame render loop derives BUILT
        // status from buildBuiltCount (see computeBuildState / the per-object
        // status loop). Without this, those objects would lazily transition
        // through their crate/poof build animation on next render instead of
        // appearing already-built.
        for (let i = 0; i < buildBuiltCount && i < buildQueue.length; i++) {
          const objId = buildQueue[i];
          objectAnimMap[objId] = { phase: "idle", animState: createObjectIdleAnimState(objId), progress: 1 };
        }
        // ── Badges (reset per theme) ─────────────────────────────────────
        themeBadges = Array.isArray(manifest?.badges) ? manifest.badges : [];
        rivalsEvictedCount = 0;
        // Seed from the host's persisted per-theme unlocks so previously-earned
        // badges stay unlocked across sessions; only the session counter
        // (rivalsEvictedCount) resets to 0 above — buildBuiltCount is now
        // RESTORED from savedBuildProgress just above, not reset to 0.
        currentBadgeThemeId = initializedThemeId || (manifest && manifest.theme_id) || null;
        const seededUnlockIds = Array.isArray(msg.payload?.unlocked_badge_ids) ? msg.payload.unlocked_badge_ids : [];
        unlockedBadgeIds = new Set(seededUnlockIds);
        // ── Per-badge dots: baseline-then-diff, keyed by currentBadgeThemeId ──
        // First time this theme has ever been loaded (no baseline on record):
        // adopt the freshly-seeded unlocks as the baseline so already-earned
        // badges never retroactively grow a dot; restore any unseen ids saved
        // from a previous session (normally none, on a true first load).
        // Otherwise: restore the persisted baseline/unseen sets, then diff
        // against the freshly-seeded unlockedBadgeIds so anything unlocked
        // while the webview was closed still lights a dot on next open.
        if (currentBadgeThemeId) {
          if (!Object.prototype.hasOwnProperty.call(badgeKnownByTheme, currentBadgeThemeId)) {
            knownBadgeIds = new Set(unlockedBadgeIds);
            const savedUnseen = badgeUnseenByTheme[currentBadgeThemeId];
            unseenBadgeIds = new Set(Array.isArray(savedUnseen) ? savedUnseen : []);
          } else {
            const savedKnown = badgeKnownByTheme[currentBadgeThemeId];
            const savedUnseen = badgeUnseenByTheme[currentBadgeThemeId];
            knownBadgeIds = new Set(Array.isArray(savedKnown) ? savedKnown : []);
            unseenBadgeIds = new Set(Array.isArray(savedUnseen) ? savedUnseen : []);
            for (const id of unlockedBadgeIds) {
              if (!knownBadgeIds.has(id)) unseenBadgeIds.add(id);
            }
            knownBadgeIds = new Set(unlockedBadgeIds);
          }
          badgeKnownByTheme[currentBadgeThemeId] = [...knownBadgeIds];
          badgeUnseenByTheme[currentBadgeThemeId] = [...unseenBadgeIds];
          persistBadgePerBadgeState();
        } else {
          // No theme id available — skip per-badge tracking gracefully rather
          // than tagging dots under a null/undefined key.
          knownBadgeIds = new Set();
          unseenBadgeIds = new Set();
        }
        // ── Rebirth: restore persisted prestige state. Independent of the
        // per-theme badge unlocks above — rebirth (count/baseline/requirement)
        // persists across theme switches and webview reloads. Source of truth
        // is SOLELY the HOST payload (rebirth_state, keyed by theme_id,
        // survives webview disposal) — a fresh theme's null rebirth_state
        // MUST fall through to defaults (savedRebirth = {}), never to the
        // webview's local getState() cache: that cache is a single unscoped
        // per-workspace value, so falling back to it here previously leaked
        // the PREVIOUS theme's rebirth count and unlocked badges into a
        // brand-new theme. persistRebirth() no longer even writes rebirth
        // data into that local cache (see its doc comment).
        const hostRebirth = msg.payload.rebirth_state;
        // savedRebirth is always an object here (hostRebirth's type is
        // RebirthPersist | null host-side; falsy collapses to {}), so there's
        // no remaining branch where it's a non-object — restoration below
        // runs unconditionally. Badges are NOT restored here: unlocked ids
        // come solely from msg.payload.unlocked_badge_ids (seeded above),
        // never from rebirth_state — the host's RebirthPersist shape has no
        // `unlocked` field (see src/host/vscode/panel.ts) and persistRebirth()
        // below never sends one, so a rebirth-side badge fallback would be
        // dead weight that could only reintroduce a leak path.
        const savedRebirth = hostRebirth || {};
        rebirthCount = typeof savedRebirth.count === "number" ? savedRebirth.count : 0;
        if (savedRebirth.baseline && typeof savedRebirth.baseline === "object") {
          rebirthBaseline = {
            built: savedRebirth.baseline.built || 0,
            evicted: savedRebirth.baseline.evicted || 0,
            tasks: savedRebirth.baseline.tasks || 0,
          };
        }
        requiredRebirthBadgeIds = Array.isArray(savedRebirth.required) ? savedRebirth.required.slice() : [];
        // DURABLE per-cycle badge counters: RESTORE (don't reset) so earned-
        // badge progress survives webview reload. Default 0 when absent (old
        // saved state, or a theme with no prior cycle progress).
        cycleObjectsBuilt = typeof savedRebirth.cycleBuilt === "number" ? savedRebirth.cycleBuilt : 0;
        cycleRivalsEvicted = typeof savedRebirth.cycleEvicted === "number" ? savedRebirth.cycleEvicted : 0;
        // D4: restore the rack's persisted queue position and the durable
        // permanent-ranged-unlock flag. Both default to "not yet earned"
        // when absent (legacy saves predating this field).
        rackInsertIndex = typeof savedRebirth.rackInsertIndex === "number" ? savedRebirth.rackInsertIndex : null;
        rangedPermanentlyUnlocked = savedRebirth.rangedUnlocked === true;
        // buildBuiltCount/rivalsEvictedCount just restarted at 0 above for this
        // theme session (they're per-theme-session lifetime counters), so the
        // built/evicted baseline components must restart at 0 too — otherwise a
        // positive baseline carried over from a previous theme/session would
        // make updateBadgeUnlocks()'s effective (eff) value negative, leaving
        // OBJECTS_BUILT/RIVALS_EVICTED badges practically unearnable until
        // re-built past that stale baseline. rebirthBaseline.tasks is NOT reset:
        // state.completedTasks is a global agent-metrics lifetime counter, not
        // per-theme.
        rebirthBaseline.built = 0;
        rebirthBaseline.evicted = 0;
        // requiredRebirthBadgeIds must reference badges that exist in the
        // CURRENT theme's badge set (badge_ids aren't shared across themes),
        // so re-roll whenever it's empty or a saved requirement doesn't
        // resolve against themeBadges (e.g. after switching themes).
        const requiredStillValid = requiredRebirthBadgeIds.length > 0 &&
          requiredRebirthBadgeIds.every((id) => themeBadges.some((b) => b && b.badge_id === id));
        if (!requiredStillValid) rollRebirthRequirement();
        // Persist once here so the just-reset built/evicted baseline (and any
        // re-rolled requirement above) are saved even if the user closes the
        // webview before the next badge unlock or rebirth would otherwise
        // trigger a persistRebirth() call.
        persistRebirth();
        updateBadgeHud();
        // ── Ranged combat upgrade ─────────────────────────────────────────
        // Characters START in melee. Building the ranged weapon rack (the
        // buildable with build_order 0 → themeBuildables[0] after the sort)
        // permanently unlocks ranged combat — and ONLY building it unlocks
        // ranged (see the build-latch near computeBuildState). D3: the rack
        // itself isn't even buildable until rebirthCount>=1 (see
        // buildSeededQueue/doRebirth). D4: once earned, the unlock is
        // PERMANENT across reloads/rebirths (not just "for the session") —
        // seed straight from the restored rangedPermanentlyUnlocked flag
        // above so it's true from boot when previously earned; otherwise
        // start locked and let the per-frame latch (~L11667) re-sync it to
        // true on the very next frame if the restored buildState shows the
        // rack already built (e.g. an older save predating this flag).
        rangedUnlocked = rangedPermanentlyUnlocked;
        rackObjectId = themeBuildables.length > 0 ? themeBuildables[0].object_id : null;
        // Resolve a stable native placement per object. Generated anchor_coord
        // values are currently always [0.5,0.5] (degenerate/equal), so detect
        // that and fall back to the deterministic OBJECT_SLOT_UVS distribution.
        // If a theme ever ships distinct anchors, honor them directly instead.
        // Stage-Editor position overrides (normalized 0..1), loaded from the
        // manifest. Shallow-copied so editor edits don't mutate the manifest.
        themeObjAnchorOverrides = (vp && typeof vp.object_anchor_overrides === "object" && vp.object_anchor_overrides)
          ? Object.assign({}, vp.object_anchor_overrides) : {};
        themeDecorAnchorOverrides = (vp && typeof vp.decor_anchor_overrides === "object" && vp.decor_anchor_overrides)
          ? Object.assign({}, vp.decor_anchor_overrides) : {};
        themeDecorFlipOverrides = (vp && typeof vp.decor_flip_overrides === "object" && vp.decor_flip_overrides)
          ? Object.assign({}, vp.decor_flip_overrides) : {};
        themeObjFlipOverrides = (vp && typeof vp.object_flip_overrides === "object" && vp.object_flip_overrides)
          ? Object.assign({}, vp.object_flip_overrides) : {};
        themeDecorHidden = new Set(
          Array.isArray(vp && vp.decor_hidden) ? vp.decor_hidden.filter((id) => typeof id === "string") : []
        );
        objectPlacement = {};
        objectHomePlacement = {};
        if (themeBuildables.length > 0) {
          const anchors = themeBuildables.map((o) =>
            Array.isArray(o.anchor_coord) && o.anchor_coord.length >= 2
              ? [o.anchor_coord[0], o.anchor_coord[1]]
              : [0.5, 0.5]
          );
          const firstAnchor = anchors[0];
          const allEqual = anchors.every(
            (a) => Math.abs(a[0] - firstAnchor[0]) < 1e-6 && Math.abs(a[1] - firstAnchor[1]) < 1e-6
          );
          themeBuildables.forEach((obj, i) => {
            // Generated ("home") placement — used when no override exists and to
            // revert a Stage-Editor move (right-click).
            let home;
            if (allEqual) {
              home = objectSlotHome(i, walkablePolygon);
            } else {
              const a = anchors[i];
              home = clampToPolygon(a[0] * walkableNativeW, a[1] * walkableNativeH, walkablePolygon);
            }
            objectHomePlacement[obj.object_id] = { nx: home[0], ny: home[1] };
            const ov = themeObjAnchorOverrides[obj.object_id];
            const placed = (Array.isArray(ov) && ov.length >= 2)
              ? clampToPolygon(ov[0] * walkableNativeW, ov[1] * walkableNativeH, walkablePolygon)
              : home;
            objectPlacement[obj.object_id] = { nx: placed[0], ny: placed[1] };
          });
        }

        // ── Background Decor: capture + resolve stable placement + sit-points ──
        // Read manifest.decor_objects (read-only contract). Reset all per-theme
        // decor/seat runtime state so nothing carries over between themes.
        themeDecor = Array.isArray(manifest?.decor_objects) ? manifest.decor_objects.slice() : [];
        decorPlacement = {};
        decorAnimMap = {};
        seatOccupancy = {};
        if (themeDecor.length > 0) {
          const dAnchors = themeDecor.map((d) =>
            Array.isArray(d.anchor_coord) && d.anchor_coord.length >= 2
              ? [d.anchor_coord[0], d.anchor_coord[1]]
              : [0.5, 0.5]
          );
          const firstD = dAnchors[0];
          const dAllEqual = dAnchors.every(
            (a) => Math.abs(a[0] - firstD[0]) < 1e-6 && Math.abs(a[1] - firstD[1]) < 1e-6
          );
          themeDecor.forEach((d, i) => {
            const decorId = d.decor_id;
            if (decorId == null) return;
            // A Stage-Editor position override wins over the declared anchor.
            // The [-1,-1] sentinel means the decor was hidden — skip it entirely
            // (no placement, no render, no seat).
            const dOv = themeDecorAnchorOverrides[decorId];
            if (Array.isArray(dOv) && dOv.length >= 2 && dOv[0] < 0 && dOv[1] < 0) return;
            // Resolve anchor placement: override, else auto-distribute when all
            // anchors are equal/degenerate, else the declared normalized anchor.
            // Decor is pure scenery and isn't required to stay inside the
            // walkable nav polygon (unlike buildables) — only bound it to the
            // scene/background rectangle so it can't resolve off-canvas.
            let placed;
            if (Array.isArray(dOv) && dOv.length >= 2) {
              placed = clampToSceneBounds(dOv[0] * walkableNativeW, dOv[1] * walkableNativeH);
            } else if (dAllEqual) {
              // Offset the slot index so decor doesn't stack on buildable objects.
              placed = objectSlotHome(i + 3, walkablePolygon);
            } else {
              const a = dAnchors[i];
              placed = clampToSceneBounds(a[0] * walkableNativeW, a[1] * walkableNativeH);
            }
            // Sit-point = anchor placement + sit_anchor offset (normalized
            // scene-space → native px via the same walkableNative scale).
            const sitAnchor = (Array.isArray(d.sit_anchor) && d.sit_anchor.length >= 2)
              ? d.sit_anchor
              : DEFAULT_SIT_ANCHOR;
            const sitNative = clampToPolygon(
              placed[0] + sitAnchor[0] * walkableNativeW,
              placed[1] + SEAT_SIT_DROP * walkableNativeH,
              walkablePolygon
            );
            decorPlacement[decorId] = {
              nx: placed[0],
              ny: placed[1],
              sitNx: sitNative[0],
              sitNy: sitNative[1],
              sittable: !!d.is_sittable,
            };
            // Prime an anim state for animated decor (anim_fps present).
            if (typeof d.anim_fps === "number" && d.anim_fps > 0) {
              decorAnimMap[decorId] = {
                frameIndex: 0,
                elapsed: 0,
                direction: 1,
                completed: false,
                fps: d.anim_fps,
                loop: d.anim_loop !== false,
              };
            }
            if (d.is_sittable) seatOccupancy[decorId] = null;
          });
        }

        // ── Phase 2b: capture enemy/EVICT config + rival roster ──────────
        const enemyCfg = vp && vp.enemy_config && typeof vp.enemy_config === "object" ? vp.enemy_config : {};
        enemySpawnIntervalSec = (typeof enemyCfg.spawn_interval_seconds === "number" && enemyCfg.spawn_interval_seconds > 0)
          ? enemyCfg.spawn_interval_seconds
          : 45;
        enemyCountMode = enemyCfg.count_mode === "all" ? "all" : "random";
        themeRivals = Array.isArray(manifest?.roster_rivals) ? manifest.roster_rivals.slice() : [];
        themeRosterAgents = Array.isArray(manifest?.roster_agents) ? manifest.roster_agents.slice() : [];
        // Reset runtime enemy state for the new theme (no enemies carry over).
        activeEnemies = [];
        enemySpawnElapsed = 0;
        // Change C: capture projectile FX availability. A theme has projectiles
        // only when BOTH the manifest declares the asset AND the frames loaded
        // (themeImages['projectile'] is populated generically by preloadThemeImages
        // from any 'projectile' key in payload.frames). Older themes lacking it
        // fall back to no-projectile ranged fire. Reset live projectiles too.
        themeHasProjectile = !!(vp && vp.projectile_asset)
          && Array.isArray(themeImages["projectile"])
          && themeImages["projectile"].length > 0;
        activeProjectiles = [];
        // Rival frames arrive in the same `frames` payload as characters/objects,
        // keyed like "rival_<rival_id>" (mirrors "object_<object_id>"); preloadThemeImages
        // already loads every key in rawFrames generically, so no extra preload step
        // is needed here as long as the host includes rival_* keys in payload.frames.

        // Build rosterOrder from the theme's playable roster (manifest.roster_agents),
        // NOT from every frame key. Object.keys(themeFramesRaw) also contains
        // rival_/object_/achievement_/crate/poof/projectile/decor_ keys, which used
        // to leak into the roster-order UI. Derive canonical character keys the same
        // way enterEditStage() does (see ~line 2547): "agent_" + slot_id, in roster
        // order (roster_agents is already slot_id-ordered). Only keep keys that
        // actually have loaded frames so an ungenerated agent doesn't render a
        // broken row.
        let charKeys = themeRosterAgents.length
          ? themeRosterAgents
              .filter((a) => a && a.slot_id !== undefined && a.slot_id !== null)
              .map((a) => "agent_" + a.slot_id)
              .filter((id) => Object.prototype.hasOwnProperty.call(themeFramesRaw, id))
          : [];
        if (!charKeys.length) {
          // Fallback: old behavior, in case roster_agents is unavailable/empty.
          charKeys = Object.keys(themeFramesRaw).filter(
            (id) => id !== "environment_background"
          );
        }
        const manifestChars = charKeys;
        // Restore saved order if present, but only when it's still exactly the
        // roster set — a stale saved order captured before this fix may contain
        // non-roster keys (rival_/object_/etc.) and must be rejected/rebuilt.
        const saved = vscode.getState() || {};
        const savedOrder = Array.isArray(saved.rosterOrder) ? saved.rosterOrder : [];
        const savedValid =
          savedOrder.length > 0 &&
          savedOrder.every((id) => manifestChars.includes(id)) &&
          manifestChars.every((id) => savedOrder.includes(id));
        if (savedValid) {
          rosterOrder = savedOrder.slice();
        } else {
          // Reconcile: keep any saved entries that are still valid roster keys (in
          // their saved relative order), then append any roster keys missing from
          // the saved order — so rosterOrder always ends up exactly the roster set.
          const savedSet = new Set(savedOrder);
          rosterOrder = savedOrder.filter((id) => manifestChars.includes(id));
          manifestChars.forEach((id) => {
            if (!savedSet.has(id)) rosterOrder.push(id);
          });
        }
        if (typeof saved.rosterCollapsed === "boolean") {
          rosterCollapsed = saved.rosterCollapsed;
        }
        buildRosterStrip();
      }
    } else if (msg && msg.type === "THEME_NONE") {
      // Host looked for a theme on "ready" and found none (fresh install) —
      // end the boot loader's loading window right away so it hands off to
      // the no-theme placeholder scene the moment render() actually draws
      // it, instead of idling for LOADING_TIMEOUT_MS/the 12s hard failsafe.
      noThemeSignaled = true;
    } else if (msg && msg.type === "THEME_SELECT_ABORTED") {
      // Host declined the switch (theme-switch warning modal was dismissed
      // instead of confirmed) — revert the optimistic selectedThemeId set on
      // click (theme-picker click handler, ~line 2952) back to the theme
      // that's still actually loaded, and re-render the picker's highlight.
      const stillLoadedId = msg.payload && msg.payload.theme_id;
      if (typeof stillLoadedId === "string") {
        selectedThemeId = stillLoadedId;
        renderThemesList(lastThemesList);
      }
    } else if (msg && msg.type === "STAGE_TUNING_SAVED") {
      if (stageEditEls && stageEditEls.status) {
        const ok = msg.payload && msg.payload.ok;
        stageEditEls.status.textContent = ok ? "Saved to theme ✓" : "Save failed";
        stageEditEls.status.style.color = ok ? "#9fffa0" : "#ff9f9f";
      }
    } else if (msg && msg.type === "THEME_ITEM_NAMES_RESULT") {
      applyThemeItemNamesResult(msg.payload || {});
    } else if (msg && msg.type === "THEME_ITEM_DESCRIPTIONS_RESULT") {
      applyThemeItemDescriptionsResult(msg.payload || {});
    } else if (msg && msg.type === "THEME_CREATIVE_DIRECTION_RESULT") {
      applyThemeCreativeDirectionResult(msg.payload || {});
    } else if (msg && msg.type === "BACKGROUND_REPLACE_RESULT") {
      const ok = msg.payload && msg.payload.ok;
      const cancelled = msg.payload && msg.payload.cancelled;
      if (stageEditEls && stageEditEls.status) {
        stageEditEls.status.textContent = cancelled ? "" : (ok ? "Background replaced ✓" : "Replace failed");
        stageEditEls.status.style.color = ok ? "#9fffa0" : "#ff9f9f";
      }
      // Reset a pending review-card Upload button. On success the host re-posts
      // THEME_IMAGE_REVIEW which rebuilds the card, so only the cancel/failure
      // path needs an explicit reset of the (still-attached) button.
      if (pendingUploadBtn) {
        if (!ok) {
          pendingUploadBtn.disabled = false;
          pendingUploadBtn.textContent = "Upload";
        }
        pendingUploadBtn = null;
      }
    } else if (msg && msg.type === "state") {
      state = msg.state;
      idleFreezeMs = state.idleFreezeMs ?? 180000;
      sanityCapMs = state.sanityCapMs ?? 900000;
      // Maintain insertion order for stable x positions
      for (const id of Object.keys(state.workers)) {
        if (!workerOrder.includes(id)) {
          workerOrder.push(id);
        }
      }
      // Remove workers no longer in state
      for (let i = workerOrder.length - 1; i >= 0; i--) {
        if (!state.workers[workerOrder[i]]) {
          workerOrder.splice(i, 1);
        }
      }
      // Update metrics panel
      renderMetrics(state.agentMetrics);
      renderDelegationStats(state.modeStats);
    } else if (msg && msg.type === "skills") {
      renderSkillsList(msg.skills, msg.error);
    } else if (msg && msg.type === "skillInstalled") {
      handleSkillInstalled(msg.id, msg.ok, msg.alreadyExisted, msg.error);
    } else if (msg && msg.type === "skillRemoved") {
      handleSkillRemoved(msg.id, msg.ok, msg.error, msg.cancelled);
    } else if (msg && msg.type === "mcp") {
      renderMcpList(msg.servers, msg.error);
    } else if (msg && msg.type === "mcpInstalled") {
      handleMcpInstalled(msg.id, msg.ok, msg.alreadyExisted, msg.error, msg.cancelled);
    } else if (msg && msg.type === "mcpRemoved") {
      handleMcpRemoved(msg.id, msg.ok, msg.error, msg.cancelled);
    } else if (msg && msg.type === "packs") {
      renderPacksList(msg.packs, msg.error);
    } else if (msg && msg.type === "packInstalled") {
      handlePackInstalled(msg.id, msg.ok, msg.results, msg.error, msg.cancelled);
    } else if (msg && msg.type === "packRemoved") {
      handlePackRemoved(msg.id, msg.ok, msg.results, msg.error, msg.cancelled);
    } else if (msg && msg.type === "agentRemoved") {
      handleAgentRemoved(msg.id, msg.ok, msg.cancelled, msg.error);
    } else if (msg && msg.type === "installState") {
      lastUefnBridgeSetUp = Boolean(msg.uefnBridgeSetUp);
      handleInstallState(msg);
      // When handleInstallState just took (or continued in) the Step-2
      // Optionals branch, renderSetupOptionals already handled the UEFN
      // section inline (button or "already set up" line), in the correct
      // DOM position (between the skill chips and the advanced-link/Done
      // button). Skip the generic call here so the UEFN card isn't
      // re-appended at the very end of #setup-card (which would both
      // duplicate-render and misplace it).
      // Mirrors handleInstallState's own branch predicate exactly (not just
      // "installed && !openedFromSettings && !done") so this is true ONLY
      // when renderSetupOptionals actually ran just now — a plain returning
      // session (hooks pre-installed, never justInstalled, setupStage stuck
      // at "not-installed") takes handleInstallState's final showMain()
      // fallback instead, and must NOT suppress the fallback renderUefnPrompt
      // call below.
      var uefnHandledByOptionals =
        msg &&
        msg.installed === true &&
        !openedFromSettings &&
        setupStage !== "done" &&
        (justInstalled || setupStage === "optionals");
      // uefnBridgeSetUp: the .mcp.json uefn-bridge entry is already present
      // (UEFN setup ran before) — don't keep re-prompting "set up UEFN".
      if (msg.uefnDetected && !msg.uefnBridgeSetUp && !uefnHandledByOptionals) {
        lastUefnDetected = true;
        renderUefnPrompt(msg.uefnSignals || []);
      }
    } else if (msg && msg.type === "uefnSetupDone") {
      handleUefnSetupDone(msg);
    } else if (msg && msg.type === "settings") {
      lastSettings = msg.payload || null;
      renderSettings();
    } else if (msg && msg.type === "settingsUpdated") {
      handleSettingsUpdated(msg);
    } else if (msg && msg.type === "metricsReset") {
      handleMetricsReset(msg);
    } else if (msg && msg.type === "doctorReport") {
      const el = document.getElementById("doctor-results");
      if (!el) return;
      el.innerHTML = "";

      // Re-enable the troubleshoot button
      document.querySelectorAll("button").forEach(b => {
        if (b.textContent === "Checking…") {
          b.disabled = false;
          b.textContent = "Troubleshoot & Fix";
        }
      });

      const findings = Array.isArray(msg.findings) ? msg.findings : [];
      const foreign = Array.isArray(msg.foreign) ? msg.foreign : [];

      for (const f of findings) {
        const row = document.createElement("div");
        row.className = "doctor-finding";
        const icon = document.createElement("span");
        icon.className = f.severity === "ok" ? "doctor-icon-ok" : f.severity === "warn" ? "doctor-icon-warn" : "doctor-icon-error";
        icon.textContent = f.severity === "ok" ? "✓" : f.severity === "warn" ? "⚠" : "✗";
        const text = document.createElement("span");
        text.className = "doctor-finding-text";
        const title = document.createElement("strong");
        title.textContent = f.title;
        const detail = document.createElement("span");
        detail.className = "doctor-detail";
        detail.textContent = " — " + f.detail;
        text.appendChild(title);
        text.appendChild(detail);
        row.appendChild(icon);
        row.appendChild(text);
        el.appendChild(row);
      }

      const hasFixable = findings.some(f => f.fixable && !f.destructive);
      if (hasFixable) {
        const fixRow = document.createElement("div");
        fixRow.className = "doctor-action-row";
        const fixBtn = document.createElement("button");
        fixBtn.className = "skill-btn settings-btn";
        fixBtn.textContent = "Fix issues";
        fixBtn.addEventListener("click", () => {
          fixBtn.disabled = true;
          fixBtn.textContent = "Fixing…";
          vscode.postMessage({ type: "applyDoctorFix", removeForeign: false });
        });
        fixRow.appendChild(fixBtn);
        el.appendChild(fixRow);
      }

      if (foreign.length > 0) {
        const cautionDiv = document.createElement("div");
        cautionDiv.className = "doctor-caution";
        const cautionTitle = document.createElement("div");
        cautionTitle.className = "doctor-caution-title";
        cautionTitle.textContent = "Foreign hook commands in Tycoon event-slots:";
        cautionDiv.appendChild(cautionTitle);
        for (const cmd of foreign) {
          const cmdEl = document.createElement("div");
          cmdEl.className = "doctor-foreign-cmd";
          cmdEl.textContent = cmd;
          cautionDiv.appendChild(cmdEl);
        }
        const removeBtn = document.createElement("button");
        removeBtn.className = "skill-btn settings-btn danger-btn";
        removeBtn.textContent = `Remove foreign hooks (${foreign.length})`;
        removeBtn.addEventListener("click", () => {
          removeBtn.disabled = true;
          removeBtn.textContent = "Removing…";
          vscode.postMessage({ type: "applyDoctorFix", removeForeign: true });
        });
        cautionDiv.appendChild(removeBtn);
        el.appendChild(cautionDiv);
      }
    } else if (msg && msg.type === "engineStatus") {
      renderEngineChips(Array.isArray(msg.chips) ? msg.chips : []);
    } else if (msg && msg.type === "doctorFixDone") {
      const el = document.getElementById("doctor-results");
      if (!el) return;
      el.innerHTML = "";

      if (!msg.ok) {
        const errEl = document.createElement("div");
        errEl.className = "doctor-finding";
        const icon = document.createElement("span");
        icon.className = "doctor-icon-error";
        icon.textContent = "✗";
        const text = document.createElement("span");
        text.className = "doctor-finding-text";
        text.textContent = "Fix failed: " + (msg.error || "Unknown error");
        errEl.appendChild(icon);
        errEl.appendChild(text);
        el.appendChild(errEl);
        return;
      }

      const changes = Array.isArray(msg.changes) ? msg.changes : [];
      if (changes.length === 0) {
        const noChange = document.createElement("div");
        noChange.className = "doctor-finding";
        noChange.textContent = "No changes needed.";
        el.appendChild(noChange);
      } else {
        for (const change of changes) {
          const row = document.createElement("div");
          row.className = "doctor-finding";
          const icon = document.createElement("span");
          icon.className = "doctor-icon-ok";
          icon.textContent = "✓";
          const text = document.createElement("span");
          text.className = "doctor-finding-text";
          text.textContent = change;
          row.appendChild(icon);
          row.appendChild(text);
          el.appendChild(row);
        }
      }

      const remaining = Array.isArray(msg.findings) ? msg.findings.filter(f => f && f.severity !== "ok") : [];
      if (remaining.length > 0) {
        const note = document.createElement("div");
        note.className = "doctor-finding";
        note.style.marginTop = "6px";
        note.textContent = "Still detected after fix:";
        el.appendChild(note);
        for (const f of remaining) {
          const row = document.createElement("div");
          row.className = "doctor-finding";
          const icon = document.createElement("span");
          icon.className = f.severity === "warn" ? "doctor-icon-warn" : "doctor-icon-error";
          icon.textContent = f.severity === "warn" ? "⚠" : "✗";
          const text = document.createElement("span");
          text.className = "doctor-finding-text";
          text.textContent = f.title + " — this may mean a previously-installed agent hook is still active in this session; fully restart the IDE, then run Troubleshoot & Fix again.";
          row.appendChild(icon);
          row.appendChild(text);
          el.appendChild(row);
        }
      }

      const findings = Array.isArray(msg.findings) ? msg.findings : [];
      const foreign = Array.isArray(msg.foreign) ? msg.foreign : [];
      const refreshEl = document.createElement("div");
      refreshEl.className = "doctor-refresh";
      for (const f of findings) {
        const row = document.createElement("div");
        row.className = "doctor-finding";
        const icon = document.createElement("span");
        icon.className = f.severity === "ok" ? "doctor-icon-ok" : f.severity === "warn" ? "doctor-icon-warn" : "doctor-icon-error";
        icon.textContent = f.severity === "ok" ? "✓" : f.severity === "warn" ? "⚠" : "✗";
        const text = document.createElement("span");
        text.textContent = " " + f.title + (f.detail ? ": " + f.detail : "");
        row.appendChild(icon);
        row.appendChild(text);
        refreshEl.appendChild(row);
      }
      if (foreign.length > 0) {
        const cautionDiv = document.createElement("div");
        cautionDiv.className = "doctor-caution";
        for (const cmd of foreign) {
          const cmdEl = document.createElement("div");
          cmdEl.className = "doctor-foreign-cmd";
          cmdEl.textContent = cmd;
          cautionDiv.appendChild(cmdEl);
        }
        refreshEl.appendChild(cautionDiv);
      }
      el.appendChild(refreshEl);
    } else if (msg && msg.type === "designDocDone") {
      /* handled by host info message */
    } else if (msg && msg.type === "projectPlanDone") {
      /* handled by host info message */
    } else if (msg && msg.type === "PLAN_STATE") {
      // Optional "Project Plan" feature. `enabled` mirrors the Settings
      // toggle; `plan` is null when the feature is off, or on with no
      // plan.json generated yet.
      projectPlanEnabled = Boolean(msg.enabled);
      currentProjectPlan = msg.plan || null;
      currentArchivedPlans = Array.isArray(msg.archivedPlans) ? msg.archivedPlans : [];
      // planReadable is new (corrupt-plan detection); undefined from an
      // older/standalone host means "readable" for back-compat.
      currentPlanReadable = msg.planReadable !== false;
      currentPlanError = msg.planError || "";
      currentPlanHasBackup = !!msg.hasBackup;
      syncProjectPlanSettingsToggle();
      renderProjectPlanSection();
    }
  });

  // ── Transparency / third-party disclosure ────────────────────────
  //
  // Installing an MCP server (or a Pack that bundles one) runs third-party
  // code on the user's machine and may call external services. We surface a
  // standing banner per list, a per-row disclosure block, and a confirm gate
  // before any networked install proceeds.

  /** Last MCP server array received, for disclosure lookup in the click handler. */
  let lastMcpServers = [];
  /** Last packs array received, for disclosure lookup in the click handler. */
  let lastPacks = [];

  /**
   * Build the standing notice for a catalog list.
   * @param {"third-party"|"local"} kind
   * @returns {HTMLElement}
   */
  function buildCatalogNotice(kind) {
    const el = document.createElement("p");
    if (kind === "local") {
      el.className = "catalog-notice catalog-notice--local";
      el.textContent =
        "Skills are local prompt files bundled with the extension — no third-party code or network calls.";
    } else {
      el.className = "catalog-notice";
      el.textContent =
        "⚠ These install third-party software that runs on your machine and may contact external services. " +
        "Review each item's source and data use, and check your organization's policy before installing.";
    }
    return el;
  }

  /**
   * Build a per-item disclosure block (used by MCP rows and Pack disclosures).
   * @param {{vendor?:string,package?:string,homepage?:string,network?:boolean,dataNote?:string,label?:string}} d
   * @returns {HTMLElement}
   */
  function buildDisclosureBlock(d) {
    const block = document.createElement("div");
    block.className = "disclosure";

    const tagLine = document.createElement("div");
    tagLine.className = "disclosure-tagline";
    const tag = document.createElement("span");
    tag.className = "disclosure-tag";
    tag.textContent = "Third-party";
    tagLine.appendChild(tag);
    if (d.vendor) {
      const vendor = document.createElement("span");
      vendor.className = "disclosure-vendor";
      vendor.textContent = d.label ? `${d.label} · ${d.vendor}` : d.vendor;
      tagLine.appendChild(vendor);
    }
    block.appendChild(tagLine);

    if (d.package) {
      const pkg = document.createElement("div");
      pkg.className = "disclosure-pkg";
      pkg.textContent = `Runs: ${d.package}`;
      block.appendChild(pkg);
    }

    const net = document.createElement("div");
    if (d.network) {
      net.className = "disclosure-net";
      net.textContent = `Sends data externally: ${d.dataNote || "contacts an external service."}`;
    } else {
      net.className = "disclosure-local";
      net.textContent = `Local only: ${d.dataNote || "runs locally with no network calls."}`;
    }
    block.appendChild(net);

    if (d.homepage) {
      const src = document.createElement("a");
      src.className = "disclosure-src";
      src.href = d.homepage;
      src.target = "_blank";
      src.rel = "noopener noreferrer";
      src.textContent = "source ↗";
      block.appendChild(src);
    }

    return block;
  }

  /**
   * Build a confirm message for a third-party install.
   * @param {{name?:string,vendor?:string,package?:string,network?:boolean,dataNote?:string,homepage?:string}} item
   * @returns {string}
   */
  function buildInstallConfirm(item) {
    const lines = [];
    lines.push(`Install ${item.name || "this item"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine.");
    if (item.vendor) lines.push(`Vendor: ${item.vendor}`);
    if (item.package) lines.push(`Runs: ${item.package}`);
    if (item.network) {
      lines.push(`Sends data externally: ${item.dataNote || "contacts an external service."}`);
    } else if (item.dataNote) {
      lines.push(`Local only: ${item.dataNote}`);
    }
    if (item.homepage) lines.push(`Source: ${item.homepage}`);
    lines.push("");
    lines.push("Check your organization's policy before continuing. Proceed?");
    return lines.join("\n");
  }

  /**
   * Rebuild #skills-list from the catalog payload.
   * @param {Array<{id:string,name:string,description:string,installed:boolean,mcpNote?:string,thirdParty?:boolean,source?:string}>} skills
   * @param {string|undefined} error
   */
  function renderSkillsList(skills, error) {
    skillsListEl.innerHTML = "";
    skillsListEl.appendChild(buildCatalogNotice("local"));
    if (error) {
      const errEl = document.createElement("p");
      errEl.className = "skills-error";
      errEl.textContent = error;
      skillsListEl.appendChild(errEl);
      return;
    }
    if (!skills || skills.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "skills-empty";
      emptyEl.textContent = "No skills available.";
      skillsListEl.appendChild(emptyEl);
      return;
    }
    for (const skill of skills) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.skillRowId = skill.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = skill.name;

      const descEl = document.createElement("span");
      descEl.className = "skill-desc";
      descEl.textContent = skill.description;

      textBlock.appendChild(nameEl);
      textBlock.appendChild(descEl);

      if (skill.mcpNote) {
        const noteEl = document.createElement("span");
        noteEl.className = "skill-mcpnote";
        noteEl.textContent = `⚙ ${skill.mcpNote}`;
        textBlock.appendChild(noteEl);
      }

      if (skill.thirdParty) {
        const attrLine = document.createElement("div");
        attrLine.className = "skill-attribution disclosure-tagline";
        const tag = document.createElement("span");
        tag.className = "disclosure-tag";
        tag.textContent = "Third-party";
        attrLine.appendChild(tag);
        if (skill.source) {
          const src = document.createElement("a");
          src.className = "disclosure-src";
          src.href = skill.source;
          src.target = "_blank";
          src.rel = "noopener noreferrer";
          src.textContent = "source ↗";
          attrLine.appendChild(src);
        }
        textBlock.appendChild(attrLine);
      }

      const btn = document.createElement("button");
      if (skill.installed) {
        btn.className = "skill-btn skill-btn--remove";
        btn.textContent = "Remove";
        btn.setAttribute("data-remove-skill-id", skill.id);
      } else {
        btn.className = "skill-btn";
        btn.textContent = "Install";
        btn.setAttribute("data-skill-id", skill.id);
      }

      row.appendChild(textBlock);
      row.appendChild(btn);
      skillsListEl.appendChild(row);
    }
  }

  /**
   * Update a skill row after an install attempt.
   * @param {string} id
   * @param {boolean} ok
   * @param {boolean|undefined} alreadyExisted
   * @param {string|undefined} error
   */
  function handleSkillInstalled(id, ok, alreadyExisted, error) {
    const btn = /** @type {HTMLElement|null} */ (
      skillsListEl.querySelector(`[data-skill-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    if (ok) {
      btn.textContent = "Installed";
      btn.classList.add("skill-btn--installed");
      btn.setAttribute("disabled", "");
      btn.removeAttribute("data-skill-id");
    } else {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
      // Show error near the row
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Install failed";
      }
    }
  }

  /**
   * Update a skill row after a remove attempt. On success the host re-posts
   * the skills list, so we mainly reconcile the in-flight button; on cancel we
   * silently restore, and on error we restore + surface the message.
   * @param {string} id
   * @param {boolean} ok
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handleSkillRemoved(id, ok, error, cancelled) {
    const btn = /** @type {HTMLElement|null} */ (
      skillsListEl.querySelector(`[data-remove-skill-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    if (cancelled) {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      // Host re-posts the skills list which re-renders this row as
      // not-installed. As a fallback (in case that message is missed) flip the
      // button back to Install here too.
      btn.textContent = "Install";
      btn.classList.remove("skill-btn--remove");
      btn.removeAttribute("disabled");
      btn.removeAttribute("data-remove-skill-id");
      btn.setAttribute("data-skill-id", id);
    } else {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
      }
    }
  }

  /**
   * Update an agent row after a remove attempt. Mirrors handleSkillRemoved.
   * The host runs the native confirm + actual removal, then re-posts the
   * roster/settings on success (which re-renders the settings list). So on ok
   * we simply let that re-render happen (and re-request settings as a fallback);
   * on cancelled/error we restore the button.
   * @param {string} id
   * @param {boolean} ok
   * @param {boolean} [cancelled]
   * @param {string} [error]
   */
  function handleAgentRemoved(id, ok, cancelled, error) {
    const btn = /** @type {HTMLElement|null} */ (
      setupConfigEl
        ? setupConfigEl.querySelector(`[data-remove-agent-id="${CSS.escape(id)}"]`)
        : null
    );
    if (ok) {
      // Host re-posts the settings payload which re-renders this list. As a
      // fallback (in case that message is missed) request settings again.
      vscode.postMessage({ type: "getSettings" });
      return;
    }
    if (!btn) return;
    // cancelled or error → restore the button to its clickable state.
    btn.removeAttribute("disabled");
    btn.textContent = "Remove";
    if (!cancelled && error) {
      const row = btn.closest(".agent-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
      }
    }
  }

  // ── MCP servers list ─────────────────────────────────────────────

  /**
   * Rebuild #mcp-list from the catalog payload. Mirrors renderSkillsList.
   * @param {Array<{id:string,name:string,description:string,installed:boolean,requiresEnv?:string[],note?:string,docsUrl?:string}>} servers
   * @param {string|undefined} error
   */
  function renderMcpList(servers, error) {
    if (!mcpListEl) return;
    lastMcpServers = Array.isArray(servers) ? servers : [];
    mcpListEl.innerHTML = "";
    mcpListEl.appendChild(buildCatalogNotice("third-party"));
    if (error) {
      const errEl = document.createElement("p");
      errEl.className = "skills-error";
      errEl.textContent = error;
      mcpListEl.appendChild(errEl);
      return;
    }
    if (!servers || servers.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "skills-empty";
      emptyEl.textContent = "No MCP servers available.";
      mcpListEl.appendChild(emptyEl);
      return;
    }
    for (const server of servers) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.mcpRowId = server.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = server.name;

      const descEl = document.createElement("span");
      descEl.className = "skill-desc";
      descEl.textContent = server.description;

      textBlock.appendChild(nameEl);

      if (server.needsSetup) {
        const setupBadge = document.createElement("span");
        setupBadge.className = "mcp-setup-badge";
        setupBadge.textContent = "Template — needs setup";
        setupBadge.style.cssText = "margin-left:8px;font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(224,168,0,0.18);color:#b8860b;border:1px solid rgba(224,168,0,0.4);vertical-align:middle;";
        textBlock.appendChild(setupBadge);
      }

      textBlock.appendChild(descEl);

      if (server.requiresEnv && server.requiresEnv.length) {
        const reqEl = document.createElement("span");
        reqEl.className = "mcp-req";
        reqEl.textContent = `Requires: ${server.requiresEnv.join(", ")}`;
        textBlock.appendChild(reqEl);
      }

      if (server.note) {
        const noteEl = document.createElement("span");
        noteEl.className = "mcp-req";
        noteEl.textContent = server.note;
        textBlock.appendChild(noteEl);
      }

      if (server.docsUrl) {
        const docsEl = document.createElement("a");
        docsEl.className = "mcp-docs";
        docsEl.href = server.docsUrl;
        docsEl.target = "_blank";
        docsEl.rel = "noopener noreferrer";
        docsEl.textContent = "docs";
        textBlock.appendChild(docsEl);
      }

      if (server.thirdParty) {
        textBlock.appendChild(buildDisclosureBlock({
          vendor: server.vendor,
          package: server.package,
          homepage: server.homepage,
          network: server.network,
          dataNote: server.dataNote,
        }));
      }

      const btn = document.createElement("button");
      if (server.installed) {
        btn.className = "skill-btn skill-btn--remove";
        btn.textContent = "Remove";
        btn.setAttribute("data-remove-mcp-id", server.id);
      } else {
        btn.className = "skill-btn";
        btn.textContent = "Install";
        btn.setAttribute("data-mcp-id", server.id);
      }

      row.appendChild(textBlock);
      row.appendChild(btn);
      mcpListEl.appendChild(row);
    }
  }

  /**
   * Update an MCP row after an install attempt. Mirrors handleSkillInstalled.
   * @param {string} id
   * @param {boolean} ok
   * @param {boolean|undefined} alreadyExisted
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handleMcpInstalled(id, ok, alreadyExisted, error, cancelled) {
    if (!mcpListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      mcpListEl.querySelector(`[data-mcp-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    // User dismissed the host confirmation modal — silently restore the button.
    if (cancelled) {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      btn.textContent = "Installed";
      btn.classList.add("skill-btn--installed");
      btn.setAttribute("disabled", "");
      btn.removeAttribute("data-mcp-id");
    } else {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Install failed";
      }
    }
  }

  /**
   * Update an MCP row after a remove attempt. Mirrors handleSkillRemoved.
   * @param {string} id
   * @param {boolean} ok
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handleMcpRemoved(id, ok, error, cancelled) {
    if (!mcpListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      mcpListEl.querySelector(`[data-remove-mcp-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    if (cancelled) {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      // Host re-posts the MCP list; flip button as a fallback.
      btn.textContent = "Install";
      btn.classList.remove("skill-btn--remove");
      btn.removeAttribute("disabled");
      btn.removeAttribute("data-remove-mcp-id");
      btn.setAttribute("data-mcp-id", id);
    } else {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
      }
    }
  }

  // ── Packs list (capability bundles: skill + MCP + agent) ─────────

  /** Part keys in display order, with their chip labels. */
  const PACK_PARTS = [
    ["skill", "Skill"],
    ["mcp", "MCP"],
    ["agent", "Agent"],
  ];

  /**
   * True when every part the pack `has` is also `installed`.
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   * @returns {boolean}
   */
  function packFullyInstalled(pack) {
    const has = pack.has || {};
    const installed = pack.installed || {};
    return PACK_PARTS.every(([key]) => !has[key] || installed[key]);
  }

  /**
   * True when at least one part the pack `has` is `installed`.
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   * @returns {boolean}
   */
  function packAnyInstalled(pack) {
    const has = pack.has || {};
    const installed = pack.installed || {};
    return PACK_PARTS.some(([key]) => has[key] && installed[key]);
  }

  /**
   * Build the "includes" chip row for a pack into a container element.
   * @param {HTMLElement} container
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   */
  function renderPackChips(container, pack) {
    container.innerHTML = "";
    const has = pack.has || {};
    const installed = pack.installed || {};
    for (const [key, label] of PACK_PARTS) {
      if (!has[key]) continue;
      const done = !!installed[key];
      const chip = document.createElement("span");
      chip.className = "pack-chip" + (done ? " pack-chip--done" : "");
      chip.textContent = done ? `${label} ✓` : label;
      container.appendChild(chip);
    }
  }

  /**
   * Rebuild #packs-list from the catalog payload. Mirrors renderMcpList.
   * @param {Array<{id:string,name:string,description:string,has:Record<string,boolean>,installed:Record<string,boolean>}>} packs
   * @param {string|undefined} error
   */
  function renderPacksList(packs, error) {
    if (!packsListEl) return;
    lastPacks = Array.isArray(packs) ? packs : [];
    packsListEl.innerHTML = "";
    packsListEl.appendChild(buildCatalogNotice("third-party"));
    if (error) {
      const errEl = document.createElement("p");
      errEl.className = "skills-error";
      errEl.textContent = error;
      packsListEl.appendChild(errEl);
      return;
    }
    if (!packs || packs.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "skills-empty";
      emptyEl.textContent = "No packs available.";
      packsListEl.appendChild(emptyEl);
      return;
    }
    for (const pack of packs) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.packRowId = pack.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = pack.name;

      const descEl = document.createElement("span");
      descEl.className = "skill-desc";
      descEl.textContent = pack.description;

      textBlock.appendChild(nameEl);
      textBlock.appendChild(descEl);

      const parts = document.createElement("div");
      parts.className = "pack-parts";
      renderPackChips(parts, pack);
      textBlock.appendChild(parts);

      // Muted line listing each bundled skill with a per-skill done marker.
      if (Array.isArray(pack.skills) && pack.skills.length) {
        const includes = document.createElement("div");
        includes.className = "pack-skills";
        const lead = document.createElement("span");
        lead.className = "pack-skills-lead";
        lead.textContent = "Includes: ";
        includes.appendChild(lead);
        pack.skills.forEach((s, i) => {
          const item = document.createElement("span");
          item.className = "pack-skills-item" + (s && s.installed ? " pack-skills-item--done" : "");
          const label = (s && (s.name || s.id)) || "";
          item.textContent = (s && s.installed) ? `${label} ✓` : label;
          includes.appendChild(item);
          if (i < pack.skills.length - 1) {
            const sep = document.createElement("span");
            sep.className = "pack-skills-sep";
            sep.textContent = ", ";
            includes.appendChild(sep);
          }
        });
        textBlock.appendChild(includes);
      }

      if (pack.thirdParty && Array.isArray(pack.disclosures) && pack.disclosures.length) {
        for (const d of pack.disclosures) {
          textBlock.appendChild(buildDisclosureBlock(d));
        }
      } else {
        const local = document.createElement("div");
        local.className = "disclosure-local";
        local.textContent =
          "Local only — installs a bundled skill + a local agent; no third-party servers.";
        textBlock.appendChild(local);
      }

      const fully = packFullyInstalled(pack);
      const anyInstalled = packAnyInstalled(pack);

      const btn = document.createElement("button");
      if (fully) {
        btn.className = "skill-btn skill-btn--installed";
        btn.textContent = "Installed";
        btn.setAttribute("disabled", "");
      } else {
        btn.className = "skill-btn";
        btn.textContent = "Install";
        btn.setAttribute("data-pack-id", pack.id);
      }

      row.appendChild(textBlock);
      row.appendChild(btn);

      // Show a Remove button whenever any component is installed (fully or
      // partially). It sits alongside the Install/Installed button.
      if (anyInstalled) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "skill-btn skill-btn--remove";
        removeBtn.textContent = "Remove";
        removeBtn.setAttribute("data-remove-pack-id", pack.id);
        row.appendChild(removeBtn);
      }

      packsListEl.appendChild(row);
    }
  }

  /**
   * Update a pack row after an install attempt. Mirrors handleMcpInstalled.
   * On success marks the row installed and re-fetches the catalog so chips
   * reflect authoritative per-part state.
   * @param {string} id
   * @param {boolean} ok
   * @param {{skill?:string,mcp?:string,agent?:string}|undefined} _results
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handlePackInstalled(id, ok, _results, error, cancelled) {
    if (!packsListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      packsListEl.querySelector(`[data-pack-id="${CSS.escape(id)}"]`)
    );
    // User dismissed the host confirmation modal — silently restore the button.
    if (cancelled) {
      if (btn) {
        btn.textContent = "Install";
        btn.removeAttribute("disabled");
      }
      return;
    }
    if (ok) {
      if (btn) {
        btn.textContent = "Installed";
        btn.classList.add("skill-btn--installed");
        btn.setAttribute("disabled", "");
        btn.removeAttribute("data-pack-id");
        const row = btn.closest(".skill-row");
        const parts = row && row.querySelector(".pack-parts");
        if (parts) {
          // Optimistically mark every present chip done; the getPacks
          // refresh below reconciles to authoritative state.
          for (const chip of parts.querySelectorAll(".pack-chip")) {
            chip.classList.add("pack-chip--done");
            if (!chip.textContent.includes("✓")) chip.textContent += " ✓";
          }
        }
      }
      // Re-fetch so chips/buttons reflect real per-part install results.
      vscode.postMessage({ type: "getPacks" });
    } else if (btn) {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Install failed";
      }
    }
  }

  /**
   * Update a pack row after a remove attempt. On success the host re-posts the
   * packs list (authoritative chip/button state); we also re-fetch as a
   * fallback. On cancel we silently restore; on error we restore + surface it.
   * @param {string} id
   * @param {boolean} ok
   * @param {{skill?:string,mcp?:string,agent?:string}|undefined} _results
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handlePackRemoved(id, ok, _results, error, cancelled) {
    if (!packsListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      packsListEl.querySelector(`[data-remove-pack-id="${CSS.escape(id)}"]`)
    );
    if (cancelled) {
      if (btn) {
        btn.textContent = "Remove";
        btn.removeAttribute("disabled");
      }
      return;
    }
    if (ok) {
      // Re-fetch so chips/buttons reflect real per-part removal results.
      vscode.postMessage({ type: "getPacks" });
    } else if (btn) {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
      }
    }
  }

  // ── Metrics panel ───────────────────────────────────────────────

  /**
   * Format a token count compactly.
   * < 1000      → "450"
   * 1k–999k     → "1.2k", "2.1k"  (trailing ".0" trimmed)
   * >= 1 000 000 → "1.5M"          (trailing ".0" trimmed)
   * @param {number} n
   * @returns {string}
   */
  function fmtTokens(n) {
    if (!n || n < 1000) return String(n ?? 0);
    if (n < 1_000_000) {
      const val = (n / 1000).toFixed(1).replace(/\.0$/, "");
      return `${val}k`;
    }
    const val = (n / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${val}M`;
  }

  /**
   * Resolve the roster's edit/implementation target label from the installed
   * agents list (`lastSettings.agents`), mirroring the resolution
   * delegationDoctrine.ts's renderPreamble/renderTeamLeadsSection use:
   * prefer "coding-specialist" when it's actually installed, else
   * "verse-expert" when installed (the UEFN roster's Verse-writing
   * implementer, which REPLACES coding-specialist on a UEFN project), else a
   * generic phrase when neither is present. Shared by the Delegation Health
   * panel's edit-count row and the copyable delegation tip so neither one
   * independently hardcodes an agent id that might not be on this project's
   * roster.
   * @param {Array<{id?: string}>} agents
   * @returns {string}
   */
  function resolveEditTargetLabel(agents) {
    const list = agents || [];
    if (list.some((agent) => agent.id === "coding-specialist")) return "coding-specialist";
    if (list.some((agent) => agent.id === "verse-expert")) return "verse-expert";
    return "your coding/implementation agent";
  }

  /**
   * Format milliseconds as "Xm Ys".
   * @param {number} ms
   * @returns {string}
   */
  function fmtMs(ms) {
    if (!ms || ms < 0) return "0m 0s";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }

  /**
   * Format a tokens-per-second rate as "3.4 tok/s" (one decimal below 10,
   * whole numbers at/above 10) or "0 tok/s" for a non-positive/zero rate.
   * @param {number} tokensPerSec
   * @returns {string}
   */
  function fmtTokensPerSec(tokensPerSec) {
    const v = Number(tokensPerSec) || 0;
    if (v <= 0) return "0 tok/s";
    const val = v < 10 ? v.toFixed(1) : String(Math.round(v));
    return `${val} tok/s`;
  }

  /**
   * Blended $ per MILLION tokens, keyed by model family. Derived from
   * Anthropic's current published API token rates using a 3:1 input:output
   * blend (agentic work is input-heavy), i.e. (3*input + output) / 4, taking
   * the latest non-deprecated model per family:
   *   opus   (4.8)  $5 in / $25 out  -> (3*5  + 25)/4 = $10
   *   sonnet (5)    $2 in / $10 out  -> (3*2  + 10)/4 = $4   [intro rate thru 2026-08-31; standard $3/$15 -> $6 from 2026-09-01]
   *   haiku  (4.5)  $1 in / $5  out  -> (3*1  +  5)/4 = $2
   *   fable  (5)    $10 in / $50 out -> (3*10 + 50)/4 = $20
   * Only TOTAL tokens are tracked per agent (no input/output/cache split), so
   * treat this as a rough estimate — RATIOS between models matter more than
   * absolute accuracy. These are API rates and do NOT reflect Claude
   * subscription (Max/Pro) billing. Run the /update-pricing skill to refresh
   * from live rates. (rates confirmed ~2026-07)
   * @type {{opus:number, sonnet:number, haiku:number, fable:number}}
   */
  const MODEL_PRICE_PER_MTOK = { opus: 10, sonnet: 4, haiku: 2, fable: 20 };

  /**
   * Blended $/million-token price for a model id/family string, or null when
   * the family can't be determined (unpriced models are excluded from cost
   * sums/rates, never shown as $0).
   * @param {string|null|undefined} model
   * @returns {number|null}
   */
  function modelPricePerMtok(model) {
    if (!model) return null;
    const s = String(model).toLowerCase();
    if (s.indexOf("opus") >= 0) return MODEL_PRICE_PER_MTOK.opus;
    if (s.indexOf("sonnet") >= 0) return MODEL_PRICE_PER_MTOK.sonnet;
    if (s.indexOf("haiku") >= 0) return MODEL_PRICE_PER_MTOK.haiku;
    if (s.indexOf("fable") >= 0) return MODEL_PRICE_PER_MTOK.fable;
    return null;
  }

  /**
   * Rough estimated $ cost for a total token count at a given model's blended
   * price. Returns null when the model is unknown or there are no tokens —
   * callers render "—" and exclude nulls from sums/rates rather than treating
   * them as $0.
   * @param {number|undefined} tokens
   * @param {string|null|undefined} model
   * @returns {number|null}
   */
  function estCostUSD(tokens, model) {
    const price = modelPricePerMtok(model);
    if (price == null || !(tokens > 0)) return null;
    return (tokens / 1e6) * price;
  }

  /**
   * Format an estimated $ figure. Prefixed with "~" by default (this is a
   * rough blended estimate, never a billed/exact amount), e.g. "~$0.42",
   * "<$0.01", "~$128". Returns "—" for null (unknown model / no tokens).
   * Pass withTilde=false to omit the leading "~" (e.g. in a narrow column
   * whose header already signals "estimate").
   * @param {number|null} v
   * @param {boolean} [withTilde=true]
   * @returns {string}
   */
  function fmtUSD(v, withTilde) {
    if (withTilde === undefined) withTilde = true;
    const tilde = withTilde ? "~" : "";
    if (v == null) return "—";
    if (v <= 0) return `${tilde}$0.00`;
    if (v < 0.01) return "<$0.01";
    if (v < 100) return `${tilde}$${v.toFixed(2)}`;
    return `${tilde}$${Math.round(v)}`;
  }

  /**
   * Conjugate a verb into its third-person singular form.
   * @param {string} verb
   * @returns {string}
   */
  function thirdPersonVerb(verb) {
    const lower = verb.toLowerCase();
    const irregular = { are: "is", have: "has", do: "does", go: "goes" };
    let conj;
    if (irregular[lower]) conj = irregular[lower];
    else if (/(s|sh|ch|x|z|o)$/.test(lower)) conj = lower + "es";
    else if (/[^aeiou]y$/.test(lower)) conj = lower.slice(0, -1) + "ies";
    else conj = lower + "s";
    return verb[0] === verb[0].toUpperCase() ? conj[0].toUpperCase() + conj.slice(1) : conj;
  }

  /**
   * Rewrite a second-person agent description into a third-person role blurb
   * for hover tooltips (e.g. "You are the Orchestrator — you coordinate work"
   * → "Coordinates work"). The agent name is shown separately, so a leading
   * self-introduction is dropped.
   * @param {string|undefined} desc
   * @returns {string}
   */
  function describeRole(desc) {
    if (!desc) return "";
    let s = String(desc).trim();
    // Drop a leading self-introduction "You are the/a/an <Name> — " so the
    // descriptive clause leads (the name is shown separately).
    s = s.replace(/^you\s+are\s+(?:the|a|an)\s+[^—:-]+?\s*[—–-]\s*/i, "");
    // Otherwise drop just the "You are " lead-in.
    s = s.replace(/^you\s+are\s+/i, "");
    // Convert sentence-initial "You <verb>" (start, or after . ! ?) to third person.
    s = s.replace(/(^|[.!?]\s+)you\s+([a-z]+)/gi, (_, pre, verb) => pre + thirdPersonVerb(verb));
    // Pronouns.
    s = s.replace(/\byour\b/gi, "its");
    s = s.replace(/\byou\b/gi, "it");
    // Capitalize first character.
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /**
   * Concise role LABEL for the character hover tooltip (e.g. "orchestrator"
   * → "Orchestrator", "primary-agent" → "Primary agent") — deliberately NOT
   * describeRole()'s verbose sentence-fragment blurb. Title-cases the agent's
   * identity: prefers agent.id (stable slugs like "coding-specialist"), falls
   * back to agent.name, hyphens/underscores become spaces, only the first
   * character is capitalized (matches the user's "Primary agent" example,
   * not "Primary Agent").
   * @param {{id?:string, name?:string}} agent
   * @returns {string}
   */
  function agentRoleLabel(agent) {
    const raw = (agent && (agent.id || agent.name)) || "";
    const s = String(raw).replace(/[-_]+/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Agent";
  }

  // Latest known version per Claude model family. Update these when a newer model
  // ships. The runtime-resolved id auto-wins if it ever reports a HIGHER version
  // than this map (so a real upgrade is never masked), and bare auto-latest
  // aliases (no version in the id) fall back to this map.
  const LATEST_MODEL_VERSION = { Opus: "4.8", Sonnet: "5", Haiku: "4.5", Fable: "5" };
  function prettyModel(model) {
    if (!model) return "";
    const s = String(model).toLowerCase();
    let family = null;
    if (s.includes("opus")) family = "Opus";
    else if (s.includes("sonnet")) family = "Sonnet";
    else if (s.includes("haiku")) family = "Haiku";
    else if (s.includes("fable")) family = "Fable";
    if (!family) return String(model); // unknown family → show raw
    // Version parsed from the resolved id, excluding 8-digit date stamps (e.g. 20250929).
    const nums = (s.match(/\d+/g) || []).filter((n) => n.length < 8);
    const idVer = nums.length ? nums.join(".") : null;
    const knownVer = LATEST_MODEL_VERSION[family] || null;
    // Prefer whichever numeric version is higher (future-proof if the runtime is ahead).
    let ver = knownVer;
    if (idVer && (!knownVer || parseFloat(idVer) > parseFloat(knownVer))) ver = idVer;
    return ver ? `${family} ${ver}` : family;
  }

  /**
   * Render the agentMetrics array into the DOM table.
   * @param {Array<{id:string,name:string,status:string,taskCount:number,mcpCount:number,activeMs:number,tokens:number,model?:string,description?:string,tier?:string,parentId?:string}>|undefined} metrics
   */
  /** Last metrics array received, re-rendered on a timer so live time ticks. */
  let lastMetrics = [];

  // Team Lead Mode Phase 3 previously nested workers under their lead
  // (expand/collapse rollup row). Retired in favor of a flat per-agent list
  // (see renderMetrics) because noisy parentId/tier data could hide a whole
  // team's rows; the per-lead expand/collapse state and rollup aggregation
  // that used to live here (isTeamExpanded/setTeamExpanded/aggregateTeam)
  // were removed along with it.

  /** Live (in-progress-inclusive) active ms for one agent metric entry, capped as usual. */
  function liveMsFor(agent) {
    const status = ((agent && agent.status) || "idle").toLowerCase();
    const isActive = status === "active";
    const seg = agent && agent.workStartAt
      ? Math.min(Math.max(0, Math.min(Date.now(), (agent.lastActivityAt ?? Date.now()) + idleFreezeMs) - agent.workStartAt), sanityCapMs)
      : 0;
    return ((agent && agent.activeMs) || 0) + (isActive ? seg : 0);
  }

  /**
   * Render one metrics row. `opts` is kept (rather than dropping the param)
   * so callers stay uniform; the lead/worker nesting opts it used to accept
   * (chevron/indent/teamTag/leadId, Team Lead Mode Phase 3) were retired
   * when the table moved to a flat per-agent list (see renderMetrics).
   */
  function buildMetricsRow(agent, maxUsdPerMin, opts) {
    opts = opts || {};
    const status = (agent.status || "idle").toLowerCase();
    const isActive = status === "active";
    const showActive = isMetricsAgentActive(agent);
    const row = document.createElement("tr");

    const displayName = agent.name || agent.id;

    const nameTd = document.createElement("td");
    nameTd.className = `col-name${showActive ? " name--active" : ""}`;

    const nameText = document.createElement("span");
    nameText.textContent = displayName;
    nameTd.appendChild(nameText);

    // Per-column tooltip: agent name + model + third-person role description.
    const role = describeRole(agent.description);
    let nameTitle = displayName;
    if (agent.model && role) {
      nameTitle = `${displayName} — ${prettyModel(agent.model)}\n${role}`;
    } else if (agent.model) {
      nameTitle = `${displayName} — ${prettyModel(agent.model)}`;
    } else if (role) {
      nameTitle = `${displayName}\n${role}`;
    }
    nameTd.title = nameTitle;
    row.appendChild(nameTd);

    // Status bar: green while active, gray while idle. Width encodes an
    // ESTIMATED $/min burn rate (estCostUSD(tokens, model) / active minutes),
    // normalized to the agent with the highest rate. This is a rough blended
    // estimate (total tokens only, no input/output split) — ratios matter more
    // than absolute accuracy. Active agents always show a visible green sliver
    // so "working" is never invisible.
    const mins = (agent.activeMs || 0) / 60000;
    const costUSD = estCostUSD(agent.tokens, agent.model);
    const usdPerMin = costUSD != null && mins > 0 ? costUSD / mins : null;
    const rawPct = usdPerMin !== null
      ? Math.round(Math.min(usdPerMin / maxUsdPerMin, 1) * 100)
      : 0;
    const fillPct = showActive ? Math.max(rawPct, 15) : rawPct;
    const statusTd = document.createElement("td");
    statusTd.className = "col-status";
    statusTd.title = "Estimated cost rate ($/min of active time) — a rough blended estimate from total tokens × approx. model price (no input/output split available; not a billed figure). The bar is scaled to the priciest agent.";
    const track = document.createElement("div");
    track.className = "status-bar-track";
    const fill = document.createElement("div");
    fill.className = `status-bar-fill ${showActive ? "status-bar-fill--active" : "status-bar-fill--idle"}`;
    fill.style.width = `${fillPct}%`;
    const label = document.createElement("span");
    label.className = "status-bar-label";
    label.textContent = showActive ? "active" : (usdPerMin !== null ? `${fmtUSD(usdPerMin, false)}/min` : "—");
    track.appendChild(fill);
    track.appendChild(label);
    statusTd.appendChild(track);
    row.appendChild(statusTd);

    const tasksTd = document.createElement("td");
    tasksTd.className = "col-tasks";
    tasksTd.title = "Tasks — number of Task-tool delegations routed to this agent.";
    tasksTd.textContent = String(agent.taskCount ?? 0);
    row.appendChild(tasksTd);

    const mcpTd = document.createElement("td");
    mcpTd.className = "col-mcp";
    mcpTd.title = "MCP — number of MCP tool calls this agent has made.";
    mcpTd.textContent = String(agent.mcpCount ?? 0);
    row.appendChild(mcpTd);

    // Show live elapsed time while active, capped by idle-freeze and sanity cap.
    const liveMs = liveMsFor(agent);
    const timeTd = document.createElement("td");
    timeTd.className = "col-time";
    timeTd.title = "Active time this agent has spent working.";
    timeTd.textContent = fmtMs(liveMs);
    row.appendChild(timeTd);

    const tokensTd = document.createElement("td");
    tokensTd.className = "col-tokens";
    tokensTd.title = "Total tokens this agent has consumed.";
    tokensTd.textContent = fmtTokens(agent.tokens ?? 0);
    row.appendChild(tokensTd);

    return row;
  }

  function renderMetrics(metrics) {
    lastMetrics = metrics || [];
    const emptyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-empty"));
    const tableEl = /** @type {HTMLElement} */ (document.getElementById("metrics-table"));
    const tbodyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tbody"));

    if (!emptyEl || !tableEl || !tbodyEl) return;

    if (!metrics || metrics.length === 0) {
      emptyEl.style.display = "";
      tableEl.style.display = "none";
      return;
    }

    emptyEl.style.display = "none";
    tableEl.style.display = "";

    // Estimated $/min burn rate of active time per agent (rough blended
    // estimate — see estCostUSD). Used to scale the status bar; unpriced
    // agents (unknown model) don't participate.
    const maxUsdPerMin = Math.max(0.0001, ...metrics.map(a => {
      const mins = (a.activeMs || 0) / 60000;
      const cost = estCostUSD(a.tokens, a.model);
      return cost != null && mins > 0 ? cost / mins : 0;
    }));

    // Flat list: every agent (lead or worker) gets its own equal top-level
    // row, in the existing sort order, no nesting/indentation/grouping. The
    // hook's parentId/tier data is noisy enough (leads sometimes recorded as
    // children of OTHER leads) that a lead→worker nesting pass could hide a
    // whole team's rows; a flat list can't hide anyone. See
    // docs/plan/team-lead-mode.md Phase 3 for the retired nesting approach.
    tbodyEl.innerHTML = "";
    for (const agent of metrics) {
      tbodyEl.appendChild(buildMetricsRow(agent, maxUsdPerMin, {}));
    }
  }

  /** Display label for a delegation mode id (the "flat" enum value renders as "Direct"). */
  const DELEGATION_MODE_LABEL = { flat: "Direct", team_leads: "Team Leads" };

  /**
   * Render the "Delegation stats" section (Team Lead Mode Phase 4:
   * measurement) — one row per delegation mode that has recorded data, so the
   * install screen's estimated "10-20% more tokens" claim can be checked
   * against real numbers measured in this workspace.
   * @param {Array<{mode:string,completedTasks:number,totalTokens:number,activeMs:number,leadTokens:number,teamTokens:number,leadOverheadPct:number|null,wallClockMs?:number}>|undefined} modeStats
   */
  function renderDelegationStats(modeStats) {
    const el = /** @type {HTMLElement} */ (document.getElementById("delegation-stats"));
    if (!el) return;

    const rows = Array.isArray(modeStats) ? modeStats.filter((m) => m && (m.completedTasks > 0 || m.totalTokens > 0)) : [];
    if (rows.length === 0) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }

    el.hidden = false;
    el.innerHTML = "";

    const heading = document.createElement("div");
    heading.className = "delegation-stats-heading";
    heading.textContent = "Delegation stats";
    el.appendChild(heading);

    for (const m of rows) {
      const label = DELEGATION_MODE_LABEL[m.mode] || m.mode;
      const tokensPerTask = m.completedTasks > 0 ? Math.round(m.totalTokens / m.completedTasks) : 0;

      const row = document.createElement("div");
      row.className = "delegation-stats-row";

      const nameEl = document.createElement("span");
      nameEl.className = "delegation-stats-mode";
      nameEl.textContent = label;
      row.appendChild(nameEl);

      const detail = document.createElement("span");
      detail.className = "delegation-stats-detail";
      let text = `${m.completedTasks} task${m.completedTasks === 1 ? "" : "s"} · ${fmtTokens(m.totalTokens)} tokens · ${fmtTokens(tokensPerTask)}/task`;
      if (m.mode === "team_leads" && m.leadOverheadPct !== null) {
        text += ` · lead overhead ${m.leadOverheadPct.toFixed(1)}% of team tokens`;
      }
      // activeMs is the mode's total active time summed across its agents;
      // unlike wallClockMs it persists after agents stop (workStartAt nulls
      // on stop), so throughput keeps showing post-run instead of "—".
      const modeTokPerSec = (typeof m.activeMs === "number" && m.activeMs > 0)
        ? m.totalTokens / (m.activeMs / 1000)
        : 0;
      // Estimated $/min burn rate for this mode: sum estCostUSD(tokens, model)
      // across the mode's agents (unpriced models excluded, not treated as $0),
      // divided by the same activeMs basis as the tok/s figure above — mirrors
      // resolveMode() in core/state.ts (delegationMode === "team_leads" wins,
      // everything else buckets as "flat").
      const modeAgents = lastMetrics.filter((a) => a && ((a.delegationMode === "team_leads" ? "team_leads" : "flat") === m.mode));
      const modeCostUSD = modeAgents.reduce((sum, a) => {
        const c = estCostUSD(a.tokens, a.model);
        return c != null ? sum + c : sum;
      }, 0);
      const modeUsdPerMin = (typeof m.activeMs === "number" && m.activeMs > 0 && modeCostUSD > 0)
        ? modeCostUSD / (m.activeMs / 60000)
        : null;
      text += ` · Throughput: ${modeTokPerSec > 0 ? fmtTokensPerSec(modeTokPerSec) : "—"} · ${modeUsdPerMin != null ? fmtUSD(modeUsdPerMin) + "/min" : "—"}`;
      detail.textContent = text;
      row.appendChild(detail);

      el.appendChild(row);
    }

    const pricingCaption = document.createElement("div");
    pricingCaption.className = "delegation-stats-caption";
    pricingCaption.textContent =
      "Dollar figures apply Anthropic API token rates — informational only. Claude subscriptions (Max/Pro) bill by plan, not per token; this is what the same work would cost via the API. Rates are refreshed with each extension update.";
    el.appendChild(pricingCaption);
  }

  // Re-render once a second so any active agent's live time keeps advancing
  // between state pushes.
  setInterval(() => {
    if (lastMetrics.length && lastMetrics.some((a) => (a.status || "").toLowerCase() === "active")) {
      renderMetrics(lastMetrics);
    }
    // Advisory-only stall check: re-render the plan section when the
    // isPlanStalled() verdict actually flips, so the note can appear/disappear
    // without waiting for a new PLAN_STATE/state push.
    if (projectPlanEnabled) {
      const stalled = isPlanStalled();
      if (stalled !== lastPlanStallState) {
        lastPlanStallState = stalled;
        renderProjectPlanSection();
      }
    }
  }, 1000);

  // ── Settings (Phase 2) ──────────────────────────────────────────

  /**
   * Most recent settings payload from the host.
   * @type {{hook:{installed:boolean,lastActivityAt:number|null}, agents:Array<{id:string,name:string,model:("opus"|"sonnet"|"haiku"|null),isOrchestrator:boolean,keywords:string}>}|null}
   */
  let lastSettings = null;

  /** Cost weight by model (relative price); used for savings estimates. */
  const COST_WEIGHT = { opus: 15, sonnet: 3, haiku: 0.8 };

  /** Relative capability/cost rank of each model (lower = cheaper/lighter). */
  const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };

  /**
   * Highest model an agent should normally need. When an agent is set above
   * its floor we proactively suggest stepping down to the cheaper model.
   */
  const SUGGESTED_MAX = {
    "search-retrieval": "haiku",
    "testing-specialist": "haiku",
    "workspace-monitor": "haiku",
  };

  /**
   * Format a timestamp as a short relative time ("3m ago", "—" if null).
   * @param {number|null|undefined} ts
   * @returns {string}
   */
  function relativeTime(ts) {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    if (diff < 0) return "just now";
    const sec = Math.floor(diff / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }

  /**
   * Compute savings percent moving from a (more expensive) current model to a
   * cheaper one. Returns a non-negative integer.
   * @param {string} current
   * @param {string} cheaper
   * @returns {number}
   */
  function savingsPct(current, cheaper) {
    const c = COST_WEIGHT[current];
    const ch = COST_WEIGHT[cheaper];
    if (!c || !ch) return 0;
    return Math.max(0, Math.round((1 - ch / c) * 100));
  }

  /** Find the metrics entry matching an agent id (or null). */
  function metricsFor(id) {
    return lastMetrics.find((m) => m && m.id === id) || null;
  }

  /**
   * Compute a recommendation for an agent given its settings + metrics.
   * @param {{id:string,model:string|null,isOrchestrator:boolean}} agent
   * @param {{taskCount?:number}|null} m
   * @returns {{text:string, suggest:(string|null), kind:"amber"|"info"}|null}
   */
  function recommendationFor(agent, m) {
    const model = agent.model;
    const taskCount = (m && m.taskCount) || 0;

    // Proactive down-size: agent is set above its suggested floor. This
    // supersedes (and replaces) the old search-retrieval-only rule, and when
    // it fires we skip the generic opus→sonnet suggestion below to avoid
    // double-recommending.
    const floor = !agent.isOrchestrator ? SUGGESTED_MAX[agent.id] : undefined;
    if (floor && model && MODEL_RANK[model] > MODEL_RANK[floor]) {
      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      return {
        text: `Could run on ${cap(floor)} — ${agent.name || agent.id} handles routine work that rarely needs ${cap(model)} (~${savingsPct(model, floor)}% cheaper)`,
        suggest: floor,
        kind: "amber",
      };
    }

    if (model === "opus" && !agent.isOrchestrator && taskCount >= 1) {
      return {
        text: `Opus is heavy for routine work; Sonnet ~${savingsPct("opus", "sonnet")}% cheaper`,
        suggest: "sonnet",
        kind: "amber",
      };
    }
    if (taskCount === 0 && !agent.isOrchestrator && agent.id !== "primary-agent") {
      return {
        text: "No tasks yet — check routing keywords",
        suggest: null,
        kind: "info",
      };
    }
    return null;
  }

  /**
   * Compute the routing fallback note for the keyword-routing section.
   * `light` drives the traffic-light dot: green = healthy, red = high
   * fallback rate, yellow = not enough data yet.
   * @returns {{text:string, kind:"amber"|"info", light:"green"|"yellow"|"red"}}
   */
  function fallbackNote() {
    const total = lastMetrics.reduce((sum, m) => sum + ((m && m.taskCount) || 0), 0);
    if (total < 5) return { text: "Routing health: not enough data", kind: "info", light: "yellow" };
    const primary = metricsFor("primary-agent");
    const primaryTasks = (primary && primary.taskCount) || 0;
    const ratio = primaryTasks / total;
    if (ratio > 0.2) {
      const pct = Math.round(ratio * 100);
      return {
        text: `High fallback rate (${pct}%): tune keywords so work routes to specialists.`,
        kind: "amber",
        light: "red",
      };
    }
    return { text: "Routing healthy", kind: "info", light: "green" };
  }

  /** Build a section wrapper with a heading. */
  function buildSection(title) {
    const section = document.createElement("section");
    section.className = "settings-section";
    const h = document.createElement("h2");
    h.className = "settings-heading";
    h.textContent = title;
    section.appendChild(h);
    return section;
  }

  /** Flash a small "saved ✓" note inside a row element. */
  function flashSaved(rowEl) {
    if (!rowEl) return;
    let note = rowEl.querySelector(".settings-saved");
    if (!note) {
      note = document.createElement("span");
      note.className = "settings-saved";
      rowEl.appendChild(note);
    }
    note.classList.remove("settings-error-note");
    note.textContent = "saved ✓";
  }

  /** Show an inline error inside a row element. */
  function flashError(rowEl, message) {
    if (!rowEl) return;
    let note = rowEl.querySelector(".settings-saved");
    if (!note) {
      note = document.createElement("span");
      note.className = "settings-saved";
      rowEl.appendChild(note);
    }
    note.classList.add("settings-error-note");
    note.textContent = message || "Failed";
  }

  /**
   * Handle a settingsUpdated ack from the host.
   * @param {{ok:boolean, id?:string, field?:string, error?:string}} msg
   */
  function handleSettingsUpdated(msg) {
    const row = msg.id
      ? setupConfigEl.querySelector(`[data-agent-row="${CSS.escape(msg.id)}"]`)
      : null;
    if (msg.ok) {
      flashSaved(row);
      // Refresh authoritative state from the host.
      vscode.postMessage({ type: "getSettings" });
    } else {
      flashError(row, msg.error || "Update failed");
      // On failure the host doesn't push a fresh "settings" message, so the
      // delegation-mode radios / review-pass checkbox (disabled while the
      // change was in flight) would otherwise stay stuck — re-enable here.
      if (msg.field === "delegationMode" && row) {
        row.querySelectorAll('input[type="radio"]').forEach((el) => { el.disabled = false; });
      } else if (msg.field === "reviewEnabled" && row) {
        row.querySelectorAll('input[type="checkbox"]').forEach((el) => { el.disabled = false; });
      }
    }
  }

  /**
   * Handle a metricsReset ack from the host.
   * @param {{ok:boolean, error?:string}} msg
   */
  function handleMetricsReset(msg) {
    if (msg.ok) {
      // Bug fix: do NOT blank the metrics table / delegation stats here.
      // The host's runtime.reset() + WorkerRegistered re-seed loop already
      // fires onChange -> a "state" message (see the msg.type === "state"
      // handler above, L6442) carrying the full roster with zeroed stats,
      // and that "state" message arrives BEFORE this metricsReset ack.
      // Clearing lastMetrics/renderMetrics/renderDelegationStats here ran
      // AFTER that correct re-seed render and wiped it out, leaving the
      // AGENT METRICS table empty until the next task's "state" push.
      // renderMetrics()/renderDelegationStats() are driven by the "state"
      // handler (L6459-6460) and self-maintain lastMetrics (see
      // renderMetrics, L7790) — nothing to do here.
      renderSettings();
      // ── Bug fix: also clear persisted badge/build/rebirth WORLD state so
      // the medal count + built objects actually disappear on Reset, instead
      // of surviving Reset/reload/upgrade via the webview's own getState()
      // cache and buildBuiltCount (requiredRebirthBadgeIds is intentionally
      // left alone — it's the host-driven requirement definition, not
      // progress, and gets repopulated by the next host payload). ──────────
      unlockedBadgeIds = new Set();
      // Also clear the per-badge dot-tracking working sets/maps (ALL themes —
      // badgeKnownByTheme/badgeUnseenByTheme are keyed by theme_id, not just
      // the current one) so a full Reset leaves no stale "known" baseline
      // that would suppress a dot on a badge re-earned after Reset.
      unseenBadgeIds = new Set();
      knownBadgeIds = new Set();
      badgeUnseenByTheme = {};
      badgeKnownByTheme = {};
      cycleObjectsBuilt = 0;
      cycleRivalsEvicted = 0;
      cyclePeakActive = 0;
      rebirthCount = 0;
      rebirthBaseline = { built: 0, evicted: 0, tasks: 0 };
      // buildBuiltCount/buildCurrentProgress drive the WORLD's visible built
      // objects (see computeBuildState) — a separate counter from
      // cycleObjectsBuilt (badge/rebirth-cycle progress only). Without
      // zeroing these the built objects stay visible after Reset.
      buildBuiltCount = 0;
      buildCurrentProgress = 0;
      // Ranged weapons must re-lock on Reset too — the weapons rack is a
      // rebirthCount>=1 unlock, and rebirthCount was just zeroed above. D4:
      // this is a full data wipe (prev.rebirth is deleted below too), so the
      // durable permanent-unlock flag and the rack's queued position are
      // cleared along with it — unlike doRebirth(), which must never touch
      // either.
      rangedUnlocked = false;
      rangedPermanentlyUnlocked = false;
      rackInsertIndex = null;
      // Purge the persisted blob so a reload can't rehydrate stale progress.
      try {
        const prev = vscode.getState() || {};
        delete prev.rebirth;
        delete prev.badgeUnseenByTheme;
        delete prev.badgeKnownByTheme;
        vscode.setState(prev);
      } catch (e) { /* best-effort */ }
      renderBadgePanel();
      renderRebirthPanel();
      // Mirrors the update site used everywhere else the unlocked count
      // changes (see updateBadgeHud, L708) rather than duplicating its
      // hidden/pop-animation logic here.
      updateBadgeHud();
    } else if (dangerStatusEl) {
      dangerStatusEl.textContent = msg.error || "Reset failed";
      dangerStatusEl.classList.add("settings-error-note");
    }
  }

  /** Reference to the danger-zone status line (set during render). */
  let dangerStatusEl = null;

  /** Render all settings sections into #setup-config from lastSettings. */
  function renderSettings() {
    if (!setupConfigEl) return;
    setupConfigEl.innerHTML = "";
    dangerStatusEl = null;

    if (!lastSettings) {
      const p = document.createElement("p");
      p.className = "settings-empty";
      p.textContent = "Loading settings…";
      setupConfigEl.appendChild(p);
      return;
    }

    const agents = lastSettings.agents || [];
    const hook = lastSettings.hook || { installed: false, lastActivityAt: null };

    // ── 1. Hook health ──
    const hookSection = buildSection("Hook health");
    const hookRow = document.createElement("div");
    hookRow.className = "settings-row hook-row";
    const hookStatus = document.createElement("div");
    hookStatus.className = "hook-status";
    const installedLine = document.createElement("div");
    installedLine.className = hook.installed ? "hook-ok" : "hook-bad";
    installedLine.textContent = hook.installed ? "Hook installed ✓" : "Hook installed ✗";
    const activityLine = document.createElement("div");
    activityLine.className = "hook-activity";
    activityLine.textContent = `Last activity: ${relativeTime(hook.lastActivityAt)}`;
    hookStatus.appendChild(installedLine);
    hookStatus.appendChild(activityLine);
    const hookHealth = (lastSettings.hookHealth) || { healthy: true, issueCount: 0 };
    const healthLine = document.createElement("div");
    healthLine.className = hookHealth.healthy ? "hook-ok" : "hook-warn";
    healthLine.textContent = hookHealth.healthy
      ? "✓ Hooks healthy — no issues detected"
      : `⚠ ${hookHealth.issueCount} issue(s) detected`;
    hookStatus.appendChild(healthLine);
    const troubleshootBtn = document.createElement("button");
    troubleshootBtn.className = "skill-btn settings-btn";
    troubleshootBtn.textContent = "Troubleshoot & Fix";
    troubleshootBtn.addEventListener("click", () => {
      troubleshootBtn.disabled = true;
      troubleshootBtn.textContent = "Checking…";
      vscode.postMessage({ type: "runDoctor" });
    });
    if (hookHealth.healthy) {
      troubleshootBtn.disabled = true;
      troubleshootBtn.classList.add("btn-disabled");
    }
    hookRow.appendChild(hookStatus);
    hookRow.appendChild(troubleshootBtn);
    hookSection.appendChild(hookRow);
    const doctorResultsEl = document.createElement("div");
    doctorResultsEl.id = "doctor-results";
    hookSection.appendChild(doctorResultsEl);

    // ── Legacy/foreign managed CLAUDE.md block removal (Settings entry point) ──
    // Same affordance as the Setup Wizard Step-2 rows (renderSetupOptionals)
    // for users who already had hooks installed before this feature shipped
    // and so never see the wizard. One row per detected non-tycoon managed
    // block (legacy config carried over from a prior setup, or a
    // currently-installed other tool's own block). Clicking Remove posts
    // "removeManagedBlock" with that block's namespace, which re-triggers
    // _handleGetSettings host-side, reposting "settings" with the block gone
    // from foreignManagedBlocks, so the row disappears (replaced by a
    // "✓ Removed" line) on the next renderSettings() without a manual reload.
    const settingsForeignBlocks = Array.isArray(lastSettings.foreignManagedBlocks)
      ? lastSettings.foreignManagedBlocks
      : [];
    settingsForeignBlocks.forEach(function (block) {
      const ns = block.namespace;
      const legacyRow = document.createElement("div");
      legacyRow.id = "settings-managed-block-row-" + ns;
      legacyRow.className = "settings-row";
      const legacyText = document.createElement("span");
      const lineNote = typeof block.lines === "number" && block.lines > 0 ? " (" + block.lines + " lines)" : "";
      legacyText.textContent = "Legacy config block `" + ns + ":*` detected in CLAUDE.md" + lineNote;
      legacyRow.appendChild(legacyText);
      const legacyBtn = document.createElement("button");
      legacyBtn.id = "settings-remove-managed-block-btn-" + ns;
      legacyBtn.className = "skill-btn settings-btn";
      legacyBtn.textContent = "Remove";
      legacyBtn.addEventListener("click", () => {
        legacyBtn.disabled = true;
        legacyBtn.textContent = "Removing…";
        managedBlockRemovalRequested.add(ns);
        vscode.postMessage({ type: "removeManagedBlock", namespace: ns });
      });
      legacyRow.appendChild(legacyBtn);
      hookSection.appendChild(legacyRow);
    });
    managedBlockRemovalRequested.forEach(function (ns) {
      const stillPresent = settingsForeignBlocks.some(function (b) {
        return b.namespace === ns;
      });
      if (!stillPresent) {
        const legacyConfirm = document.createElement("p");
        legacyConfirm.id = "settings-managed-block-confirm-" + ns;
        legacyConfirm.className = "settings-empty";
        legacyConfirm.textContent = "✓ Removed legacy config block `" + ns + ":*`";
        hookSection.appendChild(legacyConfirm);
      }
    });

    setupConfigEl.appendChild(hookSection);

    // ── 1.5. Delegation style (Team Lead Mode, Phase 2) ──
    // Same radio block + exact copy as the pre-install setup-view picker
    // (#delegation-mode-group in the HTML), rebuilt here so it reflects the
    // project's actual current mode and applies changes immediately.
    const delegSection = buildSection("Delegation style");
    const delegRow = document.createElement("div");
    delegRow.className = "settings-row";
    delegRow.dataset.agentRow = "delegation-mode";
    const delegGroup = document.createElement("div");
    delegGroup.className = "delegation-mode-group";
    const currentDelegationMode = lastSettings.delegation_mode === "team_leads" ? "team_leads" : "flat";
    const delegOptions = [
      {
        value: "flat",
        label: "Direct (recommended for most projects)",
        help: "The orchestrator briefs specialist workers directly — it does the reviewing itself. Lowest coordination cost; best for focused fixes.",
      },
      {
        value: "team_leads",
        label: "Team Leads",
        help: "Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs — many features across many files — where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Direct.",
      },
    ];
    const delegInputs = [];
    for (const opt of delegOptions) {
      const optLabel = document.createElement("label");
      optLabel.className = "delegation-mode-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "settings-delegation-mode";
      input.value = opt.value;
      if (currentDelegationMode === opt.value) input.checked = true;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        delegInputs.forEach((el) => { el.disabled = true; });
        vscode.postMessage({ type: "setDelegationMode", delegation_mode: opt.value });
      });
      delegInputs.push(input);
      const body = document.createElement("span");
      body.className = "delegation-mode-option-body";
      const labelSpan = document.createElement("span");
      labelSpan.className = "delegation-mode-option-label";
      labelSpan.textContent = opt.label;
      const helpSpan = document.createElement("span");
      helpSpan.className = "delegation-mode-option-help";
      helpSpan.textContent = opt.help;
      body.appendChild(labelSpan);
      body.appendChild(helpSpan);
      optLabel.appendChild(input);
      optLabel.appendChild(body);
      delegGroup.appendChild(optLabel);
    }
    const delegFootnote = document.createElement("p");
    delegFootnote.className = "delegation-mode-footnote";
    delegFootnote.textContent = "You can change this anytime in Settings. Switching updates this project's agent roster and delegation instructions.";
    delegGroup.appendChild(delegFootnote);
    delegRow.appendChild(delegGroup);
    delegSection.appendChild(delegRow);
    setupConfigEl.appendChild(delegSection);

    // ── 1.5b. Review pass (optional, on by default) ──
    // Composes with either delegation style above rather than being a third
    // radio — a separate checkbox row in the same "Delegation style" section.
    const reviewRow = document.createElement("div");
    reviewRow.className = "settings-row";
    reviewRow.dataset.agentRow = "review-enabled";
    const reviewGroup = document.createElement("div");
    reviewGroup.className = "delegation-mode-group";
    const reviewOptLabel = document.createElement("label");
    reviewOptLabel.className = "delegation-mode-option review-pass-option";
    const reviewCheckbox = document.createElement("input");
    reviewCheckbox.type = "checkbox";
    reviewCheckbox.id = "review-pass-enabled-checkbox";
    // Absent/undefined reads as enabled — the toggle is on by default.
    reviewCheckbox.checked = lastSettings.reviewEnabled !== false;
    reviewCheckbox.addEventListener("change", () => {
      reviewCheckbox.disabled = true;
      vscode.postMessage({ type: "setReviewEnabled", enabled: reviewCheckbox.checked });
    });
    const reviewBody = document.createElement("span");
    reviewBody.className = "delegation-mode-option-body";
    const reviewLabelSpan = document.createElement("span");
    reviewLabelSpan.className = "delegation-mode-option-label";
    reviewLabelSpan.textContent = "Review pass (optional, on by default)";
    const reviewHelpSpan = document.createElement("span");
    reviewHelpSpan.className = "delegation-mode-option-help";
    reviewHelpSpan.textContent = "Routes each significant change through a reviewer agent before it's marked done. Catches bugs and regressions early; roughly 20-40% more tokens on non-trivial tasks. Turn off for speed/lowest cost.";
    reviewBody.appendChild(reviewLabelSpan);
    reviewBody.appendChild(reviewHelpSpan);
    reviewOptLabel.appendChild(reviewCheckbox);
    reviewOptLabel.appendChild(reviewBody);
    reviewGroup.appendChild(reviewOptLabel);
    reviewRow.appendChild(reviewGroup);
    delegSection.appendChild(reviewRow);

    // ── 1.6. Project Plan (optional) ──
    // Opt-in toggle for the Project Plan tab in the metrics panel (see
    // #project-plan-body / renderProjectPlanSection()).
    // Reuses the same checkbox-row visual language as the theme builder's
    // "Pause after each image" toggle.
    const planSection = buildSection("Project Plan");
    const planRow = document.createElement("div");
    planRow.className = "settings-row";
    planRow.dataset.agentRow = "project-plan-enabled";
    const planLabel = document.createElement("label");
    planLabel.className = "theme-generation-approval-toggle";
    const planCheckbox = document.createElement("input");
    planCheckbox.type = "checkbox";
    planCheckbox.id = "project-plan-enabled-checkbox";
    planCheckbox.checked = projectPlanEnabled;
    planCheckbox.addEventListener("change", () => {
      vscode.postMessage({ type: "SET_PROJECT_PLAN_ENABLED", enabled: planCheckbox.checked });
    });
    projectPlanCheckboxEl = planCheckbox;
    const planTextWrap = document.createElement("span");
    const planTitle = document.createElement("span");
    planTitle.textContent = "Project Plan (optional, experimental)";
    const planNote = document.createElement("small");
    planNote.textContent = "Opt-in phase/task planning workflow with approve/retry controls. Off by default.";
    planTextWrap.appendChild(planTitle);
    planTextWrap.appendChild(planNote);
    planLabel.appendChild(planCheckbox);
    planLabel.appendChild(planTextWrap);
    planRow.appendChild(planLabel);
    planSection.appendChild(planRow);
    const planInstallHint = document.createElement("p");
    planInstallHint.className = "settings-empty";
    planInstallHint.textContent = "Auto-installed and kept up to date whenever Project Plan is enabled above — use this only to repair a damaged install.";
    planSection.appendChild(planInstallHint);
    const planInstallBtn = document.createElement("button");
    planInstallBtn.className = "skill-btn settings-btn";
    planInstallBtn.textContent = "Reinstall / Repair skill";
    planInstallBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "projectPlanAction" });
    });
    planSection.appendChild(planInstallBtn);
    setupConfigEl.appendChild(planSection);

    // ── 2. Agents ──
    const agentsSection = buildSection("Agents");
    for (const agent of agents) {
      const m = metricsFor(agent.id);
      const row = document.createElement("div");
      row.className = "settings-row agent-row";
      row.dataset.agentRow = agent.id;

      const head = document.createElement("div");
      head.className = "agent-row-head";

      const nameEl = document.createElement("span");
      nameEl.className = "agent-name";
      nameEl.textContent = agent.name || agent.id;
      head.appendChild(nameEl);

      if (agent.isOrchestrator) {
        const ro = document.createElement("span");
        ro.className = "agent-model-readonly";
        ro.textContent = "session model (set by Claude Code)";
        head.appendChild(ro);
      } else {
        const group = document.createElement("div");
        group.className = "model-radio-group";
        const groupName = `model-${agent.id}`;
        // Most-advanced first, left to right: Fable > Opus > Sonnet > Haiku.
        for (const model of ["fable", "opus", "sonnet", "haiku"]) {
          const lbl = document.createElement("label");
          lbl.className = "model-radio";
          const input = document.createElement("input");
          input.type = "radio";
          input.name = groupName;
          input.value = model;
          if (agent.model === model) input.checked = true;
          input.addEventListener("change", () => {
            if (input.checked) {
              vscode.postMessage({ type: "setAgentModel", id: agent.id, model });
            }
          });
          const span = document.createElement("span");
          span.textContent = model.charAt(0).toUpperCase() + model.slice(1);
          lbl.appendChild(input);
          lbl.appendChild(span);
          group.appendChild(lbl);
        }
        head.appendChild(group);

        // Per-agent RED Remove button. Non-orchestrator agents only (the
        // orchestrator is core and has no model radios / no remove). The host
        // shows the native "are you sure?" confirm and re-posts the roster on
        // success, so the webview only requests the removal + shows a pending
        // state; handleAgentRemoved() restores/reflects the outcome.
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "skill-btn skill-btn--remove agent-remove-btn";
        removeBtn.textContent = "Remove";
        removeBtn.dataset.removeAgentId = agent.id;
        removeBtn.addEventListener("click", () => {
          removeBtn.disabled = true;
          removeBtn.textContent = "Removing…";
          vscode.postMessage({ type: "removeAgent", id: agent.id });
        });
        head.appendChild(removeBtn);
      }
      row.appendChild(head);

      // Stats from matched metrics
      const stats = document.createElement("div");
      stats.className = "agent-stats";
      const mins = m && m.activeMs ? m.activeMs / 60000 : 0;
      // Rough estimated $/min burn rate (see estCostUSD) — falls back to the
      // settings-configured agent.model if the metrics record has none yet.
      const chipCostUSD = m ? estCostUSD(m.tokens, m.model || agent.model) : null;
      const chipUsdPerMin = chipCostUSD != null && mins > 0 ? chipCostUSD / mins : null;
      const chip = (label, value) => {
        const c = document.createElement("span");
        c.className = "stat-chip";
        c.textContent = `${label} ${value}`;
        return c;
      };
      stats.appendChild(chip("~$/min", fmtUSD(chipUsdPerMin)));
      stats.appendChild(chip("tasks", String((m && m.taskCount) || 0)));
      stats.appendChild(chip("MCP", String((m && m.mcpCount) || 0)));
      row.appendChild(stats);

      // Recommendation badge
      const rec = recommendationFor(agent, m);
      if (rec) {
        const badge = document.createElement("div");
        badge.className = `rec-badge rec-${rec.kind}`;
        const txt = document.createElement("span");
        txt.className = "rec-text";
        txt.textContent = rec.text;
        badge.appendChild(txt);
        if (rec.suggest) {
          const apply = document.createElement("button");
          apply.className = "skill-btn settings-btn rec-apply";
          apply.textContent = "Apply";
          apply.addEventListener("click", () => {
            vscode.postMessage({ type: "setAgentModel", id: agent.id, model: rec.suggest });
          });
          badge.appendChild(apply);
        }
        row.appendChild(badge);
      }

      agentsSection.appendChild(row);
    }
    setupConfigEl.appendChild(agentsSection);

    // ── 3. Keyword routing ──
    // Agents (non-orchestrator) whose keywords field is empty/whitespace —
    // keyword routing can never match them until the user sets a pattern.
    // Separate signal from the task-count-based "Routing health" line above.
    function unconfiguredKeywordAgents() {
      return (lastSettings.agents || []).filter(function (a) {
        return a && !a.isOrchestrator && (!a.keywords || String(a.keywords).trim() === "");
      });
    }

    const routingSection = buildSection("Keyword routing");
    const note = fallbackNote();
    const noteEl = document.createElement("div");
    noteEl.className = `routing-note rec-${note.kind}`;
    const light = document.createElement("span");
    light.className = `routing-light routing-light--${note.light}`;
    const noteText = document.createElement("span");
    noteText.className = "routing-note-text";
    noteText.textContent = note.text;
    noteEl.appendChild(light);
    noteEl.appendChild(noteText);
    routingSection.appendChild(noteEl);

    for (const agent of agents) {
      if (agent.isOrchestrator) continue;
      const row = document.createElement("div");
      row.className = "settings-row keyword-row";
      row.dataset.agentRow = agent.id;

      const lbl = document.createElement("label");
      lbl.className = "keyword-label";
      lbl.textContent = agent.name || agent.id;
      row.appendChild(lbl);

      const inputWrap = document.createElement("div");
      inputWrap.className = "keyword-input-wrap";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "keyword-input";
      input.value = agent.keywords || "";
      input.placeholder = "kw1|kw2|kw3";
      if (!agent.keywords || String(agent.keywords).trim() === "") {
        input.title = "No routing keywords set — routing to this agent is disabled";
        input.style.borderColor = "var(--status-error)";
      }
      const saveBtn = document.createElement("button");
      saveBtn.className = "skill-btn settings-btn";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "setAgentKeywords", id: agent.id, pattern: input.value });
      });
      inputWrap.appendChild(input);
      inputWrap.appendChild(saveBtn);
      row.appendChild(inputWrap);

      routingSection.appendChild(row);
    }

    const unconfiguredAgents = unconfiguredKeywordAgents();
    if (unconfiguredAgents.length > 0) {
      const unconfiguredEl = document.createElement("div");
      unconfiguredEl.className = "rec-badge rec-amber";
      const unconfiguredText = document.createElement("span");
      unconfiguredText.className = "rec-text";
      const names = unconfiguredAgents.map(function (a) { return a.name || a.id; }).join(", ");
      unconfiguredText.textContent = `⚠ ${unconfiguredAgents.length} agent${unconfiguredAgents.length === 1 ? "" : "s"} have no routing keywords — keyword routing to them is disabled until set: ${names}.`;
      unconfiguredEl.appendChild(unconfiguredText);
      routingSection.appendChild(unconfiguredEl);
    }
    setupConfigEl.appendChild(routingSection);

  // ── 3b. Delegation Health ──
  // Dual view: "this session" (scoped to the current Claude Code session id,
  // rebuilt host-side from activity.jsonl via computeStateFromRecords) vs.
  // "since last reset" (the pre-existing cumulative fields — unchanged shape,
  // back-compat; the log is cleared on Reset, so cumulative == since reset).
  const dhSection = buildSection("Delegation Health");
  const dh = (lastSettings && lastSettings.delegationHealth) || {};
  const cumDirectSearches = (typeof dh.directSearches === "number") ? dh.directSearches : 0;
  const cumDirectReads    = (typeof dh.directReads    === "number") ? dh.directReads    : 0;
  const cumDirectEdits    = (typeof dh.directEdits    === "number") ? dh.directEdits    : 0;
  const cumDelegations    = (typeof dh.delegations    === "number") ? dh.delegations    : 0;
  const cumTokens         = (typeof dh.tokens         === "number") ? dh.tokens         : 0;
  const warnThreshold     = (typeof dh.warnThreshold  === "number") ? dh.warnThreshold  : 5;
  // Session-scoped fields are additive on delegationHealth.session — absent
  // when the host couldn't determine a current session id (e.g. no hook
  // activity yet). hasSession gates the fallback described in the plan: no
  // session -> show only the cumulative "Since last reset" row.
  const sess = (dh.session && typeof dh.session === "object") ? dh.session : null;
  const hasSession = sess !== null;
  const sessDirectSearches = hasSession && typeof sess.directSearches === "number" ? sess.directSearches : 0;
  const sessDirectReads    = hasSession && typeof sess.directReads    === "number" ? sess.directReads    : 0;
  const sessDirectEdits    = hasSession && typeof sess.directEdits    === "number" ? sess.directEdits    : 0;
  const sessDelegations    = hasSession && typeof sess.delegations    === "number" ? sess.delegations    : 0;
  const sessTokens         = hasSession && typeof sess.tokens         === "number" ? sess.tokens         : 0;
  // Reads are allowed for known files (per CLAUDE.md) — they are NOT a leak, so
  // they are excluded from the ratio. Only direct Grep/Glob and edits count.
  const cumLeak = cumDirectSearches + cumDirectEdits;
  const cumTotal = cumDelegations + cumLeak;
  const sessLeak = sessDirectSearches + sessDirectEdits;
  const sessTotal = sessDelegations + sessLeak;
  // The actionable leak breakdown further down reflects THIS SESSION's
  // numbers when available, falling back to cumulative when no session
  // scoping could be determined (matching the single-row fallback above).
  const leakSearches = hasSession ? sessDirectSearches : cumDirectSearches;
  const leakReads = hasSession ? sessDirectReads : cumDirectReads;
  const leakEdits = hasSession ? sessDirectEdits : cumDirectEdits;
  const leakDelegations = hasSession ? sessDelegations : cumDelegations;
  if (cumTotal === 0 && sessTotal === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "settings-empty";
    emptyP.textContent = "No delegatable activity yet since the last reset.";
    dhSection.appendChild(emptyP);
  } else {
    // Renders one traffic-light row: "<label> — X% delegated (a of b) · ~N tokens".
    function delegationHealthRow(label, delegs, total, tokens) {
      const ratio = total > 0 ? delegs / total : 0;
      // Green / yellow / red traffic light, consistent with the rest of the UI.
      const light = total === 0
        ? { color: "var(--muted)", glow: false }
        : ratio >= 0.6
          ? { color: "var(--status-active)", glow: true }
          : ratio >= 0.35
            ? { color: "var(--status-done)", glow: false }
            : { color: "var(--status-error)", glow: false };
      const row = document.createElement("div");
      row.className = "settings-row";
      row.style.flexDirection = "row";
      row.style.alignItems = "center";
      row.style.gap = "6px";
      const dot = document.createElement("span");
      dot.style.display = "inline-block";
      dot.style.width = "9px";
      dot.style.height = "9px";
      dot.style.borderRadius = "50%";
      dot.style.background = light.color;
      if (light.glow) { dot.style.boxShadow = "0 0 5px " + light.color; }
      const span = document.createElement("span");
      span.style.fontWeight = "600";
      span.textContent = total > 0
        ? `${label} — ${Math.round(ratio * 100)}% delegated (${delegs} of ${total}) · ~${fmtTokens(tokens)} tokens`
        : `${label} — no activity yet`;
      row.appendChild(dot);
      row.appendChild(span);
      return row;
    }

    if (hasSession) {
      dhSection.appendChild(delegationHealthRow("This session", sessDelegations, sessTotal, sessTokens));
    }
    dhSection.appendChild(delegationHealthRow("Since last reset", cumDelegations, cumTotal, cumTokens));

    const searchRow = document.createElement("div");
    searchRow.className = "settings-row";
    const searchSpan = document.createElement("span");
    searchSpan.textContent = `Direct searches (Grep/Glob): ${leakSearches} — delegate to search-retrieval (Haiku, ~40x cheaper)`;
    if (leakSearches > warnThreshold) { searchSpan.style.color = "var(--status-error)"; }
    searchRow.appendChild(searchSpan);
    dhSection.appendChild(searchRow);

    const editRow = document.createElement("div");
    editRow.className = "settings-row";
    const editSpan = document.createElement("span");
    editSpan.textContent = `Direct edits: ${leakEdits} — delegate to ${resolveEditTargetLabel(agents)}`;
    editRow.appendChild(editSpan);
    dhSection.appendChild(editRow);

    const readRow = document.createElement("div");
    readRow.className = "settings-row";
    const readSpan = document.createElement("span");
    readSpan.style.color = "var(--muted)";
    readSpan.textContent = `Direct file reads: ${leakReads} — allowed for known files`;
    readRow.appendChild(readSpan);
    dhSection.appendChild(readRow);

    const noteRow = document.createElement("div");
    noteRow.className = "settings-row";
    const noteSpan = document.createElement("span");
    noteSpan.style.color = "var(--muted)";
    noteSpan.style.fontSize = "11px";
    noteSpan.textContent = hasSession
      ? "Breakdown above reflects this session; “Since last reset” totals every session's activity since the log was last cleared by Reset."
      : "No current session detected — breakdown reflects activity since the last reset (the log is cleared on Reset).";
    noteRow.appendChild(noteSpan);
    dhSection.appendChild(noteRow);

    // Builds the "Copy delegation tip" text live from this render's counters
    // (leakSearches/leakReads/leakEdits/leakDelegations — this session's
    // numbers when known, else cumulative — computed above from
    // lastSettings.delegationHealth) and the installed roster (`agents`,
    // computed at the top of renderSettings from lastSettings.agents). Keeps
    // the tip honest to the actual project + session instead of a fixed
    // 2-agent hardcoded string.
    function buildDelegationTip() {
      // Resolve the roster's edit/implementation target the same way the
      // Delegation Health panel's edit row and the generated delegation
      // doctrine do (resolveEditTargetLabel above; mirrors
      // delegationDoctrine.ts's renderPreamble/renderTeamLeadsSection):
      // prefer coding-specialist when it's actually installed, else
      // verse-expert (the UEFN roster's Verse-writing implementer, which
      // REPLACES coding-specialist on a UEFN project), else a generic
      // phrase — never a hardcoded id that might not be installed on this
      // project's roster.
      const editTargetLabel = resolveEditTargetLabel(agents);
      const leakTotal = leakSearches + leakEdits;
      const totalActions = leakDelegations + leakTotal;
      const ratio = totalActions > 0 ? leakDelegations / totalActions : 0;
      const lines = [];
      lines.push(
        totalActions > 0
          ? `Delegation this session: ${Math.round(ratio * 100)}% (${leakDelegations} delegated of ${totalActions} action${totalActions === 1 ? "" : "s"}).`
          : "Delegation this session: no delegatable activity yet."
      );
      const extensionVersion = document.querySelector(".menu-version")?.textContent?.trim();
      if (extensionVersion) {
        lines.push(`Extension: ${extensionVersion}`);
      }
      if (leakEdits > 0) {
        lines.push(`• ${leakEdits} direct edit${leakEdits === 1 ? "" : "s"} → send these to ${editTargetLabel}.`);
      }
      if (leakSearches > 0) {
        lines.push(`• ${leakSearches} direct search${leakSearches === 1 ? "" : "es"} → send these to search-retrieval (Haiku, ~40x cheaper).`);
      }
      if (leakEdits === 0 && leakSearches === 0 && leakDelegations > 0) {
        lines.push("Delegation looks healthy — keep routing work to specialists.");
      }
      if (leakReads > 0) {
        lines.push(`Known-file reads (${leakReads}) are fine — keep those direct per CLAUDE.md.`);
      }
      const cumTotalActions = cumDelegations + cumLeak;
      const cumRatio = cumTotalActions > 0 ? cumDelegations / cumTotalActions : 0;
      lines.push(
        cumTotalActions > 0
          ? `Since last reset: ${Math.round(cumRatio * 100)}% (${cumDelegations} of ${cumTotalActions}), ~${fmtTokens(cumTokens)} tokens.`
          : "Since last reset: no delegatable activity yet."
      );
      lines.push("");
      lines.push("Route by task type:");
      for (const agent of agents) {
        if (agent.isOrchestrator) continue;
        const modelLabel = agent.model || "default";
        const kws = (agent.keywords || "")
          .split("|")
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, 4);
        const hint = kws.length ? kws.join(", ") : "general tasks";
        lines.push(`• ${agent.name || agent.id} (${modelLabel}) → ${hint}`);
      }
      const searchTerms = ["search", "find", "grep", "glob", "look", "where", "locate", "explore"];
      const hasSearchAgent = agents.some((agent) => {
        if (agent.id === "search-retrieval") return true;
        const kwText = (agent.keywords || "").toLowerCase();
        return searchTerms.some((term) => kwText.includes(term));
      });
      if (!hasSearchAgent) {
        lines.push("• Search / find / grep → search-retrieval (Explore · Haiku, ~40x cheaper)");
      }
      lines.push("");
      lines.push("Task doesn't match any specialist's keywords? Route it to the Fallback Agent (Sonnet) — do not do it yourself on the orchestrator.");
      lines.push(`Reminder: any file edit/write → ${editTargetLabel}. Anything past a single known-path read (multi-file, exploring, auditing) → search-retrieval (Haiku).`);
      lines.push("");
      lines.push("Keep direct: reading known files, coordination, and talking to you.");
      const unconfiguredAgents = unconfiguredKeywordAgents();
      if (unconfiguredAgents.length > 0) {
        lines.push("");
        lines.push(`Routing not configured for: ${unconfiguredAgents.map((a) => a.name || a.id).join(", ")}`);
        lines.push("These agents have no keywords in .claude/tycoon/agent-keywords.json, so keyword routing can't send work to them. Please set sensible routing keywords for them.");
      }
      return lines.join("\n");
    }

    const btnRow = document.createElement("div");
    btnRow.className = "settings-row";
    const copyBtn = document.createElement("button");
    copyBtn.className = "skill-btn settings-btn";
    copyBtn.textContent = "Copy delegation tip";
    copyBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "copyNudge", text: buildDelegationTip() });
    });
    btnRow.appendChild(copyBtn);
    dhSection.appendChild(btnRow);
  }
  setupConfigEl.appendChild(dhSection);

    // ── 3c. Context budget ──
    const budgetSection = buildSection("Context budget");
    const cb = (lastSettings && lastSettings.contextBudget) || null;
    if (!cb) {
      const emptyNote = document.createElement("p");
      emptyNote.className = "settings-empty";
      emptyNote.textContent = "No context data.";
      budgetSection.appendChild(emptyNote);
    } else {
      /** @param {"ok"|"warn"|"high"} grade */
      function budgetDot(grade) {
        const dot = document.createElement("span");
        dot.style.display = "inline-block";
        dot.style.width = "8px";
        dot.style.height = "8px";
        dot.style.borderRadius = "50%";
        dot.style.marginRight = "6px";
        dot.style.flexShrink = "0";
        if (grade === "high") {
          dot.style.backgroundColor = "var(--status-error)";
        } else if (grade === "warn") {
          dot.style.backgroundColor = "var(--status-done)";
        } else {
          dot.style.backgroundColor = "var(--status-active)";
        }
        return dot;
      }
      /** @param {number} n */
      function formatK(n) {
        if (n >= 1000) return (Math.round(n / 100) / 10).toFixed(1) + "k";
        return String(n);
      }

      // Headline row
      const headlineRow = document.createElement("div");
      headlineRow.className = "settings-row";
      headlineRow.style.display = "flex";
      headlineRow.style.flexDirection = "row";
      headlineRow.style.alignItems = "center";
      headlineRow.style.justifyContent = "flex-start";
      headlineRow.style.textAlign = "left";
      headlineRow.style.gap = "6px";
      headlineRow.appendChild(budgetDot(cb.overall));
      const headlineText = document.createElement("span");
      headlineText.textContent = "Per prompt: ~" + formatK(cb.perPromptTokens) + " tokens (CLAUDE.md)";
      headlineRow.appendChild(headlineText);
      budgetSection.appendChild(headlineRow);

      // CLAUDE.md row
      const claudeRow = document.createElement("div");
      claudeRow.className = "settings-row";
      claudeRow.style.display = "flex";
      claudeRow.style.flexDirection = "row";
      claudeRow.style.alignItems = "center";
      claudeRow.style.justifyContent = "flex-start";
      claudeRow.style.textAlign = "left";
      claudeRow.style.gap = "6px";
      if (cb.claudeMd) {
        claudeRow.appendChild(budgetDot(cb.claudeMd.grade));
        const claudeText = document.createElement("span");
        claudeText.textContent = "CLAUDE.md: ~" + formatK(cb.claudeMd.tokens) + " tokens";
        claudeRow.appendChild(claudeText);
      } else {
        const noDot = document.createElement("span");
        noDot.style.width = "14px";
        noDot.style.display = "inline-block";
        claudeRow.appendChild(noDot);
        const missingText = document.createElement("span");
        missingText.textContent = "CLAUDE.md: not found";
        claudeRow.appendChild(missingText);
      }
      budgetSection.appendChild(claudeRow);

      // Agent file rows. Size alone is not a defect for an agent file — a
      // legitimately large REFERENCE/knowledge agent (e.g. a domain-expert
      // agent) is correctly large by design, so "warn"/"high" here read as
      // informational, not as a "trim this" verdict — never single out a
      // specific agent as bloat.
      const agentFiles = Array.isArray(cb.agents) ? cb.agents : [];
      for (const af of agentFiles) {
        const agentRow = document.createElement("div");
        agentRow.className = "settings-row";
        agentRow.style.display = "flex";
        agentRow.style.flexDirection = "row";
        agentRow.style.alignItems = "center";
        agentRow.style.justifyContent = "flex-start";
        agentRow.style.textAlign = "left";
        agentRow.style.gap = "6px";
        agentRow.appendChild(budgetDot(af.grade));
        const agentText = document.createElement("span");
        agentText.textContent = af.name + ": ~" + formatK(af.tokens) + " tokens";
        if (af.grade === "warn" || af.grade === "high") {
          agentText.textContent += " (large — reference agents can be intentionally large)";
        }
        agentRow.appendChild(agentText);
        budgetSection.appendChild(agentRow);
      }

      // Muted note
      const agentNote = document.createElement("p");
      agentNote.className = "settings-empty";
      agentNote.textContent = "Agent files load per sub-agent spawn, not every prompt. Size alone isn't a problem — a reference/knowledge agent is expected to be larger.";
      budgetSection.appendChild(agentNote);

      // Review for trimming button
      const trimBtn = document.createElement("button");
      trimBtn.className = "skill-btn settings-btn";
      trimBtn.textContent = "Review for trimming";
      trimBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "copyPrompt", text: "Review CLAUDE.md and the agent definition files in .claude/agents/ for context that can be tightened. CLAUDE.md is loaded into every prompt, so prioritize it: flag verbose, duplicated, or non-essential lines and propose a tighter rewrite that preserves every behavioral rule and the delegation routing. Then look at each .claude/agents/*.md (loaded per spawn, not every prompt) — but only flag a file if it has genuine verbosity or duplication to cut; a large reference/knowledge agent (e.g. a domain-expert agent with a big fact table) can be intentionally large and should not be flagged just because of its size. For any file with real cuts available, give a before/after token estimate and the specific cuts." });
      });
      budgetSection.appendChild(trimBtn);
    }

    // Legacy/foreign managed CLAUDE.md blocks (see legacyDoctrine.ts
    // detectForeignManagedBlocks) are surfaced with an actionable Remove
    // row under "Hook health" above, not duplicated here.

    setupConfigEl.appendChild(budgetSection);

    // ── 4. Design docs ──
    const docsSection = buildSection("Design docs");
    const docsDesc = document.createElement("p");
    docsDesc.className = "settings-empty";
    docsDesc.textContent = "Generate a design doc (GDD/PRD) from what's built, or review one you've edited. Installs the design-doc skill and copies a prompt to paste into Claude Code.";
    docsSection.appendChild(docsDesc);
    const generateBtn = document.createElement("button");
    generateBtn.className = "skill-btn settings-btn";
    generateBtn.textContent = "Generate design doc";
    generateBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "designDocAction", mode: "generate" });
    });
    docsSection.appendChild(generateBtn);
    const reviewBtn = document.createElement("button");
    reviewBtn.className = "skill-btn settings-btn";
    reviewBtn.textContent = "Review design docs";
    reviewBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "designDocAction", mode: "review" });
    });
    docsSection.appendChild(reviewBtn);
    setupConfigEl.appendChild(docsSection);

    // ── 5. Report a bug / Diagnostics ──
    // Sanitized Markdown snapshot of the health signals already computed
    // above (hook health, delegation mode, doctrine health, context budget,
    // roster consistency, engine/UEFN status) — see diagnosticReport.ts.
    // Purely local: no network call, no runtime AI. The host writes the
    // report, opens it for review, and copies it to the clipboard so the
    // user can paste it wherever they report bugs.
    const diagSection = buildSection("Report a bug / Diagnostics");
    const diagDesc = document.createElement("p");
    diagDesc.className = "settings-empty";
    diagDesc.textContent = "Creates a sanitized report of your TycoonAgents setup you can send to the maintainer. Absolute paths and secrets are stripped — review before sharing.";
    diagSection.appendChild(diagDesc);
    const diagDeeperNote = document.createElement("p");
    diagDeeperNote.className = "settings-empty";
    diagDeeperNote.textContent = "For a deeper, reasoned analysis, run /tycoon-diagnose in Claude Code.";
    diagSection.appendChild(diagDeeperNote);
    const diagBtn = document.createElement("button");
    diagBtn.className = "skill-btn settings-btn";
    diagBtn.textContent = "Generate diagnostic report";
    diagBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "generateDiagnostic" });
    });
    diagSection.appendChild(diagBtn);
    setupConfigEl.appendChild(diagSection);

    // ── 6. Danger zone ──
    const dangerSection = buildSection("Danger zone");
    dangerSection.classList.add("danger-section");
    const dangerRow = document.createElement("div");
    dangerRow.className = "settings-row danger-row";
    const resetBtn = document.createElement("button");
    resetBtn.className = "skill-btn settings-btn danger-btn";
    resetBtn.textContent = "Reset session metrics";
    resetBtn.addEventListener("click", () => {
      showResetConfirmModal();
    });
    dangerStatusEl = document.createElement("span");
    dangerStatusEl.className = "danger-status";
    dangerRow.appendChild(resetBtn);
    dangerRow.appendChild(dangerStatusEl);
    dangerSection.appendChild(dangerRow);
    setupConfigEl.appendChild(dangerSection);
  }

  // drawWorker (placeholder stick figures) and drawBuildings (placeholder
  // cityscape) were removed: entities render only as real themed art, popping
  // in on their first decoded frame. See the sprite draw paths in render().

  function drawHUD(w) {
    // Upper-left session/agents/built overlay removed — redundant + overlapped the UEFN chips.
    // Kept as a no-op so existing call sites stay valid.
  }

  // ── Roster strip (Feature 2 / Change 3) ─────────────────────────────────
  // The roster is now hosted inside the Themes modal (renderThemesList injects it).
  // buildRosterStrip() is kept as a no-op so existing call sites remain valid.
  function buildRosterStrip() {
    // Roster is rendered inside the Themes modal via renderThemesList.
    // This function intentionally does nothing to the stage DOM.
  }

  // ── Phase 2a: build-state derivation ─────────────────────────────────────
  /**
   * Derive the current build status FROM THE BUILD QUEUE (Change 1) — one
   * object at a time, time-paced, rather than proportionally filling from
   * state.completedTasks. For queue index i → object_id:
   *   i < buildBuiltCount  → BUILT
   *   i === buildBuiltCount → ACTIVE (activeProgress = buildCurrentProgress)
   *   i > buildBuiltCount  → UNBUILT (hidden)
   * Pure function of (buildQueue, buildBuiltCount, buildCurrentProgress) —
   * cheap to call once per render() frame.
   * @returns {{builtIds: Set<string>, activeId: string|null, activeProgress: number}}
   */
  function computeBuildState() {
    const builtIds = new Set();
    for (let i = 0; i < buildBuiltCount && i < buildQueue.length; i++) {
      builtIds.add(buildQueue[i]);
    }
    const activeId = buildBuiltCount < buildQueue.length ? buildQueue[buildBuiltCount] : null;
    const activeProgress = activeId !== null ? buildCurrentProgress : 0;
    return { builtIds, activeId, activeProgress };
  }

  /**
   * Advance the paced build queue by one frame (Change 1). Progress on the
   * current active object only moves while at least one ACTIVE agent is
   * actually AT the standoff spot building it (clip === "build", i.e.
   * isBuilding && !isMoving) — set via markBuilderPresent() during the
   * per-agent loop below, read here once per frame. Enemy presence preempts
   * building entirely (EVICT mode pauses the queue).
   * @param {number} delta seconds
   * @param {boolean} enemiesAlive whether any enemy is currently active
   */
  function updateBuildProgress(delta, enemiesAlive) {
    if (buildQueue.length === 0) return;
    const activeObjId = buildBuiltCount < buildQueue.length ? buildQueue[buildBuiltCount] : null;
    if (!activeObjId) return; // all built
    // Incremental RATE stays gated: enemies, conga, and "no builder" pause the
    // per-frame advance. The >=1 completion check is NOT gated here — it runs
    // unconditionally in completeBuildIfReady() (called every frame).
    if (enemiesAlive) return; // enemy preemption pauses building
    if (congaActive) return; // conga easter-egg pauses building (like enemies)
    if (buildProgressBuilderCount <= 0) return; // no one actively building right now
    // N builders on the SAME active object build it N× faster. D2: each
    // rebirth compounds a further +20% build speed (does NOT change
    // completeBuildIfReady()'s >=1 completion threshold, only the rate).
    const buildSpeedMultiplier = Math.pow(1.2, rebirthCount);
    // Linear per-object ramp: the object being built is buildQueue[buildBuiltCount].
    // Clamp the index so per-agent duration never grows past the last queued object.
    const buildIdx = Math.min(Math.max(buildBuiltCount, 0), Math.max(themeBuildables.length - 1, 0));
    const perAgentSeconds = FIRST_BUILD_SECONDS + buildIdx * BUILD_SECONDS_PER_OBJECT;
    buildCurrentProgress += (buildProgressBuilderCount * delta * buildSpeedMultiplier) / perAgentSeconds;
  }

  /**
   * Ungated completion check: whenever buildCurrentProgress has reached 1,
   * transition the active object to POOF (or advance directly if no poof
   * art). Runs every frame regardless of enemy/conga/builder gating.
   */
  function completeBuildIfReady() {
    if (buildQueue.length === 0) return;
    const activeObjId = buildBuiltCount < buildQueue.length ? buildQueue[buildBuiltCount] : null;
    if (!activeObjId) return; // all built
    if (buildCurrentProgress < 1) return;
    buildCurrentProgress = 1;
    const entry = objectAnimMap[activeObjId];
    const canPoof = themeHasPoofAsset && themeImages.poof && themeImages.poof.length > 0;
    if (entry && canPoof) {
      // Transition to POOF; buildBuiltCount advances once the poof
      // one-shot completes (handled in the per-object anim-advance pass).
      if (entry.phase !== "poof") {
        entry.phase = "poof";
        entry.animState = createAnimState("poof");
        // Celebration: the agents that were building this object dance for 5s.
        // The phase!="poof" guard makes this a one-shot per completed object.
        celebrateBuildContributors();
      }
    } else {
      // No poof art (or no entry yet) — skip straight to built, no crash.
      buildBuiltCount++;
      cycleObjectsBuilt++;
      persistRebirth();
      saveBuildProgress();
      buildCurrentProgress = 0;
      // Celebration (no-poof fast path): builders dance on completion. This
      // branch runs exactly once per object (progress reset to 0 right after).
      celebrateBuildContributors();
    }
  }

  /**
   * Trigger the 5s celebration dance on every agent that contributed to the
   * just-completed active object (see currentBuildContributors). Guarded for
   * existence. F-key completions with no contributors simply do nothing.
   */
  function celebrateBuildContributors() {
    for (const id of currentBuildContributors) {
      const ce = agentCharMap[id];
      if (ce) {
        startAgentDance(ce);
        if (Math.random() < HAPPY_BUBBLE_CHANCE) showExpression(ce, 4, 1.8);
      }
    }
  }

  // ── Phase 2b: enemy / EVICT mode helpers ─────────────────────────────────
  /**
   * Pick a random point on a walkable-polygon edge (native coords) — used as
   * an enemy spawn point so waves visibly walk in from the map boundary.
   * @param {number[][]} poly
   * @returns {number[]} [nx, ny]
   */
  function randomPolygonEdgePoint(poly) {
    if (!poly || poly.length < 2) return [0, 0];
    const ei = Math.floor(Math.random() * poly.length);
    const a = poly[ei];
    const b = poly[(ei + 1) % poly.length];
    const t = Math.random();
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /**
   * Spawn one enemy wave from themeRivals per enemyCountMode, entering from a
   * random polygon edge point. No-op (never throws) if themeRivals is empty
   * or rival frames aren't available yet.
   */
  function spawnEnemyWave() {
    if (!themeRivals || themeRivals.length === 0) return;
    let toSpawn;
    if (enemyCountMode === "all") {
      toSpawn = themeRivals.slice();
    } else {
      const n = 1 + Math.floor(Math.random() * themeRivals.length);
      const shuffled = themeRivals.slice().sort(() => Math.random() - 0.5);
      toSpawn = shuffled.slice(0, n);
    }
    const interior = randomInsidePoly(walkablePolygon);
    for (const rival of toSpawn) {
      const rivalId = rival.rival_id;
      if (!rivalId) continue;
      const spawnPt = randomPolygonEdgePoint(walkablePolygon);
      activeEnemies.push({
        instance_id: "enemy_" + (++enemyInstanceCounter),
        rival_id: rivalId,
        // Planner-classified combat style (manifest roster_rivals[].attack_style).
        // Legacy/unclassified rivals (no field, or unrecognized value) default to
        // "melee" so they never spawn a ranged projectile.
        attackStyle: rival.attack_style === "ranged" ? "ranged" : "melee",
        nx: spawnPt[0],
        ny: spawnPt[1],
        // Initial walk-in destination: toward the map interior so enemies
        // visibly enter rather than appearing in place.
        destNx: interior[0],
        destNy: interior[1],
        hp: ENEMY_MAX_HP,
        maxHp: ENEMY_MAX_HP,
        facingLeft: false,
        // Change 2: defeated enemies flee off-screen instead of vanishing.
        // fleeDestNx/Ny are set once, on the hp<=0 flee transition.
        fleeing: false,
        fleeDestNx: 0,
        fleeDestNy: 0,
        animState: createAnimState("walk"),
        targetAgentId: null,
        // Idle ambient combat: raid-target bookkeeping (lazily resolved by
        // advanceEnemies' targeting pass — see raidBuiltIds there).
        targetKind: null, // "object" | "agent" | null
        targetObjId: null,
      });
    }
  }

  /**
   * Advance the enemy spawn timer. Spawns a new wave when no enemies are
   * alive, the interval has elapsed, and at least one agent is active.
   * Resets the timer after spawning (and whenever enemies are present, so a
   * fresh interval starts counting only once the floor is clear again).
   * @param {number} delta seconds
   * @param {Array<object>} agentList current agentMetrics list
   */
  function updateEnemySpawning(delta, agentList) {
    if (activeEnemies.length > 0) {
      enemySpawnElapsed = 0; // hold the timer while a wave is still active
      return;
    }
    enemySpawnElapsed += delta;
    const hasActiveAgent = agentList.some((a) => {
      const w = state.workers[a.id];
      return w ? (w.state !== "idle" && w.state !== "leave")
               : ((a.status || "idle").toLowerCase() === "active" || (a.status || "").toLowerCase() === "working");
    });
    if (enemySpawnElapsed >= enemySpawnIntervalSec && hasActiveAgent) {
      spawnEnemyWave();
      enemySpawnElapsed = 0;
    }
  }

  /**
   * Build the perimeter waypoint loop (native coords) from the walkable
   * polygon vertices, inserting a midpoint on any edge longer than ~150px so
   * the leader tracks the boundary smoothly on long straight runs.
   * @returns {number[][]}
   */
  function buildCongaWaypoints() {
    const pts = [];
    const n = walkablePolygon.length;
    if (n < 3) return pts;
    for (let i = 0; i < n; i++) {
      const a = walkablePolygon[i];
      const b = walkablePolygon[(i + 1) % n];
      pts.push([a[0], a[1]]);
      const ex = b[0] - a[0], ey = b[1] - a[1];
      if (Math.sqrt(ex * ex + ey * ey) > 150) {
        pts.push([a[0] + ex * 0.5, a[1] + ey * 0.5]);
      }
    }
    return pts;
  }

  /**
   * Advance the ultra-rare conga-line easter egg. Called once per frame.
   * When idle, rolls a tiny chance each CONGA_CHECK_SECONDS to start a line;
   * while active, snakes agents around the perimeter and ends after
   * CONGA_SECONDS, then enters a long cooldown. No host telemetry involved.
   * @param {number} delta seconds
   * @param {Array<object>} agentList current agentMetrics list
   */
  function updateConga(delta, agentList) {
    if (congaCooldown > 0) congaCooldown = Math.max(0, congaCooldown - delta);

    if (congaActive) {
      congaTimeLeft -= delta;
      // Synchronized stop-and-cheer: every CONGA_CHEER_INTERVAL seconds the whole
      // line pauses together and holds the cheer pose for CONGA_CHEER_HOLD seconds.
      congaCheerTimer -= delta;
      if (congaCheerTimer <= 0) {
        congaCheerHold = CONGA_CHEER_HOLD;
        congaCheerTimer = CONGA_CHEER_INTERVAL;
      }
      if (congaCheerHold > 0) {
        congaCheerHold = Math.max(0, congaCheerHold - delta);
      }
      if (congaTimeLeft <= 0) {
        // End the conga: cooldown + clear per-agent assignments.
        congaActive = false;
        congaTimeLeft = 0;
        congaCheerTimer = 0;
        congaCheerHold = 0;
        congaCooldown = CONGA_COOLDOWN_SECONDS;
        for (const id of Object.keys(agentCharMap)) {
          const e = agentCharMap[id];
          e.congaIndex = -1;
          e.dancing = false;
          e.danceTimeLeft = 0;
        }
        congaOrder = [];
        congaWaypoints = [];
        congaWaypointIdx = 0;
      }
      return;
    }

    congaCheckTimer += delta;
    if (congaCheckTimer < CONGA_CHECK_SECONDS) return;
    congaCheckTimer = 0;
    if (agentList.length < 3 || activeEnemies.length > 0 || congaCooldown > 0) return;
    if (Math.random() >= CONGA_CHANCE) return;

    startConga(agentList);
  }

  /**
   * Start a conga line for the given agents: build the perimeter waypoints,
   * fix the leader→tail order, assign each agent's conga index, and flip the
   * active flags. Shared by updateConga's random trigger and the debug hotkey.
   * @param {Array<object>} agentList current agentMetrics list
   * @returns {boolean} true if a conga actually started
   */
  function startConga(agentList) {
    congaWaypoints = buildCongaWaypoints();
    if (congaWaypoints.length < 3) return false;
    congaOrder = agentList.map((a) => a.id);
    congaWaypointIdx = 0;
    let order = 0;
    for (const id of congaOrder) {
      const e = agentCharMap[id];
      if (!e) continue;
      e.congaIndex = order++;
      showExpression(e, 5, 1.8); // music bubble, coincides with conga start
      e.dancing = false;
      e.danceTimeLeft = 0;
      freeAgentSeat(e);
    }
    congaActive = true;
    congaTimeLeft = CONGA_SECONDS;
    congaCheerTimer = CONGA_CHEER_INTERVAL;
    congaCheerHold = 0;
    return true;
  }

  /**
   * Start a solo dance on a single agent's charMap entry (mirrors the normal
   * idle-dance start). Shared by the idle festivity roll and the debug hotkey.
   * @param {object} charEntry an agentCharMap entry
   */
  function startAgentDance(charEntry) {
    if (!charEntry) return;
    freeAgentSeat(charEntry);
    charEntry.dancing = true;
    charEntry.danceTimeLeft = DANCE_SECONDS_MIN + Math.random() * (DANCE_SECONDS_MAX - DANCE_SECONDS_MIN);
    charEntry.danceFrameTimer = 0;
    charEntry.lastDanceIdx = -1;
  }

  /**
   * Start a rare, one-shot emote hold (point/signal) on a single agent's
   * charMap entry. Mirrors startAgentDance's shape but drives its own
   * emoting/emoteClip/emoteTimeLeft fields instead of dancing/danceTimeLeft,
   * so an emote never fights a dance over the same state. Refuses to start
   * over an already-dancing, already-emoting, or actively seated agent.
   * @param {object} entry an agentCharMap entry
   * @param {string} clipName "point" or "signal" (ATLAS_CLIPS hold clip)
   * @param {number} durationSec how long (seconds) the emote holds
   */
  function playEmote(entry, clipName, durationSec) {
    if (!entry || entry.dancing || entry.emoting) return;
    if (entry.sitting) return; // don't override a seated pose
    entry.emoting = true;
    entry.emoteClip = clipName;
    entry.emoteTimeLeft = durationSec;
  }

  /**
   * Show a rare "expression" icon bubble above an agent's head — a pure
   * display overlay (bubbleExpr/bubbleTimeLeft/bubbleCooldown) that never
   * touches movement, clip selection, seat, or dance state. Rate-limited by
   * a single shared per-agent cooldown (BUBBLE_COOLDOWN_SEC) across all
   * bubble kinds. No-op (no crash) when the theme has no expression atlas
   * for this index — see themeImages["expression_"+index].
   * @param {object} entry an agentCharMap entry
   * @param {number} index 0..7 into the theme's expression atlas (0=love,
   *   1=idea, 2=anger, 3=team, 4=thumbs-up, 5=music, 6=sleep, 7=dazed/hit)
   * @param {number} durationSec how long (seconds) the bubble stays visible
   */
  function showExpression(entry, index, durationSec) {
    if (!entry || index < 0 || index > 7) return;
    // Non-interruptible: while this entry's persistent lead "team active"
    // bubble is showing (see drawTeamBubble), no other expression may
    // preempt it. The team-completion thumbs-up (index 4) is called AFTER
    // teamActive is cleared, so it is unaffected by this guard.
    if (entry.teamActive) return;
    if ((entry.bubbleCooldown || 0) > 0) return; // shared per-agent rate limit
    const frames = themeImages && themeImages["expression_" + index];
    if (!frames || !frames[0]) return; // theme has no expression atlas -> no bubble
    entry.bubbleExpr = index;
    entry.bubbleTimeLeft = durationSec;
    entry.bubbleCooldown = BUBBLE_COOLDOWN_SEC;
  }

  /**
   * Draw the expression-icon bubble above a sprite's head — a pure display
   * overlay shared by BOTH agents and rivals. Fully guarded: no-op (no throw)
   * when no bubble is active (exprIndex < 0 / timeLeft <= 0) or the theme's
   * expression frame isn't ready. Reads ctx/themeImages from closure. Behavior
   * is identical to the former inline agent block (same sizes, fade, bob, tail).
   * @param {number} exprIndex 0..7 into the theme expression atlas, or -1/undefined for none
   * @param {number} timeLeft remaining bubble seconds (drives the fade-out tail)
   * @param {number} cx sprite center x (canvas, un-flipped)
   * @param {number} cy sprite baseline y (canvas, un-flipped)
   * @param {number} spriteSize rendered sprite size (px)
   */
  function drawExpressionBubble(exprIndex, timeLeft, cx, cy, spriteSize) {
    if (!(exprIndex >= 0) || !(timeLeft > 0)) return;
    const bframes = themeImages["expression_" + exprIndex];
    const bimg = bframes && bframes[0];
    if (!bimg || !bimg.complete || bimg.naturalWidth <= 0) return;
    const bs = 20; // icon size (~70% of 28)
    const bx = cx; // center over head
    const by = cy - spriteSize - 11; // above head, like an HP bar
    ctx.save();
    ctx.globalAlpha = Math.min(1, timeLeft * 3); // brief fade-out tail
    ctx.fillStyle = exprIndex === 7 ? "rgba(0,0,0,0.92)" : "rgba(255,255,255,0.92)";
    const pad = 2, bw = bs + pad * 2, bh = bs + pad * 2, br = 5;
    const rx = bx - bw / 2, ry = by - bh / 2;
    ctx.beginPath();
    ctx.moveTo(rx + br, ry);
    ctx.arcTo(rx + bw, ry, rx + bw, ry + bh, br);
    ctx.arcTo(rx + bw, ry + bh, rx, ry + bh, br);
    ctx.arcTo(rx, ry + bh, rx, ry, br);
    ctx.arcTo(rx, ry, rx + bw, ry, br);
    ctx.closePath();
    ctx.fill();
    // Little downward tail pointing toward the head.
    ctx.beginPath();
    ctx.moveTo(bx - 3, ry + bh - 1);
    ctx.lineTo(bx + 3, ry + bh - 1);
    ctx.lineTo(bx, ry + bh + 4);
    ctx.closePath();
    ctx.fill();
    // Gentle vertical bob for the icon only (display-only).
    const t = performance.now ? performance.now() : Date.now();
    const bob = Math.sin(t / 180) * 1.4;
    if (exprIndex === 7) {
      // Dazed/hit: slow spin ("seeing stars") around the icon's center.
      const spin = t / 500;
      ctx.save();
      ctx.translate(bx, by - bob);
      ctx.rotate(spin);
      ctx.drawImage(bimg, -bs / 2, -bs / 2, bs, bs);
      ctx.restore();
    } else {
      ctx.drawImage(bimg, bx - bs / 2, (by - bs / 2) - bob, bs, bs);
    }
    ctx.restore();
  }

  /**
   * Draw the PERSISTENT lead "team active" bubble (expression index 3) — a
   * distinct, non-fading overlay drawn INSTEAD of drawExpressionBubble while
   * charEntry.teamActive is true (see the LEAD trigger block above and
   * showExpression's teamActive guard, which makes this bubble
   * non-interruptible). Same bubble shape/tail geometry as
   * drawExpressionBubble, but the background hue-cycles (rainbow) for the
   * first TEAM_BUBBLE_BURST_MS of charEntry.teamActiveSince, then settles to
   * a solid green with a gentle alpha pulse for as long as the team stays
   * active. Fully guarded: no-op if the theme has no expression_3 atlas
   * frame, or teamActive isn't set.
   * @param {object} charEntry an agentCharMap entry (lead) with teamActive/teamActiveSince
   * @param {number} cx sprite center x (canvas, un-flipped)
   * @param {number} cy sprite baseline y (canvas, un-flipped)
   * @param {number} spriteSize rendered sprite size (px)
   */
  function drawTeamBubble(charEntry, cx, cy, spriteSize) {
    if (!charEntry || !charEntry.teamActive) return;
    const bframes = themeImages["expression_3"];
    const bimg = bframes && bframes[0];
    if (!bimg || !bimg.complete || bimg.naturalWidth <= 0) return;
    const t = performance.now ? performance.now() : Date.now();
    const elapsed = t - (charEntry.teamActiveSince || t);
    const bs = 20; // icon size, matches drawExpressionBubble
    const bx = cx;
    const by = cy - spriteSize - 11;
    ctx.save();
    if (elapsed < TEAM_BUBBLE_BURST_MS) {
      // Attention burst: hue-cycle rainbow background.
      const hue = (elapsed * 0.3) % 360;
      ctx.fillStyle = `hsl(${hue}, 90%, 55%)`;
      ctx.globalAlpha = 0.95;
    } else {
      // Settled: solid green background with a gentle alpha pulse (sine of
      // the render clock) — distinct from the burst and from the normal
      // white expression-bubble background.
      const pulse = 0.85 + Math.sin(t / 260) * 0.12;
      ctx.fillStyle = "rgba(38, 194, 108, 1)";
      ctx.globalAlpha = pulse;
    }
    const pad = 2, bw = bs + pad * 2, bh = bs + pad * 2, br = 5;
    const rx = bx - bw / 2, ry = by - bh / 2;
    ctx.beginPath();
    ctx.moveTo(rx + br, ry);
    ctx.arcTo(rx + bw, ry, rx + bw, ry + bh, br);
    ctx.arcTo(rx + bw, ry + bh, rx, ry + bh, br);
    ctx.arcTo(rx, ry + bh, rx, ry, br);
    ctx.arcTo(rx, ry, rx + bw, ry, br);
    ctx.closePath();
    ctx.fill();
    // Little downward tail pointing toward the head (matches drawExpressionBubble).
    ctx.beginPath();
    ctx.moveTo(bx - 3, ry + bh - 1);
    ctx.lineTo(bx + 3, ry + bh - 1);
    ctx.lineTo(bx, ry + bh + 4);
    ctx.closePath();
    ctx.fill();
    // Icon itself is always fully opaque (only the background pulses/cycles).
    ctx.globalAlpha = 1;
    const bob = Math.sin(t / 180) * 1.4;
    ctx.drawImage(bimg, bx - bs / 2, (by - bs / 2) - bob, bs, bs);
    ctx.restore();
  }

  /**
   * Stand a seated (or seat-bound) agent up and release its seat. Safe to call
   * on any charEntry (no-op if it isn't sitting). Clears the per-agent sit
   * fields and marks the seat free in seatOccupancy.
   * @param {object} charEntry an agentCharMap entry
   */
  function freeAgentSeat(charEntry) {
    if (!charEntry) return;
    const seatId = charEntry.sitSeatId;
    // Release the seat only if this entry currently owns it (seatOccupancy
    // stores the owning agent id; charEntry.__id is stamped at claim time).
    if (seatId != null && seatOccupancy[seatId] === charEntry.__id) {
      seatOccupancy[seatId] = null;
    }
    charEntry.sitting = false;
    charEntry.sitSeatId = null;
    charEntry.seatDecorId = null; // no seat raise once standing
    charEntry.sitTimeLeft = 0;
  }

  /**
   * The leader throne ("Seat 1"): the FIRST sittable, non-hidden decor item
   * in themeDecor, reserved for the roster-slot-0 ("leader") character —
   * see isLeaderEntry. Recomputed on demand rather than cached: it's only
   * called from the idle sit-decision and the per-seated-agent stale-
   * occupant check (never once per frame per idle agent), themeDecor is
   * small, and always-live means a Stage-Editor hide toggle or a decor
   * regen is reflected immediately instead of through a stale cached id.
   * @returns {string|null} the throne's decor_id, or null if no seat exists.
   */
  function leaderSeatId() {
    for (const d of themeDecor) {
      const sid = d && d.decor_id;
      if (sid == null) continue;
      const p = decorPlacement[sid];
      if (!p || !p.sittable) continue;
      if (themeDecorHidden.has(sid)) continue;
      return sid;
    }
    return null;
  }

  /**
   * True iff charEntry is the current "leader" — the FIRST agent in this
   * frame's SCENE list (idx === 0). idx is computed against sceneAgentList
   * (see render(), built from agentList/state.agentMetrics right before the
   * per-agent loop), NOT the raw agentMetrics order: agentMetrics is
   * append-only, first-seen-by-hook order, and while the orchestrator is
   * USUALLY recorded first (landing at agentMetrics[0] naturally), a
   * reused/misinstalled project can record a spawned lead (e.g. build-lead)
   * first instead. sceneAgentList corrects for that by moving whichever
   * entry has id === "orchestrator" to index 0 (identity-based, not
   * position-based), so idx === 0 here is always the orchestrator when one
   * is present in the roster. idx === 0 still resolves to charIds[0]
   * (rosterOrder[0]'s costume) via the same costume-cycling formula the draw
   * and projectile-shooter code use: charIds[idx % charIds.length] (see
   * ~11480 and ~10707), so a roster drag-reorder still moves the throne's
   * costume immediately (charIds is rebuilt from the live rosterOrder every
   * render() call) — only the agent-selection half changed, from
   * "idx % charIds.length === 0" (which matched every idx that's a multiple
   * of charIds.length once the list outgrew the costume count, producing
   * multiple simultaneous leaders) to "idx === 0" (exactly one leader,
   * always the orchestrator).
   * @param {object} charEntry an agentCharMap entry
   * @param {number} idx the entry's index in this frame's sceneAgentList
   * @param {string[]} charIds this frame's resolved roster/costume id list
   */
  function isLeaderEntry(charEntry, idx, charIds) {
    return !!charEntry && Array.isArray(charIds) && charIds.length > 0 && idx === 0;
  }

  /**
   * Toggle the non-destructive Stage-Editor HIDE state for a decor item
   * (themeDecorHidden — see its declaration for how this differs from the
   * [-1,-1] anchor-hide sentinel). Hidden decor keeps its live placement, so
   * unlike the anchor-sentinel path there's no automatic "seat's decorPlacement
   * disappeared" trigger for the per-frame sitting-maintenance check to catch —
   * when hiding a seat, explicitly reuse freeAgentSeat to stand up whichever
   * agent currently owns it (seatOccupancy stores the occupying agent id).
   * @param {string} decorId
   */
  function toggleDecorHidden(decorId) {
    if (decorId == null) return;
    if (themeDecorHidden.has(decorId)) {
      themeDecorHidden.delete(decorId);
      return;
    }
    themeDecorHidden.add(decorId);
    for (const id in agentCharMap) {
      const ce = agentCharMap[id];
      if (ce && ce.sitSeatId === decorId) freeAgentSeat(ce);
    }
  }

  // debug hotkey: c=conga (the former f=fast-forward-build debug instabuild
  // hotkey was removed — F is now the Edit-Stage flip shortcut above; the
  // poof/build flow it used to shortcut is confirmed working on its own).
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const key = (e.key || "").toLowerCase();
    if (key === "c") {
      // Force-start a conga now (ignore eligibility/cooldown/probability).
      if (congaActive) return;
      if (lastAgentList.length < 1) return;
      startConga(lastAgentList);
    }
  });

  /**
   * Change C: spawn a ranged-fire projectile from (fromNx,fromNy) toward a
   * snapshotted target (toNx,toNy). No-op unless the theme provides the
   * projectile asset (graceful fallback). Purely visual — no damage here.
   * @param {number} fromNx native x of the shooter's origin (already includes
   *   the muzzle-forward X push AND the PROJECTILE_ORIGIN_HEIGHT_FRAC-based
   *   height raise — both computed by the caller from that shooter's own
   *   rendered sprite size, since only the caller knows which scale/depth
   *   applies)
   * @param {number} fromNy native y of the shooter's origin (already raised
   *   — see fromNx doc above)
   * @param {number} toNx snapshotted native x of the target (raw feet position)
   * @param {number} toNy snapshotted native y of the target (raw feet position)
   */
  function spawnProjectile(fromNx, fromNy, toNx, toNy) {
    if (!themeHasProjectile) return;
    // Only the IMPACT side still gets the flat walkableNativeH-fraction lift
    // here (reads as landing at roughly the target's center mass) — canvas y
    // increases downward, so "up" is a negative y offset. The origin side no
    // longer gets this flat lift: fromNy arrives already positioned by the
    // caller relative to the shooter's own rendered height (see
    // PROJECTILE_ORIGIN_HEIGHT_FRAC).
    const gunLift = PROJECTILE_GUN_HEIGHT_FRAC * walkableNativeH;
    activeProjectiles.push({
      fromNx: fromNx,
      fromNy: fromNy,
      toNx: toNx,
      toNy: toNy - gunLift,
      t: 0,
      // Depth-sort key: sort near the mid-flight point so it reads with the
      // combatants rather than always on top of / behind everything.
      ny: (fromNy + toNy) / 2,
    });
  }

  /**
   * Step alive enemies toward their current destination (used only while an
   * enemy has no engaging agent yet, so it keeps drifting toward the
   * interior instead of sitting frozen at the spawn edge).
   *
   * Change B: a NON-fleeing enemy now targets the NEAREST on-stage agent and
   * attacks it (walk in → melee up close, or shoot + fire a projectile from a
   * longer "ranged" distance). This is a VISUAL attack: agents have NO hp and
   * never die (they represent real coding agents). Fleeing enemies are
   * unchanged and never attack.
   * @param {number} delta seconds
   */
  function advanceEnemies(delta) {
    // Polygon bbox for depth-scale computation, needed to reproduce the
    // rival's DRAWN half-width at the muzzle-offset call below (same formula
    // the render loop uses at draw time — see the "kind === enemy" branch).
    // Recomputed here (not shared with render()'s local polyMinY/polyRangeY,
    // which are out of scope in this separate function) — walkablePolygon is
    // tiny so this is cheap.
    let enPolyMinY = Infinity, enPolyMaxY = -Infinity;
    for (const p of walkablePolygon) {
      if (p[1] < enPolyMinY) enPolyMinY = p[1];
      if (p[1] > enPolyMaxY) enPolyMaxY = p[1];
    }
    const enPolyRangeY = Math.max(enPolyMaxY - enPolyMinY, 1);

    // ── RAID targeting (idle ambient combat) ──────────────────────────────
    // Resolved ONCE per frame (not per enemy) and reused by every enemy's
    // targeting below. Rivals raid built objects before turning on agents.
    // objectPlacement[id] is the SAME resolved native position the object
    // draw path uses (depthList "kind === object" branch, ~L10701), so an
    // enemy paths to exactly where the object is drawn. Objects are a raid
    // TARGET only — never damaged/destroyed, and buildBuiltCount/build state
    // are never touched here.
    const raidBuildState = themeBuildables.length > 0 ? computeBuildState() : null;
    const raidBuiltIds = raidBuildState ? raidBuildState.builtIds : null;

    for (const en of activeEnemies) {
      // Expression-bubble countdown for rivals (mirrors the agent tick at the
      // charEntry loop). Placed BEFORE the fleeing `continue` so an evicted
      // rival's dazed/hit bubble still fades out as it flees off-screen.
      // Guarded so rivals without bubble fields (undefined) are untouched.
      if (en.bubbleTimeLeft > 0) {
        en.bubbleTimeLeft -= delta;
        if (en.bubbleTimeLeft <= 0) en.bubbleExpr = -1;
      }
      if (en.bubbleCooldown > 0) en.bubbleCooldown -= delta;
      if (en.fleeing) {
        // Change 2: defeated enemy runs off the nearest edge (a bit faster
        // than walk-in), using the walk clip, facing its travel direction.
        // NO polygon clamp — it must leave the play area. Removal happens in
        // the render loop once it is beyond the visible bounds by a margin.
        const dx = en.fleeDestNx - en.nx;
        const dy = en.fleeDestNy - en.ny;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const step = ENEMY_WALK_SPEED * 1.6 * delta;
        en.nx += (dx / dist) * step;
        en.ny += (dy / dist) * step;
        // Facing DEADZONE: hold facing on near-vertical flight (no rapid flip).
        if (Math.abs(dx) > FACING_DEADZONE) en.facingLeft = dx < 0;
        if (en.animState.action !== "walk") {
          en.animState.action = "walk";
          en.animState.frameIndex = 0;
          en.animState.elapsed = 0;
          en.animState.completed = false;
        }
        advanceRivalAnim(en.animState, delta);
        continue;
      }
      // ── Change B: attack the nearest RAID target (built object first,
      // nearest agent as fallback) ──────────────────────────────────────
      // Per-enemy attack/fire cadence timers (lazy-init; not per-frame spawn).
      if (typeof en.attackCooldown !== "number") en.attackCooldown = 0;
      if (typeof en.shotCooldown !== "number") en.shotCooldown = 0;
      en.attackCooldown -= delta;
      en.shotCooldown -= delta;

      // Find the nearest BUILT object (raidBuiltIds), by the same resolved
      // native placement the object draw path uses. Unbuilt/active(crate)
      // slots are never targeted — raidBuiltIds only contains fully-built
      // object ids (see computeBuildState).
      let nearestObjPlacement = null, nearestObjDist = Infinity, nearestObjId = null;
      if (raidBuiltIds && raidBuiltIds.size > 0) {
        for (const objId of raidBuiltIds) {
          const p = objectPlacement[objId];
          if (!p) continue;
          const odx = p.nx - en.nx, ody = p.ny - en.ny;
          const d = Math.sqrt(odx * odx + ody * ody);
          if (d < nearestObjDist) { nearestObjDist = d; nearestObjPlacement = p; nearestObjId = objId; }
        }
      }

      let targetEnt = null, targetDist = Infinity;
      if (nearestObjPlacement) {
        // ── Built object exists: raid it. Object-target STICKINESS mirrors
        // the agent stickiness below so the enemy doesn't flip-flop between
        // two near-equidistant buildings each frame. ─────────────────────
        en.targetKind = "object";
        const stickyObjId = (en.targetObjId && raidBuiltIds.has(en.targetObjId)) ? en.targetObjId : null;
        const stickyObjPlacement = stickyObjId ? objectPlacement[stickyObjId] : null;
        if (stickyObjPlacement) {
          const sdx = stickyObjPlacement.nx - en.nx, sdy = stickyObjPlacement.ny - en.ny;
          const currentDist = Math.sqrt(sdx * sdx + sdy * sdy);
          if (nearestObjDist < currentDist - TARGET_SWITCH_MARGIN) {
            targetEnt = nearestObjPlacement; targetDist = nearestObjDist;
            en.targetObjId = nearestObjId;
          } else {
            targetEnt = stickyObjPlacement; targetDist = currentDist;
          }
        } else {
          targetEnt = nearestObjPlacement; targetDist = nearestObjDist;
          en.targetObjId = nearestObjId;
        }
        // Not chasing an agent while a built object is being raided.
        en.chaseTargetId = null;
      } else {
        // ── No built object on the floor — fall back to the original
        // nearest-agent targeting. ─────────────────────────────────────
        en.targetKind = "agent";
        en.targetObjId = null;

        // Find the nearest on-stage agent by native distance. agentCharMap is
        // pruned to the current agentList each frame, so its entries are exactly
        // the agents currently on the floor.
        let nearestEnt = null, nearestDist = Infinity;
        let nearestId = null;
        for (const id of Object.keys(agentCharMap)) {
          const ent = agentCharMap[id];
          if (!ent) continue;
          const adx = ent.nx - en.nx, ady = ent.ny - en.ny;
          const d = Math.sqrt(adx * adx + ady * ady);
          if (d < nearestDist) { nearestDist = d; nearestEnt = ent; nearestId = id; }
        }

        // ── Target STICKINESS ───────────────────────────────────────────────
        // Keep chasing the SAME agent (en.chaseTargetId — distinct from
        // en.targetAgentId, which is the agent currently attacking THIS enemy)
        // until another agent is closer by more than TARGET_SWITCH_MARGIN. This
        // stops the target (and thus facing + walk direction) from flip-flopping
        // between two near-equidistant agents each frame.
        const stickyEnt = en.chaseTargetId ? agentCharMap[en.chaseTargetId] : null;
        if (stickyEnt) {
          const sdx = stickyEnt.nx - en.nx, sdy = stickyEnt.ny - en.ny;
          const currentDist = Math.sqrt(sdx * sdx + sdy * sdy);
          if (nearestEnt && nearestDist < currentDist - TARGET_SWITCH_MARGIN) {
            // A meaningfully-closer agent appeared — switch.
            targetEnt = nearestEnt; targetDist = nearestDist;
            en.chaseTargetId = nearestId;
          } else {
            // Keep the current target.
            targetEnt = stickyEnt; targetDist = currentDist;
          }
        } else if (nearestEnt) {
          // No (valid) current target — adopt the nearest agent.
          targetEnt = nearestEnt; targetDist = nearestDist;
          en.chaseTargetId = nearestId;
        }
      }

      if (!targetEnt) {
        // No agents on stage — drift toward the original interior destination
        // (walk clip) exactly as before so enemies don't freeze at the edge.
        const dx = en.destNx - en.nx;
        const dy = en.destNy - en.ny;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > WANDER_ARRIVED_EPS) {
          const step = Math.min(ENEMY_WALK_SPEED * delta, dist);
          en.nx += (dx / dist) * step;
          en.ny += (dy / dist) * step;
          // Facing DEADZONE: hold facing on near-vertical drift (no rapid flip).
          if (Math.abs(dx) > FACING_DEADZONE) en.facingLeft = dx < 0; // face drift direction so mirroring isn't stale
          const clamped = clampToPolygon(en.nx, en.ny, walkablePolygon);
          en.nx = clamped[0];
          en.ny = clamped[1];
        }
        if (en.animState.action !== "walk") {
          en.animState.action = "walk";
          en.animState.frameIndex = 0;
          en.animState.elapsed = 0;
          en.animState.completed = false;
        }
        advanceRivalAnim(en.animState, delta);
        continue;
      }

      // Face the target — but only re-face when the horizontal offset clears
      // ATTACK_FACING_DEADZONE. When the target is nearly directly above/below
      // (near-vertical), keep the current facing so the sprite doesn't rapid-
      // flip/mirror-blur in place every frame.
      if (Math.abs(targetEnt.nx - en.nx) > ATTACK_FACING_DEADZONE) {
        en.facingLeft = targetEnt.nx < en.nx;
      }

      // Enemies have only two clips: "walk" and "attack". Both melee (up-close)
      // and ranged (at distance) engagement use the same 2-frame attack clip;
      // ranged additionally spawns a projectile on its throttled cadence.
      // ── Combat mode with HYSTERESIS ────────────────────────────────────
      // The target agent MOVES, so its distance oscillates around the range
      // boundaries. Without a deadband the enemy flips walk<->attack every
      // frame (each flip reset the walk clip → walking-in-place jitter).
      // Track a sticky mode on the enemy: enter "attack" when the target is
      // within range, but stay in "attack" until it drifts beyond
      // range + ENEMY_RANGE_HYSTERESIS before returning to "walk".
      if (en.combatMode !== "attack") en.combatMode = "walk";
      const attackEnter = ENEMY_RANGED_RANGE;                       // start attacking within this
      const attackExit = ENEMY_RANGED_RANGE + ENEMY_RANGE_HYSTERESIS; // stop only beyond this
      if (en.combatMode === "attack") {
        // Keep attacking until the target escapes the outer (exit) band.
        if (targetDist > attackExit) en.combatMode = "walk";
      } else {
        // Currently walking — only switch to attack once inside the inner band.
        if (targetDist <= attackEnter) en.combatMode = "attack";
      }

      let desiredAction = "walk";
      let movedThisFrame = 0; // native px actually moved this frame (walk-anim gate)
      if (en.combatMode === "attack") {
        // In range (with hysteresis) — hold position and attack. Fire a ranged
        // projectile on the throttled cadence when outside pure melee range.
        desiredAction = "attack";
        // MELEE rivals never spawn a projectile — they still close in, enter
        // "attack" combat mode, and play the same attack clip as ranged
        // rivals; only the projectile visual is suppressed for them.
        if (en.attackStyle === "ranged" && targetDist > ENEMY_ENGAGE_RANGE && en.shotCooldown <= 0) {
          en.shotCooldown = PROJECTILE_SPAWN_INTERVAL;
          // Push the spawn origin toward the rival's leading (facing) edge so
          // the shot reads as leaving the gun rather than the sprite's
          // horizontal middle. Reproduce the SAME depth-scale/sprite-size
          // formula the "kind === enemy" draw branch uses (spriteSize =
          // 64 * depthScale * themeCharacterScale), then convert that
          // canvas-px half-width into native space via the walkableNativeW/
          // lastBgW ratio (the inverse of nativeToCanvas's scale factor;
          // lastBgW is refreshed every frame before advanceEnemies() runs —
          // see the render() call order). en.facingLeft is the same field
          // the draw code mirrors on (facingLeft === true → sprite mirrored
          // left), so the sign matches the visible flip exactly.
          const enTDepth = Math.max(0, Math.min(1, (en.ny - enPolyMinY) / enPolyRangeY));
          const enDepthScale = (0.8 + enTDepth * 0.3) * themeOverallScale;
          const enHalfWidthPx = Math.round(64 * enDepthScale * themeCharacterScale * effectiveRivalScale(en.rival_id)) / 2;
          const enHalfWidthNative = enHalfWidthPx * (walkableNativeW / lastBgW);
          const enFacingSign = en.facingLeft ? -1 : 1;
          const enMuzzleForward = enHalfWidthNative * PROJECTILE_MUZZLE_FRAC;
          // Origin height (PROJECTILE_ORIGIN_HEIGHT_FRAC of the rival's own
          // RENDERED sprite height, not a flat fraction of walkableNativeH).
          // Reproduces the real draw-time depthScale — enDepthScale above
          // omits sceneFitScale (it only feeds the X muzzle push, which is
          // unaffected by it), so sceneFitScale is folded in separately here
          // — then converts that canvas-px height into native space via the
          // same lastBgH ratio the X conversion above uses for lastBgW.
          const enFullDepthScale = enDepthScale * sceneFitScale;
          const enSpriteHeightPx = Math.round(64 * enFullDepthScale * themeCharacterScale * effectiveRivalScale(en.rival_id));
          const enSpriteHeightNative = enSpriteHeightPx * (walkableNativeH / lastBgH);
          const enOriginNy = en.ny - PROJECTILE_ORIGIN_HEIGHT_FRAC * enSpriteHeightNative;
          spawnProjectile(en.nx + enFacingSign * enMuzzleForward, enOriginNy, targetEnt.nx, targetEnt.ny);
        }
        if (en.attackCooldown <= 0) en.attackCooldown = ENEMY_ATTACK_INTERVAL;
      } else {
        // Out of range — walk toward the target. Clamp the step so it never
        // overshoots the target (stepping past then back = net-zero jitter).
        desiredAction = "walk";
        const dx = targetEnt.nx - en.nx;
        const dy = targetEnt.ny - en.ny;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const step = Math.min(ENEMY_WALK_SPEED * delta, dist); // no-overshoot clamp
        const px = en.nx, py = en.ny;
        en.nx += (dx / dist) * step;
        en.ny += (dy / dist) * step;
        const clamped = clampToPolygon(en.nx, en.ny, walkablePolygon);
        en.nx = clamped[0];
        en.ny = clamped[1];
        // Measure real displacement AFTER the polygon clamp (a blocked enemy
        // moves ~0 even though a step was requested).
        movedThisFrame = Math.hypot(en.nx - px, en.ny - py);
      }

      // Apply the desired clip. "attack" is a loop:false pingpong one-shot in
      // RIVAL_CLIPS; while in range and actively attacking, replay it on
      // completion so the attack keeps animating (mirrors the agent side).
      if (en.animState.action !== desiredAction) {
        en.animState.action = desiredAction;
        en.animState.frameIndex = 0;
        en.animState.direction = 1;
        en.animState.elapsed = 0;
        en.animState.completed = false;
      } else if (desiredAction === "attack" && en.animState.completed) {
        en.animState.frameIndex = 0;
        en.animState.direction = 1;
        en.animState.elapsed = 0;
        en.animState.completed = false;
      }
      // Decide whether the enemy is ACTUALLY walking, with hysteresis, so a
      // near-stationary enemy doesn't flip between advancing and freezing its
      // walk clip every frame (which stuttered its legs between poses in place).
      // Compare real displacement to a full-speed step (frame-rate independent).
      const fullStep = ENEMY_WALK_SPEED * delta;
      const moveRatio = fullStep > 0 ? movedThisFrame / fullStep : 0;
      if (moveRatio >= ENEMY_WALK_MOVE_RATIO_HI) {
        en.isWalking = true;
      } else if (moveRatio < ENEMY_WALK_MOVE_RATIO_LO) {
        en.isWalking = false;
      } // between LO and HI: keep the previous en.isWalking (deadband)
      if (desiredAction === "walk") {
        if (en.isWalking) {
          advanceRivalAnim(en.animState, delta);
        } else {
          // Stopped: settle on a stable standing pose (the first walk frame)
          // with the timer reset, so the enemy never vibrates or cycles in
          // place while it holds position.
          en.animState.frameIndex = 0;
          en.animState.direction = 1;
          en.animState.elapsed = 0;
        }
      } else {
        // Attack (or any non-walk) clip advances normally.
        advanceRivalAnim(en.animState, delta);
      }
    }
  }

  function render(timestamp) {
    // Pause when hidden (perf: change 1): skip the whole per-agent simulation
    // + draw while the webview tab/panel isn't visible, but keep scheduling
    // the next frame so it resumes on its own the moment it becomes visible
    // again — no missed rAF chain, no manual resume hook needed.
    if (document.hidden) {
      wasHiddenLastFrame = true;
      requestAnimationFrame(render);
      return;
    }
    // Coming back from a hidden period: `lastFrameTime` is stale (from
    // whenever the last visible frame ran), so (timestamp - lastFrameTime)
    // would be huge. The existing 0.1s clamp below already caps the delta
    // used for animation math either way, but resetting the baseline here
    // (instead of relying on the clamp alone) avoids treating this first
    // frame as a real elapsed-time sample for anything that isn't delta-based
    // (e.g. lastFrameTime itself staying a meaningful "previous frame" value).
    if (wasHiddenLastFrame) {
      wasHiddenLastFrame = false;
      lastFrameTime = timestamp;
    }
    // Delta time for animation advancement (capped at 100ms to avoid jumps on tab focus)
    const delta = lastFrameTime === 0 ? 0 : Math.min((timestamp - lastFrameTime) / 1000, 0.1);
    lastFrameTime = timestamp;

    frame++;
    // Hover-tooltip hit-list: rebuilt fresh this frame (see declaration).
    hoverTargets = [];
    const w = canvas.width;
    const h = canvas.height;

    // While the stage is still loading its theme art, suppress placeholder
    // buildings/stick-figures and show a single loading bar instead.
    const _load = themeLoadProgress();
    const _loadElapsed = themeLoadStartTs > 0 ? (nowMs() - themeLoadStartTs) : Infinity;
    const loadingActive = !noThemeSignaled && !_load.ready && themeLoadStartTs > 0 && _loadElapsed < LOADING_TIMEOUT_MS;

    // Boot loader: smooth 75→99% while sprite frames stream in. Completion
    // (100% + fade out) is decided at the END of this frame (see the gate
    // just before drawHUD) from what was ACTUALLY painted, never from the
    // loading signal alone. Reset this frame's paint telemetry here.
    bootFrameThemeBgDrawn = false;
    bootFrameSpritePending = false;
    if (!bootLoaderDone && loadingActive && themeLoaded) {
      bootLoaderSetProgress(75 + Math.round(_load.frac * 24), "Preparing scene…");
    }

    // ── Change 2: Fixed-size background (does NOT stretch on resize) ──────────
    if (themeLoaded && themeBackgroundImg && themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0) {
      // Letterbox fill: solid backdrop so edges outside the fixed BG are clean.
      ctx.fillStyle = "#0a0a12";
      ctx.fillRect(0, 0, w, h);

      // Draw at the image's natural size (fit-scaled down to the actual canvas
      // when needed — see sceneFitScale), centered horizontally, TOP-anchored.
      // Top-anchoring keeps the background (and everything mapped to it) at a
      // fixed screen position: the metrics handlebar resizes the stage from its
      // bottom edge, so a top-anchored image never shifts when h changes.
      sceneFitScale = Math.min(
        1,
        w / (themeBackgroundImg.naturalWidth * themeOverallScale),
        h / (themeBackgroundImg.naturalHeight * themeOverallScale),
      );
      const bgW = themeBackgroundImg.naturalWidth * themeOverallScale * sceneFitScale;
      const bgH = themeBackgroundImg.naturalHeight * themeOverallScale * sceneFitScale;
      const bgX = Math.floor((w - bgW) / 2);
      const bgY = 0; // top-anchor → static regardless of handlebar / canvas height
      ctx.drawImage(themeBackgroundImg, bgX, bgY, bgW, bgH);
      // Boot-loader paint signal: this frame drew the real decoded background.
      bootFrameThemeBgDrawn = true;
    } else {
      // No decoded background yet — nothing native-space is drawn this frame,
      // so nothing should be shrunk either.
      sceneFitScale = 1;
      // Fallback placeholder background
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, w, h);

      // Sky gradient strip
      const grad = ctx.createLinearGradient(0, 0, 0, h * 0.7);
      grad.addColorStop(0, "#0d1b3e");
      grad.addColorStop(1, "#1a2a50");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h * 0.7);
    }

    // Ground band (pre-theme backdrop only — no entities are drawn on it)
    const groundY = Math.floor(h * 0.78);
    if (!themeLoaded || !themeBackgroundImg || !themeBackgroundImg.complete) {
      ctx.fillStyle = "#2a3a2a";
      ctx.fillRect(0, groundY, w, h - groundY);
      ctx.strokeStyle = "#4a6a4a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(w, groundY);
      ctx.stroke();
    }

    // (Placeholder cityscape removed: the pre-theme scene draws no stand-in
    // buildings or stick figures — entities only appear as real themed art.)

    // ── Isometric character placement + wander on themed floor ───────────────
    // Derive the agent list from the metrics table (same source as renderMetrics).
    // While loading, use an empty list so no placeholder/half-loaded sprites show.
    const agentList = loadingActive ? [] : (Array.isArray(state.agentMetrics) ? state.agentMetrics : []);
    // Scene-local reorder: the leader/throne slot and charIds[0]'s avatar are
    // assigned POSITIONALLY (idx === 0 / idx % charIds.length) from whichever
    // list index 0 happens to be. agentList/agentMetrics is append-only,
    // first-seen-by-hook order — normally the orchestrator is recorded first
    // by UserPromptSubmit and lands at index 0, but in a reused/misinstalled
    // project a spawned lead (e.g. build-lead) can be recorded first instead,
    // stealing the throne and the orchestrator's avatar slot. Pin the
    // orchestrator to index 0 BY IDENTITY for the SCENE only — the metrics
    // panel keeps reading agentMetrics/agentList directly and is untouched.
    // No-op when the orchestrator is already first (the normal case).
    let sceneAgentList = agentList;
    const orchIdx = agentList.findIndex((a) => a && a.id === "orchestrator");
    if (orchIdx > 0) {
      sceneAgentList = [agentList[orchIdx], ...agentList.slice(0, orchIdx), ...agentList.slice(orchIdx + 1)];
    }
    lastAgentList = sceneAgentList; // expose to off-loop debug hotkeys (conga leader = orchestrator)

    // Rebirth (B2): track the high-water mark of concurrently-ACTIVE agents
    // this cycle, using the same isMetricsAgentActive() source of truth as
    // the metrics table/canvas (see its definition for why). Feeds the
    // AGENTS_ACTIVE badge trigger in updateBadgeUnlocks().
    let liveActiveAgentCount = 0;
    for (const a of sceneAgentList) {
      if (isMetricsAgentActive(a)) liveActiveAgentCount++;
    }
    cyclePeakActive = Math.max(cyclePeakActive, liveActiveAgentCount);

    // Prune stale entries from agentCharMap (agents no longer in metrics).
    const agentIds = new Set(sceneAgentList.map((a) => a.id));
    for (const id of Object.keys(agentCharMap)) {
      if (!agentIds.has(id)) delete agentCharMap[id];
    }

    // Resolve character sprite roster.
    const charIds = rosterOrder.length > 0 ? rosterOrder : Object.keys(themeImages);

    // Compute bg rect for native->canvas mapping (matches the draw above,
    // INCLUDING sceneFitScale — every entity is positioned via nativeToCanvas
    // against this bgW/bgH, so if this drifted from the actual drawn
    // background rect, entities would be placed as if the full native
    // 533x751 footprint were always on-canvas even when it had just been
    // shrunk to fit, undoing the fit-scale's clipping fix for everything
    // except the background image itself).
    const bgImgReady = themeLoaded && themeBackgroundImg && themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0;
    const bgW = bgImgReady ? themeBackgroundImg.naturalWidth  * themeOverallScale * sceneFitScale : w;
    const bgH = bgImgReady ? themeBackgroundImg.naturalHeight * themeOverallScale * sceneFitScale : h;
    const bgX = bgImgReady ? Math.floor((w - bgW) / 2) : 0;
    const bgY = 0; // top-anchor (matches the background draw) → static on resize
    // Cache for the stage-editor mouse handlers (canvas<->native mapping).
    lastBgX = bgX; lastBgY = bgY; lastBgW = bgW; lastBgH = bgH;

    // Polygon bbox for depth scale computation.
    let polyMinY = Infinity, polyMaxY = -Infinity;
    for (const p of walkablePolygon) {
      if (p[1] < polyMinY) polyMinY = p[1];
      if (p[1] > polyMaxY) polyMaxY = p[1];
    }
    const polyRangeY = Math.max(polyMaxY - polyMinY, 1);

    // ── Phase 2b: enemy wave spawn/advance (client-side only, no host telemetry) ──
    // Computed BEFORE the build-state block so updateBuildProgress() can gate
    // on enemiesAlive (enemy presence preempts/pauses building — Change 1).
    if (!loadingActive && themeLoaded) {
      updateEnemySpawning(delta, sceneAgentList);
      advanceEnemies(delta);
      updateConga(delta, sceneAgentList);
    }
    // Change C: advance live projectiles. t runs 0→1 over PROJECTILE_FLIGHT_SEC,
    // then lingers on the blast for PROJECTILE_BLAST_HOLD before removal. Drawn
    // after the depth list below. Skipped entirely when the theme has no
    // projectile asset (activeProjectiles stays empty — nothing spawns).
    if (activeProjectiles.length > 0) {
      for (const p of activeProjectiles) {
        p.t += delta / PROJECTILE_FLIGHT_SEC;
      }
      // Remove once the blast has finished (t past 1 by the hold fraction).
      const removeAt = 1 + PROJECTILE_BLAST_HOLD / PROJECTILE_FLIGHT_SEC;
      activeProjectiles = activeProjectiles.filter((p) => p.t < removeAt);
    }
    // Change 2: a FLEEING enemy is defeated — no longer a threat. enemiesAlive
    // (build preemption + agent engage decision) counts only non-fleeing enemies,
    // so building resumes and no agent chases a fleeing enemy.
    const enemiesAlive = activeEnemies.some((e) => !e.fleeing);
    // Reset engagement claims each frame; agents re-claim the nearest enemy below.
    if (enemiesAlive) {
      for (const en of activeEnemies) if (!en.fleeing) en.targetAgentId = null;
    }

    // ── Phase 2a (Change 1): advance the paced one-at-a-time build queue ────
    // Gated on last frame's builder-presence flag (set at the bottom of the
    // agent loop below) and on enemiesAlive (enemy preemption pauses it).
    if (themeBuildables.length > 0) {
      updateBuildProgress(delta, enemiesAlive);
      // Ungated: completes the object once progress hits 1 (normal build),
      // even if enemies/conga/no-builder paused the rate.
      completeBuildIfReady();
    }
    buildProgressBuilderCount = 0; // reset; re-armed by the agent loop below
    currentBuildContributors = []; // reset; re-populated by the agent loop below

    // ── Phase 2a: derive build state + advance per-object state machines ────
    const buildState = themeBuildables.length > 0 ? computeBuildState() : { builtIds: new Set(), activeId: null, activeProgress: 0 };
    // ── Ranged combat upgrade: unlock detection ──────────────────────────
    // Idempotent latch — once the rack object (build_order 0) is BUILT, all
    // characters permanently switch to ranged combat. D4: also durably latch
    // rangedPermanentlyUnlocked + persist it (mirrors doRebirth's
    // persistRebirth usage) the FIRST time this flips, so the unlock survives
    // reloads and every future rebirth from here on — not just this session.
    if (!rangedUnlocked && rackObjectId && buildState.builtIds.has(rackObjectId)) {
      rangedUnlocked = true;
      if (!rangedPermanentlyUnlocked) {
        rangedPermanentlyUnlocked = true;
        persistRebirth();
      }
    }
    // Cosmetic damage-smoke (Phase 1): update once per frame here — AFTER enemy
    // targeting (advanceEnemies above) and buildState derivation, BEFORE the
    // object draw pass. Reads only; feeds drawObjectSmoke in drawBuildableObject.
    updateObjectSmoke(delta, buildState.builtIds);
    // Extinguish (Phase 2): route idle, eligible characters to smoking objects
    // BEFORE the movement loop so their dest override (below) can act this frame.
    assignExtinguishers();
    const activeBuildId = buildState.activeId;
    let activeBuildObj = null;
    for (const obj of themeBuildables) {
      const objId = obj.object_id;
      const status = buildState.builtIds.has(objId) ? "built" : (objId === activeBuildId ? "active" : "unbuilt");
      if (objId === activeBuildId) activeBuildObj = obj;
      let entry = objectAnimMap[objId];
      if (!entry) {
        entry = objectAnimMap[objId] = { phase: "unbuilt", animState: null, progress: 0 };
      }
      if (status === "unbuilt") {
        entry.phase = "unbuilt";
      } else if (status === "active") {
        if (entry.phase === "unbuilt") {
          entry.phase = "active";
          entry.animState = (themeHasCrateAsset && themeImages.crate && themeImages.crate.length > 0)
            ? createAnimState("crate")
            : null; // null animState → no crate art → crate not drawn
        }
        entry.progress = buildState.activeProgress;
      } else if (status === "built") {
        if (entry.phase === "active" || entry.phase === "unbuilt") {
          if (themeHasPoofAsset && themeImages.poof && themeImages.poof.length > 0) {
            entry.phase = "poof";
            entry.animState = createAnimState("poof");
          } else {
            entry.phase = "idle";
            entry.animState = createObjectIdleAnimState(objId);
          }
        }
        entry.progress = 1;
      }
      // Advance whichever per-object animation is currently active.
      if (entry.phase === "active" && entry.animState) {
        advanceObjectAnim(entry.animState, delta);
      } else if (entry.phase === "poof" && entry.animState) {
        advanceObjectAnim(entry.animState, delta);
        if (entry.animState.completed) {
          // Poof one-shot finished — this queue slot is now fully built.
          // Advance the queue pointer here (Change 1) so the NEXT object
          // becomes the active crate starting next frame.
          entry.phase = "idle";
          entry.animState = createObjectIdleAnimState(objId);
          if (objId === activeBuildId && buildBuiltCount < buildQueue.length && buildQueue[buildBuiltCount] === objId) {
            buildBuiltCount++;
            cycleObjectsBuilt++;
            persistRebirth();
            saveBuildProgress();
            buildCurrentProgress = 0;
          }
        }
      } else if (entry.phase === "idle" && entry.animState) {
        const objImg = themeImages["object_" + objId];
        if (objImg && objImg.length > 1) {
          // Animated object: only loop while an AGENT (never a rival) is close,
          // plus a 1s linger after the last agent leaves; otherwise freeze frame 0.
          const place = objectPlacement[objId];
          let agentNear = false;
          if (place) {
            for (const agent of sceneAgentList) {
              const ent = agentCharMap[agent.id];
              if (!ent) continue;
              const dx = place.nx - ent.nx, dy = place.ny - ent.ny;
              if (dx * dx + dy * dy <= OBJECT_ANIM_PROXIMITY_NATIVE * OBJECT_ANIM_PROXIMITY_NATIVE) { agentNear = true; break; }
            }
          }
          if (agentNear) entry.animNearTimer = OBJECT_ANIM_LINGER_SEC;
          else entry.animNearTimer = Math.max(0, (entry.animNearTimer || 0) - delta);
          if (entry.animNearTimer > 0) {
            advanceObjectAnim(entry.animState, delta);
          } else {
            entry.animState.frameIndex = 0;
            entry.animState.elapsed = 0;
          }
        } else {
          advanceObjectAnim(entry.animState, delta); // static art: unchanged (holds frame 0 via modulo)
        }
      }
    }
    // Resolve standoff target (native space) for active-build agents.
    const activeBuildPlacement = activeBuildObj ? objectPlacement[activeBuildObj.object_id] : null;
    // Standoff radius: an explicit per-object exclusion_radius (manifest)
    // wins; otherwise derive one from the ACTIVE object's own rendered size
    // — while active, what's actually on screen is the crate (constant
    // default size, GLOBAL object-scale only — see drawBuildableObject's
    // crateSize), not the per-object-scaled final art, so this mirrors that
    // same "64 * depthScale * themeObjectScale" formula (depthScale folded
    // in via nativeScale below) plus a small margin. A bigger-scaled object
    // gets a proportionally bigger stand-back distance once it's built, but
    // while it's still a crate every site gets the same crate-sized standoff.
    // Objects have NO collision — this is purely a "stand a bit back"
    // distance, not physics.
    const BUILD_STANDOFF_MARGIN_NATIVE = 8;
    const activeBuildExclusionR = (() => {
      if (!activeBuildObj) return 48;
      if (typeof activeBuildObj.exclusion_radius === "number" && activeBuildObj.exclusion_radius > 0) {
        return activeBuildObj.exclusion_radius;
      }
      const objBaseSizeCanvas = 64 * themeObjectScale;
      const nativeScale = bgW > 0 ? (bgW / walkableNativeW) : 1;
      const objectRadiusNative = (objBaseSizeCanvas / 2) / nativeScale;
      return objectRadiusNative + BUILD_STANDOFF_MARGIN_NATIVE;
    })();
    let builderSideCounter = 0;

    // ── Team-formation signal prep (Part 3) ────────────────────────────
    // Count each lead's ACTIVE worker children (same isMetricsAgentActive
    // source of truth as isActive below) from agentMetrics, keyed by lead
    // id, so the per-agent loop can tell a lead "your team just formed."
    // Built once per frame, before the loop, since it needs the full roster.
    const leadChildCount = {};
    // Set of lead agent ids (Part 3b), so the per-agent loop can tell a
    // worker "you just joined a lead's team" regardless of active-count
    // bookkeeping above. Built from the same agentList pass.
    const leadIds = new Set();
    for (const m of sceneAgentList) {
      if (m && m.parentId && isMetricsAgentActive(m)) {
        leadChildCount[m.parentId] = (leadChildCount[m.parentId] || 0) + 1;
      }
      if (m && m.tier && m.tier.toLowerCase() === "lead") {
        leadIds.add(m.id);
      }
    }

    sceneAgentList.forEach((agent, idx) => {
      // Look up a live worker (if one exists) for this agent.
      const worker = state.workers[agent.id] || null;

      // ── Initialise per-agent entry ─────────────────────────────────
      if (!agentCharMap[agent.id]) {
        const home = isoSlotHome(idx, walkablePolygon);
        const wanderDelay = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
        agentCharMap[agent.id] = {
          // Owning agent id (used by seat-occupancy bookkeeping).
          __id: agent.id,
          // Native-coord position (polygon space)
          nx: home[0],
          ny: home[1],
          // Native home
          homeNx: home[0],
          homeNy: home[1],
          // Native wander destination
          destNx: home[0],
          destNy: home[1],
          // Timer until next wander pick
          wanderTimer: wanderDelay,
          // Legacy canvas x/y (kept for facing, not for positioning)
          x: 0,
          y: 0,
          prevX: 0,
          animState: createAnimState(worker ? workerStateToClip(worker.state) : "idle"),
          facingLeft: false,
          // Solo-dance state (manual frame mixer).
          dancing: false,
          danceTimeLeft: 0,
          danceFrameTimer: 0,
          lastDanceIdx: -1,
          // Rare one-shot emote state (point/signal hold clips) — separate
          // from dancing so an emote and a dance never fight over the same
          // fields (see playEmote and its countdown beside danceTimeLeft's).
          emoting: false,
          emoteClip: null,
          emoteTimeLeft: 0,
          emoteCooldown: 0,
          // Rare "expression" icon-bubble state (love/idea/anger/team/thumbs-up/music/sleep).
          // Purely a display overlay — see showExpression; never influences
          // movement, clip selection, seat, or dance state.
          bubbleExpr: -1,
          bubbleTimeLeft: 0,
          bubbleCooldown: 0,
          // Edge-detect latches for the idea/sleep/anger bubble triggers
          // (idle→active, walking→seated, idle→engaged transitions).
          prevActive: false,
          prevSitting: false,
          prevEngaging: false,
          // Set each frame from idleAndStill (see below) so other agents can
          // read "was this agent idle-still THIS frame" for the love-bubble
          // proximity gate. Display-only; never drives movement/state.
          idleStill: false,
          // Team-formation signal latch (Part 3): true once this lead has
          // played its "signal" emote for the CURRENT team; reset to false
          // when the team disbands so a reformed team signals again.
          teamSignaled: false,
          // Persistent "team active" bubble state (lead only): true from the
          // 0->=1 child-count edge until the count returns to 0 AND the
          // TEAM_BUBBLE_MIN_MS floor has elapsed. teamActiveSince is the
          // performance.now()/Date.now() timestamp the bubble started, used
          // to drive the rainbow burst -> solid-green pulse in drawTeamBubble
          // and to enforce the floor. While true, showExpression refuses to
          // touch this entry's bubble (non-interruptible).
          teamActive: false,
          teamActiveSince: 0,
          // Edge-detect latch for the worker "just joined a team" bubble
          // (Part 3b): true while this agent is currently a child of a
          // visible lead, so the false→true transition fires once per join.
          prevInTeam: false,
          // Conga-line state (assigned/cleared by updateConga).
          congaIndex: -1,
          // Sitting state (idle festivity, mirrors solo-dance system).
          sitting: false,
          sitSeatId: null,
          sitTimeLeft: 0,
          // Arrival-hysteresis latch shared by wander/build/combat/seat
          // movement (see WANDER_ARRIVED_EPS / WANDER_RESUME_EPS).
          settled: false,
          // Extinguish (Phase 2): id of the smoking object this idle char is
          // routed to (null = none); eligibility republished each frame below.
          extinguishTargetId: null,
          extinguishEligible: false,
          // Ring-slot index (0..EXTINGUISH_MAX_ASSIGN-1, -1 = unassigned) this
          // repairer occupies at its target object, assigned by
          // assignExtinguishers and consumed by the movement loop to derive a
          // distinct stand position (see EXTINGUISH_STAND_RADIUS).
          extinguishStandIdx: -1,
          // Resolved world-space stand spot for the current assignment,
          // recomputed each frame by the movement loop; read cross-function by
          // updateExtinguishProgress's per-repairer arrival tally.
          extinguishStandNx: null,
          extinguishStandNy: null,
          // Cosmetic "dazed on damage" state (see DAZE_* tunables above).
          // dazePhase: null (not dazed) | "retreat" (seeking/walking to a
          // seat) | "seated" (holding the recovery countdown).
          dazePhase: null,
          dazeTimeLeft: 0,
          // Post-recovery immunity window so a just-recovered agent doesn't
          // instantly re-daze off the next stray hit.
          dazeReentryCd: 0,
        };
      }
      const charEntry = agentCharMap[agent.id];

      // ── Active check ───────────────────────────────────────────────
      // Pure function of the agentMetrics entry — must stay identical to the
      // agent-metrics panel's showActive (the single source of truth) so the
      // canvas and panel can never diverge. worker.state intentionally does
      // NOT influence this; it's still used elsewhere below for animation.
      const isActive = isMetricsAgentActive(agent);
      charEntry.isActive = isActive; // surfaced to the draw pass for the active light

      // ── Dazed-on-damage: reentry-cooldown decay + ACTIVE override ────
      // Decays unconditionally every frame (not just while dazed) so a
      // just-recovered agent's immunity window keeps counting down even
      // while it's off doing something else. ACTIVE always wins, instantly:
      // an agent that goes/stays active drops the daze the moment it's
      // noticed here — frees the seat if it had claimed/reached one and
      // clears the dazed bubble — so the rest of this frame's isEngaging/
      // isBuilding/idleAndStill logic below runs exactly as if it had never
      // been dazed. See DAZE_* consts and the retreat/seated block below.
      if (charEntry.dazeReentryCd > 0) charEntry.dazeReentryCd = Math.max(0, charEntry.dazeReentryCd - delta);
      if (isActive && charEntry.dazePhase != null) {
        freeAgentSeat(charEntry);
        charEntry.dazePhase = null;
        charEntry.dazeTimeLeft = 0;
        charEntry.bubbleExpr = -1;
        charEntry.bubbleTimeLeft = 0;
      }

      // Leader throne (Feature: leader-throne): recomputed every frame from
      // the live charIds/rosterOrder — see isLeaderEntry's doc. Reused below
      // by the stale-throne-occupant check, the sit-chance/dwell tuning, and
      // the seat-claim throne reserve/preference.
      const isLeader = isLeaderEntry(charEntry, idx, charIds);

      // ── Idea bubble (rare, on idle→active transition) ─────────────
      // Display-only: does not affect isActive or anything derived from it.
      if (isActive && !charEntry.prevActive && Math.random() < IDEA_CHANCE) showExpression(charEntry, 1, 1.6);
      charEntry.prevActive = isActive;

      // ── Team-join bubble (Part 3b, worker side) ────────────────────
      // When this agent becomes a child of a visible lead (leadIds, built
      // above), show the team bubble once on the false→true join edge.
      // Display-only; mirrors the prevActive/prevSitting latch pattern.
      const inTeam = !!(agent && agent.parentId && leadIds.has(agent.parentId));
      if (inTeam && !charEntry.prevInTeam && !charEntry.emoting) showExpression(charEntry, 3, 2.0);
      charEntry.prevInTeam = inTeam;

      // ── Team-formation signal (Part 3, rare/informative) ──────────────
      // When this agent is a visible team lead (tier === "lead") and it has
      // ≥1 active worker child, play a one-shot "signal" (arms-up rally)
      // emote once per team-formation. teamSignaled latches so it fires only
      // on the 0→≥1 transition, and resets on disband so a reformed team
      // signals again. Defensive field access — a lead may lack a char entry
      // elsewhere, but here charEntry always exists (just created above).
      if (((agent && agent.tier) || "").toLowerCase() === "lead") {
        const leadTeamSize = leadChildCount[agent.id] || 0;
        const teamNowMs = performance.now ? performance.now() : Date.now();
        if (leadTeamSize >= 1) {
          // Persistent team bubble: latch on on the 0->=1 edge and hold while
          // ANY active child exists (see drawTeamBubble for the render side).
          if (!charEntry.teamActive) {
            charEntry.teamActive = true;
            charEntry.teamActiveSince = teamNowMs;
          }
          const leadWorkerState = worker ? worker.state : null;
          const leadIsWalking = leadWorkerState === "walk" || leadWorkerState === "arrive" || leadWorkerState === "leave";
          if (!charEntry.teamSignaled && !charEntry.dancing && !charEntry.emoting && !leadIsWalking) {
            playEmote(charEntry, "signal", 1.4);
            charEntry.teamSignaled = true;
          }
        } else if (charEntry.teamActive) {
          // Active children dropped to 0. Hold the bubble until the
          // TEAM_BUBBLE_MIN_MS floor has elapsed (even if the team completed
          // in well under that), THEN clear it and fire the thumbs-up payoff.
          const elapsed = teamNowMs - charEntry.teamActiveSince;
          if (elapsed >= TEAM_BUBBLE_MIN_MS) {
            charEntry.teamActive = false;
            charEntry.teamSignaled = false;
            showExpression(charEntry, 4, 2.0);
          }
        }
      }

      // ── Conga line (ultra-rare easter egg) ───────────────────────────
      // While a conga is active and this agent is enrolled, it fully preempts
      // engage/build/wander/dance: the agent snakes around the perimeter as
      // part of the line. Movement target is resolved here; the shared "step
      // toward destination" block below actually moves it.
      const inConga = congaActive && charEntry.congaIndex >= 0 && congaWaypoints.length >= 3;
      if (inConga) {
        // A conga member never dances or sits.
        charEntry.dancing = false;
        charEntry.danceTimeLeft = 0;
        if (charEntry.sitting || charEntry.sitSeatId != null) freeAgentSeat(charEntry);
        if (charEntry.congaIndex === 0) {
          // Leader: chase the current waypoint; advance on arrival (wrap).
          const wp = congaWaypoints[congaWaypointIdx % congaWaypoints.length];
          const wdx = wp[0] - charEntry.nx, wdy = wp[1] - charEntry.ny;
          if (Math.sqrt(wdx * wdx + wdy * wdy) <= WANDER_ARRIVED_EPS + 2) {
            congaWaypointIdx = (congaWaypointIdx + 1) % congaWaypoints.length;
          }
          const nwp = congaWaypoints[congaWaypointIdx % congaWaypoints.length];
          charEntry.destNx = nwp[0];
          charEntry.destNy = nwp[1];
        } else {
          // Follower: trail the agent ahead (already updated this frame) by
          // CONGA_TRAIL native px along the line toward it.
          const aheadId = congaOrder[charEntry.congaIndex - 1];
          const ahead = aheadId ? agentCharMap[aheadId] : null;
          if (ahead) {
            const adx = ahead.nx - charEntry.nx, ady = ahead.ny - charEntry.ny;
            const ad = Math.sqrt(adx * adx + ady * ady) || 1;
            charEntry.destNx = ahead.nx - (adx / ad) * CONGA_TRAIL;
            charEntry.destNy = ahead.ny - (ady / ad) * CONGA_TRAIL;
          }
        }
      }

      // ── EVICT combat targeting (Phase 2b / idle ambient combat) ─────
      // While any enemy is alive, agents STOP building/wandering and instead
      // engage the nearest alive enemy: walk to melee range, then tick its
      // hp down. This fully preempts the Phase 2a build block below
      // (isBuilding stays false so build standoff logic never runs).
      // NOTE: no longer gated on isActive — idle agents defend/fight back
      // too (ambient combat), not just agents with a live coding task. This
      // mirrors how ACTIVE agents already engage from anywhere on the floor
      // (no proximity gate), so idle agents behave symmetrically rather than
      // needing a separate "nearby only" radius. Build (isBuilding) remains
      // isActive-gated below — only combat engagement is now unconditional.
      let isEngaging = false;
      let engageInRange = false;
      // A celebrating (dancing) agent pauses combat for the dance's duration.
      // A dazed agent (dazePhase != null) also sits out combat entirely —
      // "stop fighting" is part of the dazed-on-damage cosmetic state
      // machine (see DAZE_* consts); it resumes once daze clears.
      if (!inConga && !charEntry.dancing && enemiesAlive && charEntry.dazePhase == null) {
        let nearestEnemy = null, nearestDist = Infinity;
        for (const en of activeEnemies) {
          if (en.fleeing) continue; // Change 2: fleeing enemies are not threats
          const ddx = en.nx - charEntry.nx, ddy = en.ny - charEntry.ny;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < nearestDist) { nearestDist = d; nearestEnemy = en; }
        }
        // ── Target STICKINESS ──────────────────────────────────────────────
        // Keep engaging the SAME enemy (charEntry.combatTargetInstanceId) until
        // another enemy is closer by more than TARGET_SWITCH_MARGIN, so the
        // agent's target (and its facing) doesn't flip between two equidistant
        // enemies each frame. Drop the sticky target if it's gone or now fleeing.
        let nearest = null, nearestPickDist = nearestDist;
        const stickyEnemy = charEntry.combatTargetInstanceId
          ? activeEnemies.find((e) => e.instance_id === charEntry.combatTargetInstanceId && !e.fleeing)
          : null;
        if (stickyEnemy) {
          const cdx = stickyEnemy.nx - charEntry.nx, cdy = stickyEnemy.ny - charEntry.ny;
          const currentDist = Math.sqrt(cdx * cdx + cdy * cdy);
          if (nearestEnemy && nearestDist < currentDist - TARGET_SWITCH_MARGIN) {
            nearest = nearestEnemy; nearestPickDist = nearestDist;
          } else {
            nearest = stickyEnemy; nearestPickDist = currentDist;
          }
        } else if (nearestEnemy) {
          nearest = nearestEnemy; nearestPickDist = nearestDist;
        }
        nearestDist = nearestPickDist;
        if (nearest) {
          isEngaging = true;
          nearest.targetAgentId = agent.id;
          charEntry.combatTargetInstanceId = nearest.instance_id;
          // Ranged combat upgrade: once the rack is built, agents engage from
          // a longer standoff distance and shoot; otherwise they close to
          // melee range. Damage applies at whichever range is in effect.
          const effectiveEngageRange = rangedUnlocked ? RANGED_ENGAGE_RANGE : ENEMY_ENGAGE_RANGE;
          if (nearestDist > effectiveEngageRange) {
            // Walk toward the enemy.
            charEntry.destNx = nearest.nx;
            charEntry.destNy = nearest.ny;
          } else {
            // In range — hold horizontal position, face and damage the enemy.
            // Ranged shooters also vertical-align (destNy) to the target's
            // row so their shots stay near-horizontal; melee holds fully.
            engageInRange = true;
            charEntry.destNx = charEntry.nx;
            charEntry.destNy = rangedUnlocked ? nearest.ny : charEntry.ny;
            nearest.hp -= AGENT_DPS * delta;
            // Enemy faces its attacker; agent facing is set below from relative x.
            nearest.facingLeft = (charEntry.nx > nearest.nx);
            // ── Cosmetic hit-reaction (idle ambient combat) ────────────────
            // Occasionally play a brief "block" flinch pose while toe-to-toe
            // with an attacking enemy. Purely visual: no damage, no eviction
            // impact — nearest.hp / cycleRivalsEvicted are untouched here.
            // Rate-limited by charEntry.hitReactCooldown (lazy-init, randomized
            // ~2-4s) so it reads as an occasional flinch, not every frame.
            // playEmote sets emoting/emoteClip="block"/emoteTimeLeft; the clip
            // selection pass (desiredClip) applies charEntry.emoteClip as an
            // override AFTER the melee/shoot engage override, so "block" briefly
            // interrupts melee/shoot exactly like the existing point/signal
            // one-shots, then returns to the normal engage clip on its own.
            if (typeof charEntry.hitReactCooldown !== "number") {
              charEntry.hitReactCooldown = HIT_REACT_COOLDOWN_MIN + Math.random() * (HIT_REACT_COOLDOWN_MAX - HIT_REACT_COOLDOWN_MIN);
            }
            charEntry.hitReactCooldown -= delta;
            if (nearest.combatMode === "attack" && charEntry.hitReactCooldown <= 0) {
              playEmote(charEntry, "block", HIT_REACT_HOLD_SEC);
              charEntry.hitReactCooldown = HIT_REACT_COOLDOWN_MIN + Math.random() * (HIT_REACT_COOLDOWN_MAX - HIT_REACT_COOLDOWN_MIN);
              showExpression(charEntry, 7, 1.2);
              // ── Dazed-on-damage TRIGGER (cosmetic only) ──────────────
              // Only an IDLE agent (never active — see the ACTIVE override
              // near isActive above) that isn't already dazed and isn't in
              // its post-recovery immunity window enters the daze state
              // machine. Repeated hits while already dazed are ignored
              // (dazePhase != null short-circuits here every subsequent
              // frame). Defensively free any seat it might already hold
              // (shouldn't normally happen mid-engage) before retreating.
              if (!isActive && charEntry.dazePhase == null && (charEntry.dazeReentryCd || 0) <= 0) {
                if (charEntry.sitSeatId != null) freeAgentSeat(charEntry);
                charEntry.dazePhase = "retreat";
                charEntry.dazeTimeLeft = DAZE_SAFETY_MAX_SEC;
              }
            }
            // Change C: ranged agents fire a projectile at the enemy on a
            // throttled cadence (target position snapshotted at fire time).
            // No-op when the theme lacks the projectile asset (fallback).
            if (rangedUnlocked) {
              if (typeof charEntry.shotCooldown !== "number") charEntry.shotCooldown = 0;
              charEntry.shotCooldown -= delta;
              // Only fire once the shot is near-horizontal (within
              // MAX_SHOT_SLOPE grade) — otherwise the shooter keeps walking
              // vertically (via destNy above) to line up. A blocked shot
              // does NOT reset the cooldown, so it fires promptly the first
              // aligned frame once it's ready.
              const sdx = Math.abs(nearest.nx - charEntry.nx);
              const sdy = Math.abs(nearest.ny - charEntry.ny);
              const shotAligned = sdy <= MAX_SHOT_SLOPE * Math.max(sdx, 1);
              if (charEntry.shotCooldown <= 0 && shotAligned) {
                charEntry.shotCooldown = PROJECTILE_SPAWN_INTERVAL;
                // Push the spawn origin toward the shooter's leading (facing)
                // edge so the shot reads as leaving the gun rather than the
                // sprite's horizontal middle. Reproduce the SAME depth-scale/
                // sprite-size formula the agent draw branch uses below
                // (spriteSize = 64 * depthScale * effectiveCharScale(charId)),
                // then convert that canvas-px half-width into native space via
                // walkableNativeW/bgW (inverse of nativeToCanvas's scale
                // factor; bgW is the local const computed earlier this frame
                // in render()). charEntry.facingLeft is the same field the
                // draw code mirrors on (facingLeft === true → sprite mirrored
                // left), so the sign matches the visible flip exactly.
                const shooterCharId = charIds.length > 0 ? charIds[idx % charIds.length] : null;
                const shooterScale = shooterCharId ? effectiveCharScale(shooterCharId) : themeCharacterScale;
                const shooterTDepth = Math.max(0, Math.min(1, (charEntry.ny - polyMinY) / polyRangeY));
                const shooterDepthScale = (0.8 + shooterTDepth * 0.3) * themeOverallScale;
                const shooterHalfWidthPx = Math.round(64 * shooterDepthScale * shooterScale) / 2;
                const shooterHalfWidthNative = shooterHalfWidthPx * (walkableNativeW / bgW);
                const shooterFacingSign = charEntry.facingLeft ? -1 : 1;
                const shooterMuzzleForward = shooterHalfWidthNative * PROJECTILE_MUZZLE_FRAC;
                // Origin height (PROJECTILE_ORIGIN_HEIGHT_FRAC of the
                // shooter's own RENDERED sprite height, not a flat fraction
                // of walkableNativeH). Reproduces the real draw-time
                // depthScale — shooterDepthScale above omits sceneFitScale
                // (it only feeds the X muzzle push, which is unaffected by
                // it), so sceneFitScale is folded in separately here — then
                // converts that canvas-px height into native space via the
                // same bgH ratio the X conversion above uses for bgW.
                const shooterFullDepthScale = shooterDepthScale * sceneFitScale;
                const shooterSpriteHeightPx = Math.round(64 * shooterFullDepthScale * shooterScale);
                const shooterSpriteHeightNative = shooterSpriteHeightPx * (walkableNativeH / bgH);
                const shooterOriginNy = charEntry.ny - PROJECTILE_ORIGIN_HEIGHT_FRAC * shooterSpriteHeightNative;
                spawnProjectile(charEntry.nx + shooterFacingSign * shooterMuzzleForward, shooterOriginNy, nearest.nx, nearest.ny);
              }
            }
            // Change 2: on defeat, transition to FLEEING (run off nearest edge)
            // rather than vanishing. A fleeing enemy is no longer a threat, so
            // agents drop it immediately (enemiesAlive / nearest search skip it).
            if (nearest.hp <= 0 && !nearest.fleeing) {
              nearest.hp = 0;
              nearest.fleeing = true;
              nearest.targetAgentId = null;
              // Show the "dazed/hit" (index 7) bubble once as the rival is
              // evicted. The !fleeing guard above makes this the single
              // once-per-rival eviction transition. showExpression is a no-op
              // if the theme lacks an expression atlas.
              showExpression(nearest, 7, HURT_EXPR_SEC);
              // Celebration: only dance once ALL enemies are defeated (none
              // still fighting) — nearest.fleeing is already true above, so
              // this check naturally excludes it.
              if (!activeEnemies.some((e) => !e.fleeing)) {
                startAgentDance(charEntry);
                if (Math.random() < HAPPY_BUBBLE_CHANCE) showExpression(charEntry, 4, 1.8);
              }
              // Distances to each native edge; run out the nearest one.
              const dLeft = nearest.nx;
              const dRight = walkableNativeW - nearest.nx;
              const dTop = Infinity; // rivals must never flee up/through the ceiling — only left/right/down
              const dBottom = walkableNativeH - nearest.ny;
              const minEdge = Math.min(dLeft, dRight, dTop, dBottom);
              const FLEE_MARGIN = 120;
              if (minEdge === dLeft) {
                nearest.fleeDestNx = -FLEE_MARGIN;
                nearest.fleeDestNy = nearest.ny;
              } else if (minEdge === dRight) {
                nearest.fleeDestNx = walkableNativeW + FLEE_MARGIN;
                nearest.fleeDestNy = nearest.ny;
              } else if (minEdge === dTop) {
                nearest.fleeDestNx = nearest.nx;
                nearest.fleeDestNy = -FLEE_MARGIN;
              } else {
                nearest.fleeDestNx = nearest.nx;
                nearest.fleeDestNy = walkableNativeH + FLEE_MARGIN;
              }
            }
          }
        }
      }
      if (!isEngaging) charEntry.combatTargetInstanceId = null;

      // ── Anger bubble (rare, on idle→engaged transition) ────────────────
      // Display-only, mirrors the prevActive/prevSitting latch pattern above
      // so it fires once when combat begins rather than spamming every frame
      // isEngaging stays true.
      if (isEngaging && !charEntry.prevEngaging && Math.random() < ANGER_CHANCE) showExpression(charEntry, 2, 1.6);
      charEntry.prevEngaging = isEngaging;

      // ── BUILD targeting (Phase 2a) ──────────────────────────────────
      // Active agents head for the current ACTIVE build target's standoff
      // spot instead of free-roaming, once one exists. Idle agents and
      // active agents with no build target (nothing active yet, or all
      // built) are untouched — they keep the wander path exactly as before.
      // Suppressed entirely while engaging an enemy (Phase 2b preemption).
      let isBuilding = false;
      if (!inConga && !isEngaging && !charEntry.dancing && isActive && activeBuildPlacement) {
        // Once already settled (arrived + latched, see charEntry.settled) at
        // THIS same build target, freeze destNx/destNy — no per-frame
        // re-target — so a stationary builder never gets nudged back into
        // "walking" by a recomputed standoff point. Only re-resolve the
        // standoff spot while still approaching, or when the target changes.
        const isNewTarget = charEntry.buildTargetId !== activeBuildObj.object_id;
        if (isNewTarget || !charEntry.settled) {
          // Alternate standoff side among builders assigned this frame.
          const side = (builderSideCounter++ % 2 === 0) ? -1 : 1;
          const ax = activeBuildPlacement.nx;
          const ay = activeBuildPlacement.ny;
          // Perpendicular-ish left/right offset along native X, small native Y
          // nudge so multiple builders on the same side don't fully overlap.
          const standoffX = ax + side * activeBuildExclusionR;
          const standoffY = ay + (side * 0.15) * activeBuildExclusionR;
          const standoff = clampToPolygon(standoffX, standoffY, walkablePolygon);
          charEntry.destNx = standoff[0];
          charEntry.destNy = standoff[1];
          if (isNewTarget) charEntry.settled = false;
        }
        charEntry.buildTargetId = activeBuildObj.object_id;
        isBuilding = true;
      } else if (!isEngaging && !inConga) {
        charEntry.buildTargetId = null;
      }

      // ── Solo dance (rare idle festivity) ──────────────────────────
      // An idle, stationary agent may randomly break into a short dance. It
      // is fully preempted by conga/engage/build. While dancing it holds
      // position and a manual frame mixer swaps the three dance frames.
      const idleAndStill = !isActive && !isBuilding && !isEngaging && !inConga;
      charEntry.idleStill = idleAndStill;

      // ── Dazed-on-damage: retreat/seated phases (cosmetic) ───────────────
      // Only reached while !isActive (the ACTIVE override near isActive
      // above clears dazePhase before this point whenever the agent is/
      // becomes active), so this never fights with build/engage logic.
      // Movement itself is handed off to the EXISTING "Sitting" maintenance
      // block further below (walk-to-seat/arrival/hold) once a seat is
      // claimed here via charEntry.sitSeatId — this block only claims the
      // seat and owns the daze timers/phase transitions.
      if (charEntry.dazePhase === "retreat") {
        if (charEntry.sitSeatId == null) {
          // Seat-seek: mirrors the normal idle sit-decision's throne-
          // reservation rule (leaderSeatId/isLeader — a dazed non-leader
          // never takes the throne), but unconditional (no SIT_CHANCE roll)
          // and retried every frame until a seat is free or the safety
          // timer below gives up.
          let dazeFreeSeatId = null;
          const dazeThroneId = leaderSeatId();
          if (isLeader && dazeThroneId != null && seatOccupancy[dazeThroneId] == null) {
            seatOccupancy[dazeThroneId] = charEntry.__id;
            dazeFreeSeatId = dazeThroneId;
          }
          if (dazeFreeSeatId == null) {
            for (const d of themeDecor) {
              const sid = d.decor_id;
              if (sid === dazeThroneId && !isLeader) continue;
              const p = sid != null ? decorPlacement[sid] : null;
              if (p && p.sittable && seatOccupancy[sid] == null && !themeDecorHidden.has(sid)) {
                seatOccupancy[sid] = charEntry.__id;
                dazeFreeSeatId = sid;
                break;
              }
            }
          }
          if (dazeFreeSeatId != null) {
            charEntry.sitSeatId = dazeFreeSeatId;
            charEntry.sitting = false; // en route — the sitting-maintenance block below walks it there
            const seat = decorPlacement[dazeFreeSeatId];
            charEntry.destNx = seat.sitNx;
            charEntry.destNy = seat.sitNy;
          }
        } else if (charEntry.sitting) {
          // Arrived (the sitting-maintenance block below latched sitting=
          // true on a prior frame) — hand off from "retreat" to "seated"
          // and start the short cosmetic recovery countdown.
          charEntry.dazePhase = "seated";
          charEntry.dazeTimeLeft = DAZE_SEATED_RECOVER_SEC;
        }
        if (charEntry.dazePhase === "retreat") {
          charEntry.dazeTimeLeft -= delta;
          if (charEntry.dazeTimeLeft <= 0) {
            // Safety cap: no seat ever opened up — give up and recover in
            // place rather than dazing forever. Leaves sitSeatId untouched
            // (null if none was ever found, or a still-en-route claim) so
            // normal idle logic just takes over from wherever it is.
            charEntry.dazePhase = null;
            charEntry.dazeReentryCd = DAZE_REENTRY_COOLDOWN_SEC;
            charEntry.bubbleExpr = -1;
            charEntry.bubbleTimeLeft = 0;
          }
        }
      } else if (charEntry.dazePhase === "seated") {
        charEntry.dazeTimeLeft -= delta;
        if (charEntry.dazeTimeLeft <= 0) {
          // Recovered: clear daze state only — leave sitSeatId/sitting alone
          // so the existing sit-maintenance block below keeps owning the
          // seat and stands the agent up normally on its own timer (may
          // "stand and leave the seat normally", per spec).
          charEntry.dazePhase = null;
          charEntry.dazeReentryCd = DAZE_REENTRY_COOLDOWN_SEC;
          charEntry.bubbleExpr = -1;
          charEntry.bubbleTimeLeft = 0;
        }
      }
      // Keep the dazed bubble visible continuously through retreat + seated,
      // bypassing showExpression's shared BUBBLE_COOLDOWN_SEC/teamActive
      // guards (this is a stronger, state-driven override, not a rare
      // one-shot bubble) — and stop it the instant daze clears (either
      // recovery path just above, or the ACTIVE override near isActive).
      if (charEntry.dazePhase != null) {
        charEntry.bubbleExpr = DAZE_EXPR_INDEX;
        charEntry.bubbleTimeLeft = Math.max(charEntry.bubbleTimeLeft || 0, 1.0);
      }

      // ── Extinguish eligibility + intent (Phase 2, cosmetic) ────────────
      // Publish eligibility (read by assignExtinguishers next frame — a 1-frame
      // lag is fine here). Then derive this-frame intent: an idle char with a
      // still-smoking assigned object that isn't fighting a rival (combat always
      // wins). extinguishArrived latches once within EXTINGUISH_ARRIVE_EPS of it.
      charEntry.extinguishEligible = idleAndStill && (charEntry.sitSeatId == null) && !isEngaging && charEntry.dazePhase == null;
      const isExtinguishing = !!(
        charEntry.extinguishTargetId &&
        objectSmoke[charEntry.extinguishTargetId] &&
        charEntry.extinguishEligible !== false &&
        !isEngaging
      );
      let extinguishArrived = false;
      if (isExtinguishing) {
        const ep = objectPlacement[charEntry.extinguishTargetId];
        if (ep) {
          // Distinct stand spot: a small ring around the object, one slot per
          // assigned repairer (idx from assignExtinguishers), so up to
          // EXTINGUISH_MAX_ASSIGN repairers settle at different points instead
          // of piling on the object's exact center (which kept anti-overlap
          // separation jostling them and isMoving never latching false).
          const idx = (typeof charEntry.extinguishStandIdx === "number" && charEntry.extinguishStandIdx >= 0)
            ? charEntry.extinguishStandIdx : 0;
          const angle = (idx / EXTINGUISH_MAX_ASSIGN) * Math.PI * 2;
          const standRaw = clampToPolygon(
            ep.nx + Math.cos(angle) * EXTINGUISH_STAND_RADIUS,
            ep.ny + Math.sin(angle) * EXTINGUISH_STAND_RADIUS,
            walkablePolygon
          );
          charEntry.extinguishStandNx = standRaw[0];
          charEntry.extinguishStandNy = standRaw[1];
          const edx = charEntry.extinguishStandNx - charEntry.nx, edy = charEntry.extinguishStandNy - charEntry.ny;
          extinguishArrived = Math.sqrt(edx * edx + edy * edy) <= EXTINGUISH_ARRIVE_EPS;
        }
      } else {
        charEntry.extinguishStandNx = null;
        charEntry.extinguishStandNy = null;
      }

      // ── Proximity "love" bubble (rare, requires a nearby idle-still agent) ──
      // Independent of the wander-decision else-if chain below (does not
      // consume a wander-decision tick or touch wanderTimer) so it can never
      // interfere with destination picking. Display-only. other.idleStill may
      // reflect this frame or last frame depending on agentCharMap iteration
      // order — fine for a cosmetic trigger.
      if (idleAndStill && !charEntry.emoting && !charEntry.extinguishTargetId && (charEntry.bubbleCooldown || 0) <= 0 && Math.random() < LOVE_CHANCE * delta) {
        const myNx = charEntry.nx, myNy = charEntry.ny;
        for (const oid in agentCharMap) {
          const other = agentCharMap[oid];
          if (other === charEntry || !other.idleStill) continue;
          if (other.extinguishTargetId) continue;
          if (typeof other.nx !== "number" || typeof other.ny !== "number") continue;
          const dx = other.nx - myNx, dy = other.ny - myNy;
          if (dx * dx + dy * dy <= LOVE_NEAR_NATIVE_SQ) { showExpression(charEntry, 0, 1.6); break; }
        }
      }

      if (charEntry.dancing) {
        if (inConga) {
          // Conga fully preempts any dance (idle solo-dance OR celebration).
          // Build/engage no longer force a cancel: they are gated on !dancing
          // above, so a celebrating ACTIVE agent keeps dancing for its 5s and
          // resumes build/fight once danceTimeLeft elapses below.
          charEntry.dancing = false;
          charEntry.danceTimeLeft = 0;
        } else {
          charEntry.danceTimeLeft -= delta;
          if (charEntry.danceTimeLeft <= 0) {
            charEntry.dancing = false;
            charEntry.danceTimeLeft = 0;
          } else {
            // Frame mixer: swap dance frame, never the same one twice in a row.
            charEntry.danceFrameTimer -= delta;
            if (charEntry.danceFrameTimer <= 0) {
              let idx = Math.floor(Math.random() * 3); // 0,1,2 -> slots 17,18,19
              if (idx === charEntry.lastDanceIdx) idx = (idx + 1) % 3;
              charEntry.lastDanceIdx = idx;
              const a = charEntry.animState;
              a.action = "dance";
              a.frameIndex = idx;
              a.direction = 1;
              a.elapsed = 0;
              a.completed = false;
              charEntry.danceFrameTimer = DANCE_FRAME_SWAP;
              // Change 3: alternate facing on each dance frame swap so the
              // dancer turns side to side — doubles the apparent animation
              // from the same 3 frames. Draw applies this flip specially for
              // dancing agents (dance clip stays flippable:false in ATLAS_CLIPS).
              charEntry.facingLeft = !charEntry.facingLeft;
            }
          }
        }
      }

      // ── Emote countdown (rare one-shot point/signal hold) ─────────
      // Mirrors the danceTimeLeft countdown above but for the separate
      // emoting/emoteClip/emoteTimeLeft fields; uses the same per-frame
      // `delta` the dance countdown uses. emoteCooldown rate-limits how
      // often a NEW playful "point" can start (Part 4) — decremented
      // unconditionally so it counts down even while not emoting.
      if (charEntry.emoting) {
        charEntry.emoteTimeLeft -= delta;
        if (charEntry.emoteTimeLeft <= 0) {
          charEntry.emoting = false;
          charEntry.emoteClip = null;
        }
      }
      if (charEntry.emoteCooldown > 0) charEntry.emoteCooldown -= delta;

      // ── Expression-bubble countdown (mirrors the emote countdown above) ──
      if (charEntry.bubbleTimeLeft > 0) {
        charEntry.bubbleTimeLeft -= delta;
        if (charEntry.bubbleTimeLeft <= 0) charEntry.bubbleExpr = -1;
      }
      if (charEntry.bubbleCooldown > 0) charEntry.bubbleCooldown -= delta;

      // ── Sitting (idle festivity, mirrors solo-dance) ──────────────
      // A seated (or walking-to-seat) agent holds its seat until it either
      // finishes SIT_SECONDS or is preempted by going active / building /
      // engaging / conga. sitSeatId being set means "committed to a seat"
      // (either en route or already seated). When preempted, free the seat.
      if (charEntry.sitSeatId != null) {
        // Stale-throne safety (Feature: leader-throne): a roster drag-
        // reorder can change who's leader while a FORMER leader is still
        // seated on the throne. Catch and evict it here — this only runs
        // for currently-seated/en-route agents (a small subset, never a
        // full-roster scan), so it's cheap even though it's per-frame.
        if (charEntry.sitSeatId === leaderSeatId() && !isLeader) {
          freeAgentSeat(charEntry);
        } else if (!idleAndStill) {
          // Went active / conga / enemy / build took priority — stand up.
          freeAgentSeat(charEntry);
        } else {
          const seat = decorPlacement[charEntry.sitSeatId];
          if (!seat) {
            freeAgentSeat(charEntry);
          } else if (!charEntry.sitting) {
            // Walking to the seat; arrive when close enough to the sit-point.
            const sdx = seat.sitNx - charEntry.nx;
            const sdy = seat.sitNy - charEntry.ny;
            if (Math.sqrt(sdx * sdx + sdy * sdy) <= SIT_ARRIVED_EPS) {
              charEntry.sitting = true;
              // Leader-throne dwell: the leader lingers on its seat much
              // longer than a normal idle sit (LEADER_SIT_DWELL_MULT).
              charEntry.sitTimeLeft = SIT_SECONDS * (isLeader ? LEADER_SIT_DWELL_MULT : 1);
              // Record the chair's decor id so the draw path can raise the
              // seated character in proportion to the chair's decor scale
              // (sitSeatId IS the decorPlacement/effectiveDecorScale key).
              charEntry.seatDecorId = charEntry.sitSeatId;
              // Snap exactly onto the sit-point and hold.
              charEntry.nx = seat.sitNx;
              charEntry.ny = seat.sitNy;
              charEntry.destNx = seat.sitNx;
              charEntry.destNy = seat.sitNy;
            } else {
              // Keep walking toward the seat's sit-point.
              charEntry.destNx = seat.sitNx;
              charEntry.destNy = seat.sitNy;
            }
          } else {
            // Seated: hold position, tick the timer, then stand + free seat.
            charEntry.destNx = charEntry.nx;
            charEntry.destNy = charEntry.ny;
            charEntry.sitTimeLeft -= delta;
            if (charEntry.sitTimeLeft <= 0) {
              freeAgentSeat(charEntry);
              charEntry.wanderTimer = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
            }
          }
        }
      }

      // ── Sleep bubble (rare, on transition into seated) ─────────────
      // charEntry.sitting has its final value for this frame now (set true
      // on arrival above, held true while seated, or false/never-seated).
      // prevSitting latches the transition so this fires at most once per
      // sit-session — a per-frame roll would spam since a seated pose is
      // held for seconds and BUBBLE_COOLDOWN_SEC alone wouldn't prevent
      // re-firing every time it expires while still seated. Display-only.
      if (charEntry.sitting && !charEntry.prevSitting && Math.random() < SLEEP_CHANCE) showExpression(charEntry, 6, 1.8);
      charEntry.prevSitting = charEntry.sitting;


      // ── Wander logic (native polygon space) ───────────────────────
      // Dancing agents hold position (no wander). Conga members are driven
      // by updateConga's destination assignment above.
      if (!inConga) charEntry.wanderTimer -= delta;
      if (!inConga && !charEntry.dancing && charEntry.sitSeatId == null && !isBuilding && !isEngaging && !isExtinguishing && charEntry.dazePhase == null && charEntry.wanderTimer <= 0) {
        // At this idle wander-decision point, an eligible idle agent may
        // instead start dancing (rare) or go sit on a free seat (rare).
        // Otherwise pick a new destination.
        if (idleAndStill && !congaActive && Math.random() < DANCE_CHANCE) {
          charEntry.dancing = true;
          charEntry.danceTimeLeft = DANCE_SECONDS_MIN + Math.random() * (DANCE_SECONDS_MAX - DANCE_SECONDS_MIN);
          charEntry.danceFrameTimer = 0;
          charEntry.lastDanceIdx = -1;
          // Hold position while dancing.
          charEntry.destNx = charEntry.nx;
          charEntry.destNy = charEntry.ny;
          charEntry.wanderTimer = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
          showExpression(charEntry, 5, 1.8); // music bubble, coincides with dance start
        } else if (idleAndStill && !congaActive && themeDecor.length > 0 && Math.random() < (isLeader ? LEADER_SIT_CHANCE : SIT_CHANCE)) {
          // Claim a free seat (if any) and start walking to it. The sitting
          // maintenance block above then drives arrival + seated hold. Never
          // triggers while conga is active or the agent is a build/enemy target
          // (both excluded by idleAndStill / !congaActive here).
          // Defensive: an agent should never hold more than one seat. If
          // charEntry somehow already owns a seat (shouldn't happen — the
          // sitting-maintenance block above releases on stand-up — but guard
          // anyway so the invariant "each seat has at most one owner, each
          // agent owns at most one seat" can never be violated), free it
          // before attempting to claim a new one.
          if (charEntry.sitSeatId != null) {
            freeAgentSeat(charEntry);
          }
          let freeSeatId = null;
          // Leader throne (Feature: leader-throne): the leader tries its
          // reserved seat FIRST, ahead of the general scan below, so an idle
          // leader reliably returns to "Seat 1" rather than picking whatever
          // ordinary seat happens to come first in themeDecor.
          const throneId = leaderSeatId();
          if (isLeader && throneId != null && seatOccupancy[throneId] == null) {
            seatOccupancy[throneId] = charEntry.__id;
            freeSeatId = throneId;
          }
          if (freeSeatId == null) {
            for (const d of themeDecor) {
              const sid = d.decor_id;
              // Throne reservation: a non-leader never claims Seat 1, even
              // when it's free — it's kept empty/reserved for the leader
              // (see leaderSeatId/isLeaderEntry).
              if (sid === throneId && !isLeader) continue;
              const p = sid != null ? decorPlacement[sid] : null;
              // H-hidden seats leave the pool entirely — never offered to an
              // idle agent looking for somewhere to sit (see toggleDecorHidden).
              if (p && p.sittable && seatOccupancy[sid] == null && !themeDecorHidden.has(sid)) {
                // Atomic test-and-set: claim the seat the instant it's found
                // free, in this same synchronous iteration — JS's single-
                // threaded execution means no other agent's forEach iteration
                // can run between the seatOccupancy[sid]==null check above and
                // this write, so two agents can never race onto the same seat.
                seatOccupancy[sid] = charEntry.__id;
                freeSeatId = sid;
                break;
              }
            }
          }
          if (freeSeatId != null) {
            charEntry.sitSeatId = freeSeatId;
            charEntry.sitting = false; // en route until arrival
            const seat = decorPlacement[freeSeatId];
            charEntry.destNx = seat.sitNx;
            charEntry.destNy = seat.sitNy;
          } else {
            // No free seat — fall back to a normal idle wander destination.
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * WANDER_RADIUS * 0.5;
            const tx = charEntry.homeNx + Math.cos(angle) * r;
            const ty = charEntry.homeNy + Math.sin(angle) * r;
            const dest = clampToPolygon(tx, ty, walkablePolygon);
            charEntry.destNx = dest[0];
            charEntry.destNy = dest[1];
          }
          charEntry.wanderTimer = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
        } else if (idleAndStill && !congaActive && !charEntry.emoting && (charEntry.emoteCooldown || 0) <= 0 && Math.random() < POINT_CHANCE) {
          // Rare playful "point" emote (Part 4): a quick static hold, gated by
          // its own cooldown so one agent can't spam it. Only reached when the
          // dance roll above did NOT trigger this tick (else-if chain).
          playEmote(charEntry, "point", 1.2);
          charEntry.emoteCooldown = EMOTE_COOLDOWN_SEC;
          // Re-arm the wander timer like the dance/sit branches above, so this
          // rare roll only happens once per wander-decision tick instead of
          // re-rolling every frame while wanderTimer stays <= 0.
          charEntry.wanderTimer = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
        } else {
          // Pick new destination: active agents roam freely; idle agents stay near home.
          let dest;
          if (isActive) {
            dest = randomInsidePoly(walkablePolygon);
          } else {
            // Jitter around home within WANDER_RADIUS; clamp inside polygon.
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * WANDER_RADIUS * 0.5;
            const tx = charEntry.homeNx + Math.cos(angle) * r;
            const ty = charEntry.homeNy + Math.sin(angle) * r;
            dest = clampToPolygon(tx, ty, walkablePolygon);
          }
          charEntry.destNx = dest[0];
          charEntry.destNy = dest[1];
          charEntry.wanderTimer = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
        }
      }

      // ── Extinguish destination override (Phase 2) ──────────────────
      // An assigned idle char walks to its smoking object, then holds (gather
      // around it, don't pile on the exact center). Runs AFTER the wander
      // decision (whose sit/wander branches are gated off for extinguishers)
      // so it has the final say on dest. Combat/build never coexist here
      // (isExtinguishing requires !isEngaging and an idle char never builds).
      if (isExtinguishing && typeof charEntry.extinguishStandNx === "number") {
        if (extinguishArrived) { charEntry.destNx = charEntry.nx; charEntry.destNy = charEntry.ny; }
        else { charEntry.destNx = charEntry.extinguishStandNx; charEntry.destNy = charEntry.extinguishStandNy; }
      }

      // ── Step toward destination ────────────────────────────────────
      // Dancing agents hold position (dest == current pos). Conga leader
      // moves a touch faster so the line snakes; followers use walk speed.
      const dxNative = charEntry.destNx - charEntry.nx;
      const dyNative = charEntry.destNy - charEntry.ny;
      const distNative = Math.sqrt(dxNative * dxNative + dyNative * dyNative);
      const moveSpeed = (inConga && charEntry.congaIndex === 0) ? WANDER_SPEED * 1.2 : WANDER_SPEED;
      let isMoving = false;
      // Synchronized conga cheer: the whole line freezes in place while holding
      // the cheer pose (congaCheerHold shared across all members).
      const congaFrozen = inConga && congaCheerHold > 0;
      // Arrival hysteresis (shared by wander/build/combat/seat-approach, since
      // they all just set destNx/destNy and fall through to this one step):
      // latch "settled" once within WANDER_ARRIVED_EPS, and don't clear it
      // until pushed out past the larger WANDER_RESUME_EPS. A bare
      // `distNative > WANDER_ARRIVED_EPS` gate has no hysteresis, so a small
      // per-frame nudge (agent-separation pass, clamp rounding) that crosses
      // the 3px line would flip movement on/off every frame — the "vibrate"
      // bug. Conga/dance/sitting bypass the latch entirely (their own gates).
      if (charEntry.settled) {
        if (distNative > WANDER_RESUME_EPS) charEntry.settled = false;
      } else if (distNative <= WANDER_ARRIVED_EPS) {
        charEntry.settled = true;
      }
      if (!congaFrozen && !charEntry.dancing && !charEntry.sitting && !charEntry.settled) {
        const beforeNx = charEntry.nx, beforeNy = charEntry.ny;
        const step = Math.min(moveSpeed * delta, distNative);
        charEntry.nx += (dxNative / distNative) * step;
        charEntry.ny += (dyNative / distNative) * step;
        // Clamp inside polygon after movement
        const clamped = clampToPolygon(charEntry.nx, charEntry.ny, walkablePolygon);
        charEntry.nx = clamped[0];
        charEntry.ny = clamped[1];
        const movedNative = Math.hypot(charEntry.nx - beforeNx, charEntry.ny - beforeNy);
        if (movedNative > WANDER_STUCK_EPS) isMoving = true;   // stuck-at-boundary jitter => NOT moving
      }

      // ── Map native pos to canvas ───────────────────────────────────
      const canvasPt = nativeToCanvas(charEntry.nx, charEntry.ny, bgX, bgY, bgW, bgH);
      const cx = canvasPt[0];
      const cy = canvasPt[1];

      // ── Facing ────────────────────────────────────────────────────
      // While engaging an enemy (Phase 2b), face the enemy directly — takes
      // priority over build-facing and movement-facing.
      const engagedEnemy = isEngaging ? activeEnemies.find((e) => e.instance_id === charEntry.combatTargetInstanceId) : null;
      if (isEngaging && engagedEnemy) {
        // Face the enemy — but only re-face when the horizontal offset clears
        // ATTACK_FACING_DEADZONE (native px). When the enemy is nearly directly
        // above/below, keep the current facing so the agent doesn't rapid-flip
        // in place every frame (mirror-blur).
        if (Math.abs(engagedEnemy.nx - charEntry.nx) > ATTACK_FACING_DEADZONE) {
          charEntry.facingLeft = engagedEnemy.nx < charEntry.nx;
        }
      } else if (isBuilding && activeBuildPlacement) {
        // While actively walking to/standing at a build target, face the
        // object directly instead of relying on movement-inferred facing
        // (which would flicker once arrived and isMoving goes false).
        const objCanvasPt = nativeToCanvas(activeBuildPlacement.nx, activeBuildPlacement.ny, bgX, bgY, bgW, bgH);
        if (cx > objCanvasPt[0] + FACING_EPS) charEntry.facingLeft = true;
        else if (cx < objCanvasPt[0] - FACING_EPS) charEntry.facingLeft = false;
      } else {
        // Movement-based facing from the INTENDED direction (stable), only while
        // actually moving, with a native deadzone so a near-vertical mover doesn't flip.
        if (isMoving && Math.abs(dxNative) > WANDER_FACING_NATIVE_EPS) {
          charEntry.facingLeft = dxNative < 0;
        }
      }
      charEntry.prevX = cx;
      charEntry.x = cx;
      charEntry.y = cy;

      // ── Clip selection ─────────────────────────────────────────────
      let desiredClip;
      if (worker) {
        desiredClip = workerStateToClip(worker.state);
      } else {
        desiredClip = isActive ? "walk" : "idle";
      }
      // STRICT RULE: a NON-active agent's STATUS clip may only ever be
      // walk / idle / sit / dance. workerStateToClip can yield "build"
      // (build/haul), "tool_idle" (survey) or "cheer" (celebrate) from a
      // worker record, but build is ACTIVE-ONLY. Clamp any active-only
      // status clip down to walk/idle here so no downstream STATUS branch can
      // surface it for an inactive agent. (isBuilding remains isActive-gated,
      // so the build override below can never fire when !isActive. isEngaging
      // is now UNCONDITIONAL — idle ambient combat — so the melee/shoot
      // override below intentionally overrides this clamp for engaging idle
      // agents too; sit/dance overrides come after and remain valid for
      // inactive agents.)
      if (!isActive && desiredClip !== "walk" && desiredClip !== "idle") {
        desiredClip = "idle";
      }
      // Override with walk while physically moving, else use status clip.
      // "dance"/"sit" (like build/cheer) are excluded so those clips are never
      // clobbered back to walk/idle.
      if (isMoving) desiredClip = "walk";
      else if (!isMoving && (desiredClip === "walk")) desiredClip = "idle";
      // BUILD override: once arrived at the standoff spot for an active
      // build target, force the build clip — never while still walking.
      if ((isBuilding || (isExtinguishing && extinguishArrived)) && !isMoving) {
        desiredClip = "build";
      }
      // EVICT override (Phase 2b / idle ambient combat): walking toward an
      // enemy uses "walk" (already covered by isMoving above); once in melee
      // range, force the melee clip — takes priority over the build override
      // since isBuilding is never true while isEngaging is true. Applies to
      // idle agents too now (isEngaging is no longer isActive-gated).
      if (isEngaging) {
        // Ranged upgrade: shoot instead of melee once the rack is built. The
        // shoot/melee one-shots both re-loop during sustained in-range combat
        // via the reset-on-completion branch below.
        desiredClip = engageInRange ? (rangedUnlocked ? "shoot" : "melee") : "walk";
      }
      // CONGA override: line members walk (or briefly cheer) — takes priority
      // over build/idle since inConga preempted those blocks above.
      if (inConga) {
        desiredClip = congaCheerHold > 0 ? "cheer" : "walk";
      }
      // EMOTE override (rare, one-shot informative/playful pose): while
      // charEntry.emoting is true, show its static held clip (point/signal).
      // Checked BEFORE dance so a dance always wins over a pending emote —
      // playEmote also refuses to start an emote while already dancing, and
      // a dance-start elsewhere doesn't clear an in-progress emote, so this
      // ordering is what actually makes dance take priority moment to moment.
      if (charEntry.emoting) {
        desiredClip = charEntry.emoteClip;
      }
      // DANCE override (highest priority for an idle festivity): a dancing
      // agent's clip is "dance". Its frameIndex is driven by the manual mixer
      // above, so DO NOT reset the anim or call advanceAnim below for it.
      if (charEntry.dancing) {
        desiredClip = "dance";
      }
      // SIT override (idle festivity): a SEATED agent's clip is "sit"
      // (frame 15, hold). Only applies once actually seated — while walking to
      // the seat the normal walk clip is used. Takes priority over idle/walk;
      // sitting never coexists with dance/conga/engage/build (all preempt it).
      if (charEntry.sitting) {
        desiredClip = "sit";
      }
      // FINAL MOVEMENT GUARD: a physically-moving agent ALWAYS walks — no
      // combat (shoot/melee), celebration (cheer), or emote (point/signal/
      // block) pose may play mid-slide; those only begin once the agent is
      // stationary at its destination. Exemptions: "dance"/"sit" are genuine
      // in-place festivity states (position-locked), and conga members walk
      // their line with an intentional periodic cheer, so leave those clips.
      if (isMoving && !inConga && desiredClip !== "dance" && desiredClip !== "sit") {
        desiredClip = "walk";
      }

      const anim = charEntry.animState;
      if (charEntry.dancing) {
        // Manual frame mixer owns anim.action/frameIndex; skip normal advance.
        anim.action = "dance";
      } else if (anim.action !== desiredClip) {
        anim.action = desiredClip;
        anim.frameIndex = 0;
        anim.direction = 1;
        anim.elapsed = 0;
        anim.completed = false;
      } else if (
        (desiredClip === "melee" || desiredClip === "shoot") &&
        anim.completed &&
        isEngaging &&
        engageInRange
      ) {
        // Change 3: melee/shoot clips are loop:false one-shots in
        // ATLAS_CLIPS (kept that way for non-looping uses elsewhere), but
        // while an agent is actively engaging an in-range enemy the attack
        // must keep replaying instead of freezing on the last frame. Reset
        // here (loop-at-the-engage-site) rather than change ATLAS_CLIPS
        // globally. Stops automatically once out of range/enemy defeated,
        // because desiredClip then changes to "walk"/"idle" and the branch
        // above handles the reset instead.
        anim.frameIndex = 0;
        anim.direction = 1;
        anim.elapsed = 0;
        anim.completed = false;
      }
      // Change 1: mark that a builder is actively present at the build
      // target this frame (arrived, not moving, build clip in effect) so
      // updateBuildProgress() knows to advance progress next frame.
      if (isBuilding && !isMoving && desiredClip === "build") {
        buildProgressBuilderCount++;
        // Record this builder so it celebrates when the object completes.
        currentBuildContributors.push(charEntry.__id);
      }
      // Skip advanceAnim for a dancing agent — the manual frame mixer above
      // sets frameIndex directly (17/18/19), never the same frame twice.
      if (!charEntry.dancing) advanceAnim(anim, delta);
    });

    // Extinguish (Phase 2): accrue extinguish progress now that all character
    // positions are settled this frame; force-clears smoke on completion.
    updateExtinguishProgress(delta);

    // ── Agent separation pass (second pass, after all base nx/ny updates
    // above are settled for this frame) ────────────────────────────────
    // Non-seated agents push apart when closer than MIN_AGENT_SEP_NATIVE so
    // they never visually overlap while wandering/roaming. Seated agents
    // (sitSeatId != null) are excluded on both sides: they never move (stay
    // pinned to their seat) and never push a neighbor out of the way.
    {
      const sepList = [];
      for (const agent of sceneAgentList) {
        const ent = agentCharMap[agent.id];
        if (ent && ent.sitSeatId == null && ent.settled) sepList.push(ent);
      }
      for (let i = 0; i < sepList.length; i++) {
        for (let j = i + 1; j < sepList.length; j++) {
          const a = sepList[i];
          const b = sepList[j];
          const dx = b.nx - a.nx;
          const dy = b.ny - a.ny;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= MIN_AGENT_SEP_NATIVE) continue;
          // Coincident centers: nudge along an arbitrary axis to avoid a
          // divide-by-zero / NaN push direction.
          let ux, uy;
          if (dist < 0.0001) {
            ux = 1; uy = 0; dist = 0;
          } else {
            ux = dx / dist; uy = dy / dist;
          }
          const overlap = (MIN_AGENT_SEP_NATIVE - dist) * AGENT_SEP_STRENGTH;
          const push = overlap / 2;
          a.nx -= ux * push; a.ny -= uy * push;
          if (typeof a.destNx === "number") {
            a.destNx -= ux * push; a.destNy -= uy * push;
            const cda = clampToPolygon(a.destNx, a.destNy, walkablePolygon);
            a.destNx = cda[0]; a.destNy = cda[1];
          }
          b.nx += ux * push; b.ny += uy * push;
          if (typeof b.destNx === "number") {
            b.destNx += ux * push; b.destNy += uy * push;
            const cdb = clampToPolygon(b.destNx, b.destNy, walkablePolygon);
            b.destNx = cdb[0]; b.destNy = cdb[1];
          }
          const clampedA = clampToPolygon(a.nx, a.ny, walkablePolygon);
          a.nx = clampedA[0]; a.ny = clampedA[1];
          const clampedB = clampToPolygon(b.nx, b.ny, walkablePolygon);
          b.nx = clampedB[0]; b.ny = clampedB[1];
        }
      }
    }

    // ── Phase 2b (Change 2): prune enemies. Defeated enemies FLEE off-screen
    // instead of vanishing; they are removed only once they run beyond the
    // visible native bounds by a margin. (Non-fleeing enemies keep hp>0 while
    // engaged; enemiesAlive already excludes fleeing ones, so the floor reads
    // "clear" for build/engage purposes the instant an enemy starts fleeing.)
    if (activeEnemies.length > 0) {
      const OFFSCREEN_MARGIN = 80;
      activeEnemies = activeEnemies.filter((en) => {
        if (!en.fleeing) return true;
        const stillOnscreen = (
          en.nx > -OFFSCREEN_MARGIN &&
          en.nx < walkableNativeW + OFFSCREEN_MARGIN &&
          en.ny > -OFFSCREEN_MARGIN &&
          en.ny < walkableNativeH + OFFSCREEN_MARGIN
        );
        // A fleeing enemy that just crossed the offscreen margin is a
        // successful eviction — count it toward RIVALS_EVICTED badges.
        if (!stillOnscreen) {
          rivalsEvictedCount++;
          cycleRivalsEvicted++;
          persistRebirth();
        }
        return stillOnscreen;
      });
    }

    // ── Phase 2a: merge buildable objects into the same Y-sorted depth list
    // as agents, so agents and objects occlude each other correctly. Objects
    // with phase "unbuilt" are skipped (hidden / not yet placed on stage).
    // Phase 2b: alive enemies are merged into the same list so they occlude
    // agents/objects correctly too.
    /** @type {Array<{kind:'agent', agent:object, ny:number}|{kind:'object', obj:object, entry:object, ny:number}|{kind:'enemy', enemy:object, ny:number}>} */
    const depthList = [];
    for (const agent of sceneAgentList) {
      const entA = agentCharMap[agent.id];
      depthList.push({ kind: "agent", agent, ny: entA ? entA.ny : 0 });
    }
    for (const obj of themeBuildables) {
      const entry = objectAnimMap[obj.object_id];
      // In Edit Stage mode, include unbuilt objects too so every buildable is
      // visible (drawn as idle final art) for per-object scale/position
      // tuning. objectPlacement is populated for ALL objects (built or not)
      // at THEME_INITIALIZED, so unbuilt entries already have a valid spot —
      // no fallback to objectHomePlacement is needed here.
      if (!entry || (entry.phase === "unbuilt" && !(editStageMode && stageShowAllObjects))) continue;
      const placement = objectPlacement[obj.object_id];
      if (!placement) continue;
      depthList.push({ kind: "object", obj, entry, ny: placement.ny });
    }
    for (const enemy of activeEnemies) {
      depthList.push({ kind: "enemy", enemy, ny: enemy.ny });
    }
    // Background decor: advance any animated decor and merge into the same
    // Y-sorted depth list so agents/objects/enemies occlude it correctly.
    for (let di = 0; di < themeDecor.length; di++) {
      const decor = themeDecor[di];
      const decorId = decor.decor_id;
      if (decorId == null) continue;
      const showAll = editStageMode && stageShowAllObjects;
      // H-hidden decor (themeDecorHidden — non-destructive, keeps its live
      // placement) is skipped entirely in normal play / edit-without-show-all,
      // matching the anchor-hide sentinel's visibility rule. In show-all it's
      // still merged into the depth list (ghost = true) so it draws at reduced
      // opacity — the "bring it back" path (see drawDecor call below).
      const ghost = themeDecorHidden.has(decorId) && showAll;
      if (themeDecorHidden.has(decorId) && !showAll) continue;
      let placement = decorPlacement[decorId];
      if (!placement) {
        // Edit-Stage show-all: synthesize a display-only fallback placement so
        // hidden/unplaced decor is visible + selectable for placing/scaling.
        // Not persisted (moving it writes a real anchor override → un-hides).
        if (showAll) placement = decorFallbackPlacement(decor, di);
        else continue;
      }
      const dAnim = decorAnimMap[decorId];
      if (dAnim) {
        const dSlots = themeImages["decor_" + decorId];
        advanceDecorAnim(dAnim, delta, dSlots ? dSlots.length : 1);
      }
      depthList.push({ kind: "decor", decor, ny: placement.ny, placement, ghost });
    }
    depthList.sort((a, b) => a.ny - b.ny);

    depthList.forEach((item) => {
      if (item.kind === "decor") {
        const placement = item.placement || decorPlacement[item.decor.decor_id];
        if (!placement) return;
        const canvasPt = nativeToCanvas(placement.nx, placement.ny, bgX, bgY, bgW, bgH);
        const tDepth = Math.max(0, Math.min(1, (item.ny - polyMinY) / polyRangeY));
        const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale * sceneFitScale;
        if (item.ghost) {
          // H-hidden decor shown in Edit-Stage show-all: reduced opacity so it
          // reads as "hidden" while still being visible/clickable to unhide.
          const prevAlpha = ctx.globalAlpha;
          ctx.globalAlpha = prevAlpha * 0.35;
          drawDecor(item.decor, canvasPt[0], canvasPt[1], depthScale);
          ctx.globalAlpha = prevAlpha;
        } else {
          drawDecor(item.decor, canvasPt[0], canvasPt[1], depthScale);
        }
        return;
      }

      if (item.kind === "object") {
        const canvasPt = nativeToCanvas(objectPlacement[item.obj.object_id].nx, objectPlacement[item.obj.object_id].ny, bgX, bgY, bgW, bgH);
        const tDepth = Math.max(0, Math.min(1, (item.ny - polyMinY) / polyRangeY));
        const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale * sceneFitScale;
        // Hover tooltip hit-box (Feature: hover tooltips) — built vs not
        // mirrors buildState.builtIds exactly (not entry.phase, which still
        // reads "active"/"poof" for a brief transitional window after the
        // object is already counted as built). Box size mirrors
        // drawBuildableObject's own baseSize (built art) / crateSize
        // (crate/in-progress) formulas so the hit box matches what's drawn.
        const hoverObjId = item.obj.object_id;
        const hoverObjBuilt = buildState.builtIds.has(hoverObjId);
        const hoverObjSize = Math.round(64 * depthScale * (hoverObjBuilt ? effectiveObjScale(hoverObjId) : themeObjectScale));
        hoverTargets.push({
          x0: canvasPt[0] - hoverObjSize / 2, y0: canvasPt[1] - hoverObjSize,
          x1: canvasPt[0] + hoverObjSize / 2, y1: canvasPt[1],
          yFront: canvasPt[1],
          kind: "object",
          name: hoverObjBuilt ? (item.obj.display_name || hoverObjId) : "Incomplete Object",
        });
        drawBuildableObject(item.obj, item.entry, canvasPt[0], canvasPt[1], depthScale);
        return;
      }

      if (item.kind === "enemy") {
        const en = item.enemy;
        const canvasPt = nativeToCanvas(en.nx, en.ny, bgX, bgY, bgW, bgH);
        const ecx = canvasPt[0], ecy = canvasPt[1];
        const tDepth = Math.max(0, Math.min(1, (en.ny - polyMinY) / polyRangeY));
        const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale * sceneFitScale;
        const rivalKey = typeof en.rival_id === "string" && en.rival_id.startsWith("rival_")
          ? en.rival_id
          : ("rival_" + en.rival_id);
        const slots = themeImages[rivalKey];
        // Enemies index rival frames via RIVAL_CLIPS (0-4). Graceful fallback
        // for OLD themes whose rival frames are the legacy 20-cell atlas:
        // indexing 0-4 still works. Never crash on a rival with < 5 frames —
        // clamp the frame index to the available length.
        let slot = currentRivalSlot(en.animState);
        if (slots && slots.length > 0 && slot >= slots.length) {
          slot = slots.length - 1;
        }
        const img = slots && slots[slot];
        const spriteSize = Math.round(64 * depthScale * themeCharacterScale * effectiveRivalScale(en.rival_id));
        if (!img || !img.complete || img.naturalWidth === 0) {
          // Rival art missing or still decoding — draw NOTHING (no placeholder
          // tile, no marker, no floating HP bar); the enemy pops in on its
          // first ready frame. Still-decoding frames keep the boot loader
          // opaque; permanently missing art renders nothing (theme health
          // check flags it) and must not hold the loader.
          if (img && !img.complete) bootFrameSpritePending = true;
          return;
        }
        const drawX = ecx - spriteSize / 2;
        const drawY = ecy - spriteSize;
        // Hover tooltip hit-box (Feature: hover tooltips) — given name from
        // manifest.roster_rivals (themeRivals), matched by en.rival_id;
        // falls back to the raw id if the roster entry can't be found.
        const hoverRivalInfo = themeRivals.find((r) => r && r.rival_id === en.rival_id);
        hoverTargets.push({
          x0: drawX, y0: drawY, x1: drawX + spriteSize, y1: drawY + spriteSize,
          yFront: ecy,
          kind: "rival",
          name: (hoverRivalInfo && hoverRivalInfo.name) || en.rival_id,
        });
        const clip = RIVAL_CLIPS[en.animState.action] || RIVAL_CLIPS.walk;
        // Enemies ALWAYS mirror to face their target/movement direction — not
        // gated on clip.flippable (mirrors the agent override so a non-flippable
        // idle/hold clip still faces the right way). facingLeft true = mirror.
        const shouldFlip = en.facingLeft === true;
        ctx.save();
        if (shouldFlip) {
          ctx.translate(ecx + spriteSize / 2, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, drawY, spriteSize, spriteSize);
        } else {
          ctx.drawImage(img, drawX, drawY, spriteSize, spriteSize);
        }
        ctx.restore();
        // HP bar above the enemy. Skipped once the rival is defeated
        // (fleeing) — an empty bar would overlap the injured bubble below.
        if (!en.fleeing) {
          const hpFrac = Math.max(0, Math.min(1, en.hp / en.maxHp));
          const barW = Math.max(12, spriteSize * 0.4);
          const barH = 4;
          const barX = ecx - barW / 2;
          const barY = ecy - spriteSize - 10;
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(barX, barY, barW, barH);
          ctx.fillStyle = hpFrac > 0.4 ? "#ff4040" : "#ff9a3c";
          ctx.fillRect(barX, barY, barW * hpFrac, barH);
          ctx.strokeStyle = "rgba(255,255,255,0.4)";
          ctx.lineWidth = 1;
          ctx.strokeRect(barX, barY, barW, barH);
        }
        // Expression bubble above the rival (e.g. dazed/hit on eviction),
        // via the same shared helper agents use. Fully guarded: rivals lacking
        // bubble fields (undefined) fail the >=0 / >0 checks inside and draw
        // nothing, so spawnEnemyWave rivals are unaffected.
        drawExpressionBubble(en.bubbleExpr, en.bubbleTimeLeft, ecx, ecy, spriteSize);
        return;
      }

      const agent = item.agent;
      const idx = sceneAgentList.indexOf(agent);
      const charEntry = agentCharMap[agent.id];
      if (!charEntry) return;

      const worker = state.workers[agent.id] || null;
      const desiredClip = charEntry.animState ? charEntry.animState.action : "idle";
      const anim = charEntry.animState;

      const cx = charEntry.x;
      const cy = charEntry.y;

      // Depth scale: agents further back (small native Y) draw slightly smaller.
      const tDepth = Math.max(0, Math.min(1, (charEntry.ny - polyMinY) / polyRangeY));
      const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale * sceneFitScale; // 0.8 (back) → 1.1 (front), ×overall×fit

      if (bgImgReady && charIds.length > 0) {
        // Pick character sprite by agent index in roster order.
        const charId = charIds[idx % charIds.length];
        const slots = themeImages[charId];

        const slot = currentSlot(anim);
        const img = slots && slots[slot];

        if (img && img.complete && img.naturalWidth > 0) {
          const spriteSize = Math.round(64 * depthScale * effectiveCharScale(charId));
          // Foot-anchor: bottom of sprite sits at canvas floor point
          const isSeatedForDraw = charEntry.sitting === true && charEntry.sitSeatId != null;
          const seatedFlipForDraw = isSeatedForDraw
            ? !!(themeDecorFlipOverrides && themeDecorFlipOverrides[charEntry.sitSeatId])
            : false;
          // Seat-alignment nudge (screen-right when unflipped, mirrored
          // screen-left when the seat is flipped) — see SEAT_SEATED_NUDGE_PX.
          const seatNudge = isSeatedForDraw
            ? (seatedFlipForDraw ? -SEAT_SEATED_NUDGE_PX : SEAT_SEATED_NUDGE_PX)
            : 0;
          // Seat lift: put the character's seat-contact point at the chair's
          // painted seat surface. Computed from the CHAIR'S OWN geometry (its
          // ny → chairDepth, its effectiveDecorScale) so it tracks the chair's
          // rendered seat surface exactly, matching drawDecor's foot-anchored
          // draw at 64 * chairDepth * chairScale. Scale-invariant in both chair
          // and character scale (see SEAT_SURFACE_FRAC / SEAT_CONTACT_FRAC
          // above). Guarded: a missing chair placement falls back to the
          // character's own depthScale so nothing throws.
          let seatRaise = 0;
          if (isSeatedForDraw && charEntry.seatDecorId != null) {
            const chair = decorPlacement[charEntry.seatDecorId];
            const chairScale = effectiveDecorScale(charEntry.seatDecorId);
            if (typeof chairScale === "number") {
              const chairDepth = chair
                ? (0.8 + Math.max(0, Math.min(1, (chair.ny - polyMinY) / polyRangeY)) * 0.3) * themeOverallScale * sceneFitScale
                : depthScale;
              const chairSpriteSize = 64 * chairDepth * chairScale;
              seatRaise = Math.max(0, SEAT_SURFACE_FRAC * chairSpriteSize - SEAT_CONTACT_FRAC * spriteSize);
            }
          }
          const drawX = cx - spriteSize / 2 + seatNudge;
          const drawY = cy - spriteSize - seatRaise; // feet at cy, raised for chair scale

          // Hover tooltip hit-box (Feature: hover tooltips) — flip-invariant:
          // the mirrored draw path below (translate+scale(-1,1)) paints inside
          // this exact same screen box, so the box doesn't need to branch on
          // shouldFlip. Bold line = the THEMED character's given name (looked
          // up from themeRosterAgents by slot, matching the "agent_" + slot_id
          // key convention charId already uses, see ~line 7767); falls back to
          // the technical agent name/id when the theme has no roster names.
          // Regular line = a concise role LABEL (agentRoleLabel below) — NOT
          // the verbose describeRole() blurb used elsewhere, which reads like
          // a sentence fragment and is too long for this tooltip.
          const rosterAgentInfo = Array.isArray(themeRosterAgents)
            ? themeRosterAgents.find((a) => a && ("agent_" + a.slot_id) === charId)
            : null;
          hoverTargets.push({
            x0: drawX, y0: drawY, x1: drawX + spriteSize, y1: drawY + spriteSize,
            yFront: cy,
            kind: "character",
            name: (rosterAgentInfo && rosterAgentInfo.name) || agent.name || agent.id,
            role: agentRoleLabel(agent),
          });

          const clip = ATLAS_CLIPS[anim.action] || ATLAS_CLIPS.idle;
          // Change 3: dancing agents flip regardless of the dance clip's
          // flippable:false flag (kept false for the ATLAS_CLIPS test) — the
          // manual dance mixer toggles facingLeft each frame swap, and this
          // draw-time special case honors it so the dancer turns side to side.
          // Non-dancing flip behavior is unchanged (still gated on clip.flippable).
          // A seated agent mirrors to match its SEAT's Stage-Editor flip state
          // (not movement-derived facingLeft) so a flipped seat's occupant
          // flips with it. Only applies once actually seated (sit clip) —
          // walking to the seat still uses normal walk-facing.
          const isSeated = charEntry.sitting === true && charEntry.sitSeatId != null;
          const shouldFlip = isSeated
            ? !!(themeDecorFlipOverrides && themeDecorFlipOverrides[charEntry.sitSeatId])
            : (clip.flippable || charEntry.dancing === true) && charEntry.facingLeft === true;

          // Draw the sprite inside its own save/restore so the horizontal-flip
          // transform NEVER leaks into the label below (a flipped+scaled context
          // would mirror-map the label to ~spriteSize/2 and fling it offscreen).
          ctx.save();
          if (shouldFlip) {
            // Mirrored draw path: the sprite is drawn at local x=0 and
            // reflected by scale(-1,1), so it never reads drawX. Baking
            // seatNudge into the translate's x-origin shifts the resulting
            // on-screen bounding box by the same +seatNudge as the
            // non-flipped path below (translate right → screen shifts right).
            ctx.translate(cx + spriteSize / 2 + seatNudge, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, drawY, spriteSize, spriteSize);
          } else {
            ctx.drawImage(img, drawX, drawY, spriteSize, spriteSize);
          }
          ctx.restore();

          // Rare "expression" icon bubble above the head (display-only —
          // see showExpression / drawExpressionBubble). Drawn in un-flipped
          // canvas coords, same cx/cy/spriteSize as the sprite just drawn
          // above. No-op when the theme has no expression atlas. While this
          // lead's persistent "team active" bubble is showing (teamActive),
          // it takes priority over the normal expression bubble — see
          // drawTeamBubble and showExpression's non-interruption guard.
          if (charEntry.teamActive) {
            drawTeamBubble(charEntry, cx, cy, spriteSize);
          } else {
            drawExpressionBubble(charEntry.bubbleExpr, charEntry.bubbleTimeLeft, cx, cy, spriteSize);
          }

          // Label below feet — drawn in un-flipped canvas coords so it stays
          // centered directly under the agent regardless of facing direction.
          const labelFont = Math.round(9 * depthScale);
          ctx.fillStyle = "#e0e0e0";
          ctx.font = `${labelFont}px monospace`;
          ctx.textAlign = "center";
          const label = (agent.name || agent.id).slice(0, 24);
          // Word-wrap: greedily pack whitespace-separated words into lines that
          // fit maxLabelW so long names ("VS Code Integration", "Search &
          // Retrieval") stack onto 2-3 centered lines instead of clipping.
          const maxLabelW = Math.max(72, spriteSize * 1.6);
          // Perf (change 2): the wrap + widest-line-width measurement below is
          // identical every frame for a given (label, wrap width, font size) —
          // cache it on the charEntry and only recompute when any of those
          // three actually change. ctx.font is already set (above) to the same
          // labelFont used at cache-store time, so measureText results match.
          let labelLines, widestLineW;
          const labelWrapKey = label + "|" + Math.round(maxLabelW) + "|" + labelFont;
          const cachedWrap = charEntry._labelWrapCache;
          if (cachedWrap && cachedWrap.key === labelWrapKey) {
            labelLines = cachedWrap.lines;
            widestLineW = cachedWrap.widestLineW;
          } else {
            const labelWords = label.split(/\s+/).filter(function (wd) { return wd.length > 0; });
            labelLines = [];
            if (labelWords.length === 0) {
              labelLines.push(label);
            } else {
              let curLine = labelWords[0];
              for (let li = 1; li < labelWords.length; li++) {
                const candidate = curLine + " " + labelWords[li];
                if (ctx.measureText(candidate).width <= maxLabelW) {
                  curLine = candidate;
                } else {
                  labelLines.push(curLine);
                  curLine = labelWords[li];
                }
              }
              labelLines.push(curLine);
            }
            // Widest line drives the active-light offset.
            widestLineW = 0;
            for (let li = 0; li < labelLines.length; li++) {
              const lw = ctx.measureText(labelLines[li]).width;
              if (lw > widestLineW) widestLineW = lw;
            }
            charEntry._labelWrapCache = { key: labelWrapKey, lines: labelLines, widestLineW: widestLineW };
          }
          const labelLineH = labelFont + 1;
          const labelY = cy + Math.round(14 * depthScale);
          for (let li = 0; li < labelLines.length; li++) {
            ctx.fillText(labelLines[li], cx, labelY + li * labelLineH);
          }

          // Active indicator: a small glowing green light immediately to the
          // LEFT of the (widest) name line so it still reads as "left of the
          // name" (reads as "this agent, working") instead of floating by the
          // head. Vertically centered on the first line.
          if (charEntry.isActive) {
            const lightR = Math.max(2, 2.6 * depthScale);
            const lightX = cx - widestLineW / 2 - lightR - 3;
            const lightY = labelY - labelFont * 0.32; // vertical-center on first line
            // Perf (change 3): pre-rendered glow (see getActiveGlowCanvas) in
            // place of a live shadowBlur rasterize every frame. The offscreen
            // canvas is drawn centered on (lightX, lightY) via its `pad`
            // offset, reproducing the exact same centered, alpha-correct dot.
            const glow = getActiveGlowCanvas(lightR);
            ctx.drawImage(glow.canvas, lightX - glow.pad, lightY - glow.pad);
          }
        } else if (img && !img.complete) {
          // Sprite frame still decoding — draw NOTHING (no stick figure, no
          // floating label); the agent pops in on its first ready frame. The
          // flag keeps the boot loader opaque over the withheld frame.
          bootFrameSpritePending = true;
        }
        // Missing/errored art: render nothing (theme health check flags it).
      }
      // No themed art available (no theme / background not ready): render
      // nothing. The old placeholder stick figures were exactly the "bare
      // chips" screen that flashed before the loaded scene.
    });

    // ── Change C: draw ranged-fire projectiles ─────────────────────────
    // Drawn on top of the depth-sorted scene so shots read clearly. The
    // 4-frame projectile FX: frame0 = muzzle at origin, frame1 = in-flight,
    // frame2 = hit, frame3 = blast. Frame + position are chosen from t.
    // No-op when the theme lacks the asset (activeProjectiles stays empty).
    if (bgImgReady && themeHasProjectile && activeProjectiles.length > 0) {
      const projFrames = themeImages["projectile"];
      for (const p of activeProjectiles) {
        const t = p.t;
        // Frame + world position by phase.
        let frameIdx, posNx, posNy;
        if (t < 0.2) {
          frameIdx = 0;             // muzzle at the shooter
          posNx = p.fromNx; posNy = p.fromNy;
        } else if (t < 0.8) {
          frameIdx = 1;             // in-flight, lerp shooter→target
          const lt = Math.max(0, Math.min(1, (t - 0.2) / 0.6));
          posNx = p.fromNx + (p.toNx - p.fromNx) * lt;
          posNy = p.fromNy + (p.toNy - p.fromNy) * lt;
        } else if (t < 0.9) {
          frameIdx = 2;             // hit at the target
          posNx = p.toNx; posNy = p.toNy;
        } else {
          frameIdx = 3;             // blast at the target
          posNx = p.toNx; posNy = p.toNy;
        }
        const img = projFrames[Math.min(frameIdx, projFrames.length - 1)];
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        const canvasPt = nativeToCanvas(posNx, posNy, bgX, bgY, bgW, bgH);
        // Size honors overall scale for consistency with the rest of the scene,
        // plus a light depth cue from the projectile's native Y.
        const tDepth = Math.max(0, Math.min(1, (posNy - polyMinY) / polyRangeY));
        const projScale = (0.8 + tDepth * 0.3) * themeOverallScale * sceneFitScale;
        const size = Math.round(40 * projScale);
        // Rotate the sprite to point along its travel direction. Computed in
        // CANVAS space (not native space) so non-uniform x/y scaling from
        // nativeToCanvas is accounted for — using the SAME nativeToCanvas
        // call/args as canvasPt above.
        const cFrom = nativeToCanvas(p.fromNx, p.fromNy, bgX, bgY, bgW, bgH);
        const cTo = nativeToCanvas(p.toNx, p.toNy, bgX, bgY, bgW, bgH);
        const angle = Math.atan2(cTo[1] - cFrom[1], cTo[0] - cFrom[0]) + PROJECTILE_ART_ANGLE_OFFSET;
        ctx.save();
        ctx.translate(canvasPt[0], canvasPt[1]);
        ctx.rotate(angle);
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }

    // (Nav-polygon debug overlay removed — the Stage Editor now shows/edits
    //  the walkable polygon, so the standalone N-key view is no longer needed.)

    // ── Stage editor overlay (draggable polygon handles) ───────────────
    if (editStageMode && themeLoaded && showBoundaryPolygon && walkablePolygon && walkablePolygon.length > 2) {
      ctx.save();
      // Filled + stroked outline (amber to distinguish from the green nav view)
      ctx.beginPath();
      const [e0x, e0y] = nativeToCanvas(walkablePolygon[0][0], walkablePolygon[0][1], bgX, bgY, bgW, bgH);
      ctx.moveTo(e0x, e0y);
      for (let i = 1; i < walkablePolygon.length; i++) {
        const [px, py] = nativeToCanvas(walkablePolygon[i][0], walkablePolygon[i][1], bgX, bgY, bgW, bgH);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(255,193,7,0.10)";
      ctx.fill();
      ctx.strokeStyle = "#ffc107";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Edge midpoint "+" hints (double-click an edge to insert a vertex)
      ctx.fillStyle = "rgba(255,193,7,0.55)";
      for (let i = 0; i < walkablePolygon.length; i++) {
        const a = walkablePolygon[i];
        const b = walkablePolygon[(i + 1) % walkablePolygon.length];
        const [mx, my] = nativeToCanvas((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, bgX, bgY, bgW, bgH);
        ctx.beginPath();
        ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Draggable vertex handles
      for (let i = 0; i < walkablePolygon.length; i++) {
        const [vx, vy] = nativeToCanvas(walkablePolygon[i][0], walkablePolygon[i][1], bgX, bgY, bgW, bgH);
        const active = (i === dragVertexIndex) || (i === hoverVertexIndex);
        ctx.beginPath();
        ctx.arc(vx, vy, active ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = active ? "#fff3cd" : "#ffc107";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#7a5b00";
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Stage loading bar (replaces placeholders while the theme loads) ──
    if (loadingActive) {
      ctx.save();
      const barW = Math.min(280, w * 0.6);
      const barH = 8;
      const bx = Math.round((w - barW) / 2);
      const by = Math.round(h * 0.47);
      // Title + subtitle
      ctx.textAlign = "center";
      ctx.fillStyle = "#eef0f6";
      ctx.font = "600 14px system-ui, -apple-system, sans-serif";
      ctx.fillText("TycoonAgents", w / 2, by - 26);
      ctx.fillStyle = "rgba(186,196,214,0.85)";
      ctx.font = "11px system-ui, -apple-system, sans-serif";
      ctx.fillText(themeLoaded ? "Loading characters…" : "Loading…", w / 2, by - 10);
      // Track
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(bx, by, barW, barH);
      // Fill
      if (themeLoaded) {
        const frac = Math.max(0, Math.min(1, _load.frac));
        ctx.fillStyle = "#39ff14";
        ctx.fillRect(bx, by, Math.max(barH, barW * frac), barH);
        ctx.fillStyle = "rgba(186,196,214,0.85)";
        ctx.font = "10px system-ui, -apple-system, sans-serif";
        ctx.fillText(Math.round(frac * 100) + "%", w / 2, by + barH + 15);
      } else {
        // Indeterminate ping-pong segment while waiting for the theme payload.
        const segW = barW * 0.34;
        const t = 0.5 - 0.5 * Math.cos((nowMs() / 700) % (Math.PI * 2));
        const segX = bx + (barW - segW) * t;
        ctx.fillStyle = "#39ff14";
        ctx.fillRect(segX, by, segW, barH);
      }
      ctx.restore();
    }

    // Badges: cheap per-frame check (small array) so unlocks + the HUD count
    // reflect this frame's build/eviction counters immediately.
    updateBadgeUnlocks();

    // ── Boot loader completion gate (end of frame — judges ACTUAL paint) ────
    // Strict all-clear for a themed boot: loading window over, EVERY queued
    // theme image settled (decoded or errored — see themeImagesAllSettled),
    // the decoded background drawn this frame, no agent stuck on a
    // still-decoding placeholder fallback, and the themed run has held for
    // BOOT_THEMED_FRAMES_MIN consecutive frames AND BOOT_THEMED_HOLD_MS
    // (whichever is later). Non-themed paths (THEME_NONE fresh install, or
    // the loading window timing out) have no themed scene to wait for and
    // complete immediately. The 12s hard timeout still force-hides anything.
    if (!bootLoaderDone && !loadingActive) {
      // Until the host has answered with THEME_INITIALIZED or THEME_NONE, a
      // theme may still be coming (slow theme discovery can outlast the 6s
      // stage-loading window) — hold opaque rather than complete into the
      // pre-theme scene. The 12s hard timeout still covers a dead host.
      const themeOutcomeKnown = themeLoaded || noThemeSignaled;
      const themedSceneExpected = themeLoaded && !noThemeSignaled && _load.ready;
      if (!themeOutcomeKnown) {
        // hold — no verdict yet
      } else if (!themedSceneExpected) {
        bootLoaderComplete();
      } else if (bootFrameThemeBgDrawn && !bootFrameSpritePending && themeImagesAllSettled()) {
        bootThemedFrames++;
        if (bootFirstThemedFrameTs === 0) bootFirstThemedFrameTs = nowMs();
        if (
          bootThemedFrames >= BOOT_THEMED_FRAMES_MIN &&
          nowMs() - bootFirstThemedFrameTs >= BOOT_THEMED_HOLD_MS
        ) {
          bootLoaderComplete();
        }
      } else {
        // Regression (placeholder resurfaced / bg not drawn) — restart the run.
        bootThemedFrames = 0;
        bootFirstThemedFrameTs = 0;
      }
    }

    // HUD overlay
    drawHUD(w);

    // Rebirth celebration confetti — drawn last so it sits on top of everything.
    updateAndDrawConfetti(ctx, h);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
