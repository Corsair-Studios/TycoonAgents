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
// EDGE_ERODE_PX = 6: an unconditional erosion band that erases anything
// within 6px of the boundary, regardless of color.
// CYAN_EDGE_BAND_PX = 18: from the erosion edge out to 18px from the
// boundary, pixels are additionally checked against a cyan-biased color
// detector (G>=160 && B>=160 && R<=G-50 && R<=B-50 && |G-B|<=45) that keys
// out both pure cyan (0,255,255) and light-blue floor/cyan blends (e.g.
// 105,217,197), while sparing warm tan floor (R too high to clear the
// margin, e.g. 200,175,140) and pale blue sky (R too high relative to G/B,
// e.g. 180,205,235).
//
// (267,10) sits ~5.4px inside the top vertex (267,4) — inside the polygon,
// and now within the widened EDGE_ERODE_PX=6 band, so it is erased
// unconditionally (previously, at EDGE_ERODE_PX=3, it was the color
// detector's job; the assertion still holds either way).
// (150,400) and (267,375) are deep interior points (>100px from the nearest
// edge), so cyan/opaque pixels there must survive untouched.
//
// The additional points below sit strictly OUTSIDE the 6px erosion band but
// INSIDE the 18px cyan band (distance ~10-15px from the boundary, verified
// via the same pointInPolygon/distanceToPolygonBoundary math as the
// implementation), so they exercise the color detector itself rather than
// the unconditional erosion:
//   (267,730) dist ~15.1px from the bottom edges — light-blue blend case.
//   (140,670) dist ~10.5px from the bottom edges — warm tan floor case.
//   (200,700) dist ~11.2px from the bottom edges — pure cyan, band-driven.
//   (350,60)  dist ~13.0px from the top-right edge — pale blue sky case.
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
  paintBlock(source, 267, 10, PURE_CYAN, 1); // just inside the top vertex, within the 6px erosion band.
  paintBlock(source, 267, 375, PURE_CYAN, 1); // dead-center of the stage, deep interior.

  const normalized = await Jimp.read(await normalizeEnvironmentImage(
    await source.getBufferAsync(Jimp.MIME_PNG),
  ));
  assert.equal(normalized.bitmap.width, ENVIRONMENT_ASSET_WIDTH);
  assert.equal(normalized.bitmap.height, ENVIRONMENT_ASSET_HEIGHT);

  // Pixel outside the stage polygon entirely: always transparent.
  assert.equal(Jimp.intToRGBA(normalized.getPixelColor(0, 0)).a, 0);

  // Near-edge cyan "outline" pixel: erased (alpha 0) by the erosion/boundary-cyan rules.
  const nearEdgeCyan = Jimp.intToRGBA(normalized.getPixelColor(267, 10));
  assert.equal(nearEdgeCyan.a, 0, 'a near-edge cyan pixel within the boundary bands must be stripped as boundary-outline artifact');

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

test('environment normalization cyan-biased detector strips light-blue floor/cyan blends and pure cyan near an edge, but spares warm tan floor and pale blue sky', async () => {
  const OPAQUE_ORANGE = 0xff8844ff;
  const PURE_CYAN = 0x00ffffff;
  const LIGHT_BLUE_BLEND = 0x69d9c5ff; // R=105,G=217,B=197 — a tan-floor/cyan-guide blend; must be stripped.
  const TAN_FLOOR = 0xc8af8cff; // R=200,G=175,B=140 — legit bright floor; B<160 fails the cyan-bias check, must survive.
  const PALE_BLUE_SKY = 0xb4cdebff; // R=180,G=205,B=235 — legit sky; R too high to clear the margin, must survive.

  // Blocks use radius=2 (5x5), not the usual radius=1: Jimp's bicubic resize
  // is only exactly lossless for a same-size image once a painted block is
  // buffered by >=2px of its own color on every side (verified empirically —
  // a 3x3 block's center pixel comes back subtly blended with the
  // surrounding fill, e.g. (200,175,140) -> (192,179,149), even though the
  // resize dimensions are unchanged), which would make an exact-RGB
  // assertion flaky. A 5x5 block's center pixel is unaffected.
  const source = new Jimp(ENVIRONMENT_ASSET_WIDTH, ENVIRONMENT_ASSET_HEIGHT, OPAQUE_ORANGE);
  paintBlock(source, 267, 730, LIGHT_BLUE_BLEND, 2); // ~15px from the bottom edges: inside the cyan band, outside erosion.
  paintBlock(source, 140, 670, TAN_FLOOR, 2); // ~10.5px from the bottom edges: same band, must NOT be chewed.
  paintBlock(source, 200, 700, PURE_CYAN, 2); // ~11.2px from the bottom edges: pure cyan removed by the color detector, not erosion.
  paintBlock(source, 350, 60, PALE_BLUE_SKY, 2); // ~13px from the top-right edge: sky near the silhouette must NOT be chewed.

  const normalized = await Jimp.read(await normalizeEnvironmentImage(
    await source.getBufferAsync(Jimp.MIME_PNG),
  ));

  const lightBlueBlend = Jimp.intToRGBA(normalized.getPixelColor(267, 730));
  assert.equal(lightBlueBlend.a, 0, 'a light-blue floor/cyan blend within the 18px band must be stripped as a boundary artifact');

  const tanFloor = Jimp.intToRGBA(normalized.getPixelColor(140, 670));
  assert.equal(tanFloor.a, 255, 'warm tan floor near the edge must survive the cyan-bias detector');
  assert.equal(tanFloor.r, 200);
  assert.equal(tanFloor.g, 175);
  assert.equal(tanFloor.b, 140);

  const pureCyanNearEdge = Jimp.intToRGBA(normalized.getPixelColor(200, 700));
  assert.equal(pureCyanNearEdge.a, 0, 'pure cyan within the cyan band (outside the erosion band) must be stripped by the color detector');

  const paleSky = Jimp.intToRGBA(normalized.getPixelColor(350, 60));
  assert.equal(paleSky.a, 255, 'pale blue sky near the top silhouette edge must survive the cyan-bias detector');
  assert.equal(paleSky.r, 180);
  assert.equal(paleSky.g, 205);
  assert.equal(paleSky.b, 235);
});
