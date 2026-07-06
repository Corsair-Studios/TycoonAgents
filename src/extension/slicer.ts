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
  /** Slots that must share one crop, scale, and anchor (for example one animation row). */
  normalizationGroups?: number[][];
  /**
   * Subset of normalizationGroups whose frames should be horizontally registered
   * against the group's first frame before the union bbox is computed. Cancels
   * drawn side-to-side drift in in-place animations (e.g. an idle sway drawn a
   * few pixels further left each frame). Groups of fewer than 2 cells are a
   * no-op. Vertical position is never adjusted — intentional bob/hop stays put.
   */
  registrationGroups?: number[][];
  /** Reassemble normalized slots into a reviewable magenta-backed sprite board. */
  rebuildBoard?: boolean;
  /** Keep the rebuilt review canvas square while preserving the requested grid. */
  squareReviewBoard?: boolean;
}

/** One sliced-and-cleaned grid cell, plus its opaque-content bounds. */
interface SliceCell {
  slot_id: number;
  cell: Jimp;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sumX: number;
  count: number;
}

/**
 * Slices a 5×4 sprite atlas into 20 normalized 128×128 PNG cells.
 *
 * For each cell:
 * - A border-connected flood fill keys away the magenta background through a
 *   tolerant range (isChromaMagenta: r≥180, b≥180, g≤90, r−g≥120, b−g≥120,
 *   |r−b|≤80), so imperfect pink backgrounds are removed from the outside in.
 * - A global strong-chroma pass (removeAllChromaMagenta) then clears EVERY pixel
 *   passing that same strict isChromaMagenta test, regardless of connectivity, so
 *   magenta fully enclosed by the sprite (gaps between legs/arms) is also removed.
 *   No true near-#FF00FF chroma survives anywhere in the cell.
 * - A follow-up de-fringe pass (defringeMagentaEdges) clears the anti-aliased
 *   magenta halo: still-opaque, magenta-dominant pixels that touch an
 *   already-transparent pixel are erased over a few iterations, so multi-pixel
 *   fringe is eaten without thresholding the whole cell.
 * - Frames listed in a `registrationGroups` entry are horizontally shifted (up
 *   to ±16px) to best match that group's first frame before the union bbox is
 *   computed, canceling drawn side-to-side drift across an in-place animation.
 *   Vertical position is never touched by this step.
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

  const cells: SliceCell[] = [];

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.columns; col++) {
      const slot_id = row * grid.columns + col;
      // Proportional boundaries cover the entire source even when a 512px
      // canvas cannot divide evenly by the requested row/column count.
      const left = Math.floor(col * atlas.bitmap.width / grid.columns);
      const right = Math.floor((col + 1) * atlas.bitmap.width / grid.columns);
      const top = Math.floor(row * atlas.bitmap.height / grid.rows);
      const bottom = Math.floor((row + 1) * atlas.bitmap.height / grid.rows);
      const cell = atlas.clone().crop(left, top, right - left, bottom - top);
      keyBorderConnectedMagenta(cell);
      removeAllChromaMagenta(cell);
      defringeMagentaEdges(cell);
      if (row > 0) {
        removeRowBoundarySpill(cell, cells[slot_id - grid.columns].cell);
      }
      if (col > 0) {
        removeColumnBoundarySpill(cell, cells[slot_id - 1].cell);
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

  // Cancel drawn horizontal drift within an in-place animation before any
  // union bbox is computed, so the group-crop/anchor logic below never bakes
  // the artist's side-to-side wobble into the shared frame.
  for (const group of grid.registrationGroups ?? []) {
    registerGroupHorizontally(cells, group);
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
  const groupedBounds = new Map<number, { minX: number; maxX: number; minY: number; maxY: number }>();
  for (const group of grid.normalizationGroups ?? []) {
    const members = group
      .map((slotId) => cells[slotId])
      .filter((cell): cell is typeof cells[number] => Boolean(cell?.count));
    if (!members.length) continue;
    const bounds = {
      minX: Math.min(...members.map((cell) => cell.minX)),
      maxX: Math.max(...members.map((cell) => cell.maxX)),
      minY: Math.min(...members.map((cell) => cell.minY)),
      maxY: Math.max(...members.map((cell) => cell.maxY)),
    };
    for (const slotId of group) groupedBounds.set(slotId, bounds);
  }
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
      const groupBounds = groupedBounds.get(cellInfo.slot_id);
      const minX = groupBounds?.minX ?? cellInfo.minX;
      const maxX = groupBounds?.maxX ?? cellInfo.maxX;
      const minY = groupBounds?.minY ?? cellInfo.minY;
      const maxY = groupBounds?.maxY ?? cellInfo.maxY;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const scale = Math.min(boardScale, maxContentExtent / bw, maxContentExtent / bh);
      const resizedWidth = Math.max(1, Math.round(bw * scale));
      const resizedHeight = Math.max(1, Math.round(bh * scale));
      // Grouped bounds (normalizationGroups) union minX/maxX/minY/maxY across every
      // member of the group so animation frames share one crop/scale. When the
      // source board doesn't divide evenly by column count (e.g. 512 / 5 columns),
      // sibling cells can be a pixel wider than this one, so the unioned bbox may
      // extend past this cell's own bitmap edge. Clamp the crop rectangle to this
      // cell's actual bounds so it never reads past its own pixel data, while
      // leaving bw/bh (used for scale/resize/centering above) untouched so grouped
      // frames keep a consistent size.
      const cropX = Math.min(minX, cellInfo.cell.bitmap.width - 1);
      const cropY = Math.min(minY, cellInfo.cell.bitmap.height - 1);
      const cropW = Math.min(bw, cellInfo.cell.bitmap.width - cropX);
      const cropH = Math.min(bh, cellInfo.cell.bitmap.height - cropY);
      const content = cellInfo.cell.clone().crop(cropX, cropY, cropW, cropH);
      if (resizedWidth !== bw || resizedHeight !== bh) {
        content.resize(resizedWidth, resizedHeight, Jimp.RESIZE_NEAREST_NEIGHBOR);
      }
      const centerOfMassOffset = (cellInfo.sumX / cellInfo.count - cellInfo.minX) * scale;
      const destX = groupBounds
        ? Math.round(64 - resizedWidth / 2)
        : Math.round(64 - centerOfMassOffset);
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

/** Pixels this dim or dimmer are treated as background, not sprite content, for registration. */
const REGISTRATION_OPAQUE_THRESHOLD = 16;
/** Widest drawn drift this mechanically corrects; wider mismatches are left alone. */
const REGISTRATION_MAX_SHIFT = 16;
/** Cost added per pixel where only one side (reference or candidate) is opaque. */
const REGISTRATION_MISMATCH_PENALTY = 255 * 3;

