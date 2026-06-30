# Animation Clips — Proposal / Handoff

Author: extension-host owner
Audience: webview team (owns `src/webview/*` and the shared IPC contract in `src/shared/types.ts`)
Status: proposal, pending webview-owner sign-off on section 5

## 1. PURPOSE

`ATLAS_CLIPS` (exported from `src/extension/themePlan.ts`) is the single source of truth mapping the 20 character-atlas slots (indices 0..19) to named animation clips. Each sliced character/enemy frame set is indexed by these slot ids.

## 2. THE CONTRACT

```typescript
export type ClipName = 'walk'|'idle'|'sit'|'melee'|'build'|'tool_idle'|'shoot'|'dance'|'cheer'|'point'|'signal'|'dodge';

export interface AtlasClip {
  frames: number[];    // 1+ slot indices into the 20-cell character atlas
  fps: number;         // >0 for animated clips; 0 for a held single-frame pose
  loop: boolean;
  flippable: boolean;  // may be horizontally mirrored to face the other way
  pingpong?: boolean;  // optional: play forward then reverse
  hold?: boolean;       // optional: single static frame (frames.length===1)
}
```

| Clip | Frames | FPS | Loop | Flippable | Pingpong | Hold | Represents |
|---|---|---|---|---|---|---|---|
| walk | [0,1,2,3,4] | 10 | true | true | - | - | walk cycle |
| idle | [16] | 0 | true | false | - | true | idle pose |
| sit | [15] | 0 | true | false | - | true | sit pose |
| melee | [5,6,7,8] | 12 | false | true | - | - | melee swing |
| build | [5,6,7,8] | 6 | true | true | - | - | build loop |
| tool_idle | [9] | 0 | true | true | - | true | held tool-in-hand idle for builders |
| shoot | [10,11] | 8 | false | true | true | - | ranged aim->fire |
| dance | [17,18] | 6 | true | false | true | - | dance |
| cheer | [19] | 0 | true | false | - | true | cheer |
| point | [12] | 0 | true | true | - | true | point |
| signal | [13] | 0 | true | false | - | true | signal |
| dodge | [14] | 0 | false | true | - | true | dodge |

## 3. FRAME METADATA

Each sliced slot also carries a `meta` object (from `src/extension/slicer.ts`, interface `FrameContentMeta`): `centroidX`, `footY`, `topY`, `left`, `right`, `opaqueCount`. Frames are center-of-mass horizontally centered and bottom-justified within their 128x128 cell, so all frames share a consistent foot line (`footY`) usable as a stable anchor point.

## 4. PROPOSED PLAYBACK ALGORITHM (for the webview render loop)

Maintain per-character state `action: ClipName` and `facingLeft: boolean`. Each render tick, advance a frame index through `clip.frames` at `clip.fps`:

- Pingpong clips (`pingpong: true`) reverse direction at the ends of the sequence instead of looping back to the start.
- Hold clips (`hold: true`) just show their single frame — no index advancing needed.

Draw the frame foot-anchored at bottom-center of the character's world position (not top-left), so different poses with different frame heights don't visually hop or jitter — anchoring on `footY` keeps the character's feet planted at a consistent screen position across clips.

If `clip.flippable` is true and `facingLeft` is true, mirror the draw horizontally via `ctx.scale(-1,1)` plus an appropriate translate — the established sprite-flip technique.

Action-selection examples:
- Use `'walk'` while the character is moving; derive `facingLeft` from the sign of `dx`, the horizontal movement delta.
- Use `'build'` while the character is actively swinging at a build target; when assigned to a build target but paused/between swings, use `'tool_idle'` (held pose with the tool in hand) rather than the empty-handed `'idle'`.
- Use `'idle'` or `'sit'` when the character is stationary/resting and not holding a tool.

## 5. PROPOSED IPC CHANGE (needs webview-owner sign-off)

This section is a **proposal only** and is pending coordination with the webview team, since `src/shared/types.ts` is the immutable shared contract per project convention — it must not be changed unilaterally.

Proposal:

- Add the `ClipName` and `AtlasClip` types to the shared contract in `src/shared/types.ts`.
- Include `clips: Record<ClipName, AtlasClip>` in the `THEME_INITIALIZED` IPC payload, alongside the existing `frames` field.

This would make the webview data-driven for animation playback instead of hardcoding frame ranges itself, with `ATLAS_CLIPS` in `src/extension/themePlan.ts` becoming the single authored source that flows through IPC to drive rendering.
