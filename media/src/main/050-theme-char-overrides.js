// Part: 50-theme-char-overrides
// Theme character scale override slider sync and related settings.
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
    const feedback = document.getElementById("menu-feedback");
    const about = document.getElementById("menu-about");
    if (feedback && feedback.parentElement === menuPopoverEl) menuPopoverEl.insertBefore(btn, feedback);
    else if (about && about.parentElement === menuPopoverEl) menuPopoverEl.insertBefore(btn, about);
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

    // ── Structure damage bar (Plan p4-t1) ────────────────────────────────────
    // Compact bar centered above a BUILT structure, shown ONLY while it is
    // damaged (objectSmoke entry with damage>0). Deliberately drawn with the
    // EXACT same visual as the build-progress/crate bar above (~7035-7048:
    // rgba(0,0,0,0.55) track, #ffc107 amber fill, rgba(255,255,255,0.65)
    // stroke, barH=6, barW=Math.max(24, size*0.9), barY clamped 14px above
    // the sprite top) — the RTS "un-building" read: fill = REMAINING health
    // (1 - damage), so a damaged structure's bar looks identical to a
    // building crate's, just running in reverse as damage climbs and
    // re-filling as it's repaired. Undamaged structures draw NOTHING (no
    // clutter). Drawn in un-flipped canvas coords, OUTSIDE the optional
    // sprite flip above, so it never mirrors; sized off baseSize (the
    // object's on-screen size ≈ depthScale·objScale) so distant structures
    // get a proportionally smaller bar, mirroring what this bar used before.
    // Reads the graded `damage` written by updateObjectSmoke — never
    // recomputed here. Fully guarded — never throws.
    try {
      const hs = objectSmoke[objId];
      const dmg = hs ? (hs.damage || 0) : 0;
      if (hs && dmg > 0) {
        const remaining = Math.max(0, Math.min(1, 1 - dmg));
        const barW = Math.max(24, baseSize * 0.9);
        const barH = 6;
        const barX = cx - barW / 2;
        // Sprite top edge is (cy - baseSize); sit the bar just above it, clamped
        // so it never clips off the top of the canvas (matches the crate bar).
        const barY = Math.max(2, cy - baseSize - 14);
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = "#ffc107";
        ctx.fillRect(barX, barY, barW * remaining, barH);
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.lineWidth = 1;
        ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
        ctx.restore();
      }
    } catch (e) { /* cosmetic only — one bad frame must not break render() */ }
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
      //    Two tallies are kept per object:
      //      - `targeted`: every qualifying rival, staggered or not. A
      //        staggered rival is still "attacking" in the sense that it
      //        holds the object's warm-up (underAttack) steady rather than
      //        letting it reset — see the reset loop below.
      //      - `damaging`: a Map of objectId -> count of rivals ACTIVELY
      //        damaging the object this frame (targeted AND NOT staggered).
      //        p2-t3: a rival currently staggered by a turret hit
      //        (turretStaggerT > 0) does not contribute to this count — the
      //        struck rival briefly stops damaging the structure for
      //        TURRET_STAGGER_SEC, which is the turret's repel/mitigation
      //        effect (this is the ONLY place structure-damage ramp is
      //        applied, so gating it here is sufficient — no separate
      //        attack-apply site). Damage stacks per attacker (capped at
      //        STRUCTURE_MAX_ATTACKERS) so a swarm damages faster than a
      //        lone attacker, applied below.
      const targeted = new Set();
      const damaging = new Map();
      if (builtIds && builtIds.size > 0 && Array.isArray(activeEnemies)) {
        for (const en of activeEnemies) {
          if (!en || en.fleeing) continue;
          if (en.targetKind !== "object") continue;
          const oid = en.targetObjId;
          if (!oid || !builtIds.has(oid)) continue;
          targeted.add(oid);
          if (en.turretStaggerT > 0) continue;
          damaging.set(oid, (damaging.get(oid) || 0) + 1);
        }
      }
      // 2. Under-attack objects: accumulate warm-up for every TARGETED object
      //    (staggered attackers included, so a fully-staggered object holds
      //    its warm-up instead of losing it), then once past the warm-up
      //    delay ramp a GRADED `damage` value (0..1, +STRUCTURE_DAMAGE_PER_SEC
      //    * min(activeAttackerCount, STRUCTURE_MAX_ATTACKERS) per second,
      //    clamped to 1 — never exceeds, object is never destroyed or
      //    reverted to a crate) using only the ACTIVELY-damaging count, and
      //    derive intensity from it, floored at SMOKE_DAMAGE_INTENSITY_FLOOR
      //    so a freshly-damaged object smokes visibly and thickens the
      //    longer the attack continues (fade-in, not a pop to full). Lazily
      //    create the entry on first targeted frame. Once the delay is
      //    crossed the object becomes PERSISTENTLY `damaged`. If every
      //    attacker is staggered this frame (activeAttackerCount === 0), no
      //    damage is added but the existing damage/intensity holds steady.
      for (const oid of targeted) {
        let s = objectSmoke[oid];
        if (!s) s = objectSmoke[oid] = { underAttack: 0, intensity: 0, anim: 0, damaged: false, damage: 0 };
        s.underAttack += delta;
        if (s.underAttack >= SMOKE_ATTACK_DELAY) {
          if (!s.damaged) s.damaged = true;
          const activeAttackerCount = damaging.get(oid) || 0;
          if (activeAttackerCount > 0) {
            s.damage = Math.min(1, (s.damage ?? 0) + STRUCTURE_DAMAGE_PER_SEC * Math.min(activeAttackerCount, STRUCTURE_MAX_ATTACKERS) * delta);
          }
          s.intensity = Math.max(SMOKE_DAMAGE_INTENSITY_FLOOR, s.damage);
        }
        s.anim += delta; // 4. advance the rising loop
      }
      // 3. Not targeted at all this frame (nothing — staggered or not — is
      //    attacking it): a `damaged` object stays smoking PERSISTENTLY (no
      //    auto-decay/delete) until a repair completes in
      //    updateExtinguishProgress — only its rising-loop anim still advances.
      //    Undamaged objects (attack stopped before the delay elapsed) still
      //    fade out and delete as before.
      for (const oid of Object.keys(objectSmoke)) {
        if (targeted.has(oid)) continue;
        const s = objectSmoke[oid];
        if (!s) { delete objectSmoke[oid]; continue; }
        s.underAttack = 0;
        if (s.damaged) {
          // Damage PERSISTS when the attack stops (no auto-decay); intensity
          // stays derived from the graded damage value (floored) — repair
          // (updateExtinguishProgress) is the only way to clear this.
          s.intensity = Math.max(SMOKE_DAMAGE_INTENSITY_FLOOR, s.damage ?? 0);
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
   * Extinguish assignment pre-pass (Phase 2; p4-t2 widened eligibility to ANY
   * agent, not just idle ones). Once per frame, AFTER updateObjectSmoke and
   * BEFORE the character movement loop. Routes eligible characters (idle OR
   * active/building) to smoking objects that still "need" extinguishing,
   * capped at EXTINGUISH_MAX_ASSIGN per object. Reads charEntry.extinguishEligible
   * (published by the movement loop last frame — a 1-frame lag is fine for a
   * cosmetic effect) and charEntry.nx/ny; writes only charEntry.extinguishTargetId.
   * Fully guarded — never throws.
   */
  function assignExtinguishers() {
    try {
      // 1. Smoking objects that still need work (have a known placement).
      //    Gate on `damage > 0` directly, NOT the derived `intensity` — since
      //    p1-t2, intensity ramps gradually (floored, then == damage), so a
      //    >=0.5 intensity threshold silently delayed dispatch until ~3s into
      //    an attack even though the object was already visibly damaged from
      //    the first tick. damage only starts accruing after SMOKE_ATTACK_DELAY
      //    (0.5s) of continuous attack, which is already the natural delay —
      //    no extra threshold needed.
      const needy = new Set();
      for (const oid in objectSmoke) {
        const s = objectSmoke[oid];
        if (s && (s.damage || 0) > 0 && objectPlacement[oid]) needy.add(oid);
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
   * Turret auto-fire (Plan p2-t2/p2-t3). Once per frame, for every object
   * flagged is_turret (turretObjectIds) that is currently BUILT
   * (builtIds.has) and whose theme has projectile art (themeHasProjectile):
   * find the nearest live attacker (activeEnemies) within TURRET_RANGE and,
   * if the turret's cooldown has elapsed, fire a cosmetic projectile at it
   * via the existing spawnProjectile pipeline and reset the cooldown to
   * TURRET_FIRE_INTERVAL_MS. No target in range, not built, or no projectile
   * art → stays silent (cooldown is left to idle, so a turret can fire the
   * instant a target enters range rather than waiting out a stale timer).
   * p2-t3: a fired-upon target also takes TURRET_HIT_DAMAGE off the SAME
   * `hp` field agents drain (reused hp<=0 → fleeing eviction path in
   * advanceEnemies — no new death system) and gets a brief
   * TURRET_STAGGER_SEC stagger (en.turretStaggerT, decremented in
   * advanceEnemies) that suppresses its structure-attack ramp
   * (updateObjectSmoke's `engaged` gate). No damaged-disable gate (p2-t4)
   * yet. Fully guarded — never throws.
   * @param {number} delta seconds since last frame
   * @param {Set<string>} builtIds object_ids that are fully built this frame
   */
  function updateTurrets(delta, builtIds) {
    if (turretObjectIds.size === 0 || !themeHasProjectile) return;
    try {
      const deltaMs = delta * 1000;
      for (const objId of turretObjectIds) {
        if (!builtIds.has(objId)) continue;
        const place = objectPlacement[objId];
        if (!place) continue;
        // ── p2-t4: damaged turrets go silent ─────────────────────────────
        // A turret is a built structure like any other, so it already rides
        // updateObjectSmoke/updateExtinguishProgress's damage/repair loop
        // (rivals can target it, it smokes, shows a health bar, agents
        // repair it) with no new system needed here. The explicit rule:
        // ANY damage (damage > 0) stops firing immediately; it stays silent
        // through partial repair; it only resumes once damage is back to 0,
        // which — per that teardown — deletes the objectSmoke[objId] entry.
        // Read live every frame; no caching. Reset cooldown to 0 while
        // disabled so the instant it's fully repaired it can fire right away
        // instead of waiting out a stale cooldown.
        const smoke = objectSmoke[objId];
        if (smoke && (smoke.damage || 0) > 0) {
          turretCooldown[objId] = 0;
          continue;
        }
        // Decrement this turret's cooldown (clamped at 0 — never goes negative
        // so a target-less turret is ready to fire the moment one appears).
        const cd = Math.max(0, (turretCooldown[objId] || 0) - deltaMs);
        turretCooldown[objId] = cd;
        if (cd > 0) continue;
        // Nearest live attacker within TURRET_RANGE (squared-distance compare,
        // mirrors assignExtinguishers'/enemy-targeting nearest-search pattern).
        let bestEnemy = null, bestDist = TURRET_RANGE * TURRET_RANGE;
        for (const en of activeEnemies) {
          if (!en || en.fleeing) continue;
          if (typeof en.nx !== "number" || typeof en.ny !== "number") continue;
          const dx = en.nx - place.nx, dy = en.ny - place.ny;
          const d = dx * dx + dy * dy;
          if (d < bestDist) { bestDist = d; bestEnemy = en; }
        }
        if (!bestEnemy) continue; // no target in range — stay silent, cooldown left at 0
        spawnProjectile(place.nx, place.ny, bestEnemy.nx, bestEnemy.ny);
        turretCooldown[objId] = TURRET_FIRE_INTERVAL_MS;
        // ── Turret animation rule ──────────────────────────────────────────
        // Non-turret animated objects animate on AGENT PROXIMITY (see the
        // idle-phase branch in the main render loop). A turret is carved out
        // of that behavior entirely: it must stay still while a character
        // merely stands beside it, and animate ONLY when it actually fires.
        // Signal that HERE, at the fire site, rather than inferring it from
        // turretCooldown (which is reused for range-gating and would be a
        // fragile proxy for "a shot just happened"). One full animation
        // cycle per shot: reset the clip to frame 0 and arm a countdown
        // (turretFireAnimT, consumed by the idle-phase branch below) sized
        // to the clip's real duration — frames ÷ fps, mirroring
        // advanceObjectAnim's own per-object fps override — clamped to the
        // fire interval so a slow clip can never bleed into the next shot's
        // rest window. Guarded: objectAnimMap[objId] may not exist yet (e.g.
        // first frame after building) — just skip the visual signal, never throw.
        const animEntry = objectAnimMap[objId];
        if (animEntry && animEntry.animState) {
          const s = animEntry.animState;
          const clip = OBJECT_CLIPS[s.action] || OBJECT_CLIPS.object_idle;
          const fps = (typeof s.fps === "number") ? s.fps : clip.fps;
          const frameCount = clip.frames ? clip.frames.length : 1;
          const cycleSec = (fps > 0 && frameCount > 1) ? (frameCount / fps) : 0;
          animEntry.turretFireAnimT = Math.min(cycleSec, TURRET_FIRE_INTERVAL_MS / 1000);
          s.frameIndex = 0;
          s.elapsed = 0;
          s.direction = 1;
          s.completed = false;
        }
        // ── p2-t3: the shot actually hits ────────────────────────────────
        // Reuse the same hp field agents drain (AGENT_DPS); the existing
        // hp<=0 → fleeing eviction check (advanceEnemies, ~L13634) reaps it
        // next frame — no new death/disengage path is introduced here.
        // Same live rebirth defense scaling as agent damage above — derived
        // from rebirthCount at fire time, never persisted.
        if (typeof bestEnemy.hp === "number") bestEnemy.hp -= TURRET_HIT_DAMAGE * Math.pow(1.1, rebirthCount);
        // Brief stagger: while turretStaggerT > 0 (decremented in
        // advanceEnemies), updateObjectSmoke's `engaged` gate excludes this
        // rival so it stops ramping structure damage — the visible "repel".
        bestEnemy.turretStaggerT = TURRET_STAGGER_SEC;
      }
    } catch (e) { /* cosmetic only — never let turret auto-fire throw */ }
  }

  /**
   * Extinguish/repair accrual (Plan p1-t4). Once per frame, AFTER the
   * character movement loop (positions settled). Tallies ARRIVED,
   * non-fighting characters per smoking object, then reduces that object's
   * graded `damage` directly by STRUCTURE_REPAIR_PER_SEC per repairer —
   * extinguishing smoke and repairing damage are the same action, so a
   * structure still under attack can keep losing ground even while being
   * worked on. On damage reaching 0 the object's smoke is force-cleared
   * (entry deleted) and its characters released. Combat always wins: a
   * character fighting a rival (combatTargetInstanceId set) does not count.
   * Fully guarded — never throws.
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
      // 2. Reduce `damage` directly for objects with >=1 active repairer, at
      //    STRUCTURE_REPAIR_PER_SEC PER repairer (`k`, tallied fresh above),
      //    so healing scales live as characters join/leave. This runs in the
      //    SAME frame as — and AFTER — updateObjectSmoke's attack ramp (see
      //    the call sites: updateObjectSmoke then assignExtinguishers then,
      //    once positions settle, this function), so a structure that is
      //    simultaneously under attack and being repaired nets the two
      //    per-frame deltas against the one shared `damage` field: this
      //    function only ever subtracts from whatever updateObjectSmoke left
      //    it at, never overwrites it wholesale, so there's no clobber/
      //    double-clamp risk regardless of which side changed it first.
      //    Force-complete once damage reaches 0.
      for (const oid in objectSmoke) {
        const s = objectSmoke[oid];
        if (!s) continue;
        const k = active[oid] || 0;
        if (k < 1) continue; // no healing with zero repairers (damage holds/keeps ramping)
        s.damage = Math.max(0, (s.damage || 0) - STRUCTURE_REPAIR_PER_SEC * k * delta);
        if (s.damage <= 0) {
          // Fully repaired: clear the persistent damage flag and remove the
          // smoke entry entirely; release every assigned character.
          s.damaged = false;
          s.intensity = 0;
          s.underAttack = 0;
          s.damage = 0;
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
   * @param {() => void} [onSettled] called once when `stored` finishes loading
   *   or errors (i.e. once its .src assignment below actually settles) — used
   *   by preloadThemeImages to know when a sprite is safe to render.
   * @returns {HTMLImageElement}
   */
  function loadDefringedFrame(src, onSettled) {
    const stored = new Image();
    if (typeof onSettled === "function") {
      stored.onload = onSettled;
      stored.onerror = onSettled;
    }
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
   * Load the bundled disco-ball sheet (media/sprites/disco_ball.png, a 2x2
   * grid of 4 frames on a magenta chroma-key background — top-left,
   * top-right, bottom-left, bottom-right) and produce 4 cached, keyed,
   * de-fringed Image frames in discoBallFrames.
   *
   * Reuses defringeImageToDataURL AS-IS (same magenta-kill/edge-flood
   * algorithm loadDefringedFrame uses for theme sprites) by running it over
   * the WHOLE 256x256 sheet first — the chroma background between the 4
   * quadrants gets killed in that single pass too, so slicing the already-
   * cleaned sheet into 4 sub-canvases afterward needs no separate keying
   * logic. Runs once (discoBallLoadAttempted guards re-entry); on ANY
   * failure discoBallFrames stays null and drawDiscoBall silently no-ops —
   * the party (lights + dancing) must never depend on this sprite.
   */
  function loadDiscoBallSprite() {
    if (discoBallLoadAttempted) return;
    discoBallLoadAttempted = true;
    const uri = appEl && appEl.dataset ? appEl.dataset.discoBallUri : null;
    if (!uri) return; // older host build without the injected URI — degrade silently
    try {
      const raw = new Image();
      raw.onload = () => {
        try {
          const cleanedUrl = defringeImageToDataURL(raw);
          const sheet = new Image();
          sheet.onload = () => {
            try {
              const sw = sheet.naturalWidth, sh = sheet.naturalHeight;
              if (!sw || !sh) return; // discoBallFrames stays null
              const halfW = sw / 2, halfH = sh / 2;
              const rects = [[0, 0], [halfW, 0], [0, halfH], [halfW, halfH]]; // TL,TR,BL,BR
              const frames = [];
              for (const [sx, sy] of rects) {
                const cvs = document.createElement("canvas");
                cvs.width = halfW;
                cvs.height = halfH;
                const cctx = cvs.getContext("2d");
                if (!cctx) return; // discoBallFrames stays null — bail on any quadrant failure
                cctx.drawImage(sheet, sx, sy, halfW, halfH, 0, 0, halfW, halfH);
                const frameImg = new Image();
                frameImg.src = cvs.toDataURL("image/png");
                frames.push(frameImg);
              }
              discoBallFrames = frames;
            } catch (_err) {
              // discoBallFrames stays null
            }
          };
          sheet.onerror = () => { /* discoBallFrames stays null */ };
          sheet.src = cleanedUrl || raw.src;
        } catch (_err) {
          // discoBallFrames stays null
        }
      };
      raw.onerror = () => { /* discoBallFrames stays null */ };
      raw.src = uri;
    } catch (_err) {
      // discoBallFrames stays null — never let sprite loading throw at boot
    }
  }

  /**
   * Bake a warm/gold-tinted variant of every discoBallFrames entry into
   * discoBallGoldFrames. Runs entirely on its own throwaway per-frame
   * canvas (never touches the main `ctx`, so there is no shared canvas
   * state to leak). Deliberately NOT a second sprite asset: it's a
   * runtime-computed tint of the existing media/sprites/disco_ball.png
   * frames, using the same "bake once via toDataURL" pattern
   * loadDiscoBallSprite already uses for the base frames above.
   *
   * Tint technique: draw the frame, multiply-blend a flat amber fill over
   * it (this also flat-fills the frame's transparent margins, since
   * "multiply" degrades to plain source-over where destination alpha is 0),
   * then re-clip with a "destination-in" pass of the original frame so only
   * the sprite's own silhouette survives — leaves shading intact, just
   * warmed, with clean edges.
   *
   * Three distinct outcomes, and discoBallGoldBuildAttempted is latched
   * (true) on exactly two of them — never on the first:
   *   1. NOT READY YET — discoBallFrames exists but at least one frame
   *      hasn't finished decoding (.complete/.naturalWidth not set yet: the
   *      base frames are data-URI Images with no onload handler of their
   *      own — see loadDiscoBallSprite — so this is expected for the first
   *      few calls). discoBallGoldBuildAttempted is NOT set; only
   *      discoBallGoldBuildAttempts increments, so the very next call (this
   *      is only ever invoked while a gold-palette party is actually
   *      visible — see drawDiscoBall) retries for real.
   *   2. CANNOT SUCCEED — either the retry budget (DISCO_BALL_GOLD_MAX_ATTEMPTS)
   *      is exhausted (frames still never finished decoding across many
   *      calls/celebrations) or a real error occurred (no 2d context, a
   *      thrown exception). discoBallGoldBuildAttempted latches true so
   *      this never retries again this session; discoBallGoldFrames stays
   *      null and drawDiscoBall's own fallback (`(palette.key === "gold" &&
   *      discoBallGoldFrames) ? ... : discoBallFrames`) keeps drawing the
   *      untinted ball — the celebration itself never depends on this bake.
   *   3. SUCCESS — discoBallGoldFrames is populated and
   *      discoBallGoldBuildAttempted latches true; every later call this
   *      session is then a single cheap `if` no-op, same as before.
   */
  function ensureDiscoBallGoldFrames() {
    if (discoBallGoldFrames || discoBallGoldBuildAttempted) return;
    if (!discoBallFrames || !discoBallFrames.length) return; // base frames not ready yet — try again next call
    const allFramesDecoded = discoBallFrames.every((frame) => frame && frame.complete && frame.naturalWidth);
    if (!allFramesDecoded) {
      discoBallGoldBuildAttempts++;
      if (discoBallGoldBuildAttempts < DISCO_BALL_GOLD_MAX_ATTEMPTS) return; // still decoding — retry next call, guard stays open
      discoBallGoldBuildAttempted = true; // budget exhausted — genuine failure, stop retrying, fall back to untinted
      return;
    }
    try {
      const built = [];
      for (const frame of discoBallFrames) {
        const cvs = document.createElement("canvas");
        cvs.width = frame.naturalWidth;
        cvs.height = frame.naturalHeight;
        const cctx = cvs.getContext("2d");
        if (!cctx) { discoBallGoldBuildAttempted = true; return; } // real failure — discoBallGoldFrames stays null, degrade to the untinted ball
        cctx.drawImage(frame, 0, 0);
        cctx.globalCompositeOperation = "multiply";
        cctx.fillStyle = DISCO_BALL_GOLD_TINT_COLOR;
        cctx.fillRect(0, 0, cvs.width, cvs.height);
        cctx.globalCompositeOperation = "destination-in";
        cctx.drawImage(frame, 0, 0);
        const img = new Image();
        img.src = cvs.toDataURL("image/png");
        built.push(img);
      }
      discoBallGoldFrames = built;
      discoBallGoldBuildAttempted = true; // succeeded — latch so later calls are a single cheap no-op
    } catch (_err) {
      discoBallGoldBuildAttempted = true; // genuine failure — discoBallGoldFrames stays null, degrade to the untinted ball
    }
  }

  /**
   * Preload all character sprite images from raw frames data.
   * @param {Record<string, string[]>} rawFrames
   */
