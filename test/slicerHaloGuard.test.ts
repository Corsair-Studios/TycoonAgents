import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import {
  sliceAndNormalizeAtlas,
  neutralizeTransparentToBlack,
  replaceChromaMagentaWithBlack,
  isMagentaBackgroundLoose,
  stripLooseMagentaToTransparent,
} from '../src/extension/slicer';

// Focused unit tests for the halo-guard building blocks used by
// AtlasGrid.smoothResize: neutralizeTransparentToBlack() zeroes the RGB of
// every fully-transparent pixel (regardless of its prior color) so a later
// bicubic resize can't blend leftover chroma-magenta into an opaque edge
// pixel, and replaceChromaMagentaWithBlack() recolors magenta background
// pixels to black up front regardless of alpha. Neither function ever
// touches alpha. isMagentaBackgroundLoose() and stripLooseMagentaToTransparent()
// broaden that coverage to shaded/dark magenta (e.g. (120,0,110)) that the
// strict isChromaMagenta test misses, while staying red-safe (real red-object
// pixels have r-b >= 50, disjoint from the loose test's r-b <= 45 bound). This
// file is intentionally separate from slicer.test.ts, mirroring
// slicerMetadata.test.ts / slicerRegistration.test.ts as an independent
// focused suite.

// --- neutralizeTransparentToBlack -------------------------------------------

test('neutralizeTransparentToBlack recolors a magenta-transparent pixel to black without touching alpha', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0xff00ff00, 0, 0); // r=255 g=0 b=255 a=0 (magenta, transparent)

  neutralizeTransparentToBlack(img);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.r, 0);
  assert.equal(after.g, 0);
  assert.equal(after.b, 0);
  assert.equal(after.a, 0);
});

test('neutralizeTransparentToBlack never modifies an opaque pixel', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0x787878ff, 0, 0); // r=120 g=120 b=120 a=255

  const before = img.getPixelColor(0, 0);
  neutralizeTransparentToBlack(img);
  const after = img.getPixelColor(0, 0);

  assert.equal(after, before, 'opaque pixel RGBA must be byte-identical before and after');
});

test('neutralizeTransparentToBlack recolors ANY transparent pixel to black, not just magenta ones', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0x0ac81e00, 0, 0); // r=10 g=200 b=30 a=0 (non-magenta, transparent)

  neutralizeTransparentToBlack(img);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.r, 0);
  assert.equal(after.g, 0);
  assert.equal(after.b, 0);
  assert.equal(after.a, 0);
});

// --- replaceChromaMagentaWithBlack ------------------------------------------

test('replaceChromaMagentaWithBlack recolors an OPAQUE magenta pixel to black without touching alpha', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0xff00ffff, 0, 0); // r=255 g=0 b=255 a=255 (opaque magenta)

  replaceChromaMagentaWithBlack(img);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.r, 0);
  assert.equal(after.g, 0);
  assert.equal(after.b, 0);
  assert.equal(after.a, 255);
});

test('replaceChromaMagentaWithBlack recolors an OPAQUE dark/shaded magenta pixel to black (broadened past the strict test) without touching alpha', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0x78006eff, 0, 0); // r=120 g=0 b=110 a=255 (dark magenta; strict isChromaMagenta would miss this)

  replaceChromaMagentaWithBlack(img);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.r, 0);
  assert.equal(after.g, 0);
  assert.equal(after.b, 0);
  assert.equal(after.a, 255);
});

test('replaceChromaMagentaWithBlack never modifies a non-magenta opaque pixel', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0x787878ff, 0, 0); // r=120 g=120 b=120 a=255

  const before = img.getPixelColor(0, 0);
  replaceChromaMagentaWithBlack(img);
  const after = img.getPixelColor(0, 0);

  assert.equal(after, before, 'non-magenta opaque pixel RGBA must be byte-identical before and after');
});

test('replaceChromaMagentaWithBlack never modifies a red-object opaque pixel (red-safe under the broadened loose test)', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0xc81e1eff, 0, 0); // r=200 g=30 b=30 a=255 (red object)

  const before = img.getPixelColor(0, 0);
  replaceChromaMagentaWithBlack(img);
  const after = img.getPixelColor(0, 0);

  assert.equal(after, before, 'red-object opaque pixel RGBA must be byte-identical before and after');
});

test('replaceChromaMagentaWithBlack recolors a transparent magenta pixel to black without touching alpha', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0xff00ff00, 0, 0); // r=255 g=0 b=255 a=0 (magenta, transparent)

  replaceChromaMagentaWithBlack(img);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.r, 0);
  assert.equal(after.g, 0);
  assert.equal(after.b, 0);
  assert.equal(after.a, 0);
});

// --- isMagentaBackgroundLoose -------------------------------------------

test('isMagentaBackgroundLoose recognizes bright and shaded/dark magenta as background', () => {
  const trueCases: Array<[number, number, number]> = [
    [255, 0, 255], // bright chroma magenta
    [153, 0, 136],
    [170, 0, 136],
    [34, 0, 34], // very dark magenta
    [120, 0, 110],
    [166, 7, 140],
  ];
  for (const [r, g, b] of trueCases) {
    assert.equal(isMagentaBackgroundLoose(r, g, b), true, `expected (${r},${g},${b}) to read as loose-magenta background`);
  }
});

test('isMagentaBackgroundLoose is red-safe: real red-object pixels are never caught', () => {
  const redObjectCases: Array<[number, number, number]> = [
    [200, 30, 30],
    [255, 20, 20],
    [180, 40, 120], // r-b = 60, outside the <=45 loose bound
    [136, 0, 80],
  ];
  for (const [r, g, b] of redObjectCases) {
    assert.equal(isMagentaBackgroundLoose(r, g, b), false, `expected red-object pixel (${r},${g},${b}) to NOT read as loose-magenta`);
  }
});

