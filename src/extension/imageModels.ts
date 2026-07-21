/**
 * imageModels.ts — single source of truth for which image-generation models
 * exist per provider, and which one is "the latest" (the default when the
 * user hasn't picked an override).
 *
 * Vendors ship new image models faster than this codebase gets updated, so
 * this list will go stale. When a provider ships a new model:
 *   1. Add it as the FIRST entry in that provider's array (order matters —
 *      index 0 is always the default "latest").
 *   2. Leave the older entries below it so users who pinned them keep working.
 * This mirrors the /update-pricing pattern used for the metrics cost table —
 * this file is the one place to touch, nothing else needs to change.
 */

import type { ThemeImageProvider } from './themeImageSettings';

export interface ImageModelOption {
  id: string;
  label: string;
  note?: string;
}

export const IMAGE_MODELS: Record<ThemeImageProvider, ImageModelOption[]> = {
  gemini: [
    { id: 'gemini-3.1-flash-image', label: 'Flash Image 3.1', note: 'Latest — recommended' },
    { id: 'gemini-3-pro-image', label: 'Pro Image 3', note: 'Premium — pricier' },
    { id: 'gemini-3.1-flash-lite-image', label: 'Flash-Lite 3.1', note: 'Cheapest' },
    { id: 'gemini-2.5-flash-image', label: '2.5 Flash Image', note: 'Legacy' },
  ],
  openai: [
    { id: 'gpt-image-2', label: 'GPT Image 2', note: 'Latest — recommended' },
    { id: 'gpt-image-1.5', label: 'GPT Image 1.5', note: '' },
    { id: 'gpt-image-1', label: 'GPT Image 1', note: '' },
    { id: 'gpt-image-1-mini', label: 'GPT Image 1 Mini', note: 'Cheapest' },
  ],
};

/** The recommended/default model for a provider — always the first (latest) entry. */
export function defaultImageModel(provider: ThemeImageProvider): string {
  return IMAGE_MODELS[provider][0].id;
}

/**
 * Resolve the model id to actually request. Intentionally permissive: any
 * non-empty stored string is used as-is (not validated against
 * {@link IMAGE_MODELS}) so a user can adopt a brand-new model id the moment a
 * vendor ships it, before this list is updated. Empty/undefined/null falls
 * back to {@link defaultImageModel} (the latest).
 */
export function resolveImageModel(
  provider: ThemeImageProvider,
  stored: string | undefined | null,
): string {
  const trimmed = (stored ?? '').trim();
  return trimmed.length > 0 ? trimmed : defaultImageModel(provider);
}