/**
 * Horizontally registers every other member of a normalization group against
 * the group's first (reference) cell, canceling side-to-side drift the artist
 * drew into an in-place animation before the group's union bbox is computed.
 * Groups of fewer than two populated cells are left untouched.
 */
function registerGroupHorizontally(cells: SliceCell[], group: number[]): void {
  const members = group
    .map((slotId) => cells[slotId])
    .filter((cell): cell is SliceCell => Boolean(cell?.count));
  if (members.length < 2) return;

  const reference = members[0];
  for (const member of members.slice(1)) {
    const dx = findBestHorizontalShift(reference.cell, member.cell);
    if (dx === 0) continue;
    shiftCellHorizontally(member.cell, dx);
    // The shift moved this cell's opaque content, so its cached bounds (used
    // by the group-union bbox and this cell's own centroid) must be redone.
    recomputeCellBounds(member);
  }
}

/**
 * Finds the integer horizontal shift dx (within ±REGISTRATION_MAX_SHIFT) that
 * best aligns `candidate`'s opaque content onto `reference`'s, by minimizing
 * summed absolute RGB difference over pixels opaque in both, with a fixed
 * penalty where only one side is opaque. Ties prefer the smaller |dx|, so an
 * already-aligned pair (dx=0) is never nudged for no reason.
 */
