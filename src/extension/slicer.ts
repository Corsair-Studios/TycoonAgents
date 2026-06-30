import Jimp from 'jimp';
import type { ThemeManifest } from '../shared/types';

export interface NormalizedAtlasPackage {
  manifest: Partial<ThemeManifest>;
  cell_width: number;
  cell_height: number;
  slots: Array<{ slot_id: number; data: string; meta: FrameContentMeta }>;
  board?: Buffer;
}

export interface FrameContentMeta {
  centroidX: number;   // center-of-mass x (alpha>0 pixels) within the 128x128 frame; -1 if frame empty
  footY: number;       // largest y containing any opaque pixel (the foot line); -1 if empty
  topY: number;        // smallest y containing any opaque pixel; -1 if empty
  left: number;        // smallest x with an opaque pixel; -1 if empty
  right: number;       // largest x with an opaque pixel; -1 if empty
  opaqueCount: number; // count of pixels with alpha>0; 0 if empty
}

/**
 * Measures the opaque (alpha>0) content of a normalized frame.
 *
 * Used to verify that emitted frames share a consistent horizontal center
 * (centroidX) and foot line (footY) after normalization.
 *
 * @param image - A Jimp image (typically the normalized 128×128 frame).
 * @returns FrameContentMeta describing the opaque-pixel bounds and centroid.
 */
export function measureFrameContent(image: Jimp): FrameContentMeta {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  let sumX = 0;
  let count = 0;

  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x: number, y: number, idx: number) {
    if (image.bitmap.data[idx + 3] > 0) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      count += 1;
    }
  });

  if (count === 0) {
    return { centroidX: -1, footY: -1, topY: -1, left: -1, right: -1, opaqueCount: 0 };
  }
  return { centroidX: sumX / count, footY: maxY, topY: minY, left: minX, right: maxX, opaqueCount: count };
}

export interface AtlasGrid {
  columns: number;
  rows: number;
  /** Normalize every slot with one scale derived from these zero-based slots. */
  scaleReferenceSlots?: number[];
  /** Desired opaque-content height for the median reference slot. */
  targetContentHeight?: number;
  /** Per-slot safety cap that prevents unusually wide poses from being clipped. */
  maxContentExtent?: number;
  /** Reassemble normalized slots into a reviewable magenta-backed sprite board. */
  rebuildBoard?: boolean;
  /** Keep the rebuilt review canvas square while preserving the requested grid. */
  squareReviewBoard?: boolean;
}

/**
 * Slices a 5×4 sprite atlas into 20 normalized 128×128 PNG cells.
 *
 * For each cell:
 * - Magenta pixels (r≥250, g≤10, b≥250) are chroma-keyed to transparent.
 * - Content is horizontally centered using center-of-mass of opaque pixels.
 * - Content is bottom-justified within the 128×128 output canvas.
 * - Empty cells (all magenta/transparent) produce a blank transparent 128×128 image.
 *
 * @param imageBuffer - Raw image bytes of the sprite atlas.
 * @param manifest    - Partial theme manifest; returned unchanged in the result.
 * @returns NormalizedAtlasPackage with 128×128 base64 PNG data URIs for each slot.
 */
export async function sliceAndNormalizeAtlas(
  imageBuffer: Buffer,
  manifest: Partial<ThemeManifest>,
  grid: AtlasGrid = { columns: 5, rows: 4 },
): Promise<NormalizedAtlasPackage> {
  if (!Number.isInteger(grid.columns) || grid.columns <= 0
      || !Number.isInteger(grid.rows) || grid.rows <= 0) {
    throw new Error('Sprite board grid dimensions must be positive integers.');
  }
  const atlas = await Jimp.read(imageBuffer);
  const cellW = Math.floor(atlas.bitmap.width / grid.columns);
  const cellH = Math.floor(atlas.bitmap.height / grid.rows);

  const cells: Array<{
    slot_id: number;
    cell: Jimp;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    sumX: number;
    count: number;
  }> = [];

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.columns; col++) {
      const slot_id = row * grid.columns + col;

      const cell = atlas.clone().crop(col * cellW, row * cellH, cellW, cellH);
      keyBorderConnectedMagenta(cell);
      if (row > 0) {
        removeRowBoundarySpill(cell, cells[slot_id - grid.columns].cell);
      }

      let minX = Infinity;
      let maxX = -1;
      let minY = Infinity;
      let maxY = -1;
      let sumX = 0;
      let count = 0;

      cell.scan(0, 0, cell.bitmap.width, cell.bitmap.height, function (x: number, y: number, idx: number) {
        // Content pixel (alpha not 0 after border-connected chroma keying)
        if (cell.bitmap.data[idx + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          sumX += x;
          count += 1;
        }
      });

      cells.push({ slot_id, cell, minX, maxX, minY, maxY, sumX, count });
    }
  }

  const referenceHeights = (grid.scaleReferenceSlots ?? [])
    .map((slotId) => cells[slotId])
    .filter((cell): cell is typeof cells[number] => Boolean(cell?.count))
    .map((cell) => cell.maxY - cell.minY + 1)
    .sort((a, b) => a - b);
  const medianReferenceHeight = referenceHeights.length
    ? referenceHeights[Math.floor(referenceHeights.length / 2)]
    : undefined;
  const boardScale = grid.targetContentHeight && medianReferenceHeight
    ? grid.targetContentHeight / medianReferenceHeight
    : 1;
  const maxContentExtent = grid.maxContentExtent ?? Number.POSITIVE_INFINITY;
  const slots: Array<{ slot_id: number; data: string; meta: FrameContentMeta }> = [];
  const rebuiltBoardWidth = grid.columns * 128;
  const rebuiltBoardHeight = grid.squareReviewBoard
    ? rebuiltBoardWidth
    : grid.rows * 128;
  if (grid.squareReviewBoard && rebuiltBoardHeight % grid.rows !== 0) {
    throw new Error('Square review board height must divide evenly across its rows.');
  }
  const rebuiltCellHeight = rebuiltBoardHeight / grid.rows;
  const rebuiltBoard = grid.rebuildBoard
    ? new Jimp(rebuiltBoardWidth, rebuiltBoardHeight, 0xff00ffff)
    : undefined;

  for (const cellInfo of cells) {
    const out = new Jimp(128, 128, 0x00000000);
    if (cellInfo.count > 0) {
      const bw = cellInfo.maxX - cellInfo.minX + 1;
      const bh = cellInfo.maxY - cellInfo.minY + 1;
      const scale = Math.min(boardScale, maxContentExtent / bw, maxContentExtent / bh);
      const resizedWidth = Math.max(1, Math.round(bw * scale));
      const resizedHeight = Math.max(1, Math.round(bh * scale));
      const content = cellInfo.cell.clone().crop(cellInfo.minX, cellInfo.minY, bw, bh);
      if (resizedWidth !== bw || resizedHeight !== bh) {
        content.resize(resizedWidth, resizedHeight, Jimp.RESIZE_NEAREST_NEIGHBOR);
      }
      const centerOfMassOffset = (cellInfo.sumX / cellInfo.count - cellInfo.minX) * scale;
      const destX = Math.round(64 - centerOfMassOffset);
      const destY = 128 - resizedHeight;
      out.composite(content, destX, destY);
    }

    const meta = measureFrameContent(out);
    const pngBuf = await out.getBufferAsync(Jimp.MIME_PNG);
    slots.push({ slot_id: cellInfo.slot_id, data: 'data:image/png;base64,' + pngBuf.toString('base64'), meta });
    if (rebuiltBoard) {
      rebuiltBoard.composite(
        out,
        (cellInfo.slot_id % grid.columns) * 128,
        Math.floor(cellInfo.slot_id / grid.columns) * rebuiltCellHeight
          + Math.floor((rebuiltCellHeight - 128) / 2),
      );
    }
  }

  return {
    manifest,
    cell_width: 128,
    cell_height: 128,
    slots,
    board: rebuiltBoard ? await rebuiltBoard.getBufferAsync(Jimp.MIME_PNG) : undefined,
  };
}

