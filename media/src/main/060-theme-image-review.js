// Part: 60-theme-image-review
// Theme image preloading and review UI.
  function preloadThemeImages(rawFrames) {
    themeImages = {};
    themeBackgroundImg = null;
    // Guards the settle callback below against a theme switch that starts a
    // NEWER preloadThemeImages call before this one's sprites finish loading
    // — a stale callback must not re-render the (by-then-superseded) roster.
    const myGen = ++themeImagesLoadGen;
    let pendingSprites = 0;
    let settledSprites = 0;
    // The THEME_INITIALIZED handler re-renders the themes list synchronously
    // right after this call returns, so rosterOrder is current immediately —
    // but every Image here is still mid-load (its .src is assigned inside
    // loadDefringedFrame's async raw.onload/onerror), so that immediate
    // render shows initials placeholders (see the readiness check at ~4494).
    // Once every sprite for THIS theme has settled (loaded or errored), fire
    // ONE follow-up re-render so the roster thumbnails swap in the real art
    // — a single call rather than one per image, so it can't thrash.
    function onSpriteSettled() {
      settledSprites++;
      if (settledSprites < pendingSprites) return;
      if (myGen !== themeImagesLoadGen) return; // superseded by a later theme load
      if (Array.isArray(lastThemesList)) {
        renderThemesList(lastThemesList);
      }
    }
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
    } else {
      console.error("TycoonAgents preloadThemeImages: no environment_background to load", {
        keyCount: Object.keys(rawFrames).length,
      });
    }
    console.info(`TycoonAgents preloadThemeImages: keyCount=${Object.keys(rawFrames).length}`);
    for (const [charId, slots] of Object.entries(rawFrames)) {
      if (charId === "environment_background") continue;
      // All sprite frame keys (agents, rivals, objects, decor, crate, poof)
      // get the magenta edge-defringe.
      pendingSprites += slots.length;
      themeImages[charId] = slots.map((src) => loadDefringedFrame(src, onSpriteSettled));
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

  // ── Quake engine (rebirth wipe + ambient profile) ──────────────────────────
  // RENDER-TIME ONLY: a reusable camera-shake effect wired to the rebirth
  // wipe (see doRebirth()) and exposed via debug hotkeys (Alt+Q / Alt+Shift+Q,
  // see the keydown handler near the conga/disco/dance-off hotkeys). This
  // ENGINE (quakeActive/quakeElapsed/quakeDuration/quakeIntensity, the
  // amplitude/camera-offset/agent-jitter math, and the dust puffs below)
  // still NEVER mutates any agent's nx/ny, dest, or object/logic state — the
  // shake is a camera translate (render(), wrapped around the whole scene
  // draw) plus a small per-agent secondary jitter applied ONLY at drawImage
  // time (the "agent" branch of the depthList.forEach draw loop) — so it
  // cannot interact with polygon clamping, combat, build, or persistence.
  // Respects prefersReducedMotion (declared above): reduced-motion users get
  // NO camera shake and NO per-agent jitter — dust puffs alone still play
  // (they carry no camera motion of their own). The AMBIENT profile now also
  // drives a real agent-movement activity (panic) — that is a SEPARATE
  // system layered on top, see the "Quake panic" section below; it never
  // reaches into this engine except to call startQuake("ambient", …) and, on
  // rival preemption, cancelQuakeFast() (a fast amplitude fade, still
  // render-only).
  let quakeActive = false;
  let quakeElapsed = 0;   // seconds into the current quake
  let quakeDuration = 0;  // seconds, set by startQuake() from the chosen profile
  let quakeIntensity = 0; // native px amplitude, set by startQuake() from the chosen profile
  /** True while a rival-arrival preemption is fading the quake out early
   *  (see cancelQuakeFast) instead of running its normal envelope. */
  let quakeFastFade = false;
  /** Seconds elapsed into the fast fade-out (counts 0 → QUAKE_CANCEL_FADE_SEC). */
  let quakeFastFadeElapsed = 0;
  /** Amplitude (native px) captured at the instant cancelQuakeFast() was
   *  called — the fade-out ramps linearly from this down to 0, so it
   *  continues smoothly from wherever the normal envelope currently was
   *  rather than jumping. */
  let quakeFastFadeFromAmp = 0;
  /** Brief dust puffs spawned on quake start, reusing the poof sprite pipeline.
   * @type {Array<{nx:number, ny:number, animState:{action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}}>} */
  let quakeDustPuffs = [];

  const QUAKE_REBIRTH_DURATION = 1.6;    // s
  const QUAKE_REBIRTH_INTENSITY = 5;     // native px
  // 30s ambient rumble (creative sign-off) — long enough that a flat
  // attack→decay envelope over the whole span would read as fading out
  // almost immediately (a plain cosine decay drops below ~15% amplitude by
  // the 25s mark); quakeAmplitude() below instead does attack → a gentle
  // flat sustain → a final QUAKE_DECAY_SEC cosine fade, so the rumble
  // actually holds through the middle of the 30s instead of visibly
  // trailing off early. Short profiles (rebirth, 1.6s) have no runway for a
  // sustain phase — decayWindow there just clamps to whatever remainder is
  // left after the attack, reproducing the original attack→decay shape
  // exactly (see quakeAmplitude's math).
  const QUAKE_AMBIENT_DURATION = 30.0;   // s
  const QUAKE_AMBIENT_INTENSITY = 3;     // native px
  const QUAKE_ATTACK_SEC = 0.15;         // fast amplitude ramp-in
  const QUAKE_DECAY_SEC = 3.0;           // final cosine fade-out window (capped to the available remainder — see quakeAmplitude)
  const QUAKE_AGENT_JITTER_FRAC = 0.30;  // per-agent secondary jitter as a fraction of the camera amplitude
  const QUAKE_DUST_MAX_PUFFS = 8;        // cap on dust puffs spawned per quake start
  /** Fade-out window (seconds) used by cancelQuakeFast — a rival arriving
   *  mid-quake ends the shake quickly rather than on a hard cut, but still
   *  faster than the normal QUAKE_DECAY_SEC tail (which is tuned for a
   *  natural end, not an interruption). */
  const QUAKE_CANCEL_FADE_SEC = 0.5;

  /**
   * Start a quake of the given profile ("rebirth" | "ambient") and spawn its
   * dust puffs at the given native-coord positions (capped, random subset —
   * see spawnQuakeDust). Purely additive to any quake already in flight —
   * re-triggering resets the envelope from a fresh attack rather than
   * stacking amplitude.
   * @param {"rebirth"|"ambient"} profile
   * @param {Array<{nx:number, ny:number}>} [positions]
   */
  function startQuake(profile, positions) {
    quakeActive = true;
    quakeElapsed = 0;
    // A fresh start always wins over any in-flight fast fade (re-triggering
    // — e.g. doRebirth's rebirth-profile quake overriding an in-progress
    // ambient one, see doRebirth's own quake-panic cancel note) — the new
    // envelope starts clean from a fresh attack, not a fading-out amplitude.
    quakeFastFade = false;
    quakeFastFadeElapsed = 0;
    quakeFastFadeFromAmp = 0;
    if (profile === "ambient") {
      quakeDuration = QUAKE_AMBIENT_DURATION;
      quakeIntensity = QUAKE_AMBIENT_INTENSITY;
    } else {
      quakeDuration = QUAKE_REBIRTH_DURATION;
      quakeIntensity = QUAKE_REBIRTH_INTENSITY;
    }
    spawnQuakeDust(positions);
  }

  /**
   * Preempt the active quake with a fast fade-out (QUAKE_CANCEL_FADE_SEC)
   * instead of a hard cut — used when a rival spawns mid-ambient-quake (see
   * updateQuakePanic). Captures the CURRENT amplitude so the fade continues
   * smoothly from wherever the envelope was (attack/sustain/decay) rather
   * than jumping. No-op when no quake is active or a fast fade is already
   * running.
   */
  function cancelQuakeFast() {
    if (!quakeActive || quakeFastFade) return;
    quakeFastFade = true;
    quakeFastFadeElapsed = 0;
    quakeFastFadeFromAmp = quakeAmplitude();
  }

  /** Advance the active quake's timer by delta seconds (same delta the rest
   * of render() uses — pause-when-hidden-safe, no fast-forward on tab return).
   * No-op when no quake is active. While a fast fade is running (see
   * cancelQuakeFast) this advances the fade instead of the normal envelope
   * timer, so a rival-preempted quake can't also hit its natural end mid-fade. */
  function updateQuake(delta) {
    if (!quakeActive) return;
    if (quakeFastFade) {
      quakeFastFadeElapsed += delta;
      if (quakeFastFadeElapsed >= QUAKE_CANCEL_FADE_SEC) {
        quakeActive = false;
        quakeElapsed = 0;
        quakeDuration = 0;
        quakeIntensity = 0;
        quakeFastFade = false;
        quakeFastFadeElapsed = 0;
        quakeFastFadeFromAmp = 0;
      }
      return;
    }
    quakeElapsed += delta;
    if (quakeElapsed >= quakeDuration) {
      quakeActive = false;
      quakeElapsed = 0;
      quakeDuration = 0;
      quakeIntensity = 0;
    }
  }

  /**
   * Current shake amplitude in NATIVE px: a fast attack ramp (QUAKE_ATTACK_SEC)
   * up to quakeIntensity, then a gentle flat sustain, then a smooth cosine
   * decay to 0 over the final QUAKE_DECAY_SEC (capped to whatever remainder
   * is actually available after the attack, so a short profile like rebirth
   * — no runway for a sustain — decays over its full remainder exactly as
   * before). While a fast fade is in flight (see cancelQuakeFast) this
   * ignores the normal envelope entirely and ramps quakeFastFadeFromAmp
   * linearly to 0 over QUAKE_CANCEL_FADE_SEC instead. 0 when no quake is active.
   */
  function quakeAmplitude() {
    if (!quakeActive) return 0;
    if (quakeFastFade) {
      const t = Math.min(1, quakeFastFadeElapsed / QUAKE_CANCEL_FADE_SEC);
      return quakeFastFadeFromAmp * (1 - t);
    }
    if (quakeElapsed < QUAKE_ATTACK_SEC) {
      return quakeIntensity * (quakeElapsed / QUAKE_ATTACK_SEC);
    }
    const remainAfterAttack = Math.max(quakeDuration - QUAKE_ATTACK_SEC, 0.0001);
    const decayWindow = Math.min(QUAKE_DECAY_SEC, remainAfterAttack);
    const decayStart = quakeDuration - decayWindow;
    if (quakeElapsed < decayStart) {
      return quakeIntensity; // gentle sustain — steady rumble between attack and final decay
    }
    const t = Math.max(0, Math.min(1, (quakeElapsed - decayStart) / decayWindow));
    return quakeIntensity * (0.5 + 0.5 * Math.cos(t * Math.PI));
  }

  /**
   * Camera-shake draw offset for the given amplitude (already in whatever
   * pixel space the caller wants — render() passes a canvas-px amplitude).
   * A rumble, not a vibration: a pair of incommensurate low-frequency sines
   * plus a small random component, driven by quakeElapsed so it's
   * deterministic-ish (repeatable envelope, not truly random noise).
   * @param {number} ampPx
   * @returns {[number, number]}
   */
  function quakeCameraOffset(ampPx) {
    if (ampPx <= 0) return [0, 0];
    const t = quakeElapsed;
    const x = Math.sin(t * 27.3) * 0.55 + Math.sin(t * 41.7 + 1.3) * 0.35 + (Math.random() - 0.5) * 0.2;
    const y = Math.sin(t * 33.1 + 0.7) * 0.55 + Math.sin(t * 19.9 + 2.1) * 0.35 + (Math.random() - 0.5) * 0.2;
    return [x * ampPx, y * ampPx];
  }

  /**
   * Smaller secondary jitter for one agent's sprite draw, phased off the
   * agent's own id so agents don't move in lockstep with each other or with
   * the camera. Draw-time only — see the "agent" branch of the
   * depthList.forEach loop in render(); never touches charEntry.x/y.
   * @param {string} agentId
   * @param {number} ampPx camera amplitude (same canvas-px units as quakeCameraOffset)
   * @returns {[number, number]}
   */
  function quakeAgentJitter(agentId, ampPx) {
    if (ampPx <= 0) return [0, 0];
    const jAmp = ampPx * QUAKE_AGENT_JITTER_FRAC;
    const id = String(agentId || "");
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
    const phase = ((h % 1000) / 1000) * Math.PI * 2;
    const t = quakeElapsed;
    const x = Math.sin(t * 37 + phase) * jAmp;
    const y = Math.sin(t * 31 + phase * 1.6) * jAmp;
    return [x, y];
  }

  /**
   * Snapshot the native-coord positions of every currently-built object
   * (buildState.builtIds ∩ objectPlacement), for dust-puff spawning. Called
   * BEFORE doRebirth()'s wipe clears buildBuiltCount/objectAnimMap so the
   * rebirth profile's dust lands on the objects actually being wiped; called
   * fresh (post-wipe state is irrelevant) by the debug hotkeys too.
   * @returns {Array<{nx:number, ny:number}>}
   */
  function capturedBuiltObjectPositions() {
    if (!themeBuildables.length) return [];
    const bs = computeBuildState();
    const out = [];
    bs.builtIds.forEach((objId) => {
      const p = objectPlacement[objId];
      if (p) out.push({ nx: p.nx, ny: p.ny });
    });
    return out;
  }

  /**
   * Spawn brief dust puffs at a random subset (capped QUAKE_DUST_MAX_PUFFS)
   * of the given native-coord positions, reusing OBJECT_CLIPS.poof's 4-frame
   * one-shot animation (see createAnimState/advanceObjectAnim/
   * currentObjectSlot) — the same clip built objects play on completion.
   * No-op on an empty/missing positions array.
   * @param {Array<{nx:number, ny:number}>} [positions]
   */
  function spawnQuakeDust(positions) {
    if (!Array.isArray(positions) || !positions.length) return;
    const pool = positions.slice();
    const n = Math.min(QUAKE_DUST_MAX_PUFFS, pool.length);
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const pos = pool.splice(idx, 1)[0];
      quakeDustPuffs.push({ nx: pos.nx, ny: pos.ny, animState: createAnimState("poof") });
    }
  }

  /**
   * Advance + draw quake dust puffs in canvas space (uses the cached
   * lastBgX/Y/W/H — see their declaration — so it can be called anywhere in
   * render() after the background rect for THIS frame is known). One-shot:
   * each puff removes itself once its poof animState reports completed
   * (OBJECT_CLIPS.poof has loop:false). Never throws on missing/still-
   * decoding poof art — just stops drawing that puff until it expires.
   */
  function updateAndDrawQuakeDust(delta) {
    if (!quakeDustPuffs.length) return;
    const poofSlots = themeImages.poof;
    const size = Math.round(64 * themeOverallScale * sceneFitScale);
    for (let i = quakeDustPuffs.length - 1; i >= 0; i--) {
      const puff = quakeDustPuffs[i];
      advanceObjectAnim(puff.animState, delta);
      if (puff.animState.completed) {
        quakeDustPuffs.splice(i, 1);
        continue;
      }
      if (!poofSlots || !poofSlots.length) continue;
      const img = poofSlots[currentObjectSlot(puff.animState)];
      if (!img || !img.complete || img.naturalWidth === 0) continue;
      const canvasPt = nativeToCanvas(puff.nx, puff.ny, lastBgX, lastBgY, lastBgW, lastBgH);
      ctx.drawImage(img, canvasPt[0] - size / 2, canvasPt[1] - size, size, size);
    }
  }

  // ── Quake panic (ambient earthquake easter egg) ─────────────────────────
  // The FULL ambient quake event: the render-only camera shake above (see
  // startQuake("ambient", …)) PLUS a real agent-movement activity layered on
  // top — every non-dazed agent scatters, repeatedly picking a new random
  // walkable destination on its own stagger timer and moving there at an
  // elevated speed (QUAKE_PANIC_SPEED_MULT), via the SAME dest-based
  // movement machinery every other ambient activity uses (destNx/destNy →
  // the shared "step toward destination" block in the per-character loop —
  // see charEntry.quakePanicTimer and the "Quake panic" block in that loop).
  // Real movement, so every polygon-clamp/collision guarantee applies
  // automatically. Each panicking agent ALSO shows a frequent expression
  // bubble — see charEntry.quakePanicExprTimer and QUAKE_PANIC_EXPR_* below
  // — a deliberate exception: Dazed (index 7) is normally combat-reserved,
  // but during the AMBIENT quake it's combat-and-earthquake-reserved (still
  // off-limits to every other ambient system — sparring/huddle/dance-off —
  // which keep their own STRICT no-Dazed/no-Anger rules unchanged). The
  // REBIRTH-profile quake (startQuake("rebirth", …), Alt+Q, doRebirth) never
  // calls startQuakePanic — only triggerAmbientQuake does — so it stays
  // zero-expression and visual-only, exactly as before.
  //
  // Structurally mirrors the sparring/huddle sections above (own state,
  // start/end/cancel functions, a live-derived `inQuakePanic` gate threaded
  // through every engage/build/idle/extinguish/wander exclusion the other
  // ambient activities already extend) with ONE difference: this isn't a
  // small picked participant set — since the event can never start (or
  // survive) while any rival is alive (see quakeAmbientBlockedReason and
  // updateQuakePanic's rival-preemption below), there's never a combat agent
  // to hand-pick around, so every eligible agent panics at once.
  /** True while the panic activity is running. Always STARTED together with
   *  the camera shake (triggerAmbientQuake calls startQuake + startQuakePanic
   *  in the same breath), but they don't always END together: a rival
   *  arrival or rebirth stops both instantly, while the shake's own natural
   *  end instead starts a QUAKE_PANIC_LINGER_SEC grace window (see
   *  quakeAmbientLingering/updateQuakePanic) before this actually flips
   *  false — panic reads as continuing "a beat" after the ground stops
   *  shaking, per product direction. */
  let quakePanicActive = false;
  /** True during the QUAKE_PANIC_LINGER_SEC grace window after the shake
   *  itself (quakeActive) has finished naturally — see updateQuakePanic's
   *  natural-end handling. quakePanicActive stays true the whole time (so
   *  every "quake-panic still active" guard/block keeps behaving correctly
   *  — the other five activities' start gates, quakeAmbientBlockedReason,
   *  moveSpeed, expression firing, etc. all need zero changes for this). */
  let quakeAmbientLingering = false;
  /** Seconds remaining in the natural-end linger window (see quakeAmbientLingering). */
  let quakeAmbientLingerTimeLeft = 0;
  /** Accumulator (seconds) toward the next ambient-quake eligibility check. */
  let quakeAmbientCheckTimer = 0;
  /** Cooldown (seconds) remaining before another ambient quake may start via
   *  the random trigger. Also stamped by the Alt+Shift+Q hotkey (see
   *  triggerAmbientQuake) so manual previews don't defeat the rarity budget. */
  let quakeAmbientCooldown = 0;
  /** Per-agent panic destination re-pick interval (seconds) — a per-agent
   *  stagger, not a synchronized tick, so the whole roster doesn't redirect
   *  in lockstep (mirrors DISCO_BUBBLE_STAGGER's reasoning, applied to
   *  movement instead of a bubble). */
  const QUAKE_PANIC_INTERVAL_MIN = 0.6;
  const QUAKE_PANIC_INTERVAL_MAX = 1.2;
  /** Panic movement speed as a multiple of WANDER_SPEED — applied at the
   *  "step toward destination" block (mirrors the conga leader's
   *  WANDER_SPEED*1.2, just larger — panic should read as faster than any
   *  other ambient movement). */
  const QUAKE_PANIC_SPEED_MULT = 1.6;
  /** Per-agent panic EXPRESSION re-pick interval (seconds), independent of
   *  QUAKE_PANIC_INTERVAL_* (movement) — see charEntry.quakePanicExprTimer
   *  and the "Quake panic" block in the per-character loop. Design target:
   *  ~3-5 bubbles per agent over the 30s ambient event. A staggered first
   *  fire at QUAKE_PANIC_EXPR_STAGGER_MIN/MAX_SEC (mean 6s) followed by
   *  repeats every QUAKE_PANIC_EXPR_MIN/MAX_SEC (mean 8s) works out to
   *  roughly 1 + floor((30 - 6) / 8) ≈ 4 fires per agent — within target —
   *  randomized per-agent so the whole roster doesn't bubble in lockstep. */
  const QUAKE_PANIC_EXPR_STAGGER_MIN_SEC = 4;
  const QUAKE_PANIC_EXPR_STAGGER_MAX_SEC = 8;
  const QUAKE_PANIC_EXPR_MIN_SEC = 6;
  const QUAKE_PANIC_EXPR_MAX_SEC = 10;
  /** How long (seconds) each panic expression bubble stays visible — mirrors
   *  the sparring spectator-reaction bubble's duration. */
  const QUAKE_PANIC_EXPR_DURATION_SEC = 1.6;
  /** Equal-chance icon pool for panic bubbles: Team(3), Anger(2), Idea(1),
   *  Dazed(7) — per explicit product direction, Dazed is allowed here even
   *  though it's normally combat-only (see this section's top-of-file doc:
   *  Dazed is combat-AND-earthquake-reserved, still off-limits to every
   *  other ambient system). */
  const QUAKE_PANIC_EXPR_POOL = [3, 2, 1, 7];
  /** Field bug (0.0.507): agents kept panicking indefinitely after the shake
   *  visuals finished — updateQuake()'s natural-end path (quakeElapsed >=
   *  quakeDuration) only ever zeroed the camera-shake state, it never called
   *  endQuakePanic(), so only the PREEMPTION paths (rival arrival, rebirth)
   *  actually stopped the panic. Per user direction: panic should stop
   *  about TWO SECONDS after the shaking stops, not instantly and not
   *  never — see updateQuakePanic's natural-end handling (quakeAmbientLingering
   *  above) for the grace window this drives. Preemption paths remain
   *  IMMEDIATE cancels (no linger) — this constant only applies to the
   *  natural end. */
  const QUAKE_PANIC_LINGER_SEC = 2;
  /** Seconds between ambient-quake random-trigger eligibility rolls — same
   *  time-based (not per-frame) approach every other ambient system uses. */
  const QUAKE_AMBIENT_CHECK_SECONDS = 180;
  /** Chance per eligibility check that the ambient event starts. Mean
   *  interval ≈ QUAKE_AMBIENT_CHECK_SECONDS / QUAKE_AMBIENT_CHANCE = 180 /
   *  0.001 = 180,000s ≈ 50 hours — deliberately rare (an earthquake is a
   *  "someday, during a long session" event, not a frequent one). */
  const QUAKE_AMBIENT_CHANCE = 0.001;
  /** Cooldown (seconds) after an ambient quake ends before another may start
   *  via the random trigger — same 3600s (1h) budget conga's rare-event
   *  cooldown uses. */
  const QUAKE_AMBIENT_COOLDOWN_SECONDS = 3600;
  /** Minimum agents required to even attempt a start — same floor conga uses. */
  const QUAKE_AMBIENT_MIN_AGENTS = 3;

  /**
   * Reason the FULL ambient quake event (shake + panic) cannot start right
   * now, or null if it's clear to start. Shared by the random scheduler
   * (updateQuakeAmbientScheduler) and the Alt+Shift+Q hotkey (via
   * triggerAmbientQuake) so both paths refuse for the identical set of
   * reasons — the "no rival battle at the same time" rule lives here once,
   * not duplicated. Deliberately does NOT check quakeAmbientCooldown/
   * prefersReducedMotion — those are scheduler-only concerns (the hotkey is
   * a manual preview and intentionally bypasses cooldown/reduced-motion,
   * mirroring the conga/disco/dance-off debug-hotkey precedent — see the
   * keydown handler's own comment on those).
   * @param {Array<object>} agentList current sceneAgentList
   * @returns {string|null}
   */
  function quakeAmbientBlockedReason(agentList) {
    if (quakePanicActive) return "ambient quake already active";
    if (!agentList || agentList.length < QUAKE_AMBIENT_MIN_AGENTS) return "too few agents";
    if (activeEnemies.length > 0) return "rivals present";
    if (congaActive || discoPartyActive || danceOffActive || sparringActive || huddleActive || victoryLapActive) return "another ambient activity is active";
    return null;
  }

  /**
   * Attempt to start the full ambient quake event (shake + panic), applying
   * quakeAmbientBlockedReason's guard first. No-op (with a console.log
   * naming the reason) when blocked — used by both the random scheduler and
   * the Alt+Shift+Q hotkey so a suppressed attempt is always visible in the
   * console rather than silently doing nothing. Stamps quakeAmbientCooldown
   * on an actual start either way (random trigger OR hotkey), so a manual
   * preview still counts against the rarity budget.
   * @param {Array<object>} agentList current sceneAgentList
   * @param {string} source "random" | "hotkey", for the console log only
   * @returns {boolean} true if the event actually started
   */
  function triggerAmbientQuake(agentList, source) {
    const blocked = quakeAmbientBlockedReason(agentList);
    if (blocked) {
      console.log(`[quake] ambient event suppressed (${source}): ${blocked}`);
      return false;
    }
    startQuake("ambient", capturedBuiltObjectPositions());
    startQuakePanic(agentList);
    quakeAmbientCooldown = QUAKE_AMBIENT_COOLDOWN_SECONDS;
    return true;
  }

  /**
   * Enroll every eligible agent (see inQuakePanic's derivation in the
   * per-character loop — non-dazed is the only exclusion) into the panic
   * activity and pre-seed each one's movement AND expression re-pick timers
   * with a random stagger so the whole roster doesn't redirect/bubble on the
   * same frame.
   * @param {Array<object>} agentList current sceneAgentList
   */
  function startQuakePanic(agentList) {
    quakePanicActive = true;
    for (const a of agentList) {
      if (!a) continue;
      const e = agentCharMap[a.id];
      if (!e) continue;
      e.quakePanicTimer = Math.random() * QUAKE_PANIC_INTERVAL_MAX;
      e.quakePanicExprTimer = QUAKE_PANIC_EXPR_STAGGER_MIN_SEC + Math.random() * (QUAKE_PANIC_EXPR_STAGGER_MAX_SEC - QUAKE_PANIC_EXPR_STAGGER_MIN_SEC);
    }
  }

  /** Reset the panic activity to inactive. No per-agent destNx/destNy/
   *  settled/quakePanicExprTimer cleanup needed — same reasoning as
   *  resetSparringState's doc: normal wander/AI happily inherits and
   *  overwrites those fields the instant `inQuakePanic` reads false next
   *  frame, and quakePanicExprTimer is only ever read/decremented INSIDE
   *  the `if (inQuakePanic)` block in the per-character loop — once this
   *  flips quakePanicActive false, nothing ever fires another bubble off a
   *  stale value; startQuakePanic reseeds it fresh on the next run anyway. */
  function endQuakePanic() {
    quakePanicActive = false;
    quakeAmbientLingering = false;
    quakeAmbientLingerTimeLeft = 0;
  }

  /**
   * Advance the panic activity's preemption rule AND its natural-end linger
   * (see QUAKE_PANIC_LINGER_SEC's field-bug note). Called once per frame,
   * after updateHuddle (same ordering rationale as updateSparring/
   * updateHuddle's own doc — this frame's congaActive/discoPartyActive/
   * danceOffActive/sparringActive/huddleActive already reflect anything that
   * just started/ended) and AFTER updateQuake (see its call site) so this
   * frame's quakeActive already reflects a natural end that happened this
   * same frame, and before the per-character loop, so a same-frame rival
   * arrival clears quakePanicActive (and therefore inQuakePanic, derived
   * per-agent in that loop) in time for combat to resume THIS frame. The
   * actual per-agent destination-picking lives inline in the per-character
   * loop (see the "Quake panic" block there, mirroring inConga's shape)
   * since every agent independently re-targets on its own stagger timer
   * rather than sharing one line/ring of positions.
   *
   * Rebirth mid-quake is handled separately by doRebirth() itself (it calls
   * endQuakePanic() directly right before starting the rebirth-profile
   * quake) since a rebirth isn't a per-frame event — see doRebirth's own note.
   * @param {number} delta seconds
   */
  function updateQuakePanic(delta) {
    if (!quakePanicActive) return;
    // Rivals spawning mid-quake immediately end BOTH the panic (agents
    // revert to normal AI this same frame, including engaging combat
    // normally — see inQuakePanic's derivation) and the shake itself, faded
    // out quickly rather than cut hard (see cancelQuakeFast). IMMEDIATE — no
    // linger, unlike the natural-end path below.
    if (activeEnemies.length > 0) {
      endQuakePanic();
      cancelQuakeFast();
      return;
    }
    // Natural end: once the shake itself (quakeActive) has finished on its
    // own — NOT via the rival branch above, which already returned — start
    // (or continue) a QUAKE_PANIC_LINGER_SEC grace window instead of ending
    // panic the instant the last camera-shake frame lands. quakePanicActive
    // stays true throughout, so every other guard/derivation that reads it
    // (the five activities' start gates, quakeAmbientBlockedReason,
    // inQuakePanic, moveSpeed, expression firing) keeps behaving exactly as
    // if the quake were still fully active — nothing else needed changing.
    if (!quakeActive) {
      if (!quakeAmbientLingering) {
        quakeAmbientLingering = true;
        quakeAmbientLingerTimeLeft = QUAKE_PANIC_LINGER_SEC;
      }
      quakeAmbientLingerTimeLeft -= delta;
      if (quakeAmbientLingerTimeLeft <= 0) {
        endQuakePanic();
      }
    }
  }

  /**
   * Random-trigger scheduler for the ambient quake event — time-based (not
   * per-frame), same approach as the conga/disco/dance-off/sparring/huddle
   * checks. Random triggering is fully disabled for reduced-motion users
   * (product decision — mirrors updateDiscoParty's identical rule; the
   * Alt+Shift+Q hotkey still works for them, same as the D-key precedent).
   * @param {number} delta seconds
   * @param {Array<object>} agentList current sceneAgentList
   */
  function updateQuakeAmbientScheduler(delta, agentList) {
    if (quakeAmbientCooldown > 0) quakeAmbientCooldown = Math.max(0, quakeAmbientCooldown - delta);
    if (quakePanicActive) return; // already running — updateQuakePanic owns it
    if (prefersReducedMotion) return;
    quakeAmbientCheckTimer += delta;
    if (quakeAmbientCheckTimer < QUAKE_AMBIENT_CHECK_SECONDS) return;
    quakeAmbientCheckTimer = 0;
    if (quakeAmbientCooldown > 0) return;
    if (quakeAmbientBlockedReason(agentList)) return;
    if (Math.random() >= QUAKE_AMBIENT_CHANCE) return;
    triggerAmbientQuake(agentList, "random");
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

  // Pre-fetch the packs catalog so the Setup Wizard Step-2 package checkbox
  // list (renderSetupOptionals) has real "what this installs" data (skills/
  // commands/MCP/agents) available the moment a fresh install reaches it,
  // without waiting on a click into Settings > Packs. Reuses the existing
  // getPacks/packs round-trip (lastPacks) rather than adding a new one; also
  // marks packsLoaded so the Settings Packs tab doesn't re-fetch redundantly.
  vscode.postMessage({ type: "getPacks" });
  packsLoaded = true;

  // Ask the host for current engine connection status immediately.
  vscode.postMessage({ type: "getEngineStatus" });

  // Ask the host for the optional Project Plan state. No-ops on the host
  // side (PLAN_STATE comes back with enabled:false, plan:null) when the
  // feature isn't turned on or there's no workspace.
  vscode.postMessage({ type: "REQUEST_PLAN" });

  // Ask the host for the credit-pressure offload offer's persisted
  // dismissal flag (p6-t1). No-ops host-side (dismissed:false) when there's
  // no workspace. See OFFLOAD_OFFER_STATE handler below and
  // checkCreditPressureOffer/renderCreditPressureOffer near renderMetrics.
  vscode.postMessage({ type: "REQUEST_OFFLOAD_OFFER_STATE" });

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

  /** Skill/pack catalog ids offered as pre-install-optional rows in the Setup
   *  Wizard Step-2 package checkbox list. Most of these ids also exist as a
   *  full pack in media/packs/catalog.json (skills + commands + MCP + agents
   *  + bridge staging); "unreal-engine" does not — it ships as a standalone
   *  skill only, so it falls back to installSkill on Continue (see
   *  describePackageInstalls / the Continue click handler below). */
  var SETUP_SKILL_CHIPS = [
    { id: "playwright", label: "Playwright" },
    { id: "godot", label: "Godot" },
    { id: "unity", label: "Unity" },
    { id: "unreal-engine", label: "Unreal Engine" },
    { id: "uefn", label: "UEFN" },
  ];

  /** Ids above that are also full packs in media/packs/catalog.json, kept
   *  only as an id-routing safety net for the (rare) case Continue is
   *  clicked before the async getPacks response has landed in lastPacks —
   *  the host re-validates the id against the real catalog regardless
   *  (_handleInstallPack), so a stale/unused entry here is harmless. This is
   *  NOT where any "what it installs" copy comes from — that is always read
   *  from the live pack entry in lastPacks (describePackageInstalls). */
  var KNOWN_PACK_CHIP_IDS = ["uefn", "playwright", "godot", "unity"];

  /**
   * Build the "Installs: …" line for a Setup Wizard Step-2 package row from
   * the matching media/packs/catalog.json entry (as returned by getPacks /
   * _handleGetPacks) — skills, slash commands, MCP server, agents, and
   * whether it stages the Python UEFN bridge. Every clause is sourced from
   * `pack`; nothing here is pack-specific prose, so a pack gaining or losing
   * a component is reflected automatically without a code change.
   * @param {any} pack Matching lastPacks entry, or undefined if this chip id
   *   has no pack (falls back to installSkill on Continue).
   * @param {{id:string,label:string}} def The SETUP_SKILL_CHIPS entry.
   * @returns {string}
   */
  function describePackageInstalls(pack, def) {
    if (!pack) {
      return (def && def.label ? def.label : "this") + " skill";
    }
    var parts = [];
    if (Array.isArray(pack.skills) && pack.skills.length) {
      var skillNames = pack.skills
        .map(function (s) { return (s && (s.name || s.id)) || ""; })
        .filter(Boolean);
      if (skillNames.length) {
        parts.push((skillNames.length === 1 ? "skill: " : "skills: ") + skillNames.join(", "));
      }
    }
    if (Array.isArray(pack.commands) && pack.commands.length) {
      parts.push(
        (pack.commands.length === 1 ? "command: " : "commands: ") +
          pack.commands.map(function (c) { return "/" + c; }).join(", ")
      );
    }
    if (pack.mcpName) {
      parts.push("MCP server: " + pack.mcpName);
    }
    if (Array.isArray(pack.agents) && pack.agents.length) {
      var agentNames = pack.agents
        .map(function (a) { return (a && (a.name || a.id)) || ""; })
        .filter(Boolean);
      if (agentNames.length) {
        parts.push((agentNames.length === 1 ? "agent: " : "agents: ") + agentNames.join(", "));
      }
    }
    if (pack.id === "uefn") {
      parts.push("the uefn-bridge MCP is provided by Trashbyrd's Power Tools (installed separately)");
    }
    return parts.length ? parts.join("; ") : "nothing additional";
  }

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
   * Renders in two pieces (top: confirmation/ignore-file checkbox/skill
   * chips, bottom: advanced-tuning link/Done button) with an "already set
   * up" UEFN confirmation line appended between them when applicable, so DOM
   * order matches the wizard spec: confirmation -> optional ignore-file
   * checkbox -> skill chips (UEFN's row is the SINGLE place to opt into
   * UEFN setup — there is no separate action card) -> [UEFN confirmation] ->
   * advanced link -> Done.
   *
   * @param {{engineChips?: Array<{id:string,label:string,state:string,detail:string}>, uefnDetected?: boolean, uefnSignals?: string[], foreignManagedBlocks?: Array<{namespace:string,lines:number}>}} info
   */
  function renderSetupOptionals(info) {
    const setupCard = document.getElementById("setup-card");
    if (!setupCard) return;
    // Cache for renderPacksList — see lastSetupOptionalsInfo declaration.
    lastSetupOptionalsInfo = info;

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

    // Evidence-based, not guessed: panel.ts _detectIgnoreTargets inspects
    // the project (.git dir, existing .p4ignore/.p4config/P4CONFIG,
    // existing .urcignore, or a detected UEFN project) and sends back only
    // the ignore file(s) it actually found signal for. Default ON iff at
    // least one target was detected; when none were, the checkbox is
    // disabled+unchecked with a reason instead of guessing a VCS.
    const gitignoreLabel = document.createElement("label");
    gitignoreLabel.className = "setup-optionals-checkbox-row";
    const gitignoreCheckbox = document.createElement("input");
    gitignoreCheckbox.type = "checkbox";
    gitignoreCheckbox.id = "setup-gitignore-checkbox";
    const ignoreTargets = info && Array.isArray(info.ignoreTargets) ? info.ignoreTargets : [];
    const gitignoreText = document.createElement("span");
    if (ignoreTargets.length > 0) {
      gitignoreCheckbox.checked = true;
      gitignoreText.textContent = "Add Tycoon logs to " + ignoreTargets.join(", ") + " (detected)";
    } else {
      gitignoreCheckbox.checked = false;
      gitignoreCheckbox.setAttribute("disabled", "");
      gitignoreText.textContent = "Add Tycoon logs to ignore file — no version-control ignore file detected";
    }
    gitignoreLabel.appendChild(gitignoreCheckbox);
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

    // Checkbox list (replaces the old click-to-toggle chip row): one row per
    // SETUP_SKILL_CHIPS entry, each showing name + one-line description +
    // a "what this installs" line derived from the matching media/packs/
    // catalog.json entry (fetched via getPacks at boot, cached in lastPacks)
    // — never hardcoded per-pack prose, so it stays correct as packs change.
    const packageList = document.createElement("div");
    packageList.id = "setup-package-list";
    packageList.className = "setup-package-list";

    // Lazily initialize the selection ONCE per wizard session so a later
    // re-render (e.g. the async "packs" response landing after this first
    // paint) never resets ticks the user already made. Per the product
    // spec: UEFN is pre-checked when EITHER signal fires — the project
    // itself looks like UEFN (uefnDetected — project-file signals, see
    // detectUefnProject) OR UEFN is installed on this machine (uefnInstalled
    // — %LOCALAPPDATA%/UnrealEditorFortnite) — plumbed through INSTALL_STATE
    // by panel.ts _handleCheckInstall. Every other row defaults unchecked.
    // This checkbox is now the SINGLE place UEFN setup is offered in the
    // wizard (see removeSetupOptionalsNodes / the UEFN section below —
    // there is no longer a separate "UEFN project detected" card).
    if (setupPackageSelection === null) {
      setupPackageSelection = new Set();
      if (info && (info.uefnDetected || info.uefnInstalled)) setupPackageSelection.add("uefn");
    }

    SETUP_SKILL_CHIPS.forEach(function (def) {
      var pack = lastPacks.find(function (p) { return p && p.id === def.id; });

      const row = document.createElement("label");
      row.className = "setup-package-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "setup-package-checkbox";
      checkbox.dataset.packageChipId = def.id;
      checkbox.checked = setupPackageSelection.has(def.id);
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) setupPackageSelection.add(def.id);
        else setupPackageSelection.delete(def.id);
      });

      const textBlock = document.createElement("div");
      textBlock.className = "setup-package-text";

      const nameEl = document.createElement("span");
      nameEl.className = "setup-package-name";
      nameEl.textContent = (pack && pack.name) || def.label;
      textBlock.appendChild(nameEl);

      const descEl = document.createElement("span");
      descEl.className = "setup-package-desc";
      descEl.textContent = (pack && pack.description) || def.label;
      textBlock.appendChild(descEl);

      const installsEl = document.createElement("span");
      installsEl.className = "setup-package-installs";
      installsEl.textContent = "Installs: " + describePackageInstalls(pack, def);
      textBlock.appendChild(installsEl);

      if (def.id === "uefn" && info && (info.uefnDetected || info.uefnInstalled)) {
        const reasonEl = document.createElement("span");
        reasonEl.className = "setup-package-reason";
        // Reflect whichever signal actually fired rather than always
        // crediting machine-level detection.
        reasonEl.textContent = info.uefnDetected
          ? "This looks like a UEFN project — pre-checked, untick to skip."
          : "UEFN detected on this system — pre-checked, untick to skip.";
        textBlock.appendChild(reasonEl);
      }

      row.appendChild(checkbox);
      row.appendChild(textBlock);
      packageList.appendChild(row);
    });
    top.appendChild(packageList);

    setupCard.appendChild(top);

    // ── UEFN "already set up" confirmation, appended between the two
    //    halves so it lands after the skill chips and before the advanced
    //    link/Done button. There is no separate UEFN action card anymore —
    //    the "UEFN" row in the skill-chip checkbox list above is the single
    //    place UEFN setup (pack + bridge staging) is offered; this is purely
    //    an informational status line for the already-done case.
    const existingUefnConfirm = document.getElementById("uefn-bridge-setup-confirm");
    if (existingUefnConfirm) existingUefnConfirm.remove();
    if (info && info.uefnDetected && info.uefnBridgeSetUp) {
      const confirm = document.createElement("p");
      confirm.id = "uefn-bridge-setup-confirm";
      confirm.className = "setup-optionals-confirm";
      confirm.textContent = "✓ UEFN bridge already set up";
      setupCard.appendChild(confirm);
    }

    // ── Bottom half: advanced-settings call-to-action, Done button ───
    const bottom = document.createElement("div");
    bottom.id = "setup-optionals-bottom";
    bottom.className = "setup-optionals-card";

    // Deliberately a <button> (not the old underlined link) so it reads as a
    // real, clickable call-to-action — but styled muted (.setup-optionals-
    // advanced-btn) relative to Continue below so it stays a secondary
    // action rather than competing with it. Behavior is unchanged: closes
    // the wizard and opens Settings.
    const advancedBtn = document.createElement("button");
    advancedBtn.type = "button";
    advancedBtn.id = "setup-optionals-advanced-btn";
    advancedBtn.className = "setup-optionals-advanced-btn";
    advancedBtn.textContent = "Advanced settings (models, keyword routing, plan, design docs) →";
    advancedBtn.addEventListener("click", function () {
      closeMenu();
      // Leaving the wizard for Settings — remove the Step-2 Optionals nodes
      // (this card, its sibling half, and the UEFN card/confirmation) so
      // they don't stay visibly stacked on top of the Settings panel.
      removeSetupOptionalsNodes();
      // The user has moved past the wizard by choosing this button; mark it
      // done so a later stray installState push (e.g. after Back) goes
      // straight to showMain() instead of re-rendering the wizard.
      setupStage = "done";
      openedFromSettings = true;
      showSetup();
      vscode.postMessage({ type: "checkInstall" });
      vscode.postMessage({ type: "getSettings" });
    });
    bottom.appendChild(advancedBtn);

    // Explicit finalize gate: the ONLY way the wizard leaves the setup
    // screen after "Install hooks". The user must review/select the
    // optionals above (gitignore, UEFN card, package checkboxes) and then
    // click this button on purpose — there is no auto-dismiss on install.
    const continueBtn = document.createElement("button");
    continueBtn.id = "setup-optionals-done-btn";
    continueBtn.className = "skill-btn setup-optionals-continue-btn";
    continueBtn.textContent = "Continue to TycoonAgents";
    continueBtn.addEventListener("click", function () {
      const checkedBoxes = packageList.querySelectorAll(".setup-package-checkbox:checked");
      checkedBoxes.forEach(function (el) {
        const id = el.dataset.packageChipId;
        if (!id) return;
        const pack = lastPacks.find(function (p) { return p && p.id === id; });
        if (pack || KNOWN_PACK_CHIP_IDS.indexOf(id) !== -1) {
          // Pack ids install the WHOLE pack — skills + commands + MCP entry
          // + agents + Python bridge staging where applicable — via the same
          // host path Settings > Packs already uses (_handleInstallPack).
          // This is the fix for the bug where onboarding used to post
          // installSkill for every chip: selecting UEFN installed only the
          // skill and silently skipped the uefn-bridge MCP entry, the
          // verse-expert/uefn-auditor agents, the uefn-moderation-scan
          // command, and the staged Python bridge.
          vscode.postMessage({
            type: "installPack",
            id: id,
            thirdParty: !!(pack && pack.thirdParty),
            disclosures: (pack && Array.isArray(pack.disclosures)) ? pack.disclosures : [],
          });
        } else {
          // No pack entry for this chip id (e.g. "unreal-engine" ships as a
          // standalone skill only) — fall back to the single-skill
          // installer, unchanged from before.
          vscode.postMessage({ type: "installSkill", id: id });
        }
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

  // NOTE: the standalone "UEFN project detected" action card (formerly
  // renderUefnPrompt/handleUefnSetupDone, posting "setupUefnProject") was
  // removed — it duplicated the Setup Wizard Step-2 UEFN checkbox row
  // (SETUP_SKILL_CHIPS above), which is now the single place UEFN setup
  // (pack install + bridge staging) is offered. The host-side
  // _handleSetupUefnProject/MSG.SETUP_UEFN_PROJECT handler is left in place
  // (see panel.ts) in case another flow still calls it; nothing in this
  // webview posts "setupUefnProject" anymore.

  window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    const msg = event.data;
    if (msg && msg.type === "THEME_BUILDER_OPENED") {
      // p75-t2 fix: THEME_BUILDER_OPENED must never open the sign-in shell
      // modal on its own — the plan editor tab opens directly on click
      // (010-modals-badges-rebirth.js), and the shell modal is now reached
      // only via "Generate with AI" while signed out. This just updates the
      // cached status (renderThemeServicePanel keeps the header status chip
      // and #theme-builder-credits-chip current) and, if the shell modal
      // already happens to be open (e.g. Generate with AI opened it and a
      // fresher THEME_BUILDER_OPENED lands after), re-renders its body too.
      // The host already refreshes status in the background after open, so
      // the old extra THEME_SERVICE_GET_STATUS post is dropped as redundant.
      renderThemeServicePanel(msg.payload || null);
    } else if (msg && msg.type === "THEME_SERVICE_STATUS") {
      renderThemeServicePanel(msg.payload || null);
      // p43-t2: refresh the image-review cards' attempt-cost line against
      // the freshly-arrived credits/pricing, without waiting for the host
      // to re-send THEME_IMAGE_REVIEW.
      if (lastThemeImageReviewPayload) renderThemeImageReview(lastThemeImageReviewPayload);
    } else if (msg && msg.type === "THEME_IMAGE_SETTINGS") {
      // deprecated: p40 removed the API-key UI that consumed this message;
      // model/quality selects still exist, but GET/SAVE_THEME_IMAGE_SETTINGS
      // are no longer posted from the webview, so this branch is unreached.
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
    } else if (msg && msg.type === "TEAM_SETUP_EXPORTED") {
      const payload = msg.payload || {};
      const exportBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("team-setup-export-btn"));
      const notice = document.getElementById("team-setup-export-notice");
      if (exportBtn) exportBtn.disabled = false;
      if (notice) {
        notice.textContent = payload.ok
          ? `Exported to ${payload.path || ".claude/tycoon-team.json"}.`
          : "Could not export: " + (payload.error || "unknown error");
        notice.classList.toggle("theme-review-status--error", !payload.ok);
        notice.removeAttribute("hidden");
      }
    } else if (msg && msg.type === "TEAM_SETUP_APPLIED") {
      const payload = msg.payload || {};
      const applyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("team-setup-apply-btn"));
      const notice = document.getElementById("team-setup-export-notice");
      if (applyBtn) applyBtn.disabled = false;
      if (notice) {
        if (payload.ok) {
          const skipped = (payload.missingAgents || []).length
            ? ` (unknown agent ids: ${payload.missingAgents.join(", ")})`
            : "";
          notice.textContent = payload.changed
            ? `Team setup applied.${skipped}`
            : `Already up to date.${skipped}`;
        } else {
          notice.textContent = "Could not apply: " + (payload.error || "unknown error");
        }
        notice.classList.toggle("theme-review-status--error", !payload.ok);
        notice.removeAttribute("hidden");
      }
      const driftApplyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("team-setup-drift-apply-btn"));
      if (driftApplyBtn) driftApplyBtn.disabled = false;
      if (payload.ok) {
        // Re-request drift so the "Team setup changed. Apply?" notice
        // clears once the applied stamp's exportedAt catches up.
        vscode.postMessage({ type: "GET_TEAM_SETUP_DRIFT" });
      }
    } else if (msg && msg.type === "TEAM_READINESS_REPORT") {
      const payload = msg.payload || {};
      const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("team-readiness-check-btn"));
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Check readiness";
      }
      const reportEl = document.getElementById("team-readiness-report");
      if (reportEl) {
        reportEl.textContent = "";
        if (!payload.ok || !payload.report) {
          const errEl = document.createElement("p");
          errEl.className = "theme-review-status--error";
          errEl.textContent = "Could not check readiness: " + (payload.error || "unknown error");
          reportEl.appendChild(errEl);
        } else {
          const harness = payload.report.harness;
          if (harness && harness.team) {
            const harnessEl = document.createElement("p");
            harnessEl.className = "team-readiness-harness";
            const harnessChip = document.createElement("span");
            harnessChip.className = "team-readiness-chip team-readiness-chip--" + (harness.ok ? "ready" : "fallback");
            harnessChip.textContent = harness.ok ? "installed" : "not installed";
            harnessEl.appendChild(document.createTextNode("Harness: " + harness.team + " "));
            harnessEl.appendChild(harnessChip);
            if (!harness.ok && harness.installed) {
              const installedNames = Object.keys(harness.installed).filter(function (id) {
                return harness.installed[id] && harness.installed[id].installed;
              });
              if (installedNames.length > 0) {
                const detailEl = document.createElement("span");
                detailEl.className = "team-readiness-detail";
                detailEl.textContent = " installed here: " + installedNames.join(", ");
                harnessEl.appendChild(detailEl);
              }
            }
            reportEl.appendChild(harnessEl);
          }
          const summaryEl = document.createElement("p");
          summaryEl.className = "team-readiness-summary";
          summaryEl.textContent = payload.report.summary && payload.report.summary.text ? payload.report.summary.text : "";
          reportEl.appendChild(summaryEl);
          const list = document.createElement("ul");
          list.className = "team-readiness-list";
          for (const agent of payload.report.agents || []) {
            const item = document.createElement("li");
            item.className = "team-readiness-item";
            const nameEl = document.createElement("span");
            nameEl.className = "team-readiness-name";
            nameEl.textContent = agent.id;
            const chipEl = document.createElement("span");
            chipEl.className = "team-readiness-chip team-readiness-chip--" + (agent.status || "not_ready");
            chipEl.textContent =
              agent.status === "ready"
                ? "ready"
                : agent.status === "fallback"
                  ? "fallback"
                  : agent.status === "default_fallback"
                    ? "default fallback"
                    : "not ready";
            item.appendChild(nameEl);
            item.appendChild(chipEl);
            if (agent.routingMatches === false) {
              const differsChip = document.createElement("span");
              differsChip.className = "team-readiness-chip team-readiness-chip--differs";
              differsChip.textContent = "differs";
              item.appendChild(differsChip);
            }
            if (agent.status === "default_fallback") {
              const warnChip = document.createElement("span");
              warnChip.className = "team-readiness-chip team-readiness-chip--warn";
              warnChip.textContent = "warn";
              item.appendChild(warnChip);
            }
            const teamModel = agent.team || {};
            const localModel = agent.local || teamModel;
            const teamLabel = teamModel.vendor ? teamModel.vendor + (teamModel.model ? "/" + teamModel.model : "") : "-";
            const localLabel = localModel.vendor ? localModel.vendor + (localModel.model ? "/" + localModel.model : "") : "-";
            const routingEl = document.createElement("span");
            routingEl.className = "team-readiness-routing";
            routingEl.textContent = "team: " + teamLabel + " · you: " + localLabel;
            item.appendChild(routingEl);
            let detailText = "";
            if (agent.status === "fallback" && agent.fallbackUsed) {
              detailText = "uses " + (agent.fallbackUsed.vendor || "fallback");
            } else if (agent.status === "default_fallback" && agent.usedFallback) {
              detailText = "will use default fallback: " + (agent.usedFallback.vendor || "fallback");
            } else if (Array.isArray(agent.missingEnv) && agent.missingEnv.length > 0) {
              detailText = "missing " + agent.missingEnv.join(", ");
            } else if (agent.status === "not_ready" && agent.detail) {
              detailText = agent.detail;
            }
            if (detailText) {
              const detailEl = document.createElement("span");
              detailEl.className = "team-readiness-detail";
              detailEl.textContent = detailText;
              item.appendChild(detailEl);
            }
            list.appendChild(item);
          }
          reportEl.appendChild(list);
        }
        reportEl.removeAttribute("hidden");
      }
    } else if (msg && msg.type === "TEAM_SETUP_DRIFT") {
      const payload = msg.payload || {};
      // Roster is authoritative: the Apply prompt shows only for
      // rosterChanged. routingChanged (manifest routing reference changed,
      // roster unchanged) is informational only — no Apply button.
      const notice = document.getElementById("team-setup-drift-notice");
      if (notice) {
        if (payload.rosterChanged) {
          notice.removeAttribute("hidden");
        } else {
          notice.setAttribute("hidden", "");
        }
      }
      const routingNotice = document.getElementById("team-setup-routing-drift-notice");
      if (routingNotice) {
        if (payload.routingChanged && !payload.rosterChanged) {
          routingNotice.removeAttribute("hidden");
        } else {
          routingNotice.setAttribute("hidden", "");
        }
      }
      const driftApplyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("team-setup-drift-apply-btn"));
      if (driftApplyBtn) driftApplyBtn.disabled = false;
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
        themeBuildStatus.innerHTML = "";
        if (msg.payload?.kind === "not_signed_in") {
          // p65-t3: a PLAN_THEME attempt with no session shows the same Sign
          // in affordance as the per-item generation errors
          // (openThemeBuilderFromReview, 020-theme-plan-editor.js) instead of
          // raw error text — clicking it opens the Theme Builder shell's
          // sign-in view and returns here once signed in.
          themeBuildStatus.appendChild(document.createTextNode("Sign in to plan a theme with AI. "));
          const signInBtn = document.createElement("button");
          signInBtn.className = "skill-btn theme-attempt-action";
          signInBtn.type = "button";
          signInBtn.textContent = "Sign in";
          signInBtn.addEventListener("click", () => openThemeBuilderFromReview());
          themeBuildStatus.appendChild(signInBtn);
        } else {
          themeBuildStatus.textContent = "Error: " + (msg.payload?.message || "Theme planning failed.");
        }
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
    } else if (msg && msg.type === "THEME_PROMPT_MISMATCH") {
      // p59-t3: one-line notice when generateBoardImage's sha256 compare
      // finds the service assembled the prompt from a newer template than
      // the local preview used.
      if (msg.payload?.message && typeof showToast === "function") {
        showToast(msg.payload.message, "info");
      }
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
      themeStageState = "pending";
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
        const envBgEntry = themeFramesRaw["environment_background"];
        const hasEnvBg = Array.isArray(envBgEntry) && typeof envBgEntry[0] === "string" && envBgEntry[0].length > 0;
        if (!hasEnvBg) {
          console.error("TycoonAgents THEME_INITIALIZED: missing environment_background", {
            theme_id: initializedThemeId,
            typeofFrames: typeof themeFramesRaw,
            keyCount: Object.keys(themeFramesRaw).length,
            hasEnvBg,
          });
          fallbackStageMessage = `Theme '${initializedThemeId ?? "unknown"}' failed to load: environment_background missing or empty`;
        } else {
          fallbackStageMessage = "";
        }
        themeLoadStartTs = nowMs(); // restart the loading window for this theme's frames
        preloadThemeImages(themeFramesRaw);
        themeLoaded = true;
        themeStageState = fallbackStageMessage ? "failed" : "loaded";
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
        // Mirrors themeHasFreedFrames(manifest) in src/extension/themePlan.ts.
        themeFreedFramesEnabled = !!manifest && manifest.freed_frames === "v2";
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
        // Designer-marked turret objects (opt-in, default off — see
        // BuildableObject.is_turret). Rebuilt fresh every theme load/repost so
        // a previous theme's marks (or a stale pre-repost value) never leak.
        turretObjectIds = new Set();
        themeBuildables.forEach((obj) => {
          if (obj.is_turret === true) turretObjectIds.add(obj.object_id);
        });
        turretCooldown = {}; // clear stale per-turret cooldowns from any previous theme
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
        // HEAL pre-existing saves rolled before REBIRTH_EXCLUDED_BADGE_IDS
        // existed: strip any now-excluded id (e.g. "crew_6" / Full House,
        // whose 4-simultaneous-agents requirement is outside the user's
        // control) and top the list back up to its original length from the
        // same eligible pool rollRebirthRequirement() draws from, so a save
        // made before this fix doesn't keep gating rebirth on an
        // unreachable badge. If no eligible top-up candidates remain, the
        // list is simply left shorter — the requiredStillValid check below
        // re-rolls it from scratch if that leaves it empty or invalid.
        {
          const originalRequiredLength = requiredRebirthBadgeIds.length;
          requiredRebirthBadgeIds = requiredRebirthBadgeIds.filter(
            (id) => REBIRTH_EXCLUDED_BADGE_IDS.indexOf(id) < 0
          );
          if (requiredRebirthBadgeIds.length < originalRequiredLength) {
            const topUpPool = eligibleRebirthPool().filter(
              (id) => requiredRebirthBadgeIds.indexOf(id) < 0
            );
            while (requiredRebirthBadgeIds.length < originalRequiredLength && topUpPool.length > 0) {
              const idx = Math.floor(Math.random() * topUpPool.length);
              requiredRebirthBadgeIds.push(topUpPool.splice(idx, 1)[0]);
            }
          }
        }
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
        updateTrophyRow();
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
        // Victory lap's own edge-trigger latch/participant set/in-flight run
        // must not survive this reset either — see resetVictoryLapForSceneReset's
        // doc for why a stale latch would spuriously fire a lap on the fresh
        // theme with no combat having happened.
        resetVictoryLapForSceneReset();
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
        // Host-persisted order (roster-order.json, survives a full VS Code
        // reload — see savedRosterOrder in the THEME_INITIALIZED payload)
        // takes priority; vscode.getState()'s rosterOrder is a same-session
        // fast-path fallback for a save that hasn't round-tripped to the host
        // yet. Either way, the reconcile below already tolerates unknown/
        // missing ids (theme edited since the order was saved).
        const hostRosterOrder = msg.payload && Array.isArray(msg.payload.savedRosterOrder)
          ? msg.payload.savedRosterOrder.filter((id) => typeof id === "string")
          : null;
        const savedOrder = hostRosterOrder && hostRosterOrder.length > 0
          ? hostRosterOrder
          : (Array.isArray(saved.rosterOrder) ? saved.rosterOrder : []);
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
        // The theme-picker click handler (~line 4406-4410) renders the themes
        // list SYNCHRONOUSLY on click, before this THEME_INITIALIZED response
        // arrives — at that point rosterOrder still holds the PREVIOUS theme's
        // order, so the "Character roster order" section under the selected
        // theme (rendered from rosterOrder at ~line 4494) was one selection
        // behind until the user clicked again. Re-render now that rosterOrder
        // has just been rebuilt above so it reflects the newly selected theme.
        //
        // Order vs. thumbnails: the ORDER (rosterOrder, just rebuilt above) is
        // ready immediately, but the THUMBNAILS (themeImages, populated by
        // preloadThemeImages earlier in this handler) are NOT — each sprite
        // finishes loading asynchronously. So this render can only guarantee
        // correct ORDER; unready tiles fall back to an initials placeholder
        // (readiness check at ~line 4494) instead of painting blank. Once
        // every sprite for this theme has settled, preloadThemeImages' own
        // onSpriteSettled callback fires exactly one more re-render to swap
        // in the real thumbnails — see themeImagesLoadGen.
        if (Array.isArray(lastThemesList)) {
          renderThemesList(lastThemesList);
        }
      } else {
        console.error("TycoonAgents THEME_INITIALIZED: frames missing or not an object", {
          theme_id: initializedThemeId,
          typeofFrames: typeof msg.payload?.frames,
          keyCount: msg.payload?.frames && typeof msg.payload.frames === "object" ? Object.keys(msg.payload.frames).length : 0,
          hasEnvBg: false,
        });
        fallbackStageMessage = `Theme '${initializedThemeId ?? "unknown"}' failed to load: frames missing or malformed`;
        themeStageState = "failed";
      }
    } else if (msg && msg.type === "THEME_NONE") {
      // Host looked for a theme on "ready" and found none (fresh install) —
      // end the boot loader's loading window right away so it hands off to
      // the no-theme placeholder scene the moment render() actually draws
      // it, instead of idling for LOADING_TIMEOUT_MS/the 12s hard failsafe.
      console.warn("TycoonAgents: THEME_NONE received");
      noThemeSignaled = true;
      themeStageState = "none";
    } else if (msg && msg.type === "CONFIRM_THEME_SWITCH") {
      // Host determined (via shouldWarnOnThemeSwitch, using its persisted
      // per-project badge counts the webview doesn't have) that switching
      // away from the current theme would drop badge visibility, and has
      // NOT switched yet — it's waiting on our decision. Show the in-panel
      // confirm modal (issue #28); "Switch theme" posts
      // SELECT_THEME_CONFIRMED to tell the host to actually proceed,
      // "Cancel"/Escape/backdrop just revert the optimistic selectedThemeId
      // set by the theme-picker click handler (~line 5006) with no host
      // round-trip, since the host never touched anything yet.
      const info = msg.payload;
      if (info && typeof info.targetThemeId === "string") {
        showThemeSwitchConfirmModal(info);
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
    } else if (msg && msg.type === "THEME_DESCRIPTIONS_REGENERATE_RESULT") {
      applyThemeDescriptionsRegenerateResult(msg.payload || {});
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
      // First GENUINE agent-activity observation: flips the "has work
      // actually run this session" flag and arms the grace-period timer
      // exactly once (see agentActivityObserved/orchestratorModelGraceTimer
      // above). Guarded so every later "state" message is a no-op here.
      // Deliberately reads msg.sessionMetrics, NOT msg.state.agentMetrics:
      // state.agentMetrics is cumulative across ALL past sessions, so it's
      // already populated on panel open for any returning user — using it
      // here would arm the grace timer (and 5s later show the warning) on
      // every panel open regardless of whether anything actually ran this
      // time, which is the exact false-positive this trigger exists to
      // avoid. msg.sessionMetrics is scoped to the CURRENT session id only
      // (reset at the session boundary — see panel.ts's
      // _computeSessionDelegationHealth) and only reports `available: true`
      // once activity.jsonl has an actual record for this session, so a
      // non-empty agentMetrics here means real work happened, not just that
      // the panel was opened.
      if (
        !agentActivityObserved &&
        msg.sessionMetrics &&
        msg.sessionMetrics.available &&
        Array.isArray(msg.sessionMetrics.agentMetrics) &&
        msg.sessionMetrics.agentMetrics.length > 0
      ) {
        agentActivityObserved = true;
        orchestratorModelGraceTimer = setTimeout(() => {
          orchestratorModelGraceElapsed = true;
          orchestratorModelGraceTimer = null;
          renderSettings();
        }, 5000);
      }
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
      // Session-scoped agentMetrics (0.0.528, see panel.ts's _postStateUpdate)
      // for the Metrics tab's "This session" scope. Update BEFORE
      // renderMetrics() so currentScopeMetrics() picks it up on this push,
      // and BEFORE updateMetricsScopeUI() so the toggle/header/caption
      // reflect the fresh availability immediately.
      lastSessionMetrics =
        msg.sessionMetrics && typeof msg.sessionMetrics === "object"
          ? msg.sessionMetrics
          : { available: false, reason: "Session data isn't available yet." };
      updateMetricsScopeUI();
      // Update metrics panel
      renderMetrics(state.agentMetrics);
      renderDelegationStats(state.modeStats, msg.toolCompliance);
      // Routing view (p13-t3, audit fix): if open, repaint ONLY its fallback
      // chips + Totals block in place — NOT a full renderRoutingModal()
      // rebuild, which would steal focus/caret from a slot input mid-typing
      // and collapse any open fallback-chain <details>. See
      // updateRoutingViewLive's doc comment.
      updateRoutingViewLive();
    } else if (msg && msg.type === "skills") {
      renderSkillsList(msg.skills, msg.error);
      // Skills/MCP/Packs installed state feeds buildUefnHealthSummaryRow's
      // install-based gate (see that function) — re-render Settings so the
      // compact "UEFN health" line appears/disappears immediately when the
      // UEFN skill/pack/MCP is installed or removed mid-session, without
      // waiting for an unrelated "settings"/"installState" push.
      renderSettings();
    } else if (msg && msg.type === "skillInstalled") {
      handleSkillInstalled(msg.id, msg.ok, msg.alreadyExisted, msg.error);
    } else if (msg && msg.type === "skillRemoved") {
      handleSkillRemoved(msg.id, msg.ok, msg.error, msg.cancelled);
    } else if (msg && msg.type === "mcp") {
      renderMcpList(msg.servers, msg.error);
      // See the "skills" branch above — same install-based gate refresh.
      renderSettings();
    } else if (msg && msg.type === "mcpInstalled") {
      handleMcpInstalled(msg.id, msg.ok, msg.alreadyExisted, msg.error, msg.cancelled);
    } else if (msg && msg.type === "mcpRemoved") {
      handleMcpRemoved(msg.id, msg.ok, msg.error, msg.cancelled);
    } else if (msg && msg.type === "packs") {
      renderPacksList(msg.packs, msg.error);
      // See the "skills" branch above — same install-based gate refresh.
      renderSettings();
    } else if (msg && msg.type === "packInstalled") {
      handlePackInstalled(msg.id, msg.ok, msg.results, msg.error, msg.cancelled);
    } else if (msg && msg.type === "packRemoved") {
      handlePackRemoved(msg.id, msg.ok, msg.results, msg.error, msg.cancelled);
    } else if (msg && msg.type === "agentRemoved") {
      handleAgentRemoved(msg.id, msg.ok, msg.cancelled, msg.error);
    } else if (msg && msg.type === "installState") {
      lastUefnBridgeSetUp = Boolean(msg.uefnBridgeSetUp);
      // Path Health (see src/host/vscode/pathHealth.ts) piggybacks on this
      // same push rather than a separate round trip — capture it here and
      // re-render the UEFN/Verse modal body so a Save/Clear/Refresh's fresh
      // re-probe (which re-invokes _handleCheckInstall host-side) shows up
      // immediately even though it arrived on "installState", not
      // "settings". Path Health moved out of renderSettings() into its own
      // modal (see renderUefnModalBody()); that function no-ops via its own
      // getElementById guard when the modal body isn't in the DOM yet, so
      // this is safe to call on every installState push (including the very
      // first one at panel load, before the modal has ever been opened) —
      // it just won't have visible effect until the modal is open, at which
      // point the "menu-uefn" click handler also renders it fresh on open.
      lastPathHealth = Array.isArray(msg.pathHealth) ? msg.pathHealth : [];
      lastPathOverridesFilePath = msg.pathOverridesFilePath || null;
      lastPathOverridesFileExists = Boolean(msg.pathOverridesFileExists);
      lastVerseExtensionState = msg.verseExtensionState || null;
      lastUefnInstalled = Boolean(msg.uefnInstalled);
      // Gate the rebuild to genuine changes only — mirrors the same guard
      // renderSettings() itself uses elsewhere, so an installState push with
      // no path-health change doesn't rebuild the modal body (and, if it's
      // open, wipe focus/scroll position) for no reason. Also re-renders
      // Settings itself (wiped/rebuilt the same way a "settings" push does)
      // so the compact "UEFN health" summary line (buildUefnHealthSummaryRow)
      // stays in sync with the modal instead of only updating on the next
      // unrelated "settings" push.
      const pathHealthSnapshot = JSON.stringify([lastPathHealth, lastPathOverridesFilePath, lastPathOverridesFileExists, lastVerseExtensionState, lastUefnInstalled]);
      if (pathHealthSnapshot !== lastPathHealthSnapshot) {
        lastPathHealthSnapshot = pathHealthSnapshot;
        renderUefnModalBody();
        renderSettings();
      }
      handleInstallState(msg);
      // The Step-2 Optionals branch (renderSetupOptionals) shows the UEFN
      // "already set up" confirmation inline when applicable — there is no
      // separate standalone UEFN card/prompt anymore (the Step-2 UEFN
      // checkbox row is the single place UEFN setup is offered), so no
      // generic fallback render is needed here.
    } else if (msg && msg.type === "settings") {
      lastSettings = msg.payload || null;
      renderSettings();
      // p20-t2: a new settings payload can flip lastSettings.harness.effective
      // while the Agents screen is open — re-render it too so density
      // switches live. Guarded like
      // updateRoutingViewLive: only while the modal actually exists and is
      // visible, and only once lastRoutingPayload/routingDraft exist (a
      // "settings" push can arrive before the first "routing" reply).
      if (routingModalEl && !routingModalEl.hasAttribute("hidden") && lastRoutingPayload) {
        renderRoutingModal();
      }
    } else if (msg && msg.type === ROUTING_MSG.ROUTING) {
      handleRoutingPayload(msg.payload || null);
    } else if (msg && msg.type === KEYWORD_HEALTH_MSG.HEALTH) {
      // Flat envelope (findings/wildcardTasksThisSession/unmatchedWords are
      // top-level on the message, not nested under `payload` — see
      // panel.ts's _postKeywordHealth).
      handleKeywordHealthPayload({
        findings: msg.findings || [],
        wildcardTasksThisSession: msg.wildcardTasksThisSession || 0,
        unmatchedWords: msg.unmatchedWords || [],
      });
    } else if (msg && msg.type === ROUTING_MSG.SAVED) {
      handleRoutingSaved(msg);
    } else if (msg && msg.type === ROUTING_MSG.PROBE_REPLY) {
      handleEnvProbeReply(msg);
    } else if (msg && msg.type === "settingsUpdated") {
      handleSettingsUpdated(msg);
    } else if (msg && msg.type === "pathOverrideResult") {
      handlePathOverrideResult(msg);
    } else if (msg && msg.type === "metricsReset") {
      handleMetricsReset(msg);
    } else if (msg && msg.type === "feedbackPreview") {
      handleFeedbackPreview(msg);
    } else if (msg && msg.type === "feedbackResult") {
      handleFeedbackResult(msg);
    } else if (msg && msg.type === "legacyArtifactsDetected") {
      showLegacyArtifactsNotice(Number(msg.artifactCount) || 0, Number(msg.foreignHookCount) || 0);
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
      // Declared here (not inside the `if (foreign.length > 0)` block below)
      // so the "Fix issues" click handler's closure can read whatever the
      // foreign-hooks checkbox is set to at click time — assignment happens
      // further down, but by the time either button is clicked the whole
      // report has already rendered.
      let removeForeignCheckbox = null;
      if (hasFixable) {
        const fixRow = document.createElement("div");
        fixRow.className = "doctor-action-row";
        const fixBtn = document.createElement("button");
        fixBtn.className = "skill-btn settings-btn";
        fixBtn.textContent = "Fix issues";
        fixBtn.addEventListener("click", () => {
          fixBtn.disabled = true;
          fixBtn.textContent = "Fixing…";
          // Checked by default (see below) — the default repair now removes
          // foreign hooks too, instead of silently leaving them behind.
          const removeForeign = Boolean(removeForeignCheckbox && removeForeignCheckbox.checked);
          vscode.postMessage({ type: "applyDoctorFix", removeForeign });
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

        const removeForeignToggle = document.createElement("label");
        removeForeignToggle.className = "doctor-caution-toggle";
        removeForeignCheckbox = document.createElement("input");
        removeForeignCheckbox.type = "checkbox";
        removeForeignCheckbox.id = "doctor-remove-foreign-checkbox";
        // ON by default: leaving this unchecked is the leaking state (foreign
        // hooks survive the fix and keep spooling unread agent-activity-*.json
        // spool files), so checked is the correct default.
        removeForeignCheckbox.checked = true;
        removeForeignToggle.appendChild(removeForeignCheckbox);
        const removeForeignLabelText = document.createElement("span");
        removeForeignLabelText.textContent = `Remove foreign hooks (${foreign.length})`;
        removeForeignToggle.appendChild(removeForeignLabelText);
        cautionDiv.appendChild(removeForeignToggle);

        const removeForeignWarning = document.createElement("div");
        removeForeignWarning.className = "delegation-mode-footnote";
        removeForeignWarning.textContent = "Removes other harnesses' hooks — only one can track a project.";
        cautionDiv.appendChild(removeForeignWarning);

        const removeBtn = document.createElement("button");
        removeBtn.className = "skill-btn settings-btn danger-btn";
        removeBtn.textContent = "Remove now";
        removeBtn.disabled = !removeForeignCheckbox.checked;
        removeForeignCheckbox.addEventListener("change", () => {
          removeBtn.disabled = !removeForeignCheckbox.checked;
        });
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
    } else if (msg && msg.type === "OFFLOAD_OFFER_STATE") {
      // Credit-pressure offload offer (p6-t1): boot-time reply to
      // REQUEST_OFFLOAD_OFFER_STATE carrying the two persisted flags plus a
      // FRESH (non-persisted) host-side providerAvailable check. Detection
      // re-evaluation happens on the next renderMetrics() call
      // (checkCreditPressureOffer), not here. `providerAvailable` defaults
      // false (Boolean(undefined) === false) so an older host build that
      // predates this field, or any falsy/missing value, fails CLOSED —
      // never shows an offer for an unconfirmed route.
      offloadOfferDismissed = Boolean(msg.dismissed);
      offloadOfferAccepted = Boolean(msg.accepted);
      offloadProviderAvailable = Boolean(msg.providerAvailable);
      renderCreditPressureOffer();
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
   * Last skills catalog array received (see renderSkillsList) — read by
   * buildUefnHealthSummaryRow to check whether the UEFN skill is installed
   * IN THIS PROJECT, mirroring lastMcpServers/lastPacks above.
   */
  let lastSkills = [];

  /**
   * Build the standing notice for a catalog list.
   * @param {"third-party"|"local"} kind
   * @returns {HTMLElement}
   */
