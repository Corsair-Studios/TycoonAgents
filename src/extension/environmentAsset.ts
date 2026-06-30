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
