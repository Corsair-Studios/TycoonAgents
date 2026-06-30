import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeThemeApproval } from '../src/extension/themeApproval';

test('theme export is ready only when every review item is accepted', () => {
  assert.deepEqual(summarizeThemeApproval(undefined), { total: 0, accepted: 0, export_ready: false });
  assert.deepEqual(summarizeThemeApproval([]), { total: 0, accepted: 0, export_ready: false });
  assert.deepEqual(
    summarizeThemeApproval([{ status: 'accepted' }, { status: 'pending' }]),
    { total: 2, accepted: 1, export_ready: false },
  );
  assert.deepEqual(
    summarizeThemeApproval([{ status: 'accepted' }, { status: 'accepted' }]),
    { total: 2, accepted: 2, export_ready: true },
  );
});
