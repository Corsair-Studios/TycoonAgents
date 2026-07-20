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

// --- Boundary-line / edge-cyan stripping ---------------------------------
//
// STAGE_POLYGON (native 533x751 output space, matching ENVIRONMENT_ASSET_*):
//   [[267,4],[529,135],[529,611],[267,747],[4,612],[4,137]]
//
// (267,10) sits ~5.4px inside the top vertex (267,4) along the polygon's
// vertical axis of symmetry — inside the polygon, past the unconditional
// EDGE_ERODE_PX=3 erosion band, but still within the CYAN_EDGE_BAND_PX=14
// rim-stripping band, so a cyan pixel placed there is boundary-outline
// artifact and must be erased. (150,400) and (267,375) are both deep
// interior points (>100px from the nearest edge), so cyan/opaque pixels
// there must survive untouched.
function paintBlock(image: Jimp, cx: number, cy: number, colorHex: number, radius = 1): void {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      image.setPixelColor(colorHex, cx + dx, cy + dy);
    }
  }
}

test('environment normalization strips a near-pure-cyan boundary-outline rim close to the silhouette edge, but leaves interior cyan and opaque art untouched', async () => {
  const OPAQUE_ORANGE = 0xff8844ff; // R=0xff,G=0x88,B=0x44 — not cyan, so untouched wherever inside the silhouette.
  const PURE_CYAN = 0x00ffffff; // R=0x00,G=0xff,B=0xff — the outline color the new rule strips near the edge.

  const source = new Jimp(ENVIRONMENT_ASSET_WIDTH, ENVIRONMENT_ASSET_HEIGHT, OPAQUE_ORANGE);
  paintBlock(source, 267, 10, PURE_CYAN, 1); // just inside the top vertex, within the 14px cyan-edge band.
  paintBlock(source, 267, 375, PURE_CYAN, 1); // dead-center of the stage, deep interior.

  const normalized = await Jimp.read(await normalizeEnvironmentImage(
    await source.getBufferAsync(Jimp.MIME_PNG),
  ));
  assert.equal(normalized.bitmap.width, ENVIRONMENT_ASSET_WIDTH);
  assert.equal(normalized.bitmap.height, ENVIRONMENT_ASSET_HEIGHT);

  // Pixel outside the stage polygon entirely: always transparent.
  assert.equal(Jimp.intToRGBA(normalized.getPixelColor(0, 0)).a, 0);

  // Near-edge cyan "outline" pixel: erased (alpha 0) by the boundary-cyan rule.
  const nearEdgeCyan = Jimp.intToRGBA(normalized.getPixelColor(267, 10));
  assert.equal(nearEdgeCyan.a, 0, 'a near-edge cyan pixel within the 14px band must be stripped as boundary-outline artifact');

  // Deep-interior cyan pixel: untouched (the band restriction protects interior art such as a blue fountain).
  const interiorCyan = Jimp.intToRGBA(normalized.getPixelColor(267, 375));
  assert.equal(interiorCyan.a, 255, 'deep-interior cyan pixels must survive — only the boundary rim is stripped');
  assert.equal(interiorCyan.r, 0);
  assert.equal(interiorCyan.g, 255);
  assert.equal(interiorCyan.b, 255);

  // Normal opaque non-cyan pixel deep in the interior: stays fully opaque and unmodified.
  const interiorOpaque = Jimp.intToRGBA(normalized.getPixelColor(150, 400));
  assert.equal(interiorOpaque.a, 255);
  assert.equal(interiorOpaque.r, 0xff);
  assert.equal(interiorOpaque.g, 0x88);
  assert.equal(interiorOpaque.b, 0x44);
});
