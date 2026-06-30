# TycoonAgents — Character Animation Handoff

**Audience:** the agent wiring the production webview render loop (Gemini owns `src/webview/*` + the IPC contract; Codex authored most of the theme-gen pipeline).
**Status:** the animation **contract + a working reference player are complete**. The production webview playback (Phase 2) is **not yet wired** — that's the work being handed off.

---

## TL;DR

`ATLAS_CLIPS` maps the 20 character-atlas slots to **12 named animation clips** (walk, melee, build, shoot, dance, …). The slicer already outputs transparent frames that are horizontally centered and bottom-justified (a consistent foot line), each carrying `meta`. A **fully working reference player** lives in `tools/animation-lab/` — double-click it to watch every clip animate.

**Your job:** port that playback into the production webview, driven by per-character action state, and decide how the clip map reaches the webview (one small IPC decision, below).

---

## What's already done (do not redo)

| Phase | What | Where |
|-------|------|-------|
| Phase 1 | Slicer emits per-frame `meta` (centroidX/footY/topY/left/right/opaqueCount); frames centered + foot-anchored | [`src/extension/slicer.ts`](src/extension/slicer.ts) (`measureFrameContent`) |
| Phase 0 | `ATLAS_CLIPS` clip contract + prompt labels realigned (ranged aim→fire); tests | [`src/extension/themePlan.ts`](src/extension/themePlan.ts), [`src/extension/themeAssetPrompts.ts`](src/extension/themeAssetPrompts.ts) |
| Lab | Standalone reference player for all clips (synthetic + real frames) | [`tools/animation-lab/`](tools/animation-lab/) |

---

## The artifacts to read

1. **Spec** → [`docs/ANIMATION-CLIPS.md`](docs/ANIMATION-CLIPS.md) — clip table, frame metadata, the playback algorithm, and the proposed IPC change.
2. **Contract data (source of truth)** → [`ATLAS_CLIPS`](src/extension/themePlan.ts#L26-L38) — the slot→clip map you consume.
3. **Reference implementation (port this)** → [`tools/animation-lab/index.html`](tools/animation-lab/index.html) — a working render loop you can lift almost verbatim:
   - rAF loop + per-clip fps advance: [index.html:439-504](tools/animation-lab/index.html#L439-L504)
   - foot-anchored draw + flip: [index.html:321-365](tools/animation-lab/index.html#L321-L365)
   - `frames.json` loader (shows the slicer's `{slots:[{slot_id,data,meta}]}` shape): [index.html:624-668](tools/animation-lab/index.html#L624-L668)
4. **Frame metadata type** → `FrameContentMeta` in [`src/extension/slicer.ts`](src/extension/slicer.ts).

---

## Clip table (quick reference)

| Clip | Frames (slots) | fps | loop | flippable | pingpong | hold |
|------|---------------|-----|------|-----------|----------|------|
| walk | 0,1,2,3,4 | 10 | ✓ | ✓ | | |
| idle | 16 | 0 | ✓ | | | ✓ |
| sit | 15 | 0 | ✓ | | | ✓ |
| melee | 5,6,7,8 | 12 | | ✓ | | |
| build | 5,6,7,8 | 6 | ✓ | ✓ | | |
| tool_idle | 9 | 0 | ✓ | ✓ | | ✓ |
| shoot | 10,11 | 8 | | ✓ | ✓ | |
| dance | 17,18 | 6 | ✓ | | ✓ | |
| cheer | 19 | 0 | ✓ | | | ✓ |
| point | 12 | 0 | ✓ | ✓ | | ✓ |
| signal | 13 | 0 | ✓ | | | ✓ |
| dodge | 14 | 0 | | ✓ | | ✓ |

---

## Your task (copy-paste)

```
Implement character animation playback in the TycoonAgents production webview
(src/webview/*), porting the working reference player in tools/animation-lab/.

Source of truth: ATLAS_CLIPS in src/extension/themePlan.ts (12 clips mapping the
20 character-atlas slots to named animations). Spec: docs/ANIMATION-CLIPS.md.

Per character, maintain:
  - action: ClipName   (which clip is currently playing)
  - facingLeft: boolean

Each render tick:
  1. clip = ATLAS_CLIPS[action]; advance a frame index through clip.frames at
     clip.fps. pingpong clips bounce at the ends; hold clips pin to frame 0;
     loop:false clips play once then settle.
  2. Draw the current slot's frame FOOT-ANCHORED at bottom-center of the
     character's world position (use the frame's meta.footY as the anchor), so
     poses with different heights don't hop/jitter.
  3. If clip.flippable && facingLeft, mirror horizontally:
     ctx.save(); ctx.translate(x,y); ctx.scale(-1,1); drawImage(...); ctx.restore();

Action selection (replace the current "cycle all 20 frames" logic):
  - 'walk' while moving; set facingLeft from the sign of the x movement delta.
  - 'build' while actively at a build target; 'tool_idle' when assigned to a
    build target but paused between swings.
  - 'idle' / 'sit' when stationary and empty-handed.
  - (shoot/melee/dance/cheer/point/signal/dodge wired to their game events.)

Do not modify src/extension/* (that's the host/theme-gen side). The reference
player in tools/animation-lab/index.html already implements every behavior above
— mirror its loop.
```

---

## The one decision you must make (IPC)

The webview needs the clip map. Pick one:

- **Option A (preferred, data-driven):** add the `ClipName` / `AtlasClip` types to `src/shared/types.ts` and include `clips: Record<ClipName, AtlasClip>` in the `THEME_INITIALIZED` payload alongside `frames`. **This edits the immutable shared contract, so it needs your explicit sign-off** (that's why it's a proposal, not already done — see §5 of the spec).
- **Option B (stopgap):** the webview imports `ATLAS_CLIPS` directly from the host module for now; migrate to Option A later.

---

## Acceptance criteria

- [ ] Each clip plays at its `fps`; pingpong bounces; hold clips are static; one-shots play once.
- [ ] Frames are foot-anchored on `meta.footY` — characters do **not** hop/jitter when cycling poses.
- [ ] Flip happens via `ctx.scale(-1,1)` **only** when `clip.flippable && facingLeft` (walk/melee/shoot mirror; dance/idle do not).
- [ ] Action state replaces the old "cycle all 20 frames" behavior.
- [ ] Behavior visually matches `tools/animation-lab/` for the same frames.
