// TycoonAgents standalone — UPLOAD_THEME_IMAGE handler: a manual per-board
// upload must land on disk as that board's current image, show up in the
// re-posted THEME_IMAGE_REVIEW (image_src set), and reply ok. Real
// themeService.js pipeline over an fs-backed temp store; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFsThemeFileStore, themeImagesDirectoryPath } from '../src/themeFileStoreFs.mjs';
import { configureThemeFileStore, saveThemePlan } from '../src/themeGenerationBridge.mjs';
import { handleUploadThemeImage } from '../src/themeGenerationMessages.mjs';

const require = createRequire(import.meta.url);
const Jimp = require('jimp');

async function solidPng(r, g, b) {
  return new Jimp(512, 512, Jimp.rgbaToInt(r, g, b, 255)).getBufferAsync('image/png');
}

const plan = {
  display_name: 'Upload Keep',
  creative_direction: 'A cozy medieval keep.',
  environment: 'A courtyard.',
  characters: ['Knight'],
  enemies: ['Goblin'],
  decor: ['Banner'],
  objects: ['Anvil'],
};

test('handleUploadThemeImage: uploading to a not-yet-generated environment board saves and re-posts it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-standalone-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createFsThemeFileStore(root);
  configureThemeFileStore(store);
  const { theme_id: themeId } = await saveThemePlan(store, plan);

  const calls = [];
  const broadcast = (eventName, data) => calls.push({ eventName, data });
  const png = await solidPng(200, 20, 20);
  await handleUploadThemeImage(store, broadcast, {
    theme_id: themeId,
    item_id: 'environment',
    image_base64: png.toString('base64'),
  });

  const result = calls.find((c) => c.data.type === 'BACKGROUND_REPLACE_RESULT');
  assert.equal(result?.data.payload.ok, true);
  const review = [...calls].reverse().find((c) => c.data.type === 'THEME_IMAGE_REVIEW');
  const item = review.data.payload.items.find((i) => i.id === 'environment');
  assert.ok(item.image_src, 'environment card must now carry an image_src');
  assert.ok(calls.some((c) => c.data.type === 'THEME_INITIALIZED'));
  const entries = await store.readdir(themeImagesDirectoryPath(themeId));
  assert.ok(entries.some((e) => e.name === 'environment.png'));
});

test('handleUploadThemeImage: missing bytes or a cancelled pick reply ok:false without writing', async () => {
  const calls = [];
  const broadcast = (eventName, data) => calls.push({ eventName, data });
  await handleUploadThemeImage({}, broadcast, { theme_id: 'x_theme', item_id: 'environment' });
  await handleUploadThemeImage({}, broadcast, { theme_id: 'x_theme', item_id: 'environment', cancelled: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data.payload.ok, false);
  assert.equal(calls[1].data.payload.cancelled, true);
});

test('handleUploadThemeImage: non-image bytes and an over-length base64 body reply ok:false with an error message', async () => {
  const calls = [];
  const broadcast = (eventName, data) => calls.push({ eventName, data });
  await handleUploadThemeImage({}, broadcast, {
    theme_id: 'x_theme',
    item_id: 'environment',
    image_base64: Buffer.from('not an image at all').toString('base64'),
  });
  await handleUploadThemeImage({}, broadcast, {
    theme_id: 'x_theme',
    item_id: 'environment',
    image_base64: 'A'.repeat(40 * 1024 * 1024),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data.payload.ok, false);
  assert.match(calls[0].data.payload.error, /not a PNG, JPEG or WEBP/);
  assert.match(calls[1].data.payload.error, /larger than 25 MB/);
});
