# Animation Lab

A standalone, dev-only canvas harness for visually verifying the 12 character
animation clips defined in `ATLAS_CLIPS` (`src/extension/themePlan.ts`)
before real character art exists, or without needing to run the full
extension at all.

It plays every clip continuously side by side so you can sanity-check frame
selection, fps, looping, ping-pong playback, held poses, and horizontal
mirroring at a glance.

## How to open it

Double-click `index.html`, or open it directly in a browser via a `file://`
URL. No server, no build step, no CDN, and no external assets — everything
needed is `index.html` + `clips.js` in this folder.

## Feeding it real data

By default the lab draws procedurally-generated placeholder figures so it
works with zero setup. To check real art instead, export the
`NormalizedAtlasPackage` produced by `sliceAndNormalizeAtlas` in
`src/extension/slicer.ts` as JSON, then use "Load frames.json" in the
toolbar to load it. A plain JSON array of up to 20 base64 data-URI strings
(indexed by slot position) is also accepted if you just want to test raw
frames without the full package shape.

If a clip references a slot that isn't present in the loaded file, that
slot falls back to the synthetic renderer rather than breaking the card.

## Toolbar controls

- **Play / Pause** — toggles the shared animation loop.
- **Step** — advances every clip by exactly one frame. Pauses playback first
  if it was running.
- **Speed** — 0.25x / 0.5x / 1x / 2x multiplier applied to every clip's fps.
- **Face left** — mirrors only `flippable: true` clips horizontally (the
  standard sprite-mirror: translate, `scale(-1, 1)`, draw, restore).
  Non-flippable clips never mirror.
- **Background** — dark / light / checkerboard backdrop per canvas, useful
  for checking transparency on loaded art.
- **Load frames.json** — loads real slicer output (see above) and switches
  cards to draw from it instead of the synthetic figures.

Each card also shows the clip's raw params (frames/fps/loop/flippable/
pingpong/hold) and a faint baseline so any vertical "foot hop" between
frames is visually obvious. Clips with `loop: false` (one-shots like
`melee`, `shoot`, `dodge`) are looped anyway in the lab for watchability —
they play forward once, pause briefly, then restart, and are marked with a
small "ONE-SHOT (loop:false in production)" label so this lab-only looping
isn't mistaken for real in-game behavior.

---

`clips.js` is a synced copy of `ATLAS_CLIPS` (`src/extension/themePlan.ts`)
guarded by `test/animationLabClips.test.ts` — if you change clip data in
`themePlan.ts`, update `clips.js` to match or the test will fail.
