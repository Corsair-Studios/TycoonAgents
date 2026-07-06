import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRetryNotes, selectThemeImageRetryPrompt } from '../src/extension/themeImageRetry';

test('retry mode reuses the saved prompt verbatim without notes', () => {
  const savedPrompt = 'Original prompt\nwith exact formatting.  ';
  assert.equal(
    selectThemeImageRetryPrompt(savedPrompt, 'replacement', '', 'retry'),
    savedPrompt,
  );
});

test('retry mode rejects legacy images without a saved prompt', () => {
  assert.throws(
    () => selectThemeImageRetryPrompt(undefined, 'replacement', '', 'retry'),
    /no saved prompt/i,
  );
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
  assert.equal(sanitizeRetryNotes('  make the sky more blue  '), 'make the sky more blue');
  assert.equal(sanitizeRetryNotes(''), '');
});

test('sanitizeRetryNotes salvages the trailing creative-direction block from a pasted full prompt', () => {
  const pastedPrompt = [
    'Create one 512 x 512 sprite board on a solid magenta background.',
    'Cell 1: idle pose facing right.',
    'Cell 2: walk cycle frame one.',
    'Creative direction: a grizzled space pirate with a cybernetic eye.',
  ].join('\n');
  assert.equal(
    sanitizeRetryNotes(pastedPrompt),
    'a grizzled space pirate with a cybernetic eye.',
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
  assert.equal(
    sanitizeRetryNotes(pastedPrompt),
    'the latest and correct direction.',
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
  assert.equal(
    sanitizeRetryNotes(longNotes),
    'keep the same silhouette.',
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
  assert.equal(
    selectThemeImageRetryPrompt('Original', 'replacement', sanitized, 'augment'),
    'Original\n\nREVISION NOTES — correct the previous result:\ngive the character a red scarf.',
  );
});
