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
// EDGE_ERODE_PX = 10: an unconditional erosion band that erases anything
// within 10px of the boundary, regardless of color.
// CYAN_EDGE_BAND_PX = 24: from the erosion edge out to 24px from the
// boundary, pixels are additionally checked against a cyan-biased color
// detector (G>=150 && B>=150 && R<=G-35 && R<=B-35 && |G-B|<=20) that keys
// out pure cyan (0,255,255) and both the original light-blue floor/cyan
// blend (e.g. 105,217,197) and the brighter bottom-edge blend that slipped
// past the earlier stricter margins (e.g. 150,205,200), while sparing warm
// tan floor (R too high to clear the margin, e.g. 200,175,140), pale
// blue sky (R too high relative to G/B, e.g. 180,205,235), and saturated
// azure sky (R clears the margin but |G-B|>20, e.g. 160,200,230 — the
// CYAN_GB_MAX_DELTA tightening from 50 to 20 is what spares this case; it
// would have been incorrectly stripped under the old delta of 50).
//
// (267,10) sits ~6px inside the top vertex (267,4) — inside the polygon,
// and within the EDGE_ERODE_PX=10 band, so it is erased unconditionally
// regardless of color.
// (150,400) and (267,375) are deep interior points (>100px from the nearest
// edge), so cyan/opaque pixels there must survive untouched.
//
// The additional points below sit strictly OUTSIDE the 10px erosion band but
// INSIDE the 24px cyan band (distance ~12-15px from the boundary, verified
// via the same pointInPolygon/distanceToPolygonBoundary math as the
// implementation), so they exercise the color detector itself rather than
// the unconditional erosion:
//   (267,20)  dist ~14.2px from the top vertex — pure cyan, band-driven.
//   (267,730) dist ~15.1px from the bottom edges — bright light-blue blend case
//             (the reported bottom-edge line regression guard).
//   (142,666) dist ~15.0px from the bottom edges — warm tan floor case.
//   (195,693) dist ~15.2px from the bottom edges — pure cyan, band-driven.
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
  paintBlock(source, 267, 10, PURE_CYAN, 1); // just inside the top vertex, within the 10px erosion band.
  paintBlock(source, 267, 20, PURE_CYAN, 1); // ~14.2px from the top vertex: outside erosion, inside the 24px cyan band — exercises the color detector, not erosion.
  paintBlock(source, 267, 375, PURE_CYAN, 1); // dead-center of the stage, deep interior.

  const normalized = await Jimp.read(await normalizeEnvironmentImage(
    await source.getBufferAsync(Jimp.MIME_PNG),
  ));
  assert.equal(normalized.bitmap.width, ENVIRONMENT_ASSET_WIDTH);
  assert.equal(normalized.bitmap.height, ENVIRONMENT_ASSET_HEIGHT);

  // Pixel outside the stage polygon entirely: always transparent.
  assert.equal(Jimp.intToRGBA(normalized.getPixelColor(0, 0)).a, 0);

  // Near-edge cyan "outline" pixel within the unconditional erosion band: erased (alpha 0).
  const nearEdgeCyan = Jimp.intToRGBA(normalized.getPixelColor(267, 10));
  assert.equal(nearEdgeCyan.a, 0, 'a near-edge cyan pixel within the erosion band must be stripped');

  // Cyan pixel outside erosion but inside the wider cyan band: erased by the color detector itself.
  const bandCyan = Jimp.intToRGBA(normalized.getPixelColor(267, 20));
  assert.equal(bandCyan.a, 0, 'a cyan pixel within the cyan band (outside erosion) must be stripped by the color detector');

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
  const LIGHT_BLUE_BLEND = 0x96cdc8ff; // R=150,G=205,B=200 — the brighter bottom-edge tan-floor/cyan-guide blend reported by the user; must be stripped. |G-B|=5<=20, so the tightened delta does not weaken this fix.
  const TAN_FLOOR = 0xc8af8cff; // R=200,G=175,B=140 — legit bright floor; B<150 fails the cyan-bias check, must survive.
  const PALE_BLUE_SKY = 0xb4cdebff; // R=180,G=205,B=235 — legit sky; R too high to clear the margin, must survive.
  const AZURE_SKY = 0xa0c8e6ff; // R=160,G=200,B=230 — saturated azure sky; R DOES clear the margin (160<=200-35 and 160<=230-35), but |G-B|=30>20 spares it under the tightened CYAN_GB_MAX_DELTA. Regression guard: under the prior delta of 50 this pixel would have been incorrectly stripped.

  // Blocks use radius=2 (5x5), not the usual radius=1: Jimp's bicubic resize
  // is only exactly lossless for a same-size image once a painted block is
  // buffered by >=2px of its own color on every side (verified empirically —
  // a 3x3 block's center pixel comes back subtly blended with the
  // surrounding fill, e.g. (200,175,140) -> (192,179,149), even though the
  // resize dimensions are unchanged), which would make an exact-RGB
  // assertion flaky. A 5x5 block's center pixel is unaffected.
  const source = new Jimp(ENVIRONMENT_ASSET_WIDTH, ENVIRONMENT_ASSET_HEIGHT, OPAQUE_ORANGE);
  paintBlock(source, 267, 730, LIGHT_BLUE_BLEND, 2); // ~15.1px from the bottom edges: inside the cyan band, outside erosion.
  paintBlock(source, 142, 666, TAN_FLOOR, 2); // ~15.0px from the bottom edges: same band, must NOT be chewed.
  paintBlock(source, 195, 693, PURE_CYAN, 2); // ~15.2px from the bottom edges: pure cyan removed by the color detector, not erosion.
  paintBlock(source, 350, 60, PALE_BLUE_SKY, 2); // ~13px from the top-right edge: sky near the silhouette must NOT be chewed.
  paintBlock(source, 185, 60, AZURE_SKY, 2); // ~12.97px from the top-left edge (mirrors the 350,60 sky point): the tightened-delta regression guard — must NOT be chewed.

  const normalized = await Jimp.read(await normalizeEnvironmentImage(
    await source.getBufferAsync(Jimp.MIME_PNG),
  ));

  const lightBlueBlend = Jimp.intToRGBA(normalized.getPixelColor(267, 730));
  assert.equal(lightBlueBlend.a, 0, 'a bright light-blue floor/cyan blend within the 24px band must be stripped as a boundary artifact');

  const tanFloor = Jimp.intToRGBA(normalized.getPixelColor(142, 666));
  assert.equal(tanFloor.a, 255, 'warm tan floor near the edge must survive the cyan-bias detector');
  assert.equal(tanFloor.r, 200);
  assert.equal(tanFloor.g, 175);
  assert.equal(tanFloor.b, 140);

  const pureCyanNearEdge = Jimp.intToRGBA(normalized.getPixelColor(195, 693));
  assert.equal(pureCyanNearEdge.a, 0, 'pure cyan within the cyan band (outside the erosion band) must be stripped by the color detector');

  const paleSky = Jimp.intToRGBA(normalized.getPixelColor(350, 60));
  assert.equal(paleSky.a, 255, 'pale blue sky near the top silhouette edge must survive the cyan-bias detector');
  assert.equal(paleSky.r, 180);
  assert.equal(paleSky.g, 205);
  assert.equal(paleSky.b, 235);

  // Regression guard for the CYAN_GB_MAX_DELTA 50->20 tightening: azure sky
  // clears the R margin (unlike PALE_BLUE_SKY above) but has |G-B|=30>20,
  // so it must be spared by the delta gate specifically. Under the old
  // delta of 50 this pixel would have been incorrectly stripped.
  const azureSky = Jimp.intToRGBA(normalized.getPixelColor(185, 60));
  assert.equal(azureSky.a, 255, 'azure sky (R clears the margin, |G-B|=30>20) must survive the tightened cyan-bias delta');
  assert.equal(azureSky.r, 160);
  assert.equal(azureSky.g, 200);
  assert.equal(azureSky.b, 230);
});
