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
