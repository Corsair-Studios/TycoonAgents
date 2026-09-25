// Part: 65-theme-anim-preview
// Theme Builder review screen: "Preview animation" section on animated board
// cards (characters, rivals, animated objects, animated decor). Loops the
// SAME clip data the stage plays — ATLAS_CLIPS / RIVAL_CLIPS / OBJECT_CLIPS
// (media/src/main/030-theme-picker-list.js) and the frame arrays fetched
// on-demand via GET_THEME_ITEM_FRAMES, run through the same
// loadDefringedFrame() de-fringe path the stage uses.

// itemId -> { themeId, kind, frames: {key: HTMLImageElement[]}, requested }
const themeAnimPreviewState = new Map();
// itemId -> { canvas, ctx, clipKey, clipList, frameIndex, cycleElapsed,
//             playing, speed, showBounds, bg, raf-relevant timers }
const themeAnimPreviewPlayers = new Map();
let themeAnimPreviewObserver = null;
let themeAnimPreviewRafHandle = null;
let themeAnimPreviewLastTs = 0;

/**
 * Returns the ordered clip table for one board kind, or null when that
 * board isn't animated. Mirrors the stage's own clip selection so the
 * preview can never drift (values are read directly, never copied).
 * @param {any} item a THEME_IMAGE_REVIEW review item
 */
function themeAnimPreviewClipsForItem(item) {
  if (!item) return null;
  if (item.kind === "character") return typeof ATLAS_CLIPS !== "undefined" ? ATLAS_CLIPS : null;
  if (item.kind === "rival") return typeof RIVAL_CLIPS !== "undefined" ? RIVAL_CLIPS : null;
  if ((item.kind === "object" || item.kind === "decor") && typeof item.anim_fps === "number" && item.anim_fps > 0) {
    return typeof OBJECT_CLIPS !== "undefined" ? OBJECT_CLIPS : null;
  }
  return null;
}

/** True iff this board kind/manifest data is animated (see task brief). */
function themeAnimPreviewIsAnimated(item) {
  return Boolean(themeAnimPreviewClipsForItem(item));
}

function themeAnimPreviewRequestFrames(themeId, itemId, imageSrc) {
  const state = themeAnimPreviewState.get(itemId);
  if (state && state.requested) return;
  themeAnimPreviewState.set(itemId, { themeId, frames: null, requested: true, imageSrc });
  vscode.postMessage({ type: "GET_THEME_ITEM_FRAMES", payload: { theme_id: themeId, item_id: itemId } });
}

/** Host reply handler, invoked from 060's message listener. */
function handleThemeItemFramesMessage(payload) {
  const itemId = payload.item_id;
  if (!itemId) return;
  const rawFrames = payload.frames || {};
  /** @type {Record<string, HTMLImageElement[]>} */
  const loaded = {};
  Object.keys(rawFrames).forEach((key) => {
    loaded[key] = (rawFrames[key] || [])
      .filter((src) => !!src)
      .map((src) => loadDefringedFrame(src, () => themeAnimPreviewRepaint(itemId)));
  });
  const prev = themeAnimPreviewState.get(itemId) || {};
  themeAnimPreviewState.set(itemId, { ...prev, frames: loaded, requested: true, imageSrc: prev.imageSrc });
  themeAnimPreviewRepaint(itemId);
}

/** Invalidates cached frames for an item so the next open re-fetches them
 * (Retry / re-slice / Normalize size / a fresh THEME_IMAGE_REVIEW for it). */
function themeAnimPreviewInvalidate(itemId) {
  themeAnimPreviewState.delete(itemId);
  const player = themeAnimPreviewPlayers.get(itemId);
  if (player && player.open) {
    themeAnimPreviewRequestFrames(player.themeId, itemId);
  }
}

function themeAnimPreviewRepaint(itemId) {
  const player = themeAnimPreviewPlayers.get(itemId);
  if (player) themeAnimPreviewDraw(player);
}

/**
 * Garbage-collects one player: unobserves its canvas and drops it (and its
 * cached frames) from the maps. Safe to call more than once.
 */
function themeAnimPreviewDestroyPlayer(itemId) {
  const player = themeAnimPreviewPlayers.get(itemId);
  if (player && themeAnimPreviewObserver) {
    try { themeAnimPreviewObserver.unobserve(player.canvas); } catch (_e) { /* noop */ }
  }
  themeAnimPreviewPlayers.delete(itemId);
  themeAnimPreviewState.delete(itemId);
}

/**
 * Self-contained GC pass (no other module needs to call this): a card that
 * was removed from the DOM — the review screen closed, or the card list was
 * rebuilt and this item's card no longer exists — leaves its player's
 * canvas detached (`isConnected === false`). Swept once per rAF tick from
 * themeAnimPreviewEnsureLoop, so stale players/observers never accumulate
 * across re-renders without any other file having to call into this one.
 */
