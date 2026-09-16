import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWalkPoseGuide, POSE_GUIDE_FILES } from '../src/extension/poseGuides';

// A minimal valid 1x1 transparent PNG.
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeExtensionRoot(withBiped: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'pose-guides-test-'));
  mkdirSync(join(root, 'media', 'pose-guides'), { recursive: true });
  if (withBiped) {
    writeFileSync(
      join(root, POSE_GUIDE_FILES.biped),
      Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64')
    );
  }
  return root;
}

test('loadWalkPoseGuide returns a data URL for a present PNG', () => {
  const root = makeExtensionRoot(true);
  try {
    const dataUrl = loadWalkPoseGuide(root, 'biped');
    assert.ok(dataUrl, 'expected a data URL');
    assert.ok(dataUrl!.startsWith('data:image/png;base64,'));
    const base64 = dataUrl!.slice('data:image/png;base64,'.length);
    assert.equal(base64, ONE_PIXEL_PNG_BASE64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadWalkPoseGuide returns null when the PNG is missing', () => {
  const root = makeExtensionRoot(true); // only biped present, not quadruped
  try {
    const result = loadWalkPoseGuide(root, 'quadruped');
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadWalkPoseGuide caches the result and does not re-read a changed file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pose-guides-test-cache-'));
  mkdirSync(join(root, 'media', 'pose-guides'), { recursive: true });
  const filePath = join(root, POSE_GUIDE_FILES.quadruped);
  writeFileSync(filePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
  try {
    const first = loadWalkPoseGuide(root, 'quadruped');
    assert.ok(first);

    // Mutate the file on disk; a cached call must not observe this change.
    writeFileSync(filePath, Buffer.from('not a real png at all', 'utf8'));

    const second = loadWalkPoseGuide(root, 'quadruped');
    assert.equal(second, first, 'expected cached value, not a re-read of the mutated file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
