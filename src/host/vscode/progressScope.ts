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
 * key. The legacy-entry carry-forward migration that used to exist here has
 * been REMOVED: every (project, theme) pair now starts cold on a composite
 * key, and legacy plain-`themeId` entries are never read, copied, or
 * persisted. This makes the scoped "Reset" flow authoritative — once reset,
 * an entry cannot be resurrected from a lingering legacy key.
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

/** Result of a composite read. Kept `{ value, store, migrated }`-shaped for caller compatibility. */
export interface CompositeReadResult<T> {
  /** The resolved value (composite entry only), if any. */
  value: T | undefined;
  /** Always the input `store` reference, unchanged — this function never mutates or copies. */
  store: Record<string, T>;
  /**
   * Always `false`. Migration was removed; this field is kept only so
   * existing callers (which persist when `migrated` is true) compile
   * unchanged and simply never re-persist.
   */
  migrated: boolean;
}

/**
 * Read a (project, theme) entry from a store keyed by composite keys.
 *
 * Migration from the legacy plain-`themeId` key has been REMOVED: this reads
 * ONLY `${scopeKey}|${themeId}`. A legacy plain-`themeId` entry, if present,
 * is never read, copied, or persisted — a store that only has a legacy entry
 * reads as cold (value `undefined`) for any composite key. Per-project cold
 * start is intended (see file header).
 */
export function readCompositeWithMigration<T>(
  store: Record<string, T>,
  scopeKey: string,
  themeId: string,
): CompositeReadResult<T> {
  const key = compositeKey(scopeKey, themeId);
  const value = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined;
  return { value, store, migrated: false };
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
 * Delete the legacy plain-`themeId` entry (if present) from a store. Used
 * alongside {@link removeProjectThemeEntry} by the scoped "reset stats" flow
 * so a stale pre-scoping global entry can't linger or (now that migration is
 * removed) resurface later for some other project. Other themes' legacy
 * entries and every project's composite entries are left intact. Returns the
 * SAME store reference (with `changed: false`) when there was nothing to
 * remove, so callers can skip a write.
 */
export function removeLegacyThemeEntry<T>(
  store: Record<string, T>,
  themeId: string,
): { store: Record<string, T>; changed: boolean } {
  if (!Object.prototype.hasOwnProperty.call(store, themeId)) return { store, changed: false };
  const next = { ...store };
  delete next[themeId];
  return { store: next, changed: true };
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
 * Resolve "which project is this window/panel scoped to" — workspace-first,
 * env-var-fallback-only.
 *
 * `CLAUDE_PROJECT_DIR` is a PROCESS-WIDE environment variable inherited by
 * the whole VS Code / extension-host process, not a per-window value. When
 * the IDE (or an Extension Development Host) is launched from some fixed
 * directory, that single env value leaks into every open window, so it can
 * never be trusted as the primary source of "which project is this" — doing
 * so causes cross-project data bleed (activity/badges/build progress from
 * one project appearing in every other project). The open workspace folder
 * is the only genuinely per-window source of truth.
 *
 * Precedence:
 * 1. If a workspace folder is open, use its path — UNLESS the env var is set
 *    and normalizes-equal to one of the open workspace folders, in which
 *    case the env var's exact string is returned (same project, matching
 *    value; avoids an unnecessary divergence between the two).
 * 2. If no workspace folder is open, fall back to the env var (or "" if
 *    unset) — an empty window has no other per-window signal available.
 */
export function resolveProjectRoot(
  workspaceFolderPaths: readonly string[],
  claudeProjectDirEnv: string | undefined,
): string {
  const normalize = (p: string): string => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  const primary = workspaceFolderPaths[0];
  if (primary) {
    if (
      claudeProjectDirEnv &&
      workspaceFolderPaths.some((f) => normalize(f) === normalize(claudeProjectDirEnv))
    ) {
      return claudeProjectDirEnv;
    }
    return primary;
  }
  return claudeProjectDirEnv ?? "";
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
