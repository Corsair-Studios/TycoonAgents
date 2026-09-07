// Part: 10-modals-badges-rebirth
// Theme switch/reset confirm modals, badge HUD persistence, trophy/badge rendering, rebirth flow and panel.
  function closeThemeSwitchConfirmModal() {
    if (themeSwitchConfirmModalEl) themeSwitchConfirmModalEl.setAttribute("hidden", "");
  }

  function buildThemeSwitchConfirmModal() {
    if (themeSwitchConfirmModalEl) return;

    const modal = document.createElement("div");
    modal.id = "theme-switch-confirm-modal";
    modal.setAttribute("hidden", "");

    const backdrop = document.createElement("div");
    backdrop.id = "theme-switch-confirm-backdrop";
    backdrop.addEventListener("click", () => {
      closeThemeSwitchConfirmModal();
      selectedThemeId = themeSwitchConfirmPreviousId;
      renderThemesList(lastThemesList);
    });
    modal.appendChild(backdrop);

    const dialog = document.createElement("div");
    dialog.id = "theme-switch-confirm-dialog";

    const title = document.createElement("div");
    title.id = "theme-switch-confirm-title";
    title.textContent = "Switch theme?";
    dialog.appendChild(title);

    themeSwitchConfirmMessageEl = document.createElement("p");
    themeSwitchConfirmMessageEl.id = "theme-switch-confirm-message";
    dialog.appendChild(themeSwitchConfirmMessageEl);

    const actions = document.createElement("div");
    actions.className = "reset-confirm-actions";

    themeSwitchConfirmCancelBtn = document.createElement("button");
    themeSwitchConfirmCancelBtn.type = "button";
    themeSwitchConfirmCancelBtn.className = "skill-btn settings-btn";
    themeSwitchConfirmCancelBtn.textContent = "Cancel";
    themeSwitchConfirmCancelBtn.addEventListener("click", () => {
      closeThemeSwitchConfirmModal();
      // Revert the optimistic highlight set by the theme-picker click
      // handler back to the theme that's still actually loaded.
      selectedThemeId = themeSwitchConfirmPreviousId;
      renderThemesList(lastThemesList);
    });
    actions.appendChild(themeSwitchConfirmCancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "skill-btn settings-btn danger-btn";
    confirmBtn.textContent = "Switch theme";
    confirmBtn.addEventListener("click", () => {
      closeThemeSwitchConfirmModal();
      vscode.postMessage({ type: "SELECT_THEME_CONFIRMED", payload: { theme_id: pendingThemeSwitchTargetId } });
    });
    actions.appendChild(confirmBtn);

    dialog.appendChild(actions);
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    themeSwitchConfirmModalEl = modal;
  }

  /** Target theme id the pending confirm modal would switch to, if confirmed. */
  let pendingThemeSwitchTargetId = "";

  // ── Remove-agent confirm modal (Agents screen card footer) — same
  // backdrop/dialog/title/message/Cancel-Confirm shape as
  // buildThemeSwitchConfirmModal above, reused for a different destructive
  // action (removeAgent) since window.confirm isn't available in webviews. ──
  let removeAgentConfirmModalEl = null;
  let removeAgentConfirmMessageEl = null;
  let removeAgentConfirmTitleEl = null;
  let pendingRemoveAgentId = "";
  let pendingRemoveAgentOnConfirm = null;

  function closeRemoveAgentConfirmModal() {
    if (removeAgentConfirmModalEl) removeAgentConfirmModalEl.setAttribute("hidden", "");
  }

  function buildRemoveAgentConfirmModal() {
    if (removeAgentConfirmModalEl) return;

    const modal = document.createElement("div");
    modal.id = "remove-agent-confirm-modal";
    modal.setAttribute("hidden", "");

    const backdrop = document.createElement("div");
    backdrop.id = "remove-agent-confirm-backdrop";
    backdrop.addEventListener("click", closeRemoveAgentConfirmModal);
    modal.appendChild(backdrop);

    const dialog = document.createElement("div");
    dialog.id = "remove-agent-confirm-dialog";

    removeAgentConfirmTitleEl = document.createElement("div");
    removeAgentConfirmTitleEl.id = "remove-agent-confirm-title";
    dialog.appendChild(removeAgentConfirmTitleEl);

    removeAgentConfirmMessageEl = document.createElement("p");
    removeAgentConfirmMessageEl.id = "remove-agent-confirm-message";
    dialog.appendChild(removeAgentConfirmMessageEl);

    const actions = document.createElement("div");
    actions.className = "reset-confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "skill-btn settings-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeRemoveAgentConfirmModal);
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "skill-btn settings-btn danger-btn";
    confirmBtn.textContent = "Remove";
    confirmBtn.addEventListener("click", () => {
      closeRemoveAgentConfirmModal();
      if (typeof pendingRemoveAgentOnConfirm === "function") pendingRemoveAgentOnConfirm();
    });
    actions.appendChild(confirmBtn);

    dialog.appendChild(actions);
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    removeAgentConfirmModalEl = modal;
  }

  /**
   * Open the remove-agent confirm modal. `onConfirm` is called (and only
   * called) if the user clicks Confirm — the caller is responsible for
   * posting removeAgent.
   */
  function openRemoveAgentConfirmModal(agentId, agentName, onConfirm) {
    buildRemoveAgentConfirmModal();
    pendingRemoveAgentId = agentId;
    pendingRemoveAgentOnConfirm = onConfirm;
    removeAgentConfirmTitleEl.textContent = `Remove ${agentName || agentId}?`;
    removeAgentConfirmMessageEl.textContent =
      `This deletes ${agentName || agentId}'s agent file and its routing entry from this project. This can't be undone from here.`;
    removeAgentConfirmModalEl.removeAttribute("hidden");
  }

  /**
   * Show the in-panel "switch theme" confirmation. Called when the host
   * responds to SELECT_THEME with CONFIRM_THEME_SWITCH instead of switching
   * immediately. Mirrors the wording the host's showWarningMessage used to
   * show (see the removed inline confirm in panel.ts's MSG.SELECT_THEME
   * handler).
   * @param {{targetThemeId: string, targetName: string, previousThemeId: string, previousName: string, previousBadgeCount: number}} info
   */
  function showThemeSwitchConfirmModal(info) {
    buildThemeSwitchConfirmModal();
    if (!themeSwitchConfirmModalEl || !themeSwitchConfirmMessageEl) return;
    pendingThemeSwitchTargetId = info.targetThemeId;
    themeSwitchConfirmPreviousId = info.previousThemeId;
    themeSwitchConfirmMessageEl.textContent =
      `Switching to "${info.targetName}". Each theme tracks its own badges — it starts fresh here. ` +
      `Your "${info.previousName}" progress (${info.previousBadgeCount} badges) is saved and comes back when you switch to it again.`;
    themeSwitchConfirmModalEl.removeAttribute("hidden");
    try {
      if (themeSwitchConfirmCancelBtn) themeSwitchConfirmCancelBtn.focus();
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
  /**
   * Compute the pool of badge ids eligible to be drawn as the NEXT rebirth
   * requirement: this theme's badges, minus REBIRTH_EXCLUDED_BADGE_IDS,
   * restricted to the tier pool matching the current rebirthCount when that
   * intersection is non-empty (falls back to the full excluded-filtered set
   * so rebirth never becomes impossible if the theme has none of the tier's
   * pool badges). Applying the exclusion BEFORE the tier restriction means
   * it covers both the tier-restricted branch and the fallback branch.
   * Shared by rollRebirthRequirement() and the save-restore heal path in
   * the THEME_INITIALIZED handler so both draw from identical rules.
   */
  function eligibleRebirthPool() {
    const ids = (themeBadges || []).map((b) => b && b.badge_id).filter(Boolean)
      .filter((id) => REBIRTH_EXCLUDED_BADGE_IDS.indexOf(id) < 0);
    const tierPool = rebirthTierPool(rebirthCount);
    const restricted = ids.filter((id) => tierPool.indexOf(id) >= 0);
    return (restricted.length > 0 ? restricted : ids).slice();
  }

  function rollRebirthRequirement() {
    const pool = eligibleRebirthPool();
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
   * from the tier matching the new rebirthCount, and persist. Also wipes the
   * player's BUILT OBJECTS back to zero (buildBuiltCount/buildCurrentProgress
   * + the per-object animation/phase map) so the board has to be rebuilt from
   * scratch every cycle — "that's just the nature of a rebirth." This does
   * NOT touch rivalsEvictedCount/agent metrics/HUD, which stay lifetime, and
   * it does NOT touch buildQueue membership or rebirth-earned PERMANENT
   * unlocks (rack/turret availability, rangedPermanentlyUnlocked, and every
   * rebirthCount-gated cosmetic ladder reward) — only the "how much of the
   * queue is already built" pointer resets, not what's unlocked.
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
    // p3-t1: turret-flagged objects are withheld from buildQueue until
    // rebirthCount reaches TURRET_UNLOCK_REBIRTH (see buildSeededQueue). The
    // instant that threshold is first crossed, PUSH every turret's
    // object_id onto the END of the LIVE queue as an UNBUILT object so it
    // turns buildable immediately, no reload needed. CRITICAL: this must
    // append at the end (NOT splice at buildBuiltCount+1 like the rack) —
    // buildSeededQueue always appends unlocked turrets at the very end of
    // its returned queue (a position that never disturbs the non-turret
    // built/unbuilt boundary on reload); splicing mid-queue here would put
    // the live-crossed turret at a DIFFERENT index than a reload would
    // recompute, corrupting buildBuiltCount's meaning the next time the
    // theme loads. Gated to the exact crossing (===, not >=) so later
    // rebirths don't re-run this walk; the indexOf guard also makes it
    // safe/idempotent if it ever did (no double-insert/no double-append).
    if (rebirthCount === TURRET_UNLOCK_REBIRTH) {
      themeBuildables.forEach((obj) => {
        if (obj.is_turret === true && buildQueue.indexOf(obj.object_id) === -1) {
          buildQueue.push(obj.object_id);
        }
      });
    }
    // buildBuiltCount is being wiped to 0 a few lines below, so the baseline's
    // `built` component must be consistent with that (0), not the pre-wipe
    // value — otherwise updateBadgeUnlocks()-style (eff = lifetime - baseline)
    // math would go negative. In practice `rebirthBaseline.built` is a
    // write-only field today (nothing subtracts it; OBJECTS_BUILT badge
    // progress reads cycleObjectsBuilt instead, and THEME_INITIALIZED always
    // re-zeroes it on load — see ~L9930), but keep it truthful anyway.
    rebirthBaseline = { built: 0, evicted: rivalsEvictedCount, tasks: (state.completedTasks || 0) };
    cycleObjectsBuilt = 0;
    cycleRivalsEvicted = 0;
    cyclePeakActive = 0;
    unlockedBadgeIds = new Set([...unlockedBadgeIds].filter((id) => id.indexOf("rebirth_") === 0));
    rollRebirthRequirement();
    rebirthConfirmPending = false;
    persistRebirth();
    // Rebirth mid-ambient-quake preemption: if the panic activity (see the
    // "Quake panic" section near the quake engine) is running, end it BEFORE
    // starting the rebirth-profile shake below — a rebirth isn't a per-frame
    // event (unlike a rival spawning, see updateQuakePanic's own rival
    // preemption), so nothing else clears quakePanicActive for us. No fast
    // fade needed here (that's specifically for fading the ambient shake out
    // to silence): the rebirth-profile startQuake() call right below
    // immediately overwrites the envelope with the dramatic wipe shake
    // anyway, so there's nothing to fade — just stop driving agent movement.
    if (quakePanicActive) endQuakePanic();
    // Quake (render-only, see startQuake): snapshot the built-object
    // positions BEFORE the wipe below clears buildBuiltCount/objectAnimMap,
    // so the dust puffs land on the objects actually being wiped, then kick
    // off the REBIRTH-profile camera shake. Purely cosmetic — the state
    // mutation below stays exactly as instant as before; the shake+dust just
    // cover it visually and can never delay or alter it.
    startQuake("rebirth", capturedBuiltObjectPositions());
    // ── Wipe built objects: "a rebirth resets ... all of the objects the
    // player has built, and they have to build them all over again." Mirrors
    // the full-Reset path (see handleMetricsReset, ~L12659) for the
    // buildBuiltCount/buildCurrentProgress zeroing, but — unlike Reset —
    // leaves buildQueue, rebirthCount, rangedPermanentlyUnlocked, and every
    // other permanent unlock untouched (the rack/turret objects just queued
    // above stay queued; they simply aren't pre-built).
    //
    // objectAnimMap is also cleared here (not just left to the per-frame
    // status loop) because that loop only force-resets entries whose derived
    // status is "unbuilt"; the single object now sitting at buildQueue[0]
    // derives status "active", and the loop's active-branch only creates a
    // fresh crate anim when entry.phase was "unbuilt" — an entry left over
    // from being fully built (phase "idle") would never transition and would
    // keep rendering as already-built forever. Clearing the map here means
    // every entry is freshly created "unbuilt" next frame and transitions
    // correctly regardless of which index it lands on.
    buildBuiltCount = 0;
    buildCurrentProgress = 0;
    objectAnimMap = {};
    // Persist the wipe host-side (composite-keyed build-progress.json is a
    // plain overwrite — see panel.ts saveBuildProgress) so a reload restores
    // 0, not the pre-rebirth count.
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
    updateTrophyRow();
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
      if (sub) sub.textContent = (count === 1 ? "Weapons rack now buildable · " : "") + "Build speed +" + buildPct + "%";
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
    try {
      // Every on-scene agent dances for exactly REBIRTH_DANCE_SECONDS,
      // regardless of current activity — reuses startAgentDance (which
      // frees any seat first) then pins the duration to the fixed rebirth
      // length instead of its usual randomized 2-3s range.
      for (const id in agentCharMap) {
        const ce = agentCharMap[id];
        if (!ce) continue;
        startAgentDance(ce);
        ce.danceTimeLeft = REBIRTH_DANCE_SECONDS;
      }
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
      const defensePct = Math.round((Math.pow(1.1, rebirthCount) - 1) * 100);
      const bonus = document.createElement("div");
      bonus.className = "rebirth-bonus";
      bonus.textContent = `Ranged weapons · Build speed +${pct}% · Defense +${defensePct}%`;
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

    // Upcoming-unlock hint: show ONLY the single next tier the player
    // hasn't reached yet (lowest threshold strictly greater than
    // rebirthCount), not every future unlock at once. Same underlying
    // tiers/wording as before — weapons rack (real threshold is the literal
    // `>= 1` check in buildSeededQueue, only when the theme has a buildable
    // rack object), turret (TURRET_UNLOCK_REBIRTH, only when the theme
    // actually has a turret object), disco dance party
    // (DANCE_PARTY_UNLOCK_REBIRTH), dance-off (DANCE_OFF_UNLOCK_REBIRTH),
    // victory lap upgrade (VICTORY_LAP_UNLOCK_REBIRTH), gold palette
    // (GOLD_PALETTE_UNLOCK_REBIRTH) — just filtered down to one line. Past
    // the highest known tier there is nothing left to preview, so nothing
    // renders (no stale last-tier line, no placeholder).
    const rebirthUnlockPreviews = [];
    // Rack: buildSeededQueue withholds buildables[0] (rackObjectId) from the
    // build queue entirely until rebirthCount >= 1, at which point it splices
    // back in and becomes buildable — building it unlocks ranged weapons
    // (see the "Building this unlocks ranged weapons" tooltip ~line 2708).
    // There is no named RACK_UNLOCK_REBIRTH constant — buildSeededQueue's
    // gate is the literal `>= 1` at line ~5533 — so this mirrors that literal
    // rather than inventing a duplicate constant.
    if (rackObjectId) {
      rebirthUnlockPreviews.push({
        rebirth: 1,
        text: `Reach Rebirth 1 to unlock the buildable weapons rack and ranged weapons`,
      });
    }
    if (turretObjectIds.size > 0) {
      rebirthUnlockPreviews.push({
        rebirth: TURRET_UNLOCK_REBIRTH,
        text: `Reach Rebirth ${TURRET_UNLOCK_REBIRTH} to unlock a buildable defensive turret`,
      });
    }
    // Stand-up huddle (see updateHuddle, HUDDLE_UNLOCK_REBIRTH — gated at the
    // same rebirth tier as the turret above). Unlike the turret entry, this is
    // pure character-animation cosmetics with no buildable-object dependency,
    // so — per product ask — it ALWAYS renders regardless of theme contents:
    // Rebirth 2's preview line must never be empty.
    rebirthUnlockPreviews.push({
      rebirth: HUDDLE_UNLOCK_REBIRTH,
      text: `Reach Rebirth ${HUDDLE_UNLOCK_REBIRTH} to unlock team stand-up huddles`,
    });
    rebirthUnlockPreviews.push({
      rebirth: DANCE_PARTY_UNLOCK_REBIRTH,
      text: `Reach Rebirth ${DANCE_PARTY_UNLOCK_REBIRTH} to unlock the disco dance party`,
    });
    rebirthUnlockPreviews.push({
      rebirth: DANCE_OFF_UNLOCK_REBIRTH,
      text: `Reach Rebirth ${DANCE_OFF_UNLOCK_REBIRTH} to unlock the dance-off`,
    });
    // Whether a wave-clear victory lap fires at all is gated on a random
    // cadence (VICTORY_LAP_CLASH_INTERVAL/VICTORY_LAP_CHANCE), not on
    // rebirth — this tier preview only advertises the UPGRADE (see
    // VICTORY_LAP_UNLOCK_REBIRTH / updateVictoryLap), so the wording says
    // "upgrade" rather than "unlock".
    rebirthUnlockPreviews.push({
      rebirth: VICTORY_LAP_UNLOCK_REBIRTH,
      text: `Reach Rebirth ${VICTORY_LAP_UNLOCK_REBIRTH} to upgrade the victory lap with party lights and confetti`,
    });
    rebirthUnlockPreviews.push({
      rebirth: GOLD_PALETTE_UNLOCK_REBIRTH,
      text: `Reach Rebirth ${GOLD_PALETTE_UNLOCK_REBIRTH} to unlock the gold party palette`,
    });
    // Sparring exhibition (see updateSparring, SPARRING_UNLOCK_REBIRTH) —
    // moved to the gold-palette tier; the stand-up huddle above stays at its
    // own earlier tier via HUDDLE_UNLOCK_REBIRTH.
    rebirthUnlockPreviews.push({
      rebirth: SPARRING_UNLOCK_REBIRTH,
      text: `Reach Rebirth ${SPARRING_UNLOCK_REBIRTH} to unlock agent sparring exhibitions`,
    });

    const nextRebirthUnlock = rebirthUnlockPreviews
      .filter((p) => rebirthCount < p.rebirth)
      .sort((a, b) => a.rebirth - b.rebirth)[0];
    if (nextRebirthUnlock) {
      const nextUnlockHint = document.createElement("div");
      nextUnlockHint.className = "rebirth-bonus";
      nextUnlockHint.textContent = nextRebirthUnlock.text;
      panel.appendChild(nextUnlockHint);
    }

    // Concrete next-rebirth stat line: current → next build-speed AND
    // defense bonus, both derived live from the same compounding formulas
    // used for the current-bonus line above (~1915-1916) and gameplay (build
    // speed ~13784+, defense ~8347/16557) — never a hardcoded table. Unlike
    // the tier-gated unlock hint above, neither stat has a cap, so there is
    // always a next rebirth to preview and this renders unconditionally.
    const nextPct = Math.round((Math.pow(1.2, rebirthCount + 1) - 1) * 100);
    const currentPct = Math.round((Math.pow(1.2, rebirthCount) - 1) * 100);
    const nextDefensePct = Math.round((Math.pow(1.1, rebirthCount + 1) - 1) * 100);
    const currentDefensePct = Math.round((Math.pow(1.1, rebirthCount) - 1) * 100);
    const nextStatLine = document.createElement("div");
    nextStatLine.className = "rebirth-bonus";
    nextStatLine.textContent = `Next rebirth: build speed +${currentPct}% → +${nextPct}% · defense +${currentDefensePct}% → +${nextDefensePct}%`;
    panel.appendChild(nextStatLine);

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
  // One-line warning, inserted here (not in the static HTML owned by
  // panel.ts) because Install Hooks strips foreign hooks unconditionally
  // with no warning today. Placed as the button's very next sibling so the
  // CSS rule `#install-hooks-btn[hidden] + #install-hooks-warning` mirrors
  // whatever hidden/shown state the many call sites below already put the
  // button in — no need to touch each one individually. Shown unconditionally
  // (not gated on a foreign-hook count): the "installState" push this screen
  // renders from carries no such count, and inventing new host plumbing for
  // it is out of scope here.
  const installHooksWarningEl = document.createElement("p");
  installHooksWarningEl.id = "install-hooks-warning";
  installHooksWarningEl.className = "delegation-mode-footnote";
  installHooksWarningEl.textContent = "Removes other harnesses' hooks — only one can track a project.";
  installHooksBtn.insertAdjacentElement("afterend", installHooksWarningEl);
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

  /**
   * Legacy/foreign-harness leak notice — reacts to the host's
   * "legacyArtifactsDetected" push (sent once per panel load, only when
   * artifactCount or foreignHookCount is non-zero; see the message dispatch
   * below). Fixing is delegated entirely to the existing Hook Doctor flow
   * inside Settings (Troubleshoot & Fix / the foreign-hooks checkbox added
   * above) — this notice never duplicates that repair UI, it just opens it.
   */
  function showLegacyArtifactsNotice(artifactCount, foreignHookCount) {
    if (!artifactCount && !foreignHookCount) return; // nothing found — render nothing
    if ((vscode.getState() || {}).legacyArtifactsNoticeDismissed) return;
    if (document.getElementById("legacy-artifacts-notice")) return; // already up this load

    const notice = document.createElement("div");
    notice.id = "legacy-artifacts-notice";
    notice.className = "catalog-notice legacy-artifacts-notice";

    const text = document.createElement("span");
    text.className = "legacy-artifacts-notice-text";
    const fileWord = artifactCount === 1 ? "file" : "files";
    const hookWord = foreignHookCount === 1 ? "hook" : "hooks";
    text.textContent =
      `Found ${artifactCount} leftover ${fileWord} and ${foreignHookCount} foreign ${hookWord} from another harness.`;
    notice.appendChild(text);

    const fixBtn = document.createElement("button");
    fixBtn.className = "skill-btn settings-btn legacy-artifacts-notice-fix";
    fixBtn.textContent = "Open Hook Doctor";
    fixBtn.addEventListener("click", () => {
      dismissLegacyArtifactsNotice();
      menuSettingsBtn.click(); // same entry point the hamburger menu uses
    });
    notice.appendChild(fixBtn);

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "legacy-artifacts-notice-dismiss";
    dismissBtn.setAttribute("aria-label", "Dismiss");
    dismissBtn.textContent = "×";
    dismissBtn.addEventListener("click", () => dismissLegacyArtifactsNotice());
    notice.appendChild(dismissBtn);

    document.body.appendChild(notice);
  }

  /**
   * Session-scoped dismissal: written into the same vscode.getState()/
   * setState() blob used elsewhere in this file (e.g. activeMetricsTab,
   * badgeHudUnseen). Persists across webview hide/show and reload within
   * this VS Code session, cleared on a fresh session — no host-side
   * persistence invented for this.
   */
  function dismissLegacyArtifactsNotice() {
    const notice = document.getElementById("legacy-artifacts-notice");
    if (notice) notice.remove();
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, legacyArtifactsNoticeDismissed: true });
  }

  /**
   * Issue #25 — dismissible banner warning that the observed orchestrator
   * model is Sonnet or Haiku (never Opus/Fable/Unknown; see modelFamily,
   * ~line 13185, which returns "Opus"/"Sonnet"/"Haiku"/"Fable"/null).
   * Same fixed-overlay pattern as showLegacyArtifactsNotice/
   * dismissLegacyArtifactsNotice above — reused deliberately, not
   * reinvented. Dismissal is keyed BY MODEL FAMILY (not a bare boolean) so
   * switching away and back to a sub-Opus model, or switching to a
   * *different* sub-Opus model, re-surfaces the banner rather than being
   * silenced forever by one dismissal.
   * @param {"Opus"|"Sonnet"|"Haiku"|"Fable"|null} family
   */
  function showOrchestratorModelBanner(family) {
    const existing = document.getElementById("orchestrator-model-notice");
    if (existing) existing.remove(); // re-render clean each settings paint

    if (family !== "Sonnet" && family !== "Haiku") return; // opus/fable/unknown never warn

    const dismissedFamily = (vscode.getState() || {}).orchestratorModelNoticeDismissedFor;
    if (dismissedFamily === family) return;

    const notice = document.createElement("div");
    notice.id = "orchestrator-model-notice";
    notice.className = "catalog-notice orchestrator-model-notice";

    const text = document.createElement("span");
    text.className = "orchestrator-model-notice-text";
    text.textContent =
      `Orchestrator is running on ${family}. TycoonAgents expects Opus or above at the top so it can distill and delegate cheap work — Sonnet/Haiku here loses the savings. Run /model opus to fix.`;
    notice.appendChild(text);

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "orchestrator-model-notice-dismiss";
    dismissBtn.setAttribute("aria-label", "Dismiss");
    dismissBtn.textContent = "×";
    dismissBtn.addEventListener("click", () => dismissOrchestratorModelBanner(family));
    notice.appendChild(dismissBtn);

    document.body.appendChild(notice);
  }

  /**
   * Dismiss the orchestrator-model banner for the given model family. See
   * showOrchestratorModelBanner for why dismissal is keyed by family rather
   * than a single flag.
   * @param {"Sonnet"|"Haiku"} family
   */
  function dismissOrchestratorModelBanner(family) {
    const notice = document.getElementById("orchestrator-model-notice");
    if (notice) notice.remove();
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, orchestratorModelNoticeDismissedFor: family });
  }
  
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
  const themeImageModelEl   = /** @type {HTMLSelectElement} */ (document.getElementById("theme-image-model"));
  const themeImageQualityRow = /** @type {HTMLElement} */ (document.getElementById("theme-image-quality-row"));
  const themeImageQualityEl = /** @type {HTMLSelectElement} */ (document.getElementById("theme-image-quality"));
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
  /** @type {{gemini: Array<{id:string,label:string,note?:string}>, openai: Array<{id:string,label:string,note?:string}>}} */
  let themeImageModels = { gemini: [], openai: [] };
  /** @type {{gemini: string, openai: string}} Saved model id per provider ('' = Latest). */
  let themeImageSelectedModels = { gemini: "", openai: "" };
  /** @type {Array<{id:string,label:string,note?:string}>} OpenAI-only quality options ('low'|'medium'|'high'). */
  let themeImageQualityOptions = [];
  /** Saved OpenAI quality override ('' = medium/default). Gemini has no quality parameter. */
  let themeImageSelectedQuality = "";
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
  /** Per-frame regeneration (feedback #18): item.id -> Set of selected
   * frame_keys indices to keep from the next retry's freshly-generated
   * board. Persisted here (not in the DOM) so selections survive the
   * full-list re-render a retry triggers; cleared for an item once its retry
   * request is sent (see the retry button handler) so a finished retry
   * starts the next selection fresh. */
  const themeReviewSelectedFrameSlots = new Map();
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
  /** Setup Wizard Step 2 package checkbox list: ids the user currently has
   *  checked, persisted across re-renders of renderSetupOptionals (e.g. once
   *  the async "packs" catalog response lands) so a re-render never loses a
   *  user's tick/untick. Lazily initialized to {"uefn"} iff detected, else
   *  empty — see renderSetupOptionals. Reset to null on a fresh install so a
   *  later session starts from the auto-detect defaults again. */
  let setupPackageSelection = null;
  /** The `info` object passed to the most recent renderSetupOptionals call —
   *  cached so renderPacksList can re-invoke renderSetupOptionals with the
   *  same UEFN/foreign-block state once the async "packs" catalog response
   *  lands (see renderPacksList). Not read anywhere else. */
  let lastSetupOptionalsInfo = null;

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
      // showMain(), which hid the whole screen before renderSetupOptionals
      // — or any other optional action — ever had a chance to render.
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

  // ── Routing modal entry point ───────────────────────────────────────────
  // #menu-routing ships in panel.ts's static HTML template (both hosts serve
  // it) — bind to it directly, guarded, the same way menuThemesBtn is.
  // Factored into openRoutingModal() (p17-t4) so the Settings screen's
  // harness "needs a default route" hint can trigger the exact same
  // open sequence as the menu item, not a divergent copy.
  function openRoutingModal() {
    closeMenu();
    // Only one panel open at a time (2026-09-05 fix): if Settings (the
    // setup overlay) is showing — e.g. opened via the harness dropdown's
    // "Open Agents" link — hide it before the Agents modal opens, the
    // mirror of openSettingsFromAgents() closing the Agents modal below.
    showMain();
    ensureRoutingModal();
    // A stale suppression from a previous session's failed save must
    // never survive a close/reopen — the fresh getRouting reply below
    // is a deliberate resync, not the automatic post-failure re-push it
    // exists to guard against.
    routingSuppressNextRebuild = false;
    // Fresh open of the modal — any prior session's Override expansions no
    // longer apply (coordinator review fix: this reset must NOT also run on
    // every live "routing" repush while the modal stays open, see
    // handleRoutingPayload).
    routingExpandedAgents = {};
    renderRoutingModal();
    openModal(routingModalEl, routingCloseBtnEl);
    vscode.postMessage({ type: ROUTING_MSG.GET });
  }
  var menuRoutingBtn = document.getElementById("menu-routing");
  if (menuRoutingBtn) {
    menuRoutingBtn.addEventListener("click", () => {
      openRoutingModal();
    });
  }

  // Closes the Agents modal and opens Settings — same sequence as the
  // hamburger menu's Settings item (menuSettingsBtn above), reused by the
  // Agents header's "Change in Settings" link (2026-09-05: harness question
  // lives only in Settings; the Agents screen just links there).
  function openSettingsFromAgents() {
    closeModal(routingModalEl);
    removeSetupOptionalsNodes();
    setupStage = "done";
    openedFromSettings = true;
    showSetup();
    vscode.postMessage({ type: "checkInstall" });
    vscode.postMessage({ type: "getSettings" });
  }

  /**
   * Read-only harness line atop the Agents screen content
   * (2026-09-05 decision): "Runs on Claude Code" / "Runs on OpenCode" plus a
   * link-button back to Settings, where the actual harness dropdown
   * (buildHarnessControl) lives. Replaces the old buildHarnessControl mount
   * that used to duplicate the dropdown here.
   */
  function buildAgentsHarnessLine(harnessEffective) {
    if (!lastSettings || !lastSettings.harness) return null;
    var harnessOptions = Array.isArray(lastSettings.harness.options)
      ? lastSettings.harness.options
      : [
          { id: "claude-code", label: "Claude Code" },
          { id: "opencode", label: "OpenCode" },
        ];
    var match = harnessOptions.find(function (opt) { return opt.id === harnessEffective; });
    var harnessLabel = match ? match.label : (harnessEffective === "opencode" ? "OpenCode" : "Claude Code");
    var line = document.createElement("p");
    line.className = "routing-agents-harness-line";
    line.textContent = "Runs on " + harnessLabel + " · ";
    var changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "routing-inline-link-btn routing-agents-harness-change-btn";
    changeBtn.textContent = "Change in Settings";
    changeBtn.addEventListener("click", function () {
      openSettingsFromAgents();
    });
    line.appendChild(changeBtn);
    return line;
  }

  if (themesFooterCloseBtn) {
    themesFooterCloseBtn.addEventListener("click", () => closeModal(themesModalEl));
  }

  // ── UEFN / Verse modal (Path Health, split out of Settings) ────────
  const menuUefnBtn      = /** @type {HTMLElement} */ (document.getElementById("menu-uefn"));
  const uefnModalEl      = /** @type {HTMLElement} */ (document.getElementById("uefn-modal"));
  const uefnBackdrop     = /** @type {HTMLElement} */ (document.getElementById("uefn-backdrop"));
  const uefnModalCloseBtn = /** @type {HTMLElement} */ (document.getElementById("uefn-modal-close"));

  if (menuUefnBtn) {
    menuUefnBtn.addEventListener("click", () => {
      closeMenu();
      // openUefnModal() (defined below, hoisted) re-renders the body then
      // opens — renderUefnModalBody() also runs on every installState/
      // settings push (see the message dispatch below) so it stays live
      // while open, but a fresh render on open covers the case where those
      // pushes haven't happened yet this panel session. Shared with the
      // Settings "UEFN health" summary button (buildUefnHealthSummaryRow)
      // so both entry points open the modal identically.
      openUefnModal();
    });
  }

  if (uefnModalCloseBtn) {
    uefnModalCloseBtn.addEventListener("click", () => closeModal(uefnModalEl));
  }

  if (uefnBackdrop) {
    uefnBackdrop.addEventListener("click", () => closeModal(uefnModalEl));
  }

  // ── Feedback modal (Submit feedback, split out of Settings) ────────
  const menuFeedbackBtn      = /** @type {HTMLElement} */ (document.getElementById("menu-feedback"));
  const feedbackModalEl      = /** @type {HTMLElement} */ (document.getElementById("feedback-modal"));
  const feedbackModalBackdrop = /** @type {HTMLElement} */ (document.getElementById("feedback-backdrop"));
  const feedbackModalCloseBtn = /** @type {HTMLElement} */ (document.getElementById("feedback-modal-close"));

  if (menuFeedbackBtn) {
    menuFeedbackBtn.addEventListener("click", () => {
      closeMenu();
      // The feedback form is static (doesn't read lastSettings), so a
      // single render on open is enough to keep it fresh — see
      // renderFeedbackModalBody()'s doc comment for why this differs from
      // renderUefnModalBody() above.
      renderFeedbackModalBody();
      openModal(feedbackModalEl, feedbackModalCloseBtn);
    });
  }

  if (feedbackModalCloseBtn) {
    feedbackModalCloseBtn.addEventListener("click", () => closeModal(feedbackModalEl));
  }

  if (feedbackModalBackdrop) {
    feedbackModalBackdrop.addEventListener("click", () => closeModal(feedbackModalEl));
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

  /**
   * Rebuild the #theme-image-model options for the given provider from the
   * last-received IMAGE_MODELS list, then select the saved override (or
   * "Latest" when unset). textContent-safe: uses the Option constructor, no
   * innerHTML with server/config-derived data.
   * @param {string} provider
   */
  function populateModelSelect(provider) {
    if (!themeImageModelEl) return;
    themeImageModelEl.textContent = "";
    themeImageModelEl.appendChild(new Option("Latest (recommended)", ""));
    const options = themeImageModels[provider] || [];
    for (const model of options) {
      if (!model || !model.id) continue;
      const text = model.note ? model.label + " — " + model.note : model.label;
      themeImageModelEl.appendChild(new Option(text, model.id));
    }
    themeImageModelEl.value = themeImageSelectedModels[provider] || "";
  }

  /**
   * Rebuild the #theme-image-quality options from the last-received
   * IMAGE_QUALITY_OPTIONS list and select the saved override (or "Default"
   * when unset), same construction style as populateModelSelect. OpenAI
   * only — Gemini has no `quality` parameter, so the whole row is hidden
   * for that provider instead of being populated empty.
   * @param {string} provider
   */
  function populateQualitySelect(provider) {
    if (themeImageQualityRow) themeImageQualityRow.hidden = provider !== "openai";
    if (!themeImageQualityEl) return;
    if (provider !== "openai") return;
    themeImageQualityEl.textContent = "";
    themeImageQualityEl.appendChild(new Option("Default (medium)", ""));
    for (const quality of themeImageQualityOptions) {
      if (!quality || !quality.id) continue;
      const text = quality.note ? quality.label + " — " + quality.note : quality.label;
      themeImageQualityEl.appendChild(new Option(text, quality.id));
    }
    themeImageQualityEl.value = themeImageSelectedQuality || "";
  }

  if (themeImageProvider) {
    themeImageProvider.addEventListener("change", () => {
      updateThemeApiKeyUi("", false);
      populateModelSelect(selectedThemeImageProvider());
      populateQualitySelect(selectedThemeImageProvider());
      vscode.postMessage({
        type: 'SET_THEME_IMAGE_PREFERENCE',
        payload: {
          provider: selectedThemeImageProvider(),
          model: themeImageModelEl ? themeImageModelEl.value : "",
          quality: themeImageQualityEl ? themeImageQualityEl.value : "",
        },
      });
    });
  }

  if (themeImageModelEl) {
    themeImageModelEl.addEventListener("change", () => {
      vscode.postMessage({
        type: 'SET_THEME_IMAGE_PREFERENCE',
        payload: {
          provider: selectedThemeImageProvider(),
          model: themeImageModelEl.value,
          quality: themeImageQualityEl ? themeImageQualityEl.value : "",
        },
      });
    });
  }

  if (themeImageQualityEl) {
    themeImageQualityEl.addEventListener("change", () => {
      vscode.postMessage({
        type: 'SET_THEME_IMAGE_PREFERENCE',
        payload: {
          provider: selectedThemeImageProvider(),
          model: themeImageModelEl ? themeImageModelEl.value : "",
          quality: themeImageQualityEl.value,
        },
      });
    });
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
        payload: {
          provider,
          api_key: apiKey,
          model: themeImageModelEl ? themeImageModelEl.value : "",
          quality: themeImageQualityEl ? themeImageQualityEl.value : "",
        },
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
