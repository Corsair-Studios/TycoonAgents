import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { sliceAndNormalizeAtlas, bleedTransparentEdges } from '../src/extension/slicer';

// Focused unit tests for the halo-guard feature: bleedTransparentEdges()
// neutralizes the RGB of transparent pixels that still carry leftover
// chroma-magenta color, so a later bicubic resize can't blend that magenta
// into opaque edge pixels and produce a halo. This file is intentionally
// separate from slicer.test.ts, mirroring slicerMetadata.test.ts /
// slicerRegistration.test.ts as an independent focused suite.

test('bleedTransparentEdges recolors a magenta-transparent pixel adjacent to an opaque neighbor without touching its alpha', () => {
  // A 2x1 image: pixel 0 is a transparent leftover-magenta background pixel
  // (RGB still pure magenta even though alpha is 0 -- chroma-key knockout
  // only zeroes alpha, it never has to touch RGB); pixel 1 is a solid opaque
  // neutral-gray pixel, its only neighbor.
  const img = new Jimp(2, 1, 0x00000000);
  img.setPixelColor(0xff00ff00, 0, 0); // r=255 g=0 b=255 a=0 (magenta, transparent)
  img.setPixelColor(0x787878ff, 1, 0); // r=120 g=120 b=120 a=255 (neutral gray, opaque)

  const before = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(before.r, 255);
  assert.equal(before.b, 255);
  assert.equal(before.a, 0);

  bleedTransparentEdges(img, 4);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  // Alpha must be completely untouched -- still fully transparent.
  assert.equal(after.a, 0);
  // RGB must have moved off pure magenta toward the single opaque neighbor.
  assert.ok(
    !(after.r === 255 && after.b === 255),
    `expected RGB to move off pure magenta, got rgb(${after.r},${after.g},${after.b})`,
  );
  // With exactly one opaque neighbor, the average IS that neighbor's color;
  // allow +-2 for rounding.
  assert.ok(Math.abs(after.r - 120) <= 2, `expected r near 120, got ${after.r}`);
  assert.ok(Math.abs(after.g - 120) <= 2, `expected g near 120, got ${after.g}`);
  assert.ok(Math.abs(after.b - 120) <= 2, `expected b near 120, got ${after.b}`);
});

test('bleedTransparentEdges never modifies an already-opaque pixel', () => {
  const img = new Jimp(2, 1, 0x00000000);
  img.setPixelColor(0xff00ff00, 0, 0); // transparent magenta neighbor
  img.setPixelColor(0x1950a0ff, 1, 0); // opaque blue content pixel

  const before = img.getPixelColor(1, 0);
  bleedTransparentEdges(img, 4);
  const after = img.getPixelColor(1, 0);

  assert.equal(after, before, 'opaque pixel RGBA must be byte-identical before and after bleeding');
});

test('bleedTransparentEdges leaves a transparent pixel unchanged when it has no opaque neighbor anywhere', () => {
  // A fully-transparent 3x3 magenta field -- nothing opaque to average
  // toward, so every pixel (RGB and alpha) must survive byte-identical even
  // across multiple iterations.
  const img = new Jimp(3, 3, 0x00000000);
  img.scan(0, 0, 3, 3, function (_x, _y, idx) {
    this.bitmap.data[idx] = 255;
    this.bitmap.data[idx + 1] = 0;
    this.bitmap.data[idx + 2] = 255;
    this.bitmap.data[idx + 3] = 0;
  });
  const before = Buffer.from(img.bitmap.data);

  bleedTransparentEdges(img, 4);

  assert.deepEqual(img.bitmap.data, before);
});

test('bleedTransparentEdges defaults to a usable iteration count when called with one argument', () => {
  const img = new Jimp(2, 1, 0x00000000);
  img.setPixelColor(0xff00ff00, 0, 0);
  img.setPixelColor(0x787878ff, 1, 0);

  assert.doesNotThrow(() => bleedTransparentEdges(img));

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.a, 0);
  assert.ok(!(after.r === 255 && after.b === 255));
});

// --- smoothResize end-to-end (best effort) -----------------------------
//
// Exercises the full pipeline: bled RGB feeding a bicubic resize should not
// reintroduce a magenta-tinted fringe at partial-alpha edge pixels the way a
// raw (unbled) bicubic resize over magenta-backed transparent pixels would.
// If AtlasGrid.smoothResize isn't wired into sliceAndNormalizeAtlas yet this
// assertion will simply reflect that (see report) -- it targets the intended
// integration contract rather than an implementation detail.

test('smoothResize (bleed + bicubic) produces no magenta-dominant halo at partial-alpha edge pixels', async () => {
  const cellSize = 40;
  const atlas = new Jimp(cellSize, cellSize, 0xff00ffff);
  // A solid opaque neutral-green square well clear of the cell edges, so only
  // the resize step (not chroma-key/despill) can introduce a fringe.
  atlas.scan(10, 10, 20, 20, function (_x, _y, idx) {
    this.bitmap.data[idx] = 40;
    this.bitmap.data[idx + 1] = 160;
    this.bitmap.data[idx + 2] = 40;
    this.bitmap.data[idx + 3] = 255;
  });

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    { columns: 1, rows: 1, targetContentHeight: 100, maxContentExtent: 120, smoothResize: true },
  );
  const frame = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));

  let haloPixels = 0;
  frame.scan(0, 0, frame.bitmap.width, frame.bitmap.height, function (_x, _y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    if (a === 0 || a === 255) return; // only inspect partial-alpha (resize-blended) edge pixels
    if (r >= 180 && b >= 180 && g <= 90) haloPixels++;
  });

  assert.equal(haloPixels, 0, 'no partial-alpha edge pixel should read as a magenta-dominant halo');
});
