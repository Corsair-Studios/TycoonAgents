/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Canvas renderer and panel controller for TycoonAgents webview.
// Receives WorldState from the VS Code extension host via postMessage.

(function () {
  const vscode = acquireVsCodeApi();

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
    }

    function onUp(ev) {
      const px = window.innerHeight - ev.clientY;
      const clamped = applyMetricsHeight(px);
      saveMetricsHeight(clamped);
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
      if (badgeDetailModalEl && !badgeDetailModalEl.hasAttribute("hidden")) {
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

  if (badgeHudBtn) {
    badgeHudBtn.addEventListener("click", () => {
      renderBadgePanel();
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
   * Persist rebirth state into the SAME vscode getState()/setState() blob used
   * for metricsHeight/rosterOrder/etc — merges in, never drops existing keys.
   * cyclePeakActive is intentionally NOT persisted (brief C1: high-water mark
   * for the CURRENT session only).
   */
  function persistRebirth() {
    const prev = vscode.getState() || {};
    vscode.setState({
      ...prev,
      rebirth: {
        count: rebirthCount,
        baseline: rebirthBaseline,
        required: requiredRebirthBadgeIds,
        unlocked: [...unlockedBadgeIds],
        cycleBuilt: cycleObjectsBuilt,
        cycleEvicted: cycleRivalsEvicted,
      },
    });
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
    rebirthBaseline = { built: buildBuiltCount, evicted: rivalsEvictedCount, tasks: (state.completedTasks || 0) };
    cycleObjectsBuilt = 0;
    cycleRivalsEvicted = 0;
    cyclePeakActive = 0;
    unlockedBadgeIds = new Set([...unlockedBadgeIds].filter((id) => id.indexOf("rebirth_") === 0));
    rollRebirthRequirement();
    rebirthConfirmPending = false;
    persistRebirth();
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
    if (rangedUnlocked === false && rebirthCount >= 1) rangedUnlocked = true; // D1: permanent ranged weapons from here on
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
      if (sub) sub.textContent = "Ranged weapons unlocked · Build speed +" + buildPct + "%";
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
  const themePlanObjects    = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-objects"));
  const themePlanExpressions = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-expressions"));
  const themePlanAchievements = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-achievements"));
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
    } else {
      showMain();
    }
  }

  installHooksBtn.addEventListener("click", () => {
    const teamLeadsRadio = /** @type {HTMLInputElement|null} */ (
      document.getElementById("delegation-mode-team-leads")
    );
    const delegation_mode = teamLeadsRadio && teamLeadsRadio.checked ? "team_leads" : "flat";
    vscode.postMessage({ type: "installHooks", delegation_mode });
  });

  menuSettingsBtn.addEventListener("click", () => {
    closeMenu();
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

  function renderPlanSlots(container, values, groupName) {
    if (!container) return;
    container.innerHTML = "";
    values.forEach((value, index) => {
      const label = document.createElement("label");
      label.className = "theme-plan-slot";
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.dataset.planGroup = groupName;
      input.dataset.planIndex = String(index);
      label.appendChild(number);
      label.appendChild(input);
      container.appendChild(label);
    });
  }

  function renderThemePlan(plan) {
    currentThemePlan = plan;
    if (themePlanName) themePlanName.value = plan.display_name || "";
    if (themePlanDirection) themePlanDirection.value = plan.creative_direction || "";
    if (themePlanEnvironment) themePlanEnvironment.value = plan.environment || "";
    if (themePlanObjects) themePlanObjects.value = (plan.objects || []).join(", ");
    if (themePlanExpressions) themePlanExpressions.value = (plan.expressions || []).join(", ");
    if (themePlanAchievements) themePlanAchievements.value = (plan.achievements || []).join(", ");
    renderPlanSlots(themePlanCharacters, plan.characters || [], "characters");
    renderPlanSlots(themePlanEnemies, plan.enemies || [], "enemies");
    if (themePlanValidation) themePlanValidation.textContent = "";
    if (themePlanEditor) themePlanEditor.removeAttribute("hidden");
    if (themeImageReview) themeImageReview.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
  }

  function collectPlanSlots(container) {
    return container
      ? Array.from(container.querySelectorAll("input")).map((input) => input.value.trim()).filter(Boolean)
      : [];
  }

  function collectCommaList(input, expected, label) {
    const values = input ? input.value.split(",").map((value) => value.trim()).filter(Boolean) : [];
    if (values.length !== expected) throw new Error(`${label} needs exactly ${expected} comma-separated entries (currently ${values.length}).`);
    return values;
  }

  function collectEditedThemePlan() {
    const characters = collectPlanSlots(themePlanCharacters);
    const enemies = collectPlanSlots(themePlanEnemies);
    if (characters.length !== 16) throw new Error(`Characters needs all 16 filled slots (currently ${characters.length}).`);
    if (enemies.length !== 4) throw new Error(`Enemies needs all 4 filled slots (currently ${enemies.length}).`);
    const displayName = themePlanName ? themePlanName.value.trim() : "";
    const creativeDirection = themePlanDirection ? themePlanDirection.value.trim() : "";
    const environment = themePlanEnvironment ? themePlanEnvironment.value.trim() : "";
    if (!displayName || !creativeDirection || !environment) throw new Error("Theme name, creative direction, and environment are required.");
    return {
      ...currentThemePlan,
      theme_id: "",
      display_name: displayName,
      creative_direction: creativeDirection,
      characters,
      environment,
      enemies,
      objects: collectCommaList(themePlanObjects, 13, "Objects"),
      expressions: collectCommaList(themePlanExpressions, 16, "Expressions"),
      achievements: collectCommaList(themePlanAchievements, 20, "Achievement badges"),
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
        drafts.set(itemId, {
          feedback: card.querySelector(".theme-review-feedback")?.value || "",
          mode: card.querySelector(".theme-review-mode")?.value || "",
          characterName: card.querySelector(".theme-review-name-input")?.value || "",
          promptOpen: Boolean(card.querySelector(".theme-review-prompt")?.open),
          names,
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
   * @returns {Array<{rowId: string, itemKind: "object"|"decor"|"rival", label: string, original: string}>}
   */
  function themeReviewNameRows(item) {
    if (item.kind === "object_atlas" && Array.isArray(item.object_rows)) {
      // Labels use the GLOBAL object number ("Object 6".."Object 10"), matching
      // this board's own title ("Animated objects 6-10") and the manifest's
      // buildable_objects order — not the humanized object_id, since the id is
      // immutable and a humanized-id label would read as "the old name"
      // forever once the display name has been changed via this editor.
      // The global offset is derived from the item id's `objects_NN` suffix
      // (board 1 = objects 1-5, board 2 = objects 6-10, ...), mirroring the
      // OBJECT_ROWS_PER_BOARD=5 chunking in themeAssetPrompts.ts/createObjectBoardRows
      // and the same `objects_(\d+)` parse the host uses in reconstructObjectRows
      // (themeService.ts) — the id format is already the shared source of truth,
      // so no extra field needs to travel through the review-item payload.
      const OBJECT_ROWS_PER_BOARD = 5;
      const boardMatch = /objects_(\d+)/.exec(item.id || "");
      const boardNumber = boardMatch ? Number(boardMatch[1]) || 1 : 1;
      const globalOffset = (boardNumber - 1) * OBJECT_ROWS_PER_BOARD;
      let objectIndex = 0;
      return item.object_rows
        .filter((row) => row && row.kind === "object" && row.object_id)
        .map((row) => {
          objectIndex += 1;
          return {
            rowId: row.object_id,
            itemKind: "object",
            label: "Object " + (globalOffset + objectIndex),
            original: row.display_name || "",
          };
        });
    }
    if (item.kind === "background_decor_atlas" && Array.isArray(item.decor_rows)) {
      const rows = [];
      let seatIndex = 0;
      let decorIndex = 0;
      for (const row of item.decor_rows) {
        if (!row || !row.decor_id) continue;
        if (row.kind === "seat") {
          seatIndex += 1;
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Seat " + seatIndex, original: row.display_name || "" });
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
    return [];
  }

  /**
   * Builds the per-board "Names" editor: one label+input pair per row (see
   * themeReviewNameRows) plus a batched "Apply names" button that posts ONE
   * SET_THEME_ITEM_NAMES message for every edited, valid row on this board.
   * Returns null when the item's kind carries no nameable rows.
   * @param {any} item
   * @param {{names?: Record<string,string>}|undefined} savedDraft
   * @param {boolean} busy true while a previous Apply for this board is in flight
   * @param {boolean} disabledForGeneration true while an unrelated active generation run blocks edits
   */
  function buildThemeReviewNamesSection(item, savedDraft, busy, disabledForGeneration) {
    const rows = themeReviewNameRows(item);
    if (!rows.length) return null;
    const section = document.createElement("div");
    section.className = "theme-review-names";
    const title = document.createElement("div");
    title.className = "theme-review-names-title";
    title.textContent = "Names";
    const grid = document.createElement("div");
    grid.className = "theme-review-names-grid";
    const inputsDisabled = busy || disabledForGeneration;
    const inputs = [];
    for (const row of rows) {
      const rowEl = document.createElement("label");
      rowEl.className = "theme-review-names-row";
      const labelEl = document.createElement("span");
      labelEl.textContent = row.label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "theme-review-name-input theme-review-names-input";
      input.maxLength = 60;
      input.dataset.rowId = row.rowId;
      input.dataset.itemKind = row.itemKind;
      input.dataset.original = row.original;
      const draftValue = savedDraft?.names && Object.prototype.hasOwnProperty.call(savedDraft.names, row.rowId)
        ? savedDraft.names[row.rowId]
        : row.original;
      input.value = draftValue;
      input.disabled = inputsDisabled;
      rowEl.appendChild(labelEl);
      rowEl.appendChild(input);
      grid.appendChild(rowEl);
      inputs.push(input);
    }
    const applyBtn = document.createElement("button");
    applyBtn.className = "skill-btn theme-review-names-apply";
    applyBtn.type = "button";
    applyBtn.textContent = busy ? "Saving..." : "Apply names";
    const statusEl = document.createElement("div");
    statusEl.className = "theme-review-names-status";
    const dirtyChanges = () => inputs
      .map((input) => ({ input, trimmed: input.value.trim().replace(/\s+/g, " ") }))
      .filter(({ input, trimmed }) => trimmed && trimmed.length <= 60 && trimmed !== input.dataset.original);
    const updateApplyState = () => {
      applyBtn.disabled = inputsDisabled || dirtyChanges().length === 0;
    };
    for (const input of inputs) input.addEventListener("input", updateApplyState);
    updateApplyState();
    applyBtn.addEventListener("click", () => {
      const changes = [];
      for (const input of inputs) {
        const trimmed = input.value.trim().replace(/\s+/g, " ");
        if (!trimmed || trimmed.length > 60 || trimmed === input.dataset.original) {
          // Empty/whitespace/too-long edits are rejected client-side — revert
          // to the last known-good value instead of blocking the rest.
          input.value = input.dataset.original;
          continue;
        }
        changes.push({ item_kind: input.dataset.itemKind, id: input.dataset.rowId, name: trimmed });
      }
      if (!changes.length) {
        updateApplyState();
        return;
      }
      for (const input of inputs) input.disabled = true;
      applyBtn.disabled = true;
      applyBtn.textContent = "Saving...";
      statusEl.textContent = "";
      statusEl.classList.remove("theme-review-error");
      themeReviewBusyItems.set(item.id, "names");
      vscode.postMessage({
        type: "SET_THEME_ITEM_NAMES",
        payload: { theme_id: reviewThemeId, board_id: item.id, changes },
      });
    });
    section.appendChild(title);
    section.appendChild(grid);
    section.appendChild(applyBtn);
    section.appendChild(statusEl);
    return section;
  }

  /** Handles a THEME_ITEM_NAMES_RESULT reply. The host posts a fresh
   * THEME_IMAGE_REVIEW (full card rebuild, reflecting the resynced prompt/rows —
   * see resyncRenamedReviewItems in themeService.ts) immediately before this
   * message, so this only needs to patch the busy/status affordances — labels
   * are positional (see themeReviewNameRows) and never go stale, and the
   * rebuilt card's inputs already carry the saved names. */
  function applyThemeItemNamesResult(payload) {
    const boardId = payload.board_id || "";
    themeReviewBusyItems.delete(boardId);
    if (!themeImageReviewList) return;
    const cards = themeImageReviewList.querySelectorAll("[data-item-id]");
    for (const card of cards) {
      if (card.getAttribute("data-item-id") !== boardId) continue;
      const applyBtn = card.querySelector(".theme-review-names-apply");
      const statusEl = card.querySelector(".theme-review-names-status");
      const inputs = card.querySelectorAll(".theme-review-names-input");
      const appliedById = new Map((payload.applied || []).map((change) => [change.id, change.name]));
      const rejectedById = new Map((payload.rejected || []).map((rejection) => [rejection.id, rejection.reason]));
      for (const input of inputs) {
        input.disabled = false;
        const rowId = input.getAttribute("data-row-id");
        if (rowId && appliedById.has(rowId)) {
          const nextName = appliedById.get(rowId);
          input.value = nextName;
          input.dataset.original = nextName;
        } else if (rowId && rejectedById.has(rowId)) {
          input.value = input.dataset.original;
        }
      }
      if (applyBtn) {
        applyBtn.textContent = "Apply names";
        applyBtn.disabled = true;
      }
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
        } else {
          statusEl.textContent = "Names saved ✓";
          statusEl.classList.remove("theme-review-error");
        }
      }
    }
  }

  function renderThemeImageReview(payload) {
    if (!themeImageReview || !themeImageReviewList) return;
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
        : "Write a revised prompt or describe exactly what should change for this item.";
      const savedDraft = reviewUiState.drafts.get(item.id);
      if (savedDraft) feedback.value = savedDraft.feedback;
      const feedbackHint = document.createElement("div");
      feedbackHint.className = "theme-review-feedback-hint";
      feedbackHint.textContent = "Notes only — don't paste a full prompt; layout and art rules are added automatically.";
      // Object/decor/rival board rows are always drawn from the manifest's
      // buildable_objects / decor_objects / roster_rivals display names — the
      // "Names" editor below is the only way to rename them (notes above are
      // creative direction only and cannot rename or reorder rows).
      const namesSection = buildThemeReviewNamesSection(
        item,
        savedDraft,
        themeReviewBusyItems.get(item.id) === "names",
        Boolean(payload.generation_active && !isCurrentReviewGate),
      );
      const retryRow = document.createElement("div");
      retryRow.className = "theme-review-retry-row";
      const mode = document.createElement("select");
      mode.className = "theme-review-mode";
      const augmentOption = document.createElement("option");
      augmentOption.value = "augment";
      augmentOption.textContent = "Add notes to original prompt";
      const replaceOption = document.createElement("option");
      replaceOption.value = "replace";
      replaceOption.textContent = "Replace creative direction";
      const retryOption = document.createElement("option");
      retryOption.value = "retry";
      retryOption.textContent = "No notes, just retry";
      retryOption.disabled = !item.prompt;
      mode.appendChild(augmentOption);
      mode.appendChild(replaceOption);
      mode.appendChild(retryOption);
      mode.value = "replace";
      if (item.generation_error) mode.value = "replace";
      if (savedDraft?.mode
          && Array.from(mode.options).some((option) => option.value === savedDraft.mode && !option.disabled)) {
        mode.value = savedDraft.mode;
      }
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
      retryBtn.disabled = retryBusy || Boolean(payload.generation_active && !isCurrentReviewGate);
      retryBtn.title = !item.image_src && !payload.generation_active
        ? "Generate this unfinished image using the notes above."
        : payload.generation_active && !isCurrentReviewGate
          ? "This image is generating or queued in the active run."
          : "Generate a replacement using the notes above.";
      retryBtn.addEventListener("click", () => {
        const notes = feedback.value.trim();
        if (mode.value !== "retry" && !notes) {
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
            mode: mode.value,
            image_provider: selectedThemeImageProvider(),
            character_name: characterNameInput ? characterNameInput.value.trim() : undefined,
          },
        });
      });
      const updateRetryMode = () => {
        const retriesSavedPrompt = mode.value === "retry";
        feedback.disabled = retriesSavedPrompt;
        if (retriesSavedPrompt) feedback.removeAttribute("aria-invalid");
      };
      mode.addEventListener("change", updateRetryMode);
      updateRetryMode();
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
      retryRow.appendChild(mode);
      retryRow.appendChild(retryBtn);
      if (resliceBtn) retryRow.appendChild(resliceBtn);

      const promptDetails = document.createElement("details");
      promptDetails.className = "theme-review-prompt";
      promptDetails.open = Boolean(savedDraft?.promptOpen);
      const promptSummary = document.createElement("summary");
      promptSummary.textContent = "View generation prompt";
      const promptText = document.createElement("pre");
      promptText.textContent = item.prompt || "Legacy image — no original prompt was saved.";
      promptDetails.appendChild(promptSummary);
      promptDetails.appendChild(promptText);

      body.appendChild(heading);
      body.appendChild(meta);
      if (generationError) body.appendChild(generationError);
      if (nameRow) body.appendChild(nameRow);
      if (namesSection) body.appendChild(namesSection);
      body.appendChild(decisionRow);
      body.appendChild(feedback);
      body.appendChild(feedbackHint);
      body.appendChild(retryRow);
      body.appendChild(retryStatus);
      body.appendChild(retryWarning);
      body.appendChild(promptDetails);
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

      for (const charId of rosterOrder) {
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
          imgEl.width = 44;
          imgEl.height = 44;
          imgEl.draggable = false;
          imgEl.style.pointerEvents = "none";
          thumb.appendChild(imgEl);
        } else {
          thumb.textContent = charId.slice(0, 2).toUpperCase();
        }

        // Label below thumbnail
        const charLabel = document.createElement("div");
        charLabel.className = "modal-roster-char-label";
        charLabel.textContent = charId.slice(0, 8);
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
    melee:     { frames: [5, 6, 7, 8],     fps: 12, loop: false, flippable: true },
    build:     { frames: [5, 6, 7, 8],     fps: 6,  loop: true,  flippable: true },
    tool_idle: { frames: [9],              fps: 0,  loop: true,  flippable: true,  hold: true },
    shoot:     { frames: [10, 11],         fps: 8,  loop: false, flippable: true,  pingpong: true },
    dance:     { frames: [17, 18, 19],     fps: 6,  loop: true,  flippable: false, pingpong: true },
    cheer:     { frames: [19],             fps: 0,  loop: true,  flippable: false, hold: true },
    point:     { frames: [12],             fps: 0,  loop: true,  flippable: true,  hold: true },
    signal:    { frames: [13],             fps: 0,  loop: true,  flippable: false, hold: true },
    dodge:     { frames: [14],             fps: 0,  loop: false, flippable: true,  hold: true },
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
  /** Effective decor scale for a given decor_id. */
  function effectiveDecorScale(decorId) {
    const o = themeDecorScaleOverrides[decorId];
    return (typeof o === "number" && o > 0) ? o : themeDecorScale;
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
   * Fraction of the chair sprite's height (base→seat surface) used to lift a
   * seated character when its chair is scaled up/down via the decor scale. The
   * chair draws at 64 * chairDepth * chairScale, so a bigger chair's seat
   * surface rises; the seated character (fixed native sit-point) would otherwise
   * sit too low. Raise = SEAT_RAISE_FRAC * (chairScale - 1) * 64 * chairDepth —
   * zero at scale 1 (unchanged). Bumped 0.42 → 0.6: these throne seats sit
   * higher up the sprite than 0.42 assumed, so scaled-up chairs left the
   * occupant too low. Single tune-friendly constant.
   */
  const SEAT_RAISE_FRAC = 0.6;
  /**
   * Horizontal canvas-px nudge applied to a seated character's draw position
   * for better chair alignment: shifted RIGHT when its seat is not flipped,
   * mirrored to the LEFT when the seat IS flipped horizontally. Cosmetic
   * draw-time only — never affects logical position or depth sort.
   */
  const SEAT_SEATED_NUDGE_PX = 4;
  /** Chance, per idle wander-decision, that an idle agent goes to sit on a free seat. */
  const SIT_CHANCE = 0.05;
  /** How long (seconds) a character stays seated before standing up. */
  const SIT_SECONDS = 12;
  /** How close (native px) to a seat's sit-point before the agent is "seated". */
  const SIT_ARRIVED_EPS = 4;
  /** Effective object scale for a given buildable object id. */
  function effectiveObjScale(objId) {
    const o = themeObjScaleOverrides[objId];
    return (typeof o === "number" && o > 0) ? o : themeObjectScale;
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
   * of badges. Thresholds are checked against buildDefaultBadges() (themeMigration.ts):
   *   Tier 0 (rebirthCount === 0, i.e. rolling the FIRST rebirth's requirement):
   *     the easiest badges — build_3/6 (3/6 objects), evict_5/10 (5/10 evictions),
   *     task_10 (10 tasks), crew_3 (3 agents active).
   *   Tier 1 (rebirthCount === 1): mid-range — build_10/13, evict_20/35,
   *     task_50, crew_6.
   *   Tier 2+ (rebirthCount >= 2): the hardest per-cycle badges — evict_50/75/100,
   *     task_150/500. (No harder AGENTS_ACTIVE badge exists beyond crew_6, which
   *     is already used at tier 1, so tier 2 draws only from evict_/task_.)
   * rebirth_* badges are NEVER included in any tier: they're permanent
   * (rebirthCount-gated, never wiped) so putting one in a requirement pool
   * would make it trivially/permanently satisfied after the first Rebirth.
   */
  const REBIRTH_TIER0_EASY = ["build_3", "build_6", "evict_5", "evict_10", "task_10", "crew_3"];
  const REBIRTH_TIER1_MEDIUM = ["build_10", "build_13", "evict_20", "evict_35", "task_50", "crew_6"];
  const REBIRTH_TIER2_HARD = ["evict_50", "evict_75", "evict_100", "task_150", "task_500"];
  /** Pick the tier pool to draw the next requirement from, based on rebirthCount. */
  function rebirthTierPool(count) {
    if (count <= 0) return REBIRTH_TIER0_EASY;
    if (count === 1) return REBIRTH_TIER1_MEDIUM;
    return REBIRTH_TIER2_HARD;
  }
  // NOTE: rebirthCount/rebirthBaseline/requiredRebirthBadgeIds are restored
  // from vscode.getState().rebirth inside the THEME_INITIALIZED handler
  // (~line 4349), not here — requiredRebirthBadgeIds must be validated
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
   * the session. Reset to false on every THEME_INITIALIZED (new theme load).
   */
  let rangedUnlocked = false;

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
   * @param {Array<object>} buildables
   * @param {string} themeId
   * @returns {string[]}
   */
  function buildSeededQueue(buildables, themeId) {
    const ids = buildables.map((o) => o.object_id);
    const rand = mulberry32(seededHash(String(themeId || "")));
    // Fisher-Yates shuffle using the seeded PRNG.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    }
    return ids;
  }

  // ── Phase 2b: enemy / EVICT mode state ───────────────────────────────────
  /** Seconds between enemy spawn waves (manifest.viewport.enemy_config.spawn_interval_seconds). */
  let enemySpawnIntervalSec = 45;
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
   * Fraction of walkableNativeH that a projectile's origin/impact points are
   * raised above the shooter/target's BASE (feet) position, so shots read as
   * coming from roughly gun / mid-character height instead of the ground.
   * Both endpoints are raised equally so the shot angle is unaffected. Tunable.
   */
  const PROJECTILE_GUN_HEIGHT_FRAC = 0.06;
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
  /** Index of the polygon vertex currently being dragged, or -1. */
  let dragVertexIndex = -1;
  /** Index of the polygon vertex under the cursor (for hover highlight), or -1. */
  let hoverVertexIndex = -1;
  /** Id of the scene object (buildable/decor) currently being dragged, or null. */
  let dragObjectId = null;
  /** Type of the dragged scene object: "buildable" | "decor" | null. */
  let dragObjectType = null;
  /** Type of the scene object currently under the cursor (hover, not drag): "buildable" | "decor" | null. Used by the F-to-flip decor shortcut. */
  let hoverSceneObjType = null;
  /** Id of the scene object currently under the cursor (hover, not drag), or null. */
  let hoverSceneObjId = null;
  /** Last drawn background rect (canvas px) — lets mouse handlers map canvas<->native. */
  let lastBgX = 0, lastBgY = 0, lastBgW = 1, lastBgH = 1;
  /** Character id selected in the per-character override control. */
  let editSelectedCharId = "";
  /** Buildable object_id selected in the per-object override control. */
  let editSelectedObjId = "";
  /** Rival rival_id selected in the per-rival override control. */
  let editSelectedRivalId = "";
  /** Decor decor_id selected in the per-decor override control. */
  let editSelectedDecorId = "";

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
    const vi = vertexAt(mx, my, 11);
    if (vi >= 0) { dragVertexIndex = vi; e.preventDefault(); return; }
    // Otherwise start dragging a buildable/decor object under the cursor.
    const hit = sceneObjectAt(mx, my, 20);
    if (hit) {
      dragObjectType = hit.type;
      dragObjectId = hit.id;
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
    if (dragVertexIndex >= 0) {
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
          '</div>' +
        '</div>' +
        '<div class="se-section">' +
          '<div class="se-section-title">Enemies</div>' +
          '<div class="se-row"><span class="se-label">Spawn interval (s)</span><span class="se-value"><span id="se-ei-val">45</span></span></div>' +
          '<input id="se-ei" class="se-range" type="range" min="10" max="180" step="5" value="45">' +
          '<div class="se-sublabel">Enemy count mode</div>' +
          '<select id="se-ecm" class="se-select"><option value="random">random</option><option value="all">all</option></select>' +
        '</div>' +
        '<div id="se-hint" class="se-hint">Polygon: drag points · dbl-click edge to add · right-click to remove.<br>Objects/decor: drag to move · right-click to reset (decor: hide) · hover decor + F to flip</div>' +
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
    stageEditEls.ei = wrap.querySelector("#se-ei");
    stageEditEls.eiVal = wrap.querySelector("#se-ei-val");
    stageEditEls.ecm = wrap.querySelector("#se-ecm");
    stageEditEls.save = wrap.querySelector("#se-save");
    stageEditEls.done = wrap.querySelector("#se-done");
    stageEditEls.status = wrap.querySelector("#se-status");
    stageEditEls.showAll = wrap.querySelector("#se-show-all");

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
      syncDecorOverrideSlider();
    });
    stageEditEls.do_.addEventListener("input", () => {
      if (!editSelectedDecorId) return;
      themeDecorScaleOverrides[editSelectedDecorId] = parseFloat(stageEditEls.do_.value) || 1;
    });
    stageEditEls.doClear.addEventListener("click", () => {
      if (editSelectedDecorId) delete themeDecorScaleOverrides[editSelectedDecorId];
      syncDecorOverrideSlider();
    });
    stageEditEls.ei.addEventListener("input", () => {
      enemySpawnIntervalSec = parseFloat(stageEditEls.ei.value) || 45;
      stageEditEls.eiVal.textContent = String(Math.round(enemySpawnIntervalSec));
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
    stageEditEls.oo.value = String(typeof ov === "number" && ov > 0 ? ov : themeObjectScale);
  }
  function syncRivalOverrideSlider() {
    const ov = themeRivalScaleOverrides[editSelectedRivalId];
    stageEditEls.ro.value = String(typeof ov === "number" && ov > 0 ? ov : themeRivalScale);
  }
  function syncDecorOverrideSlider() {
    const ov = themeDecorScaleOverrides[editSelectedDecorId];
    stageEditEls.do_.value = String(typeof ov === "number" && ov > 0 ? ov : themeDecorScale);
  }
  function enterEditStage() {
    if (!themeLoaded) return;
    buildStageEditPanel();
    editStageMode = true;
    // Build the per-character override list strictly from the playable roster
    // (manifest.roster_agents), keyed "agent_"+slot_id to match effectiveCharScale/
    // themeImages. Never fall back to Object.keys(themeImages) — that set also
    // contains object_/rival_/crate/poof/badge_/expression_ keys.
    let charOptions;
    if (themeRosterAgents.length) {
      charOptions = themeRosterAgents
        .filter((a) => a && a.slot_id)
        .map((a) => ({ id: "agent_" + a.slot_id, label: a.name || a.slot_id }));
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
    stageEditEls.eiVal.textContent = String(Math.round(enemySpawnIntervalSec));
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
    const decorOptions = themeDecor
      .filter((d) => d && d.decor_id != null)
      .map((d) => ({ id: d.decor_id, label: d.display_name || d.decor_id }));
    stageEditEls.decor.innerHTML = "";
    for (const opt of decorOptions) {
      const optEl = document.createElement("option");
      optEl.value = opt.id;
      optEl.textContent = opt.label;
      stageEditEls.decor.appendChild(optEl);
    }
    editSelectedDecorId = (decorOptions[0] && decorOptions[0].id) || "";
    syncDecorOverrideSlider();
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
        decor_flip_overrides: themeDecorFlipOverrides,
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
    // F toggles a horizontal-flip override on the hovered decor (Stage
    // Editor only). Never hijacks F outside edit mode or off a decor hover.
    if ((e.key === "f" || e.key === "F") && editStageMode && hoverSceneObjType === "decor" && hoverSceneObjId) {
      if (themeDecorFlipOverrides[hoverSceneObjId]) delete themeDecorFlipOverrides[hoverSceneObjId];
      else themeDecorFlipOverrides[hoverSceneObjId] = true;
      e.preventDefault();
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
      ctx.drawImage(crateImg, cx - baseSize / 2, cy - baseSize, baseSize, baseSize);
      // Change 2: progress/health bar for the ACTIVE crate — since the build
      // queue guarantees exactly one active object at a time, this bar is
      // always visible while building. Clamp barY so it never clips off the
      // top of the canvas (e.g. tall objects near the top of the stage).
      const barW = Math.max(24, baseSize * 0.9);
      const barH = 6;
      const barX = cx - barW / 2;
      const barY = Math.max(2, cy - baseSize - 14);
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
      const objImg = objSlots ? objSlots[slotIdx] : null;
      if (objImg && objImg.complete && objImg.naturalWidth > 0) {
        ctx.drawImage(objImg, cx - baseSize / 2, cy - baseSize, baseSize, baseSize);
      } else if (objImg && !objImg.complete) {
        // Object art still decoding — draw nothing (pops in when ready) and
        // keep the boot loader opaque. Permanently missing art also renders
        // nothing (the theme health check flags it).
        bootFrameSpritePending = true;
      }
    }
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
        themeObjScaleOverrides = (vp && vp.object_scale_overrides && typeof vp.object_scale_overrides === "object") ? vp.object_scale_overrides : {};
        themeRivalScale = (vp && typeof vp.rival_scale === "number" && vp.rival_scale > 0) ? vp.rival_scale : 1;
        themeRivalScaleOverrides = (vp && vp.rival_scale_overrides && typeof vp.rival_scale_overrides === "object") ? Object.assign({}, vp.rival_scale_overrides) : {};
        themeDecorScale = (vp && typeof vp.decor_scale === "number" && vp.decor_scale > 0) ? vp.decor_scale : DECOR_SCALE;
        themeDecorScaleOverrides = (vp && typeof vp.decor_scale_overrides === "object" && vp.decor_scale_overrides) ? Object.assign({}, vp.decor_scale_overrides) : {};

        // ── Phase 2a: capture buildable objects + resolve stable placement ──
        const manifest = msg.payload?.manifest;
        themeBuildables = Array.isArray(manifest?.buildable_objects)
          ? manifest.buildable_objects.slice().sort((a, b) => (a.build_order || 0) - (b.build_order || 0))
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
        buildQueue = buildSeededQueue(themeBuildables, initializedThemeId);
        buildBuiltCount = 0;
        buildCurrentProgress = 0;
        // ── Badges (reset per theme) ─────────────────────────────────────
        themeBadges = Array.isArray(manifest?.badges) ? manifest.badges : [];
        rivalsEvictedCount = 0;
        // Seed from the host's persisted per-theme unlocks so previously-earned
        // badges stay unlocked across sessions; only the session counters
        // (rivalsEvictedCount/buildBuiltCount) reset to 0 above/below.
        currentBadgeThemeId = initializedThemeId || (manifest && manifest.theme_id) || null;
        const seededUnlockIds = Array.isArray(msg.payload?.unlocked_badge_ids) ? msg.payload.unlocked_badge_ids : [];
        unlockedBadgeIds = new Set(seededUnlockIds);
        // ── Rebirth: restore persisted prestige state. Independent of the
        // per-theme badge unlocks above — rebirth (count/baseline/requirement)
        // persists across theme switches and webview reloads. Source of truth is
        // now the HOST payload (rebirth_state, keyed by theme_id, survives webview
        // disposal); fall back to the local vscode getState() cache when absent.
        const hostRebirth = msg.payload.rebirth_state;
        const savedRebirth = hostRebirth || (vscode.getState() || {}).rebirth;
        if (savedRebirth && typeof savedRebirth === "object") {
          rebirthCount = typeof savedRebirth.count === "number" ? savedRebirth.count : 0;
          if (savedRebirth.baseline && typeof savedRebirth.baseline === "object") {
            rebirthBaseline = {
              built: savedRebirth.baseline.built || 0,
              evicted: savedRebirth.baseline.evicted || 0,
              tasks: savedRebirth.baseline.tasks || 0,
            };
          }
          requiredRebirthBadgeIds = Array.isArray(savedRebirth.required) ? savedRebirth.required.slice() : [];
          if (Array.isArray(savedRebirth.unlocked)) {
            for (const id of savedRebirth.unlocked) unlockedBadgeIds.add(id);
          }
          // DURABLE per-cycle badge counters: RESTORE (don't reset) so earned-
          // badge progress survives webview reload. Default 0 when absent (old
          // saved state, or a theme with no prior cycle progress).
          cycleObjectsBuilt = typeof savedRebirth.cycleBuilt === "number" ? savedRebirth.cycleBuilt : 0;
          cycleRivalsEvicted = typeof savedRebirth.cycleEvicted === "number" ? savedRebirth.cycleEvicted : 0;
        } else {
          // No saved rebirth state for this theme — start the cycle counters fresh.
          cycleObjectsBuilt = 0;
          cycleRivalsEvicted = 0;
        }
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
        // ── Ranged combat upgrade (reset per theme) ─────────────────────
        // Characters START in melee. Building the ranged weapon rack (the
        // buildable with build_order 0 → themeBuildables[0] after the sort)
        // permanently unlocks ranged combat for the rest of the session.
        // Because buildQueue is randomized, the rack may be built early,
        // late, or never — that's intended. D1: once rebirthCount>=1, ranged
        // combat is a permanent prestige bonus and applies from theme-load,
        // regardless of whether the rack has been (re)built this cycle.
        rangedUnlocked = rebirthCount >= 1;
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
    } else if (msg && msg.type === "STAGE_TUNING_SAVED") {
      if (stageEditEls && stageEditEls.status) {
        const ok = msg.payload && msg.payload.ok;
        stageEditEls.status.textContent = ok ? "Saved to theme ✓" : "Save failed";
        stageEditEls.status.style.color = ok ? "#9fffa0" : "#ff9f9f";
      }
    } else if (msg && msg.type === "THEME_ITEM_NAMES_RESULT") {
      applyThemeItemNamesResult(msg.payload || {});
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
      handleInstallState(msg);
      if (msg.uefnDetected) {
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

  // ── Team rollup (Team Lead Mode Phase 3: hierarchy telemetry) ───────────
  // Entries with tier === "lead" that have at least one visible child (a
  // worker whose parentId points at them) render as an expand/collapse team
  // row. Expand/collapse state is persisted per-lead-id in webview state,
  // mirroring the metricsHeight/rosterOrder persistence above. Defaults to
  // expanded so a first-time view shows individual rows.

  /** @param {string} leadId */
  function isTeamExpanded(leadId) {
    const saved = vscode.getState() || {};
    const map = saved.teamExpanded || {};
    return map[leadId] !== false;
  }

  /** @param {string} leadId @param {boolean} expanded */
  function setTeamExpanded(leadId, expanded) {
    const prev = vscode.getState() || {};
    const map = { ...(prev.teamExpanded || {}) };
    map[leadId] = expanded;
    vscode.setState({ ...prev, teamExpanded: map });
  }

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
   * Build a synthetic "team aggregate" row for a collapsed lead: sums
   * tasks/MCP/tokens/live-time across the lead and its workers. Approximate
   * (mirrors the hook's stack-based parent inference) but good enough for a
   * rollup total — see docs/plan/team-lead-mode.md Phase 3.
   */
  function aggregateTeam(lead, children) {
    const sum = (key) => children.reduce((s, c) => s + ((c && c[key]) || 0), 0);
    const totalLiveMs = liveMsFor(lead) + children.reduce((s, c) => s + liveMsFor(c), 0);
    return {
      ...lead,
      taskCount: (lead.taskCount || 0) + sum("taskCount"),
      mcpCount: (lead.mcpCount || 0) + sum("mcpCount"),
      tokens: (lead.tokens || 0) + sum("tokens"),
      // Pre-baked total; workStartAt cleared so the row renderer doesn't add
      // a second live segment on top of what liveMsFor() already counted.
      activeMs: totalLiveMs,
      workStartAt: null,
    };
  }

  /**
   * Render one metrics row. `opts.chevron` ("expanded"|"collapsed") marks a
   * lead's team-rollup row; `opts.indent` marks a worker nested under an
   * expanded lead; `opts.teamTag` labels a collapsed row as an aggregate.
   */
  function buildMetricsRow(agent, maxTokensPerMin, opts) {
    opts = opts || {};
    const status = (agent.status || "idle").toLowerCase();
    const isActive = status === "active";
    const showActive = isMetricsAgentActive(agent);
    const row = document.createElement("tr");
    const rowClasses = [];
    if (opts.indent) rowClasses.push("metrics-row--child");
    if (opts.chevron) rowClasses.push("metrics-row--lead");
    if (rowClasses.length) row.className = rowClasses.join(" ");

    const displayName = agent.name || agent.id;

    const nameTd = document.createElement("td");
    nameTd.className = `col-name${showActive ? " name--active" : ""}`;

    if (opts.chevron) {
      const chevronBtn = document.createElement("button");
      chevronBtn.type = "button";
      chevronBtn.className = "team-chevron";
      const expanded = opts.chevron === "expanded";
      chevronBtn.setAttribute("aria-label", expanded ? "Collapse team" : "Expand team");
      chevronBtn.setAttribute("aria-expanded", String(expanded));
      chevronBtn.textContent = expanded ? "▾" : "▸"; // ▾ expanded / ▸ collapsed
      chevronBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setTeamExpanded(opts.leadId, !expanded);
        renderMetrics(lastMetrics);
      });
      nameTd.appendChild(chevronBtn);
    } else if (opts.indent) {
      const spacer = document.createElement("span");
      spacer.className = "metrics-row-indent";
      nameTd.appendChild(spacer);
    }

    const nameText = document.createElement("span");
    nameText.textContent = displayName;
    nameTd.appendChild(nameText);

    if (opts.teamTag) {
      const tag = document.createElement("span");
      tag.className = "team-tag";
      tag.textContent = "team";
      tag.title = "Rolled-up total for this lead's team (lead + its workers, approximate — see docs/plan/team-lead-mode.md).";
      nameTd.appendChild(tag);
    }

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

    // Status bar: green while active, gray while idle. Width encodes the
    // raw tokens per minute of active time (tokens / activeMs minutes), normalized
    // to the agent with the highest tokens-per-minute. Active agents always show
    // a visible green sliver so "working" is never invisible.
    const mins = (agent.activeMs || 0) / 60000;
    const tokensPerMin = mins > 0 ? (agent.tokens || 0) / mins : null;
    const rawPct = tokensPerMin !== null
      ? Math.round(Math.min(tokensPerMin / maxTokensPerMin, 1) * 100)
      : 0;
    const fillPct = showActive ? Math.max(rawPct, 15) : rawPct;
    const statusTd = document.createElement("td");
    statusTd.className = "col-status";
    statusTd.title = "Tokens/min — average tokens generated per minute of active time. The bar is scaled to the busiest agent.";
    const track = document.createElement("div");
    track.className = "status-bar-track";
    const fill = document.createElement("div");
    fill.className = `status-bar-fill ${showActive ? "status-bar-fill--active" : "status-bar-fill--idle"}`;
    fill.style.width = `${fillPct}%`;
    const label = document.createElement("span");
    label.className = "status-bar-label";
    label.textContent = showActive ? "active" : (tokensPerMin !== null ? fmtTokens(Math.round(tokensPerMin)) : "—");
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

    // Raw tokens per minute of active time: each agent's token total divided by
    // its finalized active minutes (no model weighting). Used to scale the status bar.
    const maxTokensPerMin = Math.max(1, ...metrics.map(a => {
      const mins = (a.activeMs || 0) / 60000;
      return mins > 0 ? (a.tokens || 0) / mins : 0;
    }));

    // Group workers under a visible lead (tier === "lead"). Approximate —
    // parentId comes from the hook's active-agent-stack inference and can
    // misattribute concurrent spawns (docs/plan/team-lead-mode.md Phase 3).
    const leadIds = new Set(metrics.filter((m) => ((m && m.tier) || "").toLowerCase() === "lead").map((m) => m.id));
    const childrenByLead = new Map();
    for (const m of metrics) {
      if (m && m.parentId && leadIds.has(m.parentId)) {
        if (!childrenByLead.has(m.parentId)) childrenByLead.set(m.parentId, []);
        childrenByLead.get(m.parentId).push(m);
      }
    }
    const nestedChildIds = new Set();
    for (const arr of childrenByLead.values()) {
      for (const c of arr) nestedChildIds.add(c.id);
    }

    // Rebuild rows
    tbodyEl.innerHTML = "";
    for (const agent of metrics) {
      // Rendered nested under its lead below — skip its top-level slot.
      if (nestedChildIds.has(agent.id)) continue;

      const children = leadIds.has(agent.id) ? (childrenByLead.get(agent.id) || []) : [];
      if (children.length === 0) {
        // Flat row: no children to roll up — identical to pre-Phase-3 rendering,
        // including leads that haven't spawned anyone (yet) and any worker whose
        // parentId doesn't match a currently-visible lead.
        tbodyEl.appendChild(buildMetricsRow(agent, maxTokensPerMin, {}));
        continue;
      }

      if (isTeamExpanded(agent.id)) {
        tbodyEl.appendChild(buildMetricsRow(agent, maxTokensPerMin, { chevron: "expanded", leadId: agent.id }));
        for (const child of children) {
          tbodyEl.appendChild(buildMetricsRow(child, maxTokensPerMin, { indent: true }));
        }
      } else {
        tbodyEl.appendChild(buildMetricsRow(
          aggregateTeam(agent, children),
          maxTokensPerMin,
          { chevron: "collapsed", leadId: agent.id, teamTag: true },
        ));
      }
    }
  }

  /** Display label for a delegation mode id. */
  const DELEGATION_MODE_LABEL = { flat: "Flat", team_leads: "Team Leads" };

  /**
   * Render the "Delegation stats" section (Team Lead Mode Phase 4:
   * measurement) — one row per delegation mode that has recorded data, so the
   * install screen's estimated "10-20% more tokens" claim can be checked
   * against real numbers measured in this workspace.
   * @param {Array<{mode:string,completedTasks:number,totalTokens:number,activeMs:number,leadTokens:number,teamTokens:number,leadOverheadPct:number|null}>|undefined} modeStats
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
      detail.textContent = text;
      row.appendChild(detail);

      el.appendChild(row);
    }

    const caption = document.createElement("div");
    caption.className = "delegation-stats-caption";
    caption.textContent = "Measured this workspace — not an estimate.";
    el.appendChild(caption);
  }

  // Re-render once a second so any active agent's live time keeps advancing
  // between state pushes.
  setInterval(() => {
    if (lastMetrics.length && lastMetrics.some((a) => (a.status || "").toLowerCase() === "active")) {
      renderMetrics(lastMetrics);
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
      // delegation-mode radios (disabled while the change was in flight)
      // would otherwise stay stuck — re-enable them here.
      if (msg.field === "delegationMode" && row) {
        row.querySelectorAll('input[type="radio"]').forEach((el) => { el.disabled = false; });
      }
    }
  }

  /**
   * Handle a metricsReset ack from the host.
   * @param {{ok:boolean, error?:string}} msg
   */
  function handleMetricsReset(msg) {
    if (msg.ok) {
      lastMetrics = [];
      renderMetrics([]);
      renderDelegationStats([]);
      renderSettings();
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
        label: "Flat (recommended for most projects)",
        help: "The orchestrator briefs specialist workers directly. Lowest token cost, fastest for small-to-medium tasks.",
      },
      {
        value: "team_leads",
        label: "Team Leads",
        help: "Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs — many features across many files — where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Flat.",
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
        for (const model of ["opus", "sonnet", "haiku", "fable"]) {
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
      const tpm = mins > 0 ? Math.round((m.tokens || 0) / mins) : 0;
      const chip = (label, value) => {
        const c = document.createElement("span");
        c.className = "stat-chip";
        c.textContent = `${label} ${value}`;
        return c;
      };
      stats.appendChild(chip("tok/min", fmtTokens(tpm)));
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
    setupConfigEl.appendChild(routingSection);

  // ── 3b. Delegation Health ──
  const dhSection = buildSection("Delegation Health");
  const dh = (lastSettings && lastSettings.delegationHealth) || {};
  const directSearches = (typeof dh.directSearches === "number") ? dh.directSearches : 0;
  const directReads    = (typeof dh.directReads    === "number") ? dh.directReads    : 0;
  const directEdits    = (typeof dh.directEdits    === "number") ? dh.directEdits    : 0;
  const delegations    = (typeof dh.delegations    === "number") ? dh.delegations    : 0;
  const warnThreshold  = (typeof dh.warnThreshold  === "number") ? dh.warnThreshold  : 5;
  // Reads are allowed for known files (per CLAUDE.md) — they are NOT a leak, so
  // they are excluded from the ratio. Only direct Grep/Glob and edits count.
  const dhLeak = directSearches + directEdits;
  const dhTotal = delegations + dhLeak;
  if (dhTotal === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "settings-empty";
    emptyP.textContent = "No delegatable activity yet this session.";
    dhSection.appendChild(emptyP);
  } else {
    const ratio = delegations / dhTotal;
    // Green / yellow / red traffic light, consistent with the rest of the UI.
    const light = ratio >= 0.6
      ? { color: "var(--status-active)", label: "Delegating well", glow: true }
      : ratio >= 0.35
        ? { color: "var(--status-done)", label: "Some direct work", glow: false }
        : { color: "var(--status-error)", label: "Low delegation", glow: false };
    const badge = document.createElement("div");
    badge.className = "settings-row";
    badge.style.flexDirection = "row";
    badge.style.alignItems = "center";
    badge.style.gap = "6px";
    const dot = document.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "9px";
    dot.style.height = "9px";
    dot.style.borderRadius = "50%";
    dot.style.background = light.color;
    if (light.glow) { dot.style.boxShadow = "0 0 5px " + light.color; }
    const badgeSpan = document.createElement("span");
    badgeSpan.style.fontWeight = "600";
    badgeSpan.textContent = `${light.label} · ${Math.round(ratio * 100)}%`;
    badge.appendChild(dot);
    badge.appendChild(badgeSpan);
    dhSection.appendChild(badge);

    const summaryRow = document.createElement("div");
    summaryRow.className = "settings-row";
    const summarySpan = document.createElement("span");
    summarySpan.textContent = `Orchestrator delegated ${delegations} tasks; did ${directSearches} searches and ${directEdits} edits directly.`;
    summaryRow.appendChild(summarySpan);
    dhSection.appendChild(summaryRow);

    const delegRow = document.createElement("div");
    delegRow.className = "settings-row";
    const delegSpan = document.createElement("span");
    delegSpan.textContent = `Delegations: ${delegations}`;
    delegRow.appendChild(delegSpan);
    dhSection.appendChild(delegRow);

    const searchRow = document.createElement("div");
    searchRow.className = "settings-row";
    const searchSpan = document.createElement("span");
    searchSpan.textContent = `Direct searches (Grep/Glob): ${directSearches} — delegate to search-retrieval (Haiku, ~40x cheaper)`;
    if (directSearches > warnThreshold) { searchSpan.style.color = "var(--status-error)"; }
    searchRow.appendChild(searchSpan);
    dhSection.appendChild(searchRow);

    const editRow = document.createElement("div");
    editRow.className = "settings-row";
    const editSpan = document.createElement("span");
    editSpan.textContent = `Direct edits: ${directEdits} — delegate to coding-specialist (Sonnet)`;
    editRow.appendChild(editSpan);
    dhSection.appendChild(editRow);

    const readRow = document.createElement("div");
    readRow.className = "settings-row";
    const readSpan = document.createElement("span");
    readSpan.style.color = "var(--muted)";
    readSpan.textContent = `Direct file reads: ${directReads} — allowed for known files`;
    readRow.appendChild(readSpan);
    dhSection.appendChild(readRow);

    const noteRow = document.createElement("div");
    noteRow.className = "settings-row";
    const noteSpan = document.createElement("span");
    noteSpan.style.color = "var(--muted)";
    noteSpan.style.fontSize = "11px";
    noteSpan.textContent = "Session totals — reflects the whole session so far.";
    noteRow.appendChild(noteSpan);
    dhSection.appendChild(noteRow);

    const btnRow = document.createElement("div");
    btnRow.className = "settings-row";
    const copyBtn = document.createElement("button");
    copyBtn.className = "skill-btn settings-btn";
    copyBtn.textContent = "Copy delegation tip";
    copyBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "copyNudge", text: "Delegate all searches and file reads to sub-agents per CLAUDE.md - search-retrieval for lookups, coding-specialist for edits." });
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

      // Agent file rows
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
        agentRow.appendChild(agentText);
        budgetSection.appendChild(agentRow);
      }

      // Muted note
      const agentNote = document.createElement("p");
      agentNote.className = "settings-empty";
      agentNote.textContent = "Agent files load per sub-agent spawn, not every prompt.";
      budgetSection.appendChild(agentNote);

      // Review for trimming button
      const trimBtn = document.createElement("button");
      trimBtn.className = "skill-btn settings-btn";
      trimBtn.textContent = "Review for trimming";
      trimBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "copyPrompt", text: "Review CLAUDE.md and the agent definition files in .claude/agents/ for context bloat. CLAUDE.md is loaded into every prompt, so prioritize it: flag verbose, duplicated, or non-essential lines and propose a tighter rewrite that preserves every behavioral rule and the delegation routing. Then do the same for each .claude/agents/*.md (loaded per spawn). For each file give a before/after token estimate and the specific cuts." });
      });
      budgetSection.appendChild(trimBtn);
    }
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

    // ── 5. Danger zone ──
    const dangerSection = buildSection("Danger zone");
    dangerSection.classList.add("danger-section");
    const dangerRow = document.createElement("div");
    dangerRow.className = "settings-row danger-row";
    const resetBtn = document.createElement("button");
    resetBtn.className = "skill-btn settings-btn danger-btn";
    resetBtn.textContent = "Reset session metrics";
    resetBtn.addEventListener("click", () => {
      if (window.confirm("Reset all session metrics? This cannot be undone.")) {
        vscode.postMessage({ type: "resetMetrics" });
      }
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
    // unconditionally in completeBuildIfReady() (called every frame), so a
    // fast-forward (F hotkey) that pushes progress past 1 always poofs/advances.
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
   * Ungated completion check: whenever buildCurrentProgress has reached 1 (via
   * normal building OR the F fast-forward hotkey), transition the active object
   * to POOF (or advance directly if no poof art). Runs every frame regardless
   * of enemy/conga/builder gating so F reliably completes an object.
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
      if (ce) startAgentDance(ce);
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

  // debug hotkeys: c=conga, f=fast-forward build
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const key = (e.key || "").toLowerCase();
    if (key === "c") {
      // Force-start a conga now (ignore eligibility/cooldown/probability).
      if (congaActive) return;
      if (lastAgentList.length < 1) return;
      startConga(lastAgentList);
    } else if (key === "f") {
      // Fast-forward the CURRENT active object's build by one full object
      // (a build normally takes 20 real minutes). +1.0 progress per press;
      // completeBuildIfReady() (called every frame) does the poof/advance,
      // so completion fires regardless of builder/enemy/conga gating.
      if (congaActive) return;
      if (buildBuiltCount >= buildQueue.length) return; // nothing left to build
      buildCurrentProgress += 1; // +1.0 progress = one full object, regardless of ramp
    }
  });

  /**
   * Change C: spawn a ranged-fire projectile from (fromNx,fromNy) toward a
   * snapshotted target (toNx,toNy). No-op unless the theme provides the
   * projectile asset (graceful fallback). Purely visual — no damage here.
   * @param {number} fromNx native x of the shooter
   * @param {number} fromNy native y of the shooter
   * @param {number} toNx snapshotted native x of the target
   * @param {number} toNy snapshotted native y of the target
   */
  function spawnProjectile(fromNx, fromNy, toNx, toNy) {
    if (!themeHasProjectile) return;
    // Raise both endpoints equally by a fraction of the walkable height so
    // the shot originates/lands at roughly gun (mid-character) height
    // instead of the feet/base — canvas y increases downward, so "up" is
    // a negative y offset. Raising both ends keeps the travel angle intact.
    const gunLift = PROJECTILE_GUN_HEIGHT_FRAC * walkableNativeH;
    activeProjectiles.push({
      fromNx: fromNx,
      fromNy: fromNy - gunLift,
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
    for (const en of activeEnemies) {
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
      // ── Change B: attack the NEAREST agent ──────────────────────────
      // Per-enemy attack/fire cadence timers (lazy-init; not per-frame spawn).
      if (typeof en.attackCooldown !== "number") en.attackCooldown = 0;
      if (typeof en.shotCooldown !== "number") en.shotCooldown = 0;
      en.attackCooldown -= delta;
      en.shotCooldown -= delta;

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
      let targetEnt = null, targetDist = Infinity;
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
          spawnProjectile(en.nx + enFacingSign * enMuzzleForward, en.ny, targetEnt.nx, targetEnt.ny);
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
    // Delta time for animation advancement (capped at 100ms to avoid jumps on tab focus)
    const delta = lastFrameTime === 0 ? 0 : Math.min((timestamp - lastFrameTime) / 1000, 0.1);
    lastFrameTime = timestamp;

    frame++;
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

      // Draw at the image's natural size, centered horizontally, TOP-anchored.
      // Top-anchoring keeps the background (and everything mapped to it) at a
      // fixed screen position: the metrics handlebar resizes the stage from its
      // bottom edge, so a top-anchored image never shifts when h changes.
      const bgW = themeBackgroundImg.naturalWidth * themeOverallScale;
      const bgH = themeBackgroundImg.naturalHeight * themeOverallScale;
      const bgX = Math.floor((w - bgW) / 2);
      const bgY = 0; // top-anchor → static regardless of handlebar / canvas height
      ctx.drawImage(themeBackgroundImg, bgX, bgY, bgW, bgH);
      // Boot-loader paint signal: this frame drew the real decoded background.
      bootFrameThemeBgDrawn = true;
    } else {
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
    lastAgentList = agentList; // expose to off-loop debug hotkeys

    // Rebirth (B2): track the high-water mark of concurrently-ACTIVE agents
    // this cycle, using the same isMetricsAgentActive() source of truth as
    // the metrics table/canvas (see its definition for why). Feeds the
    // AGENTS_ACTIVE badge trigger in updateBadgeUnlocks().
    let liveActiveAgentCount = 0;
    for (const a of agentList) {
      if (isMetricsAgentActive(a)) liveActiveAgentCount++;
    }
    cyclePeakActive = Math.max(cyclePeakActive, liveActiveAgentCount);

    // Prune stale entries from agentCharMap (agents no longer in metrics).
    const agentIds = new Set(agentList.map((a) => a.id));
    for (const id of Object.keys(agentCharMap)) {
      if (!agentIds.has(id)) delete agentCharMap[id];
    }

    // Resolve character sprite roster.
    const charIds = rosterOrder.length > 0 ? rosterOrder : Object.keys(themeImages);

    // Compute bg rect for native->canvas mapping (matches the draw above).
    const bgImgReady = themeLoaded && themeBackgroundImg && themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0;
    const bgW = bgImgReady ? themeBackgroundImg.naturalWidth  * themeOverallScale : w;
    const bgH = bgImgReady ? themeBackgroundImg.naturalHeight * themeOverallScale : h;
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
      updateEnemySpawning(delta, agentList);
      advanceEnemies(delta);
      updateConga(delta, agentList);
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
      // Ungated: completes the object once progress hits 1 (normal build OR the
      // F fast-forward hotkey), even if enemies/conga/no-builder paused the rate.
      completeBuildIfReady();
    }
    buildProgressBuilderCount = 0; // reset; re-armed by the agent loop below
    currentBuildContributors = []; // reset; re-populated by the agent loop below

    // ── Phase 2a: derive build state + advance per-object state machines ────
    const buildState = themeBuildables.length > 0 ? computeBuildState() : { builtIds: new Set(), activeId: null, activeProgress: 0 };
    // ── Ranged combat upgrade: unlock detection ──────────────────────────
    // Idempotent latch — once the rack object (build_order 0) is BUILT, all
    // characters permanently switch to ranged combat for the session.
    if (!rangedUnlocked && rackObjectId && buildState.builtIds.has(rackObjectId)) {
      rangedUnlocked = true;
    }
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
            buildCurrentProgress = 0;
          }
        }
      } else if (entry.phase === "idle" && entry.animState) {
        advanceObjectAnim(entry.animState, delta);
      }
    }
    // Resolve standoff target (native space) for active-build agents.
    const activeBuildPlacement = activeBuildObj ? objectPlacement[activeBuildObj.object_id] : null;
    // Standoff radius: an explicit per-object exclusion_radius (manifest)
    // wins; otherwise derive one from the object's OWN rendered size (same
    // 64 * effectiveObjScale baseSize formula drawBuildableObject uses,
    // converted from canvas px to native px) plus a small margin, so a
    // bigger-scaled object gets a proportionally bigger stand-back distance
    // instead of a flat guess that's too small for large objects (agents
    // overlapping it) or too large for small ones. Objects have NO collision
    // — this is purely a "stand a bit back" distance, not physics.
    const BUILD_STANDOFF_MARGIN_NATIVE = 8;
    const activeBuildExclusionR = (() => {
      if (!activeBuildObj) return 48;
      if (typeof activeBuildObj.exclusion_radius === "number" && activeBuildObj.exclusion_radius > 0) {
        return activeBuildObj.exclusion_radius;
      }
      const objBaseSizeCanvas = 64 * effectiveObjScale(activeBuildObj.object_id);
      const nativeScale = bgW > 0 ? (bgW / walkableNativeW) : 1;
      const objectRadiusNative = (objBaseSizeCanvas / 2) / nativeScale;
      return objectRadiusNative + BUILD_STANDOFF_MARGIN_NATIVE;
    })();
    let builderSideCounter = 0;

    agentList.forEach((agent, idx) => {
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
          // Conga-line state (assigned/cleared by updateConga).
          congaIndex: -1,
          // Sitting state (idle festivity, mirrors solo-dance system).
          sitting: false,
          sitSeatId: null,
          sitTimeLeft: 0,
          // Arrival-hysteresis latch shared by wander/build/combat/seat
          // movement (see WANDER_ARRIVED_EPS / WANDER_RESUME_EPS).
          settled: false,
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

      // ── EVICT combat targeting (Phase 2b) ────────────────────────────
      // While any enemy is alive, active agents STOP building/wandering and
      // instead engage the nearest alive enemy: walk to melee range, then
      // tick its hp down. This fully preempts the Phase 2a build block below
      // (isBuilding stays false so build standoff logic never runs).
      let isEngaging = false;
      let engageInRange = false;
      // A celebrating (dancing) agent pauses combat for the dance's duration.
      if (!inConga && !charEntry.dancing && isActive && enemiesAlive) {
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
                spawnProjectile(charEntry.nx + shooterFacingSign * shooterMuzzleForward, charEntry.ny, nearest.nx, nearest.ny);
              }
            }
            // Change 2: on defeat, transition to FLEEING (run off nearest edge)
            // rather than vanishing. A fleeing enemy is no longer a threat, so
            // agents drop it immediately (enemiesAlive / nearest search skip it).
            if (nearest.hp <= 0 && !nearest.fleeing) {
              nearest.hp = 0;
              nearest.fleeing = true;
              nearest.targetAgentId = null;
              // Celebration: the agent that landed the killing blow dances 5s.
              startAgentDance(charEntry);
              // Distances to each native edge; run out the nearest one.
              const dLeft = nearest.nx;
              const dRight = walkableNativeW - nearest.nx;
              const dTop = nearest.ny;
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

      // ── Sitting (idle festivity, mirrors solo-dance) ──────────────
      // A seated (or walking-to-seat) agent holds its seat until it either
      // finishes SIT_SECONDS or is preempted by going active / building /
      // engaging / conga. sitSeatId being set means "committed to a seat"
      // (either en route or already seated). When preempted, free the seat.
      if (charEntry.sitSeatId != null) {
        if (!idleAndStill) {
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
              charEntry.sitTimeLeft = SIT_SECONDS;
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

      // ── Wander logic (native polygon space) ───────────────────────
      // Dancing agents hold position (no wander). Conga members are driven
      // by updateConga's destination assignment above.
      if (!inConga) charEntry.wanderTimer -= delta;
      if (!inConga && !charEntry.dancing && charEntry.sitSeatId == null && !isBuilding && !isEngaging && charEntry.wanderTimer <= 0) {
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
        } else if (idleAndStill && !congaActive && themeDecor.length > 0 && Math.random() < SIT_CHANCE) {
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
          for (const d of themeDecor) {
            const sid = d.decor_id;
            const p = sid != null ? decorPlacement[sid] : null;
            if (p && p.sittable && seatOccupancy[sid] == null) {
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
      // STRICT RULE: a NON-active agent may only ever play walk / idle / sit /
      // dance. workerStateToClip can yield "build" (build/haul), "tool_idle"
      // (survey) or "cheer" (celebrate) from a worker record, but build & combat
      // are ACTIVE-ONLY. Clamp any active-only clip down to walk/idle here so no
      // downstream branch can surface it for an inactive agent. (isBuilding /
      // isEngaging are already gated on isActive, so the build/melee/shoot
      // overrides below can never fire when !isActive; sit/dance overrides come
      // after and remain valid for inactive agents.)
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
      if (isBuilding && !isMoving) {
        desiredClip = "build";
      }
      // EVICT override (Phase 2b): walking toward an enemy uses "walk"
      // (already covered by isMoving above); once in melee range, force the
      // melee clip — takes priority over the build override since isBuilding
      // is never true while isEngaging is true.
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

    // ── Agent separation pass (second pass, after all base nx/ny updates
    // above are settled for this frame) ────────────────────────────────
    // Non-seated agents push apart when closer than MIN_AGENT_SEP_NATIVE so
    // they never visually overlap while wandering/roaming. Seated agents
    // (sitSeatId != null) are excluded on both sides: they never move (stay
    // pinned to their seat) and never push a neighbor out of the way.
    {
      const sepList = [];
      for (const agent of agentList) {
        const ent = agentCharMap[agent.id];
        if (ent && ent.sitSeatId == null) sepList.push(ent);
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
          b.nx += ux * push; b.ny += uy * push;
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
    for (const agent of agentList) {
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
      let placement = decorPlacement[decorId];
      if (!placement) {
        // Edit-Stage show-all: synthesize a display-only fallback placement so
        // hidden/unplaced decor is visible + selectable for placing/scaling.
        // Not persisted (moving it writes a real anchor override → un-hides).
        if (editStageMode && stageShowAllObjects) placement = decorFallbackPlacement(decor, di);
        else continue;
      }
      const dAnim = decorAnimMap[decorId];
      if (dAnim) {
        const dSlots = themeImages["decor_" + decorId];
        advanceDecorAnim(dAnim, delta, dSlots ? dSlots.length : 1);
      }
      depthList.push({ kind: "decor", decor, ny: placement.ny, placement });
    }
    depthList.sort((a, b) => a.ny - b.ny);

    depthList.forEach((item) => {
      if (item.kind === "decor") {
        const placement = item.placement || decorPlacement[item.decor.decor_id];
        if (!placement) return;
        const canvasPt = nativeToCanvas(placement.nx, placement.ny, bgX, bgY, bgW, bgH);
        const tDepth = Math.max(0, Math.min(1, (item.ny - polyMinY) / polyRangeY));
        const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale;
        drawDecor(item.decor, canvasPt[0], canvasPt[1], depthScale);
        return;
      }

      if (item.kind === "object") {
        const canvasPt = nativeToCanvas(objectPlacement[item.obj.object_id].nx, objectPlacement[item.obj.object_id].ny, bgX, bgY, bgW, bgH);
        const tDepth = Math.max(0, Math.min(1, (item.ny - polyMinY) / polyRangeY));
        const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale;
        drawBuildableObject(item.obj, item.entry, canvasPt[0], canvasPt[1], depthScale);
        return;
      }

      if (item.kind === "enemy") {
        const en = item.enemy;
        const canvasPt = nativeToCanvas(en.nx, en.ny, bgX, bgY, bgW, bgH);
        const ecx = canvasPt[0], ecy = canvasPt[1];
        const tDepth = Math.max(0, Math.min(1, (en.ny - polyMinY) / polyRangeY));
        const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale;
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
        // HP bar above the enemy.
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
        return;
      }

      const agent = item.agent;
      const idx = agentList.indexOf(agent);
      const charEntry = agentCharMap[agent.id];
      if (!charEntry) return;

      const worker = state.workers[agent.id] || null;
      const desiredClip = charEntry.animState ? charEntry.animState.action : "idle";
      const anim = charEntry.animState;

      const cx = charEntry.x;
      const cy = charEntry.y;

      // Depth scale: agents further back (small native Y) draw slightly smaller.
      const tDepth = Math.max(0, Math.min(1, (charEntry.ny - polyMinY) / polyRangeY));
      const depthScale = (0.8 + tDepth * 0.3) * themeOverallScale; // 0.8 (back) → 1.1 (front), ×overall

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
          // Seat-scale raise: a scaled-up chair's seat surface rises with its
          // sprite, so lift the seated character in proportion to the chair's
          // EXTRA scale (0 at scale 1 = current correct behavior). Computed from
          // the CHAIR'S OWN geometry (its ny → chairDepth, its effectiveDecorScale)
          // so it tracks the chair's rendered seat surface exactly rather than
          // approximating with the character's depth. drawDecor draws the chair
          // foot-anchored at size 64 * chairDepth * chairScale, so its extra
          // height vs scale 1 is (chairScale - 1) * 64 * chairDepth, and the seat
          // surface sits SEAT_RAISE_FRAC up that height. Guarded: a missing chair
          // placement or non-numeric scale falls back to the character-depth
          // approximation so nothing throws.
          let seatRaise = 0;
          if (isSeatedForDraw && charEntry.seatDecorId != null) {
            const chair = decorPlacement[charEntry.seatDecorId];
            const chairScale = effectiveDecorScale(charEntry.seatDecorId);
            if (chair && typeof chairScale === "number") {
              // Chair depth from ITS OWN ny — identical formula to drawDecor's
              // caller (see the decor draw at the depthScale calc below).
              const chairTDepth = Math.max(0, Math.min(1, (chair.ny - polyMinY) / polyRangeY));
              const chairDepth = (0.8 + chairTDepth * 0.3) * themeOverallScale;
              seatRaise = SEAT_RAISE_FRAC * (chairScale - 1) * 64 * chairDepth;
            } else if (typeof chairScale === "number") {
              // Fallback: approximate with the character's own depthScale.
              seatRaise = SEAT_RAISE_FRAC * (chairScale - 1) * 64 * depthScale;
            }
          }
          const drawX = cx - spriteSize / 2 + seatNudge;
          const drawY = cy - spriteSize - seatRaise; // feet at cy, raised for chair scale

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
          const labelWords = label.split(/\s+/).filter(function (wd) { return wd.length > 0; });
          const labelLines = [];
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
          const labelLineH = labelFont + 1;
          const labelY = cy + Math.round(14 * depthScale);
          // Widest line drives the active-light offset.
          let widestLineW = 0;
          for (let li = 0; li < labelLines.length; li++) {
            const lw = ctx.measureText(labelLines[li]).width;
            if (lw > widestLineW) widestLineW = lw;
          }
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
            ctx.save();
            ctx.shadowColor = "#39ff14";
            ctx.shadowBlur = 5;
            ctx.fillStyle = "#39ff14";
            ctx.beginPath();
            ctx.arc(lightX, lightY, lightR, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
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
        const projScale = (0.8 + tDepth * 0.3) * themeOverallScale;
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
    if (editStageMode && themeLoaded && walkablePolygon && walkablePolygon.length > 2) {
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