/**
 * Models rarely emit mathematically exact #FF00FF. Flood from the cell border
 * through a tolerant magenta range so pink background variation is removed,
 * while disconnected magenta details inside the sprite remain opaque.
 */
function keyBorderConnectedMagenta(cell: Jimp): void {
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * width + x;
    if (visited[offset]) return;
    const idx = offset * 4;
    if (!isChromaMagenta(cell.bitmap.data[idx], cell.bitmap.data[idx + 1], cell.bitmap.data[idx + 2])) return;
    visited[offset] = 1;
    queue.push(offset);
  };

  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const offset = queue[cursor];
    const x = offset % width;
    const y = Math.floor(offset / width);
    cell.bitmap.data[offset * 4 + 3] = 0;
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }
}

function isChromaMagenta(r: number, g: number, b: number): boolean {
  return r >= 180
    && b >= 180
    && g <= 90
    && r - g >= 120
    && b - g >= 120
    && Math.abs(r - b) <= 80;
}

/**
 * Image models sometimes let the feet or equipment from one row cross into
 * the row below. Once the atlas is sliced, that overflow looks like a small,
 * disconnected object at the top of the next cell and would otherwise be
 * normalized along with the real sprite.
 *
 * Remove only a minor top-connected component that continues opaque pixels
 * from the preceding cell. If the component is most of the current cell's
 * content, keep it: that is more likely a badly framed but recoverable sprite
 * than row-boundary debris.
 */
function removeRowBoundarySpill(cell: Jimp, cellAbove: Jimp): void {
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  if (width !== cellAbove.bitmap.width || height !== cellAbove.bitmap.height) return;

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let opaqueCount = 0;

  cell.scan(0, 0, width, height, function (_x: number, _y: number, idx: number) {
    if (cell.bitmap.data[idx + 3] !== 0) opaqueCount++;
  });
  if (opaqueCount === 0) return;

  const aboveBottomY = height - 1;
  for (let x = 0; x < width; x++) {
    if (cell.bitmap.data[x * 4 + 3] === 0) continue;

    let continuesFromAbove = false;
    for (let dx = -2; dx <= 2; dx++) {
      const aboveX = x + dx;
      if (aboveX < 0 || aboveX >= width) continue;
      const aboveIdx = (aboveBottomY * width + aboveX) * 4;
      if (cellAbove.bitmap.data[aboveIdx + 3] !== 0) {
        continuesFromAbove = true;
        break;
      }
    }
    if (!continuesFromAbove) continue;

    visited[x] = 1;
    queue.push(x);
  }
  if (queue.length === 0) return;

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const offset = queue[cursor];
    const x = offset % width;
    for (const neighbor of [offset - 1, offset + 1, offset - width, offset + width]) {
      if (neighbor < 0 || neighbor >= width * height || visited[neighbor]) continue;
      const neighborX = neighbor % width;
      if (Math.abs(neighborX - x) > 1) continue;
      if (cell.bitmap.data[neighbor * 4 + 3] === 0) continue;
      visited[neighbor] = 1;
      queue.push(neighbor);
    }
  }

  // Never erase the primary subject if it happens to touch the cell's top.
  if (queue.length * 2 >= opaqueCount) return;
  for (const offset of queue) cell.bitmap.data[offset * 4 + 3] = 0;
}
