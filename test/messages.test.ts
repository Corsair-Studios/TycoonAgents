import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MSG, MSG_SCHEMAS } from '../src/host/vscode/messages';

// media/main.js is a hand-edited browser file that cannot import messages.ts
// (it's an untyped, non-bundled IIFE). It matches these wire strings by hand,
// so this is a drift guard, same trick as test/mainPanelClips.test.ts: read
// the file and assert a few representative literals still appear verbatim.
function readMainJs(): string {
  return readFileSync(join(process.cwd(), 'media', 'main.js'), 'utf8');
}

test('MSG values are all unique wire strings', () => {
  const values = Object.values(MSG);
  const unique = new Set(values);
  assert.equal(unique.size, values.length, 'MSG contains duplicate wire strings');
});

test('media/main.js still uses a representative sample of MSG wire strings', () => {
  const src = readMainJs();
  const spotChecks: Array<[string, string]> = [
    ['BADGE_UNLOCKED', MSG.BADGE_UNLOCKED],
    ['installSkill', MSG.INSTALL_SKILL],
    ['DELETE_THEME', MSG.DELETE_THEME],
    ['SAVE_STAGE_TUNING', MSG.SAVE_STAGE_TUNING],
    ['setAgentModel', MSG.SET_AGENT_MODEL],
    ['SET_THEME_ITEM_NAMES', MSG.SET_THEME_ITEM_NAMES],
    ['SET_THEME_CREATIVE_DIRECTION', MSG.SET_THEME_CREATIVE_DIRECTION],
  ];
  for (const [label, wire] of spotChecks) {
    assert.ok(
      src.includes(`"${wire}"`) || src.includes(`'${wire}'`),
      `media/main.js has drifted — expected literal "${wire}" (${label}) not found`,
    );
  }
});

test('SET_AGENT_MODEL schema: valid payload passes', () => {
  const result = MSG_SCHEMAS.SET_AGENT_MODEL.safeParse({ type: 'setAgentModel', id: 'search-retrieval', model: 'haiku' });
  assert.equal(result.success, true);
});

test('SET_AGENT_MODEL schema: missing required field fails', () => {
  const result = MSG_SCHEMAS.SET_AGENT_MODEL.safeParse({ type: 'setAgentModel', id: 'search-retrieval' });
  assert.equal(result.success, false);
});

test('SET_AGENT_MODEL schema: extra fields are tolerated (passthrough)', () => {
  const result = MSG_SCHEMAS.SET_AGENT_MODEL.safeParse({
    type: 'setAgentModel',
    id: 'search-retrieval',
    model: 'haiku',
    futureField: 'ignored-by-older-hosts',
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>)['futureField'], 'ignored-by-older-hosts');
  }
});

test('ID_ONLY schema: valid payload passes, missing id fails', () => {
  assert.equal(MSG_SCHEMAS.ID_ONLY.safeParse({ type: 'removeSkill', id: 'theme-builder' }).success, true);
  assert.equal(MSG_SCHEMAS.ID_ONLY.safeParse({ type: 'removeSkill' }).success, false);
  assert.equal(MSG_SCHEMAS.ID_ONLY.safeParse({ type: 'removeSkill', id: '' }).success, false);
});

test('DELETE_THEME schema: valid payload passes, missing theme_id fails', () => {
  assert.equal(MSG_SCHEMAS.DELETE_THEME.safeParse({ theme_id: 'cobra_command' }).success, true);
  assert.equal(MSG_SCHEMAS.DELETE_THEME.safeParse({}).success, false);
  assert.equal(MSG_SCHEMAS.DELETE_THEME.safeParse(undefined).success, false);
});

test('BADGE_UNLOCKED schema: valid payload passes, partial payload fails', () => {
  assert.equal(
    MSG_SCHEMAS.BADGE_UNLOCKED.safeParse({ theme_id: 'cobra_command', badge_id: 'first_build' }).success,
    true,
  );
  assert.equal(MSG_SCHEMAS.BADGE_UNLOCKED.safeParse({ theme_id: 'cobra_command' }).success, false);
});

test('RENAME_THEME_CHARACTER schema: valid payload passes, extra fields tolerated', () => {
  const result = MSG_SCHEMAS.RENAME_THEME_CHARACTER.safeParse({
    theme_id: 'cobra_command',
    item_id: 'char_01',
    name: 'Vex',
    unknownFutureField: 42,
  });
  assert.equal(result.success, true);
});

test('RENAME_THEME_CHARACTER schema: missing item_id fails', () => {
  const result = MSG_SCHEMAS.RENAME_THEME_CHARACTER.safeParse({ theme_id: 'cobra_command', name: 'Vex' });
  assert.equal(result.success, false);
});

test('SET_THEME_ITEM_NAMES schema: valid batch passes', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    board_id: 'objects_01',
    changes: [
      { item_kind: 'object', id: 'crate_01', name: 'Supply Crate' },
      { item_kind: 'decor', id: 'seat_01', name: 'Camp Chair' },
    ],
  });
  assert.equal(result.success, true);
});

test('SET_THEME_ITEM_NAMES schema: empty changes array fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    board_id: 'objects_01',
    changes: [],
  });
  assert.equal(result.success, false);
});

