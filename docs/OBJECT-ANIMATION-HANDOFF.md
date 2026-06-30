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
- Canvas **512×512**, **4 columns × 5 logical rows** = 20 visually equal cells, flat **#FF00FF** magenta background
  (same chroma-key + cell-padding rules as characters — reuse `boardContract(4, 5)`).
- **Each ROW = one object → exactly 4 distinct animation frames** (AI-generated, so every cell is a real
  frame — no held/duplicate frames). Each board has **5 item rows**: up to 5 objects, with build-system
  rows occupying the final board. `ceil(rowsNeeded / 5)` boards.
- **Build system (shared, 1 per theme):** **crate = 1 frame** (static, 1 row, 3 cells magenta) +
  **poof = 4 frames** (1 row, one-shot). These ride alongside objects on the final board.
- **Board count for the target (13 objects + crate + poof):** 13 object rows + 1 poof row + 1 crate row
  = **15 rows → exactly 3 boards, no spare**. Packing:
  - Board 1: objects 1–5
  - Board 2: objects 6–10
  - Board 3: objects 11–13, then **poof** row, **crate** row
- Source cells are 128 wide × 102/103 tall (remainder pixels are distributed proportionally); the
  slicer emits 128×128 frames and normalizes content per row. The shipped
  **`object_scale`** knob (manifest.viewport / Stage Editor) up-scales objects at draw time.

## Animation clip contract (add to themePlan.ts, parallel to ATLAS_CLIPS)
```ts
export type ObjectClipName = 'object_idle' | 'crate' | 'poof';
export interface ObjectClip { frames: number[]; fps: number; loop: boolean; hold?: boolean; }
export const OBJECT_CLIPS: Record<ObjectClipName, ObjectClip> = {
  object_idle: { frames: [0, 1, 2, 3], fps: 5,  loop: true },              // built object, loops (all 4 frames)
  crate:       { frames: [0],          fps: 0,  loop: true, hold: true },  // single static crate frame
  poof:        { frames: [0, 1, 2, 3], fps: 12, loop: false },             // one-shot reveal, 4 frames
};
```

## Slicing (reuse `sliceAndNormalizeAtlas`, grid 4×5)
Slice each board into 20 cells, then **group by row** (4 cells per row):
- Object row r → object's 4 frames = cells `[r*4 .. r*4+3]` → `frames["object_<object_id>"]`.
- Build-system rows → `frames["crate"] = [first cell of the crate row]`,
  `frames["poof"] = [the 4 cells of the poof row]`.
(`scaleReferenceSlots`/`targetContentHeight` normalize per-row like characters do.)

## Manifest / contract additions (types.ts)
- `BuildableObject.sprite_asset` → point at the animated key, e.g. `"frames.json#object_<object_id>"`
  (an array of 4 data-URIs). Optionally add `anim_fps?: number`, `anim_loop?: boolean` per object.
- Add a shared build-system reference, e.g. on `ViewportConfig`:
  `crate_asset?: string` (`"frames.json#crate"`), `poof_asset?: string` (`"frames.json#poof"`).

## Runtime (webview — Claude owns this)

**Build state (webview-derived, user-approved):** No host telemetry change. The panel derives state each
frame from `state.completedTasks × UNITS_PER_TASK` (tunable), filling `buildable_objects` in `build_order`
(each consumes `work_units_required`). Fully-filled = **BUILT** (`object_idle`), the first partially-filled
= **ACTIVE** (crate + progress bar), the rest = **UNBUILT** (hidden). `built`/`active` are derived, not stored.