function findBestHorizontalShift(reference: Jimp, candidate: Jimp): number {
  const refData = reference.bitmap.data;
  const refWidth = reference.bitmap.width;
  const candData = candidate.bitmap.data;
  const candWidth = candidate.bitmap.width;
  const height = Math.min(reference.bitmap.height, candidate.bitmap.height);

  let bestDx = 0;
  let bestCost = Infinity;
  for (let dx = -REGISTRATION_MAX_SHIFT; dx <= REGISTRATION_MAX_SHIFT; dx++) {
    let cost = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < refWidth; x++) {
        const refIdx = (y * refWidth + x) * 4;
        const refOpaque = refData[refIdx + 3] > REGISTRATION_OPAQUE_THRESHOLD;
        // shifted candidate value at x came from the candidate's own (x - dx).
        const srcX = x - dx;
        const inBounds = srcX >= 0 && srcX < candWidth;
        const candIdx = inBounds ? (y * candWidth + srcX) * 4 : -1;
        const candOpaque = inBounds && candData[candIdx + 3] > REGISTRATION_OPAQUE_THRESHOLD;
        if (refOpaque && candOpaque) {
          cost += Math.abs(refData[refIdx] - candData[candIdx])
            + Math.abs(refData[refIdx + 1] - candData[candIdx + 1])
            + Math.abs(refData[refIdx + 2] - candData[candIdx + 2]);
        } else if (refOpaque !== candOpaque) {
          cost += REGISTRATION_MISMATCH_PENALTY;
        }
      }
    }
    if (cost < bestCost || (cost === bestCost && Math.abs(dx) < Math.abs(bestDx))) {
      bestCost = cost;
      bestDx = dx;
    }
  }
  return bestDx;
}

/**
 * Translates a cell's pixels horizontally by dx (positive = right), filling
 * every vacated column with transparency. Vertical position is untouched:
 * a pixel at (x, y) only ever moves to (x + dx, y).
 */
function shiftCellHorizontally(cell: Jimp, dx: number): void {
  if (dx === 0) return;
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  const source = Buffer.from(cell.bitmap.data);
  const dest = cell.bitmap.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const destIdx = (y * width + x) * 4;
      const srcX = x - dx;
      if (srcX >= 0 && srcX < width) {
        const srcIdx = (y * width + srcX) * 4;
        dest[destIdx] = source[srcIdx];
        dest[destIdx + 1] = source[srcIdx + 1];
        dest[destIdx + 2] = source[srcIdx + 2];
        dest[destIdx + 3] = source[srcIdx + 3];
      } else {
        dest[destIdx] = 0;
        dest[destIdx + 1] = 0;
        dest[destIdx + 2] = 0;
        dest[destIdx + 3] = 0;
      }
    }
  }
}

/** Rescans a cell's opaque-pixel bounds in place after its pixels were shifted. */
function recomputeCellBounds(cellInfo: SliceCell): void {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  let sumX = 0;
  let count = 0;
  const { cell } = cellInfo;
  cell.scan(0, 0, cell.bitmap.width, cell.bitmap.height, function (x: number, y: number, idx: number) {
    if (cell.bitmap.data[idx + 3] !== 0) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      count += 1;
    }
  });
  cellInfo.minX = minX;
  cellInfo.maxX = maxX;
  cellInfo.minY = minY;
  cellInfo.maxY = maxY;
  cellInfo.sumX = sumX;
  cellInfo.count = count;
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

/**
 * Global strong-chroma removal. keyBorderConnectedMagenta only reaches magenta
 * that flood-connects to the cell border, so a magenta region fully enclosed by
 * the sprite (gaps between legs/arms) survives. This pass makes EVERY pixel that
 * passes the strict isChromaMagenta test transparent — regardless of connectivity
 * or adjacency — so no true near-#FF00FF chroma remains anywhere in the cell.
 *
 * The strict test is used (not the looser isMagentaDominant) so legitimate pink,
 * purple, or skin art is never touched — only genuine chroma-key background.
 */
