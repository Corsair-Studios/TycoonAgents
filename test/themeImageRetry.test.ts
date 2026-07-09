import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRetryNotes, selectThemeImageRetryPrompt } from '../src/extension/themeImageRetry';

test('retry mode rerolls the fresh current-template base, ignoring feedback', () => {
  const freshBasePrompt = 'Fresh base prompt\nbuilt from the CURRENT template + manifest.  ';
  assert.equal(
    selectThemeImageRetryPrompt(freshBasePrompt, 'replacement', 'ignored feedback', 'retry'),
    freshBasePrompt,
  );
});

test('retry mode never fails for "no saved prompt" — a fresh base is always available', () => {
  // Previously 'retry' replayed the saved item.prompt verbatim and threw when
  // it was missing/blank. Now it always rebuilds from the current template +
  // manifest (see themeService.retryThemeImage), so an empty base string is
  // simply returned rather than treated as an error condition.
  assert.equal(selectThemeImageRetryPrompt('', 'replacement', '', 'retry'), '');
});

test('note-based retry modes still require feedback', () => {
  assert.throws(
    () => selectThemeImageRetryPrompt('Original', 'replacement', '  ', 'augment'),
    /add retry instructions/i,
  );
  assert.equal(
    selectThemeImageRetryPrompt('Original', 'replacement', 'make it blue', 'augment'),
    'Original\n\nREVISION NOTES — correct the previous result:\nmake it blue',
  );
  assert.equal(
    selectThemeImageRetryPrompt('Original', 'replacement', 'new direction', 'replace'),
    'replacement',
  );
});

test('sanitizeRetryNotes passes normal notes through unchanged', () => {
  assert.deepEqual(
    sanitizeRetryNotes('  make the sky more blue  '),
    { notes: 'make the sky more blue', trimmed: false },
  );
  assert.deepEqual(sanitizeRetryNotes(''), { notes: '', trimmed: false });
});

test('sanitizeRetryNotes salvages the trailing creative-direction block from a pasted full prompt', () => {
  const pastedPrompt = [
    'Create one 512 x 512 sprite board on a solid magenta background.',
    'Cell 1: idle pose facing right.',
    'Cell 2: walk cycle frame one.',
    'Creative direction: a grizzled space pirate with a cybernetic eye.',
  ].join('\n');
  assert.deepEqual(
    sanitizeRetryNotes(pastedPrompt),
    { notes: 'a grizzled space pirate with a cybernetic eye.', trimmed: true },
  );
});

test('sanitizeRetryNotes uses the LAST creative-direction marker when a prompt was pasted more than once', () => {
  const pastedPrompt = [
    'Create one 512 x 512 sprite sheet on a solid magenta background.',
    'Cell 1: idle pose.',
    'Cell 2: walk frame.',
    'Creative direction: first stale direction, ignore this.',
    'Creative direction: the latest and correct direction.',
  ].join('\n');
  assert.deepEqual(
    sanitizeRetryNotes(pastedPrompt),
    { notes: 'the latest and correct direction.', trimmed: true },
  );
});

test('sanitizeRetryNotes throws a clear error when a pasted full prompt has nothing salvageable', () => {
  const pastedPrompt = [
    'Create one 512 x 512 character atlas on a solid magenta background.',
    'Cell 1: idle pose facing right.',
    'Cell 2: walk cycle frame one.',
  ].join('\n');
  assert.throws(
    () => sanitizeRetryNotes(pastedPrompt),
    /full generation prompt/i,
  );
});

test('sanitizeRetryNotes flags notes over the 4000-char cap and throws when nothing is salvageable', () => {
  const longNotes = 'x'.repeat(4001);
  assert.throws(
    () => sanitizeRetryNotes(longNotes),
    /full generation prompt/i,
  );
});

test('sanitizeRetryNotes salvages the tail even when the pasted prompt only trips the length cap', () => {
  const longNotes = `${'filler text '.repeat(400)}Creative direction: keep the same silhouette.`;
  assert.ok(longNotes.length > 4000);
  assert.deepEqual(
    sanitizeRetryNotes(longNotes),
    { notes: 'keep the same silhouette.', trimmed: true },
  );
});

test('sanitized notes feed into augment mode the same way as hand-typed notes', () => {
  const pastedPrompt = [
    'Create one 512 x 512 sprite board on a solid magenta background.',
    'Cell 1: idle pose facing right.',
    'Cell 2: walk cycle frame one.',
    'Creative direction: give the character a red scarf.',
  ].join('\n');
  const sanitized = sanitizeRetryNotes(pastedPrompt);
  assert.equal(sanitized.trimmed, true);
  assert.equal(
    selectThemeImageRetryPrompt('Original', 'replacement', sanitized.notes, 'augment'),
    'Original\n\nREVISION NOTES — correct the previous result:\ngive the character a red scarf.',
  );
});
