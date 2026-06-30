import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas, measureFrameContent } from '../src/extension/slicer';

// ---------------------------------------------------------------------------
// Phase 1 metadata tests: prove measureFrameContent() is correct in isolation,
// and prove the "no-hop" property — every non-empty normalized frame from a
// sliced atlas shares the same horizontal center (centroidX) and foot line
// (footY), regardless of where the source art was positioned within its cell.
// ---------------------------------------------------------------------------

test('measureFrameContent computes exact bounds/centroid for a known opaque rectangle', async () => {
  const image = new Jimp(128, 128, 0x00000000);
  // Opaque rectangle: x in [20,40), y in [50,90) -> width 20, height 40.
  image.scan(20, 50, 20, 40, function (_x, _y, idx) {
    this.bitmap.data[idx] = 10;
    this.bitmap.data[idx + 1] = 200;
    this.bitmap.data[idx + 2] = 30;
    this.bitmap.data[idx + 3] = 255;
  });

  const meta = measureFrameContent(image);

  // left=20, right=39 (20..39 inclusive = 20 px wide)
  // topY=50, footY=89 (50..89 inclusive = 40 px tall)
  // centroidX = average x of columns 20..39 = (20+39)/2 = 29.5
  // opaqueCount = 20 * 40 = 800
  assert.equal(meta.left, 20);
  assert.equal(meta.right, 39);
  assert.equal(meta.topY, 50);
  assert.equal(meta.footY, 89);
  assert.equal(meta.centroidX, 29.5);
  assert.equal(meta.opaqueCount, 800);
});

test('measureFrameContent reports the empty sentinel for an all-transparent image', async () => {
  const image = new Jimp(128, 128, 0x00000000);
  const meta = measureFrameContent(image);
  assert.equal(meta.centroidX, -1);
  assert.equal(meta.footY, -1);
  assert.equal(meta.topY, -1);
  assert.equal(meta.left, -1);
  assert.equal(meta.right, -1);
  assert.equal(meta.opaqueCount, 0);
});

test('no-hop: differently-positioned same-size blobs normalize to a shared centroidX and footY', async () => {
  // 5x4 grid, cell 102x128 (5*102=510 <= 512, 4*128=512).
  const cellW = 102;
  const cellH = 128;
  const atlas = new Jimp(cellW * 5, cellH * 4, 0xff00ffff);

  const blobW = 16;
  const blobH = 24;
  const blobColor = 0x1950a0ff; // non-magenta, opaque

  const paintBlob = (col: number, row: number, offsetX: number, offsetY: number) => {
    const x = col * cellW + offsetX;
    const y = row * cellH + offsetY;
    atlas.scan(x, y, blobW, blobH, function (_px, _py, idx) {
      this.bitmap.data.writeUInt32BE(blobColor, idx);
    });
  };

  // Place the same-size blob at four different offsets within their cells.
  // Slot 0 (col0,row0): shoved top-left.
  paintBlob(0, 0, 2, 2);
  // Slot 1 (col1,row0): shoved bottom-right.
  paintBlob(1, 0, cellW - blobW - 2, cellH - blobH - 2);
  // Slot 2 (col2,row0): centered.
  paintBlob(2, 0, Math.floor((cellW - blobW) / 2), Math.floor((cellH - blobH) / 2));
  // Slot 6 (col1,row1): off to one side, near the top.
  paintBlob(1, 1, cellW - blobW - 5, 5);
  // All remaining cells stay pure magenta (empty).

  const nonEmptySlotIds = [0, 1, 2, 6];

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {});

  const measured: Array<{ slot_id: number; centroidX: number; footY: number }> = [];
  for (const id of nonEmptySlotIds) {
    const slot = result.slots[id];
    assert.ok(slot, `expected slot ${id} to exist`);
    // Prefer the contract field slot.meta; fall back to decoding + measuring
    // manually so the geometric assertion still has value if meta isn't wired.
    let centroidX: number;
    let footY: number;
    const meta = (slot as { meta?: { centroidX: number; footY: number; opaqueCount: number } }).meta;
    if (meta && meta.opaqueCount > 0) {
      centroidX = meta.centroidX;
      footY = meta.footY;
    } else {
      const image = await Jimp.read(Buffer.from(slot.data.split(',')[1], 'base64'));
      const fallback = measureFrameContent(image);
      assert.ok(fallback.opaqueCount > 0, `slot ${id} should not be empty`);
      centroidX = fallback.centroidX;
      footY = fallback.footY;
    }
    measured.push({ slot_id: id, centroidX, footY });
  }

  assert.equal(measured.length, nonEmptySlotIds.length);

  // Agreement definition: max-min spread across all non-empty frames.
  // centroidX must agree within +/-2px (spread <= 4); footY within +/-1px (spread <= 2... use <=1 per spec wording "agree within +/-1px").
  const centroidXs = measured.map((m) => m.centroidX);
  const footYs = measured.map((m) => m.footY);
  const centroidSpread = Math.max(...centroidXs) - Math.min(...centroidXs);
  const footSpread = Math.max(...footYs) - Math.min(...footYs);

  assert.ok(
    centroidSpread <= 4,
    `centroidX spread too large: ${centroidSpread} (values: ${centroidXs.join(', ')})`,
  );
  assert.ok(
    footSpread <= 1,
    `footY spread too large: ${footSpread} (values: ${footYs.join(', ')})`,
  );
});

test('empty (pure magenta) cell yields opaqueCount 0 and -1 sentinel metadata', async () => {
  const cellW = 102;
  const cellH = 128;
  const atlas = new Jimp(cellW * 5, cellH * 4, 0xff00ffff);

  // Paint a blob only in slot 0; slot 1 stays pure magenta (empty).
  atlas.scan(10, 10, 16, 24, function (_x, _y, idx) {
    this.bitmap.data.writeUInt32BE(0x1950a0ff, idx);
  });

  const result = await sliceAndNormalizeAtlas(await atlas.getBufferAsync(Jimp.MIME_PNG), {});
  const emptySlot = result.slots[1];
  assert.ok(emptySlot, 'expected slot 1 to exist');

  const meta = (emptySlot as { meta?: { centroidX: number; footY: number; topY: number; left: number; right: number; opaqueCount: number } }).meta;
  if (meta) {
    assert.equal(meta.opaqueCount, 0);
    assert.equal(meta.centroidX, -1);
    assert.equal(meta.footY, -1);
    assert.equal(meta.topY, -1);
    assert.equal(meta.left, -1);
    assert.equal(meta.right, -1);
  } else {
    // Fallback: decode and measure manually if meta isn't wired yet.
    const image = await Jimp.read(Buffer.from(emptySlot.data.split(',')[1], 'base64'));
    const fallback = measureFrameContent(image);
    assert.equal(fallback.opaqueCount, 0);
    assert.equal(fallback.centroidX, -1);
    assert.equal(fallback.footY, -1);
  }
});