function removeAllChromaMagenta(cell: Jimp): void {
  const data = cell.bitmap.data;
  cell.scan(0, 0, cell.bitmap.width, cell.bitmap.height, function (_x: number, _y: number, idx: number) {
    if (data[idx + 3] === 0) return;
    if (isChromaMagenta(data[idx], data[idx + 1], data[idx + 2])) {
      data[idx + 3] = 0;
    }
  });
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
 * Looser than isChromaMagenta so anti-aliased boundary pixels — the pink/magenta
 * halo blended between sprite and background (e.g. rgb(150,40,200)) — are caught.
 * Green must sit well below both red and blue with roughly balanced red/blue,
 * which excludes normal skin, red, orange, and purple sprite colors.
 */
function isMagentaDominant(r: number, g: number, b: number): boolean {
  return g < r - 40
    && g < b - 40
    && r > 110
    && b > 110
    && Math.abs(r - b) < 110;
}

/**
 * De-fringe pass. After keyBorderConnectedMagenta has already made the solid
 * background transparent, a thin anti-aliased magenta halo can survive around
 * the sprite because its blended pixels fail the strict isChromaMagenta test.
 *
 * For a few bounded iterations, clear every still-opaque, magenta-dominant pixel
 * that is 8-neighbour adjacent to an already-transparent pixel. Re-evaluating
 * adjacency each iteration lets a multi-pixel-thick halo be eaten inward.
 *
 * Only pixels touching transparency are considered, so interior disconnected
 * magenta details (which are surrounded by opaque pixels) are never touched.
 */
function defringeMagentaEdges(cell: Jimp): void {
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  const data = cell.bitmap.data;
  const ITERATIONS = 3;

  for (let pass = 0; pass < ITERATIONS; pass++) {
    const toClear: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = y * width + x;
        const idx = offset * 4;
        if (data[idx + 3] === 0) continue; // already transparent
        if (!isMagentaDominant(data[idx], data[idx + 1], data[idx + 2])) continue;

        let touchesTransparent = false;
        for (let dy = -1; dy <= 1 && !touchesTransparent; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (data[(ny * width + nx) * 4 + 3] === 0) {
              touchesTransparent = true;
              break;
            }
          }
        }
        if (touchesTransparent) toClear.push(idx);
      }
    }
    if (toClear.length === 0) break;
    for (const idx of toClear) data[idx + 3] = 0;
  }
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
  if (width !== cellAbove.bitmap.width) return;

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let opaqueCount = 0;

  cell.scan(0, 0, width, height, function (_x: number, _y: number, idx: number) {
    if (cell.bitmap.data[idx + 3] !== 0) opaqueCount++;
  });
  if (opaqueCount === 0) return;

  const aboveBottomY = cellAbove.bitmap.height - 1;
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

/**
 * Image models sometimes let an extended weapon, build tool, or equipment from
 * one column cross sideways into the cell to its right. Once the atlas is sliced,
 * that overflow looks like a small, disconnected object clinging to the left edge
 * of the next cell and would otherwise be normalized along with the real sprite.
 *
 * The column-axis analog of removeRowBoundarySpill: remove only a minor
 * left-connected component that continues opaque pixels from the preceding
 * (left) cell's right edge. If the component is most of the current cell's
 * content, keep it: that is more likely a badly framed but recoverable sprite
 * than column-boundary debris.
 */
function removeColumnBoundarySpill(cell: Jimp, leftNeighbor: Jimp): void {
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  if (height !== leftNeighbor.bitmap.height) return;

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let opaqueCount = 0;

  cell.scan(0, 0, width, height, function (_x: number, _y: number, idx: number) {
    if (cell.bitmap.data[idx + 3] !== 0) opaqueCount++;
  });
  if (opaqueCount === 0) return;

  const leftWidth = leftNeighbor.bitmap.width;
  const leftRightX = leftWidth - 1;
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    if (cell.bitmap.data[offset * 4 + 3] === 0) continue;

    let continuesFromLeft = false;
    for (let dy = -2; dy <= 2; dy++) {
      const leftY = y + dy;
      if (leftY < 0 || leftY >= height) continue;
      const leftIdx = (leftY * leftWidth + leftRightX) * 4;
      if (leftNeighbor.bitmap.data[leftIdx + 3] !== 0) {
        continuesFromLeft = true;
        break;
      }
    }
    if (!continuesFromLeft) continue;

    visited[offset] = 1;
    queue.push(offset);
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

  // Never erase the primary subject if it happens to touch the cell's left edge.
  if (queue.length * 2 >= opaqueCount) return;
  for (const offset of queue) cell.bitmap.data[offset * 4 + 3] = 0;
}
