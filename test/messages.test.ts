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

test('SET_THEME_ITEM_DESCRIPTIONS schema: accepts projectile item_kind, including an empty (clearing) description', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_DESCRIPTIONS.safeParse({
    theme_id: 'cobra_command',
    board_id: 'background_decor',
    changes: [{ item_kind: 'projectile', id: 'projectile', description: 'A crackling blue energy bolt.' }],
  });
  assert.equal(result.success, true);
  const clearResult = MSG_SCHEMAS.SET_THEME_ITEM_DESCRIPTIONS.safeParse({
    theme_id: 'cobra_command',
    board_id: 'background_decor',
    changes: [{ item_kind: 'projectile', id: 'projectile', description: '' }],
  });
  assert.equal(clearResult.success, true);
});

test('SET_THEME_ITEM_NAMES schema: projectile item_kind fails (never renameable)', () => {
  const result = MSG_SCHEMAS.SET_THEME_ITEM_NAMES.safeParse({
    theme_id: 'cobra_command',
    changes: [{ item_kind: 'projectile', id: 'projectile', name: 'Bolt' }],
  });
  assert.equal(result.success, false);
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

// --- APPLY_DOCTOR_FIX -------------------------------------------------------
// Regression coverage for the removeForeign default/honor contract described
// at the schema's declaration site (messages.ts): omitting removeForeign
// must still default to true (an older/stale webview keeps removing foreign
// hooks), while an EXPLICIT false must be honored rather than overridden.
// These two are the critical pair — write them so a future accidental flip
// of `.default(true)` to `.default(false)` (or dropping the default
// entirely) fails loudly here first.

test('APPLY_DOCTOR_FIX schema: removeForeign absent parses to true (the safe default for stale webviews)', () => {
  const result = MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({});
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as { removeForeign: boolean }).removeForeign, true);
  }
});

test('APPLY_DOCTOR_FIX schema: an explicit false is honored as false, not overridden to the default', () => {
  const result = MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: false });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as { removeForeign: boolean }).removeForeign, false);
  }
});

test('APPLY_DOCTOR_FIX schema: an explicit true stays true', () => {
  const result = MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: true });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as { removeForeign: boolean }).removeForeign, true);
  }
});

test('APPLY_DOCTOR_FIX schema: non-boolean removeForeign values are rejected, never silently coerced', () => {
  assert.equal(MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: 'false' }).success, false, 'the string "false" must not parse as boolean false');
  assert.equal(MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: 0 }).success, false, 'the number 0 must not parse as boolean false');
  assert.equal(MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: 1 }).success, false, 'the number 1 must not parse as boolean true');
  assert.equal(MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: null }).success, false, 'null must not silently fall back to the default');
});

test('APPLY_DOCTOR_FIX schema: unknown keys are tolerated (passthrough)', () => {
  const result = MSG_SCHEMAS.APPLY_DOCTOR_FIX.safeParse({ removeForeign: false, futureField: 'ignored-by-older-hosts' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>)['futureField'], 'ignored-by-older-hosts');
  }
});

// --- LEGACY_ARTIFACTS_DETECTED ----------------------------------------------
// Outbound host->webview notification (see panel.ts's
// _detectLegacyArtifactsOnLoad + the MSG.READY handler). No MSG_SCHEMAS entry
// (that table only covers inbound mutating messages) — just guard the wire
// string itself, since the webview listener string-matches it by hand and a
// silent rename would break that listener without any type error.

test('MSG.LEGACY_ARTIFACTS_DETECTED wire string is stable ("legacyArtifactsDetected")', () => {
  assert.equal(MSG.LEGACY_ARTIFACTS_DETECTED, 'legacyArtifactsDetected');
});

// --- REPAIR_HOOK (deleted dead code) ----------------------------------------
// MSG.REPAIR_HOOK was removed as dead code alongside the
// cleanupForeignHookArtifacts removeForeignCommands fix (see
// test/hookInstall.test.ts). Guard against it silently reappearing.

