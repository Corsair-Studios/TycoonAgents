import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas } from '../src/extension/slicer';

// ---------------------------------------------------------------------------
// Gutter-snapping tests (rival-only `snapGutterBoundaries` option): a fixed
// proportional cut can land mid-silhouette when a limb/tentacle spills a few
// pixels past its nominal cell boundary. When there IS a fully-background
// gap nearby — alpha 0, or (on a magenta board) chroma-magenta within the
// same tolerance the per-cell keying pass uses — the cut should snap into it
// instead of slicing the content; when there is no such gap, or a real
// sprite pixel taints every candidate in the search window, the proportional
// cut must still be used.
// ---------------------------------------------------------------------------

function paintRect(atlas: Jimp, x: number, y: number, w: number, h: number, color: number): void {
  atlas.scan(x, y, w, h, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(color, idx);
  });
}

/** Punches a real alpha=0 gap into an otherwise-opaque atlas (full cell height). */
function punchTransparentGap(atlas: Jimp, x: number, w: number): void {
  atlas.scan(x, 0, w, atlas.bitmap.height, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(0x00000000, idx);
  });
}

test('snapGutterBoundaries cuts at a transparent gap offset from the proportional line', async () => {
  const cellSize = 60;
  // Opaque magenta background (the outer-frame detector only excludes magenta
  // rings, so an all-transparent atlas would itself get misread as a border
  // and trimmed) with a real alpha=0 gap punched in, so the gap is a genuine
  // transparent span, exactly like a transparent-mode board's own padding.
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);
  const color = 0x1950a0ff;

  // Nominal proportional boundary sits at x=60 (2 cols, 120px wide).
  // Left content spills to x=62 (past the nominal line); a transparent gap
  // runs from x=62 to x=68; right content starts at x=68.
  paintRect(atlas, 50, 10, 12, 40, color); // x in [50, 62)
  paintRect(atlas, 68, 10, 12, 40, color); // x in [68, 80)
  punchTransparentGap(atlas, 62, 6); // x in [62, 68)

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);

  const snapped = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2,
    rows: 1,
    snapGutterBoundaries: true,
  });
  const proportional = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2,
    rows: 1,
  });

  // Proportional cut at x=60 slices the left rect (its content spans 50-62):
  // the surviving 2px sliver that lands in slot 1 reads as boundary spill
  // from its neighbor and is cleaned away, so the left rect's pixels are
  // simply lost rather than just relocated.
  assert.equal(proportional.slots[0].meta.opaqueCount, 10 * 40);
  assert.equal(proportional.slots[1].meta.opaqueCount, 12 * 40);

  // Snapped cut lands in the transparent gap (62-68), so each rect stays
  // whole and entirely in its own cell.
  assert.equal(snapped.slots[0].meta.opaqueCount, 12 * 40);
  assert.equal(snapped.slots[1].meta.opaqueCount, 12 * 40);
});

test('snapGutterBoundaries falls back to the proportional cut when no transparent gap exists', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);
  const color = 0x1950a0ff;

  // One continuous opaque band straddling the nominal boundary (x=60) with
  // no transparent column anywhere near it (window is only ~8% of 60 = ~5px).
  paintRect(atlas, 40, 10, 40, 40, color); // x in [40, 80), no gap in [55,65)

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);

  const snapped = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2,
    rows: 1,
    snapGutterBoundaries: true,
  });
  const proportional = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2,
    rows: 1,
  });

  // No gap in the search window -> identical result to the plain proportional cut
  // (both cells split the band exactly in half, each retaining 20x40 opaque px).
  assert.equal(snapped.slots[0].meta.opaqueCount, proportional.slots[0].meta.opaqueCount);
  assert.equal(snapped.slots[1].meta.opaqueCount, proportional.slots[1].meta.opaqueCount);
  assert.equal(proportional.slots[0].meta.opaqueCount, 20 * 40);
  assert.equal(proportional.slots[1].meta.opaqueCount, 20 * 40);
  assert.equal(snapped.slots[0].meta.right, proportional.slots[0].meta.right);
});

test('on a magenta-background atlas, snapGutterBoundaries finds an offset magenta gutter', async () => {
  const cellSize = 60;
  // No alpha punch at all: the background is plain opaque #FF00FF magenta
  // everywhere except the two painted rects, exactly like a real production
  // (magenta-keyed) rival board. The x=[62,68) gap is background only
  // because it's magenta, never because of alpha.
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);
  const color = 0x1950a0ff;
  paintRect(atlas, 50, 10, 12, 40, color); // x in [50, 62)
  paintRect(atlas, 68, 10, 12, 40, color); // x in [68, 80)

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);
  const snapped = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2, rows: 1, snapGutterBoundaries: true, gutterKeyColor: 'magenta',
  });

  assert.equal(snapped.slots[0].meta.opaqueCount, 12 * 40);
  assert.equal(snapped.slots[1].meta.opaqueCount, 12 * 40);
});

test('an anti-aliased/near-magenta pixel within key tolerance still counts as background', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);
  const color = 0x1950a0ff;
  paintRect(atlas, 50, 10, 12, 40, color); // x in [50, 62)
  paintRect(atlas, 68, 10, 12, 40, color); // x in [68, 80)
  // Repaint the gap with a shaded/near-magenta color that still passes
  // isChromaMagenta's tolerance (r>=180, b>=180, g<=90, r-g/b-g>=120), the
  // same predicate the per-cell chroma-keying pass uses, instead of pure
  // #FF00FF, mimicking an anti-aliased edge blended toward the sprite.
  paintRect(atlas, 62, 10, 6, 40, 0xd020d0ff);

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);
  const snapped = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2, rows: 1, snapGutterBoundaries: true, gutterKeyColor: 'magenta',
  });

  assert.equal(snapped.slots[0].meta.opaqueCount, 12 * 40);
  assert.equal(snapped.slots[1].meta.opaqueCount, 12 * 40);
});

test('a real sprite pixel inside the search window breaks that column as a gutter candidate', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);
  const color = 0x1950a0ff;

  // Taint every column across the whole search window (nominal=60, window
  // ~5px -> 55..65) with one non-background pixel each, so isBackgroundColumn
  // fails for every candidate in range and snapping cannot find a clean gap.
  for (let x = 55; x <= 65; x++) {
    atlas.setPixelColor(color, x, 5);
  }

  const buf = await atlas.getBufferAsync(Jimp.MIME_PNG);
  const snapped = await sliceAndNormalizeAtlas(buf, {}, {
    columns: 2, rows: 1, snapGutterBoundaries: true, gutterKeyColor: 'magenta',
  });
  const proportional = await sliceAndNormalizeAtlas(buf, {}, { columns: 2, rows: 1 });

  // No clean column anywhere in the window -> falls back to the proportional
  // cut, identical to the no-snap result.
  assert.equal(snapped.slots[0].meta.opaqueCount, proportional.slots[0].meta.opaqueCount);
  assert.equal(snapped.slots[1].meta.opaqueCount, proportional.slots[1].meta.opaqueCount);
});

test('other boards (snapGutterBoundaries unset) are unaffected by the new boundary precompute', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 4, cellSize * 4, 0xff00ffff);
  const color = 0x1950a0ff;

  paintRect(atlas, 0 * cellSize + 15, 0 * cellSize + 10, 20, 20, color);
  paintRect(atlas, 1 * cellSize + 15, 1 * cellSize + 10, 20, 20, color);

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, {
    columns: 4,
    rows: 4,
  });

  assert.equal(result.slots[0].meta.opaqueCount, 20 * 20);
  assert.equal(result.slots[5].meta.opaqueCount, 20 * 20);
});
