import { compositeBoardFromFrameKeys } from './slicer';
import { resizeSpriteBoardCanvas } from './spriteBoardOptimizer';
import type { ThemeImageKind } from './themeImageReviewState';

/**
 * Host-independent (no 'vscode' import). Used by themeService.ts's recovery
 * path (ensureThemeReviewImages) to rebuild board-shaped review PNGs for
 * themes that shipped with frames.json but no review.json/images — e.g. the
 * bundled sample theme, or a hand-authored/imported one.
 */

/** The subset of ThemeImageReviewItem this module needs to compose one board. */
export interface RecoverableBoardItem {
  kind: ThemeImageKind;
  filename: string;
  frame_keys: string[];
  /** rival_atlas only: board row count drives the grid's row count. */
  rival_rows?: readonly unknown[];
}

export interface RecoveredBoardFile {
  filename: string;
  data: Buffer;
}

/**
 * Grid geometry (columns x rows of 128px cells) per sliceable board kind.
 * Mirrors themeService.ts's private reviewBoardGridForItemKind, which is the
 * SAME lookup the real generation/retry path uses to recomposite a board's
 * review preview from frames.json (see compositeBoardFromFrameKeys call in
 * retryThemeImage) — duplicated here (not imported) so this module stays
 * free of any dependency on themeService.ts and avoids a circular import.
 * Keep the two switches in sync if a board kind's grid ever changes.
 * Returns undefined for kinds with no fixed grid (environment: a single
 * ungridded image, handled separately by the caller).
 */
export function recoveryBoardGridForKind(
  item: Pick<RecoverableBoardItem, 'kind' | 'rival_rows'>,
): { columns: number; rows: number } | undefined {
  switch (item.kind) {
    case 'character_atlas': return { columns: 5, rows: 4 };
    case 'rival_atlas': return item.rival_rows?.length ? { columns: 5, rows: item.rival_rows.length } : undefined;
    case 'object_atlas': return { columns: 4, rows: 4 };
    case 'background_decor_atlas': return { columns: 4, rows: 4 };
    case 'expression_atlas': return { columns: 4, rows: 2 };
    case 'achievement_atlas': return { columns: 5, rows: 5 };
    case 'emote_atlas': return { columns: 5, rows: 4 };
    case 'environment': return undefined;
    default: return undefined;
  }
}

/**
 * Compose ONE magenta (#FF00FF) sprite-sheet PNG per board item from
 * already-saved frames.json data, using the same cell layout and composite
 * routine (compositeBoardFromFrameKeys, from slicer.ts) that the real
 * generation/retry path uses to redraw a board's review preview — so a
 * recovered board is pixel-for-pixel structurally identical to a generated
 * one: same canvas size, same per-slot placement, unfilled cells left flat
 * magenta.
 *
 * A board with none of its frame keys populated yet is skipped entirely (no
 * output file), the same "not generated" state a freshly-synthesized,
 * never-generated board shows — so an ungenerated recovered theme still
 * shows a pending placeholder card instead of an empty magenta board.
 *
 * `environment` items are handled without a grid: the single stored frame is
 * decoded and used verbatim (already normalized when originally generated).
 */
export async function composeRecoveredBoardImages(
  items: readonly RecoverableBoardItem[],
  frames: Record<string, string[]>,
): Promise<RecoveredBoardFile[]> {
  const files: RecoveredBoardFile[] = [];

  for (const item of items) {
    if (item.kind === 'environment') {
      const frameList = frames[item.frame_keys[0]] ?? [];
      if (!frameList.length) continue;
      const dataUri = frameList[0];
      const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
      files.push({ filename: item.filename, data: Buffer.from(base64, 'base64') });
      continue;
    }

    const grid = recoveryBoardGridForKind(item);
    if (!grid) continue;
    const hasAnyFrames = item.frame_keys.some((key) => (frames[key]?.length ?? 0) > 0);
    if (!hasAnyFrames) continue;

    let data = await compositeBoardFromFrameKeys(item.frame_keys, frames, grid.columns, grid.rows);
    if (item.kind === 'character_atlas') {
      // Character boards are retained at a fixed 512x512 review canvas — see
      // applySlicedAtlasFromBuffer's character_atlas branch / processCharacterAtlas.
      data = await resizeSpriteBoardCanvas(data, 512, 512);
    }
    files.push({ filename: item.filename, data });
  }

  return files;
}
