/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  themesDirectoryPath,
  themeDirectoryPath,
  themeManifestPath,
  themeFramesPath,
  themePlanPath,
  themeReviewPath,
  themeImagesDirectoryPath,
  themeRawImagesDirectoryPath,
  joinThemePath,
} from '../src/extension/themeFileStore';

// project-plan pA-t5: pin the on-disk theme layout that themeFileStore.ts's
// relative-path builders produce. themeService.ts/themeStorage.ts (vscode
// adapter) and standalone/src/themeFileStoreFs.mjs (fs adapter, see
// standalone/test/themeFileStoreFs.test.mjs) both key their reads/writes off
// these EXACT relative paths -- a silent rename here would desync the two
// hosts' on-disk layouts without either host's own tests noticing (each only
// checks self-consistency against the builder it imports). themeFileStore.ts
// is vscode-free, so this test needs no stub.

test('themeFileStore path builders produce the pinned themes/<id>/ layout', () => {
  const themeId = 'castle_theme';

  assert.equal(themesDirectoryPath(), 'themes');
  assert.equal(themeDirectoryPath(themeId), 'themes/castle_theme');
  assert.equal(themeManifestPath(themeId), 'themes/castle_theme/manifest.json');
  assert.equal(themeFramesPath(themeId), 'themes/castle_theme/frames.json');
  assert.equal(themePlanPath(themeId), 'themes/castle_theme/plan.json');
  assert.equal(themeReviewPath(themeId), 'themes/castle_theme/review.json');
  assert.equal(themeImagesDirectoryPath(themeId), 'themes/castle_theme/images');
  assert.equal(themeRawImagesDirectoryPath(themeId), 'themes/castle_theme/images/raw');
});

test('themeFileStore path builders stay pinned for a second, distinct themeId (not hardcoded to one id)', () => {
  const themeId = 'cyberpunk_2049';

  assert.equal(themeDirectoryPath(themeId), 'themes/cyberpunk_2049');
  assert.equal(themeManifestPath(themeId), 'themes/cyberpunk_2049/manifest.json');
  assert.equal(themePlanPath(themeId), 'themes/cyberpunk_2049/plan.json');
  assert.equal(themeReviewPath(themeId), 'themes/cyberpunk_2049/review.json');
  assert.equal(themeImagesDirectoryPath(themeId), 'themes/cyberpunk_2049/images');
  assert.equal(themeRawImagesDirectoryPath(themeId), 'themes/cyberpunk_2049/images/raw');
});

test('joinThemePath normalizes segments (no empty/duplicate slashes) -- the primitive every builder above relies on', () => {
  assert.equal(joinThemePath('themes', 'castle_theme', 'manifest.json'), 'themes/castle_theme/manifest.json');
  assert.equal(joinThemePath('themes/castle_theme', 'images/raw'), 'themes/castle_theme/images/raw');
  assert.equal(joinThemePath('', 'themes', '', 'castle_theme'), 'themes/castle_theme');
});
