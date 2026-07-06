import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { createThemeArchive, parseThemeArchive } from '../src/extension/themeArchive';
import { BADGE_TRIGGER_TYPES } from '../src/shared/types';

const encoder = new TextEncoder();

function themeFiles(): Map<string, Uint8Array> {
  const manifest = {
    manifest_version: '1.0.0',
    theme_id: 'space_station',
    display_name: 'Space Station',
    author: 'Test',
    viewport: {
      native_width: 800,
      native_height: 600,
      background_asset: 'environment_background',
      walkable_nav_polygon: [[0, 0], [800, 0], [800, 600], [0, 600]],
    },
    roster_agents: [],
    roster_rivals: [],
    buildable_objects: [],
    badges: [],
  };
  return new Map([
    ['manifest.json', encoder.encode(JSON.stringify(manifest))],
    ['frames.json', encoder.encode(JSON.stringify({ agent_0: ['data:image/png;base64,abc'] }))],
    ['images/agent_0.png', new Uint8Array([1, 2, 3])],
  ]);
}

test('theme archive round-trips all theme files', () => {
  const parsed = parseThemeArchive(createThemeArchive(themeFiles()));

  assert.equal(parsed.themeId, 'space_station');
  assert.equal(parsed.displayName, 'Space Station');
  assert.deepEqual([...parsed.files.keys()], ['manifest.json', 'frames.json', 'images/agent_0.png']);
  assert.deepEqual(parsed.files.get('images/agent_0.png'), new Uint8Array([1, 2, 3]));
});

test('theme archive accepts one enclosing directory', () => {
  const nested = new Map([...themeFiles()].map(([path, bytes]) => [`space_station/${path}`, bytes]));
  const parsed = parseThemeArchive(createThemeArchive(nested));

  assert.equal(parsed.themeId, 'space_station');
  assert.ok(parsed.files.has('manifest.json'));
  assert.ok(parsed.files.has('images/agent_0.png'));
});

test('theme archive rejects path traversal', () => {
  const archive = zipSync({
    '../manifest.json': encoder.encode('{}'),
    'frames.json': encoder.encode('{}'),
  });

  assert.throws(() => parseThemeArchive(archive), /unsafe path/);
});

test('theme archive rejects paths that collide on case-insensitive filesystems', () => {
  const files = themeFiles();
  files.set('images/AGENT_0.png', new Uint8Array([4, 5, 6]));

  assert.throws(() => parseThemeArchive(createThemeArchive(files)), /duplicate path/);
});

test('theme archive accepts a badge of every trigger type in BADGE_TRIGGER_TYPES, rejects an unknown one', () => {
  const badgeFor = (triggerType: string, index: number) => ({
    badge_id: `badge_${index}`,
    display_name: `Badge ${index}`,
    description: `Earned via ${triggerType}.`,
    trigger_type: triggerType,
    threshold: 1,
    icon_asset: `frames.json#achievement_${index}`,
  });

  // One badge per valid trigger type (covers TASKS_COMPLETED/AGENTS_ACTIVE/
  // REBIRTH_COUNT/OBJECTS_BUILT_POST_REBIRTH, which the old hardcoded
  // two-element list wrongly rejected) — the archive must round-trip.
  const files = themeFiles();
  const validManifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString('utf8'));
  files.set('manifest.json', encoder.encode(JSON.stringify({
    ...validManifest,
    badges: BADGE_TRIGGER_TYPES.map((triggerType, index) => badgeFor(triggerType, index)),
  })));
  const parsed = parseThemeArchive(createThemeArchive(files));
  assert.equal(parsed.themeId, 'space_station');

  // An unknown trigger_type still fails manifest validation.
  files.set('manifest.json', encoder.encode(JSON.stringify({
    ...validManifest,
    badges: [badgeFor('NOT_A_REAL_TRIGGER', 0)],
  })));
  assert.throws(() => parseThemeArchive(createThemeArchive(files)), /does not match/);
});

test('theme archive rejects invalid required theme data', () => {
  const files = themeFiles();
  files.set('manifest.json', encoder.encode(JSON.stringify({ theme_id: '../bad', display_name: 'Bad' })));
  assert.throws(() => parseThemeArchive(createThemeArchive(files)), /invalid theme_id/);

  const validManifest = JSON.parse(Buffer.from(themeFiles().get('manifest.json')!).toString('utf8'));
  files.set('manifest.json', encoder.encode(JSON.stringify({ ...validManifest, theme_id: 'good', display_name: 'Good' })));
  files.set('frames.json', encoder.encode(JSON.stringify({ agent_0: [42] })));
  assert.throws(() => parseThemeArchive(createThemeArchive(files)), /arrays of strings/);
});
