import Jimp from 'jimp';

/** Strict decimal-kilobyte ceiling so boards remain below 200 KB everywhere. */
export const MAX_SPRITE_BOARD_BYTES = 200_000;
export const MAX_SPRITE_BOARD_WIDTH = 640;
export const MAX_SPRITE_BOARD_HEIGHT = 512;
export const SPRITE_BOARD_CANVAS_SIZE = 512;

const POSTERIZE_LEVELS = [256, 128, 64, 32, 16];

/** Resize a retained review canvas to exact pixel dimensions without re-slicing it. */
export async function resizeSpriteBoardCanvas(
  imageBuffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  if (!Number.isInteger(width) || width <= 0
      || !Number.isInteger(height) || height <= 0) {
    throw new Error('Sprite board canvas dimensions must be positive integers.');
  }
  const image = await Jimp.read(imageBuffer);
  if (image.bitmap.width !== width || image.bitmap.height !== height) {
    image.resize(width, height, Jimp.RESIZE_NEAREST_NEIGHBOR);
  }
  return image
    .deflateLevel(9)
    .deflateStrategy(3)
    .filterType(Jimp.PNG_FILTER_AUTO)
    .getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Compress a generated grid board, then restore its retained/reviewed PNG to
 * the exact square production canvas. Compression may temporarily reduce the
 * raster dimensions; the final nearest-neighbor resize keeps the chroma key
 * crisp while ensuring all aggregate boards share one stable canvas contract.
 */
export async function optimizeSpriteBoardCanvas(
  imageBuffer: Buffer,
  gridColumns: number,
  gridRows: number,
): Promise<Buffer> {
  const optimized = await optimizeSpriteBoard(
    imageBuffer,
    undefined,
    gridColumns,
    gridRows,
  );
  return resizeSpriteBoardCanvas(
    optimized,
    SPRITE_BOARD_CANVAS_SIZE,
    SPRITE_BOARD_CANVAS_SIZE,
  );
}

/**
 * Downsample and PNG-compress a generated 5x4 sprite board.
 *
 * Candidates favor resolution and color fidelity first. If PNG compression and
 * palette reduction are not enough, dimensions are reduced until the encoded
 * bytes fit the requested ceiling. Nearest-neighbor resizing keeps the magenta
 * chroma-key exact and avoids introducing halos around sprite silhouettes.
 */
export async function optimizeSpriteBoard(
  imageBuffer: Buffer,
  maxBytes = MAX_SPRITE_BOARD_BYTES,
  gridColumns = 5,
  gridRows = 4,
): Promise<Buffer> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Sprite board byte limit must be a positive integer.');
  }
  if (!Number.isInteger(gridColumns) || gridColumns <= 0
      || !Number.isInteger(gridRows) || gridRows <= 0) {
    throw new Error('Sprite board grid dimensions must be positive integers.');
  }
  const image = await Jimp.read(imageBuffer);
  resizeToInitialBounds(image, gridColumns, gridRows);

  while (true) {
    let smallestCandidate: Buffer | undefined;

    for (const levels of POSTERIZE_LEVELS) {
      const candidateImage = image.clone();
      if (levels < 256) candidateImage.posterize(levels);

      const candidate = await candidateImage
        .deflateLevel(9)
        .deflateStrategy(3)
        .filterType(Jimp.PNG_FILTER_AUTO)
        .getBufferAsync(Jimp.MIME_PNG);

      if (!smallestCandidate || candidate.length < smallestCandidate.length) {
        smallestCandidate = candidate;
      }
      if (candidate.length < maxBytes) return candidate;
    }

    const sizeRatio = Math.sqrt(maxBytes / smallestCandidate!.length) * 0.92;
    const scale = Math.min(0.85, Math.max(0.5, sizeRatio));
    const nextWidth = alignToGrid(
      Math.floor(image.bitmap.width * scale),
      gridColumns,
    );
    const nextHeight = alignToGrid(
      Math.floor(image.bitmap.height * scale),
      gridRows,
    );

    if (nextWidth === image.bitmap.width && nextHeight === image.bitmap.height) {
      throw new Error(`Could not compress sprite board below ${maxBytes} bytes.`);
    }

    image.resize(nextWidth, nextHeight, Jimp.RESIZE_NEAREST_NEIGHBOR);
  }
}

function resizeToInitialBounds(
  image: Jimp,
  gridColumns: number,
  gridRows: number,
): void {
  const scale = Math.min(
    1,
    MAX_SPRITE_BOARD_WIDTH / image.bitmap.width,
    MAX_SPRITE_BOARD_HEIGHT / image.bitmap.height,
  );
  const width = alignToGrid(Math.floor(image.bitmap.width * scale), gridColumns);
  const height = alignToGrid(Math.floor(image.bitmap.height * scale), gridRows);

  if (width !== image.bitmap.width || height !== image.bitmap.height) {
    image.resize(width, height, Jimp.RESIZE_NEAREST_NEIGHBOR);
  }
}

function alignToGrid(value: number, gridSize: number): number {
  return Math.max(gridSize, Math.floor(value / gridSize) * gridSize);
}