function themeAnimPreviewSweepDetached() {
  themeAnimPreviewPlayers.forEach((player, itemId) => {
    if (!player.canvas || !player.canvas.isConnected) {
      themeAnimPreviewDestroyPlayer(itemId);
    }
  });
}

/**
 * Builds the collapsible "Preview animation" section for one animated board
 * card. Returns null for non-animated boards (badges, expressions,
 * environment, static objects/decor).
 * @param {any} item a THEME_IMAGE_REVIEW review item
 * @param {string} themeId
 */
function buildThemeAnimPreviewSection(item, themeId) {
  const clips = themeAnimPreviewClipsForItem(item);
  if (!clips) return null;

  // A fresh THEME_IMAGE_REVIEW for this item (Retry, re-slice, Normalize
  // size) bumps image_src's revision query param — treat that as "frames
  // changed" and drop any cached preview frames/player so the next open
  // re-fetches instead of showing stale art.
  const prevState = themeAnimPreviewState.get(item.id);
  if (prevState && prevState.imageSrc !== item.image_src) {
    themeAnimPreviewState.delete(item.id);
  }
  const existingPlayer = themeAnimPreviewPlayers.get(item.id);
  const wasOpen = existingPlayer ? existingPlayer.open : false;
  if (existingPlayer && themeAnimPreviewObserver) {
    try { themeAnimPreviewObserver.unobserve(existingPlayer.canvas); } catch (_e) { /* noop */ }
  }

  const clipNames = Object.keys(clips);
  const section = document.createElement("div");
  section.className = "theme-anim-preview-section";
  const details = document.createElement("details");
  details.className = "theme-anim-preview-details";
  details.open = wasOpen;
  const summary = document.createElement("summary");
  summary.textContent = "Preview animation";
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "theme-anim-preview-body";

  const canvas = document.createElement("canvas");
  canvas.className = "theme-anim-preview-canvas";
  canvas.width = 128;
  canvas.height = 128;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Animation preview for " + (item.display_name || item.id));
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.imageSmoothingEnabled = false;
  body.appendChild(canvas);

  const controls = document.createElement("div");
  controls.className = "theme-anim-preview-controls";

  const clipSelect = document.createElement("select");
  clipSelect.className = "theme-anim-preview-clip-select";
  clipSelect.setAttribute("aria-label", "Animation clip");
  const cycleOpt = document.createElement("option");
  cycleOpt.value = "__cycle__";
  cycleOpt.textContent = "Cycle all";
  clipSelect.appendChild(cycleOpt);
  clipNames.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    clipSelect.appendChild(opt);
  });
  clipSelect.value = "__cycle__";
  controls.appendChild(clipSelect);

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "skill-btn theme-anim-preview-play";
  playBtn.textContent = "Pause";
  playBtn.setAttribute("aria-label", "Play or pause the animation preview");
  controls.appendChild(playBtn);

  const speedSelect = document.createElement("select");
  speedSelect.className = "theme-anim-preview-speed";
  speedSelect.setAttribute("aria-label", "Playback speed");
  [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"]].forEach(([value, label]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    speedSelect.appendChild(opt);
  });
  speedSelect.value = "1";
  controls.appendChild(speedSelect);

  const stepBtn = document.createElement("button");
  stepBtn.type = "button";
  stepBtn.className = "skill-btn theme-anim-preview-step";
  stepBtn.textContent = "Step";
  stepBtn.setAttribute("aria-label", "Advance one frame");
  controls.appendChild(stepBtn);

  const frameLabel = document.createElement("span");
  frameLabel.className = "theme-anim-preview-frame-label";
  frameLabel.textContent = "frame 0";
  controls.appendChild(frameLabel);

  const bgBtn = document.createElement("button");
  bgBtn.type = "button";
  bgBtn.className = "skill-btn theme-anim-preview-bg";
  bgBtn.textContent = "Dark bg";
  bgBtn.setAttribute("aria-label", "Toggle preview background");
  controls.appendChild(bgBtn);

  const boundsBtn = document.createElement("button");
  boundsBtn.type = "button";
  boundsBtn.className = "skill-btn theme-anim-preview-bounds";
  boundsBtn.textContent = "Show bounds";
  boundsBtn.setAttribute("aria-pressed", "false");
  boundsBtn.setAttribute("aria-label", "Toggle frame and ground-line bounds overlay");
  controls.appendChild(boundsBtn);

  body.appendChild(controls);
  details.appendChild(body);
  section.appendChild(details);

  /** @type {any} */
  const player = {
    itemId: item.id,
    themeId,
    clips,
    clipKey: "__cycle__",
    cycleIndex: 0,
    frameIndex: 0,
    elapsed: 0,
    cycleElapsed: 0,
    playing: true,
    speed: 1,
    bg: "checker",
    showBounds: false,
    open: wasOpen,
    canvas,
    ctx,
    frameLabel,
    visible: false,
  };
  themeAnimPreviewPlayers.set(item.id, player);

  clipSelect.addEventListener("change", () => {
    player.clipKey = clipSelect.value;
    player.frameIndex = 0;
    player.elapsed = 0;
    themeAnimPreviewDraw(player);
  });
  playBtn.addEventListener("click", () => {
    player.playing = !player.playing;
    playBtn.textContent = player.playing ? "Pause" : "Play";
  });
  speedSelect.addEventListener("change", () => {
    player.speed = parseFloat(speedSelect.value) || 1;
  });
  stepBtn.addEventListener("click", () => {
    player.playing = false;
    playBtn.textContent = "Play";
    themeAnimPreviewAdvanceFrame(player);
    themeAnimPreviewDraw(player);
  });
  bgBtn.addEventListener("click", () => {
    player.bg = player.bg === "checker" ? "dark" : "checker";
    bgBtn.textContent = player.bg === "checker" ? "Dark bg" : "Checker bg";
    themeAnimPreviewDraw(player);
  });
  boundsBtn.addEventListener("click", () => {
    player.showBounds = !player.showBounds;
    boundsBtn.setAttribute("aria-pressed", String(player.showBounds));
    themeAnimPreviewDraw(player);
  });
  details.addEventListener("toggle", () => {
    player.open = details.open;
    if (details.open) {
      themeAnimPreviewRequestFrames(themeId, item.id, item.image_src);
      if (themeAnimPreviewObserver) themeAnimPreviewObserver.observe(canvas);
    } else if (themeAnimPreviewObserver) {
      themeAnimPreviewObserver.unobserve(canvas);
    }
  });

  if (wasOpen) {
    themeAnimPreviewRequestFrames(themeId, item.id, item.image_src);
    if (themeAnimPreviewObserver) themeAnimPreviewObserver.observe(canvas);
  }
  themeAnimPreviewEnsureLoop();
  return section;
}

