/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Vscode-free storage contract for theme file I/O (project-plan task pA-t1,
 * "Foundation: decouple storage + config from vscode"). themeStorage.ts and
 * themeService.ts read/write theme data (manifest.json, plan.json,
 * review.json, frames.json, images/, images/raw/, .bak backups) exclusively
 * through a `ThemeFileStore` instead of calling `vscode.workspace.fs`
 * directly, so that logic can eventually be reused by a non-VS-Code host
 * (see standalone/, and pA-t4's planned appData/fs-backed adapter).
 *
 * This module (and only this module) MUST NOT import 'vscode' — it is the
 * single source of truth both the extension's vscode-backed adapter
 * (themeFileStoreVscode.ts) and any future standalone adapter implement.
 *
 * All paths passed to a ThemeFileStore method are POSIX-style ('/'-joined)
 * paths RELATIVE to that store's own root (the extension's
 * `globalStorageUri`, or the standalone's appData theme directory) — never
 * absolute filesystem paths. The relative-path builder functions below are
 * the one place the on-disk theme layout is spelled out; keep them in sync
 * with the (unchanged) vscode.Uri-returning builders in themeStorage.ts,
 * which panel.ts still uses directly for webview URI conversion.
 */

/** One entry returned by `ThemeFileStore.readdir`. */
export interface ThemeFileStoreEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Minimal stat info a ThemeFileStore implementation must report. */
export interface ThemeFileStoreStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  /** Milliseconds since epoch, matching vscode.FileStat.mtime's unit. */
  mtimeMs: number;
}

export interface ThemeFileStoreRemoveOptions {
  recursive?: boolean;
}

export interface ThemeFileStoreRenameOptions {
  overwrite?: boolean;
}

/**
 * Vscode-free theme file storage contract. Implementations should preserve
 * native error semantics for a missing path (e.g. the extension's adapter
 * lets vscode's own `FileSystemError` with `code === 'FileNotFound'`
 * propagate unchanged from `readFile`/`stat`), since existing callers in
 * themeService.ts rely on catching that to detect "does not exist" cheaply.
 */
export interface ThemeFileStore {
  readFile(relativePath: string): Promise<Uint8Array>;
  writeFile(relativePath: string, data: Uint8Array | Buffer): Promise<void>;
  readdir(relativePath: string): Promise<ThemeFileStoreEntry[]>;
  /** Create the directory (and any missing parents) if it doesn't exist yet. */
  mkdirp(relativePath: string): Promise<void>;
  remove(relativePath: string, options?: ThemeFileStoreRemoveOptions): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<ThemeFileStoreStat>;
  rename(fromRelativePath: string, toRelativePath: string, options?: ThemeFileStoreRenameOptions): Promise<void>;
}

/** Root directory (relative to a ThemeFileStore) all per-theme folders live under. */
export const THEMES_DIRECTORY_NAME = 'themes';

export function joinThemePath(...segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
}

export function themesDirectoryPath(): string {
  return THEMES_DIRECTORY_NAME;
}

export function themeDirectoryPath(themeId: string): string {
  return joinThemePath(THEMES_DIRECTORY_NAME, themeId);
}

export function themeManifestPath(themeId: string): string {
  return joinThemePath(themeDirectoryPath(themeId), 'manifest.json');
}

export function themeFramesPath(themeId: string): string {
  return joinThemePath(themeDirectoryPath(themeId), 'frames.json');
}

export function themePlanPath(themeId: string): string {
  return joinThemePath(themeDirectoryPath(themeId), 'plan.json');
}

export function themeReviewPath(themeId: string): string {
  return joinThemePath(themeDirectoryPath(themeId), 'review.json');
}

export function themeImagesDirectoryPath(themeId: string): string {
  return joinThemePath(themeDirectoryPath(themeId), 'images');
}

export function themeRawImagesDirectoryPath(themeId: string): string {
  return joinThemePath(themeImagesDirectoryPath(themeId), 'raw');
}

// Legacy flat-file layout (pre per-theme-directory releases): sidecar files
// sitting directly at the storage root, named `<themeId>_<kind>`. Several
// read paths still fall back to these for themes written by older releases.
export function legacyManifestPath(themeId: string): string {
  return `${themeId}_manifest.json`;
}

export function legacyFramesPath(themeId: string): string {
  return `${themeId}_frames.json`;
}

export function legacyPlanPath(themeId: string): string {
  return `${themeId}_plan.json`;
}

export function legacyReviewPath(themeId: string): string {
  return `${themeId}_review.json`;
}

export function legacyImageReviewPath(themeId: string): string {
  return `${themeId}_image_review.json`;
}

export function legacyImagesDirectoryPath(themeId: string): string {
  return `${themeId}_images`;
}
