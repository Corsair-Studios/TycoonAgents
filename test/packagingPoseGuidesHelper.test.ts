import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPoseGuidesPackaged } from './packagingPoseGuidesHelper';

test('checkPoseGuidesPackaged skips (ran: false) when no repo PNGs exist', () => {
  const result = checkPoseGuidesPackaged([], ['extension/media/pose-guides/README.md']);
  assert.equal(result.ran, false);
  assert.deepEqual(result.missingFromVsix, []);
});

test('checkPoseGuidesPackaged passes when every repo PNG is in the VSIX', () => {
  const result = checkPoseGuidesPackaged(
    ['humanoid-walk-reference.png', 'quadruped-walk-reference.png'],
    [
      'extension/media/pose-guides/humanoid-walk-reference.png',
      'extension/media/pose-guides/quadruped-walk-reference.png',
    ],
  );
  assert.equal(result.ran, true);
  assert.deepEqual(result.missingFromVsix, []);
});

test('checkPoseGuidesPackaged flags a repo PNG missing from the VSIX', () => {
  const result = checkPoseGuidesPackaged(
    ['humanoid-walk-reference.png', 'quadruped-walk-reference.png'],
    ['extension/media/pose-guides/humanoid-walk-reference.png'],
  );
  assert.equal(result.ran, true);
  assert.deepEqual(result.missingFromVsix, ['extension/media/pose-guides/quadruped-walk-reference.png']);
});
