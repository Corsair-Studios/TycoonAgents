import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import {
  MAX_SPRITE_BOARD_BYTES,
  MAX_SPRITE_BOARD_HEIGHT,
  MAX_SPRITE_BOARD_WIDTH,
  optimizeSpriteBoard,
  optimizeSpriteBoardCanvas,
  resizeSpriteBoardCanvas,
} from '../src/extension/spriteBoardOptimizer';
import { isMagentaBackgroundLoose } from '../src/extension/slicer';

test('optimizeSpriteBoard produces a valid grid-aligned PNG below 200 KB', async () => {
  const source = new Jimp(800, 640, 0xff00ffff);
  let random = 0x12345678;

  source.scan(0, 0, source.bitmap.width, source.bitmap.height, (_x, _y, idx) => {
    // High-entropy pixels make this a deliberately difficult compression case.
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    source.bitmap.data[idx] = random & 0xff;
    source.bitmap.data[idx + 1] = (random >>> 8) & 0xff;
    source.bitmap.data[idx + 2] = (random >>> 16) & 0xff;
    source.bitmap.data[idx + 3] = 0xff;
  });

  const input = await source.getBufferAsync(Jimp.MIME_PNG);
  assert.ok(input.length >= MAX_SPRITE_BOARD_BYTES);

  const output = await optimizeSpriteBoard(input);
  assert.ok(output.length < MAX_SPRITE_BOARD_BYTES, `${output.length} is not below the byte limit`);
  assert.deepEqual([...output.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const decoded = await Jimp.read(output);
  assert.ok(decoded.bitmap.width <= MAX_SPRITE_BOARD_WIDTH);
  assert.ok(decoded.bitmap.height <= MAX_SPRITE_BOARD_HEIGHT);
  assert.equal(decoded.bitmap.width % 5, 0);
  assert.equal(decoded.bitmap.height % 4, 0);
});

test('optimizeSpriteBoard rejects invalid byte limits', async () => {
  const source = await new Jimp(5, 4, 0xff00ffff).getBufferAsync(Jimp.MIME_PNG);
  await assert.rejects(
    optimizeSpriteBoard(source, 0),
    /byte limit must be a positive integer/,
  );
});

test('optimizeSpriteBoard aligns output to a custom board grid', async () => {
  const source = await new Jimp(641, 513, 0xff00ffff).getBufferAsync(Jimp.MIME_PNG);
  const output = await optimizeSpriteBoard(source, undefined, 4, 3);
  const decoded = await Jimp.read(output);
  assert.equal(decoded.bitmap.width % 4, 0);
  assert.equal(decoded.bitmap.height % 3, 0);
});

test('resizeSpriteBoardCanvas enforces an exact 512x512 review canvas', async () => {
  const source = await new Jimp(640, 640, 0xff00ffff).getBufferAsync(Jimp.MIME_PNG);
  const output = await resizeSpriteBoardCanvas(source, 512, 512);
  const decoded = await Jimp.read(output);
  assert.equal(decoded.bitmap.width, 512);
  assert.equal(decoded.bitmap.height, 512);
});

test('optimizeSpriteBoardCanvas retains aggregate boards at exactly 512x512', async () => {
  for (const [columns, rows] of [[4, 3], [4, 4], [5, 4]]) {
    const source = await new Jimp(1024, 1024, 0xff00ffff).getBufferAsync(Jimp.MIME_PNG);
    const output = await optimizeSpriteBoardCanvas(source, columns, rows);
    const decoded = await Jimp.read(output);
    assert.equal(decoded.bitmap.width, 512);
    assert.equal(decoded.bitmap.height, 512);
  }
});

// Regression guard: buildable-object boards ('bicubic' resample) must
// flatten back onto an OPAQUE MAGENTA background for the review board --
// consistent with every other board type -- while smoothing the object
// content on a transparent base first so bicubic resampling can't bloom
// purple into the object's edges. The board must be neither transparent
// (that broke re-slicing of a black-boxed board) nor opaque black (that
// rendered a black box behind every object in-game). The in-game FRAMES
// produced by the slicer's smoothResize remain transparent -- untouched
// here. 'nearest' (the default, used by every other board type) is
// untouched by this fix and keeps its prior behavior.

function magentaBoardWithContent(): Jimp {
  const source = new Jimp(1024, 1024, 0xff00ffff); // magenta background
  // Opaque non-magenta content well inside one interior cell (4x4 grid ->
  // 256px cells), clear of every board edge/corner so the corners stay
  // pure background all the way through resize/compression.
  source.scan(280, 280, 64, 64, function (_x, _y, idx) {
    this.bitmap.data[idx] = 40;
    this.bitmap.data[idx + 1] = 160;
    this.bitmap.data[idx + 2] = 40;
    this.bitmap.data[idx + 3] = 255;
  });
  return source;
}

test('optimizeSpriteBoardCanvas (bicubic/object-board mode) flattens onto a magenta background (consistent review board), objects preserved', async () => {
  const input = await magentaBoardWithContent().getBufferAsync(Jimp.MIME_PNG);

  const output = await optimizeSpriteBoardCanvas(input, 4, 4, { resample: 'bicubic' });
  const decoded = await Jimp.read(output);
  assert.equal(decoded.bitmap.width, 512);
  assert.equal(decoded.bitmap.height, 512);

  const w = decoded.bitmap.width;
  const h = decoded.bitmap.height;
  const corners: Array<[number, number]> = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  for (const [x, y] of corners) {
    const { r, g, b, a } = Jimp.intToRGBA(decoded.getPixelColor(x, y));
    assert.equal(
      a,
      255,
      `corner (${x},${y}) must be OPAQUE (alpha 255) -- the review board is flattened onto magenta, `
      + 'not left transparent (transparent corners are the earlier regression that broke re-slicing)',
    );
    assert.ok(
      r >= 200 && g <= 60 && b >= 200,
      `corner (${x},${y}) must read as magenta (r>=200,g<=60,b>=200), got r=${r} g=${g} b=${b} -- `
      + 'opaque black is exactly the regression that caused black boxes behind objects in-game',
    );
  }

  let survivingObjectPixel = false;
  decoded.scan(0, 0, w, h, function (_x, _y, idx) {
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const a = this.bitmap.data[idx + 3];
    if (a === 255 && !isMagentaBackgroundLoose(r, g, b)) {
      survivingObjectPixel = true;
    }
  });
  assert.ok(
    survivingObjectPixel,
    'at least one opaque non-magenta pixel must survive the resample -- the drawn object content, '
    + 'proving the board is not blank/all-magenta',
  );
});

test('optimizeSpriteBoardCanvas (default nearest mode) still returns a valid PNG buffer -- behavior for other board types unchanged', async () => {
  const input = await magentaBoardWithContent().getBufferAsync(Jimp.MIME_PNG);

  const output = await optimizeSpriteBoardCanvas(input, 4, 4);
  assert.ok(Buffer.isBuffer(output));
  assert.deepEqual([...output.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const decoded = await Jimp.read(output);
  assert.equal(decoded.bitmap.width, 512);
  assert.equal(decoded.bitmap.height, 512);
});
