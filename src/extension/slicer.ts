import Jimp from 'jimp';
import type { ThemeManifest } from '../shared/types';

export interface NormalizedAtlasPackage {
  manifest: Partial<ThemeManifest>;
  cell_width: number;
  cell_height: number;
  slots: Array<{ slot_id: number; data: string }>;
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
): Promise<NormalizedAtlasPackage> {
  const atlas = await Jimp.read(imageBuffer);
  const cellW = Math.floor(atlas.bitmap.width / 5);
  const cellH = Math.floor(atlas.bitmap.height / 4);

  const slots: Array<{ slot_id: number; data: string }> = [];

  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      const slot_id = row * 5 + col;

      const cell = atlas.clone().crop(col * cellW, row * cellH, cellW, cellH);

      let minX = Infinity;
      let maxX = -1;
      let minY = Infinity;
      let maxY = -1;
      let sumX = 0;
      let count = 0;

      cell.scan(0, 0, cell.bitmap.width, cell.bitmap.height, function (x: number, y: number, idx: number) {
        const r = cell.bitmap.data[idx];
        const g = cell.bitmap.data[idx + 1];
        const b = cell.bitmap.data[idx + 2];

        // Chroma-key magenta to transparent
        if (r >= 250 && g <= 10 && b >= 250) {
          cell.bitmap.data[idx + 3] = 0;
          return;
        }

        // Content pixel (alpha not 0 after keying)
        if (cell.bitmap.data[idx + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          sumX += x;
          count += 1;
        }
      });

      const out = new Jimp(128, 128, 0x00000000);

      if (count > 0) {
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const content = cell.clone().crop(minX, minY, bw, bh);
        const comX = sumX / count;
        const destX = Math.round(64 - (comX - minX));
        const destY = 128 - bh;
        out.composite(content, destX, destY);
      }

      const pngBuf = await out.getBufferAsync(Jimp.MIME_PNG);
      slots.push({ slot_id, data: 'data:image/png;base64,' + pngBuf.toString('base64') });
    }
  }

  return { manifest, cell_width: 128, cell_height: 128, slots };
}
