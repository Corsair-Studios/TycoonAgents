import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas } from '../src/extension/slicer';
import type { AtlasGrid } from '../src/extension/slicer';
import { assembleThemePrompt, CHARACTER_QUADRUPED_TARGET_CONTENT_WIDTH } from '../src/core/themePromptTemplates';
import type { StructuredGenerateRequest } from '../src/core/themePromptTemplates';
import { characterAtlasGrid } from '../src/extension/themeService';

// p-clipping-fix: four-legged character boards (5 cols x 4 rows, portrait
// cells) clip tails/strides that spill into the neighboring cell because the
// character prompt sized poses by HEIGHT only. These tests cover the new
// WIDTH-based silhouette budget in the four-legged prompt, and the
// width-based normalization + gutter snapping added for four-legged boards
// in src/extension/themeService.ts's characterAtlasGrid.

const theme = { description: 'A whimsical steampunk carnival', creativeDirection: 'Brass gears', palette: ['#8B5E3C'] };

function rosterRequest(bodyPlan: 'biped' | 'quadruped'): StructuredGenerateRequest {
  return {
    promptTemplateVersion: 'x',
    theme,
    themeName: 'Steampunk Carnival',
    boardType: 'roster_agent',
    slot: { name: 'Clockwork Hound', description: 'a mechanical dog companion', bodyPlan },
  };
}

test('four-legged character prompt carries a width-based silhouette budget', () => {
  const { prompt } = assembleThemePrompt(rosterRequest('quadruped'), { walkPoseGuideAttached: true });
  assert.match(prompt, /stays within the central 70% of the cell WIDTH/i);
  assert.match(prompt, /gutter of at least 15% of the cell width/i);
  assert.match(prompt, /tail curled or held close to the body/i);
  // Replaces, not adds to, the height rule.
  assert.doesNotMatch(prompt, /occupies exactly 72% of the cell height/i);
});

test('two-legged character prompt keeps the original height-based scale rule, unchanged', () => {
  const { prompt } = assembleThemePrompt(rosterRequest('biped'), { walkPoseGuideAttached: true });
  assert.match(prompt, /occupies exactly 72% of the cell height/i);
  assert.doesNotMatch(prompt, /cell WIDTH/i);
});

function paintRect(atlas: Jimp, x: number, y: number, w: number, h: number, color: number): void {
  atlas.scan(x, y, w, h, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(color, idx);
  });
}

test('character-atlas gutter snapping finds a magenta gutter offset from the proportional cut', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 5, cellSize * 4, 0xff00ffff);
  const color = 0x1950a0ff;
  // Column boundary between cell 0 and cell 1 in row 0 sits at x=60. Content
  // spills 2px past it (to x=62); the true gap is x=62..68.
  paintRect(atlas, 50, 10, 12, 40, color); // cell 0 content, spills to x=62
  paintRect(atlas, 68, 10, 12, 40, color); // cell 1 content, starts at x=68

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);
  const snapped = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 5, rows: 4, snapGutterBoundaries: true, gutterKeyColor: 'magenta',
  });
  const proportional = await sliceAndNormalizeAtlas(buf, {}, { columns: 5, rows: 4 });

  assert.equal(snapped.slots[0].meta.opaqueCount, 12 * 40);
  assert.equal(snapped.slots[1].meta.opaqueCount, 12 * 40);
  // Confirms the proportional cut really would have clipped, so the snap is
  // doing real work here rather than the two results coinciding by chance.
  assert.notEqual(proportional.slots[0].meta.opaqueCount, snapped.slots[0].meta.opaqueCount);
});

test('four-legged normalization fits content by WIDTH and keeps the same ground line as a taller pose', async () => {
  const cellSize = 64;
  const targetWidth = 40;
  const makeAtlas = async (spriteWidth: number, spriteHeight: number) => {
    const atlas = new Jimp(cellSize, cellSize, 0xff00ffff);
    const left = Math.floor((cellSize - spriteWidth) / 2);
    const top = cellSize - spriteHeight; // feet touch the cell bottom
    atlas.scan(left, top, spriteWidth, spriteHeight, function (_x, _y, idx) {
      this.bitmap.data[idx] = 25;
      this.bitmap.data[idx + 1] = 80;
      this.bitmap.data[idx + 2] = 160;
      this.bitmap.data[idx + 3] = 255;
    });
    return atlas.getBufferAsync(Jimp.MIME_PNG);
  };
  const grid = {
    columns: 1,
    rows: 1,
    scaleReferenceSlots: [0],
    targetContentWidth: targetWidth,
    maxContentExtent: 120,
  };
  // Two poses with different silhouette heights (a standing pose vs. a wider
  // mid-stride pose) but scaled by the same width budget.
  const [standing, wide] = await Promise.all([
    sliceAndNormalizeAtlas(await makeAtlas(30, 40), {}, grid),
    sliceAndNormalizeAtlas(await makeAtlas(50, 24), {}, grid),
  ]);

  const opaqueBounds = async (dataUri: string) => {
    const image = await Jimp.read(Buffer.from(dataUri.split(',')[1], 'base64'));
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      if (this.bitmap.data[idx + 3] !== 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    });
    return { width: maxX - minX + 1, height: maxY - minY + 1, bottom: maxY };
  };

  const standingBounds = await opaqueBounds(standing.slots[0].data);
  const wideBounds = await opaqueBounds(wide.slots[0].data);

  // Both fit to the same WIDTH target (not height).
  assert.equal(standingBounds.width, targetWidth);
  assert.equal(wideBounds.width, targetWidth);
  // Both stay bottom-anchored to the same ground line (128px frame bottom),
  // regardless of differing content height, so a cat doesn't float or sink.
  assert.equal(standingBounds.bottom, 127);
  assert.equal(wideBounds.bottom, 127);
});

