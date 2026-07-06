import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas } from '../src/extension/slicer';

// ---------------------------------------------------------------------------
// Registration tests: prove registrationGroups mechanically cancels drawn
// horizontal drift within a group (e.g. an AI-drawn animation row where the
// subject shifts a few pixels left/right each frame), while a group NOT
// listed in registrationGroups keeps whatever drift the source art has, and
// registration never touches vertical position (intentional bob/hop stays).
// ---------------------------------------------------------------------------

function paintRect(atlas: Jimp, x: number, y: number, w: number, h: number, color: number): void {
  atlas.scan(x, y, w, h, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(color, idx);
  });
}

test('registrationGroups cancels drawn horizontal drift; an unlisted group keeps its drift', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 4, cellSize * 2, 0xff00ffff);
  const color = 0x1950a0ff;

  // Row 0 (slots 0-3): registered. Cols 0 and 2 carry the same 20x20 rect;
  // col 2's copy is drawn 6px further right than col 0's - the drift to cancel.
  paintRect(atlas, 0 * cellSize + 15, 20, 20, 20, color);
  paintRect(atlas, 2 * cellSize + 21, 20, 20, 20, color);

  // Row 1 (slots 4-7): the identical drift pattern, but this row is NOT
  // listed in registrationGroups.
  paintRect(atlas, 0 * cellSize + 15, cellSize + 20, 20, 20, color);
  paintRect(atlas, 2 * cellSize + 21, cellSize + 20, 20, 20, color);

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, {
    columns: 4,
    rows: 2,
    normalizationGroups: [[0, 1, 2, 3], [4, 5, 6, 7]],
    registrationGroups: [[0, 1, 2, 3]],
  });

  // Registered row: drift cancelled, both frames share the same content left edge.
  assert.equal(result.slots[0].meta.left, result.slots[2].meta.left);

  // Unregistered row: the 6px drawn drift survives group normalization's
  // shared-crop, relative-position-preserving behavior.
  assert.equal(result.slots[6].meta.left - result.slots[4].meta.left, 6);
});

test('registration only ever shifts horizontally; vertical bob between frames is preserved', async () => {
  const cellSize = 60;
  const atlas = new Jimp(cellSize * 2, cellSize, 0xff00ffff);
  const color = 0x1950a0ff;

  // Frame 0: rect at (15, 10). Frame 1 (candidate): the same rect shifted 6px
  // right (drift to cancel) AND 15px down (intentional bob to preserve).
  paintRect(atlas, 15, 10, 20, 20, color);
  paintRect(atlas, cellSize + 21, 25, 20, 20, color);

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {}, {
    columns: 2,
    rows: 1,
    normalizationGroups: [[0, 1]],
    registrationGroups: [[0, 1]],
  });

  const [frame0, frame1] = result.slots;
  assert.equal(frame0.meta.left, frame1.meta.left);
  assert.equal(frame1.meta.topY - frame0.meta.topY, 15);
  assert.equal(frame1.meta.footY - frame0.meta.footY, 15);
});