function themeAnimPreviewEnsureObserver() {
  if (themeAnimPreviewObserver || typeof IntersectionObserver === "undefined") return;
  themeAnimPreviewObserver = new IntersectionObserver((entries) => {
    let becameVisible = false;
    entries.forEach((entry) => {
      const canvas = entry.target;
      themeAnimPreviewPlayers.forEach((player) => {
        if (player.canvas === canvas) {
          player.visible = entry.isIntersecting;
          if (entry.isIntersecting) becameVisible = true;
        }
      });
    });
    // The shared loop stops itself once nothing is visible (see
    // themeAnimPreviewEnsureLoop) — restart it here so a scrolled-back-into-
    // view preview resumes without needing another card build/toggle.
    if (becameVisible) themeAnimPreviewEnsureLoop();
  }, { threshold: 0.05 });
}

function themeAnimPreviewEnsureLoop() {
  themeAnimPreviewEnsureObserver();
  if (themeAnimPreviewRafHandle !== null) return;
  themeAnimPreviewLastTs = 0;
  const step = (ts) => {
    themeAnimPreviewSweepDetached();
    const dt = themeAnimPreviewLastTs ? (ts - themeAnimPreviewLastTs) / 1000 : 0;
    themeAnimPreviewLastTs = ts;
    let anyVisible = false;
    themeAnimPreviewPlayers.forEach((player) => {
      if (!player.open || player.visible === false) return;
      anyVisible = true;
      if (!player.playing) return;
      player.elapsed += dt * player.speed;
      player.cycleElapsed += dt * player.speed;
      themeAnimPreviewAdvanceByTime(player);
    });
    // Stop the shared loop once no player is both open and on-screen — it is
    // restarted (themeAnimPreviewEnsureLoop) by whatever makes a player
    // visible/open again: a card being built, a <details> toggle opening, or
    // the IntersectionObserver reporting a canvas back on-screen.
    if (!anyVisible) {
      themeAnimPreviewRafHandle = null;
      themeAnimPreviewLastTs = 0;
      return;
    }
    themeAnimPreviewRafHandle = requestAnimationFrame(step);
  };
  themeAnimPreviewRafHandle = requestAnimationFrame(step);
}

const THEME_ANIM_PREVIEW_CYCLE_SEC = 2;
const THEME_ANIM_PREVIEW_ONE_SHOT_PAUSE_SEC = 0.6;

