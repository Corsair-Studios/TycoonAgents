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
