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
 * fringe the provider may leave behind along the edge.
 */
const EDGE_ERODE_PX = 3;

/**
 * Width of the boundary band (in pixels, measured inward from the
 * silhouette edge) within which near-cyan pixels are treated as an
 * unwanted outline artifact and erased. Kept narrow so legitimate
 * cyan/teal art deeper in the interior (e.g. a blue fountain) is not
 * erased.
 */
const CYAN_EDGE_BAND_PX = 14;

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
      if (r <= 60 && g >= 180 && b >= 180) {
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