test('MSG.REPAIR_HOOK no longer exists', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(MSG, 'REPAIR_HOOK'),
    false,
    'REPAIR_HOOK was deleted as dead code and must not be reintroduced',
  );
});

// --- REGENERATE_THEME_DESCRIPTIONS ------------------------------------------
// Re-derive every *_descriptions field from the plan's current
// creative_direction (see themeDescriptionsStale in themePlan.ts and
// regenerateThemeDescriptions in themeService.ts).

test('MSG.REGENERATE_THEME_DESCRIPTIONS and MSG.THEME_DESCRIPTIONS_REGENERATE_RESULT are stable, unique wire strings', () => {
  assert.equal(MSG.REGENERATE_THEME_DESCRIPTIONS, 'REGENERATE_THEME_DESCRIPTIONS');
  assert.equal(MSG.THEME_DESCRIPTIONS_REGENERATE_RESULT, 'THEME_DESCRIPTIONS_REGENERATE_RESULT');
});

test('media/main.js still posts REGENERATE_THEME_DESCRIPTIONS', () => {
  const src = readMainJs();
  assert.ok(
    src.includes(`"${MSG.REGENERATE_THEME_DESCRIPTIONS}"`) || src.includes(`'${MSG.REGENERATE_THEME_DESCRIPTIONS}'`),
    'media/main.js has drifted — expected literal REGENERATE_THEME_DESCRIPTIONS not found',
  );
});

test('REGENERATE_THEME_DESCRIPTIONS schema: valid payload round-trips', () => {
  const result = MSG_SCHEMAS.REGENERATE_THEME_DESCRIPTIONS.safeParse({ theme_id: 'test_theme' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.theme_id, 'test_theme');
  }
});

test('REGENERATE_THEME_DESCRIPTIONS schema: missing theme_id fails', () => {
  const result = MSG_SCHEMAS.REGENERATE_THEME_DESCRIPTIONS.safeParse({});
  assert.equal(result.success, false);
});

test('REGENERATE_THEME_DESCRIPTIONS schema: empty theme_id fails', () => {
  const result = MSG_SCHEMAS.REGENERATE_THEME_DESCRIPTIONS.safeParse({ theme_id: '' });
  assert.equal(result.success, false);
});

test('REGENERATE_THEME_DESCRIPTIONS schema: extra fields are tolerated (passthrough)', () => {
  const result = MSG_SCHEMAS.REGENERATE_THEME_DESCRIPTIONS.safeParse({
    theme_id: 'test_theme',
    futureField: 'ignored-by-older-hosts',
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>)['futureField'], 'ignored-by-older-hosts');
  }
});

// ── OPEN_THEME_BUILDER / THEME_BUILDER_OPENED (p40-t4) ──────────────────────
// Webview -> host OPEN_THEME_BUILDER (no payload) and the host -> webview
// THEME_BUILDER_OPENED reply ({ signedIn: boolean }); see
// src/host/vscode/messages.ts:262-269, panel.ts:1865-1869,
// standalone/src/server.mjs OPEN_THEME_BUILDER_WIRE.

test('MSG.OPEN_THEME_BUILDER and MSG.THEME_BUILDER_OPENED are stable, unique wire strings', () => {
  assert.equal(MSG.OPEN_THEME_BUILDER, 'OPEN_THEME_BUILDER');
  assert.equal(MSG.THEME_BUILDER_OPENED, 'THEME_BUILDER_OPENED');
  assert.notEqual(MSG.OPEN_THEME_BUILDER, MSG.THEME_BUILDER_OPENED);
});

test('media/main.js still posts OPEN_THEME_BUILDER and handles THEME_BUILDER_OPENED', () => {
  const src = readMainJs();
  assert.ok(
    src.includes(`"${MSG.OPEN_THEME_BUILDER}"`) || src.includes(`'${MSG.OPEN_THEME_BUILDER}'`),
    'media/main.js has drifted — expected literal "OPEN_THEME_BUILDER" not found',
  );
  assert.ok(
    src.includes(`"${MSG.THEME_BUILDER_OPENED}"`) || src.includes(`'${MSG.THEME_BUILDER_OPENED}'`),
    'media/main.js has drifted — expected literal "THEME_BUILDER_OPENED" not found',
  );
});

