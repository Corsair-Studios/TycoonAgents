import Jimp from 'jimp';

export const ENVIRONMENT_ASSET_WIDTH = 533;
export const ENVIRONMENT_ASSET_HEIGHT = 751;

const STAGE_POLYGON: Array<[number, number]> = [
  [267, 4],
  [529, 135],
  [529, 611],
  [267, 747],
  [4, 612],
  [4, 137],
];

/**
 * Pixels this close (in any direction) to the silhouette boundary are erased
 * even if they lie inside the polygon, to remove sub-pixel anti-aliased
 * fringe the provider may leave behind along the edge. This is the
 * color-agnostic primary fix: a guaranteed trim of the immediate boundary
 * fringe on every edge, regardless of what color it blended to. Outside the
 * polygon is already transparent, and the environment prompt already tells
 * the art to bleed slightly past the edge, so a slightly thicker margin
 * here is harmless.
 */
const EDGE_ERODE_PX = 10;

/**
 * Width of the boundary band (in pixels, measured inward from the
 * silhouette edge) within which cyan-biased pixels are treated as an
 * unwanted outline artifact and erased. Kept narrow so legitimate
 * cyan/teal art deeper in the interior (e.g. a blue fountain at the
 * center, ~250px from any edge) is not erased.
 */
const CYAN_EDGE_BAND_PX = 24;

/**
 * Cyan-bias thresholds used within CYAN_EDGE_BAND_PX to key out the light
 * outline left where the tan floor blends into the cyan (#00FFFF) exterior
 * guide color through the bicubic resize. Pure cyan is (0,255,255); the
 * blend lightens toward tan by lifting R while G and B stay high and close
 * to each other. So a pixel is treated as cyan-biased when both G and B are
 * high AND R sits well below both AND G/B are close together:
 *   - G >= CYAN_MIN_GB && B >= CYAN_MIN_GB
 *   - R <= G - CYAN_R_MARGIN && R <= B - CYAN_R_MARGIN
 *   - |G - B| <= CYAN_GB_MAX_DELTA
 * This catches pure cyan (0,255,255) and floor/cyan blends like
 * (105,217,197), but spares warm tan floor (R high, e.g. (200,175,140) -
 * fails the R margin check) and grey stone (R close to G/B - fails the R
 * margin check).
 *
 * The BOTTOM edges of the silhouette produce a brighter floor+cyan blend
 * than the original near-pure-cyan estimate assumed (the bright tan floor
 * lifts R further than expected while G/B stay high and close together,
 * e.g. (150,205,200)), which slipped past the original stricter margins.
 * The relaxed CYAN_MIN_GB/CYAN_R_MARGIN below still clear that blend
 * (150<=205-35=170 and 150<=200-35=165) and warm tan floor stays spared
 * (200,175,140: fails both the B>=150 and R<=G-35 checks) — but relaxing
 * R_MARGIN alone is not enough to keep pale blue SKY near the top edges
 * safe, since saturated azure sky (e.g. (160,200,230)) also satisfies the
 * R margin check. The distinguishing signal is G vs. B: true cyan/floor
 * blends are G≈B (green and blue channels close together), while sky is
 * blue-DOMINANT (B noticeably greater than G). CYAN_GB_MAX_DELTA is kept
 * tight at 20 specifically to gate on this: the bottom blend (150,205,200)
 * has |G-B|=5<=20 and is still cleared, pure cyan (0,255,255) has
 * |G-B|=0<=20 and is cleared, but azure sky (160,200,230) has |G-B|=30>20
 * and (155,195,225) has |G-B|=30>20 — both spared.
 */
const CYAN_MIN_GB = 150;
const CYAN_R_MARGIN = 35;
const CYAN_GB_MAX_DELTA = 20;

/**
 * Produces an opaque, high-contrast guide so image models cannot silently
 * discard transparent padding while interpreting the target silhouette.
 */
export async function createEnvironmentShapeGuide(): Promise<Buffer> {
  const guide = new Jimp(ENVIRONMENT_ASSET_WIDTH, ENVIRONMENT_ASSET_HEIGHT, 0x00ffffff);
  guide.scan(0, 0, guide.bitmap.width, guide.bitmap.height, function (x, y, idx) {
    const inside = pointInPolygon(x, y, STAGE_POLYGON);
    const color = inside ? [126, 48, 190] : [0, 255, 255];
    this.bitmap.data[idx] = color[0];
    this.bitmap.data[idx + 1] = color[1];
    this.bitmap.data[idx + 2] = color[2];
    this.bitmap.data[idx + 3] = 255;
  });
  return guide.getBufferAsync(Jimp.MIME_PNG);
}

/** Resize provider output to the runtime contract and enforce transparency. */
export async function normalizeEnvironmentImage(imageBuffer: Buffer): Promise<Buffer> {
  const image = await Jimp.read(imageBuffer);
  image.resize(ENVIRONMENT_ASSET_WIDTH, ENVIRONMENT_ASSET_HEIGHT, Jimp.RESIZE_BICUBIC);
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
    if (!pointInPolygon(x, y, STAGE_POLYGON)) {
      this.bitmap.data[idx + 3] = 0;
      return;
    }
    // Inside the silhouette: erode a thin fringe along the boundary to
    // remove sub-pixel anti-aliasing, and within a slightly wider band,
    // strip any leftover near-cyan outline the provider painted along the
    // silhouette edge. Cyan/teal art deeper in the interior is untouched.
    const distanceToEdge = distanceToPolygonBoundary(x, y, STAGE_POLYGON);
    if (distanceToEdge <= EDGE_ERODE_PX) {
      this.bitmap.data[idx + 3] = 0;
      return;
    }
    if (distanceToEdge <= CYAN_EDGE_BAND_PX) {
      const r = this.bitmap.data[idx];
      const g = this.bitmap.data[idx + 1];
      const b = this.bitmap.data[idx + 2];
      const isCyanBiased =
        g >= CYAN_MIN_GB &&
        b >= CYAN_MIN_GB &&
        r <= g - CYAN_R_MARGIN &&
        r <= b - CYAN_R_MARGIN &&
        Math.abs(g - b) <= CYAN_GB_MAX_DELTA;
      if (isCyanBiased) {
        this.bitmap.data[idx + 3] = 0;
      }
    }
  });
  return image.getBufferAsync(Jimp.MIME_PNG);
}

function pointInPolygon(x: number, y: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = ((yi > y) !== (yj > y))
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Shortest distance from point (px, py) to the segment (x1,y1)-(x2,y2). */
function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;
  return Math.hypot(px - closestX, py - closestY);
}

/** Shortest distance from point (x, y) to the polygon's boundary edges. */
function distanceToPolygonBoundary(x: number, y: number, points: Array<[number, number]>): number {
  let minDistance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const distance = distanceToSegment(x, y, xj, yj, xi, yi);
    if (distance < minDistance) minDistance = distance;
  }
  return minDistance;
}
