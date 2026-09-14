// Part: 120-agent-dance-render-init
// Agent dance/emote/expression drawing, projectile/enemy updates, main render loop, and init/IIFE close.
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
   * @param {boolean} [force=false] bypass BUBBLE_COOLDOWN_SEC. Reserved for
   *   rare, deliberate, whole-cast celebrations (disco party / conga line) —
   *   NOT for ambient ("ambient chatter") ones, which must keep their spam
   *   protection. Every other call site omits this and is unaffected. A
   *   forced bubble deliberately does NOT (re)start the cooldown either —
   *   see the comment above the cooldown write below.
   */
  function showExpression(entry, index, durationSec, force) {
    if (!entry || index < 0 || index > 7) return;
    // Non-interruptible: while this entry's persistent lead "team active"
    // bubble is showing (see drawTeamBubble), no other expression may
    // preempt it. The team-completion thumbs-up (index 4) is called AFTER
    // teamActive is cleared, so it is unaffected by this guard.
    if (entry.teamActive) return;
    if (!force && (entry.bubbleCooldown || 0) > 0) return; // shared per-agent rate limit
    const frames = themeImages && themeImages["expression_" + index];
    if (!frames || !frames[0]) return; // theme has no expression atlas -> no bubble
    entry.bubbleExpr = index;
    entry.bubbleTimeLeft = durationSec;
    // Non-forced (ambient) bubbles start the shared cooldown as before. A
    // forced (party) bubble deliberately leaves bubbleCooldown untouched —
    // it must not suppress a legitimate ambient bubble later, and repeatedly
    // re-triggering the party (e.g. the D-key) must not be blocked by an
    // earlier party's own forced bubble either.
    if (!force) entry.bubbleCooldown = BUBBLE_COOLDOWN_SEC;
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

  // debug hotkey: Alt+C=conga, Alt+D=disco party, Alt+O=dance-off, Alt+L=
  // victory lap, Alt+Q=rebirth-profile quake, Alt+Shift+Q=ambient-profile
  // quake (the former f=fast-forward-build debug instabuild hotkey was
  // removed — F is now the Edit-Stage flip shortcut above; the poof/build
  // flow it used to shortcut is confirmed working on its own). All of these
  // easter-egg hotkeys require the Alt modifier specifically (product ask:
  // make them a little harder to trigger by accident) — Ctrl/Meta
  // combinations must NOT fire any of them. None of the other branches below
  // check e.shiftKey (Alt+Shift+<letter> already falls into the matching
  // Alt+<letter> branch since e.key lowercases the same either way) — the
  // quake branch is the first one that needs Shift to pick between two
  // profiles, so it checks e.shiftKey explicitly inside its own block.
  // Reserved letters — do NOT bind: f e s v g r t h (VS Code/Antigravity menu
  // mnemonics: File/Edit/Selection/View/Go/Run/Terminal/Help) and z (VS Code
  // toggle word wrap). Letters currently taken: c d o l p q.
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    const key = (e.key || "").toLowerCase();
    if (key === "c" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Force-start a conga now (ignore eligibility/cooldown/probability) —
      // but NOT the safety gates: refuses while a party is already running,
      // while a rival is present (previously missing here — updateConga's
      // own random trigger already checked this; the hotkey now matches),
      // or while a disco party or dance-off is active (mutual exclusion —
      // see updateDiscoParty/updateConga/updateDanceOff), or while a victory
      // lap is playing (see updateVictoryLap) — without this check the
      // hotkey could start a second system on the same agents for a frame,
      // relying on updateVictoryLap's belt-and-braces to clean it up next
      // frame instead of never letting it happen. The conga stays
      // fully ungated by rebirth — only the disco dance party (below) is an
      // advertised unlock (see DANCE_PARTY_UNLOCK_REBIRTH).
      if (congaActive) return;
      if (activeEnemies.length > 0) return;
      if (discoPartyActive) return;
      if (danceOffActive) return;
      if (victoryLapActive) return;
      if (lastAgentList.length < 1) return;
      startConga(lastAgentList);
    }
    if (key === "d" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Force-start a disco party now (ignores DISCO_COOLDOWN_SECONDS and the
      // random probability, mirroring the conga debug hotkey above) —
      // but NOT the safety gates: refuses while a party is already running,
      // while a rival is present (product rule: rivals also BLOCK a party
      // from starting, not just end one), during a conga or dance-off, or
      // below the advertised unlock rebirth (DANCE_PARTY_UNLOCK_REBIRTH —
      // mirrors the random trigger's gate in updateDiscoParty; a gate the
      // hotkey bypasses isn't a real gate).
      // Reduced-motion note: this still triggers the dancing for
      // prefers-reduced-motion users — only drawDiscoOverlay's lighting pass
      // is suppressed for them (see its doc comment) — so Alt+D remains a
      // useful, motion-safe way to see the dance without the flashing lights.
      if (discoPartyActive) return;
      if (activeEnemies.length > 0) return;
      if (congaActive) return;
      if (danceOffActive) return;
      // Also refuses while a victory lap is playing (see updateVictoryLap) —
      // same gate-not-a-frame-later-patch reasoning as the Alt+C branch above.
      if (victoryLapActive) return;
      if (rebirthCount < DANCE_PARTY_UNLOCK_REBIRTH) return;
      if (lastAgentList.length < 1) return;
      startDiscoParty();
    }
    if (key === "o" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Force-start a dance-off now (ignores DANCE_OFF_COOLDOWN_SECONDS and
      // the random probability, mirroring the conga/disco debug hotkeys
      // above) — but NOT the safety gates: refuses while a party is already
      // running, while a rival is present, or during a conga/disco party
      // (mutual exclusion — see updateConga/updateDiscoParty/updateDanceOff),
      // or below the advertised unlock rebirth (DANCE_OFF_UNLOCK_REBIRTH —
      // mirrors the random trigger's gate in updateDanceOff; a gate the
      // hotkey bypasses isn't a real gate).
      // Reduced-motion note: same as Alt+D — this still triggers the actual
      // dance-off; only the shared lighting/ball pass is suppressed for
      // those users (drawDiscoOverlay/drawDiscoBall self-guard on
      // prefersReducedMotion).
      if (danceOffActive) return;
      if (activeEnemies.length > 0) return;
      if (congaActive) return;
      if (discoPartyActive) return;
      // Also refuses while a victory lap is playing (see updateVictoryLap) —
      // same gate-not-a-frame-later-patch reasoning as the Alt+C/D branches above.
      if (victoryLapActive) return;
      if (rebirthCount < DANCE_OFF_UNLOCK_REBIRTH) return;
      if (lastAgentList.length < 2) return;
      startDanceOff(lastAgentList);
    }
    if (key === "p" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Preview-only toggle for the Rebirth-6 gold party palette (see
      // GOLD_PALETTE_UNLOCK_REBIRTH / getActivePartyPalette) — lets the
      // product owner SEE the palette before it's actually earned. Unlike
      // Alt+C/D/O above this doesn't start anything and carries no
      // eligibility/party-state gates — it only flips which colors the NEXT
      // party paint (or an already-running one) reads. In-memory only:
      // never writes rebirthCount, never persists, never posts to the host.
      // Pressing it again reverts to the rebirth-derived palette.
      goldPalettePreviewForced = !goldPalettePreviewForced;
      // eslint-disable-next-line no-console -- deliberate: makes the preview
      // override observable so it never reads as a real unlock.
      console.log(`[preview] gold party palette override: ${goldPalettePreviewForced ? "ON — Alt+P to revert" : "off"}`);
      if (goldPalettePreviewForced) {
        // With no party running the palette flip alone is invisible (every
        // consumer of getActivePartyPalette() is gated on
        // partyVisualIntensity > 0) — kick off a short standalone preview so
        // the lighting/ball are actually visible. If a real party is already
        // showing those same visuals, the flip alone is enough (see
        // startGoldPalettePreview's doc) — do nothing extra.
        if (!congaActive && !discoPartyActive && !danceOffActive && !victoryLapActive) {
          startGoldPalettePreview();
        }
      } else if (goldPalettePreviewActive) {
        // Reverting mid-preview ends it cleanly rather than leaving the
        // lighting/ball hanging on the palette that was just turned off.
        endGoldPalettePreview();
      }
    }
    if (key === "l" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Preview/debug hotkey: force-start a wave-clear victory lap now (see
      // updateVictoryLap/startVictoryLap). Unlike Alt+C/D/O this has no
      // eligibility-roll or real wave to draw participants from, so it
      // sweeps the CURRENT roster instead (startVictoryLap's
      // overrideAgentList path) — mirrors the whole-cast preview convention
      // those three already use for their own hotkeys. Refuses while already
      // running, while a rival is present, or during a conga/disco
      // party/dance-off (same mutual-exclusion rule the real trigger follows
      // — see updateVictoryLap). Carries NO rebirth gate of its own: the
      // base cheer is ungated from the start, and startVictoryLap's own
      // upgraded/base decision (rebirthCount >= VICTORY_LAP_UNLOCK_REBIRTH,
      // OR the Alt+P gold-preview override just above) already decides which
      // version plays — so pressing Alt+P first, THEN Alt+L, is how a player
      // below Rebirth 5 previews the upgraded (longer, lit, confetti)
      // celebration.
      if (victoryLapActive) return;
      if (activeEnemies.length > 0) return;
      if (congaActive || discoPartyActive || danceOffActive) return;
      if (lastAgentList.length < 1) return;
      startVictoryLap(lastAgentList);
    }
    if (key === "q" && e.altKey && !e.ctrlKey && !e.metaKey) {
      // Debug/preview hotkeys for the quake engine (see startQuake). Alt+Q
      // (rebirth-profile shake) carries NO eligibility/party-state gates — a
      // plain camera shake never touches agent behavior or party state, so
      // there's nothing to conflict with. Alt+Shift+Q is different: it now
      // triggers the FULL ambient event (shake + panic — see "Quake panic"
      // near the quake engine), which DOES drive agent movement, so it goes
      // through the same start guard the random scheduler uses
      // (triggerAmbientQuake/quakeAmbientBlockedReason) — a no-op with a
      // console.log reason when suppressed by rivals or another ambient
      // activity, same as every other party hotkey's belt-and-braces style.
      if (e.shiftKey) {
        // Alt+Shift+Q → full ambient quake event: QUAKE_AMBIENT_DURATION
        // shake + panic, and stamps quakeAmbientCooldown same as the random
        // trigger (see triggerAmbientQuake) so a manual preview still counts
        // against the rarity budget.
        triggerAmbientQuake(lastAgentList, "hotkey");
      } else {
        // Alt+Q → rebirth-profile quake, VISUAL ONLY: does NOT call
        // doRebirth() and does not touch rebirthCount, badges, or build
        // state — just the same camera shake + dust the real rebirth wipe
        // triggers, for testing/tuning the effect without burning a rebirth.
        startQuake("rebirth", capturedBuiltObjectPositions());
      }
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
      // p2-t3: turret-hit stagger countdown (repel). Decremented for every
      // enemy every frame, including fleeing ones (harmless — a fleeing
      // rival already skips the structure-attack gate below via en.fleeing).
      // While turretStaggerT > 0, updateObjectSmoke's `engaged` check
      // excludes this rival, so it stops ramping structure damage — the
      // turret shot's "repel" effect.
      if (en.turretStaggerT > 0) en.turretStaggerT -= delta;
      // p2-t3: authoritative hp<=0 eviction, runs for EVERY enemy every
      // frame — not just one an agent happens to have picked as `nearest`.
      // The render-loop combat pass (~L13691) already evicts hp<=0 targets
      // it is actively engaging, but a rival a TURRET is shooting may never
      // be any agent's nearest pick, so its hp could run arbitrarily
      // negative and it would never flee. Guarded on !en.fleeing so this can
      // never double-fire against (or conflict with) the render-loop check —
      // whichever site sees hp<=0 first flips fleeing=true, and the other's
      // `!fleeing` guard then skips it. Replicates the SAME fields the
      // render-loop eviction sets to start the flee-off-edge behavior
      // (hp clamp, fleeing, targetAgentId clear, hit bubble, flee dest
      // toward the nearest edge). Deliberately omits the victory-dance
      // celebration block — that reads the specific charEntry who landed
      // the killing blow, which doesn't exist in this per-enemy loop.
      if (en.hp <= 0 && !en.fleeing) {
        en.hp = 0;
        en.fleeing = true;
        en.targetAgentId = null;
        showExpression(en, 7, HURT_EXPR_SEC);
        const dLeft = en.nx;
        const dRight = walkableNativeW - en.nx;
        const dTop = Infinity; // rivals must never flee up/through the ceiling — only left/right/down
        const dBottom = walkableNativeH - en.ny;
        const minEdge = Math.min(dLeft, dRight, dTop, dBottom);
        const FLEE_MARGIN = 120;
        if (minEdge === dLeft) {
          en.fleeDestNx = -FLEE_MARGIN;
          en.fleeDestNy = en.ny;
        } else if (minEdge === dRight) {
          en.fleeDestNx = walkableNativeW + FLEE_MARGIN;
          en.fleeDestNy = en.ny;
        } else if (minEdge === dTop) {
          en.fleeDestNx = en.nx;
          en.fleeDestNy = -FLEE_MARGIN;
        } else {
          en.fleeDestNx = en.nx;
          en.fleeDestNy = walkableNativeH + FLEE_MARGIN;
        }
      }
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
        if (en.attackStyle === "ranged" && targetDist > ENEMY_ENGAGE_RANGE) {
          // Vertical alignment gate — mirrors the character ranged-shooter
          // check (~13322-13324): only fire when the shot is near-horizontal
          // (within MAX_SHOT_SLOPE grade). Previously rivals fired with no
          // alignment check at all, so a ranged rival off-row from its target
          // fired steeply up/down instead of near-horizontally like agents.
          const enSdx = Math.abs(targetEnt.nx - en.nx);
          const enSdy = Math.abs(targetEnt.ny - en.ny);
          const enShotAligned = enSdy <= MAX_SHOT_SLOPE * Math.max(enSdx, 1);
          if (!enShotAligned) {
            // Misaligned — vertical-align toward the target's row instead of
            // firing this frame, mirroring the agent-side destNy alignment
            // nudge (~13274). Rivals have no destNx/destNy queue while in
            // "attack" combat mode (they otherwise hold position), so step
            // en.ny directly here; en.nx is left untouched (holds position
            // horizontally, same as the agent side holding destNx).
            const alignDy = targetEnt.ny - en.ny;
            const alignStep = Math.min(ENEMY_WALK_SPEED * delta, Math.abs(alignDy));
            en.ny += Math.sign(alignDy) * alignStep;
            const enAlignClamped = clampToPolygon(en.nx, en.ny, walkablePolygon);
            en.nx = enAlignClamped[0];
            en.ny = enAlignClamped[1];
          } else if (en.shotCooldown <= 0) {
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

    // Quake engine: advance on the same pause-aware delta as everything else
    // in render() (see updateQuake's doc). Amplitude is computed once per
    // frame in canvas px (native-px quakeAmplitude() × the same
    // themeOverallScale/sceneFitScale factor every other native-sized draw
    // uses) and reused below for both the whole-scene camera translate and
    // each agent's smaller secondary jitter. Reduced-motion users get 0 here
    // — no camera shake, no per-agent jitter — dust puffs are unaffected
    // (spawnQuakeDust doesn't consult this at all).
    updateQuake(delta);
    const quakeAmpCanvas = prefersReducedMotion ? 0 : quakeAmplitude() * themeOverallScale * sceneFitScale;
    const [quakeCamX, quakeCamY] = quakeCameraOffset(quakeAmpCanvas);

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

    // Quake camera translate: ONE wrap point around the whole scene draw
    // (background through the disco/dance-off overlays below), restored just
    // before the stage-editor overlay/loading-bar/HUD/rebirth-confetti layers
    // — those stay static so edit handles and UI text never shake. A pure
    // ctx-transform push; nothing under it needs to know it's shaking.
    ctx.save();
    ctx.translate(quakeCamX, quakeCamY);

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
      // Plain dark fill always underlies the fallback (and is ALL that's drawn
      // while themeStageState is still 'pending' — the boot loader/loading
      // screen owns that moment, so no sky/ground fallback paints under or
      // instead of it; see themeStageState above).
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, w, h);

      if (themeStageState !== "pending") {
        // Sky gradient strip
        const grad = ctx.createLinearGradient(0, 0, 0, h * 0.7);
        grad.addColorStop(0, "#0d1b3e");
        grad.addColorStop(1, "#1a2a50");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h * 0.7);

        if (fallbackStageMessage) {
          ctx.save();
          ctx.fillStyle = "#ffb4b4";
          ctx.font = "13px var(--vscode-font-family, sans-serif)";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(fallbackStageMessage, w / 2, 8);
          ctx.restore();
        }
      }
    }

    // Ground band (pre-theme backdrop only — no entities are drawn on it; and
    // not while themeStageState is still 'pending' — see above)
    const groundY = Math.floor(h * 0.78);
    if (themeStageState !== "pending" && (!themeLoaded || !themeBackgroundImg || !themeBackgroundImg.complete)) {
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
    // Per-spawn instance actors (AgentMetric.liveSpawns, src/core/state.ts):
    // when two or more concurrent Task spawns are routed to the same agent
    // id, add one extra scene entry per instance beyond the first so each
    // concurrent spawn gets its own on-stage actor instead of sharing one.
    // Extras are shallow clones of the primary agent's metric row, keyed as
    // "<id>#<n>" (n >= 2) so they flow through every existing per-agent
    // system below (isoSlotHome placement, agentCharMap init/prune, worker
    // state lookup) exactly like a normal roster entry — sharing the same
    // sprite/accent (all fields except id/name are copied verbatim) and
    // labeled with a "#n" suffix. Retired automatically the frame liveSpawns
    // shrinks: they simply stop being emitted here, and the existing
    // agentCharMap prune step (agentIds derived from sceneAgentList, just
    // below) deletes the now-absent id like any other agent leaving the roster.
    if (sceneAgentList.some((a) => Array.isArray(a.liveSpawns) && a.liveSpawns.length > 1)) {
      const expanded = [];
      for (const a of sceneAgentList) {
        expanded.push(a);
        const count = Array.isArray(a.liveSpawns) ? a.liveSpawns.length : 1;
        for (let n = 2; n <= count; n++) {
          expanded.push({ ...a, id: `${a.id}#${n}`, name: `${a.name || a.id} #${n}` });
        }
      }
      sceneAgentList = expanded;
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
      updateDiscoParty(delta, sceneAgentList);
      updateDanceOff(delta, sceneAgentList);
      // Rebirth-2 ambient activities — plain character animation, not a
      // lighting event, so these don't touch partyVisualIntensity. Run after
      // the three parties above (so this frame's congaActive/
      // discoPartyActive/danceOffActive already reflect anything that just
      // started/ended) and before the per-character loop (so a preemption
      // clears inSparring/inHuddle in time for combat/build to resume the
      // same frame). Each also reads victoryLapActive in its own random-
      // trigger gate — that one lags by a frame here (updateVictoryLap runs
      // after these two), same one-frame tolerance every other ambient
      // system's ordering already accepts. See updateSparring/updateHuddle.
      updateSparring(delta, sceneAgentList);
      updateHuddle(delta, sceneAgentList);
      // Ambient quake event (shake + panic — see the "Quake panic" section
      // near the quake engine). The scheduler's random trigger reads
      // congaActive/discoPartyActive/danceOffActive/sparringActive/
      // huddleActive/victoryLapActive via quakeAmbientBlockedReason, so it
      // runs after all five of those (same ordering rationale as
      // updateSparring/updateHuddle above); the preemption/natural-end-linger
      // check runs before the per-character loop so a same-frame rival
      // arrival clears inQuakePanic in time for combat to resume THIS frame,
      // and reads this frame's quakeActive (updateQuake already ran earlier
      // in render() — see its own call site) so a natural end is caught the
      // same frame it happens, not one frame late.
      updateQuakePanic(delta);
      updateQuakeAmbientScheduler(delta, sceneAgentList);
      // Runs AFTER the three parties (so this frame's congaActive/
      // discoPartyActive/danceOffActive already reflect anything that just
      // started/ended this same frame — no same-frame race, same reasoning
      // as updateConga's own ordering note) and BEFORE updateDanceOffConfetti
      // (so a confetti burst spawned by startVictoryLap gets its first tick
      // this same frame, matching how updateDanceOff's own confetti spawn
      // already precedes it).
      updateVictoryLap(delta);
      // Call position here does NOT matter for correctness — see
      // updateGoldPalettePreview's own doc for why it's order-independent.
      // Kept in this slot (before updateDanceOffConfetti) purely to read
      // alongside the other four party updates above.
      updateGoldPalettePreview(delta);
      updateDanceOffConfetti(delta);
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
    // Turret auto-fire (Plan p2-t2): AFTER buildState is derived (needs
    // builtIds) and AFTER activeEnemies targeting above, same phase as the
    // other per-object update passes. Cosmetic-only for now (see doc comment).
    updateTurrets(delta, buildState.builtIds);
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
        // Turret rule: clear any in-flight fire-animation countdown so a
        // demolished/reset turret doesn't resume mid-cycle with stale timing
        // once it's rebuilt and goes idle again.
        entry.turretFireAnimT = 0;
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
        const isAnimatedArt = objImg && objImg.length > 1;
        // Turret rule: non-turret animated objects animate on AGENT
        // PROXIMITY (unchanged below); an object flagged is_turret is carved
        // out of that entirely and instead animates ONE FULL CYCLE PER SHOT,
        // driven by the fire signal updateTurrets writes at its
        // spawnProjectile call site (turretFireAnimT + reset frame/elapsed).
        // No proximity check runs for turrets at all — standing next to one
        // does nothing. turretObjectIds is read live here, so a turret that
        // stops being flagged (theme swap) simply falls through to ordinary
        // proximity behavior next frame, and a DAMAGED turret is naturally
        // still: updateTurrets' smoke.damage>0 guard `continue`s before ever
        // reaching the fire site, so it never arms turretFireAnimT.
        if (turretObjectIds.has(objId)) {
          if (isAnimatedArt) {
            if ((entry.turretFireAnimT || 0) > 0) {
              entry.turretFireAnimT -= delta;
              advanceObjectAnim(entry.animState, delta);
            } else {
              entry.turretFireAnimT = 0;
              // Rest on the first frame between shots.
              entry.animState.frameIndex = 0;
              entry.animState.elapsed = 0;
            }
          } else {
            advanceObjectAnim(entry.animState, delta); // static art: unchanged (holds frame 0 via modulo)
          }
        } else if (isAnimatedArt) {
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
          // Timer until next quake-panic destination re-pick (see the
          // "Quake panic" section near the quake engine and inQuakePanic's
          // derivation above) — defaults to 0 so a mid-panic new roster
          // entry re-targets on its very next eligible frame rather than
          // waiting on an undefined countdown.
          quakePanicTimer: 0,
          // Timer until next quake-panic EXPRESSION bubble re-pick (see
          // QUAKE_PANIC_EXPR_* and startQuakePanic's stagger seed) —
          // independent of quakePanicTimer (movement); same
          // defaults-to-0/reseeded-on-start reasoning.
          quakePanicExprTimer: 0,
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
          // Disco-party music-bubble stagger (seeded by startDiscoParty,
          // consumed/fired by updateDiscoParty — see DISCO_BUBBLE_* above).
          discoBubbleDelay: 0,
          discoBubbleFired: false,
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
          // Ambient idle poses (freed-frames, plan p10-t4): mirrors
          // AmbientPoseState in src/webview/animationPlayback.ts.
          standingBack: false,
          prevIsMoving: false,
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

      // Cross-vendor accent (p24-t2): "fallback" | "foreign" | "native",
      // decided by the single pure source of truth in 005-agent-accent.js.
      // harnessEffective is read live off the shared `lastSettings` (declared
      // in 080-packs-events.js, same concatenated webview scope) so switching
      // the harness select flips accents on the very next render() frame —
      // no separate recompute pass needed.
      var accentHarness = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
      charEntry.accentKind = agentAccent({
        vendor: agent.vendor,
        costModelClass: agent.costModelClass,
        fallbackOf: agent.fallbackOf,
        harness: accentHarness,
      });
      // dfb (p31-t2): default-fallback dispatches get "(dfb)" instead of
      // "(fb)" on the nameplate/tooltip label below — same accent color,
      // distinct suffix so a viewer can tell "a fallback" from "THE default
      // fallback" at a glance.
      charEntry.accentIsDefault = !!agent.fallbackIsDefault;

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
      // Dance-off enrollment (live-derived, mirrors inConga's derivation
      // style): true for exactly the two participants while a dance-off is
      // active, across ALL its phases (walkin/duel/celebrate) — see
      // updateDanceOff. Used below to extend every inConga exclusion gate
      // (engage/build/wander/extinguish) rather than inventing a parallel
      // mechanism, per the same "fully preempts" contract inConga has.
      const inDanceOff = danceOffActive && (charEntry.__id === danceOffIdA || charEntry.__id === danceOffIdB);
      // Sparring/huddle enrollment (live-derived, mirrors inDanceOff's
      // derivation style): true for the sparring pair + its ring spectators,
      // or the huddle's ring, while that respective ambient activity is
      // active — see updateSparring/updateHuddle. Threaded through every
      // engage/build/wander/extinguish exclusion inDanceOff already extends,
      // per the same "fully preempts" contract.
      const inSparring = sparringActive && (charEntry.__id === sparringIdA || charEntry.__id === sparringIdB || sparringSpectatorIds.indexOf(charEntry.__id) >= 0);
      const inHuddle = huddleActive && huddleParticipantIds.indexOf(charEntry.__id) >= 0;
      // Quake-panic enrollment (see the "Quake panic" section near the quake
      // engine, and updateQuakePanic/triggerAmbientQuake): unlike
      // inConga/inDanceOff/inSparring/inHuddle above, this is NOT a small
      // picked participant set — the ambient quake event can never start (or
      // survive) while any rival is alive (quakeAmbientBlockedReason refuses
      // to start with one present; a rival arriving mid-quake preempts the
      // whole event immediately — see updateQuakePanic), so there is never a
      // combat agent to exclude by hand and every eligible agent panics at
      // once. Dazed is the one exception — mirrors pickSparringParticipants/
      // pickHuddleParticipants excluding dazePhase != null — a recovering
      // agent keeps its seat-seek/recovery animation instead of being pulled
      // into a panic sprint. Threaded through every engage/build/idle/
      // extinguish/wander exclusion inDanceOff already extends, per the same
      // "fully preempts" contract.
      const inQuakePanic = quakePanicActive && charEntry.dazePhase == null;
      if (inQuakePanic) {
        // A panicking agent never dances or sits — mirrors inConga's own
        // dancing/seat clear above.
        charEntry.dancing = false;
        charEntry.danceTimeLeft = 0;
        if (charEntry.sitting || charEntry.sitSeatId != null) freeAgentSeat(charEntry);
        charEntry.quakePanicTimer -= delta;
        if (charEntry.quakePanicTimer <= 0) {
          const dest = randomInsidePoly(walkablePolygon);
          charEntry.destNx = dest[0];
          charEntry.destNy = dest[1];
          charEntry.settled = false;
          charEntry.quakePanicTimer = QUAKE_PANIC_INTERVAL_MIN + Math.random() * (QUAKE_PANIC_INTERVAL_MAX - QUAKE_PANIC_INTERVAL_MIN);
        }
        // Frequent panic expression bubble (product direction, distinct from
        // the sparring/dance-off/huddle "no Dazed/Anger" rule): equal random
        // pick from QUAKE_PANIC_EXPR_POOL (Team/Anger/Idea/Dazed), on its own
        // independent stagger timer (QUAKE_PANIC_EXPR_*, seeded by
        // startQuakePanic). force=true bypasses the 60s BUBBLE_COOLDOWN_SEC
        // (same as the disco/conga "deliberate whole-cast" bubbles) so the
        // ~6-10s cadence isn't swallowed by the shared ambient-chatter rate
        // limit; it deliberately does NOT set the cooldown either, so it
        // can't suppress a legitimate ambient bubble once panic ends. This
        // timer only ever ticks/fires inside this `if (inQuakePanic)` block,
        // so the moment quakePanicActive goes false (natural end, rival
        // preemption, or rebirth — see endQuakePanic's callers) nothing more
        // fires; no pending timer leaks past the event.
        charEntry.quakePanicExprTimer -= delta;
        if (charEntry.quakePanicExprTimer <= 0) {
          const exprIdx = QUAKE_PANIC_EXPR_POOL[Math.floor(Math.random() * QUAKE_PANIC_EXPR_POOL.length)];
          showExpression(charEntry, exprIdx, QUAKE_PANIC_EXPR_DURATION_SEC, true);
          charEntry.quakePanicExprTimer = QUAKE_PANIC_EXPR_MIN_SEC + Math.random() * (QUAKE_PANIC_EXPR_MAX_SEC - QUAKE_PANIC_EXPR_MIN_SEC);
        }
      }
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
      if (!inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic && !charEntry.dancing && enemiesAlive && charEntry.dazePhase == null) {
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
          // Victory lap (see updateVictoryLap/startVictoryLap): record every
          // agent that actually fought at any point during this wave. Can't
          // wait and read isEngaging at the moment the wave truly clears —
          // by then the last rival has already spent several frames fleeing
          // off-screen, during which isEngaging (and combatTargetInstanceId)
          // reads false for everyone again — see victoryLapWaveParticipants'
          // own doc.
          victoryLapWaveParticipants.add(agent.id);
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
            // Rebirth defense scaling: derived live from rebirthCount every
            // frame (same Math.pow(1.1, n) compounding style as build speed's
            // 1.2) — never baked into a stored stat, so a reload can't
            // compound it. Rivals are untouched; this only strengthens the
            // player's agents.
            nearest.hp -= AGENT_DPS * delta * Math.pow(1.1, rebirthCount);
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
      // p4-t2: repair outranks build. An agent already carrying a repair
      // assignment (extinguishTargetId, set by assignExtinguishers earlier
      // this same frame — see call order note there) must NOT also count as
      // a builder this frame, even if it's active and standing over an
      // active build placement. This is what makes an active agent DIVERT
      // to repair when damage exists, and resume building once the repair
      // assignment clears (extinguishTargetId back to null next frame).
      let isBuilding = false;
      if (!inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic && !isEngaging && !charEntry.dancing && isActive && activeBuildPlacement && charEntry.extinguishTargetId == null) {
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
      } else if (!isEngaging && !inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic) {
        charEntry.buildTargetId = null;
      }

      // ── Solo dance (rare idle festivity) ──────────────────────────
      // An idle, stationary agent may randomly break into a short dance. It
      // is fully preempted by conga/engage/build. While dancing it holds
      // position and a manual frame mixer swaps the three dance frames.
      const idleAndStill = !isActive && !isBuilding && !isEngaging && !inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic;
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

      // ── Extinguish eligibility + intent (p4-t2: any agent may repair) ───
      // Publish eligibility (read by assignExtinguishers next frame — a 1-frame
      // lag is fine here). p4-t2 widens this from idle-only to ANY agent —
      // active/building-capable agents are now repair-eligible too — keeping
      // only the sensible exclusions: seated, dazed, engaging combat, conga,
      // or mid-dance. (isActive/isBuilding are deliberately NOT checked here
      // anymore.) Then derive this-frame intent: an eligible char with a
      // still-smoking assigned object that isn't fighting a rival (combat always
      // wins). extinguishArrived latches once within EXTINGUISH_ARRIVE_EPS of it.
      charEntry.extinguishEligible = !inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic && !isEngaging && !charEntry.dancing && (charEntry.sitSeatId == null) && charEntry.dazePhase == null;
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
      if (!inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic) charEntry.wanderTimer -= delta;
      if (!inConga && !inDanceOff && !inSparring && !inHuddle && !inQuakePanic && !charEntry.dancing && charEntry.sitSeatId == null && !isBuilding && !isEngaging && !isExtinguishing && charEntry.dazePhase == null && charEntry.wanderTimer <= 0) {
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

      // ── Extinguish destination override (Phase 2; p4-t2: any agent) ─────
      // An assigned char (idle OR active) walks to its smoking object, then
      // holds (gather around it, don't pile on the exact center). Runs AFTER
      // the wander decision (whose sit/wander branches are gated off for
      // extinguishers) so it has the final say on dest. Combat/build never
      // coexist here: isExtinguishing requires !isEngaging, and isBuilding is
      // forced false whenever extinguishTargetId is set (repair outranks
      // build — see the isBuilding gate above), so an active repairer is
      // routed here instead of the build-standoff branch.
      if (isExtinguishing && typeof charEntry.extinguishStandNx === "number") {
        if (extinguishArrived) { charEntry.destNx = charEntry.nx; charEntry.destNy = charEntry.ny; }
        else { charEntry.destNx = charEntry.extinguishStandNx; charEntry.destNy = charEntry.extinguishStandNy; }
      }

      // ── Step toward destination ────────────────────────────────────
      // Dancing agents hold position (dest == current pos). Conga leader
      // moves a touch faster so the line snakes; followers use walk speed.
      // A panicking agent moves faster still (QUAKE_PANIC_SPEED_MULT) — the
      // two never overlap (conga and quake-panic are mutually exclusive
      // ambient activities, see quakeAmbientBlockedReason), so this is a
      // plain either/or, not a stacking multiplier.
      const dxNative = charEntry.destNx - charEntry.nx;
      const dyNative = charEntry.destNy - charEntry.ny;
      const distNative = Math.sqrt(dxNative * dxNative + dyNative * dyNative);
      const moveSpeed = (inConga && charEntry.congaIndex === 0) ? WANDER_SPEED * 1.2
        : inQuakePanic ? WANDER_SPEED * QUAKE_PANIC_SPEED_MULT
        : WANDER_SPEED;
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
      // ── Ambient idle poses (freed-frames, plan p10-t4) ────────────────
      // Mirrors onWalkEnded/updateIdleRare in src/webview/animationPlayback.ts
      // exactly (parity hand-maintained — see the ATLAS_CLIPS note above).
      // Walk-end edge: fires the instant isMoving flips true -> false this
      // frame. Rolls STAND_BACK_CHANCE (gated on the theme flag, never while
      // active) and latches the result until the next walk/state change.
      // Any higher-priority override below (build/engage/dance/sit/conga/
      // emote/etc.) unconditionally reassigns desiredClip for those states,
      // so a stand_back latch set here is naturally shadowed by them — it
      // never fights an active task.
      // Activity can begin without a walk transition (e.g. a task starts
      // while the agent is standing still mid-idle) — clear the latched
      // stand_back pose the instant isActive flips true, not only on the
      // next walk restart.
      if (isActive) {
        charEntry.standingBack = false;
      }
      if (!isMoving && charEntry.prevIsMoving) {
        charEntry.standingBack = themeFreedFramesEnabled && !isActive && Math.random() < STAND_BACK_CHANCE;
      } else if (isMoving) {
        charEntry.standingBack = false;
      }
      if (charEntry.standingBack && !isActive && desiredClip === "idle") {
        desiredClip = "stand_back";
      }
      charEntry.prevIsMoving = isMoving;
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
      // STALE-HOST-ACTIVITY guard: the host has no combat concept (see
      // state.ts) and can hand us any of its activity-clip WORKER states
      // ("build"/"haul" -> build, "survey" -> tool_idle, "celebrate" -> cheer,
      // see workerStateToClip) at any time, including while this agent is
      // standing at a rival — e.g. a preempting social state (sparring, conga,
      // etc.) suppressed isEngaging above and the melee override never ran.
      // Any such clip that outlives the activity backing it reads as a stale
      // pose (an agent frozen mid-survey or stuck cheering). HOST_ACTIVITY_
      // CLIP_ACTIVE below states, per clip, what "genuinely active" means:
      //  - "build": isBuilding already accounts for !isEngaging and requires
      //    an actual build target; the extinguish path legitimately drives
      //    the same clip and is exempted the same way the old build-only
      //    guard was.
      //  - "tool_idle": survey has no in-webview driver at all (no ambient
      //    system ever plays it), so it is never genuinely active here.
      //  - "cheer": conga/dance-off/sparring are its only genuine drivers,
      //    and each overrides desiredClip unconditionally further below in
      //    this same chain — so knocking a stale host "cheer" down here does
      //    not block them; they simply reassert it when their own condition
      //    is true.
      // Runs before emote/conga/dance so those still win. Written as a
      // direct conditional (no per-iteration object literal) since this
      // runs once per character per render frame; "genuinely active" per
      // clip is exactly as it was: "build" needs isBuilding or the
      // extinguish exemption, "tool_idle" and "cheer" have no genuine
      // driver here (see above) and are always knocked down.
      if (
        (desiredClip === "build" && !(isBuilding || (isExtinguishing && extinguishArrived))) ||
        desiredClip === "tool_idle" ||
        desiredClip === "cheer"
      ) {
        desiredClip = isMoving ? "walk" : "idle";
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
      // DANCE-OFF override: the winner holds the cheer pose (frame 19, hold)
      // in place during the post-duel celebration beat. Highest priority,
      // like SIT above — a celebrating winner is never dancing/emoting/
      // sitting at the same time (endDanceOff/cancelDanceOff clear those
      // fields the instant the dance-off ends). The loser just falls through
      // to the normal walk/idle clips while walking away.
      if (danceOffActive && danceOffPhase === "celebrate" && charEntry.__id === danceOffWinnerId) {
        desiredClip = "cheer";
      }
      // SPARRING override: highest priority while enrolled, mirrors the
      // DANCE-OFF override's placement — a sparrer/spectator's pose is never
      // fought over by idle/walk/dance/sit/emote (all already resolved
      // above). During "walkin" this forces "idle", but the FINAL MOVEMENT
      // GUARD right below still wins while still physically approaching
      // (isMoving), so the pose only actually shows once arrived. Only the
      // two sparrers ever get melee/block/cheer — a spectator always reads
      // "idle" (see the else branch below).
      if (inSparring) {
        if (sparringPhase === "active" && (charEntry.__id === sparringIdA || charEntry.__id === sparringIdB)) {
          const isA = charEntry.__id === sparringIdA;
          const isAttacker = isA ? sparringAttacker === 0 : sparringAttacker === 1;
          desiredClip = isAttacker ? "melee" : "block";
        } else if (sparringPhase === "celebrate") {
          desiredClip = (charEntry.__id === sparringCelebrateId) ? "cheer" : "idle";
        } else {
          desiredClip = "idle";
        }
      }
      // HUDDLE override: same priority tier as SPARRING above (the two are
      // mutually exclusive per-agent — inSparring/inHuddle can never both be
      // true for the same charEntry, see updateSparring/updateHuddle's
      // eligibility checks). The rotating speaker plays "point"; every other
      // participant (including one still walking in) reads "idle".
      if (inHuddle) {
        desiredClip = (huddlePhase === "active" && huddleParticipantIds[huddleSpeakerIdx] === charEntry.__id) ? "point" : "idle";
      }
      // FINAL MOVEMENT GUARD: a physically-moving agent ALWAYS walks — no
      // combat (shoot/melee), celebration (cheer), or emote (point/signal/
      // block) pose may play mid-slide; those only begin once the agent is
      // stationary at its destination. Exemptions: "dance"/"sit" are genuine
      // in-place festivity states (position-locked), conga members walk
      // their line with an intentional periodic cheer, and a dance-off
      // winner holds its cheer in place (never moving) — so leave those clips.
      if (isMoving && !inConga && desiredClip !== "dance" && desiredClip !== "sit" && desiredClip !== "cheer") {
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
        (
          (isEngaging && engageInRange) ||
          // Sparring exhibition: the current attacker's melee swing must
          // keep replaying for the whole ~0.8-1.2s role window (SPARRING_
          // ROLE_MIN/MAX_SEC) instead of freezing after one 2-frame swing —
          // same loop-at-the-engage-site reasoning as real combat below,
          // just gated on inSparring instead of isEngaging/engageInRange.
          (desiredClip === "melee" && inSparring && sparringPhase === "active")
        )
      ) {
        // Change 3: melee/shoot clips are loop:false one-shots in
        // ATLAS_CLIPS (kept that way for non-looping uses elsewhere), but
        // while an agent is actively engaging an in-range enemy — or (see
        // above) sparring as the current attacker — the attack must keep
        // replaying instead of freezing on the last frame. Reset here
        // (loop-at-the-engage-site) rather than change ATLAS_CLIPS globally.
        // Stops automatically once out of range/enemy defeated, because
        // desiredClip then changes to "walk"/"idle" and the branch above
        // handles the reset instead.
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
          // Quake secondary jitter: a small, per-agent-phased draw-time
          // offset (see quakeAgentJitter) — added ONLY here, never into
          // charEntry.x/y, cx, or cy, so hover hit-boxes/expression bubbles
          // below intentionally stay put (the mismatch is sub-pixel-ish and
          // purely cosmetic).
          const [quakeAjX, quakeAjY] = quakeAgentJitter(agent.id, quakeAmpCanvas);
          const drawX = cx - spriteSize / 2 + seatNudge + quakeAjX;
          const drawY = cy - spriteSize - seatRaise + quakeAjY; // feet at cy, raised for chair scale

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
            name: ((rosterAgentInfo && rosterAgentInfo.name) || agent.name || agent.id)
              + (charEntry.accentKind === "fallback" ? (charEntry.accentIsDefault ? " (dfb)" : " (fb)") : ""),
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

          // Cross-vendor active ring (p24-t2): a working (isActive) foreign
          // or fallback agent gets a colored outline ring around its sprite —
          // native agents keep today's look (no ring). Drawn in un-flipped
          // canvas coords, centered on the sprite's own box, so it never
          // interacts with the flip transform below.
          if (charEntry.isActive && (charEntry.accentKind === "foreign" || charEntry.accentKind === "fallback")) {
            var accentRingColor = charEntry.accentKind === "fallback"
              ? "rgba(255, 176, 32, 0.9)" // --accent amber
              : "rgba(79, 195, 247, 0.9)"; // --accent-info light blue
            ctx.save();
            ctx.strokeStyle = accentRingColor;
            ctx.lineWidth = Math.max(1.5, 2 * depthScale);
            ctx.beginPath();
            ctx.ellipse(cx, cy - spriteSize / 2, spriteSize / 2 + 3, spriteSize / 2 + 3, 0, 0, Math.PI * 2);
            ctx.stroke();
            // Thin active-progress arc: a lightweight "working" pulse in the
            // same accent color, distinct from the ring itself (the Active
            // indicator light below still marks isActive for native agents).
            var accentPulseT = (performance.now ? performance.now() : Date.now()) / 900;
            var accentPulseFrac = 0.5 + 0.5 * Math.sin(accentPulseT);
            ctx.globalAlpha = 0.35 + 0.5 * accentPulseFrac;
            ctx.lineWidth = Math.max(2.5, 3.5 * depthScale);
            ctx.beginPath();
            ctx.ellipse(cx, cy - spriteSize / 2, spriteSize / 2 + 3, spriteSize / 2 + 3, 0, -Math.PI / 2, -Math.PI / 2 + accentPulseFrac * Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

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
            ctx.translate(cx + spriteSize / 2 + seatNudge + quakeAjX, 0);
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
          // Live-read the themed name from themeRosterAgents (same source/lookup
          // as the hover tooltip above, via the already-computed rosterAgentInfo)
          // rather than a value captured once — a RENAME_THEME_CHARACTER /
          // SET_THEME_ITEM_NAMES re-post of THEME_INITIALIZED refreshes
          // themeRosterAgents, so this label now updates the same frame instead
          // of requiring a reload. Falls back to agent.name || agent.id when the
          // theme has no roster name for this slot (non-themed-agent case).
          // Fallback agents get the " (fb)" suffix on the nameplate (p24-t2);
          // foreign gets no suffix, only the ring above. slice(0, 24) runs on
          // the base name first so the suffix is never truncated away.
          const label = ((rosterAgentInfo && rosterAgentInfo.name) || agent.name || agent.id).slice(0, 24)
            + (charEntry.accentKind === "fallback" ? (charEntry.accentIsDefault ? " (dfb)" : " (fb)") : "");
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

    // ── Quake dust puffs (see startQuake) — drawn on top of the depth-sorted
    // scene, same layering slot as projectiles/confetti below. No-op when
    // no quake has spawned any (the common case).
    updateAndDrawQuakeDust(delta);

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

    // ── Disco ball + lighting overlay ───────────────────────────────────
    // Ball drawn FIRST so the lighting wash composites over it too (same
    // "everything drawn so far this frame" region as the lights), then the
    // lighting overlay itself — both BEFORE drawHUD so the HUD text stays
    // crisp. Single cheap comparison each when no party is running.
    drawDiscoBall(w, h, bgX, bgY, bgW, bgH);
    drawDiscoOverlay(w, h);
    // Dance-off winner confetti — same overlay region (composites above the
    // scene, drawn before drawHUD so HUD text stays crisp/unoccluded).
    // Single cheap boolean check when no burst is live.
    drawDanceOffConfetti();

    // End of the quake camera translate (see the matching ctx.save() before
    // the background draw above) — everything below (stage-editor handles,
    // loading bar, HUD, rebirth confetti) is static/unshaken UI.
    ctx.restore();

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
      // themeStageState leaving 'pending' is the authoritative verdict (it also
      // covers the 15s pending safety cap, which the older themeLoaded/noThemeSignaled
      // check alone did not).
      const themeOutcomeKnown = themeStageState !== "pending";
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

  // Kick off the bundled disco-ball sprite load once at boot — independent
  // of theme loading (this asset ships with the extension, not per-theme),
  // async and non-blocking; drawDiscoBall degrades silently until it settles.
  loadDiscoBallSprite();

  requestAnimationFrame(render);
})();
