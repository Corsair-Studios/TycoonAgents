/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// Guards the actual shipped bundle at media/themes/<theme_id>/, which
// src/host/vscode/bundledThemeSeeds.ts (see its readDirectory/readFile calls
// around lines 50-75) reads directly off disk at first-run activation: it
// walks media/themes/*, and for each directory expects exactly
// manifest.json (with a theme_id) and frames.json -- nothing else. Any other
// file (images/, images/raw/, plan.json, review.json, .bak sidecars, ...)
// is neither read by that seeding code nor stripped by it, so if someone
// later copies raw art or planning artifacts into this directory they'd
// ship in the VSIX unnoticed. This test fails loudly if that happens.

const THEME_IDS = ['catopia', 'doggo_tycoon'] as const;

for (const THEME_ID of THEME_IDS) {
  const THEME_DIR = path.resolve(__dirname, '..', '..', 'media', 'themes', THEME_ID);

  test(`bundled theme media/themes/${THEME_ID}/manifest.json parses with the expected theme_id`, async () => {
    const raw = await fsp.readFile(path.join(THEME_DIR, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as { theme_id?: string };
    assert.equal(manifest.theme_id, THEME_ID, 'manifest theme_id must match the seed directory name');
  });

  test(`bundled theme ${THEME_ID} frames.json parses and contains a non-trivial number of frame entries`, async () => {
    const raw = await fsp.readFile(path.join(THEME_DIR, 'frames.json'), 'utf8');
    const frames = JSON.parse(raw) as Record<string, unknown[]>;
    const keys = Object.keys(frames);
    assert.ok(keys.length > 20, `expected many frame-set keys, got ${keys.length}`);

    let totalFrameEntries = 0;
    for (const key of keys) {
      const value = frames[key];
      assert.ok(Array.isArray(value), `frame set "${key}" must be an array`);
      totalFrameEntries += value.length;
    }
    assert.ok(totalFrameEntries > 100, `expected a non-trivial total frame count, got ${totalFrameEntries}`);
  });

  test(`bundled theme seed directory ${THEME_ID} contains ONLY manifest.json and frames.json`, async () => {
    const entries = await fsp.readdir(THEME_DIR, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    assert.deepEqual(
      names,
      ['frames.json', 'manifest.json'],
      `media/themes/${THEME_ID} must ship ONLY manifest.json + frames.json -- ` +
        'no images/, images/raw/, plan.json, review.json, or backup sidecars. ' +
        'bundledThemeSeeds.ts only ever reads those two files; anything else here ' +
        'ships in the VSIX unread and unstripped.',
    );
  });
}
