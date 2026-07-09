import { test } from 'node:test';
import assert from 'node:assert/strict';

// themeService.ts does `import * as vscode from 'vscode'` at module scope (needed by
// other exports); mergeOwnedFrames itself never touches the vscode API, but Node can't
// resolve the 'vscode' module outside the real extension host. Stub the module loader
// so this file's require chain resolves under plain `node --test` — same trick as
// test/themeItemNames.test.ts / test/reviewSynthesis.test.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mergeOwnedFrames } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');

// Regression test for the bug where a background-decor board's freshly-regenerated
// art disappeared from the running game after the review UI showed it as accepted.
//
// Root cause: retryThemeImage/resliceThemeImageFromRaw (via applySlicedAtlasFromBuffer)
// load frames.json ONCE at the start of a board retry, then run a slow image-generation
// API call, and only afterwards write frames.json back. If a SECOND board retry (e.g. an
// object board) is in flight concurrently — having loaded its own frames.json snapshot
// BEFORE the first retry (e.g. decor) finished and saved — its eventual blind overwrite
// reverts the first retry's already-saved keys back to the stale snapshot it started
// with. mergeOwnedFrames is the fix: only the keys a retry actually owns are overlaid
// onto whatever is CURRENTLY on disk, so a slower sibling retry can't clobber another
// board's already-persisted frames.
test('mergeOwnedFrames preserves a sibling board\'s frames that were saved after this operation started', () => {
  // Snapshot this (slow, object-board) operation loaded at the START of its run —
  // decor keys still hold the OLD art at this point.
  const staleSnapshotFromLoad: Record<string, string[]> = {
    decor_seat_1: ['old-decor-art'],
    object_crate: ['old-crate-art'],
  };
  // While the object-board operation's image-gen API call was in flight, a decor
  // retry started AND finished, saving new decor art to disk.
  const currentOnDisk: Record<string, string[]> = {
    decor_seat_1: ['NEW-decor-art'],
    object_crate: ['old-crate-art'],
  };
  // The object-board operation now applies its own new art to its in-memory copy
  // (which still has the stale decor_seat_1 it loaded at the start) and owns only
  // its own key.
  const frames = { ...staleSnapshotFromLoad, object_crate: ['NEW-crate-art'] };
  const ownedFrameKeys = ['object_crate'];

  const merged = mergeOwnedFrames(currentOnDisk, frames, ownedFrameKeys);

  assert.deepEqual(merged.decor_seat_1, ['NEW-decor-art'], 'sibling board\'s newer art must survive');
  assert.deepEqual(merged.object_crate, ['NEW-crate-art'], 'this operation\'s own new art must be applied');
});

test('mergeOwnedFrames drops an owned key that this operation intentionally removed', () => {
  const currentOnDisk: Record<string, string[]> = {
    object_crate: ['crate-art'],
    poof: ['stale-poof-art'],
  };
  // Self-healing re-slice dropped 'poof' from this board's ownership (see
  // removeStaleBoardFrameKeys) — it's no longer present in the in-memory frames.
  const frames: Record<string, string[]> = { object_crate: ['new-crate-art'] };
  const ownedFrameKeys = ['object_crate', 'poof'];

  const merged = mergeOwnedFrames(currentOnDisk, frames, ownedFrameKeys);

  assert.deepEqual(merged.object_crate, ['new-crate-art']);
  assert.equal('poof' in merged, false, 'a key this operation dropped must not survive on disk');
});

test('mergeOwnedFrames leaves untouched keys exactly as they are on disk', () => {
  const currentOnDisk: Record<string, string[]> = {
    agent_0: ['agent-art'],
    environment_background: ['bg-art'],
  };
  const frames: Record<string, string[]> = { ...currentOnDisk, agent_0: ['ignored-stale-copy'] };
  const merged = mergeOwnedFrames(currentOnDisk, frames, ['environment_background']);

  assert.deepEqual(merged.agent_0, ['agent-art'], 'non-owned keys must come from disk, not the stale in-memory copy');
  assert.deepEqual(merged.environment_background, ['bg-art']);
});

test('mergeOwnedFrames falls back to the in-memory frames when nothing is on disk yet', () => {
  const frames: Record<string, string[]> = { agent_0: ['first-write'] };
  const merged = mergeOwnedFrames(undefined, frames, ['agent_0']);
  assert.deepEqual(merged, { agent_0: ['first-write'] });
});
