/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as path from "path";
import * as crypto from "crypto";

/**
 * Pure (no-vscode) helpers for per-PROJECT + per-THEME scoping of the
 * badge-unlocks / rebirth-state / build-progress JSON stores.
 *
 * Historically those stores were keyed by theme_id ONLY, and globalStorage is
 * shared across every workspace on the machine — so a badge/rebirth/build
 * entry for "cobra_command" in project A leaked into project B's view of the
 * same theme. These helpers introduce a composite `${scopeKey}|${themeId}`
 * key while staying backward-compatible with legacy plain-`themeId` entries
 * via one-time, transparent, non-destructive migration (see
 * `readCompositeWithMigration`).
 *
 * Kept dependency-free (fs/vscode-free) so it's directly unit-testable; the
 * vscode.workspace.fs read/write plumbing lives in panel.ts, which imports
 * these functions.
 */

/** Fallback scope id used when no workspace/project root is available. */
export const NO_PROJECT_SCOPE = "no-project";

/**
 * Derive a stable per-project scope id from a project root path. The same
 * root (any casing/slash style) always yields the same id; different roots
 * yield different ids. A missing/empty root falls back to a shared constant
 * so no-workspace sessions still share one scope (matching legacy behavior
 * for that edge case, where "project" isn't a meaningful concept).
 */
export function projectScopeKey(root: string | undefined | null): string {
  if (!root) return NO_PROJECT_SCOPE;
  const normalized = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Build the composite `${scopeKey}|${themeId}` store key. */
export function compositeKey(scopeKey: string, themeId: string): string {
  return `${scopeKey}|${themeId}`;
}

/** Result of a migration-aware composite read. */
export interface CompositeReadResult<T> {
  /** The resolved value (composite entry, or migrated-in legacy entry), if any. */
  value: T | undefined;
  /**
   * The store to persist. Identical to the input `store` reference when
   * nothing changed; a NEW object (input left untouched) when a legacy entry
   * was copied forward under the composite key.
   */
  store: Record<string, T>;
  /** True iff a legacy plain-themeId entry was copied into the composite key. */
  migrated: boolean;
}

/**
 * Read a (project, theme) entry from a store keyed by composite keys, with
 * one-time transparent migration from a legacy plain-`themeId` key: if the
 * composite key is missing but a legacy entry exists, the legacy value is
 * copied forward under the composite key in the RETURNED store (the input
 * store is never mutated) so the caller can persist it. The legacy key is
 * deliberately left in place — harmless, and another project may still need
 * to migrate from it.
 */
export function readCompositeWithMigration<T>(
  store: Record<string, T>,
  scopeKey: string,
  themeId: string,
): CompositeReadResult<T> {
  const key = compositeKey(scopeKey, themeId);
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    return { value: store[key], store, migrated: false };
  }
  if (Object.prototype.hasOwnProperty.call(store, themeId)) {
    return { value: store[themeId], store: { ...store, [key]: store[themeId] }, migrated: true };
  }
  return { value: undefined, store, migrated: false };
}

/** Write a (project, theme) entry. Returns a NEW store; input is untouched. */
export function writeComposite<T>(
  store: Record<string, T>,
  scopeKey: string,
  themeId: string,
  value: T,
): Record<string, T> {
  return { ...store, [compositeKey(scopeKey, themeId)]: value };
}

/**
 * Remove only the CURRENT project's entry for a theme (used by the scoped
 * "reset stats" flow). Other projects' composite entries and the legacy
 * plain-themeId entry are left intact. Returns the SAME store reference when
 * there was nothing to remove (so callers can skip a write).
 */
export function removeProjectThemeEntry<T>(
  store: Record<string, T>,
  scopeKey: string,
  themeId: string,
): Record<string, T> {
  const key = compositeKey(scopeKey, themeId);
  if (!Object.prototype.hasOwnProperty.call(store, key)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

/**
 * Remove EVERY entry for a theme — the legacy plain-themeId key AND every
 * project's composite key — used when the theme itself is deleted from disk
 * entirely (deleteTheme removes it for every workspace, so no project should
 * keep orphaned progress for it). Returns the SAME store reference when
 * nothing matched.
 */
export function removeThemeEverywhere<T>(store: Record<string, T>, themeId: string): Record<string, T> {
  const suffix = `|${themeId}`;
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(store)) {
    if (key === themeId || key.endsWith(suffix)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : store;
}

/**
 * Decide whether the theme-switch warning modal should be shown: only when
 * there IS a currently-loaded theme, it differs from the target, and it has
 * at least one unlocked badge (for the current project) to lose visibility
 * of.
 */
export function shouldWarnOnThemeSwitch(
  currentThemeId: string | undefined | null,
  targetThemeId: string,
  currentThemeBadgeCount: number,
): boolean {
  return Boolean(currentThemeId) && currentThemeId !== targetThemeId && currentThemeBadgeCount > 0;
}