test('OPEN_THEME_BUILDER schema: no-payload message passes', () => {
  const result = MSG_SCHEMAS.OPEN_THEME_BUILDER.safeParse({});
  assert.equal(result.success, true);
});

test('OPEN_THEME_BUILDER schema: extra fields are tolerated (passthrough)', () => {
  const result = MSG_SCHEMAS.OPEN_THEME_BUILDER.safeParse({ futureField: 'ignored-by-older-hosts' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal((result.data as Record<string, unknown>)['futureField'], 'ignored-by-older-hosts');
  }
});

// ── THEME_SERVICE_* schemas (p42-t1/p42-t5) ─────────────────────────────────

test('THEME_SERVICE_GET_STATUS / THEME_SERVICE_GOOGLE_START / THEME_SERVICE_SIGN_OUT accept empty payloads', () => {
  for (const key of ['THEME_SERVICE_GET_STATUS', 'THEME_SERVICE_GOOGLE_START', 'THEME_SERVICE_SIGN_OUT'] as const) {
    const result = MSG_SCHEMAS[key].safeParse({});
    assert.equal(result.success, true, `${key} should accept an empty payload`);
  }
});

test('THEME_SERVICE_REQUEST_MAGIC_LINK schema: requires non-empty email', () => {
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_REQUEST_MAGIC_LINK.safeParse({ email: 'a@b.com' }).success, true);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_REQUEST_MAGIC_LINK.safeParse({ email: '' }).success, false);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_REQUEST_MAGIC_LINK.safeParse({}).success, false);
});

test('THEME_SERVICE_VERIFY schema: requires email and code', () => {
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_VERIFY.safeParse({ email: 'a@b.com', code: '123456' }).success, true);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_VERIFY.safeParse({ email: 'a@b.com' }).success, false);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_VERIFY.safeParse({ code: '123456' }).success, false);
});

test('THEME_SERVICE_GOOGLE_COMPLETE schema: code is optional (empty-submit guard)', () => {
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_GOOGLE_COMPLETE.safeParse({}).success, true);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_GOOGLE_COMPLETE.safeParse({ code: 'abc' }).success, true);
});

test('THEME_SERVICE_BUY_CREDITS schema: requires non-empty pack id', () => {
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_BUY_CREDITS.safeParse({ pack: 'starter45' }).success, true);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_BUY_CREDITS.safeParse({ pack: '' }).success, false);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_BUY_CREDITS.safeParse({}).success, false);
});

test('THEME_SERVICE_STATUS schema: minimal signed-out and full signed-in payloads pass, non-boolean signedIn fails', () => {
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_STATUS.safeParse({ signedIn: false }).success, true);
  const full = {
    signedIn: true,
    email: 'a@b.com',
    provider: 'email',
    credits: 12,
    pricing: { typicalTheme: { min: 8, max: 20 }, packs: [] },
    pendingCheckout: false,
    error: { kind: 'unreachable', message: 'down' },
  };
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_STATUS.safeParse(full).success, true);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_STATUS.safeParse({ signedIn: 'yes' }).success, false);
  assert.equal(MSG_SCHEMAS.THEME_SERVICE_STATUS.safeParse({}).success, false);
});

test('THEME_SERVICE_STATUS schema payload never needs to carry token fields (accessToken/refreshToken not required or special-cased)', () => {
  const withTokenLikeExtra = { signedIn: true, accessToken: 'should-not-be-here' };
  const result = MSG_SCHEMAS.THEME_SERVICE_STATUS.safeParse(withTokenLikeExtra);
  // passthrough() means the schema itself doesn't strip it — the contract that
  // no token ever reaches this payload is enforced by themeServiceHost.ts
  // (see test/themeServiceHost.test.ts assertNoTokenLeak), not by this schema.
  assert.equal(result.success, true);
});
