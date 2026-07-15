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
  /**
   * Align registration by silhouette overlap only (ignore per-pixel brightness)
   * — for in-place lighting animations where RGB-based matching gets fooled by
   * the lighting change; characters keep RGB matching.
   */
  registrationShapeOnly?: boolean;
  /**
   * Characters/rivals only. Trims thin content trailing BELOW the feet (e.g. a
   * cape drag) from the content bbox bottom so the cell scales + bottom-justifies
   * to the FEET, not the cape tip. A bottom row counts as 'feet' only if its
   * opaque-pixel count is >= this ratio of the densest row's count. Ignored when unset.
   */
  feetAnchorMinWidthRatio?: number;
  /**
   * When true, horizontal content overflow clips at the frame edge instead of
   * shrinking the cell/clip; height still caps to protect head/feet — used for
   * character boards so all poses stay the same size.
   */
  clipWidthOverflow?: boolean;
  /**
   * When true, clamps the board-wide boardScale so it is never greater than 1
   * -- content is never enlarged beyond its native source-crop size, only ever
   * shrunk. Prevents nearest-neighbor upscaling artifacts on small drawn
   * content. Per-cell caps (maxContentExtent, 128px) are unaffected.
   */
  noUpscale?: boolean;
  /**
   * Buildable-object boards ONLY. When true, cell resizing uses bicubic
   * (smooth) interpolation instead of nearest-neighbor, and any transparent
   * background pixel has its RGB neutralized to black immediately beforehand
   * (see neutralizeTransparentToBlack) so bicubic blending can't pull leftover
   * chroma-magenta color into opaque edge pixels. Reduced interior crispness
   * is an accepted tradeoff for smoother object silhouettes; characters,
   * rivals, decor, environment, expression, and achievement boards must never
   * set this.
   */
  smoothResize?: boolean;
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
 * - A despill pass (despillMagentaEdges) then handles the fringe that survives
 *   all of the above: a faint magenta tint blended over a DARK subject pixel
 *   (e.g. the art style's black outlines) is too low-luminance to trip the
 *   magenta-dominant erase pass, but still reads as a visible purple halo.
 *   Any opaque pixel within 2px of transparency whose red and blue channels
 *   both spill clearly above green is desaturated toward green (or, for an
 *   extreme spill, made transparent) instead of erased outright, so the
 *   silhouette is never thinned.
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
  let atlas = await Jimp.read(imageBuffer);

  // Some image models (e.g. nano-banana/Gemini) wrap the whole sheet in a solid
  // NON-background border (typically black). Because the grid is cut at fixed
  // proportional offsets, that border shifts every cell. Peel any uniform outer
  // frame off first, stopping exactly at the magenta padding, so the grid math
  // below sees the same sheet it would have without the frame. Plain magenta
  // padding is never trimmed, so a well-formed sheet gets zero trim (no change).
  const frameInset = detectOuterFrame(atlas, isChromaMagenta, {
    minRegionWidth: grid.columns * 4,
    minRegionHeight: grid.rows * 4,
  });
  if (frameInset.top || frameInset.left || frameInset.right || frameInset.bottom) {
    const fw = atlas.bitmap.width;
    const fh = atlas.bitmap.height;
    atlas = atlas.clone().crop(
      frameInset.left,
      frameInset.top,
      fw - frameInset.left - frameInset.right,
      fh - frameInset.top - frameInset.bottom,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[slicer] Trimmed outer frame (px): top=${frameInset.top} left=${frameInset.left} `
      + `right=${frameInset.right} bottom=${frameInset.bottom}`,
    );
  }

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
      despillMagentaEdges(cell);
      if (row > 0) {
        reclaimRowBoundarySpill(cell, cells[slot_id - grid.columns]);
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
    registerGroupHorizontally(cells, group, grid.registrationShapeOnly);
  }

  // Feet-anchor pass (characters/rivals). MUST run AFTER registerGroupHorizontally —
  // that path re-scans shifted cells and would overwrite an in-scan trim — and BEFORE
  // boardScale/groupedBounds so reference heights and group unions use the feet, not
  // the cape tip. For each cell, rescan its CURRENT bbox for per-row opaque counts and
  // move the effective bottom up to the lowest DENSE row (the feet), trimming thin
  // below-feet content (a cape drag), but only when the trim removes <= 25% of the bbox
  // height (safety fallback for legitimately narrow-bottomed poses).
  if (grid.feetAnchorMinWidthRatio && grid.feetAnchorMinWidthRatio > 0) {
    const feetRatio = grid.feetAnchorMinWidthRatio;
    for (const cellInfo of cells) {
      if (cellInfo.count <= 0) continue;
      const { cell, minY, maxY } = cellInfo;
      const rowOpaqueCounts = new Array(cell.bitmap.height).fill(0);
      cell.scan(0, minY, cell.bitmap.width, maxY - minY + 1, function (_x: number, y: number, idx: number) {
        if (cell.bitmap.data[idx + 3] !== 0) rowOpaqueCounts[y] += 1;
      });
      let maxRowCount = 0;
      for (let y = minY; y <= maxY; y++) if (rowOpaqueCounts[y] > maxRowCount) maxRowCount = rowOpaqueCounts[y];
      const feetThreshold = maxRowCount * feetRatio;
      let feetY = maxY;
      for (let y = maxY; y >= minY; y--) { if (rowOpaqueCounts[y] >= feetThreshold) { feetY = y; break; } }
      const bboxHeight = maxY - minY + 1;
      if (feetY < maxY && (maxY - feetY) <= 0.25 * bboxHeight) {
        cellInfo.maxY = feetY;
      }
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
  let boardScale = grid.targetContentHeight && medianReferenceHeight
    ? grid.targetContentHeight / medianReferenceHeight
    : 1;
  if (grid.noUpscale) {
    boardScale = Math.min(boardScale, 1);
  }
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
      // Row-boundary reclamation (reclaimRowBoundarySpill) can grow a cell's
      // content taller than the fixed 128px output frame (an oversized subject's
      // reclaimed base pixels are appended below its original crop). maxContentExtent
      // already guards this for every production grid, but cap against the frame's
      // own dimensions too so a grid that omits maxContentExtent still scales the
      // now-taller content down to fit instead of letting destY go negative and
      // silently clip the top of the sprite at composite time below.
      const scale = grid.clipWidthOverflow
        ? Math.min(boardScale, maxContentExtent / bh, 128 / bh)
        : Math.min(boardScale, maxContentExtent / bw, maxContentExtent / bh, 128 / bw, 128 / bh);
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
        if (grid.smoothResize) {
          neutralizeTransparentToBlack(content);
          content.resize(resizedWidth, resizedHeight, Jimp.RESIZE_BICUBIC);
        } else {
          content.resize(resizedWidth, resizedHeight, Jimp.RESIZE_NEAREST_NEIGHBOR);
        }
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
function registerGroupHorizontally(cells: SliceCell[], group: number[], shapeOnly?: boolean): void {
  const members = group
    .map((slotId) => cells[slotId])
    .filter((cell): cell is SliceCell => Boolean(cell?.count));
  if (members.length < 2) return;

  const reference = members[0];
  for (const member of members.slice(1)) {
    const dx = findBestHorizontalShift(reference.cell, member.cell, shapeOnly);
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
export function findBestHorizontalShift(reference: Jimp, candidate: Jimp, shapeOnly?: boolean): number {
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
          // Shape-only registration ignores per-pixel brightness so an in-place
          // lighting/glow animation can't fool the alignment; the silhouette
          // mismatch penalty below still drives the shift toward true overlap.
          if (!shapeOnly) {
            cost += Math.abs(refData[refIdx] - candData[candIdx])
              + Math.abs(refData[refIdx + 1] - candData[candIdx + 1])
              + Math.abs(refData[refIdx + 2] - candData[candIdx + 2]);
          }
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
 * Sets RGB to black for every fully-transparent (alpha === 0) pixel, leaving
 * alpha and every opaque/partial-alpha pixel's RGB untouched. Used to strip
 * leftover chroma-magenta color out of already-keyed-transparent background
 * pixels before a bicubic resize, so blending can't pull magenta into the
 * silhouette edge (bicubic samples RGB regardless of alpha).
 */
export function neutralizeTransparentToBlack(image: Jimp): void {
  const data = image.bitmap.data;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (_x: number, _y: number, idx: number) {
    if (data[idx + 3] === 0) {
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
    }
  });
}

/**
 * Sets RGB to black for every pixel whose color passes the strict
 * isChromaMagenta test, regardless of alpha (opaque magenta becomes opaque
 * black; transparent magenta becomes transparent black). Alpha is always left
 * as-is. Used to recolor the magenta board background before any resize so a
 * later bicubic pass has no magenta source pixels to blend from.
 */
export function replaceChromaMagentaWithBlack(image: Jimp): void {
  const data = image.bitmap.data;
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (_x: number, _y: number, idx: number) {
    if (isChromaMagenta(data[idx], data[idx + 1], data[idx + 2])) {
      data[idx] = 0;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
    }
  });
}

/** Per-side inset, in pixels, of a detected uniform outer frame. */
export interface OuterFrameInset {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface DetectOuterFrameOptions {
  /** Per-channel color tolerance (0..255) for "same color" ring pixels. Default 24. */
  colorTolerance?: number;
  /** Fraction of a ring that must match its dominant color to count as uniform. Default 0.9. */
  dominantFraction?: number;
  /** Hard cap on trim per side, as a fraction of that dimension. Default 0.15. */
  maxTrimFraction?: number;
  /** If the trimmed region would be narrower than this (px), abort with zero inset. */
  minRegionWidth?: number;
  /** If the trimmed region would be shorter than this (px), abort with zero inset. */
  minRegionHeight?: number;
}

const ZERO_INSET: OuterFrameInset = { top: 0, left: 0, right: 0, bottom: 0 };

/**
 * Detects a uniform, solid-color OUTER FRAME (e.g. a black border some image
 * models draw around the whole sheet) so it can be cropped away before the
 * fixed proportional grid is applied — otherwise the border shifts every cell.
 *
 * Each of the 4 edges is peeled INDEPENDENTLY. For an edge's current outermost
 * row/column, the ring's dominant color is found; the ring is peeled iff
 * >= `dominantFraction` of its pixels are within `colorTolerance` (per channel)
 * of that single dominant color AND that dominant color is NOT the magenta
 * background (`isBackgroundColor`). Peeling stops the moment a ring is
 * background (magenta padding) or mixed (sprite pixels) — so a solid frame is
 * removed and the sprite grid's own internal magenta padding is preserved.
 *
 * A well-formed magenta-to-edge sheet therefore gets ZERO trim (identical to
 * pre-existing behavior). Trim on any side is capped at `maxTrimFraction`; if a
 * frame would exceed it, that side stops rather than over-cropping. Degenerate
 * detection (region too small) returns zero inset, and any thrown error fails
 * safe to zero inset.
 *
 * @param atlas             The source sprite sheet.
 * @param isBackgroundColor Predicate identifying the chroma-key background
 *                          color (pass `isChromaMagenta`).
 * @param opts              Tuning + safety bounds.
 */
export function detectOuterFrame(
  atlas: Jimp,
  isBackgroundColor: (r: number, g: number, b: number) => boolean,
  opts: DetectOuterFrameOptions = {},
): OuterFrameInset {
  try {
    const W = atlas.bitmap.width;
    const H = atlas.bitmap.height;
    if (!W || !H) return { ...ZERO_INSET };

    const tol = opts.colorTolerance ?? 24;
    const frac = opts.dominantFraction ?? 0.9;
    const maxFrac = opts.maxTrimFraction ?? 0.15;
    const minRegionWidth = opts.minRegionWidth ?? 1;
    const minRegionHeight = opts.minRegionHeight ?? 1;
    const maxTrimX = Math.floor(W * maxFrac);
    const maxTrimY = Math.floor(H * maxFrac);
    const data = atlas.bitmap.data;

    const rgbAt = (x: number, y: number): [number, number, number] => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };

    // Returns true when `pixels` form a uniform ring of a single NON-background
    // color (>= frac within tolerance of the dominant color).
    const isUniformNonBackgroundRing = (pixels: Array<[number, number, number]>): boolean => {
      if (pixels.length === 0) return false;
      // Dominant color via a coarse (3-bit/channel) histogram, then average the
      // winning bucket for a stable representative color.
      const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
      for (const [r, g, b] of pixels) {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let e = buckets.get(key);
        if (!e) { e = { r: 0, g: 0, b: 0, n: 0 }; buckets.set(key, e); }
        e.r += r; e.g += g; e.b += b; e.n += 1;
      }
      let best: { r: number; g: number; b: number; n: number } | undefined;
      for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
      if (!best) return false;
      const dr = best.r / best.n;
      const dg = best.g / best.n;
      const db = best.b / best.n;
      // A background-colored ring means we've reached the magenta padding: stop.
      if (isBackgroundColor(dr, dg, db)) return false;
      let within = 0;
      for (const [r, g, b] of pixels) {
        if (Math.abs(r - dr) <= tol && Math.abs(g - dg) <= tol && Math.abs(b - db) <= tol) within += 1;
      }
      return within >= frac * pixels.length;
    };

    const inset = { top: 0, left: 0, right: 0, bottom: 0 };

    // TOP: peel rows from the top edge.
    while (inset.top < maxTrimY) {
      const y = inset.top;
      const x0 = inset.left;
      const x1 = W - 1 - inset.right;
      const yBottom = H - 1 - inset.bottom;
      if (x0 > x1 || y >= yBottom) break;
      const ring: Array<[number, number, number]> = [];
      for (let x = x0; x <= x1; x++) ring.push(rgbAt(x, y));
      if (!isUniformNonBackgroundRing(ring)) break;
      inset.top += 1;
    }
    // BOTTOM: peel rows from the bottom edge.
    while (inset.bottom < maxTrimY) {
      const y = H - 1 - inset.bottom;
      const x0 = inset.left;
      const x1 = W - 1 - inset.right;
      const yTop = inset.top;
      if (x0 > x1 || y <= yTop) break;
      const ring: Array<[number, number, number]> = [];
      for (let x = x0; x <= x1; x++) ring.push(rgbAt(x, y));
      if (!isUniformNonBackgroundRing(ring)) break;
      inset.bottom += 1;
    }
    // LEFT: peel columns from the left edge (over the already-trimmed y range).
    while (inset.left < maxTrimX) {
      const x = inset.left;
      const y0 = inset.top;
      const y1 = H - 1 - inset.bottom;
      const xRight = W - 1 - inset.right;
      if (y0 > y1 || x >= xRight) break;
      const ring: Array<[number, number, number]> = [];
      for (let y = y0; y <= y1; y++) ring.push(rgbAt(x, y));
      if (!isUniformNonBackgroundRing(ring)) break;
      inset.left += 1;
    }
    // RIGHT: peel columns from the right edge.
    while (inset.right < maxTrimX) {
      const x = W - 1 - inset.right;
      const y0 = inset.top;
      const y1 = H - 1 - inset.bottom;
      const xLeft = inset.left;
      if (y0 > y1 || x <= xLeft) break;
      const ring: Array<[number, number, number]> = [];
      for (let y = y0; y <= y1; y++) ring.push(rgbAt(x, y));
      if (!isUniformNonBackgroundRing(ring)) break;
      inset.right += 1;
    }

    const regionWidth = W - inset.left - inset.right;
    const regionHeight = H - inset.top - inset.bottom;
    if (regionWidth < minRegionWidth || regionHeight < minRegionHeight
        || regionWidth <= 0 || regionHeight <= 0) {
      return { ...ZERO_INSET };
    }
    return inset;
  } catch {
    // Fail safe to current behavior (no trim) on any unexpected error.
    return { ...ZERO_INSET };
  }
}

/**
 * Looser than isChromaMagenta so anti-aliased boundary pixels — the pink/magenta
 * halo blended between sprite and background (e.g. rgb(150,40,200)) — are caught.
 * Green must sit well below both red and blue with roughly balanced red/blue,
 * which excludes normal skin, red, orange, and purple sprite colors.
 *
 * The r/b floor is tuned down slightly (from 110) to reach a bit further into
 * near-magenta blends at the extreme without opening the door to legitimate
 * red or purple art: the asymmetric-channel guards above (g well below both
 * r and b, with r/b roughly balanced) still exclude those.
 */
function isMagentaDominant(r: number, g: number, b: number): boolean {
  return g < r - 40
    && g < b - 40
    && r > 90
    && b > 90
    && Math.abs(r - b) < 110;
}

/**
 * Despill pass. defringeMagentaEdges erases whole pixels once they read as
 * clearly magenta-dominant, but a faint magenta tint blended over a DARK
 * subject pixel — the black outlines this art style relies on — often stays
 * too low-luminance to trip that erase threshold (e.g. rgb(70,20,70)) while
 * still reading as a visible purple halo in-game, especially along sprite
 * bottoms.
 *
 * For every still-opaque pixel within EDGE_RADIUS of a transparent pixel
 * (edge proximity keeps this from ever touching legitimately pink/purple
 * interior art, which sits far from any cut edge), a clear red+blue spill
 * over green is desaturated toward green rather than deleted, so the
 * silhouette is never thinned. An extreme spill is instead made fully
 * transparent, since at that point it is background bleed, not tinted art.
 *
 * Edge proximity is evaluated against a pre-pass alpha snapshot so pixels
 * this same pass turns transparent don't cascade into eating further pixels
 * within the same call.
 */
function despillMagentaEdges(cell: Jimp): void {
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  const data = cell.bitmap.data;
  const EDGE_RADIUS = 2;
  const SPILL_MARGIN = 40;
  const STRONG_SPILL_MARGIN = 100;
  const CLAMP_HEADROOM = 30;

  const alphaSnapshot = new Uint8Array(width * height);
  for (let i = 0; i < alphaSnapshot.length; i++) alphaSnapshot[i] = data[i * 4 + 3];

  const isNearTransparentEdge = (x: number, y: number): boolean => {
    for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS; dy++) {
      for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (alphaSnapshot[ny * width + nx] === 0) return true;
      }
    }
    return false;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * width + x;
      const idx = offset * 4;
      if (data[idx + 3] === 0) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (!(r > g + SPILL_MARGIN && b > g + SPILL_MARGIN)) continue;
      if (!isNearTransparentEdge(x, y)) continue;

      if (r > g + STRONG_SPILL_MARGIN && b > g + STRONG_SPILL_MARGIN) {
        data[idx + 3] = 0;
        continue;
      }
      const clamped = Math.min(r, b, g + CLAMP_HEADROOM);
      data[idx] = clamped;
      data[idx + 2] = clamped;
    }
  }
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
 * Widest slice, as a fraction of the LOWER cell's own height, searched below a
 * row boundary for base pixels an oversized subject spilled downward out of
 * the cell above. Pixels found connected within this window are reclaimed
 * into the upper cell (see reclaimRowBoundarySpill) instead of being
 * discarded, so a subject drawn taller than its grid cell keeps its full,
 * tapered base rather than being flat-cut at the grid line. Spill connected
 * pixels found deeper than this window are still discarded, same as before
 * this feature existed — a component that reaches this far past the boundary
 * reads as noise, not a recoverable base.
 */
const ROW_OVERFLOW_RECLAIM_FRACTION = 0.2;

/**
 * Image models sometimes draw a subject taller than its grid cell, so its
 * base crosses the row boundary and lands in the top strip of the cell below.
 * Once the atlas is sliced, that overflow looks like a small, disconnected
 * component at the top of the next cell.
 *
 * Find only a minor top-connected component in `cell` that continues opaque
 * pixels from `cellAboveInfo`'s bottom row (8-connected flood from that
 * boundary-adjacent seed). If the component is most of `cell`'s own content,
 * leave it alone: that is more likely a badly framed but recoverable sprite
 * that happens to touch the cell top than row-boundary debris.
 *
 * Otherwise the component is genuine spill. Pixels within
 * ROW_OVERFLOW_RECLAIM_FRACTION of `cell`'s own height are reclaimed: copied
 * into a taller replacement for `cellAboveInfo.cell` (grown downward, below
 * its previous bottom edge, at the same x/relative-y they held in `cell`) and
 * cleared from `cell`, so the overflow is moved rather than duplicated.
 * `cellAboveInfo`'s cached content bounds are recomputed to cover the newly
 * added pixels. Any connected pixels deeper than the window are simply
 * cleared from `cell`, matching this function's pre-reclamation behavior.
 *
 * Where a component seeds off `cellAboveInfo`'s bottom row by coincidence
 * (the lower cell's own subject happens to touch it) rather than genuine
 * continuation, the majority-content guard above already protects it; for a
 * true minority spill component, only pixels actually connected to that seed
 * are ever claimed, so a separate subject elsewhere in `cell` is untouched.
 */
function reclaimRowBoundarySpill(cell: Jimp, cellAboveInfo: SliceCell): void {
  const width = cell.bitmap.width;
  const height = cell.bitmap.height;
  const cellAbove = cellAboveInfo.cell;
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

  // Never touch the primary subject if it happens to touch the cell's top.
  if (queue.length * 2 >= opaqueCount) return;

  const reclaimWindowPx = Math.max(1, Math.round(height * ROW_OVERFLOW_RECLAIM_FRACTION));
  const claimed: number[] = [];
  let maxClaimedY = -1;
  for (const offset of queue) {
    const y = Math.floor(offset / width);
    if (y < reclaimWindowPx) {
      claimed.push(offset);
      if (y > maxClaimedY) maxClaimedY = y;
    } else {
      cell.bitmap.data[offset * 4 + 3] = 0;
    }
  }
  if (claimed.length === 0) return;

  const oldAboveHeight = cellAbove.bitmap.height;
  const grown = new Jimp(cellAbove.bitmap.width, oldAboveHeight + maxClaimedY + 1, 0x00000000);
  // Same width, contiguous rows: a straight buffer copy reproduces the
  // original cell's pixels starting at row 0 of the grown bitmap.
  grown.bitmap.data.set(cellAbove.bitmap.data, 0);
  for (const offset of claimed) {
    const x = offset % width;
    const y = Math.floor(offset / width);
    const srcIdx = offset * 4;
    const destIdx = ((oldAboveHeight + y) * grown.bitmap.width + x) * 4;
    grown.bitmap.data[destIdx] = cell.bitmap.data[srcIdx];
    grown.bitmap.data[destIdx + 1] = cell.bitmap.data[srcIdx + 1];
    grown.bitmap.data[destIdx + 2] = cell.bitmap.data[srcIdx + 2];
    grown.bitmap.data[destIdx + 3] = cell.bitmap.data[srcIdx + 3];
    // Claimed by the cell above; clear it here so it is not left behind (and
    // not double-counted when this cell's own content bounds are scanned).
    cell.bitmap.data[srcIdx + 3] = 0;
  }
  cellAboveInfo.cell = grown;
  recomputeCellBounds(cellAboveInfo);
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