test('two-legged normalization keeps fitting content by HEIGHT (unaffected by the width option)', async () => {
  const cellSize = 64;
  const atlas = new Jimp(cellSize, cellSize, 0xff00ffff);
  atlas.scan(17, 24, 30, 40, function (_x, _y, idx) {
    this.bitmap.data[idx] = 25;
    this.bitmap.data[idx + 1] = 80;
    this.bitmap.data[idx + 2] = 160;
    this.bitmap.data[idx + 3] = 255;
  });
  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);
  const grid = {
    columns: 1,
    rows: 1,
    scaleReferenceSlots: [0],
    targetContentHeight: 118,
    maxContentExtent: 126,
  };
  const result = await sliceAndNormalizeAtlas(buf, {}, grid);
  const image = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));
  let minY = Infinity, maxY = -1;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (_x, y, idx) {
    if (this.bitmap.data[idx + 3] !== 0) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  });
  assert.equal(maxY - minY + 1, 118); // scaled to targetContentHeight (height-driven), not the width option
});

// ---------------------------------------------------------------------------
// Review follow-up (BLOCKING #1): the width-fit scale had no width cap when
// clipWidthOverflow was also on (it was set for both body plans), so a wide,
// short quadruped frame could scale past maxContentExtent/128 and clip at
// the cell edge. Fixed by (a) always applying the width caps in
// sliceAndNormalizeAtlas when targetContentWidth is set, regardless of
// clipWidthOverflow, and (b) disabling clipWidthOverflow for the quadruped
// characterAtlasGrid entirely, since its whole point (letting a wide POSE
// clip instead of shrinking its CLIP) doesn't apply to a single-creature
// width budget. This test runs the REAL production grid, not a stand-in.
// ---------------------------------------------------------------------------
test('REAL characterAtlasGrid("quadruped"): a wide/short frame scales to fit maxContentExtent, never clips at the cell edge', async () => {
  const grid = characterAtlasGrid(false, 'quadruped') as AtlasGrid;
  assert.equal(grid.targetContentWidth, CHARACTER_QUADRUPED_TARGET_CONTENT_WIDTH);
  assert.equal(grid.maxContentExtent, 120);
  assert.equal(grid.clipWidthOverflow, false);

  // 1024x1024, 5 cols x 4 rows -- the real production atlas size.
  const atlas = new Jimp(1024, 1024, 0xff00ffff);
  const color = 0x1950a0ff;
  const colX = (col: number) => Math.floor(col * 1024 / 5);
  const rowY = (row: number) => Math.floor(row * 1024 / 4);

  // Reference slots (0,1,2,3,4,16): identical width-100 bodies so the median
  // reference width is 100 -> boardScale = 118/100 = 1.18, matching the
  // review's reported ~1.18.
  for (const slot of [0, 1, 2, 3, 4, 16]) {
    const row = Math.floor(slot / 5), col = slot % 5;
    paintRect(atlas, colX(col) + 20, rowY(row) + 20, 100, 150, color);
  }

  // Slot 9 (tool_idle -- its own single-cell normalization group, not a
  // scale reference): a wide, short frame matching the review's failure
  // shape (bw=140, bh=30). At boardScale 1.18 with no width cap this would
  // resize to ~165px wide and clip at the 128px frame edge.
  paintRect(atlas, colX(4) + 10, rowY(1) + 40, 140, 30, color);

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);
  const result = await sliceAndNormalizeAtlas(buf, {}, grid);

  const bounds = async (dataUri: string) => {
    const image = await Jimp.read(Buffer.from(dataUri.split(',')[1], 'base64'));
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, count = 0;
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      if (this.bitmap.data[idx + 3] !== 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        count += 1;
      }
    });
    return { width: maxX - minX + 1, height: maxY - minY + 1, count };
  };

  const slot9 = await bounds(result.slots[9].data);
  assert.ok(slot9.width <= 120, `slot 9 width ${slot9.width} exceeds maxContentExtent (120) -- would clip`);
  assert.ok(slot9.width <= 128, `slot 9 width ${slot9.width} exceeds the 128px frame -- clipped`);
  // Not clipped: the whole 140x30 rectangle survives, scaled down uniformly
  // (opaque pixel count matches a full filled rectangle, not a partial one).
  assert.ok(
    slot9.count >= slot9.width * slot9.height * 0.9,
    `slot 9 opaque count ${slot9.count} is far below its bbox area (${slot9.width}x${slot9.height}) -- looks cropped`,
  );
});

