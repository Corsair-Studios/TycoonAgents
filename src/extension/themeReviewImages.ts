import Jimp from 'jimp';

export interface ReviewImageFile {
  filename: string;
  data: Buffer;
}

/**
 * Rebuilds reviewable PNGs from the normalized images stored in a theme's
 * frames sidecar. This is primarily a compatibility path for themes created
 * before Theme Builder started retaining the generated atlas files.
 */
export async function recoverReviewImages(
  frames: unknown,
): Promise<ReviewImageFile[]> {
  if (!isRecord(frames)) return [];

  const files: ReviewImageFile[] = [];
  for (const [key, value] of Object.entries(frames)) {
    if (!Array.isArray(value)) continue;

    const buffers = value
      .map((item) => decodeImageDataUri(item))
      .filter((item): item is Buffer => item !== undefined);
    if (buffers.length === 0) continue;

    const images: Jimp[] = [];
    for (const buffer of buffers) {
      try {
        images.push(await Jimp.read(buffer));
      } catch {
        // A damaged frame should not prevent other saved images being recovered.
      }
    }
    if (images.length === 0) continue;

    const stem = toSafeFileStem(key);
    if (key === 'environment_background' || images.length === 1) {
      files.push({
        filename: `${stem}.png`,
        data: await images[0].getBufferAsync(Jimp.MIME_PNG),
      });
      continue;
    }

    const columns = Math.min(5, images.length);
    const rows = Math.ceil(images.length / columns);
    const cellWidth = Math.max(...images.map((image) => image.bitmap.width));
    const cellHeight = Math.max(...images.map((image) => image.bitmap.height));
    const atlas = new Jimp(columns * cellWidth, rows * cellHeight, 0x00000000);

    images.forEach((image, index) => {
      const x = (index % columns) * cellWidth + Math.floor((cellWidth - image.bitmap.width) / 2);
      const y = Math.floor(index / columns) * cellHeight + (cellHeight - image.bitmap.height);
      atlas.composite(image, x, y);
    });

    files.push({
      filename: `${stem}_recovered_atlas.png`,
      data: await atlas.getBufferAsync(Jimp.MIME_PNG),
    });
  }

  return files;
}

function decodeImageDataUri(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) return undefined;

  try {
    const data = Buffer.from(match[1], 'base64');
    return data.length > 0 ? data : undefined;
  } catch {
    return undefined;
  }
}

function toSafeFileStem(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'image';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
