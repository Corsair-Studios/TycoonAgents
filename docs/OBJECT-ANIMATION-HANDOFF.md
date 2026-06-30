# Animated Buildable Objects — Spec & Handoff

Upgrade buildable objects from **single-state** images to **animated** sprites, and add a shared
**crate → poof → reveal** build sequence. This mirrors the proven character-atlas pipeline
(`buildCharacterAtlasPrompt` / `ATLAS_CLIPS` / `sliceAndNormalizeAtlas`).

## Why
Today `buildObjectAtlasPrompt` (themeAssetPrompts.ts:342) makes a **4×3 board of 12 single-frame
objects** — one static pose each, no animation. We want: (1) each built object plays a short idle
animation; (2) while an object is being built it shows as a **crate**; (3) on completion a **poof**
puff plays and reveals the finished object.

## Format (reuses the 512×512 / magenta / configurable-grid pipeline)
- Canvas **512×512**, **5 columns × 4 rows** of **128×128** cells, flat **#FF00FF** magenta background
  (same chroma-key + cell-padding rules as characters — reuse `boardContract(5, 4)`).
- **Object boards:** each **ROW = one object** → **4 objects per board**, each row = **5 frames** of a
  smooth looping idle/active animation. `ceil(objectCount / 4)` object boards (≈3 for 12 objects).
- **Build-system board (1 per theme):** row 0 = **crate** under-construction loop (5 frames);
  row 1 = **poof** reveal (5 frames, one-shot); rows 2–3 unused (flat magenta).
- Render scale stays 128px/cell; the shipped **`object_scale`** tuning knob (manifest.viewport,
  Stage Editor) up-scales objects at draw time, so big objects don't need bigger cells.

## Animation clip contract (add to themePlan.ts, parallel to ATLAS_CLIPS)
```ts
export type ObjectClipName = 'object_idle' | 'crate' | 'poof';
export interface ObjectClip { frames: number[]; fps: number; loop: boolean; pingpong?: boolean; }
export const OBJECT_CLIPS: Record<ObjectClipName, ObjectClip> = {
  object_idle: { frames: [0, 1, 2, 3, 4], fps: 6,  loop: true },   // built object, loops
  crate:       { frames: [0, 1, 2, 3, 4], fps: 6,  loop: true },   // under construction, loops
  poof:        { frames: [0, 1, 2, 3, 4], fps: 14, loop: false },  // one-shot reveal
};
```

## Slicing (reuse `sliceAndNormalizeAtlas`, grid 5×4)
Slice each board into 20 cells, then **group by row**:
- Object board, row r (0..3) → object's 5 frames = cells `[r*5 .. r*5+4]` → `frames["object_<object_id>"]`.
- Build-system board → `frames["crate"] = cells[0..4]`, `frames["poof"] = cells[5..9]`.
(`scaleReferenceSlots`/`targetContentHeight` can normalize per-row like characters do.)

## Manifest / contract additions (types.ts)
- `BuildableObject.sprite_asset` → point at the animated key, e.g. `"frames.json#object_<object_id>"`
  (an array of 5 data-URIs). Optionally add `anim_fps?: number`, `anim_loop?: boolean` per object.
- Add a shared build-system reference, e.g. on `ViewportConfig`:
  `crate_asset?: string` (`"frames.json#crate"`), `poof_asset?: string` (`"frames.json#poof"`).

## Runtime (webview — Claude owns this, build after PNGs exist)
Per buildable object at `anchor_coord`: state machine
`UNBUILT → (agent building) CRATE-loop + progress/health bar → on work_units_required reached:
POOF one-shot → OBJECT_IDLE loop`. Uses `object_scale` + per-object override. Depth-sorted with agents.

---

# GENERATION PROMPTS (ready to use — OpenAI GPT Image + Gemini nano-banana)

Provider-agnostic (the existing prompts have no provider-specific text). Tuned for GPT Image
consistency (preferred). Fill the `<…>` template fields the same way `buildObjectAtlasPrompt` does.