**Object placement:** `anchor_coord` is normalized 0..1 (map via the polygon's native→canvas path). NOTE:
generated anchors are currently all `[0.5,0.5]`, so the webview AUTO-DISTRIBUTES the 13 objects at
deterministic points inside the walkable polygon. Honor `object_scale` + per-object override. Depth-sort
objects together with agents by Y.

**Per-object render state machine:** `UNBUILT (hidden) → ACTIVE (crate-hold + progress/health bar) →
on cumulative work ≥ work_units_required: POOF (one-shot) → OBJECT_IDLE (loop)`. Graceful fallback when a
theme has no `crate`/`poof` frames: draw a simple "under construction" marker + bar, then swap straight to
the object (no poof), no crash.

**Agent BUILD behavior (MODE_CONSTRUCT):**
- An ACTIVE agent walks toward the current ACTIVE build target (clip = `walk`).
- It stops a STANDOFF DISTANCE from the object (use `exclusion_radius`), positioned to the LEFT or RIGHT
  side of the object (alternate sides among builders), and FACES the object (flip toward it).
- It switches to the `build` clip **only after reaching** the standoff position — never while still walking.
- Idle (non-active) agents wander as today.

**Enemy / EVICT preemption (overrides build):**
- When one or more enemies are present on the map, every active agent STOPS building, walks to the nearest
  enemy, and engages it (`melee`/`shoot` clips) until ALL enemies are defeated.
- When all enemies are cleared, agents RESUME building the active target.
- Enemies are the manifest `roster_rivals` sprites; combat is a visualization (rival `resolve`/HP ticks down).

**Enemy spawn config (NEW editable theme field — see contract below):**
- `enemy_spawn_interval_seconds`: how often a wave appears (frequency).
- `enemy_count_mode`: `'all'` (always spawn all rivals) or `'random'` (spawn 1..rivalCount).
- Editable in the Stage Editor (like the scale sliders) and persisted to the manifest.

### Contract addition needed for enemy config (types.ts — requires approval)
Add an optional block (e.g. on `ViewportConfig` or a new `enemy_config`):
```ts
enemy_spawn_interval_seconds?: number;          // default e.g. 45
enemy_count_mode?: 'all' | 'random';            // default 'random'
```

---

# GENERATION PROMPTS (ready to use — OpenAI GPT Image + Gemini nano-banana)

Provider-agnostic (the existing prompts have no provider-specific text). Tuned for GPT Image
consistency (preferred). Fill the `<…>` template fields the same way `buildObjectAtlasPrompt` does.

One unified template per board. The board has **5 rows of 4 cells**; fill each row with an object,
the poof, the crate, or leave it magenta. Object boards use object rows only; the final board mixes the
last objects + poof + crate (for 13 objects: Board 1 = objects 1–5, Board 2 = objects 6–10,
Board 3 = objects 11–13 + poof + crate — a full board, no empty rows).

```
Create one sprite sheet for the "<themeName>" theme.
The outer image canvas is exactly 512 x 512 pixels (1:1). Do not crop to the grid bounds.
Inside is an exact 4-column by 5-logical-row grid of 20 visually equal cells.
Every unused pixel must be perfectly flat solid #FF00FF magenta — no gradients, lighting, shadow,
texture, fog, reflections, scenery, or environmental effects. Nothing may cross cell boundaries;
keep generous empty padding around all content.

Each ROW is 4 cells, left to right, holding the sequential animation frames of ONE item.
Populate all five placeholders from that board's row layout:
Row 1: <OBJECT, POOF, or CRATE row>
Row 2: <OBJECT, POOF, or CRATE row>
Row 3: <OBJECT, POOF, or CRATE row>
Row 4: <OBJECT, POOF, or CRATE row>
Row 5: <OBJECT, POOF, or CRATE row>

For an OBJECT row include `<display_name> — <short motion hint>`, for example
"radar dish slowly rotating, red status light pulsing." Boards 1–2 contain five OBJECT rows.
Board 3 contains three OBJECT rows followed by POOF and CRATE.

OBJECT rows: all 4 cells are the SAME object from the SAME fixed three-quarter / isometric camera,
identical position, scale, colors and lighting; ONLY moving or glowing parts change between cells so
the row loops seamlessly (cell 4 flows back into cell 1). Do NOT translate, rotate, or resize the
object body between frames. Keep motion subtle. Center each object with its lowest contact point near
the cell bottom; identical relative scale for all objects across all boards.

POOF row (one-shot reveal, does NOT loop), 4 cells, sized to cover a full object and centered:
  Cell 1: a small smoke puff beginning to form low/center.
  Cell 2: the puff growing outward.
  Cell 3: a full, OPAQUE puff that completely hides whatever is behind it.
  Cell 4: the puff dissipating to faint wisps.
Use neutral light-grey / white smoke with a subtle <themeName> color tint.

CRATE row: a single closed shipping CRATE in cell 1 (the remaining 3 cells flat magenta), themed to
<themeName> (materials, colors, markings match the theme). It is a static "ready to build" crate.

Crisp retro pixel art, consistent three-quarter / isometric viewpoint and lighting across every cell.
Creative direction: <creativeDirection>
```

> Note: this replaces the legacy single-state `buildObjectAtlasPrompt` (4×3, one static object per cell).

---

# Codex integration checklist (generation pipeline)
1. **themeAssetPrompts.ts** — replace the single-state 4×3 `buildObjectAtlasPrompt` with the unified
   animated **4×5** board prompt above (one row per item, 5 rows/board). Batch up to 5 objects per board; on
   the final board, append the **poof** row and **crate** row after the remaining object rows. Use
   `boardContract(4, 5)` for the shared magenta/grid rules.
2. **themePlan.ts** — add `OBJECT_CLIPS` (above).
3. **Slicing/orchestration** — slice each board **4×5** and group rows → `object_<id>` (4 cells/row,
   4 frames per object row), `crate` (first cell of the crate row), `poof` (4 cells of the
   poof row). See Slicing section.
4. **types.ts** — point `BuildableObject.sprite_asset` at `frames.json#object_<id>`; add
   `ViewportConfig.crate_asset` / `poof_asset`.
5. **Review UI** — surface all 3 object boards (the crate + poof share Board 3) as review cards (they
   already get Keep / Needs changes / Retry / **Upload**), so the user can regenerate or hand-upload any.
   This increases a full generation run from 23 to **25** review images.

# Claude (webview) follow-up — after PNGs/frames exist
Render objects at `anchor_coord` with the crate→poof→object_idle state machine + progress bar, honoring
`object_scale`. Tracked in the stage-tuning/gameplay roadmap.
