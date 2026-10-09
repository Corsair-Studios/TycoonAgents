// Part: 30-theme-picker-list
// Theme picker list rendering and related theme review section builders.
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
      // p81-t1: name first, full flexible width, ellipsis only once it runs
      // out of room; status/SELECTED badge move to a second line underneath
      // so a long name never gets squeezed by the status text next to it.
      const nameLabel = document.createElement("span");
      nameLabel.className = "theme-picker-name";
      nameLabel.textContent = themeName;
      const metaRow = document.createElement("span");
      metaRow.className = "theme-picker-meta";
      if (isSelected) {
        const badge = document.createElement("span");
        badge.className = "theme-selected-badge";
        badge.textContent = "Selected";
        metaRow.appendChild(badge);
      }
      const approvalLabel = document.createElement("span");
      approvalLabel.className = "theme-picker-approval" + (theme.export_ready ? " theme-picker-approval--ready" : "");
      approvalLabel.textContent = theme.export_ready
        ? "Ready to export"
        : theme.total
          ? `${theme.accepted}/${theme.total} approved`
          : "Review required";
      metaRow.appendChild(approvalLabel);
      btn.appendChild(nameLabel);
      btn.appendChild(metaRow);
      btn.addEventListener("click", () => {
        selectedThemeId = theme.theme_id;
        vscode.postMessage({ type: 'SELECT_THEME', payload: { theme_id: theme.theme_id } });
        // Refresh the list so the selected highlight updates immediately
        renderThemesList(lastThemesList);
      });

      const reviewBtn = document.createElement("button");
      reviewBtn.className = "skill-btn";
      reviewBtn.textContent = "Review";
      reviewBtn.title = "Review images";
      reviewBtn.setAttribute("aria-label", "Review images");
      reviewBtn.addEventListener("click", () => {
        // p79-t1: reviewing an existing theme reuses the manual screen —
        // board grid + header (Back/name/Save theme), no AI-only elements.
        themeBuilderScreen = "manual";
        if (themePromptInput) themePromptInput.value = theme.display_name || "";
        // showThemeImageReview itself ends in renderThemeBuilderScreen
        // (p79-t2 review fix).
        showThemeImageReview(theme.theme_id);
      });

      const exportBtn = document.createElement("button");
      exportBtn.className = "skill-btn";
      exportBtn.type = "button";
      exportBtn.textContent = "Export";
      exportBtn.disabled = !theme.export_ready;
      exportBtn.dataset.exportReady = String(Boolean(theme.export_ready));
      exportBtn.title = theme.export_ready
        ? `Export ${themeName} as a .zip file`
        : `Approve every theme image before exporting (${theme.accepted || 0}/${theme.total || 0} approved)`;
      exportBtn.setAttribute("aria-label", "Export .zip");
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
        // Order comes from rosterOrder (rebuilt synchronously in the
        // THEME_INITIALIZED handler, ~line 9059-9068); thumbnails come from
        // themeImages (populated by preloadThemeImages in that SAME handler,
        // but each Image's .src is assigned asynchronously once its sprite
        // decodes — see loadDefringedFrame). A correct render needs BOTH: the
        // handler's immediate re-render can land before any sprite has
        // finished loading, so thumbImg can be a real-but-not-yet-ready
        // Image (truthy, .src === ""), which used to paint a blank/broken
        // <img>. Require complete+naturalWidth so an unready sprite falls
        // back to the initials placeholder instead; preloadThemeImages fires
        // one follow-up re-render once every sprite for this theme has
        // settled (see themeImagesLoadGen), which then swaps in the real art.
        const slots = themeImages[charId];
        const candidate = slots && (slots[16] || slots[0]);
        const thumbImg = candidate && candidate.complete && candidate.naturalWidth > 0 ? candidate : null;

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
          // Durable host-side persist (survives a full VS Code reload) —
          // vscode.setState above stays as a same-session fast-path cache.
          saveRosterOrder();

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
    // Only closing the first-run install screen itself counts as a dismissal;
    // a normal Settings -> Back must not hide a broken install.
    if (!openedFromSettings) setupDismissed = true;
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

  // Evaluated ONCE at startup and cached (never per-frame): whether the OS
  // reports a reduced-motion preference. Used by the disco-party AND conga
  // easter eggs' shared lighting/ball layer (see drawDiscoOverlay /
  // drawDiscoBall, gated on partyVisualIntensity) to suppress the moving
  // lights and ball for either party type, and by the disco party's own
  // rare random trigger (updateDiscoParty) — a real photosensitivity safety
  // gate, not a style preference.
  const prefersReducedMotion = (() => {
    try {
      return typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  })();

  // ── Theme character rendering ────────────────────────────────────────────
  // ATLAS_CLIPS mirrors src/extension/themePlan.ts exactly — keep in sync
  // (a parity test enforces the two stay identical). Row-1 cells 1-4 are a
  // four-frame walk cycle; cell 5 stays the back view.
  const ATLAS_CLIPS = {
    walk:      { frames: [0, 1, 2, 3],  fps: 10, loop: true,  flippable: true },
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
    // Cell 5 (back view). Only played when the active theme's manifest
    // carries freed_frames: 'v2' — see themeHasFreedFrames in
    // src/extension/themePlan.ts (parity-tested).
    stand_back: { frames: [4], fps: 0, loop: true, flippable: false, hold: true },
    // Idle ambient combat (cosmetic hit-reaction): a brief block/flinch pose.
    // Frame 14 is this block clip's OWN dedicated dodge/flinch frame (no longer
    // part of the melee clip). Played as a one-shot emote override
    // (see playEmote / charEntry.emoteClip) exactly like point/signal —
    // characters take NO damage, this is purely visual.
    block:     { frames: [14],             fps: 6,  loop: false, flippable: true },
  };

  // True only when the active theme's manifest carries freed_frames: 'v2' —
  // mirrors themeHasFreedFrames in src/extension/themePlan.ts (parity-
  // tested there; main.js can't import it since it's a plain webview IIFE,
  // not bundled). Set on THEME_INITIALIZED; gates stand_back/idle_rare below.
  let themeFreedFramesEnabled = false;

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
  // ── Graded structural damage (Plan p1-t2) ────────────────────────────────
  // Damage is a continuous 0..1 value that ramps while a structure is under
  // sustained attack, instead of latching straight to "fully smoking" the
  // moment SMOKE_ATTACK_DELAY elapses. Smoke intensity is DRIVEN by this
  // value, so a freshly-damaged object smokes faintly and thickens the
  // longer the attack continues, clamped at 1 (never destroyed/un-built —
  // see objectSmoke.damage). Persists (no auto-decay) once the attack
  // stops; only a completed repair (updateExtinguishProgress) clears it.
  // STRUCTURE_DAMAGE_PER_SEC (derived from BUILD_SECONDS_PER_OBJECT, plan
  // p4-t1) is declared further down, right after BUILD_SECONDS_PER_OBJECT
  // itself — that const isn't defined yet at this point in the top-level
  // init order, and this whole file is one IIFE evaluated top-to-bottom, so
  // referencing it here would hit the const TDZ (same pattern as
  // TURRET_HIT_DAMAGE above).
  const SMOKE_DAMAGE_INTENSITY_FLOOR = 0.35; // min smoke intensity once `damaged` is true — fresh-damage alpha = SMOKE_MAX_ALPHA * 0.35 = 0.55 * 0.35 = ~0.19 (~19% opacity); the old 0.15 floor (~8% opacity) was too faint to read as damage at a glance
  // ── Extinguish / Repair (Plan p1-t4) ─────────────────────────────────────
  // Repair now acts DIRECTLY on the same graded `damage` value the attack
  // ramp writes (STRUCTURE_DAMAGE_PER_SEC, above) — extinguishing smoke and
  // repairing damage are the same action. Each arrived, non-combat repairer
  // reduces damage at STRUCTURE_REPAIR_PER_SEC/sec (updateExtinguishProgress),
  // while updateObjectSmoke keeps ramping damage up on any frame the object
  // is still under attack; both run once per frame against the same field,
  // so a structure fought AND repaired simultaneously nets the difference.
  // STRUCTURE_REPAIR_PER_SEC (also derived from BUILD_SECONDS_PER_OBJECT,
  // plan p4-t1) is declared alongside STRUCTURE_DAMAGE_PER_SEC further down
  // for the same TDZ reason — see the note above.
  const EXTINGUISH_MAX_ASSIGN = 3;   // max characters routed to one smoking object
  const EXTINGUISH_ARRIVE_EPS = 24;  // native px: within this of a repairer's OWN stand spot counts as "arrived"
  const EXTINGUISH_STAND_RADIUS = 28; // native px: ring radius around the object each repairer stands at (distinct per-slot spot, no pile-up)
  // ── Turret auto-fire (Plan p2-t2) ─────────────────────────────────────────
  // A BUILT object the designer flagged is_turret (see turretObjectIds below)
  // auto-targets the nearest in-range attacker and fires a cosmetic projectile
  // via the existing spawnProjectile pipeline (~1 shot/sec). Purely additive:
  // objects not in turretObjectIds, or themes without projectile art, never
  // fire. The damaged-disable gate (p2-t4) is deliberately NOT implemented
  // here. Damage-to-rival/repel (p2-t3, below) IS implemented: each shot
  // reuses the same `hp` field agents drain (AGENT_DPS) and the same
  // hp<=0 → fleeing eviction path (advanceEnemies), and briefly staggers the
  // target so it stops ramping structure damage (updateObjectSmoke gate).
  const TURRET_RANGE = 420;             // native px: 3x ENEMY_RANGED_RANGE (120), tripled from the original 140; tunable
  const TURRET_FIRE_INTERVAL_MS = 1000; // ms between shots per turret (~1/sec); tunable
  const TURRET_DAMAGE_FRACTION = 0.1;   // fraction of an agent's DPS a turret shot deals, amortized over its fire interval; tunable
  // TURRET_HIT_DAMAGE (derived from AGENT_DPS) is declared further down,
  // right after AGENT_DPS itself — AGENT_DPS isn't defined yet at this point
  // in the top-level init order, and this whole file is one IIFE evaluated
  // top-to-bottom, so referencing it here would hit the const TDZ.
  const TURRET_STAGGER_SEC = 0.5;       // seconds a struck rival stops attacking structures; tunable
  // p3-t1: a turret-flagged object is withheld from buildQueue (see
  // buildSeededQueue) until the player has completed this many rebirths, then
  // appears automatically — no reload required (see doRebirth's live splice).
  const TURRET_UNLOCK_REBIRTH = 2;      // rebirths required before a turret object becomes buildable; tunable
  // p3-t2: the disco dance party (random trigger AND the Alt+D hotkey) is
  // withheld until the player has completed this many rebirths — an
  // advertised unlock, mirroring TURRET_UNLOCK_REBIRTH above. The conga line
  // stays intentionally ungated (still random + Alt+C) — see updateDiscoParty
  // and the keydown handler's Alt+D branch for the two gate checks.
  const DANCE_PARTY_UNLOCK_REBIRTH = 3; // rebirths required before the disco dance party unlocks; tunable
  // p3-t3: the dance-off (random trigger AND the Alt+O hotkey) unlocks one
  // tier above the disco dance party — its own constant, since it no longer
  // shares a tier with DANCE_PARTY_UNLOCK_REBIRTH. See updateDanceOff and the
  // keydown handler's Alt+O branch for the two gate checks.
  const DANCE_OFF_UNLOCK_REBIRTH = 4;   // rebirths required before the dance-off unlocks; tunable
  // p3-t4: the wave-clear "victory lap" fires on a gated cadence, not every
  // clear — see VICTORY_LAP_CLASH_INTERVAL/VICTORY_LAP_CHANCE/victoryLapClashCount
  // near updateVictoryLap: only every VICTORY_LAP_CLASH_INTERVAL-th wave-clear
  // "clash" even rolls, and that roll only hits VICTORY_LAP_CHANCE of the
  // time, from the very start of the game, so combat's payoff stays a
  // surprise rather than a guarantee. This constant only gates the UPGRADE:
  // when a lap DOES fire, it gets longer, plus the shared party lighting/ball
  // (partyVisualIntensity/getActivePartyPalette) and a confetti burst, once
  // the player reaches this rebirth tier — mirroring DANCE_OFF_UNLOCK_REBIRTH's
  // gate style one line up. The Alt+P gold-preview override (below) also
  // force-shows the upgraded version early — see startVictoryLap.
  const VICTORY_LAP_UNLOCK_REBIRTH = 5; // rebirths required before a wave-clear victory lap gets the upgraded (lit/confetti) version; whether a lap fires at all is gated separately (VICTORY_LAP_CLASH_INTERVAL/VICTORY_LAP_CHANCE); tunable
  // p3-t5: the gold/amber party palette (disco lighting, the disco ball, and
  // the dance-off winner confetti — see getActivePartyPalette further down)
  // unlocks one tier above the dance-off. Alt+P previews it without touching
  // this gate or rebirthCount — see the keydown handler's Alt+P branch.
  const GOLD_PALETTE_UNLOCK_REBIRTH = 6; // rebirths required before the gold party palette unlocks; tunable

  /** Theme data set by THEME_INITIALIZED */
  let themeLoaded = false;
  /**
   * Explicit stage theme-readiness state, separate from themeLoaded/noThemeSignaled
   * so the stage draw and boot-loader dismissal can tell "no verdict yet" apart from
   * "verdict is no-theme" apart from "verdict is a broken theme":
   *   'pending' — initial; host hasn't answered yet. Stage draws plain dark fill only
   *               (no sky/ground fallback) and the boot loader must not dismiss.
   *   'loaded'  — THEME_INITIALIZED preloaded a usable theme (themeLoaded becomes true
   *               with no fallbackStageMessage).
   *   'none'    — THEME_NONE received, or the 15s pending safety cap fired.
   *   'failed'  — THEME_INITIALIZED arrived but frames/environment_background were
   *               missing or malformed (fallbackStageMessage is set).
   * 'none' and 'failed' both use today's sky/ground fallback stage; only 'pending'
   * suppresses it.
   * @type {'pending'|'loaded'|'none'|'failed'}
   */
  let themeStageState = "pending";
  /** Set when THEME_INITIALIZED arrives without usable frames/environment_background; drawn on the fallback stage instead of failing silently. */
  let fallbackStageMessage = "";
  /** @type {Record<string, string[]>} raw frames per character (slot → data-URI) */
  let themeFramesRaw = {};
  /** @type {Record<string, HTMLImageElement[]>} preloaded Image objects per character */
  let themeImages = {};
  /** Bumped on every preloadThemeImages() call; lets a stale settle-callback
   *  from a superseded theme load detect it's no longer current and skip its
   *  follow-up roster re-render (see preloadThemeImages/loadDefringedFrame). */
  let themeImagesLoadGen = 0;
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
   * column opacity/scale factor (now DERIVED from `damage`, floored while
   * damaged — see updateObjectSmoke); anim: seconds elapsed, drives the
   * rising loop. damaged: true once the object has taken a full
   * SMOKE_ATTACK_DELAY of attack. damage: 0..1 graded damage value that
   * ramps by STRUCTURE_DAMAGE_PER_SEC per second while actively attacked,
   * clamped to 1, and never auto-decays — so the object keeps smoking (even
   * after the attacking rival leaves/dies), at a density proportional to
   * accumulated damage, until repaired. Repair (updateExtinguishProgress)
   * reduces this SAME field by STRUCTURE_REPAIR_PER_SEC per active repairer;
   * the entry is deleted once damage reaches 0 — damage is the single
   * source of truth for both smoke/health-bar display and repair
   * completion. Created lazily the first frame an object is under attack;
   * deleted only on repair completion. Purely visual — never affects
   * build/attack logic.
   * @type {Record<string, {underAttack:number, intensity:number, anim:number, damaged?:boolean, damage?:number}>}
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
  /**
   * Object IDs the designer has marked as turrets (manifest
   * buildable_objects[].is_turret === true), keyed by nothing else — a flat
   * Set of object_id. Phase 2 groundwork: this Set is the ONLY thing a later
   * auto-fire feature needs to read; nothing here fires anything yet. Reset
   * and rebuilt every THEME_INITIALIZED alongside objectAnimParams above, so
   * it never leaks a previous theme's (or a stale pre-repost) turret marks.
   * @type {Set<string>}
   */
  let turretObjectIds = new Set();
  /**
   * Per-turret fire cooldown (Plan p2-t2), keyed by object_id, in the SAME ms
   * unit as TURRET_FIRE_INTERVAL_MS. Decremented by delta*1000 each frame in
   * the turret update pass; a turret fires only when its entry is <= 0 (or
   * absent — treated as 0, so a freshly-built turret can fire immediately).
   * Reset/cleared every THEME_INITIALIZED alongside turretObjectIds so a
   * previous theme's cooldowns never leak.
   * @type {Record<string, number>}
   */
  let turretCooldown = {};
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
  /**
   * Persist the current rosterOrder (drag-reorder in the "Character roster
   * order" modal section, including which character sits in Seat 1 / leader
   * — leader-ness is derived purely from rosterOrder[0], see isLeaderEntry)
   * to the host, mirroring saveBuildProgress so the order survives a full
   * VS Code reload instead of only living in vscode.setState. Posted under
   * selectedThemeId. No-ops if no theme is loaded.
   */
  function saveRosterOrder() {
    if (!selectedThemeId) return;
    vscode.postMessage({
      type: "saveRosterOrder",
      payload: { themeId: selectedThemeId, rosterOrder: rosterOrder.slice() },
    });
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
  // vscode state; DOES reset buildBuiltCount (built objects) but NEVER
  // touches rivalsEvictedCount/agent metrics directly — see doRebirth()).
  // Badges measure progress WITHIN the current rebirth cycle via the
  // baselines below, since the underlying lifetime counters persist through
  // rebirth. ──────────────────────────────────────────────────────────────
  /** Number of times the player has rebirthed. Drives ranged-weapon + build-speed bonuses. */
  let rebirthCount = 0;
  /**
   * Lifetime-counter snapshot captured at the moment of the last rebirth (or
   * 0/0/0 if never). Only `.tasks` is actually read (updateBadgeUnlocks'
   * effTasks) — `.built`/`.evicted` are write-only today (OBJECTS_BUILT/
   * RIVALS_EVICTED badge progress reads cycleObjectsBuilt/cycleRivalsEvicted
   * instead, and THEME_INITIALIZED always re-zeroes them on load), kept only
   * so a saved snapshot never reads as truthful-but-stale.
   */
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
    "crew_3",
  ];
  const REBIRTH_TIER_MID = [
    "build_6", "build_10", "build_13",
    "evict_20", "evict_35", "evict_50", "evict_75", "evict_100",
    "task_50", "task_150",
    "reborn_builder",
  ];
  const REBIRTH_TIER_LATE = [
    "build_10", "build_13",
    "evict_50", "evict_75", "evict_100",
    "task_150", "task_500",
    "reborn_builder",
  ];
  /**
   * Badge ids that must NEVER be selected as a rebirth requirement, even
   * though they stay fully intact and earnable as normal badges. "Full
   * House" (crew_6, 4 agents simultaneously active) requires a level of
   * concurrent agent activity that is outside the user's control — the
   * project's parallel-agent limit is commonly 2 — so gating rebirth on it
   * can hand the user a requirement they may never be able to satisfy,
   * permanently blocking rebirth. Enforced in rollRebirthRequirement() (via
   * eligibleRebirthPool()) and re-applied as a heal to pre-existing saves
   * at restore time.
   */
  const REBIRTH_EXCLUDED_BADGE_IDS = ["crew_6"];
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
  // ── Structure damage/repair rates (Plan p4-t1) ───────────────────────────
  // Derived from BUILD_SECONDS_PER_OBJECT so the "un-build" bar (damage bar,
  // drawn identically to the build-progress bar) reads at a deliberately
  // slower pace than building — a single-character build fills the bar in
  // BUILD_SECONDS_PER_OBJECT seconds; damage alone now takes ~2x that (a
  // sustained attack ramps damage 0→1 in 2 * BUILD_SECONDS_PER_OBJECT
  // seconds), while ONE repairer empties the same bar back out at full build
  // speed (BUILD_SECONDS_PER_OBJECT seconds), letting a single defender
  // out-pace a single attacker. Declared here (not with the rest of the
  // STRUCTURE_* block above) to avoid the BUILD_SECONDS_PER_OBJECT TDZ — see
  // the note left in that block.
  const STRUCTURE_DAMAGE_PER_SEC = 0.5 / BUILD_SECONDS_PER_OBJECT; // ~0.00833/s per attacker — tunable, derived
  const STRUCTURE_REPAIR_PER_SEC = 1 / BUILD_SECONDS_PER_OBJECT;   // ~0.0167/s per active repairer — tunable, derived
  // Damage now stacks per attacker (see updateObjectSmoke), so this caps how
  // much a large swarm can accelerate the ramp — without a cap, a big raid
  // could take a structure from undamaged to fully damaged in a single
  // frame's worth of seconds; capped, the fastest possible ramp is bounded
  // regardless of how many rivals pile onto one object.
  const STRUCTURE_MAX_ATTACKERS = 4;
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
   *   stays out of the pool entirely while this is < 1, and any is_turret
   *   object is always excluded from the shuffle pool and appended at the
   *   END of the returned queue only once this is >= TURRET_UNLOCK_REBIRTH
   *   (p3-t1; see doRebirth for the live-append that adds a turret without a
   *   reload the instant that threshold is first crossed).
   * @param {number|null} [rackInsertIndex] persisted splice index for the
   *   rack; null/undefined falls back to appending at the end.
   * @returns {string[]}
   */
  function buildSeededQueue(buildables, themeId, rebirthCount, rackInsertIndex) {
    const rackId = buildables.length > 0 ? buildables[0].object_id : null;
    let pool = rackId !== null ? buildables.filter((o) => o.object_id !== rackId) : buildables;
    // p3-t1: turret-flagged objects are ALWAYS excluded from the shuffle pool
    // itself (UNCONDITIONALLY — regardless of rebirthCount), same treatment
    // as the rack above. CRITICAL: the seeded Fisher-Yates shuffle's
    // permutation depends on the pool's length/contents, so filtering
    // turrets CONDITIONALLY (only when locked) would make every OTHER
    // object's shuffle order differ once a turret unlocks — scrambling
    // buildBuiltCount's already-built prefix on the very next reload (bug
    // caught in review). Keeping the pre-shuffle pool identical in every
    // rebirth state keeps every non-turret object's position stable forever;
    // turrets are appended back post-shuffle below, mirroring the rack's
    // filter-then-splice-back pattern. Turret-less themes: no-op.
    const turretIds = pool.filter((o) => o.is_turret === true).map((o) => o.object_id);
    if (turretIds.length > 0) {
      pool = pool.filter((o) => o.is_turret !== true);
    }
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
    // p3-t1: once unlocked, turret(s) are appended at the very END of the
    // queue (in build_order — buildables/pool is pre-sorted by the caller) —
    // a trailing position that never disturbs the non-turret built/unbuilt
    // boundary regardless of buildBuiltCount. Hidden entirely (not appended)
    // while locked. MUST match doRebirth's live-crossing append exactly, so
    // a live-added turret and a reload-recomputed queue agree on position.
    if ((rebirthCount || 0) >= TURRET_UNLOCK_REBIRTH) {
      for (const tid of turretIds) ids.push(tid);
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
  /** Fixed duration (seconds) every on-scene agent dances for on a REBIRTH. */
  const REBIRTH_DANCE_SECONDS = 3.0;
  /** Seconds between dance-frame swaps (manual frame mixer). */
  const DANCE_FRAME_SWAP = 0.35;
  /** Chance, per idle wander-decision, that an idle agent throws in a rare playful "point" emote. */
  const POINT_CHANCE = 0.01;
  /** Minimum seconds between one agent's playful "point" emotes (rate limit). */
  const EMOTE_COOLDOWN_SEC = 20;

  // ── Ambient idle poses (freed-frames scene behaviour, plan p10-t4) ─────
  // Mirrors src/webview/animationPlayback.ts's onWalkEnded exactly (parity
  // is hand-maintained, same as ATLAS_CLIPS above) — that file is the
  // testable copy since main.js is a plain IIFE with no exports.
  /** Chance a walk-end picks the held "stand_back" pose instead of idle. */
  const STAND_BACK_CHANCE = 0.25;

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
  const CONGA_SECONDS = 27;
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

  // ── Disco party easter egg ────────────────────────────────────────────────
  // All party state lives together so the rival-arrival cancel path
  // (cancelDiscoParty) is trivially correct: one function zeroes everything
  // in one place, nothing scattered to miss. Characters dance via the
  // EXISTING dance mechanism (charEntry.dancing/danceTimeLeft) — see
  // startDiscoParty; this block only tracks the party itself and the
  // full-scene lighting overlay's eased intensity.
  /** True while the disco party is active. */
  let discoPartyActive = false;
  /** "gather" (walking to the ring, not yet dancing) or "dance" (arrived,
   *  dancing via the existing mechanism). Mirrors huddle's walkin/active
   *  split so gathering reuses that same pattern rather than a new one. */
  let discoPartyPhase = "gather";
  /** Seconds elapsed in the current "gather" phase — same purpose as
   *  huddleWalkinElapsed, capped by DISCO_GATHER_TIMEOUT_SEC. */
  let discoGatherElapsed = 0;
  /** Ring anchor (native coords) picked once per party via pickHuddleAnchor(). */
  let discoAnchorNx = 0;
  let discoAnchorNy = 0;
  /** Seconds remaining in the current party. */
  let discoPartyTimeLeft = 0;
  /** Wall-clock ms the CURRENT party (conga OR disco) started — drives the
   *  shared lighting/ball animation phase (orbit angle, hue drift, ball spin
   *  frame, ball drop-in position). Set by whichever party's start function
   *  runs (startConga/startDiscoParty). */
  let partyVisualStartMs = 0;
  /** Eased 0..1 SHARED lighting/ball intensity, fed by whichever party type
   *  is currently active (conga or disco — see updateConga/updateDiscoParty,
   *  each of which writes this using the same ease-in/hold/ease-out formula).
   *  Ease in/out ~DISCO_EASE_SECONDS on a natural start/end; snapped straight
   *  to 0 on EITHER party's rival-cancel path (endConga/cancelDiscoParty).
   *  Read by drawDiscoOverlay/drawDiscoBall each frame; a single cheap
   *  comparison when 0. This is the LIGHTING layer only — character-animation
   *  ownership (congaIndex/inConga vs dancing/danceTimeLeft) stays fully
   *  separate per party type; see the mutual-exclusion checks in
   *  updateConga/updateDiscoParty. */
  let partyVisualIntensity = 0;
  /** Accumulator (seconds) toward the next rare-trigger eligibility check. */
  let discoCheckTimer = 0;
  /** Cooldown (seconds) remaining before another party may start. */
  let discoCooldown = 0;
  /** Party duration (feedback #21: "~10 seconds" so the celebration reads as
   *  deliberate rather than a blip — was 7s/five-plus-two). Covers the DANCE
   *  phase only; the GATHER walk-in (see DISCO_GATHER_TIMEOUT_SEC) runs
   *  before this timer starts, same as huddle's walkin/active split. */
  const DISCO_PARTY_SECONDS = 10;
  /** Ease-in/ease-out window for the lighting overlay (not used on the
   *  rival-cancel path, which snaps off immediately — see cancelDiscoParty). */
  const DISCO_EASE_SECONDS = 0.4;
  /** Sane upper bound (seconds) on the gather/walk-in phase before every
   *  participant snaps straight to its ring slot — mirrors
   *  HUDDLE_WALKIN_TIMEOUT_SEC so a straggler can never indefinitely delay
   *  the dancing from starting. */
  const DISCO_GATHER_TIMEOUT_SEC = 6;
  /** Seconds between random-trigger eligibility rolls. */
  const DISCO_CHECK_SECONDS = 45;
  /** Chance per eligibility check that a party starts. Mean interval ≈
   *  DISCO_CHECK_SECONDS / DISCO_CHANCE (feedback #21: raise so a user idling
   *  a few minutes plausibly sees one, without it becoming noise). Old:
   *  45/0.04 = 1125s (~19 min). New: 45/0.15 = 300s (5 min) — a user idling
   *  for "a few minutes" has a good chance of catching one (~63% within 5
   *  min, ~86% within 10 min, via 1-(1-0.15)^n checks), while
   *  DISCO_COOLDOWN_SECONDS (300s) still guarantees at least 5 minutes
   *  between any two parties so it can't fire back-to-back and become noise.
   *  Time-based (not a per-frame roll) so the rate is frame-rate independent. */
  const DISCO_CHANCE = 0.15;
  /** Minimum cooldown (seconds) after a party ends before another may start
   *  via the random trigger (the D-key debug trigger ignores this, mirroring
   *  the 'c' conga hotkey precedent — see the keydown handler). */
  const DISCO_COOLDOWN_SECONDS = 300;

  // ── Disco-ball sprite (bundled, theme-independent) ────────────────────────
  // Ships with the extension (media/sprites/disco_ball.png) rather than being
  // generated per-theme, so it lives outside themeImages/OBJECT_CLIPS. Its
  // drop-in/rest/retract/snap-away position is derived PURELY from
  // partyVisualIntensity (declared above) — no separate ball-lifecycle state —
  // so it automatically inherits every existing rule for free: eased in/out
  // on the normal start/end path, and an instant snap on cancelDiscoParty's
  // rival-arrival path, without this file touching that reviewed function at
  // all. See loadDiscoBallSprite/drawDiscoBall further down.
  /** 4 keyed+sliced frames (see loadDiscoBallSprite), or null until loaded /
   *  if loading ever fails — drawDiscoBall no-ops in that case; the party
   *  (lights + dancing) never depends on this sprite existing.
   *  @type {HTMLImageElement[] | null} */
  let discoBallFrames = null;
  /** Guards loadDiscoBallSprite so it only ever runs once. */
  let discoBallLoadAttempted = false;
  /** Warm/gold-tinted variant of discoBallFrames, built ONCE lazily by
   *  ensureDiscoBallGoldFrames (below loadDiscoBallSprite) the first time the
   *  gold party palette actually needs to draw the ball — no second sprite
   *  asset, just a runtime-tinted bake of the existing one, cached forever
   *  after. Null until built, or if building ever fails — drawDiscoBall
   *  falls back to the plain discoBallFrames in that case.
   *  @type {HTMLImageElement[] | null} */
  let discoBallGoldFrames = null;
  /** Guards ensureDiscoBallGoldFrames so the bake only ever LATCHES once —
   *  but only once the outcome is actually known (built successfully, a
   *  real error was thrown, or the retry budget below was exhausted). Never
   *  set just because a base frame hasn't finished decoding YET — see
   *  discoBallGoldBuildAttempts and ensureDiscoBallGoldFrames's own doc. */
  let discoBallGoldBuildAttempted = false;
  /** Consecutive "base frames exist but haven't finished decoding yet"
   *  calls seen by ensureDiscoBallGoldFrames — distinguishes "not ready
   *  yet, try again" from "cannot succeed, stop trying" (see
   *  DISCO_BALL_GOLD_MAX_ATTEMPTS). Reset is never needed: it only ever
   *  increments while discoBallGoldBuildAttempted is still false, and the
   *  moment either the bake succeeds or this hits the cap,
   *  discoBallGoldBuildAttempted latches and this stops being read. */
  let discoBallGoldBuildAttempts = 0;
  /** Attempt cap before a still-not-decoded base frame is treated as a
   *  genuine, permanent failure rather than "still decoding" — generous
   *  (ensureDiscoBallGoldFrames is only actually called while a gold-palette
   *  party is visibly active, see drawDiscoBall, so this budget can span
   *  several separate celebrations before giving up for the rest of the
   *  session and falling back to the untinted ball). */
  const DISCO_BALL_GOLD_MAX_ATTEMPTS = 300;
  /** Multiply-blend tint color used to bake discoBallGoldFrames — warm amber. */
  const DISCO_BALL_GOLD_TINT_COLOR = "#ffcc55";
  /** Spin-cycle clip for the ball sprite — same {frames,fps,loop} shape as
   *  OBJECT_CLIPS (~4681), driven the same way drawObjectSmoke drives
   *  OBJECT_CLIPS.poof: frame index = floor(elapsed*fps) mod frame count. A
   *  slow continuous rotation, not a fast effect. */
  const DISCO_BALL_CLIP = { frames: [0, 1, 2, 3], fps: 4, loop: true };
  /** Ball diameter as a fraction of the drawn background width. */
  const DISCO_BALL_SIZE_FRAC = 0.09;
  /** Resting center-y as a fraction of background height — near the top. */
  const DISCO_BALL_REST_Y_FRAC = 0.14;

  // ── Disco-party music bubble (mirrors the conga line's, at CONGA's
  // showExpression(e, 5, 1.8) call site — index 5 = "Music" in
  // THEME_PLAN_FIXED_EXPRESSION_LABELS) ──────────────────────────────────
  /** Same bubble duration the conga line uses, for visual consistency. */
  const DISCO_BUBBLE_DURATION_SEC = 1.8;
  /** Per-agent stagger step (roster order) so bubbles pop in a subtle wave
   *  rather than all at once. */
  const DISCO_BUBBLE_STAGGER_SEC = 0.12;
  /** Small per-agent jitter added on top of the stagger step. */
  const DISCO_BUBBLE_STAGGER_JITTER_SEC = 0.08;
  /** Cap on the roster-order stagger so a large roster's bubbles still all
   *  fire early in the party rather than trailing into it. Scaled
   *  proportionally to DISCO_PARTY_SECONDS (was 1.2s for a 5s party; now
   *  1.2 * 7/5 for the 7s party) so the fraction of the party spent
   *  popping bubbles stays the same as before. */
  const DISCO_BUBBLE_STAGGER_MAX_SEC = 1.68;

  // ── Dance-off easter egg ───────────────────────────────────────────────
  // Two NOT-working agents meet in the middle and take turns dancing for
  // DANCE_OFF_TURN_SECONDS each, alternating for DANCE_OFF_ROUNDS full
  // rounds (a "round" = both dancers get one turn), then a winner is picked
  // at random: it celebrates in place (cheer pose) while the loser walks
  // away. Shares the SAME partyVisualIntensity/partyVisualStartMs lighting
  // layer the conga and disco party use (see partyEaseIntensity) — no
  // separate visual system. Mutually exclusive with BOTH the conga and the
  // disco party in both directions (random triggers AND hotkeys) — see the
  // congaActive/discoPartyActive checks in this block's own start gates,
  // the mirrored danceOffActive checks added to updateConga/updateDiscoParty
  // and their hotkeys, and updateDanceOff's own belt-and-braces check.
  /** True while a dance-off is running (walk-in, duel, or celebration). */
  let danceOffActive = false;
  /** "walkin" | "duel" | "celebrate" | "idle" (idle = not meaningful while !danceOffActive). */
  let danceOffPhase = "idle";
  /** agent.id of each participant, or null when inactive. */
  let danceOffIdA = null;
  let danceOffIdB = null;
  /** Native-coord stand points either side of the walkable polygon's centroid, computed once at start. */
  let danceOffPosA = null;
  let danceOffPosB = null;
  /** Seconds elapsed walking in this run — capped by DANCE_OFF_WALKIN_TIMEOUT_SEC so a blocked path can't hang the easter egg forever. */
  let danceOffWalkinElapsed = 0;
  /** Which participant dances THIS turn: 0 = A, 1 = B. */
  let danceOffTurnActor = 0;
  /** Turns (A-dances-once or B-dances-once) completed so far this run; DANCE_OFF_TURNS_TOTAL ends the duel. */
  let danceOffTurnsCompleted = 0;
  /** Seconds remaining in the CURRENT turn's dance. */
  let danceOffTurnTimeLeft = 0;
  /** Overall countdown (seconds) covering duel+celebrate, feeding partyEaseIntensity
   *  exactly like congaTimeLeft/discoPartyTimeLeft do — set once when the duel
   *  starts (walk-in has no fixed length, see danceOffWalkinElapsed) and never
   *  reset again, so the celebration's ease-out lands at the true end. */
  let danceOffTimeLeft = 0;
  /** agent.id of the randomly-chosen winner, set when the duel ends; only meaningful during danceOffPhase === "celebrate". */
  let danceOffWinnerId = null;
  /** Seconds remaining in the winner's post-duel celebration hold. */
  let danceOffCelebrateTimeLeft = 0;
  /** Accumulator (seconds) toward the next rare-trigger eligibility check. */
  let danceOffCheckTimer = 0;
  /** Cooldown (seconds) remaining before another dance-off may start. */
  let danceOffCooldown = 0;
  /** Seconds each dancer performs before yielding the floor to the other. */
  const DANCE_OFF_TURN_SECONDS = 2;
  /** Music-bubble duration (seconds) popped above the dancer's head at the
   *  start of each turn — shorter than DANCE_OFF_TURN_SECONDS so it reads as
   *  a lead-in, not a cover for the whole turn. See beginDanceOffTurn. */
  const DANCE_OFF_BUBBLE_DURATION_SEC = 1.2;
  /** Full rounds (both participants each get one turn = 1 round). Product spec: "three rounds". */
  const DANCE_OFF_ROUNDS = 3;
  /** Total alternating turns in a run (2 dancers x DANCE_OFF_ROUNDS). */
  const DANCE_OFF_TURNS_TOTAL = DANCE_OFF_ROUNDS * 2;
  /** Total duel time (seconds): all turns back to back. */
  const DANCE_OFF_DUEL_SECONDS = DANCE_OFF_TURNS_TOTAL * DANCE_OFF_TURN_SECONDS;
  /** Seconds the winner holds its victory cheer while the loser walks away. */
  const DANCE_OFF_CELEBRATE_SECONDS = 3;
  /** danceOffTimeLeft's starting value at the moment the duel begins (see its own doc). */
  const DANCE_OFF_TIMED_TOTAL = DANCE_OFF_DUEL_SECONDS + DANCE_OFF_CELEBRATE_SECONDS;
  /** Sane upper bound (seconds) on the walk-in phase — a blocked path snaps both
   *  dancers straight to their stand points and starts the duel rather than
   *  hanging forever. */
  const DANCE_OFF_WALKIN_TIMEOUT_SEC = 6;
  /** Half the native-px gap between the two stand points (centred on the
   *  walkable polygon's centroid) — comfortably above MIN_AGENT_SEP_NATIVE (34)
   *  so the agent-separation pass never fights the face-off spacing. */
  const DANCE_OFF_STAND_HALF_GAP = 40;
  /** Seconds between random-trigger eligibility rolls — same time-based (not
   *  per-frame) approach as the conga/disco checks, so frame rate never
   *  affects frequency. */
  const DANCE_OFF_CHECK_SECONDS = 45;
  /** Chance per eligibility check that a dance-off starts — rare, in the same
   *  spirit as the conga/disco random triggers (see CONGA_CHANCE/DISCO_CHANCE). */
  const DANCE_OFF_CHANCE = 0.01;
  /** Cooldown (seconds) after a dance-off ends before another may start via the
   *  random trigger (the Alt+O hotkey ignores this, mirroring the conga/disco
   *  hotkey precedent). */
  const DANCE_OFF_COOLDOWN_SECONDS = 300;
  // NOTE: gated one tier above the disco party via its own
  // DANCE_OFF_UNLOCK_REBIRTH constant (search "GATE SPOT" in updateDanceOff
  // for the random-trigger check, plus the matching check in the Alt+O
  // hotkey below).

  // ── Dance-off winner confetti ──────────────────────────────────────────
  // A small, theme-independent, asset-free celebration burst (plain colored
  // rects/ribbons — no sprite, so it looks right in every theme) at the
  // winner's on-screen position when danceOffPhase becomes "celebrate" (see
  // the winner-pick block in updateDanceOff). Pooled at module scope so
  // spawning a burst never allocates: every particle object in
  // danceOffConfettiPool is created once, below, and only ever has its
  // fields overwritten. danceOffConfettiActive is the single boolean the
  // inactive path (both the per-frame update and the draw) checks first —
  // one comparison, nothing else, when no confetti is falling.
  /** True while at least one pooled particle is still alive. Single cheap
   *  gate for both updateDanceOffConfetti and drawDanceOffConfetti. */
  let danceOffConfettiActive = false;
  /** Particle count for one burst — "a little bit of confetti", not a
   *  screen-filling effect. */
  const DANCE_OFF_CONFETTI_COUNT = 22;
  /** Downward acceleration (px/s^2) applied to every live particle. */
  const DANCE_OFF_CONFETTI_GRAVITY = 260;
  /** Amplitude (px/s^2) of the gentle side-to-side drift wobble. */
  const DANCE_OFF_CONFETTI_DRIFT = 40;
  /** Flat palette of small ribbon colors — deliberately generic (not
   *  theme-sourced) so the burst reads correctly under every theme. */
  const DANCE_OFF_CONFETTI_COLORS = [
    "#ff5252", "#ffb300", "#ffee58", "#66bb6a", "#42a5f5", "#ab47bc", "#ff7043",
  ];
  /** Fixed-size particle pool, allocated ONCE at module scope and reused for
   *  every burst — the inactive path never allocates. Each entry:
   *  {active, x, y, vx, vy, rot, vrot, life, maxLife, color, w, h} in canvas
   *  (screen) coordinates. */
  const danceOffConfettiPool = (function buildDanceOffConfettiPool() {
    const pool = new Array(DANCE_OFF_CONFETTI_COUNT);
    for (let i = 0; i < DANCE_OFF_CONFETTI_COUNT; i++) {
      pool[i] = {
        active: false, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vrot: 0,
        life: 0, maxLife: 0, color: DANCE_OFF_CONFETTI_COLORS[0], w: 4, h: 7,
      };
    }
    return pool;
  })();

  /**
   * Spawn one confetti burst at (cx, cy) — the winner's canvas position at
   * the instant the winner is picked (see the celebrate-phase transition in
   * updateDanceOff, which reads winnerEntry.x/winnerEntry.y the same way the
   * per-character loop derives cx/cy for every other overlay). No-op for
   * reduced-motion users, matching the disco lighting/ball suppression rule.
   * Reuses the pooled particle objects in place — no allocation.
   * @param {number} cx @param {number} cy canvas-space burst origin
   */
  function spawnDanceOffConfetti(cx, cy) {
    if (prefersReducedMotion) return;
    // Colour source is the only thing the gold palette changes here — see
    // getActivePartyPalette (defined further down, but hoisted like every
    // other function declaration in this IIFE, so it's already callable by
    // the time this function actually runs). Looked up once per burst, not
    // per particle.
    const confettiColors = getActivePartyPalette().confetti;
    for (let i = 0; i < danceOffConfettiPool.length; i++) {
      const p = danceOffConfettiPool[i];
      p.active = true;
      p.x = cx;
      p.y = cy;
      // Mostly-upward burst spread (a shallow cone around straight up), then
      // gravity below arcs it back down and out.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
      const speed = 70 + Math.random() * 90;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.rot = Math.random() * Math.PI * 2;
      p.vrot = (Math.random() - 0.5) * 8;
      p.maxLife = 0.9 + Math.random() * 0.5;
      p.life = p.maxLife;
      p.color = confettiColors[Math.floor(Math.random() * confettiColors.length)];
      p.w = 3 + Math.random() * 3;
      p.h = 6 + Math.random() * 4;
    }
    danceOffConfettiActive = true;
  }

  /**
   * Advance every live confetti particle by delta seconds: gravity, a gentle
   * sideways drift wobble, rotation, and life decay. Inactive path is the
   * single danceOffConfettiActive boolean check — no allocation either way.
   * @param {number} delta seconds
   */
