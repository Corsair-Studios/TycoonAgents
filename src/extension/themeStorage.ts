import * as vscode from 'vscode';

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