## A) Animated object board (4 objects / board)
```
Create one ANIMATED object sprite sheet for the "<themeName>" theme.
The outer image canvas is exactly 512 x 512 pixels (1:1). Do not crop to the grid bounds.
Inside is an exact 5-column by 4-row grid of 20 equal 128x128 cells.
Every unused pixel must be perfectly flat solid #FF00FF magenta — no gradients, lighting, shadow,
texture, fog, reflections, scenery, or environmental effects. Nothing may cross cell boundaries;
keep generous empty padding around every object.

This board contains EXACTLY 4 objects. Each object occupies ONE ROW of 5 cells, left to right, and
those 5 cells are 5 sequential frames of a short, smoothly LOOPING idle/active animation of that object:
Row 1 (cells 1-5):  <Object A display_name> — <short motion hint, e.g. "radar dish slowly rotating, red status light pulsing">
Row 2 (cells 6-10): <Object B display_name> — <short motion hint>
Row 3 (cells 11-15): <Object C display_name> — <short motion hint>
Row 4 (cells 16-20): <Object D display_name> — <short motion hint>

Animation rules: within a row, all 5 frames are the SAME object from the SAME fixed three-quarter /
isometric camera, with identical position, identical scale, identical colors, identical lighting.
ONLY the moving or glowing parts change between frames so the row loops seamlessly (frame 5 flows back
into frame 1). Do NOT translate, rotate, or resize the object body between frames. Keep motion subtle.
Center each object in its cell with its lowest contact point near the cell's bottom edge. Use identical
relative scale for all 4 objects. Crisp retro pixel art, consistent isometric viewpoint and lighting.

Creative direction: <creativeDirection>
```

## B) Build-system board (crate + poof, 1 per theme)
```
Create one BUILD-SYSTEM sprite sheet for the "<themeName>" theme.
Canvas exactly 512 x 512 px (1:1); exact 5-column by 4-row grid of 20 equal 128x128 cells.
Every unused pixel must be perfectly flat solid #FF00FF magenta (no gradients/lighting/scenery).
Nothing crosses cell boundaries; generous padding.

Row 1 (cells 1-5): a closed shipping CRATE that is "under construction", themed to <themeName>
(its materials, colors, and markings should match the theme). The 5 cells are 5 frames of a SUBTLE,
seamlessly LOOPING "being worked on" animation — e.g. the crate bobs slightly, faint tool sparks /
glints, a small lid rattle — SAME crate, identical position and scale, frame 5 loops back to frame 1.

Row 2 (cells 6-10): a POOF smoke-burst REVEAL animation, 5 frames, ONE-SHOT (it does NOT loop), sized
to cover a full 128x128 object and centered in each cell:
  Frame 1: a small puff beginning to form low/center.
  Frame 2: the puff growing outward.
  Frame 3: a full, OPAQUE puff that completely hides whatever is behind it.
  Frame 4: the puff dissipating, becoming semi-transparent.
  Frame 5: nearly cleared — only faint wisps remain.
Use a neutral light-grey / white smoke with a subtle <themeName> color tint.

Rows 3 and 4 (cells 11-20): leave every pixel flat solid #FF00FF magenta (unused).

Center content in each used cell. Crisp retro pixel art, consistent three-quarter / isometric
viewpoint and lighting matching the object boards.

Creative direction: <creativeDirection>
```

---

# Codex integration checklist (generation pipeline)
1. **themeAssetPrompts.ts** — replace the single-state 4×3 `buildObjectAtlasPrompt` with the animated
   4-objects-per-board prompt (A), batching objects into boards of 4; add `buildBuildSystemBoardPrompt`
   (B). Keep using `boardContract(5, 4)` for the shared magenta/grid rules.
2. **themePlan.ts** — add `OBJECT_CLIPS` (above).
3. **Slicing/orchestration** — slice each object board 5×4 and group rows → `object_<id>` keys; slice the
   build-system board → `crate` / `poof` keys (see Slicing section).
4. **types.ts** — point `BuildableObject.sprite_asset` at `frames.json#object_<id>`; add
   `ViewportConfig.crate_asset` / `poof_asset`.
5. **Review UI** — surface object boards + the build-system board as review cards (they already get
   Keep / Needs changes / Retry / **Upload**), so the user can regenerate or hand-upload any of them.

# Claude (webview) follow-up — after PNGs/frames exist
Render objects at `anchor_coord` with the crate→poof→object_idle state machine + progress bar, honoring
`object_scale`. Tracked in the stage-tuning/gameplay roadmap.
