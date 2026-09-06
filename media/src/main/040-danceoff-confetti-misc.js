// Part: 40-danceoff-confetti-misc
// Dance-off confetti updates and other mid-file screen helpers.
  function updateDanceOffConfetti(delta) {
    if (!danceOffConfettiActive) return;
    let anyAlive = false;
    for (let i = 0; i < danceOffConfettiPool.length; i++) {
      const p = danceOffConfettiPool[i];
      if (!p.active) continue;
      p.life -= delta;
      if (p.life <= 0) { p.active = false; continue; }
      p.vy += DANCE_OFF_CONFETTI_GRAVITY * delta;
      p.vx += Math.sin(p.life * 6 + p.rot) * DANCE_OFF_CONFETTI_DRIFT * delta;
      p.x += p.vx * delta;
      p.y += p.vy * delta;
      p.rot += p.vrot * delta;
      anyAlive = true;
    }
    danceOffConfettiActive = anyAlive;
  }

  /**
   * Draw every live confetti particle as a small colored, rotated rect
   * (asset-free, theme-independent) fading out over its lifetime. Guarded
   * like drawDiscoOverlay/drawDiscoBall: a single cheap boolean check when
   * inactive, and reduced-motion users get none (spawnDanceOffConfetti
   * already refuses to populate the pool for them, but this is checked too
   * as belt-and-braces in case that ever changes). Every ctx mutation is
   * inside its own save/restore so no state (globalAlpha, transform) leaks
   * into later draws.
   */
  function drawDanceOffConfetti() {
    if (!danceOffConfettiActive || prefersReducedMotion) return;
    for (let i = 0; i < danceOffConfettiPool.length; i++) {
      const p = danceOffConfettiPool[i];
      if (!p.active) continue;
      const alpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
  }

  /** Clear all confetti state — deactivates every pooled particle and drops
   *  the single active flag. Called from clearDanceOffParticipants so every
   *  one of its four callers-in-spirit (natural end via endDanceOff,
   *  interruption via cancelDanceOff — rival arrival, a participant going
   *  active, or a participant vanishing) stops the confetti on the same
   *  frame it stops everything else, rather than letting it fall over
   *  whatever replaces the dance-off scene. */
  function clearDanceOffConfetti() {
    for (let i = 0; i < danceOffConfettiPool.length; i++) {
      danceOffConfettiPool[i].active = false;
    }
    danceOffConfettiActive = false;
  }

  // ── Sparring exhibition (Rebirth-6 ambient easter egg) ─────────────────
  // Two idle, non-building agents face off in a friendly sparring drill:
  // alternating attacker (melee clip)/defender (block clip) roles, with 0-3
  // idle bystanders drifting in as ring spectators. Shares NO state with the
  // dance-off/disco/conga "party" lighting layer (partyVisualIntensity) —
  // this is plain character animation, not a lighting event — but mirrors
  // their STRUCTURAL shape (own state block, start/update/end/cancel
  // functions, a live-derived `inSparring` gate threaded through every
  // engage/build/wander exclusion the same way `inDanceOff` is, see the
  // per-character loop). Purely cosmetic: never touches hp, build progress,
  // or persisted state — only destNx/destNy/settled/facingLeft (all fields
  // every other ambient system already reuses) and display-only expression
  // bubbles. STRICT product rule: this activity must NEVER show a Dazed (7)
  // or Anger (2) bubble — see updateSparring's spectator-reaction roll and
  // the celebrate-phase winner pick, both of which only ever pick from
  // {Love, Team, Thumbs-up}.
  /** True while a sparring exhibition is running (walk-in, active, or celebrate). */
  let sparringActive = false;
  /** "walkin" | "active" | "celebrate" | "idle" (idle = not meaningful while !sparringActive). */
  let sparringPhase = "idle";
  /** agent.id of the two sparrers, or null when inactive. */
  let sparringIdA = null;
  let sparringIdB = null;
  /** Native-coord stand points either side of a random ring center, computed once at start. */
  let sparringPosA = null;
  let sparringPosB = null;
  /** agent.id of each spectator enrolled this run (0..SPARRING_MAX_SPECTATORS), index-aligned with sparringSpectatorPos. @type {string[]} */
  let sparringSpectatorIds = [];
  /** Native-coord ring stand point per spectator, computed once at start, index-aligned with sparringSpectatorIds. @type {number[][]} */
  let sparringSpectatorPos = [];
  /** Seconds elapsed walking in this run — capped by SPARRING_WALKIN_TIMEOUT_SEC so a blocked path can't hang the easter egg forever. */
  let sparringWalkinElapsed = 0;
  /** Which sparrer is CURRENTLY attacking: 0 = A, 1 = B (the other defends). */
  let sparringAttacker = 0;
  /** Seconds remaining before the current attacker/defender assignment swaps. */
  let sparringRoleTimeLeft = 0;
  /** Overall countdown (seconds) for the active (melee/block) phase — randomized once at the walkin→active transition. */
  let sparringTimeLeft = 0;
  /** agent.id of the sparrer randomly chosen to celebrate at the end — "only one will celebrate" (product rule); the other returns to idle with no bubble. */
  let sparringCelebrateId = null;
  /** Seconds remaining in the celebrating sparrer's cheer hold. */
  let sparringCelebrateTimeLeft = 0;
  /** Accumulator (seconds) toward the next spectator sparse-reaction roll. */
  let sparringSpectatorReactTimer = 0;
  /** rebirthCount snapshot at the moment this run started — updateSparring cancels immediately if this drifts (a rebirth happened mid-exhibition). */
  let sparringStartRebirthCount = 0;
  /** Accumulator (seconds) toward the next rare-trigger eligibility check. */
  let sparringCheckTimer = 0;
  /** Cooldown (seconds) remaining before another sparring exhibition may start via the random trigger. */
  let sparringCooldown = 0;
  /** Rebirths required before the sparring exhibition unlocks — same tier as the gold party palette; the stand-up huddle unlocks separately at HUDDLE_UNLOCK_REBIRTH. */
  const SPARRING_UNLOCK_REBIRTH = 6;
  /** Seconds between random-trigger eligibility rolls (time-based, not per-frame, like every other ambient system's check). */
  const SPARRING_CHECK_SECONDS = 90;
  /** Chance per eligibility check that an exhibition starts — mean interval ≈ SPARRING_CHECK_SECONDS/SPARRING_CHANCE ≈ 900s, an "occasional" cadence per product ask. */
  const SPARRING_CHANCE = 0.1;
  /** Cooldown (seconds) after a run ends before another may start via the random trigger. */
  const SPARRING_COOLDOWN_SECONDS = 240;
  /** Half the native-px gap between the two sparrers ("~a body-width apart") — comfortably above MIN_AGENT_SEP_NATIVE (34) so the separation pass never fights the face-off spacing, mirrors DANCE_OFF_STAND_HALF_GAP. */
  const SPARRING_STAND_HALF_GAP = 34;
  /** Sane upper bound (seconds) on the walk-in phase before both sparrers snap straight to their stand points. */
  const SPARRING_WALKIN_TIMEOUT_SEC = 6;
  /** Min/max seconds an attacker/defender role holds before swapping. */
  const SPARRING_ROLE_MIN_SEC = 0.8;
  const SPARRING_ROLE_MAX_SEC = 1.2;
  /** Min/max seconds the exhibition runs before a winner is chosen to celebrate. */
  const SPARRING_DURATION_MIN_SEC = 6;
  const SPARRING_DURATION_MAX_SEC = 10;
  /** Seconds the chosen sparrer holds its cheer pose. */
  const SPARRING_CELEBRATE_SECONDS = 2;
  /** Max idle bystanders that may drift in as ring spectators this run. */
  const SPARRING_MAX_SPECTATORS = 3;
  /** Minimum idle, non-building agents required (the two sparrers) to even attempt a start. */
  const SPARRING_MIN_IDLE_FOR_START = 2;
  /** Native-px ring radius spectators stand at around the sparring pair's
   *  midpoint. Worst case is the edge spectator (fan angle 36°/144° off the
   *  A-B axis — hit for BOTH the 2-spectator case, where the ±54° offsets
   *  land exactly there, and the 3-spectator case's two outer slots): its
   *  distance to the NEAR sparrer (SPARRING_STAND_HALF_GAP=34 out from
   *  center) is sqrt(R^2 - 2*34*R*cos36 + 34^2). At R=46 that was ~27.2px —
   *  under MIN_AGENT_SEP_NATIVE (34), so the universal separation pass kept
   *  nudging that spectator off its ring point every frame. R=64 gives
   *  ~41.6px, a comfortable ~7.6px margin above MIN_AGENT_SEP_NATIVE. */
  const SPARRING_RING_RADIUS = 64;
  /** Chance, per SPARRING_SPECTATOR_REACT_INTERVAL_SEC tick, that a given spectator reacts with a sparse bubble. */
  const SPARRING_SPECTATOR_REACT_CHANCE = 0.15;
  /** Seconds between spectator reaction eligibility ticks. */
  const SPARRING_SPECTATOR_REACT_INTERVAL_SEC = 2.0;

  /**
   * Select the two sparrers (and, from the remainder, 0..SPARRING_MAX_SPECTATORS
   * spectators) eligible for a sparring exhibition: not active
   * (isMetricsAgentActive), not in a conga/dance-off/huddle, not dancing,
   * emoting, seated, dazed, or already repairing. Mirrors
   * pickDanceOffParticipants' shape. Returns null (never a partial pick) if
   * fewer than SPARRING_MIN_IDLE_FOR_START qualify.
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {{a:string, b:string, spectators:string[]}|null}
   */
  function pickSparringParticipants(agentList) {
    const eligible = [];
    for (const a of agentList) {
      if (!a) continue;
      if (isMetricsAgentActive(a)) continue;
      const e = agentCharMap[a.id];
      if (!e) continue;
      if (e.congaIndex >= 0) continue;
      if (e.dancing || e.emoting) continue;
      if (e.sitting || e.sitSeatId != null) continue;
      if (e.dazePhase != null) continue;
      if (e.extinguishTargetId != null) continue;
      if (danceOffActive && (a.id === danceOffIdA || a.id === danceOffIdB)) continue;
      if (huddleActive && huddleParticipantIds.indexOf(a.id) >= 0) continue;
      eligible.push(a.id);
    }
    if (eligible.length < SPARRING_MIN_IDLE_FOR_START) return null;
    // Fisher-Yates partial shuffle (mirrors pickDanceOffParticipants).
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
    }
    const a = eligible[0], b = eligible[1];
    const rest = eligible.slice(2);
    const spectatorCount = Math.min(rest.length, Math.floor(Math.random() * (SPARRING_MAX_SPECTATORS + 1)));
    return { a, b, spectators: rest.slice(0, spectatorCount) };
  }

  /**
   * Start a sparring exhibition: pick participants, drop a ring center at a
   * random walkable point (variety run to run — deliberately NOT the same
   * centroid spot the dance-off always uses), compute stand points, and send
   * everyone walking in. Shared by updateSparring's random trigger only (no
   * debug hotkey requested for this feature).
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {boolean} true if an exhibition actually started
   */
  function startSparring(agentList) {
    const pick = pickSparringParticipants(agentList);
    if (!pick) return false;
    const eA = agentCharMap[pick.a];
    const eB = agentCharMap[pick.b];
    if (!eA || !eB) return false;
    const center = randomInsidePoly(walkablePolygon);
    const ccx = center[0], ccy = center[1];
    sparringPosA = clampToPolygon(ccx - SPARRING_STAND_HALF_GAP, ccy, walkablePolygon);
    sparringPosB = clampToPolygon(ccx + SPARRING_STAND_HALF_GAP, ccy, walkablePolygon);
    sparringIdA = pick.a;
    sparringIdB = pick.b;
    sparringSpectatorIds = pick.spectators.slice();
    // Fan spectators out on a semicircle "audience" arc facing the ring,
    // rather than the 0/π angles the two sparrers already occupy.
    const count = sparringSpectatorIds.length;
    sparringSpectatorPos = sparringSpectatorIds.map((id, i) => {
      const spread = Math.PI * 0.6;
      const angle = Math.PI / 2 + (i - (count - 1) / 2) * (spread / Math.max(count - 1, 1));
      return clampToPolygon(ccx + Math.cos(angle) * SPARRING_RING_RADIUS, ccy + Math.sin(angle) * SPARRING_RING_RADIUS, walkablePolygon);
    });
    freeAgentSeat(eA);
    freeAgentSeat(eB);
    eA.destNx = sparringPosA[0]; eA.destNy = sparringPosA[1]; eA.settled = false;
    eB.destNx = sparringPosB[0]; eB.destNy = sparringPosB[1]; eB.settled = false;
    for (let i = 0; i < sparringSpectatorIds.length; i++) {
      const se = agentCharMap[sparringSpectatorIds[i]];
      if (!se) continue;
      freeAgentSeat(se);
      se.destNx = sparringSpectatorPos[i][0];
      se.destNy = sparringSpectatorPos[i][1];
      se.settled = false;
    }
    sparringActive = true;
    sparringPhase = "walkin";
    sparringWalkinElapsed = 0;
    sparringAttacker = Math.random() < 0.5 ? 0 : 1;
    sparringRoleTimeLeft = 0;
    sparringTimeLeft = 0;
    sparringCelebrateId = null;
    sparringCelebrateTimeLeft = 0;
    sparringSpectatorReactTimer = SPARRING_SPECTATOR_REACT_INTERVAL_SEC;
    sparringStartRebirthCount = rebirthCount;
    return true;
  }

  /** Reset all module-level sparring state to inactive. Shared tail of both
   *  endSparring and cancelSparring. No per-agent fields to clear (unlike
   *  dance-off's dancing/danceTimeLeft) — this feature never writes anything
   *  onto a charEntry beyond destNx/destNy/settled/facingLeft, all of which
   *  normal wander/AI happily inherits and overwrites on its own the instant
   *  `inSparring` reads false next frame. That's what makes disband "no
   *  stuck flags" for free. */
  function resetSparringState() {
    sparringActive = false;
    sparringPhase = "idle";
    sparringIdA = null;
    sparringIdB = null;
    sparringPosA = null;
    sparringPosB = null;
    sparringSpectatorIds = [];
    sparringSpectatorPos = [];
    sparringWalkinElapsed = 0;
    sparringAttacker = 0;
    sparringRoleTimeLeft = 0;
    sparringTimeLeft = 0;
    sparringCelebrateId = null;
    sparringCelebrateTimeLeft = 0;
  }

  /** Natural end (celebration hold ran out). */
  function endSparring() {
    sparringCooldown = SPARRING_COOLDOWN_SECONDS;
    resetSparringState();
  }

  /** Interruption path — rival arrival, rebirth, a load-bearing sparrer went
   *  active/vanished, or (belt-and-braces) another party-style system somehow
   *  became active. Participants simply resume normal AI next frame once
   *  `inSparring` reads false — see resetSparringState's doc. */
  function cancelSparring() {
    sparringCooldown = SPARRING_COOLDOWN_SECONDS;
    resetSparringState();
  }

  /**
   * Advance the sparring exhibition. Called once per frame, after
   * updateDanceOff (so this frame's congaActive/discoPartyActive/
   * danceOffActive already reflect anything that just started/ended this
   * same frame) and before the per-character loop (so an interruption clears
   * participants in time for them to re-engage combat/work on the same frame).
   * @param {number} delta seconds
   * @param {Array<object>} agentList current sceneAgentList
   */
  function updateSparring(delta, agentList) {
    if (sparringCooldown > 0) sparringCooldown = Math.max(0, sparringCooldown - delta);

    if (sparringActive) {
      // Preemption (product rule): real combat, a rebirth, or another
      // party-style system taking the floor all cancel immediately.
      // huddleActive is belt-and-braces here (both activities' own start
      // gates already refuse to fire while the other is active — see
      // updateHuddle's own random-trigger gate — so this should be
      // unreachable), same defensive style as congaActive/discoPartyActive.
      if (activeEnemies.length > 0 || rebirthCount !== sparringStartRebirthCount || congaActive || discoPartyActive || danceOffActive || huddleActive) {
        cancelSparring();
        return;
      }
      const eA = agentCharMap[sparringIdA];
      const eB = agentCharMap[sparringIdB];
      const agentA = agentList.find((a) => a && a.id === sparringIdA);
      const agentB = agentList.find((a) => a && a.id === sparringIdB);
      // Either load-bearing sparrer vanished or went back to active/working — end immediately.
      if (!eA || !eB || !agentA || !agentB || isMetricsAgentActive(agentA) || isMetricsAgentActive(agentB)) {
        cancelSparring();
        return;
      }
      // A spectator that went active/vanished just quietly drops out — only
      // the two sparrers are load-bearing for the whole exhibition.
      for (let i = sparringSpectatorIds.length - 1; i >= 0; i--) {
        const sid = sparringSpectatorIds[i];
        const sAgent = agentList.find((a) => a && a.id === sid);
        const sEnt = agentCharMap[sid];
        if (!sAgent || !sEnt || isMetricsAgentActive(sAgent)) {
          sparringSpectatorIds.splice(i, 1);
          sparringSpectatorPos.splice(i, 1);
        }
      }

      if (sparringPhase === "walkin") {
        const dxA = sparringPosA[0] - eA.nx, dyA = sparringPosA[1] - eA.ny;
        const dxB = sparringPosB[0] - eB.nx, dyB = sparringPosB[1] - eB.ny;
        const arrivedA = Math.sqrt(dxA * dxA + dyA * dyA) <= WANDER_ARRIVED_EPS + 2;
        const arrivedB = Math.sqrt(dxB * dxB + dyB * dyB) <= WANDER_ARRIVED_EPS + 2;
        sparringWalkinElapsed += delta;
        const timedOut = sparringWalkinElapsed >= SPARRING_WALKIN_TIMEOUT_SEC;
        if ((arrivedA && arrivedB) || timedOut) {
          eA.nx = sparringPosA[0]; eA.ny = sparringPosA[1];
          eB.nx = sparringPosB[0]; eB.ny = sparringPosB[1];
          eA.destNx = eA.nx; eA.destNy = eA.ny; eA.settled = true;
          eB.destNx = eB.nx; eB.destNy = eB.ny; eB.settled = true;
          eA.facingLeft = (eB.nx - eA.nx) < 0;
          eB.facingLeft = (eA.nx - eB.nx) < 0;
          sparringPhase = "active";
          sparringTimeLeft = SPARRING_DURATION_MIN_SEC + Math.random() * (SPARRING_DURATION_MAX_SEC - SPARRING_DURATION_MIN_SEC);
          sparringRoleTimeLeft = SPARRING_ROLE_MIN_SEC + Math.random() * (SPARRING_ROLE_MAX_SEC - SPARRING_ROLE_MIN_SEC);
        }
        return;
      }

      if (sparringPhase === "active") {
        sparringTimeLeft -= delta;
        sparringRoleTimeLeft -= delta;
        if (sparringRoleTimeLeft <= 0) {
          sparringAttacker = sparringAttacker === 0 ? 1 : 0;
          sparringRoleTimeLeft = SPARRING_ROLE_MIN_SEC + Math.random() * (SPARRING_ROLE_MAX_SEC - SPARRING_ROLE_MIN_SEC);
        }
        // Sparse spectator reactions. STRICT product rule: friendly only —
        // never index 7 (Dazed) or index 2 (Anger) here.
        sparringSpectatorReactTimer -= delta;
        if (sparringSpectatorReactTimer <= 0) {
          sparringSpectatorReactTimer = SPARRING_SPECTATOR_REACT_INTERVAL_SEC;
          for (const sid of sparringSpectatorIds) {
            const se = agentCharMap[sid];
            if (!se || Math.random() >= SPARRING_SPECTATOR_REACT_CHANCE) continue;
            const roll = Math.random();
            const idx = roll < 0.45 ? 3 /* Team */ : roll < 0.9 ? 4 /* Thumbs-up */ : 0 /* Love, rare */;
            showExpression(se, idx, 1.6);
          }
        }
        if (sparringTimeLeft <= 0) {
          // Only ONE randomly-chosen sparrer celebrates — the other simply
          // returns to idle with no bubble (product rule: "only one will
          // celebrate").
          sparringCelebrateId = Math.random() < 0.5 ? sparringIdA : sparringIdB;
          const celebEnt = agentCharMap[sparringCelebrateId];
          if (celebEnt) showExpression(celebEnt, 4 /* Thumbs-up */, SPARRING_CELEBRATE_SECONDS);
          sparringPhase = "celebrate";
          sparringCelebrateTimeLeft = SPARRING_CELEBRATE_SECONDS;
        }
        return;
      }

      if (sparringPhase === "celebrate") {
        sparringCelebrateTimeLeft -= delta;
        if (sparringCelebrateTimeLeft <= 0) endSparring();
        return;
      }
      return;
    }

    // Not active. Random trigger — time-based (not per-frame), same approach
    // as the conga/disco/dance-off checks.
    sparringCheckTimer += delta;
    if (sparringCheckTimer < SPARRING_CHECK_SECONDS) return;
    sparringCheckTimer = 0;
    // Blocked while: too few agents, a rival present, still on cooldown, a
    // conga/disco/dance-off/huddle is running (all drive destNx/destNy or
    // charEntry.dancing), or a victory lap is playing.
    if (agentList.length < SPARRING_MIN_IDLE_FOR_START || activeEnemies.length > 0 || sparringCooldown > 0 ||
        congaActive || discoPartyActive || danceOffActive || huddleActive || victoryLapActive || quakePanicActive) return;
    if (rebirthCount < SPARRING_UNLOCK_REBIRTH) return;
    if (Math.random() >= SPARRING_CHANCE) return;
    startSparring(agentList);
  }

  // ── Stand-up huddle (Rebirth-2 ambient easter egg) ─────────────────────
  // 3-5 idle, non-building agents converge on a ring around a clear nav
  // point (near a random built object, or an open point in the walkable
  // polygon) with a rotating SPEAKER (point clip + Idea/Team bubble) and
  // listeners (idle clip, sparse Thumbs-up/Idea reactions). Same structural
  // shape and same cosmetic-only guarantee as the sparring exhibition above;
  // mutually exclusive with it (and with conga/disco/dance-off) so the two
  // ambient activities interleave rather than ever overlapping.
  /** True while a huddle is running (walk-in or active). */
  let huddleActive = false;
  /** "walkin" | "active" | "idle" (idle = not meaningful while !huddleActive). No celebrate phase — "speaker gets no special ending" (product rule). */
  let huddlePhase = "idle";
  /** agent.id of every participant this run (3..5), in ring-slot order — index-aligned with huddlePositions. @type {string[]} */
  let huddleParticipantIds = [];
  /** Native-coord ring stand point per participant, computed once at start, index-aligned with huddleParticipantIds. @type {number[][]} */
  let huddlePositions = [];
  /** Fixed ring anchor (native coords), computed once at start by pickHuddleAnchor. */
  let huddleAnchorNx = 0;
  let huddleAnchorNy = 0;
  /** Seconds elapsed walking in this run — capped by HUDDLE_WALKIN_TIMEOUT_SEC. */
  let huddleWalkinElapsed = 0;
  /** Index into huddleParticipantIds of the CURRENT rotating speaker. */
  let huddleSpeakerIdx = 0;
  /** Seconds remaining in the current speaker's turn. */
  let huddleSpeakerTimeLeft = 0;
  /** Overall countdown (seconds) for the active phase — randomized once at the walkin→active transition. */
  let huddleTimeLeft = 0;
  /** huddleTimeLeft's starting value for the current run (needed to derive "mid-meeting" for the sleep joke below, since the duration itself is randomized per run). */
  let huddleDurationTotal = 0;
  /** agent.id picked (at most once per huddle, ~HUDDLE_SLEEP_JOKE_CHANCE of runs) to show the mid-meeting Sleep joke bubble, or null if this run doesn't get one. */
  let huddleSleeperChosenId = null;
  /** True once the Sleep joke has actually fired this run — guarantees "at most once per huddle" even though the eligibility check re-runs every listener-reaction tick. */
  let huddleSleeperFired = false;
  /** Accumulator (seconds) toward the next listener sparse-reaction roll. */
  let huddleListenerReactTimer = 0;
  /** rebirthCount snapshot at the moment this run started — updateHuddle cancels immediately if this drifts. */
  let huddleStartRebirthCount = 0;
  /** Accumulator (seconds) toward the next rare-trigger eligibility check. */
  let huddleCheckTimer = 0;
  /** Cooldown (seconds) remaining before another huddle may start via the random trigger. */
  let huddleCooldown = 0;
  /** Rebirths required before the huddle unlocks — same tier as the turret; the sparring exhibition unlocks separately at SPARRING_UNLOCK_REBIRTH. */
  const HUDDLE_UNLOCK_REBIRTH = 2;
  /** Seconds between random-trigger eligibility rolls — offset from SPARRING_CHECK_SECONDS so the two activities' random rolls don't always land on the same tick. */
  const HUDDLE_CHECK_SECONDS = 75;
  /** Chance per eligibility check that a huddle starts — mean interval ≈ HUDDLE_CHECK_SECONDS/HUDDLE_CHANCE ≈ 250s, a bit rarer than the sparring exhibition. */
  const HUDDLE_CHANCE = 0.3;
  /** Cooldown (seconds) after a run ends before another may start via the random trigger. */
  const HUDDLE_COOLDOWN_SECONDS = 300;
  /** Min/max participants — product spec: "3-5 idle agents". */
  const HUDDLE_MIN_PARTICIPANTS = 3;
  const HUDDLE_MAX_PARTICIPANTS = 5;
  /** Native-px ring radius around the anchor — above MIN_AGENT_SEP_NATIVE (34) so the separation pass never fights the ring spacing. */
  const HUDDLE_RING_RADIUS = 40;
  /** Sane upper bound (seconds) on the walk-in phase before every participant snaps straight to its ring slot. */
  const HUDDLE_WALKIN_TIMEOUT_SEC = 7;
  /** Seconds each rotating speaker holds the floor. */
  const HUDDLE_SPEAKER_TURN_SEC = 2;
  /** Min/max seconds the huddle runs before disbanding. */
  const HUDDLE_DURATION_MIN_SEC = 8;
  const HUDDLE_DURATION_MAX_SEC = 12;
  /** Chance, per HUDDLE_LISTENER_REACT_INTERVAL_SEC tick, that a given listener reacts with a sparse bubble. */
  const HUDDLE_LISTENER_REACT_CHANCE = 0.18;
  /** Seconds between listener reaction eligibility ticks. */
  const HUDDLE_LISTENER_REACT_INTERVAL_SEC = 2.2;
  /** Chance, decided once per huddle at start, that this run includes the mid-meeting Sleep joke — "~10% chance per huddle... at most once per huddle" (product rule). */
  const HUDDLE_SLEEP_JOKE_CHANCE = 0.10;
  /** Bubble duration (seconds) for the speaker's Idea/Team pose and the listener reactions. */
  const HUDDLE_BUBBLE_DURATION_SEC = 1.8;
  /** Chance the ring anchor is dropped near a random FULLY BUILT object (phase "idle" in objectAnimMap) instead of an open walkable point. */
  const HUDDLE_ANCHOR_NEAR_OBJECT_CHANCE = 0.5;

  /**
   * Pick the huddle's ring anchor: either near a random fully-built object
   * (a small jitter around its placement, clamped inside the walkable
   * polygon) or an open point inside the polygon — per product ask ("near a
   * random built object or open nav centroid"). Falls back to an open point
   * whenever the theme has no built objects yet.
   * @returns {number[]} [nx, ny] native coords, guaranteed inside walkablePolygon
   */
  function pickHuddleAnchor() {
    if (Math.random() < HUDDLE_ANCHOR_NEAR_OBJECT_CHANCE) {
      const built = [];
      for (const obj of themeBuildables) {
        const entry = objectAnimMap[obj.object_id];
        const p = objectPlacement[obj.object_id];
        if (entry && entry.phase === "idle" && p) built.push(p);
      }
      if (built.length > 0) {
        const p = built[Math.floor(Math.random() * built.length)];
        return clampToPolygon(
          p.nx + (Math.random() - 0.5) * HUDDLE_RING_RADIUS,
          p.ny + (Math.random() - 0.5) * HUDDLE_RING_RADIUS,
          walkablePolygon
        );
      }
    }
    return randomInsidePoly(walkablePolygon);
  }

  /**
   * Select 3..5 huddle participants: same eligibility shape as
   * pickSparringParticipants (not active, not conga/dance-off/sparring, not
   * dancing/emoting/seated/dazed/repairing). Returns null if fewer than
   * HUDDLE_MIN_PARTICIPANTS qualify.
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {string[]|null}
   */
  function pickHuddleParticipants(agentList) {
    const eligible = [];
    for (const a of agentList) {
      if (!a) continue;
      if (isMetricsAgentActive(a)) continue;
      const e = agentCharMap[a.id];
      if (!e) continue;
      if (e.congaIndex >= 0) continue;
      if (e.dancing || e.emoting) continue;
      if (e.sitting || e.sitSeatId != null) continue;
      if (e.dazePhase != null) continue;
      if (e.extinguishTargetId != null) continue;
      if (danceOffActive && (a.id === danceOffIdA || a.id === danceOffIdB)) continue;
      if (sparringActive && (a.id === sparringIdA || a.id === sparringIdB || sparringSpectatorIds.indexOf(a.id) >= 0)) continue;
      eligible.push(a.id);
    }
    if (eligible.length < HUDDLE_MIN_PARTICIPANTS) return null;
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
    }
    const count = Math.min(eligible.length, HUDDLE_MIN_PARTICIPANTS + Math.floor(Math.random() * (HUDDLE_MAX_PARTICIPANTS - HUDDLE_MIN_PARTICIPANTS + 1)));
    return eligible.slice(0, count);
  }

  /**
   * Start a huddle: pick participants, drop a ring anchor (pickHuddleAnchor),
   * compute one ring-slot stand point per participant, and send everyone
   * walking in.
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {boolean} true if a huddle actually started
   */
  function startHuddle(agentList) {
    const ids = pickHuddleParticipants(agentList);
    if (!ids) return false;
    const anchor = pickHuddleAnchor();
    huddleAnchorNx = anchor[0];
    huddleAnchorNy = anchor[1];
    huddleParticipantIds = ids;
    huddlePositions = ids.map((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2;
      return clampToPolygon(
        huddleAnchorNx + Math.cos(angle) * HUDDLE_RING_RADIUS,
        huddleAnchorNy + Math.sin(angle) * HUDDLE_RING_RADIUS,
        walkablePolygon
      );
    });
    for (let i = 0; i < ids.length; i++) {
      const e = agentCharMap[ids[i]];
      if (!e) continue;
      freeAgentSeat(e);
      e.destNx = huddlePositions[i][0];
      e.destNy = huddlePositions[i][1];
      e.settled = false;
    }
    huddleActive = true;
    huddlePhase = "walkin";
    huddleWalkinElapsed = 0;
    huddleSpeakerIdx = 0;
    huddleSpeakerTimeLeft = 0;
    huddleTimeLeft = 0;
    huddleDurationTotal = 0;
    huddleSleeperChosenId = (Math.random() < HUDDLE_SLEEP_JOKE_CHANCE)
      ? ids[Math.floor(Math.random() * ids.length)]
      : null;
    huddleSleeperFired = false;
    huddleListenerReactTimer = HUDDLE_LISTENER_REACT_INTERVAL_SEC;
    huddleStartRebirthCount = rebirthCount;
    return true;
  }

  /** Reset all module-level huddle state to inactive. No per-agent fields to
   *  clear — same "no stuck flags" reasoning as resetSparringState. */
  function resetHuddleState() {
    huddleActive = false;
    huddlePhase = "idle";
    huddleParticipantIds = [];
    huddlePositions = [];
    huddleAnchorNx = 0;
    huddleAnchorNy = 0;
    huddleWalkinElapsed = 0;
    huddleSpeakerIdx = 0;
    huddleSpeakerTimeLeft = 0;
    huddleTimeLeft = 0;
    huddleDurationTotal = 0;
    huddleSleeperChosenId = null;
    huddleSleeperFired = false;
  }

  /** Natural end (duration ran out). Speaker gets no special ending (product rule) — everyone just disperses. */
  function endHuddle() {
    huddleCooldown = HUDDLE_COOLDOWN_SECONDS;
    resetHuddleState();
  }

  /** Interruption path — rival arrival, rebirth, the group falling below
   *  HUDDLE_MIN_PARTICIPANTS, or (belt-and-braces) another party-style
   *  system somehow becoming active. */
  function cancelHuddle() {
    huddleCooldown = HUDDLE_COOLDOWN_SECONDS;
    resetHuddleState();
  }

  /**
   * Advance the huddle. Called once per frame, after updateSparring (so a
   * sparring exhibition that just started/ended this frame is already
   * reflected) and before the per-character loop.
   * @param {number} delta seconds
   * @param {Array<object>} agentList current sceneAgentList
   */
  function updateHuddle(delta, agentList) {
    if (huddleCooldown > 0) huddleCooldown = Math.max(0, huddleCooldown - delta);

    if (huddleActive) {
      // sparringActive is belt-and-braces here — see the matching note in
      // updateSparring's own preemption check above.
      if (activeEnemies.length > 0 || rebirthCount !== huddleStartRebirthCount || congaActive || discoPartyActive || danceOffActive || sparringActive) {
        cancelHuddle();
        return;
      }
      // Drop any participant that went active or vanished. If the group
      // falls below HUDDLE_MIN_PARTICIPANTS it no longer reads as a
      // "meeting" — disband entirely rather than limp on with 1-2 agents.
      for (let i = huddleParticipantIds.length - 1; i >= 0; i--) {
        const pid = huddleParticipantIds[i];
        const pAgent = agentList.find((a) => a && a.id === pid);
        const pEnt = agentCharMap[pid];
        if (!pAgent || !pEnt || isMetricsAgentActive(pAgent)) {
          huddleParticipantIds.splice(i, 1);
          huddlePositions.splice(i, 1);
          if (huddleSpeakerIdx >= huddleParticipantIds.length) huddleSpeakerIdx = 0;
        }
      }
      if (huddleParticipantIds.length < HUDDLE_MIN_PARTICIPANTS) {
        cancelHuddle();
        return;
      }

      if (huddlePhase === "walkin") {
        let allArrived = true;
        for (let i = 0; i < huddleParticipantIds.length; i++) {
          const e = agentCharMap[huddleParticipantIds[i]];
          const pos = huddlePositions[i];
          if (!e || !pos) continue;
          const dx = pos[0] - e.nx, dy = pos[1] - e.ny;
          if (Math.sqrt(dx * dx + dy * dy) > WANDER_ARRIVED_EPS + 2) allArrived = false;
        }
        huddleWalkinElapsed += delta;
        const timedOut = huddleWalkinElapsed >= HUDDLE_WALKIN_TIMEOUT_SEC;
        if (allArrived || timedOut) {
          for (let i = 0; i < huddleParticipantIds.length; i++) {
            const e = agentCharMap[huddleParticipantIds[i]];
            const pos = huddlePositions[i];
            if (!e || !pos) continue;
            e.nx = pos[0]; e.ny = pos[1];
            e.destNx = e.nx; e.destNy = e.ny; e.settled = true;
            e.facingLeft = (huddleAnchorNx - e.nx) < 0; // face inward, toward the ring center
          }
          huddlePhase = "active";
          huddleTimeLeft = HUDDLE_DURATION_MIN_SEC + Math.random() * (HUDDLE_DURATION_MAX_SEC - HUDDLE_DURATION_MIN_SEC);
          huddleDurationTotal = huddleTimeLeft;
          huddleSpeakerIdx = Math.floor(Math.random() * huddleParticipantIds.length);
          huddleSpeakerTimeLeft = HUDDLE_SPEAKER_TURN_SEC;
          const speakerEnt = agentCharMap[huddleParticipantIds[huddleSpeakerIdx]];
          if (speakerEnt) showExpression(speakerEnt, Math.random() < 0.5 ? 1 /* Idea */ : 3 /* Team */, HUDDLE_BUBBLE_DURATION_SEC);
        }
        return;
      }

      if (huddlePhase === "active") {
        huddleTimeLeft -= delta;
        huddleSpeakerTimeLeft -= delta;
        if (huddleSpeakerTimeLeft <= 0) {
          huddleSpeakerIdx = (huddleSpeakerIdx + 1) % huddleParticipantIds.length;
          huddleSpeakerTimeLeft = HUDDLE_SPEAKER_TURN_SEC;
          const speakerEnt = agentCharMap[huddleParticipantIds[huddleSpeakerIdx]];
          if (speakerEnt) showExpression(speakerEnt, Math.random() < 0.5 ? 1 /* Idea */ : 3 /* Team */, HUDDLE_BUBBLE_DURATION_SEC);
        }
        const speakerId = huddleParticipantIds[huddleSpeakerIdx];

        huddleListenerReactTimer -= delta;
        if (huddleListenerReactTimer <= 0) {
          huddleListenerReactTimer = HUDDLE_LISTENER_REACT_INTERVAL_SEC;
          for (const pid of huddleParticipantIds) {
            if (pid === speakerId) continue;
            const e = agentCharMap[pid];
            if (!e || Math.random() >= HUDDLE_LISTENER_REACT_CHANCE) continue;
            showExpression(e, Math.random() < 0.5 ? 4 /* Thumbs-up */ : 1 /* Idea */, 1.6);
          }
        }

        // Sleep joke (the bit): at most once per huddle, roughly mid-meeting,
        // never dropped on whoever is currently speaking.
        if (huddleSleeperChosenId && !huddleSleeperFired && speakerId !== huddleSleeperChosenId) {
          const elapsed = huddleDurationTotal - huddleTimeLeft;
          if (elapsed >= huddleDurationTotal / 2) {
            const sleeperEnt = agentCharMap[huddleSleeperChosenId];
            if (sleeperEnt) {
              showExpression(sleeperEnt, 6 /* Sleep */, 2.2);
              huddleSleeperFired = true;
            }
          }
        }

        if (huddleTimeLeft <= 0) endHuddle();
        return;
      }
      return;
    }

    // Not active. Random trigger — time-based (not per-frame), offset from
    // the sparring exhibition's own check cadence so the two interleave
    // naturally instead of always rolling on the same tick.
    huddleCheckTimer += delta;
    if (huddleCheckTimer < HUDDLE_CHECK_SECONDS) return;
    huddleCheckTimer = 0;
    if (agentList.length < HUDDLE_MIN_PARTICIPANTS || activeEnemies.length > 0 || huddleCooldown > 0 ||
        congaActive || discoPartyActive || danceOffActive || sparringActive || victoryLapActive || quakePanicActive) return;
    if (rebirthCount < HUDDLE_UNLOCK_REBIRTH) return;
    if (Math.random() >= HUDDLE_CHANCE) return;
    startHuddle(agentList);
  }

  // ── Victory lap (wave-clear celebration) ──────────────────────────────
  // Each non-empty→empty activeEnemies edge (a wave is fully cleared, i.e. a
  // "clash" completing) — see updateVictoryLap for the edge-trigger latch —
  // increments a session-local clash counter. Only every
  // VICTORY_LAP_CLASH_INTERVAL-th clash even ROLLS for a lap, and that roll
  // only succeeds VICTORY_LAP_CHANCE of the time; every other clash (wrong
  // multiple, or a failed roll) just returns agents to normal post-combat
  // idle with no lap and no dangling state (updateVictoryLap explicitly
  // drains victoryLapWaveParticipants on that path). On a hit, base form is
  // an ungated, ~2s "cheer" pose (via playEmote, the SAME
  // emoting/emoteClip/emoteTimeLeft one-shot mechanism point/signal/block
  // already use) on every agent that fought — purely cosmetic, never touches
  // movement/build/combat state, so it can't block the work loop even if
  // left to decay naturally. The Rebirth-5 upgrade (VICTORY_LAP_UNLOCK_REBIRTH)
  // makes the SAME moment longer and adds the shared party lighting/ball
  // (partyVisualIntensity/getActivePartyPalette — exactly like the conga/
  // disco party/dance-off) plus one pooled confetti burst
  // (spawnDanceOffConfetti). Mutually exclusive with all three of those (see
  // updateVictoryLap's own belt-and-braces check and the `|| victoryLapActive`
  // addition to each of their own idle-trigger gates).
  /** True while a victory lap (base or upgraded) is playing. */
  let victoryLapActive = false;
  /** True if the CURRENT run is the upgraded (lighting/ball/confetti)
   *  version — decided once, at start, from rebirthCount/goldPalettePreviewForced
   *  (see startVictoryLap) and never re-evaluated mid-run, so a rebirth or a
   *  preview toggle mid-lap can't change an already-playing celebration. */
  let victoryLapUpgraded = false;
  /** Seconds remaining in the current victory lap. */
  let victoryLapTimeLeft = 0;
  /** Snapshot of participant agent ids for the CURRENT run (taken from
   *  victoryLapWaveParticipants at start) — the set every clear/cancel path
   *  sweeps to release its emote fields. @type {string[]} */
  let victoryLapParticipantIds = [];
  /** Edge-trigger latch: whether activeEnemies held at least one enemy as of
   *  LAST frame. updateVictoryLap compares this against the current frame's
   *  count to detect the exact non-empty→empty transition — a level check
   *  (`activeEnemies.length === 0`) would instead fire on every frame the
   *  floor stays clear (almost always), not just the clearing instant. */
  let victoryLapPrevEnemiesPresent = false;
  /** Count of completed wave-clear "clashes" seen this session — used to gate
   *  the lap to every VICTORY_LAP_CLASH_INTERVAL-th one (see updateVictoryLap).
   *  Deliberately a plain session-local counter, not persisted anywhere — it
   *  resets to 0 on reload, which is fine for a purely cosmetic cadence. */
  let victoryLapClashCount = 0;
  /** Agent ids that engaged combat at any point during the CURRENT wave.
   *  Populated live by the per-character isEngaging block (see the
   *  `isEngaging = true` branch in the per-character loop) and drained by
   *  startVictoryLap. A running set is necessary rather than reading
   *  isEngaging at the clearing instant, because a defeated enemy FLEES for
   *  several frames before actually leaving the screen (see advanceEnemies'
   *  fleeing-prune filter) — during that tail every agent's isEngaging (and
   *  combatTargetInstanceId) already reads false again, which would
   *  otherwise erase who actually fought by the time activeEnemies truly
   *  empties. @type {Set<string>} */
  const victoryLapWaveParticipants = new Set();
  /** Duration (seconds) of the base, ungated victory-lap cheer. */
  const VICTORY_LAP_BASE_SECONDS = 2;
  /** Duration (seconds) of the Rebirth-5 upgraded celebration — long enough
   *  to read the shared lighting/ball ease in and out (DISCO_EASE_SECONDS
   *  each way, via partyEaseIntensity, same as the other three parties) plus
   *  a real hold in the middle. */
  const VICTORY_LAP_UPGRADED_SECONDS = 4;
  /** How many wave-clear clashes must complete before the next one even
   *  ROLLS for a lap (see victoryLapClashCount / updateVictoryLap). */
  const VICTORY_LAP_CLASH_INTERVAL = 5;
  /** Chance, on an eligible (every-Nth) clash, that a lap actually starts. */
  const VICTORY_LAP_CHANCE = 0.2;

  /**
   * Clear every field this feature writes on its participants
   * (emoting/emoteClip/emoteTimeLeft) — called by both endVictoryLap
   * (natural end) and cancelVictoryLap (rival arrival / belt-and-braces)
   * so neither exit path can miss one. Mirrors clearDanceOffParticipants'
   * shape. Guarded to only clear an emote THIS feature actually started
   * (clip still "cheer") so it can never stomp an unrelated emote (e.g. a
   * "block" hit-reaction) that started on the same agent after the lap began.
   */
  function clearVictoryLapParticipants() {
    for (const id of victoryLapParticipantIds) {
      const e = agentCharMap[id];
      if (!e || e.emoteClip !== "cheer") continue;
      e.emoting = false;
      e.emoteClip = null;
      e.emoteTimeLeft = 0;
    }
  }

  /** Natural end (timer ran out). On an upgraded run, lighting has already
   *  eased to ~0 via partyEaseIntensity by the time this fires (mirrors
   *  endConga/endDiscoParty/endDanceOff); a base run never touched
   *  partyVisualIntensity at all, so this is a no-op for it. */
  function endVictoryLap() {
    clearVictoryLapParticipants();
    if (victoryLapUpgraded) partyVisualIntensity = 0;
    victoryLapActive = false;
    victoryLapUpgraded = false;
    victoryLapTimeLeft = 0;
    victoryLapParticipantIds = [];
  }

  /**
   * Rival-arrival cancel path (and the belt-and-braces "another party
   * somehow started" path). Clears every participant's emote fields on the
   * SAME frame — before the per-character isEngaging gate runs later this
   * frame (updateVictoryLap is called alongside updateConga/updateDiscoParty/
   * updateDanceOff, early in render(), well before the per-character loop) —
   * and, on an upgraded run, snaps the shared lighting straight to 0 with no
   * ease-out, matching cancelDiscoParty/endConga/cancelDanceOff's rule that
   * the abruptness on a rival arrival is the point. Note: playEmote never
   * touched movement/build/combat state to begin with (isEngaging itself is
   * never gated on charEntry.emoting), so agents were always free to
   * re-engage even before this runs — this exists to stop the cosmetic
   * cheer pose/visuals cleanly rather than because anything was actually
   * blocking combat.
   */
  function cancelVictoryLap() {
    clearVictoryLapParticipants();
    if (victoryLapUpgraded) partyVisualIntensity = 0; // snap off, no ease-out
    victoryLapActive = false;
    victoryLapUpgraded = false;
    victoryLapTimeLeft = 0;
    victoryLapParticipantIds = [];
  }

  /**
   * Full victory-lap runtime reset for a scene transition where
   * activeEnemies itself is being hard-reset out from under this feature
   * (theme switch via THEME_INITIALIZED, and a metrics Reset — see their
   * call sites). Without this, two things go stale across the boundary:
   *   1. victoryLapPrevEnemiesPresent (the edge-trigger latch) can still
   *      read true from the OLD theme's last frame. The very next frame
   *      sees the freshly-reset activeEnemies as empty and reads that as a
   *      non-empty→empty transition, spuriously firing a lap with no combat
   *      having happened in the new theme/session.
   *   2. victoryLapWaveParticipants can still hold agent ids from the
   *      previous theme's roster, which no longer exist in the fresh
   *      agentCharMap.
   * Also cancels any lap actually in flight, since its participants may no
   * longer exist (or, on a metrics Reset, rebirthCount/getActivePartyPalette
   * just changed under it). Safe to call even when nothing is in flight.
   */
  function resetVictoryLapForSceneReset() {
    if (victoryLapActive) cancelVictoryLap();
    victoryLapPrevEnemiesPresent = false;
    victoryLapWaveParticipants.clear();
  }

  /**
   * Start a victory lap. Snapshots this wave's participants (from
   * victoryLapWaveParticipants — see its own doc), or, when overrideAgentList
   * is given (the Alt+L debug/preview hotkey), sweeps every currently
   * on-stage agent instead — mirroring the whole-cast preview convention
   * startConga/startDiscoParty/startDanceOff already use for THEIR hotkeys —
   * so Alt+L is useful for testing even when no real wave has been fought
   * yet. Pops a "cheer" pose on each participant via the EXISTING
   * emoting/emoteClip/emoteTimeLeft one-shot mechanism (playEmote — the same
   * fields the point/signal/block emotes use), which is purely cosmetic and
   * self-reverts on its own once emoteTimeLeft decays, needing no active
   * state machine for that part.
   *
   * Whether THIS run is the upgraded version is decided once, here, from
   * rebirthCount >= VICTORY_LAP_UNLOCK_REBIRTH OR the Alt+P gold-preview
   * override (goldPalettePreviewForced) — the same override
   * getActivePartyPalette reads — so pressing Alt+P first, then Alt+L, is
   * how a player below Rebirth 5 previews the upgraded celebration. Upgraded
   * runs additionally get the shared party lighting/ball
   * (partyVisualIntensity, same start pattern startConga/startDiscoParty/
   * startDanceOff use) and one confetti burst (spawnDanceOffConfetti) at the
   * centroid of the participants' last-known canvas position, and run via
   * victoryLapActive/victoryLapTimeLeft so a rival arriving mid-lap has
   * explicit state to cancel.
   * @param {Array<object>} [overrideAgentList] when given, sweep every id in
   *   this list instead of the tracked wave participants (Alt+L only).
   * @returns {boolean} true if a lap actually started (false if there was
   *   nobody to celebrate with).
   */
  function startVictoryLap(overrideAgentList) {
    const upgraded = goldPalettePreviewForced || rebirthCount >= VICTORY_LAP_UNLOCK_REBIRTH;
    const ids = overrideAgentList
      ? overrideAgentList.map((a) => a.id)
      : Array.from(victoryLapWaveParticipants);
    victoryLapWaveParticipants.clear();
    if (ids.length === 0) return false; // nobody actually fought this wave — nothing to celebrate
    victoryLapActive = true;
    victoryLapUpgraded = upgraded;
    victoryLapTimeLeft = upgraded ? VICTORY_LAP_UPGRADED_SECONDS : VICTORY_LAP_BASE_SECONDS;
    victoryLapParticipantIds = ids;
    let cx = 0, cy = 0, posCount = 0;
    for (const id of ids) {
      const e = agentCharMap[id];
      if (!e) continue;
      playEmote(e, "cheer", victoryLapTimeLeft);
      if (typeof e.x === "number" && typeof e.y === "number") { cx += e.x; cy += e.y; posCount++; }
    }
    if (upgraded) {
      partyVisualStartMs = nowMs();
      if (goldPalettePreviewActive) {
        // Handoff — see handOffGoldPalettePreviewToParty's doc: keep the
        // CURRENT partyVisualIntensity so the lap's ease-in continues
        // smoothly from wherever the preview was, instead of snapping to black.
        handOffGoldPalettePreviewToParty();
      } else {
        partyVisualIntensity = 0; // eases in over DISCO_EASE_SECONDS via updateVictoryLap
      }
      if (posCount > 0) spawnDanceOffConfetti(cx / posCount, cy / posCount);
    }
    return true;
  }

  /**
   * Advance the wave-clear victory lap. Called once per frame, in the SAME
   * block as updateConga/updateDiscoParty/updateDanceOff (see render()) —
   * BEFORE the per-character isEngaging gate, so a rival arriving mid-lap
   * cancels it and lets agents re-engage the same frame the rival appears,
   * matching those three systems' ordering guarantee.
   * @param {number} delta seconds
   */
  function updateVictoryLap(delta) {
    const enemiesPresentNow = activeEnemies.length > 0;
    if (victoryLapActive) {
      // Belt-and-braces: a conga/disco party/dance-off must never own
      // character state at the same time as a victory lap. All three now
      // refuse to start while victoryLapActive is true (see the
      // `|| victoryLapActive` addition to each of their own idle-trigger
      // gates), so this should be unreachable — but if it ever happens,
      // cancel cleanly rather than let two systems fight over these
      // participants. Mirrors updateDanceOff's own congaActive/discoPartyActive
      // check.
      if (congaActive || discoPartyActive || danceOffActive) {
        cancelVictoryLap();
        victoryLapPrevEnemiesPresent = enemiesPresentNow;
        return;
      }
      // Rival arrival ends it immediately — same product rule as the other
      // three ("if rivals arrive, the celebration is over").
      if (enemiesPresentNow) {
        cancelVictoryLap();
        victoryLapPrevEnemiesPresent = enemiesPresentNow;
        return;
      }
      victoryLapTimeLeft -= delta;
      if (victoryLapUpgraded) {
        partyVisualIntensity = partyEaseIntensity(victoryLapTimeLeft, VICTORY_LAP_UPGRADED_SECONDS);
      }
      if (victoryLapTimeLeft <= 0) endVictoryLap();
      victoryLapPrevEnemiesPresent = enemiesPresentNow;
      return;
    }

    // Not active. Edge-triggered: only evaluate on the exact non-empty→empty
    // transition (this frame has none, but LAST frame had at least one) —
    // a level check here would instead fire every frame the floor stays
    // clear, which is almost always. Also refuses while a conga/disco
    // party/dance-off is running — a wave clearing during one of those
    // simply doesn't count as a clash at all (see the header comment above).
    if (victoryLapPrevEnemiesPresent && !enemiesPresentNow && !congaActive && !discoPartyActive && !danceOffActive) {
      // Every clash increments the counter; only every VICTORY_LAP_CLASH_INTERVAL-th
      // one even rolls, and that roll only hits VICTORY_LAP_CHANCE of the time.
      victoryLapClashCount++;
      const eligible = victoryLapClashCount % VICTORY_LAP_CLASH_INTERVAL === 0;
      if (eligible && Math.random() < VICTORY_LAP_CHANCE) {
        startVictoryLap();
      } else {
        // No lap this clash — agents simply return to work like any other
        // post-combat moment. startVictoryLap() is the only thing that
        // normally drains victoryLapWaveParticipants, so a clash that skips
        // it must clear the set itself here or the NEXT wave's fighters
        // would inherit stale ids from this uncelebrated one.
        victoryLapWaveParticipants.clear();
      }
    }
    victoryLapPrevEnemiesPresent = enemiesPresentNow;
  }

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
  // Derived (Plan p2-t3, not hardcoded): a turret shot deals
  // TURRET_DAMAGE_FRACTION (0.1, one tenth) of an agent's DPS, amortized over
  // the turret's own fire interval — 40 * 0.1 * (1000ms/1000) = 4 HP/shot.
  // Stays anchored to AGENT_DPS/TURRET_FIRE_INTERVAL_MS if either is retuned.
  const TURRET_HIT_DAMAGE = AGENT_DPS * TURRET_DAMAGE_FRACTION * (TURRET_FIRE_INTERVAL_MS / 1000);
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
