import * as vscode from 'vscode';
import { resolveThemeFileStore } from './themeFileStoreVscode';
import { themeRawImagesDirectoryPath } from './themeFileStore';

export const THEMES_DIRECTORY_NAME = 'themes';

export function themesDirectoryUri(globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(globalStorageUri, THEMES_DIRECTORY_NAME);
}

export function themeDirectoryUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themesDirectoryUri(globalStorageUri), themeId);
}

export function themeManifestUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themeDirectoryUri(globalStorageUri, themeId), 'manifest.json');
}

export function themeFramesUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themeDirectoryUri(globalStorageUri, themeId), 'frames.json');
}

export function themePlanUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themeDirectoryUri(globalStorageUri, themeId), 'plan.json');
}

export function themeReviewUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themeDirectoryUri(globalStorageUri, themeId), 'review.json');
}

export function themeImagesDirectoryUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themeDirectoryUri(globalStorageUri, themeId), 'images');
}

export function themeRawImagesDirectoryUri(globalStorageUri: vscode.Uri, themeId: string): vscode.Uri {
  return vscode.Uri.joinPath(themeImagesDirectoryUri(globalStorageUri, themeId), 'raw');
}

/**
 * Persist the RAW pre-slice atlas buffer that the image provider returned, under
 * `images/raw/<name>` (name matches the normalized `images/<name>` so raw and
 * sliced line up 1:1). This is WRITE-ONLY: it enables a future "re-slice without
 * re-paying the image API" path; there is no consumer yet. Callers must treat it
 * as best-effort and never let a failure here break generation.
 */
export async function saveRawAtlas(
  globalStorageUri: vscode.Uri,
  themeId: string,
  name: string,
  buffer: Buffer,
): Promise<void> {
  const store = resolveThemeFileStore(globalStorageUri);
  const rawDirectoryPath = themeRawImagesDirectoryPath(themeId);
  await store.mkdirp(rawDirectoryPath);
  await store.writeFile(`${rawDirectoryPath}/${name}`, buffer);
}