// ---------------------------------------------------------------------------
// Review follow-up (coverage gap #2): snapGutterBoundaries is now on for ALL
// character boards, but "two-legged unchanged" was only exercised on toy
// grids. This runs the REAL characterAtlasGrid("biped") config (registration
// groups, feet anchor, clipWidthOverflow, and the ALWAYS-ON boundary cleanup
// passes reclaimRowBoundarySpill/removeColumnBoundarySpill) on a 5x4 magenta
// board where one sprite's limb comes within the +/-8% snap window of a
// COLUMN boundary (a row boundary is deliberately avoided here: it's already
// handled by the pre-existing reclaimRowBoundarySpill pass regardless of
// snapGutterBoundaries, which is why an earlier version of this test showed
// no difference at all -- a column boundary has no such reclaim). Slot 13
// ("shoot", its 2-frame group's other member, 12, is left empty so it
// behaves as its own single-member group) spills 2px past the column
// boundary into slot 14 ("block", its own singleton group). Neither is a
// scale-reference slot, so boardScale (left at its 1 default -- reference
// slots are intentionally empty here) is identical in both runs and every
// OTHER cell is byte-identical with snapping on vs off. At the boundary,
// snapping is demonstrably no worse: slot 13 keeps content a proportional
// cut would clip, and slot 14 is unaffected either way because the
// always-on removeColumnBoundarySpill pass already cleans up the 2px
// leaked-in fragment on the proportional cut, exactly the same class of
// improvement already proven generically for rivals.
// ---------------------------------------------------------------------------
test('REAL characterAtlasGrid("biped"): gutter snapping is no worse than the proportional cut at a column boundary', async () => {
  const cell = 160; // 5 cols x 4 rows -> 800x640
  const buildAtlas = async () => {
    const atlas = new Jimp(cell * 5, cell * 4, 0xff00ffff);
    const color = 0x1950a0ff;
    // Row 2 (y=[320,480)) spans slots 10-14. Column boundary col3/col4 sits
    // at the nominal x=640 (4 * cell).
    // Slot 13 ("shoot"): a limb spills 2px past the column boundary (to x=642).
    paintRect(atlas, 600, 350, 42, 80, color); // x in [600,642), y in [350,430)
    // Real background gap (x in [642,648)), then slot 14's own unrelated content.
    paintRect(atlas, 648, 350, 52, 80, color); // x in [648,700), y in [350,430)
    return atlas.getBufferAsync(Jimp.MIME_PNG);
  };
  const buf = await buildAtlas();

  const snappedGrid = characterAtlasGrid(false, 'biped') as AtlasGrid;
  assert.equal(snappedGrid.snapGutterBoundaries, true); // the change under review
  const unsnappedGrid: AtlasGrid = { ...snappedGrid, snapGutterBoundaries: false };

  const [snapped, proportional] = await Promise.all([
    sliceAndNormalizeAtlas(buf, {}, snappedGrid),
    sliceAndNormalizeAtlas(buf, {}, unsnappedGrid),
  ]);

  // Every cell except the two touching the moved boundary (13, 14) is
  // byte-identical: registration/feetAnchor/clipWidthOverflow being "real"
  // doesn't change anything off the boundary.
  for (let slot = 0; slot < 20; slot++) {
    if (slot === 13 || slot === 14) continue;
    assert.equal(snapped.slots[slot].data, proportional.slots[slot].data, `slot ${slot} differs`);
  }

  // Slot 13: the proportional cut lands exactly on the boundary (x=640) and
  // clips the 2px spill; snapping finds the real gap at x=642 and keeps it.
  assert.equal(proportional.slots[13].meta.opaqueCount, 40 * 80, 'expected the proportional cut to clip the 2px spill');
  assert.equal(snapped.slots[13].meta.opaqueCount, 42 * 80, 'expected snapping to keep the full limb');
  assert.ok(
    snapped.slots[13].meta.opaqueCount > proportional.slots[13].meta.opaqueCount,
    'snapping should capture content the proportional cut clips, never lose content',
  );

  // Slot 14: unaffected either way -- the always-on removeColumnBoundarySpill
  // pass already strips the 2px leaked-in fragment on the proportional cut
  // (it's a minor left-edge-connected component, not most of the cell's
  // content), and snapping's crop simply never includes it in the first
  // place. Same real content, same result: snapping is no worse here.
  assert.equal(snapped.slots[14].meta.opaqueCount, proportional.slots[14].meta.opaqueCount);
  assert.equal(snapped.slots[14].meta.opaqueCount, 52 * 80);
});
