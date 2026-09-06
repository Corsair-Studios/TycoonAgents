// Part: 110-hud-canvas-draw
// HUD drawing and canvas/stage draw routines.
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
   * @param {number} agentCount live sceneAgentList.length (incl. orchestrator)
   *   at the moment the wave spawns. The wave is capped at
   *   min(themeRivals.length, agentCount) so a raid can never field more
   *   rivals than the player currently has agents to answer it (0 agents ->
   *   0 rivals spawn). Read live per call, never cached, so growing the
   *   roster raises the cap on the next wave.
   */
  function spawnEnemyWave(agentCount) {
    if (!themeRivals || themeRivals.length === 0) return;
    const rivalMax = themeRivals.length;
    const cap = Math.max(0, Math.min(rivalMax, agentCount || 0));
    if (cap === 0) return;
    let toSpawn;
    if (enemyCountMode === "all") {
      toSpawn = themeRivals.slice(0, cap);
    } else {
      const n = 1 + Math.floor(Math.random() * rivalMax);
      const shuffled = themeRivals.slice().sort(() => Math.random() - 0.5);
      toSpawn = shuffled.slice(0, Math.min(n, cap));
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
      spawnEnemyWave(Array.isArray(agentList) ? agentList.length : 0);
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
   * Shared ease-in/hold/ease-out formula for the party visual layer
   * (partyVisualIntensity), fed by whichever party type is currently active
   * — updateConga and updateDiscoParty each call this against their own
   * timeLeft/totalSeconds pair instead of keeping independent copies of the
   * formula, so a future tuning change (e.g. DISCO_EASE_SECONDS) can never
   * silently apply to only one party type. Pure function, no side effects.
   * @param {number} timeLeft seconds remaining in the current party
   * @param {number} totalSeconds the party's full duration
   * @returns {number} clamped 0..1 eased intensity
   */
  function partyEaseIntensity(timeLeft, totalSeconds) {
    const elapsed = totalSeconds - timeLeft;
    const inT = Math.min(1, elapsed / DISCO_EASE_SECONDS);
    const outT = Math.min(1, timeLeft / DISCO_EASE_SECONDS);
    return Math.max(0, Math.min(inT, outT));
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
      // Rivals end the conga immediately — same product rule as the disco
      // party ("if rivals arrive, the party is over"), and a conga IS a
      // party. Checked first, before any timer/cheer math, and BEFORE the
      // per-character loop runs later this same frame, so the live-derived
      // `inConga` (congaActive && congaIndex>=0) already reads false by the
      // time that frame's combat gate (!inConga && !dancing) is evaluated —
      // agents re-engage on the same frame the rival appears. Mirrors
      // cancelDiscoParty's ordering exactly.
      if (activeEnemies.length > 0) {
        endConga();
        return;
      }
      // Belt-and-braces: a disco party or dance-off must never start during
      // a conga (both of their own start gates already refuse to fire while
      // congaActive is true, and updateConga runs first in render() so a
      // same-frame race can't slip through) — but if that ever fails, end
      // the conga immediately rather than let two systems both drive
      // charEntry.dancing/animation this frame. Mirrors updateDiscoParty's
      // congaActive check and updateDanceOff's congaActive/discoPartyActive
      // check exactly, so all three party systems now defend symmetrically.
      if (discoPartyActive || danceOffActive) {
        endConga();
        return;
      }
      congaTimeLeft -= delta;
      // Shared lighting/ball intensity — same partyEaseIntensity helper
      // updateDiscoParty uses for discoPartyTimeLeft, applied here against
      // congaTimeLeft/CONGA_SECONDS instead. Derived from congaTimeLeft
      // (already ticking down by delta above) rather than a new timer, so
      // there's nothing new to drift out of sync. On natural end this has
      // already eased to ~0 by the time congaTimeLeft<=0 below fires
      // endConga(); the rival-cancel branch above skips straight to
      // endConga() before this ever runs, so it snaps instead of easing —
      // see endConga's explicit zero-set.
      partyVisualIntensity = partyEaseIntensity(congaTimeLeft, CONGA_SECONDS);
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
      if (congaTimeLeft <= 0) endConga();
      return;
    }

    congaCheckTimer += delta;
    if (congaCheckTimer < CONGA_CHECK_SECONDS) return;
    congaCheckTimer = 0;
    // A conga, a disco party, and a dance-off must never own character
    // animation state simultaneously — all three now carry the identical
    // belt-and-braces shape: each active branch checks the OTHER two's
    // active flags and ends itself cleanly if either is somehow true (see
    // this function's own congaActive-branch check above, updateDiscoParty's
    // congaActive/danceOffActive check, and updateDanceOff's
    // congaActive/discoPartyActive check). The victoryLapActive check added
    // below is the same idea applied to the newer fourth system — see
    // updateVictoryLap.
    if (agentList.length < 3 || activeEnemies.length > 0 || congaCooldown > 0 || discoPartyActive || danceOffActive || victoryLapActive || quakePanicActive) return;
    if (Math.random() >= CONGA_CHANCE) return;

    startConga(agentList);
  }

  /**
   * End the conga line — shared by the natural end-of-run path (timer
   * elapsed) and the rival-arrival cancel path above. Clears EVERY
   * congaIndex write site (the natural-end block used to do this inline;
   * factored out here so both paths use the identical, audited clear) so
   * the live-derived `inConga` can never see a stale index survive into a
   * future conga, and resets the shared line state + cooldown.
   */
  function endConga() {
    congaActive = false;
    congaTimeLeft = 0;
    congaCheerTimer = 0;
    congaCheerHold = 0;
    congaCooldown = CONGA_COOLDOWN_SECONDS;
    // Snap the shared lighting/ball intensity to 0. On a natural end this is
    // redundant (the ease math above already drove it to ~0 by the time
    // congaTimeLeft<=0), but on the rival-cancel path (called BEFORE any
    // ease math runs this frame — see the activeEnemies branch above) this
    // is the actual instant snap-off, matching cancelDiscoParty's rule that
    // the abruptness on a rival arrival is the point.
    partyVisualIntensity = 0;
    for (const id of Object.keys(agentCharMap)) {
      const e = agentCharMap[id];
      if (!e) continue;
      e.congaIndex = -1;
      e.dancing = false;
      e.danceTimeLeft = 0;
    }
    congaOrder = [];
    congaWaypoints = [];
    congaWaypointIdx = 0;
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
      // force=true: a rare, deliberate whole-cast celebration (like the
      // disco party) — must not be silently skipped just because this agent
      // bubbled recently for an unrelated ambient reason, and must not block
      // a re-press a few seconds later either (see showExpression's force doc).
      showExpression(e, 5, 1.8, true); // music bubble, coincides with conga start
      e.dancing = false;
      e.danceTimeLeft = 0;
      freeAgentSeat(e);
    }
    congaActive = true;
    congaTimeLeft = CONGA_SECONDS;
    congaCheerTimer = CONGA_CHEER_INTERVAL;
    congaCheerHold = 0;
    // Shared lighting/ball state (see partyVisualIntensity's declaration) —
    // same start pattern startDiscoParty uses, so drawDiscoOverlay/
    // drawDiscoBall pick up the conga for free with no code changes there.
    partyVisualStartMs = nowMs();
    if (goldPalettePreviewActive) {
      // Handoff (Alt+P preview was mid-ride): end the preview's own
      // bookkeeping but deliberately keep the CURRENT partyVisualIntensity as
      // this conga's starting point, so the real party's ease-in continues
      // smoothly instead of snapping to black first — see
      // handOffGoldPalettePreviewToParty's doc. No preview running: unchanged
      // zero-start behaviour below.
      handOffGoldPalettePreviewToParty();
    } else {
      partyVisualIntensity = 0; // eases in over DISCO_EASE_SECONDS via updateConga
    }
    return true;
  }

  // ── Disco party easter egg ────────────────────────────────────────────────

  // ── Party palette (default vs gold) ─────────────────────────────────────
  // Rebirth 6 unlock (GOLD_PALETTE_UNLOCK_REBIRTH, ~line 4797): the shared
  // party visuals — disco lighting, the disco ball, and the dance-off winner
  // confetti (all three party types funnel through this one lighting layer
  // already) — shift from the multicoloured default scheme to a warm
  // gold/amber one, so a long-time player's parties visibly read differently
  // from a newcomer's. Palettes are DATA, not scattered
  // `if (rebirthCount >= 6)` branches: every draw path below reads its
  // colors from whichever object getActivePartyPalette() returns.
  // getActivePartyPalette is the ONLY place rebirthCount (or the Alt+P
  // preview override — see the keydown handler) is consulted for this
  // feature; nothing else checks either one directly.
  const PARTY_PALETTE_DEFAULT = {
    key: "default",
    lightA: { start: "rgba(255,0,170,0.95)", end: "rgba(255,0,170,0)" },
    lightB: { start: "rgba(0,200,255,0.95)", end: "rgba(0,200,255,0)" },
    hueBase: 0,      // full-spectrum hue wash — unchanged from the original single-scheme behavior
    hueRange: 360,
    washSat: "70%",
    washLight: "55%",
    confetti: DANCE_OFF_CONFETTI_COLORS, // declared ~line 5710; unchanged 7-color set
  };
  const PARTY_PALETTE_GOLD = {
    key: "gold",
    lightA: { start: "rgba(255,196,64,0.95)", end: "rgba(255,196,64,0)" },
    lightB: { start: "rgba(255,140,0,0.95)", end: "rgba(255,140,0,0)" },
    hueBase: 35,     // amber
    hueRange: 30,    // narrow warm band (35°..65°: amber through gold-yellow) — never leaves warm hues
    washSat: "85%",
    washLight: "52%",
    confetti: ["#ffd700", "#ffc107", "#ffb300", "#ff8f00", "#ffe082", "#fff176"],
  };
  /** Alt+P preview override (see the keydown handler) — forces the gold
   *  palette on regardless of rebirthCount so it can be previewed before
   *  it's actually earned. In-memory only: never persisted, never posted to
   *  the host, never touches rebirthCount itself. Toggling again reverts to
   *  the rebirth-derived palette. */
  let goldPalettePreviewForced = false;
  /** Single source of truth for which party palette is active right now.
   *  drawDiscoOverlay, drawDiscoBall, and spawnDanceOffConfetti all call
   *  this instead of checking rebirthCount/goldPalettePreviewForced
   *  themselves. */
  function getActivePartyPalette() {
    return (goldPalettePreviewForced || rebirthCount >= GOLD_PALETTE_UNLOCK_REBIRTH)
      ? PARTY_PALETTE_GOLD
      : PARTY_PALETTE_DEFAULT;
  }

  // ── Gold-palette standalone preview (Alt+P with no party running) ──────
  // getActivePartyPalette() only feeds drawDiscoOverlay/drawDiscoBall/
  // spawnDanceOffConfetti, and every one of those is gated on
  // partyVisualIntensity > 0 — so flipping goldPalettePreviewForced with no
  // party active was previously a correct but INVISIBLE no-op (console.log
  // only). This gives Alt+P something to actually show: a short, self-
  // contained ride of the SAME shared partyVisualIntensity/partyEaseIntensity
  // lighting layer the conga/disco-party/dance-off/victory-lap all use, with
  // no agentCharMap/dancing/participant state touched at all — visuals only.
  /** Hold time (seconds) once the standalone preview reaches full intensity;
   *  combined with the two DISCO_EASE_SECONDS in/out ramps this reads for a
   *  few seconds total, per product ask ("roughly 4-5 seconds"). */
  const GOLD_PALETTE_PREVIEW_SECONDS = 4.5;
  /** True only while the standalone preview (not a real party) owns
   *  partyVisualIntensity. Never true at the same time as
   *  congaActive/discoPartyActive/danceOffActive/victoryLapActive — see
   *  startGoldPalettePreview's caller (the Alt+P handler) and
   *  updateGoldPalettePreview's belt-and-braces check below. */
  let goldPalettePreviewActive = false;
  let goldPalettePreviewTimeLeft = 0;
  /** On-screen chip telling the user the palette is a PREVIEW, not an earned
   *  unlock (see the Alt+P handler doc). Lives at bottom-center of
   *  #stage-area — clear of the trophy row (right: 74px) and the handbook
   *  launcher (bottom-left, see setupHandbookLauncher above). Built lazily so
   *  nothing is added to the DOM until the override is actually toggled on. */
  let goldPalettePreviewChipEl = null;
  function setGoldPalettePreviewChipVisible(visible) {
    if (!visible) {
      if (goldPalettePreviewChipEl) {
        goldPalettePreviewChipEl.remove();
        goldPalettePreviewChipEl = null;
      }
      return;
    }
    if (goldPalettePreviewChipEl) return;
    const stageAreaEl = document.getElementById("stage-area");
    if (!stageAreaEl) return;
    const chip = document.createElement("div");
    chip.id = "gold-palette-preview-chip";
    chip.className = "engine-chip"; // house style (rgba(10,10,11,.72), 1px #27272A, 999px radius, 11px)
    chip.style.position = "absolute";
    chip.style.left = "50%";
    chip.style.bottom = "12px";
    chip.style.transform = "translateX(-50%)";
    chip.style.zIndex = "10";
    chip.style.pointerEvents = "none"; // purely informational, never blocks stage clicks
    chip.textContent = "Preview — Gold Party Palette";
    stageAreaEl.appendChild(chip);
    goldPalettePreviewChipEl = chip;
  }

  /** Start the standalone preview. Only called by the Alt+P handler, and
   *  only when no real party is currently active (the handler checks
   *  congaActive/discoPartyActive/danceOffActive/victoryLapActive first —
   *  same "toggle alone suffices" reasoning documented there). Mirrors
   *  startDiscoParty's lighting-only setup (partyVisualStartMs/
   *  partyVisualIntensity) but deliberately does NOT touch agentCharMap —
   *  no dancing, no participants, visuals only. */
  function startGoldPalettePreview() {
    goldPalettePreviewActive = true;
    goldPalettePreviewTimeLeft = GOLD_PALETTE_PREVIEW_SECONDS;
    partyVisualStartMs = nowMs();
    partyVisualIntensity = 0; // eases in over DISCO_EASE_SECONDS via updateGoldPalettePreview
    setGoldPalettePreviewChipVisible(true);
  }

  /** Shared end path for the standalone preview — natural timeout (ease-out
   *  already reached ~0, same reasoning as endDiscoParty), a rival arriving
   *  (snap, matching cancelDiscoParty's "abruptness is the point"), a real
   *  party starting mid-preview (belt-and-braces, see updateGoldPalettePreview),
   *  or the user pressing Alt+P again to revert. Unlike the real parties there
   *  is no per-character state to differentiate a "natural" end from a
   *  "cancel" — nothing here ever touched agentCharMap — so one function
   *  covers all four exits. */
  function endGoldPalettePreview() {
    goldPalettePreviewActive = false;
    goldPalettePreviewTimeLeft = 0;
    partyVisualIntensity = 0;
    setGoldPalettePreviewChipVisible(false);
  }

  /** Handoff path: called by each real party's startX() (startConga,
   *  startDiscoParty, startDanceOff, the victory-lap upgrade branch) at the
   *  exact moment it discovers a preview was mid-ride. Clears the SAME
   *  bookkeeping/chip as endGoldPalettePreview but deliberately does NOT
   *  zero partyVisualIntensity — the caller skips its own zero-set and lets
   *  the real party's ease-in continue from whatever intensity the preview
   *  had already reached, so the screen never snaps to black on handoff. */
  function handOffGoldPalettePreviewToParty() {
    goldPalettePreviewActive = false;
    goldPalettePreviewTimeLeft = 0;
    setGoldPalettePreviewChipVisible(false);
  }

  /**
   * Advance the standalone gold-palette preview. Called once per frame from
   * the same gated block as updateConga/updateDiscoParty/updateDanceOff/
   * updateVictoryLap. Deliberately ORDER-INDEPENDENT — do not "optimise away"
   * the active-flags check below by relying on call position: every real
   * party's startX() already calls handOffGoldPalettePreviewToParty() the
   * instant it starts (see startConga/startDiscoParty/startDanceOff/the
   * victory-lap upgrade branch), synchronously clearing
   * goldPalettePreviewActive before this function next runs regardless of
   * where in the frame it's called from — proven by construction: every path
   * that can flip congaActive/discoPartyActive/danceOffActive/victoryLapActive
   * true routes through exactly one of those four startX() functions, and
   * each one performs the handoff itself. The flags check here is a
   * defensive backstop for any future call path that sets one of those flags
   * without going through a startX(), not the primary mechanism.
   * @param {number} delta seconds
   */
  function updateGoldPalettePreview(delta) {
    if (!goldPalettePreviewActive) return;
    // Backstop — see the order-independence note above. Ends the preview
    // (full snap-to-zero) rather than handing off, since reaching this
    // branch means some path started a party WITHOUT calling
    // handOffGoldPalettePreviewToParty() first — treat it like a rival: end
    // cleanly rather than silently leave stale preview state.
    if (congaActive || discoPartyActive || danceOffActive || victoryLapActive) {
      endGoldPalettePreview();
      return;
    }
    // Rivals end the preview immediately, same product rule as every other
    // party type ("if rivals arrive, the party is over").
    if (activeEnemies.length > 0) {
      endGoldPalettePreview();
      return;
    }
    goldPalettePreviewTimeLeft -= delta;
    partyVisualIntensity = partyEaseIntensity(goldPalettePreviewTimeLeft, GOLD_PALETTE_PREVIEW_SECONDS);
    if (goldPalettePreviewTimeLeft <= 0) endGoldPalettePreview();
  }

  /** Radial gradients for the two moving disco lights, built ONCE per
   *  palette (lazily, on first actual paint of that palette — see
   *  ensureDiscoGradients) and centered at their own local (0,0) origin with
   *  a fixed DISCO_LIGHT_RADIUS reach. Movement is achieved by translating
   *  the canvas before painting each one, NOT by recreating the gradient —
   *  so drawDiscoOverlay never allocates a gradient inside the render loop,
   *  for either palette. Keyed by palette.key ("default"/"gold").
   *  @type {Record<string, {a: CanvasGradient, b: CanvasGradient}>} */
  const discoGradientCache = {};
  /** Reach (px) of each disco light gradient before it fades to transparent. */
  const DISCO_LIGHT_RADIUS = 340;
  /** Peak alpha of each moving light at full party intensity. */
  const DISCO_LIGHT_MAX_ALPHA = 0.55;
  /** Angular speed (rad/s) of the light orbit — slow drift, not a strobe. */
  const DISCO_ORBIT_SPEED = 0.4;
  /** Hue-wash rotation speed (deg/s) — a ~12s period, smooth and continuous. */
  const DISCO_HUE_SPEED = 30;
  /** Hue-wash gentle alpha pulse frequency (Hz) — well under the ~3Hz
   *  photosensitivity cap; amplitude kept modest via *_BASE/*_RANGE below. */
  const DISCO_WASH_PULSE_HZ = 0.35;
  const DISCO_WASH_ALPHA_BASE = 0.06;
  const DISCO_WASH_ALPHA_RANGE = 0.03;

  /** Build (or return the cached) pair of disco-light gradients for the
   *  given palette. Cheap no-op on every call after the first for that
   *  palette. Never called while inactive (drawDiscoOverlay's early return
   *  guards it), so an unused scene — or a palette never actually painted —
   *  pays nothing at all for this.
   *  @param {{key:string, lightA:{start:string,end:string}, lightB:{start:string,end:string}}} palette
   *  @returns {{a: CanvasGradient, b: CanvasGradient}} */
  function ensureDiscoGradients(palette) {
    const cached = discoGradientCache[palette.key];
    if (cached) return cached;
    const a = ctx.createRadialGradient(0, 0, 0, 0, 0, DISCO_LIGHT_RADIUS);
    a.addColorStop(0, palette.lightA.start);
    a.addColorStop(1, palette.lightA.end);
    const b = ctx.createRadialGradient(0, 0, 0, 0, 0, DISCO_LIGHT_RADIUS);
    b.addColorStop(0, palette.lightB.start);
    b.addColorStop(1, palette.lightB.end);
    const pair = { a, b };
    discoGradientCache[palette.key] = pair;
    return pair;
  }

  /**
   * Paint the full-scene disco lighting pass: two slowly-orbiting colored
   * radial gradients plus a gentle hue-washed tint, composited over
   * everything already drawn this frame (background, objects, decor,
   * characters — called after the depth-sorted entity loop, before drawHUD).
   * Inactive-path cost is a single comparison and nothing else — no
   * allocation, no canvas state touched — satisfying the product's
   * "cost near-nothing when inactive" requirement.
   *
   * PHOTOSENSITIVITY: reduced-motion users get NO lighting pass at all, ever
   * — not even from the manual D-key trigger (chosen behavior; the D key
   * still triggers the dancing for those users, just not this overlay — see
   * the keydown handler's comment). This is deliberately unconditional on
   * partyVisualIntensity so it can never be bypassed by a future call site.
   * Shared between the disco party AND the conga line — whichever is active
   * feeds this same value (see updateConga/updateDiscoParty).
   * @param {number} w canvas width
   * @param {number} h canvas height
   */
  function drawDiscoOverlay(w, h) {
    if (partyVisualIntensity <= 0 || prefersReducedMotion) return;
    const palette = getActivePartyPalette();
    const grad = ensureDiscoGradients(palette);
    const t = (nowMs() - partyVisualStartMs) / 1000;
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = partyVisualIntensity * DISCO_LIGHT_MAX_ALPHA;
    // Light 1: slow orbit.
    ctx.save();
    ctx.translate(
      w * 0.5 + Math.cos(t * DISCO_ORBIT_SPEED) * w * 0.32,
      h * 0.45 + Math.sin(t * DISCO_ORBIT_SPEED * 0.8) * h * 0.28
    );
    ctx.fillStyle = grad.a;
    ctx.fillRect(-DISCO_LIGHT_RADIUS, -DISCO_LIGHT_RADIUS, DISCO_LIGHT_RADIUS * 2, DISCO_LIGHT_RADIUS * 2);
    ctx.restore();
    // Light 2: counter-orbit, opposite phase.
    ctx.save();
    ctx.translate(
      w * 0.5 + Math.cos(t * -DISCO_ORBIT_SPEED * 0.85 + Math.PI) * w * 0.30,
      h * 0.5 + Math.sin(t * DISCO_ORBIT_SPEED * 0.6 + Math.PI) * h * 0.30
    );
    ctx.fillStyle = grad.b;
    ctx.fillRect(-DISCO_LIGHT_RADIUS, -DISCO_LIGHT_RADIUS, DISCO_LIGHT_RADIUS * 2, DISCO_LIGHT_RADIUS * 2);
    ctx.restore();
    // Gentle global hue wash — smooth continuous hue drift (~12s period) with
    // a slow, low-amplitude alpha pulse. Well under the ~3 changes/sec
    // photosensitivity cap; nowhere near a strobe. Range is palette-driven:
    // the default palette sweeps the full 360° (unchanged original
    // behavior); the gold palette stays inside its narrow warm hueRange.
    const hue = palette.hueBase + ((t * DISCO_HUE_SPEED) % palette.hueRange);
    const washPulse = 0.5 + 0.5 * Math.sin(t * DISCO_WASH_PULSE_HZ * Math.PI * 2);
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = partyVisualIntensity * (DISCO_WASH_ALPHA_BASE + washPulse * DISCO_WASH_ALPHA_RANGE);
    ctx.fillStyle = `hsl(${hue}, ${palette.washSat}, ${palette.washLight})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** Monotonic ease-out (no overshoot) — used for the disco ball's
   *  drop-in/retract position so the reverse of "drop in" (party ending)
   *  reads as a graceful rise-and-fade rather than a bounce-glitch.
   *  @param {number} x 0..1 @returns {number} 0..1 */
  function easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3);
  }

  /**
   * Draw the bundled disco-ball sprite: drops in from above the background
   * on party start, holds near the top-centre of the stage while spinning
   * (frame-cycled, not a canvas rotation), and leaves the same way it
   * arrived. Deliberately has NO party-lifecycle state of its own — position
   * and alpha are both derived purely from partyVisualIntensity (declared
   * with the rest of the disco-party state above, but shared with the conga
   * line — see updateConga), so it automatically matches every existing rule
   * for free, for EITHER party type:
   *   - normal start/end: intensity eases over DISCO_EASE_SECONDS via
   *     updateDiscoParty/updateConga → the ball eases in/out in lock-step
   *     with the lights.
   *   - rival-cancel: cancelDiscoParty/endConga snap partyVisualIntensity
   *     straight to 0 (no ease) → the ball vanishes on the same frame,
   *     matching "the abruptness is the point". Neither this function nor
   *     its caller touches cancelDiscoParty/endDiscoParty/startDiscoParty/
   *     endConga/startConga's reviewed lifecycle logic.
   * Guarded like drawDiscoOverlay: a single cheap comparison when inactive,
   * and reduced-motion users get no ball at all (same as the lighting pass),
   * for either party type.
   * Sprite-load failure degrades to a silent no-op — the party itself never
   * depends on this sprite.
   * @param {number} w canvas width @param {number} h canvas height
   * @param {number} bgX @param {number} bgY @param {number} bgW @param {number} bgH
   *   drawn background rect (see the bgW/bgH block above the entity loop) —
   *   the ball is positioned relative to this, never hardcoded pixels.
   */
  function drawDiscoBall(w, h, bgX, bgY, bgW, bgH) {
    if (partyVisualIntensity <= 0 || prefersReducedMotion) return;
    if (!discoBallFrames || !discoBallFrames.length) return; // never loaded / failed — degrade silently
    // Gold palette: lazily bake (once ever) and use the tinted frame set;
    // ensureDiscoBallGoldFrames no-ops after its first call. Falls back to
    // the plain frames if the bake hasn't finished yet or ever failed.
    const palette = getActivePartyPalette();
    if (palette.key === "gold") ensureDiscoBallGoldFrames();
    const frames = (palette.key === "gold" && discoBallGoldFrames) ? discoBallGoldFrames : discoBallFrames;
    const fi = Math.floor(((nowMs() - partyVisualStartMs) / 1000) * DISCO_BALL_CLIP.fps) % DISCO_BALL_CLIP.frames.length;
    const frame = frames[DISCO_BALL_CLIP.frames[fi]];
    if (!frame || !frame.complete || frame.naturalWidth === 0) return;
    const size = bgW * DISCO_BALL_SIZE_FRAC;
    if (!(size > 0)) return;
    const restCy = bgY + bgH * DISCO_BALL_REST_Y_FRAC;
    const startCy = bgY - size; // fully above the background's top edge
    const eased = easeOutCubic(Math.max(0, Math.min(1, partyVisualIntensity)));
    const cy = startCy + (restCy - startCy) * eased;
    const cx = bgX + bgW * 0.5;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, partyVisualIntensity));
    ctx.drawImage(frame, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
  }

  /**
   * Start a disco party: GATHER first, then dance. Every agentCharMap entry
   * is sent walking to a ring slot around one shared anchor — same pattern
   * as startHuddle (pickHuddleAnchor + one ring position per participant at
   * HUDDLE_RING_RADIUS via destNx/destNy) — so the cast visibly converges on
   * one spot instead of dancing wherever it already stood (feedback #21:
   * "gather and celebrate"). Dancing itself (charEntry.dancing/danceTimeLeft,
   * same fields startAgentDance uses) only starts once updateDiscoParty's
   * "gather" phase sees everyone arrived (or the DISCO_GATHER_TIMEOUT_SEC
   * timeout), exactly like huddle's walkin→active handoff — no parallel
   * state machine, just huddle's existing shape reused for a different mover
   * set. Rivals are never entries in agentCharMap (see activeEnemies), so
   * this can't sweep one in; callers (updateDiscoParty's random trigger, the
   * D-key handler) already refuse to start while any rival is present or a
   * conga is running.
   */
  function startDiscoParty() {
    discoPartyActive = true;
    discoPartyPhase = "gather";
    discoGatherElapsed = 0;
    discoPartyTimeLeft = DISCO_PARTY_SECONDS;
    partyVisualStartMs = nowMs();
    if (goldPalettePreviewActive) {
      // Handoff — see handOffGoldPalettePreviewToParty's doc: keep the
      // CURRENT partyVisualIntensity so this party's ease-in continues
      // smoothly from wherever the preview was, instead of snapping to black.
      handOffGoldPalettePreviewToParty();
    } else {
      partyVisualIntensity = 0; // eases in over DISCO_EASE_SECONDS via updateDiscoParty
    }
    // One shared anchor for the whole cast (pickHuddleAnchor — near a built
    // object or an open nav point, same selection huddle uses) and one ring
    // slot per participant around it, spaced HUDDLE_RING_RADIUS out. Reusing
    // huddle's anchor/ring math rather than inventing new pathing.
    const anchor = pickHuddleAnchor();
    discoAnchorNx = anchor[0];
    discoAnchorNy = anchor[1];
    const ids = Object.keys(agentCharMap);
    // Slight per-character stagger for the music bubble (product ask: "show
    // the music emoji over their heads for a moment before they start
    // dancing... just like the conga line"), so the whole roster doesn't pop
    // the bubble on the exact same frame. Seeded here, consumed frame-by-frame
    // by updateDiscoParty's dance-phase branch below.
    let bubbleIdx = 0;
    for (let i = 0; i < ids.length; i++) {
      const e = agentCharMap[ids[i]];
      if (!e) continue;
      freeAgentSeat(e);
      const angle = (i / ids.length) * Math.PI * 2;
      const pos = clampToPolygon(
        discoAnchorNx + Math.cos(angle) * HUDDLE_RING_RADIUS,
        discoAnchorNy + Math.sin(angle) * HUDDLE_RING_RADIUS,
        walkablePolygon
      );
      // Walk-in only — NOT dancing yet, so the FINAL MOVEMENT GUARD
      // (~movement-clip resolution below) naturally plays "walk" while
      // isMoving, same as any other destNx/destNy move. Dancing starts once
      // updateDiscoParty's gather phase sees everyone arrived.
      e.destNx = pos[0];
      e.destNy = pos[1];
      e.settled = false;
      e.dancing = false;
      e.danceTimeLeft = 0;
      e.discoBubbleDelay = Math.min(bubbleIdx * DISCO_BUBBLE_STAGGER_SEC, DISCO_BUBBLE_STAGGER_MAX_SEC) + Math.random() * DISCO_BUBBLE_STAGGER_JITTER_SEC;
      e.discoBubbleFired = false;
      bubbleIdx++;
    }
    return true;
  }

  /** Natural end (timer ran out, no rival interruption): ease-out already
   *  reached 0 via updateDiscoParty's min(inT,outT) intensity formula, and
   *  every agentCharMap entry's danceTimeLeft was seeded to the same
   *  DISCO_PARTY_SECONDS and has been counting down against the same
   *  per-frame delta ever since — so it has already self-reverted
   *  (dancing=false) via the existing dance-countdown loop by the time this
   *  fires. Nothing dance-related to clear here. */
  function endDiscoParty() {
    discoPartyActive = false;
    discoPartyTimeLeft = 0;
    partyVisualIntensity = 0;
    discoCooldown = DISCO_COOLDOWN_SECONDS;
  }

  /**
   * Rival-arrival cancel path (product rule: "if rivals arrive, the party is
   * over"). Unlike endDiscoParty, this fires BEFORE the per-character
   * combat/dance loop runs this same frame (updateDiscoParty is called early
   * in render()), so forcing dancing=false here — rather than waiting on the
   * normal countdown — makes the very next lines of this same frame's
   * per-character loop see !charEntry.dancing and let combat engagement
   * (isEngaging, gated on !dancing) start immediately, matching "our
   * characters immediately get to action and attack the rivals". Lighting
   * snaps to 0 with no ease-out — that abruptness is the point.
   */
  function cancelDiscoParty() {
    discoPartyActive = false;
    discoPartyPhase = "gather";
    discoGatherElapsed = 0;
    discoPartyTimeLeft = 0;
    partyVisualIntensity = 0; // snap off, no ease-out
    discoCooldown = DISCO_COOLDOWN_SECONDS;
    for (const id of Object.keys(agentCharMap)) {
      const e = agentCharMap[id];
      if (!e) continue;
      e.dancing = false;
      e.danceTimeLeft = 0;
      e.danceFrameTimer = 0;
      e.lastDanceIdx = -1;
    }
  }

  /**
   * Advance the disco-party easter egg. Called once per frame, gated exactly
   * like updateConga (only while the scene is actually loaded/rendering —
   * the caller already skips this while document.hidden or the theme is
   * still loading, satisfying "only evaluated while the scene is actually
   * rendering and visible").
   * @param {number} delta seconds
   * @param {Array<object>} agentList current scene agent list (sceneAgentList)
   */
  function updateDiscoParty(delta, agentList) {
    if (discoCooldown > 0) discoCooldown = Math.max(0, discoCooldown - delta);

    if (discoPartyActive) {
      // Rivals end the party immediately (product rule) — checked first,
      // before any timer/easing math, so a rival arriving mid-party cancels
      // on the same frame it appears.
      if (activeEnemies.length > 0) {
        cancelDiscoParty();
        return;
      }
      // Belt-and-braces: a conga or dance-off must never start during a
      // party (the random trigger below and the 'c'/Alt+O hotkeys all check
      // discoPartyActive, and updateConga/updateDanceOff are both called
      // around updateDiscoParty in render() so a same-frame race can't slip
      // through) — but if that ever fails, end the party immediately rather
      // than let two systems both drive charEntry.dancing/animation this
      // frame. Reuses cancelDiscoParty's full clear (snap lighting off,
      // release every dancer) since this is the same "another system now
      // owns these characters" situation as a rival arriving.
      if (congaActive || danceOffActive) {
        cancelDiscoParty();
        return;
      }
      // GATHER phase: walk everyone to their ring slot (set by
      // startDiscoParty) before any dancing starts — same walkin→active
      // handoff shape as updateHuddle. No dance-timer/lighting math runs yet:
      // discoPartyTimeLeft is still seeded to the full DISCO_PARTY_SECONDS
      // (unchanged since startDiscoParty), so partyEaseIntensity's elapsed
      // (totalSeconds - timeLeft) is 0 and intensity stays at 0 — the
      // lights/ball only start easing in once we flip to "dance" below and
      // discoPartyTimeLeft begins counting down.
      if (discoPartyPhase === "gather") {
        let allArrived = true;
        for (const id of Object.keys(agentCharMap)) {
          const e = agentCharMap[id];
          if (!e) continue;
          const dx = e.destNx - e.nx, dy = e.destNy - e.ny;
          if (Math.sqrt(dx * dx + dy * dy) > WANDER_ARRIVED_EPS + 2) { allArrived = false; break; }
        }
        discoGatherElapsed += delta;
        const timedOut = discoGatherElapsed >= DISCO_GATHER_TIMEOUT_SEC;
        if (allArrived || timedOut) {
          for (const id of Object.keys(agentCharMap)) {
            const e = agentCharMap[id];
            if (!e) continue;
            // Snap stragglers to their slot on timeout, same as huddle's
            // walkin timeout — every dancer starts the dance clip from the
            // same ring position, none left mid-walk into "dance".
            e.nx = e.destNx; e.ny = e.destNy; e.settled = true;
            e.dancing = true;
            e.danceTimeLeft = DISCO_PARTY_SECONDS;
            e.danceFrameTimer = 0;
            e.lastDanceIdx = -1;
          }
          discoPartyPhase = "dance";
        }
        return;
      }
      // Staggered music bubble (see startDiscoParty's discoBubbleDelay seed).
      // force=true: a rare, deliberate whole-cast celebration, same class of
      // event as the conga line — the D-key can retrigger a party within
      // seconds, and BUBBLE_COOLDOWN_SEC (60s, meant for ambient chatter
      // spam) would otherwise silently swallow the bubble on the very next
      // press. Bypasses the cooldown GATE only — does not set/reset it
      // either (see showExpression's force doc), so this never suppresses a
      // later legitimate ambient bubble.
      for (const a of agentList) {
        const e = agentCharMap[a.id];
        if (!e || e.discoBubbleFired) continue;
        // A mid-party joiner gets a fresh agentCharMap entry (default
        // discoBubbleDelay: 0) but was never swept into e.dancing by
        // startDiscoParty (that only ran once, at party start) — without
        // this guard it would immediately pop a "music" bubble while
        // standing still. The bubble is strictly a signal that THIS
        // character is dancing, so require e.dancing here too; a joiner
        // just waits out the rest of the party undancing and unbubbled.
        if (!e.dancing) continue;
        if ((e.discoBubbleDelay || 0) > 0) { e.discoBubbleDelay -= delta; continue; }
        e.discoBubbleFired = true;
        showExpression(e, 5, DISCO_BUBBLE_DURATION_SEC, true); // music bubble, coincides with disco-party start
      }
      discoPartyTimeLeft -= delta;
      // Ease in over DISCO_EASE_SECONDS, hold, ease out over the same window
      // as the party naturally winds down (min of the two ramps) — shared
      // with updateConga via partyEaseIntensity.
      partyVisualIntensity = partyEaseIntensity(discoPartyTimeLeft, DISCO_PARTY_SECONDS);
      if (discoPartyTimeLeft <= 0) endDiscoParty();
      return;
    }

    // Not active. Random triggering is fully disabled for reduced-motion
    // users (product decision — see the D-key handler for the manual path,
    // which still works for them).
    if (prefersReducedMotion) return;
    discoCheckTimer += delta;
    if (discoCheckTimer < DISCO_CHECK_SECONDS) return;
    discoCheckTimer = 0;
    // Blocked while: no agents, a rival is present, still on cooldown, a
    // conga or dance-off is running (kept mutually exclusive — all three
    // drive charEntry.dancing), or the player hasn't reached the advertised
    // unlock rebirth yet (see DANCE_PARTY_UNLOCK_REBIRTH — mirrors
    // TURRET_UNLOCK_REBIRTH's gate style; the Alt+D hotkey below carries the
    // same check). Also blocked while a victory lap is playing — see
    // updateVictoryLap.
    if (agentList.length < 1 || activeEnemies.length > 0 || discoCooldown > 0 || congaActive || danceOffActive || victoryLapActive || quakePanicActive) return;
    if (rebirthCount < DANCE_PARTY_UNLOCK_REBIRTH) return;
    if (Math.random() >= DISCO_CHANCE) return;
    startDiscoParty();
  }

  // ── Dance-off easter egg ────────────────────────────────────────────────

  /**
   * Select exactly two NOT-working agents eligible to face off: not active
   * (isMetricsAgentActive), not already in a conga, not dancing, not seated.
   * Returns null (never a partial pair) if fewer than two qualify — the
   * dance-off must never start with only one participant.
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {string[]|null} [idA, idB] (order randomized), or null
   */
  function pickDanceOffParticipants(agentList) {
    const eligible = [];
    for (const a of agentList) {
      if (!a || isMetricsAgentActive(a)) continue;
      const e = agentCharMap[a.id];
      if (!e) continue;
      if (e.congaIndex >= 0) continue; // defensive — congaActive is already required false to reach here
      if (e.dancing) continue;
      if (e.sitting || e.sitSeatId != null) continue;
      eligible.push(a.id);
    }
    if (eligible.length < 2) return null;
    // Fisher-Yates partial shuffle — only the first two picks matter.
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
    }
    return [eligible[0], eligible[1]];
  }

  /**
   * Start a dance-off between two randomly-chosen non-working agents: pick
   * the pair, compute two stand points either side of the walkable
   * polygon's centroid, and send both walking there. Shared by
   * updateDanceOff's random trigger and the Alt+O hotkey.
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {boolean} true if a dance-off actually started
   */
  function startDanceOff(agentList) {
    const pair = pickDanceOffParticipants(agentList);
    if (!pair) return false;
    const eA = agentCharMap[pair[0]];
    const eB = agentCharMap[pair[1]];
    if (!eA || !eB) return false;
    let ccx = 0, ccy = 0;
    for (const p of walkablePolygon) { ccx += p[0]; ccy += p[1]; }
    ccx /= walkablePolygon.length; ccy /= walkablePolygon.length;
    danceOffPosA = clampToPolygon(ccx - DANCE_OFF_STAND_HALF_GAP, ccy, walkablePolygon);
    danceOffPosB = clampToPolygon(ccx + DANCE_OFF_STAND_HALF_GAP, ccy, walkablePolygon);
    danceOffIdA = pair[0];
    danceOffIdB = pair[1];
    freeAgentSeat(eA);
    freeAgentSeat(eB);
    eA.dancing = false; eA.danceTimeLeft = 0;
    eB.dancing = false; eB.danceTimeLeft = 0;
    eA.destNx = danceOffPosA[0]; eA.destNy = danceOffPosA[1]; eA.settled = false;
    eB.destNx = danceOffPosB[0]; eB.destNy = danceOffPosB[1]; eB.settled = false;
    danceOffActive = true;
    danceOffPhase = "walkin";
    danceOffWalkinElapsed = 0;
    danceOffTurnActor = 0;
    danceOffTurnsCompleted = 0;
    danceOffTurnTimeLeft = 0;
    danceOffTimeLeft = 0;
    danceOffWinnerId = null;
    danceOffCelebrateTimeLeft = 0;
    // Shared lighting/ball state (see partyVisualIntensity's declaration) —
    // same start pattern startConga/startDiscoParty use, so drawDiscoOverlay/
    // drawDiscoBall pick this up for free with no code changes there.
    partyVisualStartMs = nowMs();
    if (goldPalettePreviewActive) {
      // Handoff — see handOffGoldPalettePreviewToParty's doc: keep the
      // CURRENT partyVisualIntensity so this party's ease-in continues
      // smoothly from wherever the preview was, instead of snapping to black.
      handOffGoldPalettePreviewToParty();
    } else {
      partyVisualIntensity = 0; // eases in over DISCO_EASE_SECONDS during walk-in
    }
    return true;
  }

  /**
   * Begin one turn of the duel: the current danceOffTurnActor dances for
   * DANCE_OFF_TURN_SECONDS (via the EXISTING dancing/danceTimeLeft
   * mechanism — same fields startAgentDance/startDiscoParty use) while the
   * other stands and watches. Shared by the walk-in→duel transition and
   * updateDanceOff's turn-advance.
   * @param {object} eA danceOffIdA's charMap entry
   * @param {object} eB danceOffIdB's charMap entry
   */
  function beginDanceOffTurn(eA, eB) {
    const dancer = danceOffTurnActor === 0 ? eA : eB;
    const watcher = danceOffTurnActor === 0 ? eB : eA;
    dancer.dancing = true;
    dancer.danceTimeLeft = DANCE_OFF_TURN_SECONDS;
    dancer.danceFrameTimer = 0;
    dancer.lastDanceIdx = -1;
    watcher.dancing = false;
    watcher.danceTimeLeft = 0;
    danceOffTurnTimeLeft = DANCE_OFF_TURN_SECONDS;
    // Music bubble on the dancer whose turn is starting — once per turn (6x
    // per dance-off: 3 rounds x 2 dancers), NOT the watcher. force=true
    // bypasses BUBBLE_COOLDOWN_SEC (60s) the same way the conga/disco-party
    // start bubbles do (see their own showExpression(..., true) call sites) —
    // without it only the very first turn's bubble would ever show. Duration
    // is shorter than DANCE_OFF_TURN_SECONDS so it reads as a lead-in rather
    // than covering the whole turn.
    showExpression(dancer, 5, DANCE_OFF_BUBBLE_DURATION_SEC, true);
  }

  /**
   * Clear every dance-off field this feature ever writes on its two
   * participants (dancing/danceTimeLeft/danceFrameTimer/lastDanceIdx) —
   * called by both endDanceOff (natural end) and cancelDanceOff
   * (interruption) so neither exit path can miss one. Facing/position are
   * deliberately left as-is (matches endConga) — normal wander/AI takes over
   * from wherever the agent currently is the instant danceOffActive/inDanceOff
   * (its live-derived gate, see the per-character loop) goes false.
   */
  function clearDanceOffParticipants() {
    const eA = danceOffIdA ? agentCharMap[danceOffIdA] : null;
    const eB = danceOffIdB ? agentCharMap[danceOffIdB] : null;
    for (const e of [eA, eB]) {
      if (!e) continue;
      e.dancing = false;
      e.danceTimeLeft = 0;
      e.danceFrameTimer = 0;
      e.lastDanceIdx = -1;
    }
    // Winner-celebration confetti (see spawnDanceOffConfetti) shares this
    // single exit funnel with everything else the dance-off owns — both
    // endDanceOff (natural end) and cancelDanceOff (rival arrival /
    // participant active / participant vanished) call this, so the confetti
    // never keeps falling over whatever the scene becomes next.
    clearDanceOffConfetti();
  }

  /** Reset all module-level dance-off state to inactive. Shared tail of both endDanceOff and cancelDanceOff. */
  function resetDanceOffState() {
    danceOffActive = false;
    danceOffPhase = "idle";
    danceOffIdA = null;
    danceOffIdB = null;
    danceOffPosA = null;
    danceOffPosB = null;
    danceOffWalkinElapsed = 0;
    danceOffTurnActor = 0;
    danceOffTurnsCompleted = 0;
    danceOffTurnTimeLeft = 0;
    danceOffTimeLeft = 0;
    danceOffWinnerId = null;
    danceOffCelebrateTimeLeft = 0;
  }

  /**
   * Natural end (duel completed all DANCE_OFF_TURNS_TOTAL turns, winner
   * celebrated for DANCE_OFF_CELEBRATE_SECONDS): lighting has already eased
   * to ~0 via partyEaseIntensity by the time this fires. Mirrors
   * endConga/endDiscoParty.
   */
  function endDanceOff() {
    clearDanceOffParticipants();
    partyVisualIntensity = 0;
    danceOffCooldown = DANCE_OFF_COOLDOWN_SECONDS;
    resetDanceOffState();
  }

  /**
   * Interruption path — rival arrival, a participant went active/working
   * again, a participant vanished from the agent list, or (belt-and-braces)
   * a conga/disco party somehow became active. Snaps the shared
   * lighting/ball straight to 0 — no ease-out, matching
   * cancelDiscoParty/endConga's rival-cancel rule that the abruptness is the
   * point — and clears both participants' dance fields on the SAME frame so
   * they re-engage combat/work immediately. Called from updateDanceOff,
   * which (like updateConga/updateDiscoParty) runs before the per-character
   * isEngaging gate in render(), so this ordering guarantee is preserved.
   */
  function cancelDanceOff() {
    clearDanceOffParticipants();
    partyVisualIntensity = 0; // snap off, no ease-out
    danceOffCooldown = DANCE_OFF_COOLDOWN_SECONDS;
    resetDanceOffState();
  }

  /**
   * Advance the dance-off easter egg. Called once per frame, after
   * updateConga/updateDiscoParty (see render()) so a conga/party that just
   * started THIS frame is already visible to this function's start gates —
   * and before the per-character loop, so an interruption clears both
   * participants in time for them to re-engage combat/work on the same frame.
   * @param {number} delta seconds
   * @param {Array<object>} agentList current sceneAgentList
   */
  function updateDanceOff(delta, agentList) {
    if (danceOffCooldown > 0) danceOffCooldown = Math.max(0, danceOffCooldown - delta);

    if (danceOffActive) {
      // Belt-and-braces: a conga or disco party must never own character
      // state at the same time as a dance-off. Both of their own start
      // gates now refuse to fire while danceOffActive is true, so this
      // should be unreachable — but if it ever happens, end cleanly rather
      // than let two systems fight over these two characters.
      if (congaActive || discoPartyActive) { cancelDanceOff(); return; }
      // Rival arrival ends it immediately (same product rule as conga/disco).
      if (activeEnemies.length > 0) { cancelDanceOff(); return; }
      const eA = agentCharMap[danceOffIdA];
      const eB = agentCharMap[danceOffIdB];
      const agentA = agentList.find((a) => a && a.id === danceOffIdA);
      const agentB = agentList.find((a) => a && a.id === danceOffIdB);
      // Either participant vanished from the roster, or went back to
      // active/working — end immediately, in every phase (walkin/duel/celebrate).
      if (!eA || !eB || !agentA || !agentB || isMetricsAgentActive(agentA) || isMetricsAgentActive(agentB)) {
        cancelDanceOff();
        return;
      }

      if (danceOffPhase === "walkin") {
        const dxA = danceOffPosA[0] - eA.nx, dyA = danceOffPosA[1] - eA.ny;
        const dxB = danceOffPosB[0] - eB.nx, dyB = danceOffPosB[1] - eB.ny;
        const arrivedA = Math.sqrt(dxA * dxA + dyA * dyA) <= WANDER_ARRIVED_EPS + 2;
        const arrivedB = Math.sqrt(dxB * dxB + dyB * dyB) <= WANDER_ARRIVED_EPS + 2;
        danceOffWalkinElapsed += delta;
        // Simple ease-IN only while walking in — there's no fixed end yet to
        // ease OUT against (see danceOffTimeLeft's doc). The duel phase below
        // switches to the shared partyEaseIntensity helper, which handles the
        // real ease-out at the true end.
        partyVisualIntensity = Math.max(0, Math.min(1, (nowMs() - partyVisualStartMs) / 1000 / DISCO_EASE_SECONDS));
        const timedOut = danceOffWalkinElapsed >= DANCE_OFF_WALKIN_TIMEOUT_SEC;
        if ((arrivedA && arrivedB) || timedOut) {
          // Snap both onto their stand points (covers the timeout case,
          // where a blocked path left one short) and force them to face off.
          eA.nx = danceOffPosA[0]; eA.ny = danceOffPosA[1];
          eB.nx = danceOffPosB[0]; eB.ny = danceOffPosB[1];
          eA.destNx = eA.nx; eA.destNy = eA.ny; eA.settled = true;
          eB.destNx = eB.nx; eB.destNy = eB.ny; eB.settled = true;
          eA.facingLeft = (eB.nx - eA.nx) < 0;
          eB.facingLeft = (eA.nx - eB.nx) < 0;
          danceOffPhase = "duel";
          danceOffTurnActor = 0;
          danceOffTurnsCompleted = 0;
          danceOffTimeLeft = DANCE_OFF_TIMED_TOTAL;
          beginDanceOffTurn(eA, eB);
        }
        return;
      }

      if (danceOffPhase === "duel") {
        // Reassert the current turn's dancing state EVERY frame, before the
        // shared per-character decay block runs later this same frame (it
        // does `charEntry.danceTimeLeft -= delta` unconditionally on any
        // dancing=true entry — see the block right after the sitting/love
        // bubble section in the per-character loop). Without this,
        // charEntry.danceTimeLeft (set once at turn start) and
        // danceOffTurnTimeLeft (decremented once per frame, below) drift out
        // of step by exactly one frame — charEntry's copy always hits <=0
        // one frame before danceOffTurnTimeLeft does, so the decay block
        // force-clears dancing and pops the dancer to idle for a frame at
        // EVERY turn boundary. Refreshing danceTimeLeft back to a full
        // DANCE_OFF_TURN_SECONDS here, every frame, makes updateDanceOff the
        // single owner of both fields for its two participants: the decay
        // block's decrement can never reach <=0 while a turn is still live,
        // because this always runs first and tops it back up. Turn timing
        // itself is owned entirely by danceOffTurnTimeLeft below — never by
        // the shared danceTimeLeft countdown. Deliberately does NOT touch
        // danceFrameTimer/lastDanceIdx (only beginDanceOffTurn resets those,
        // once per turn) so the manual dance-frame swap cadence
        // (DANCE_FRAME_SWAP) keeps running normally instead of restarting
        // every frame.
        const dancer = danceOffTurnActor === 0 ? eA : eB;
        const watcher = danceOffTurnActor === 0 ? eB : eA;
        dancer.dancing = true;
        dancer.danceTimeLeft = DANCE_OFF_TURN_SECONDS;
        watcher.dancing = false;
        watcher.danceTimeLeft = 0;

        danceOffTimeLeft -= delta;
        partyVisualIntensity = partyEaseIntensity(danceOffTimeLeft, DANCE_OFF_TIMED_TOTAL);
        danceOffTurnTimeLeft -= delta;
        if (danceOffTurnTimeLeft <= 0) {
          danceOffTurnsCompleted++;
          if (danceOffTurnsCompleted >= DANCE_OFF_TURNS_TOTAL) {
            const winnerIsA = Math.random() < 0.5;
            const winnerEntry = winnerIsA ? eA : eB;
            const loserEntry = winnerIsA ? eB : eA;
            danceOffWinnerId = winnerIsA ? danceOffIdA : danceOffIdB;
            winnerEntry.dancing = false; winnerEntry.danceTimeLeft = 0;
            loserEntry.dancing = false; loserEntry.danceTimeLeft = 0;
            // Winner holds position in place (see the DANCE-OFF cheer clip
            // override in the per-character loop); loser is released to a
            // random walkable point and picked up by normal wander/AI once
            // inDanceOff clears at endDanceOff.
            winnerEntry.destNx = winnerEntry.nx; winnerEntry.destNy = winnerEntry.ny;
            const away = randomInsidePoly(walkablePolygon);
            loserEntry.destNx = away[0]; loserEntry.destNy = away[1];
            loserEntry.settled = false;
            danceOffPhase = "celebrate";
            danceOffCelebrateTimeLeft = DANCE_OFF_CELEBRATE_SECONDS;
            // Winner-celebration confetti — spawned at the winner's current
            // canvas position (winnerEntry.x/.y, the same fields the
            // per-character loop derives cx/cy from for every other overlay,
            // e.g. drawExpressionBubble). No-op for reduced-motion users.
            spawnDanceOffConfetti(winnerEntry.x, winnerEntry.y);
          } else {
            danceOffTurnActor = danceOffTurnActor === 0 ? 1 : 0;
            beginDanceOffTurn(eA, eB);
          }
        }
        return;
      }

      if (danceOffPhase === "celebrate") {
        danceOffTimeLeft -= delta;
        partyVisualIntensity = partyEaseIntensity(danceOffTimeLeft, DANCE_OFF_TIMED_TOTAL);
        danceOffCelebrateTimeLeft -= delta;
        if (danceOffCelebrateTimeLeft <= 0) endDanceOff();
        return;
      }
      return;
    }

    // Not active. Random trigger — time-based (not per-frame) so frame rate
    // never affects frequency, same approach as the conga/disco checks.
    danceOffCheckTimer += delta;
    if (danceOffCheckTimer < DANCE_OFF_CHECK_SECONDS) return;
    danceOffCheckTimer = 0;
    // Blocked while: fewer than 2 agents, a rival is present, still on
    // cooldown, or a conga/disco party is running (kept mutually exclusive —
    // all three drive charEntry.dancing/destNx/destNy). Also blocked while a
    // victory lap is playing — see updateVictoryLap.
    if (agentList.length < 2 || activeEnemies.length > 0 || danceOffCooldown > 0 || congaActive || discoPartyActive || victoryLapActive || quakePanicActive) return;
    // GATE SPOT: the dance-off unlocks one tier above the disco dance party,
    // via its own DANCE_OFF_UNLOCK_REBIRTH constant (mirrors
    // DANCE_PARTY_UNLOCK_REBIRTH's check in updateDiscoParty above; the
    // Alt+O hotkey below carries the same check).
    if (rebirthCount < DANCE_OFF_UNLOCK_REBIRTH) return;
    if (Math.random() >= DANCE_OFF_CHANCE) return;
    startDanceOff(agentList);
  }

  /**
   * Start a solo dance on a single agent's charMap entry (mirrors the normal
   * idle-dance start). Shared by the idle festivity roll and the debug hotkey.
   * @param {object} charEntry an agentCharMap entry
   */