test('SET_THEME_ITEM_NAMES schema: unknown item_kind fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    changes: [{ item_kind: 'sprocket', id: 'crate_01', name: 'Supply Crate' }],
  });
  assert.equal(result.success, false);
});

test('SET_THEME_ITEM_NAMES schema: name over 60 characters fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    changes: [{ item_kind: 'object', id: 'crate_01', name: 'x'.repeat(61) }],
  });
  assert.equal(result.success, false);
});

// SET_THEME_ITEM_NAMES deliberately has NO 'crate'/'poof' item_kind — the
// build crate and poof effect are never renamed (description-only, via
// SET_THEME_ITEM_DESCRIPTIONS below).
test('SET_THEME_ITEM_NAMES schema: crate/poof item_kind fails (never renameable)', () => {
  const crateResult = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    changes: [{ item_kind: 'crate', id: 'crate', name: 'Supply Crate' }],
  });
  assert.equal(crateResult.success, false);
  const poofResult = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    changes: [{ item_kind: 'poof', id: 'poof', name: 'Poof' }],
  });
  assert.equal(poofResult.success, false);
});

test('SET_THEME_ITEM_DESCRIPTIONS schema: accepts crate/poof item_kind, including an empty (clearing) description', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_DESCRIPTIONS.safeParse({
    theme_id: 'cobra_command',
    board_id: 'objects_02',
    changes: [
      { item_kind: 'crate', id: 'crate', description: 'A reinforced steel crate with hazard stripes.' },
      { item_kind: 'poof', id: 'poof', description: '' },
    ],
  });
  assert.equal(result.success, true);
});

test('SET_THEME_ITEM_DESCRIPTIONS schema: accepts badge item_kind (positional achievement descriptions)', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_DESCRIPTIONS.safeParse({
    theme_id: 'cobra_command',
    board_id: 'achievements',
    changes: [{ item_kind: 'badge', id: 'achievement_0', description: 'A gold laurel wreath around a hammer.' }],
  });
  assert.equal(result.success, true);
});

test('SET_THEME_ITEM_DESCRIPTIONS schema: unknown item_kind still fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_DESCRIPTIONS.safeParse({
    theme_id: 'cobra_command',
    changes: [{ item_kind: 'sticker', id: 'achievement_0', description: 'x' }],
  });
  assert.equal(result.success, false);
});

test('RESET_THEME_BADGE_NAMES schema: valid payload passes, missing theme_id fails', () => {
  assert.equal(MSG_SCHEMAS.RESET_THEME_BADGE_NAMES.safeParse({ theme_id: 'cobra_command' }).success, true);
  assert.equal(MSG_SCHEMAS.RESET_THEME_BADGE_NAMES.safeParse({}).success, false);
});

// --- SET_THEME_CREATIVE_DIRECTION / THEME_CREATIVE_DIRECTION_RESULT ---------
// Post-generation "Creative Direction" editor (see themeService.
// updateThemeCreativeDirection). MSG_SCHEMAS only validates MUTATING inbound
// messages (see the module's own doc comment) — THEME_CREATIVE_DIRECTION_RESULT
// is an outbound host->webview reply, so like every other *_RESULT message in
// this file (e.g. THEME_ITEM_DESCRIPTIONS_RESULT) it has no schema entry;
// it's covered here only as a wire-string/uniqueness check.

test('SET_THEME_CREATIVE_DIRECTION schema: valid payload passes', () => {
  const result = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse({
    theme_id: 'cobra_command',
    creative_direction: 'a grizzled space pirate with a cybernetic eye',
  });
  assert.equal(result.success, true);
});

test('SET_THEME_CREATIVE_DIRECTION schema: an empty creative_direction string still passes (emptiness is rejected by themeService, not the wire schema)', () => {
  const result = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse({
    theme_id: 'cobra_command',
    creative_direction: '',
  });
  assert.equal(result.success, true);
});

test('SET_THEME_CREATIVE_DIRECTION schema: missing theme_id fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse({
    creative_direction: 'a grizzled space pirate',
  });
  assert.equal(result.success, false);
});

test('SET_THEME_CREATIVE_DIRECTION schema: missing creative_direction fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse({ theme_id: 'cobra_command' });
  assert.equal(result.success, false);
});

test('SET_THEME_CREATIVE_DIRECTION schema: non-string creative_direction fails', () => {
  const result = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse({
    theme_id: 'cobra_command',
    creative_direction: 42,
  });
  assert.equal(result.success, false);
});

test('SET_THEME_CREATIVE_DIRECTION schema: extra fields are tolerated (passthrough)', () => {
  const result = MSG_SCHEMAS.SET_THEME_CREATIVE_DIRECTION.safeParse({
    theme_id: 'cobra_command',
    creative_direction: 'a grizzled space pirate',
    futureField: 'ignored-by-older-hosts',
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>)['futureField'], 'ignored-by-older-hosts');
  }
});

test('MSG carries both the SET_THEME_CREATIVE_DIRECTION request and THEME_CREATIVE_DIRECTION_RESULT reply wire strings', () => {
  assert.equal(MSG.SET_THEME_CREATIVE_DIRECTION, 'SET_THEME_CREATIVE_DIRECTION');
  assert.equal(MSG.THEME_CREATIVE_DIRECTION_RESULT, 'THEME_CREATIVE_DIRECTION_RESULT');
});