test('isMagentaBackgroundLoose rejects gray/black/blue/green (non-magenta) pixels', () => {
  const nonMagentaCases: Array<[number, number, number]> = [
    [100, 100, 100], // gray
    [0, 0, 0], // black
    [20, 20, 200], // blue
    [30, 200, 30], // green
  ];
  for (const [r, g, b] of nonMagentaCases) {
    assert.equal(isMagentaBackgroundLoose(r, g, b), false, `expected non-magenta pixel (${r},${g},${b}) to NOT read as loose-magenta`);
  }
});

// --- stripLooseMagentaToTransparent --------------------------------------

test('stripLooseMagentaToTransparent sets alpha=0 AND RGB=0 for a dark/shaded magenta pixel', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0x78006eff, 0, 0); // r=120 g=0 b=110 a=255 (dark magenta)

  stripLooseMagentaToTransparent(img);

  const after = Jimp.intToRGBA(img.getPixelColor(0, 0));
  assert.equal(after.r, 0);
  assert.equal(after.g, 0);
  assert.equal(after.b, 0);
  assert.equal(after.a, 0);
});

test('stripLooseMagentaToTransparent never modifies a red-object opaque pixel', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0xc81e1eff, 0, 0); // r=200 g=30 b=30 a=255 (red object)

  const before = img.getPixelColor(0, 0);
  stripLooseMagentaToTransparent(img);
  const after = img.getPixelColor(0, 0);

  assert.equal(after, before, 'red-object opaque pixel RGBA must be byte-identical before and after');
});

test('stripLooseMagentaToTransparent never modifies a non-magenta gray opaque pixel', () => {
  const img = new Jimp(1, 1, 0x00000000);
  img.setPixelColor(0x787878ff, 0, 0); // r=120 g=120 b=120 a=255 (gray)

  const before = img.getPixelColor(0, 0);
  stripLooseMagentaToTransparent(img);
  const after = img.getPixelColor(0, 0);

  assert.equal(after, before, 'gray opaque pixel RGBA must be byte-identical before and after');
});

// --- smoothResize end-to-end (best effort) -----------------------------
//
// Exercises the full pipeline: a downscaling resize over a magenta-backed
// cell with grid.smoothResize:true must neutralize the transparent
// background's RGB to black BEFORE the bicubic resize runs, so no
// magenta-tinted color can blend into the partial-alpha edge pixels the
// resize produces.

test('smoothResize (neutralize + bicubic downscale) produces no magenta-dominant halo at partial-alpha edge pixels', async () => {
  const cellSize = 100;
  const atlas = new Jimp(cellSize, cellSize, 0xff00ffff);
  // A solid opaque neutral-green square well clear of the cell edges. Content
  // height (60px) is intentionally well above targetContentHeight (20px) so
  // the resulting boardScale is well below 1 -- a real downscale, not a
  // no-op or an upscale.
  atlas.scan(20, 20, 60, 60, function (_x, _y, idx) {
    this.bitmap.data[idx] = 40;
    this.bitmap.data[idx + 1] = 160;
    this.bitmap.data[idx + 2] = 40;
    this.bitmap.data[idx + 3] = 255;
  });

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    {
      columns: 1,
      rows: 1,
      scaleReferenceSlots: [0],
      targetContentHeight: 20,
      maxContentExtent: 120,
      smoothResize: true,
    },
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

test('smoothResize e2e: a dark/shaded magenta background patch is stripped to transparent, not left as a purple pixel', async () => {
  const cellSize = 100;
  const atlas = new Jimp(cellSize, cellSize, 0xff00ffff); // bright magenta background (strict-keyed away)
  // Opaque neutral-green subject, well clear of the cell edges.
  atlas.scan(20, 20, 60, 60, function (_x, _y, idx) {
    this.bitmap.data[idx] = 40;
    this.bitmap.data[idx + 1] = 160;
    this.bitmap.data[idx + 2] = 40;
    this.bitmap.data[idx + 3] = 255;
  });
  // A dark/shaded magenta patch adjacent to the subject. It FAILS the strict
  // isChromaMagenta test (r=130, b=120 are both below the 180 floor), so it
  // survives keyBorderConnectedMagenta/removeAllChromaMagenta as opaque
  // "content" -- exactly the leftover pixel that used to bloom into a purple
  // halo under bicubic resize before stripLooseMagentaToTransparent existed.
  atlas.scan(12, 12, 6, 6, function (_x, _y, idx) {
    this.bitmap.data[idx] = 130;
    this.bitmap.data[idx + 1] = 0;
    this.bitmap.data[idx + 2] = 120;
    this.bitmap.data[idx + 3] = 255;
  });

  const result = await sliceAndNormalizeAtlas(
    await atlas.getBufferAsync(Jimp.MIME_PNG),
    {},
    {
      columns: 1,
      rows: 1,
      scaleReferenceSlots: [0],
      targetContentHeight: 20,
      maxContentExtent: 120,
      smoothResize: true,
    },
  );
  const frame = await Jimp.read(Buffer.from(result.slots[0].data.split(',')[1], 'base64'));

  let magentaish = 0;
  frame.scan(0, 0, frame.bitmap.width, frame.bitmap.height, function (_x, _y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    if (isMagentaBackgroundLoose(r, g, b)) magentaish++;
  });

  assert.equal(magentaish, 0, 'no pixel in the final frame should read as loose-magenta -- the dark patch must be gone, not left purple');
});
