export interface ThemeGenerationReviewItem {
  id: string;
  frame_keys: string[];
}

/**
 * Current themes use the `objects` item for their 12-object sprite sheet.
 * Some releases also appended a second, empty legacy item to the same review
 * document. Keep genuinely legacy themes intact while removing that duplicate.
 */
export function withoutRedundantBuildableObjectsItem<T extends { id: string }>(items: T[]): T[] {
  if (!items.some((item) => item.id === 'objects')) return items;
  return items.filter((item) => item.id !== 'buildable_objects');
}

/** An item is resumably complete only when both its retained image and frames exist. */
export function isThemeGenerationItemComplete(
  item: ThemeGenerationReviewItem,
  hasReviewImage: boolean,
  frames: Record<string, string[]>,
): boolean {
  if (!hasReviewImage) return false;
  return item.frame_keys.length === 0
    || item.frame_keys.every((key) => Array.isArray(frames[key]) && frames[key].length > 0);
}