function themeAnimPreviewActiveClipName(player) {
  if (player.clipKey !== "__cycle__") return player.clipKey;
  const names = Object.keys(player.clips).filter((n) => player.clips[n].loop !== false);
  const pool = names.length ? names : Object.keys(player.clips);
  if (player.cycleElapsed >= THEME_ANIM_PREVIEW_CYCLE_SEC) {
    player.cycleElapsed = 0;
    player.cycleIndex = (player.cycleIndex + 1) % pool.length;
    player.frameIndex = 0;
    player.elapsed = 0;
  }
  return pool[player.cycleIndex % pool.length];
}

function themeAnimPreviewAdvanceByTime(player) {
  const clipName = themeAnimPreviewActiveClipName(player);
  const clip = player.clips[clipName];
  if (!clip) return;
  const fps = clip.fps || 0;
  if (fps <= 0 || clip.hold) {
    themeAnimPreviewDraw(player);
    return;
  }
  // One-shot clips (loop: false, e.g. melee): a wholly separate, simple,
  // deterministic timer — play every frame at exactly the clip's fps, then
  // hold the last frame for THEME_ANIM_PREVIEW_ONE_SHOT_PAUSE_SEC (~600ms)
  // before restarting. It intentionally does not try to match the stage's
  // real emote-override timing, only the fps, per the task brief.
  if (clip.loop === false) {
    const seq = themeAnimPreviewClipSequence(clip);
    const frameDur = 1 / fps;
    if (player.oneShotHolding) {
      player.oneShotHoldElapsed = (player.oneShotHoldElapsed || 0) + player.elapsed;
      player.elapsed = 0;
      if (player.oneShotHoldElapsed >= THEME_ANIM_PREVIEW_ONE_SHOT_PAUSE_SEC) {
        player.oneShotHoldElapsed = 0;
        player.oneShotHolding = false;
        player.frameIndex = 0;
      }
    } else if (player.elapsed >= frameDur) {
      player.elapsed -= frameDur;
      if (player.frameIndex < seq.length - 1) {
        player.frameIndex += 1;
      } else {
        player.oneShotHolding = true;
        player.oneShotHoldElapsed = 0;
      }
    }
    themeAnimPreviewDraw(player);
    return;
  }
  const frameDur = 1 / fps;
  if (player.elapsed >= frameDur) {
    player.elapsed -= frameDur;
    themeAnimPreviewAdvanceFrame(player);
  }
  themeAnimPreviewDraw(player);
}

/** Advances frameIndex one step for looping (including pingpong) clips. */
function themeAnimPreviewAdvanceFrame(player) {
  const clipName = player.clipKey === "__cycle__" ? themeAnimPreviewActiveClipName(player) : player.clipKey;
  const clip = player.clips[clipName];
  if (!clip) return;
  const seq = themeAnimPreviewClipSequence(clip);
  if (!seq.length) return;
  player.frameIndex = (player.frameIndex + 1) % seq.length;
}

/** Expands a clip's frames[] into its playback order — pingpong clips
 * (e.g. dance) go forward then back, exactly as the stage plays them. */
function themeAnimPreviewClipSequence(clip) {
  const frames = clip.frames || [];
  if (!clip.pingpong || frames.length < 3) return frames;
  const back = frames.slice(1, frames.length - 1).reverse();
  return frames.concat(back);
}

function themeAnimPreviewDraw(player) {
  const { ctx, canvas } = player;
  if (!ctx) return;
  const state = themeAnimPreviewState.get(player.itemId);
  const clipName = player.clipKey === "__cycle__" ? themeAnimPreviewActiveClipName(player) : player.clipKey;
  const clip = player.clips[clipName];
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (player.bg === "dark") {
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    const cell = 8;
    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? "#cccccc" : "#eeeeee";
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
  if (!state || !state.frames || !clip) {
    if (player.frameLabel) player.frameLabel.textContent = "loading...";
    return;
  }
  // Rival/object/decor boards key frames per clip name; character boards
  // store all 16 poses under one key — clip.frames indexes into that array.
  const framesForKey = state.frames[clipName] || Object.values(state.frames)[0] || [];
  const seq = themeAnimPreviewClipSequence(clip);
  const idx = seq[player.frameIndex % Math.max(seq.length, 1)] ?? 0;
  const img = framesForKey[idx] || framesForKey[0];
  if (player.frameLabel) player.frameLabel.textContent = "frame " + (player.frameIndex + 1) + "/" + seq.length + " (" + clipName + ")";
  if (!img || !img.complete || !img.naturalWidth) return;
  const scale = Math.max(1, Math.floor(Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight)));
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const dx = Math.floor((canvas.width - w) / 2);
  const dy = Math.floor((canvas.height - h) / 2);
  ctx.drawImage(img, dx, dy, w, h);
  if (player.showBounds) {
    ctx.strokeStyle = "#ff3366";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(dx, dy + h - 1);
    ctx.lineTo(dx + w, dy + h - 1);
    ctx.strokeStyle = "#33ccff";
    ctx.stroke();
  }
}
