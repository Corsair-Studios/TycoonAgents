import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectThemeImageRetryPrompt } from '../src/extension/themeImageRetry';

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
