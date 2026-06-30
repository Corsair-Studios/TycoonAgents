import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jimp from 'jimp';
import {
  createEnvironmentShapeGuide,
  ENVIRONMENT_ASSET_HEIGHT,
  ENVIRONMENT_ASSET_WIDTH,
  normalizeEnvironmentImage,
} from '../src/extension/environmentAsset';

test('environment shape guide is opaque and uses the target dimensions', async () => {
  const guide = await Jimp.read(await createEnvironmentShapeGuide());
  assert.equal(guide.bitmap.width, ENVIRONMENT_ASSET_WIDTH);
  assert.equal(guide.bitmap.height, ENVIRONMENT_ASSET_HEIGHT);
  let transparentPixels = 0;
  guide.scan(0, 0, guide.bitmap.width, guide.bitmap.height, function (_x, _y, idx) {
    if (this.bitmap.data[idx + 3] !== 255) transparentPixels++;
  });
  assert.equal(transparentPixels, 0);
});

test('environment normalization clips provider output to the stage silhouette', async () => {
  const source = new Jimp(1024, 1024, 0xff8844ff);
  const normalized = await Jimp.read(await normalizeEnvironmentImage(
    await source.getBufferAsync(Jimp.MIME_PNG),
  ));
  assert.equal(normalized.bitmap.width, ENVIRONMENT_ASSET_WIDTH);
  assert.equal(normalized.bitmap.height, ENVIRONMENT_ASSET_HEIGHT);
  assert.equal(Jimp.intToRGBA(normalized.getPixelColor(0, 0)).a, 0);
  assert.equal(Jimp.intToRGBA(normalized.getPixelColor(266, 375)).a, 255);
});
