import { ATLAS_CLIPS, type ClipName } from '../extension/themePlan';

export interface CharacterAnimationState {
  action: ClipName;
  frameIndex: number;
  direction: 1 | -1;
  elapsedSeconds: number;
  completed: boolean;
}

export function createCharacterAnimation(action: ClipName = 'idle'): CharacterAnimationState {
  return {
    action,
    frameIndex: 0,
    direction: 1,
    elapsedSeconds: 0,
    completed: false,
  };
}

export function setCharacterAction(state: CharacterAnimationState, action: ClipName): void {
  if (state.action === action) return;
  state.action = action;
  state.frameIndex = 0;
  state.direction = 1;
  state.elapsedSeconds = 0;
  state.completed = false;
}

export function advanceCharacterAnimation(
  state: CharacterAnimationState,
  deltaSeconds: number,
): void {
  const clip = ATLAS_CLIPS[state.action];
  if (clip.hold || clip.frames.length <= 1 || clip.fps <= 0) {
    state.frameIndex = 0;
    return;
  }
  if (state.completed || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;

  state.elapsedSeconds += deltaSeconds;
  const frameDuration = 1 / clip.fps;
  while (state.elapsedSeconds >= frameDuration && !state.completed) {
    state.elapsedSeconds -= frameDuration;
    stepCharacterAnimation(state);
  }
}

export function currentCharacterSlot(state: CharacterAnimationState): number {
  const frames = ATLAS_CLIPS[state.action].frames;
  return frames[Math.min(state.frameIndex, frames.length - 1)];
}

function stepCharacterAnimation(state: CharacterAnimationState): void {
  const clip = ATLAS_CLIPS[state.action];
  const frameCount = clip.frames.length;

  if (clip.pingpong) {
    state.frameIndex += state.direction;
    if (state.frameIndex >= frameCount - 1) {
      state.frameIndex = frameCount - 1;
      if (clip.loop) state.direction = -1;
      else state.completed = true;
    } else if (state.frameIndex <= 0) {
      state.frameIndex = 0;
      state.direction = 1;
    }
    return;
  }

  state.frameIndex += 1;
  if (state.frameIndex < frameCount) return;
  if (clip.loop) state.frameIndex = 0;
  else {
    state.frameIndex = frameCount - 1;
    state.completed = true;
  }
}

// ── Ambient idle poses (freed-frames scene behaviour, plan p10-t4) ─────────
// Two rare cosmetic poses gated on the theme's freed_frames:'v2' flag (see
// themeHasFreedFrames in ../extension/themePlan). Mirrored by hand into
// media/main.js's per-character loop (that file is a plain untyped IIFE, not
// bundled from here) — keep the two in sync the same way ATLAS_CLIPS is kept
// in sync between themePlan.ts and main.js.

/** Chance a walk-end picks the held "stand_back" pose instead of idle. */
export const STAND_BACK_CHANCE = 0.25;
/** Per-idle-minute chance of playing the "idle_rare" one-shot. */
export const IDLE_RARE_CHANCE = 0.05;
/** Idle_rare is rolled at most once per this many seconds of continuous idle. */
export const IDLE_RARE_MINUTE_SECONDS = 60;
/** Duration of one full idle_rare pass: ATLAS_CLIPS.idle_rare has 2 frames at fps 2. */
export const IDLE_RARE_DURATION_SECONDS = 1.0;

export interface AmbientPoseState {
  /** True while the character should hold "stand_back" instead of "idle". */
  standingBack: boolean;
  /** True while the one-shot idle_rare pose is currently playing. */
  idleRareActive: boolean;
  /** Elapsed seconds since idle_rare started playing. */
  idleRareElapsed: number;
  /** Seconds accumulated toward the next per-minute idle_rare roll. */
  idleMinuteTimer: number;
}

export function createAmbientPoseState(): AmbientPoseState {
  return { standingBack: false, idleRareActive: false, idleRareElapsed: 0, idleMinuteTimer: 0 };
}

/**
 * Call the instant a character's walk ends (isMoving true -> false this
 * frame). Rolls STAND_BACK_CHANCE and latches the result; never rolls (and
 * clears any previous latch) while the theme flag is off or the agent is
 * active on a task.
 */
export function onWalkEnded(
  state: AmbientPoseState,
  active: boolean,
  freedFramesEnabled: boolean,
  rng: () => number = Math.random,
): void {
  state.standingBack = !!freedFramesEnabled && !active && rng() < STAND_BACK_CHANCE;
}

/** Call when a walk (re)starts or the agent otherwise leaves the held pose. */
export function clearAmbientPoses(state: AmbientPoseState): void {
  state.standingBack = false;
  state.idleRareActive = false;
  state.idleRareElapsed = 0;
}

/**
 * Call once per frame while idle. Advances the per-minute idle_rare roll
 * timer and the one-shot's own playback clock; returns true for exactly the
 * frames idle_rare should be the displayed clip (one full 2-frame/fps-2 pass,
 * i.e. IDLE_RARE_DURATION_SECONDS, then it returns false and the caller falls
 * back to "idle"). Never rolls or plays while inactive-gating fails (theme
 * flag off, agent active, or agent not idle-and-still).
 */
/**
 * Call once per frame regardless of walk/idle branch. Clears every latched
 * ambient pose the instant the agent becomes active, even when activity
 * starts without a walk transition (e.g. a task begins mid-idle, before
 * onWalkEnded would ever fire). No-op while inactive — walk-end/idle-rare
 * gating above already governs the inactive case.
 */
export function onActiveChanged(state: AmbientPoseState, active: boolean): void {
  if (!active) return;
  state.standingBack = false;
  state.idleRareActive = false;
  state.idleRareElapsed = 0;
  state.idleMinuteTimer = 0;
}

export function updateIdleRare(
  state: AmbientPoseState,
  active: boolean,
  freedFramesEnabled: boolean,
  idleAndStill: boolean,
  deltaSeconds: number,
  rng: () => number = Math.random,
): boolean {
  if (!freedFramesEnabled || active || !idleAndStill) {
    state.idleRareActive = false;
    state.idleRareElapsed = 0;
    state.idleMinuteTimer = 0;
    return false;
  }
  if (state.idleRareActive) {
    state.idleRareElapsed += deltaSeconds;
    if (state.idleRareElapsed >= IDLE_RARE_DURATION_SECONDS) {
      state.idleRareActive = false;
      state.idleRareElapsed = 0;
    }
    return state.idleRareActive;
  }
  state.idleMinuteTimer += deltaSeconds;
  if (state.idleMinuteTimer >= IDLE_RARE_MINUTE_SECONDS) {
    state.idleMinuteTimer -= IDLE_RARE_MINUTE_SECONDS;
    if (rng() < IDLE_RARE_CHANCE) {
      state.idleRareActive = true;
      state.idleRareElapsed = 0;
      return true;
    }
  }
  return false;
}
