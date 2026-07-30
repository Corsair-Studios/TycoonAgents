/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { MSG, MSG_SCHEMAS } from '../src/host/vscode/messages';

// Coverage for the roster-order persistence fix (src/host/vscode/panel.ts
// ~2457-2521): a per-(project, theme) roster-order store (roster-order.json
// in globalStorage), keyed via writeComposite/readCompositeWithMigration
// exactly like the existing build-progress store. panel.ts does
// `import * as vscode from "vscode"` at module scope, so — same technique
// as test/panelBridgeStaleness.test.ts and test/themeFramesWriteMutex.test.ts
// — the module loader is patched to hand back a real-fs-backed vscode stub
// before requiring the compiled panel.js, and the REAL prototype methods are
// invoked directly against a minimal fake `this` carrying only the state
// they touch (_globalStorageUri, _projectScopeKey, and sibling methods).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;

class FakeUri {
  readonly fsPath: string;
  readonly path: string;
  constructor(fsPath: string) {
    this.fsPath = fsPath;
    this.path = fsPath.split(path.sep).join('/');
  }
  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }
  static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return new FakeUri(path.join(base.fsPath, ...segments.map((s) => s.split('/').join(path.sep))));
  }
}

function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {
    Uri: FakeUri,
    workspace: {
      fs: {
        async readFile(uri: FakeUri): Promise<Uint8Array> {
          return fsp.readFile(uri.fsPath);
        },
        async writeFile(uri: FakeUri, data: Uint8Array): Promise<void> {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, Buffer.from(data));
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in t)) {
        t[prop] = new Proxy(function stub() {}, handler);
      }
      return t[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy(target, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require('../src/host/vscode/panel') as typeof import('../src/host/vscode/panel');

const P = TycoonPanel.prototype as any;

// Roster-order-only method set: what saveRosterOrder/getRosterOrder/
// _removeThemeRosterOrder actually touch on `this`.
const ROSTER_METHODS = {
  _rosterOrderUri: P._rosterOrderUri,
  _readRosterOrderStore: P._readRosterOrderStore,
  _writeRosterOrderStore: P._writeRosterOrderStore,
  getRosterOrder: P.getRosterOrder,
  saveRosterOrder: P.saveRosterOrder,
  _removeThemeRosterOrder: P._removeThemeRosterOrder,
};

// _buildThemeInitPayload also calls getUnlockedBadges / getRebirthState /
// getBuildProgress, each backed by its own file store — wire up the real
// methods for those too so the payload build runs the actual production
// code path end to end.
const INIT_PAYLOAD_METHODS = {
  ...ROSTER_METHODS,
  _badgeUnlocksUri: P._badgeUnlocksUri,
  _readBadgeUnlocksStore: P._readBadgeUnlocksStore,
  _writeBadgeUnlocksStore: P._writeBadgeUnlocksStore,
  getUnlockedBadges: P.getUnlockedBadges,
  _rebirthStateUri: P._rebirthStateUri,
  _readRebirthStore: P._readRebirthStore,
  _writeRebirthStore: P._writeRebirthStore,
  getRebirthState: P.getRebirthState,
  _buildProgressUri: P._buildProgressUri,
  _readBuildProgressStore: P._readBuildProgressStore,
  _writeBuildProgressStore: P._writeBuildProgressStore,
  getBuildProgress: P.getBuildProgress,
  _buildThemeInitPayload: P._buildThemeInitPayload,
};

function fakePanel(globalStorageUri: FakeUri, scopeKey: string, methods: Record<string, unknown>): any {
  return {
    _globalStorageUri: globalStorageUri,
    _projectScopeKey: () => scopeKey,
    _currentThemeId: undefined as string | undefined,
    ...methods,
  };
}

async function tmpStorageUri(prefix: string): Promise<{ uri: FakeUri; root: string; cleanup: () => Promise<void> }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return { uri: FakeUri.file(root), root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 1. Store round-trip, scoped by theme AND by project scope key.
// ---------------------------------------------------------------------------

test('saveRosterOrder/getRosterOrder round-trip, isolated by theme id and by project scope key', async () => {
  const { uri, cleanup } = await tmpStorageUri('tycoon-roster-roundtrip-');
  try {
    const scopeA = fakePanel(uri, 'scopeA', ROSTER_METHODS);
    const scopeB = fakePanel(uri, 'scopeB', ROSTER_METHODS);

    await scopeA.saveRosterOrder('theme1', ['agent_c', 'agent_a', 'agent_b']);
    await scopeA.saveRosterOrder('theme2', ['agent_x']);
    await scopeB.saveRosterOrder('theme1', ['agent_z']);

    assert.deepEqual(await scopeA.getRosterOrder('theme1'), ['agent_c', 'agent_a', 'agent_b']);
    assert.deepEqual(await scopeA.getRosterOrder('theme2'), ['agent_x']);
    // Same theme id, different project scope -> a genuinely different entry.
    assert.deepEqual(await scopeB.getRosterOrder('theme1'), ['agent_z']);
    // Never saved for this (scope, theme) pair -> cold, not a leak from scopeA.
    assert.equal(await scopeB.getRosterOrder('theme2'), null);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Sanitization: non-strings dropped, >64 entries capped, non-array
//    payload never throws.
// ---------------------------------------------------------------------------

test('saveRosterOrder drops non-string entries and caps to 64', async () => {
  const { uri, cleanup } = await tmpStorageUri('tycoon-roster-sanitize-');
  try {
    const panel = fakePanel(uri, 'scopeA', ROSTER_METHODS);

    await panel.saveRosterOrder('theme1', ['a', 123, null, 'b', undefined, {}, 'c', [], true]);
    assert.deepEqual(await panel.getRosterOrder('theme1'), ['a', 'b', 'c']);

    const oversized = Array.from({ length: 100 }, (_, i) => `agent_${i}`);
    await panel.saveRosterOrder('theme2', oversized);
    const stored = await panel.getRosterOrder('theme2');
    assert.equal(stored!.length, 64);
    assert.deepEqual(stored, oversized.slice(0, 64));
  } finally {
    await cleanup();
  }
});

test('saveRosterOrder never throws on a non-array payload and persists an empty order', async () => {
  const { uri, cleanup } = await tmpStorageUri('tycoon-roster-garbage-');
  try {
    const panel = fakePanel(uri, 'scopeA', ROSTER_METHODS);
    const garbageValues: unknown[] = ['just-a-string', 42, { not: 'an-array' }, null, undefined, true];

    for (const [i, garbage] of garbageValues.entries()) {
      const themeId = `garbage_theme_${i}`;
      await assert.doesNotReject(panel.saveRosterOrder(themeId, garbage));
      assert.deepEqual(await panel.getRosterOrder(themeId), []);
    }
  } finally {
    await cleanup();
  }
});

test('SAVE_ROSTER_ORDER schema: valid payload passes; non-array, >64 entries, and non-string entries all fail', () => {
  assert.equal(
    MSG_SCHEMAS.SAVE_ROSTER_ORDER.safeParse({ themeId: 'theme1', rosterOrder: ['a', 'b'] }).success,
    true,
  );
  assert.equal(
    MSG_SCHEMAS.SAVE_ROSTER_ORDER.safeParse({ themeId: 'theme1', rosterOrder: 'not-an-array' }).success,
    false,
  );
  assert.equal(
    MSG_SCHEMAS.SAVE_ROSTER_ORDER.safeParse({
      themeId: 'theme1',
      rosterOrder: Array.from({ length: 65 }, (_, i) => `a${i}`),
    }).success,
    false,
  );
  assert.equal(
    MSG_SCHEMAS.SAVE_ROSTER_ORDER.safeParse({ themeId: 'theme1', rosterOrder: ['a', 42, 'b'] }).success,
    false,
  );
  assert.equal(MSG_SCHEMAS.SAVE_ROSTER_ORDER.safeParse({ themeId: '', rosterOrder: [] }).success, false);
  assert.equal(MSG.SAVE_ROSTER_ORDER, 'saveRosterOrder');
});

// ---------------------------------------------------------------------------
// 3. Corrupt store file: garbage bytes -> cold read, no throw, next save works.
// ---------------------------------------------------------------------------

test('a corrupt roster-order.json is read as cold (no throw), and the next save recovers it', async () => {
  const { uri, root, cleanup } = await tmpStorageUri('tycoon-roster-corrupt-');
  try {
    await fsp.writeFile(path.join(root, 'roster-order.json'), '{not valid json, garbage bytes \x00\x01');
    const panel = fakePanel(uri, 'scopeA', ROSTER_METHODS);

    await assert.doesNotReject(panel.getRosterOrder('theme1'));
    assert.equal(await panel.getRosterOrder('theme1'), null);

    await assert.doesNotReject(panel.saveRosterOrder('theme1', ['a', 'b']));
    assert.deepEqual(await panel.getRosterOrder('theme1'), ['a', 'b']);

    const raw = JSON.parse(await fsp.readFile(path.join(root, 'roster-order.json'), 'utf8'));
    assert.deepEqual(raw['scopeA|theme1'], ['a', 'b']);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Delete cleanup: _removeThemeRosterOrder removes ONLY that theme's
//    entries (across every project scope), leaving other themes intact.
// ---------------------------------------------------------------------------

test('_removeThemeRosterOrder removes only the deleted theme, in every project scope, leaving other themes intact', async () => {
  const { uri, cleanup } = await tmpStorageUri('tycoon-roster-delete-');
  try {
    const scopeA = fakePanel(uri, 'scopeA', ROSTER_METHODS);
    const scopeB = fakePanel(uri, 'scopeB', ROSTER_METHODS);

    await scopeA.saveRosterOrder('theme1', ['a1']);
    await scopeB.saveRosterOrder('theme1', ['b1']);
    await scopeA.saveRosterOrder('theme2', ['a2']);

    await scopeA._removeThemeRosterOrder('theme1');

    assert.equal(await scopeA.getRosterOrder('theme1'), null);
    assert.equal(await scopeB.getRosterOrder('theme1'), null);
    assert.deepEqual(await scopeA.getRosterOrder('theme2'), ['a2']);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Init payload: _buildThemeInitPayload carries savedRosterOrder matching
//    the stored order for the current scope, and null when none was saved.
// ---------------------------------------------------------------------------

test('_buildThemeInitPayload includes savedRosterOrder matching the stored order for the current scope', async () => {
  const { uri, cleanup } = await tmpStorageUri('tycoon-roster-initpayload-');
  try {
    const panel = fakePanel(uri, 'scopeA', INIT_PAYLOAD_METHODS);
    await panel.saveRosterOrder('theme1', ['agent_b', 'agent_a']);

    const manifest = { theme_id: 'theme1' } as any;
    const payload = await panel._buildThemeInitPayload(manifest, {}, false);

    assert.deepEqual(payload.savedRosterOrder, ['agent_b', 'agent_a']);
    assert.equal(panel._currentThemeId, 'theme1', '_buildThemeInitPayload must latch _currentThemeId');
  } finally {
    await cleanup();
  }
});

test('_buildThemeInitPayload.savedRosterOrder is null when nothing was ever saved for this theme', async () => {
  const { uri, cleanup } = await tmpStorageUri('tycoon-roster-initpayload-none-');
  try {
    const panel = fakePanel(uri, 'scopeA', INIT_PAYLOAD_METHODS);

    const manifest = { theme_id: 'never_saved_theme' } as any;
    const payload = await panel._buildThemeInitPayload(manifest, {}, false);

    assert.equal(payload.savedRosterOrder, null);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Retry payload sanity (webview source-text audit, not a behavior test:
//    main.js is a hand-edited, non-bundled file — see test/messages.test.ts
//    for the same drift-guard technique). Confirms the retry-notes textarea
//    and its "feedback"/"augment"/"custom" mode machinery are gone, and
//    RETRY_THEME_IMAGE now always sends a bare mode: "retry".
// ---------------------------------------------------------------------------

function readMainJs(): string {
  return readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
}

test('main.js no longer creates the retry-notes ("theme-review-feedback") textarea or its augment/custom mode logic', () => {
  const src = readMainJs();
  // Exact old class token (quoted) -- distinct from the still-present, unrelated
  // "theme-review-feedback-hint" class used by the creative-direction warning.
  assert.ok(!src.includes('"theme-review-feedback"'), 'the retired retry-notes textarea class must be gone');
  assert.ok(!src.includes("'theme-review-feedback'"), 'the retired retry-notes textarea class must be gone (single-quoted)');
  assert.ok(!src.includes('feedback: notes'), 'the retired feedback payload field must be gone');
  assert.ok(!src.includes('effectiveMode'), 'the retired augment/custom mode computation must be gone');
});

test('main.js RETRY_THEME_IMAGE post site always sends mode "retry" with no feedback field', () => {
  const src = readMainJs();
  const match = src.match(/type:\s*'RETRY_THEME_IMAGE'[\s\S]*?\}\s*\)\s*;/);
  assert.ok(match, 'RETRY_THEME_IMAGE postMessage site not found in media/main.js (drift guard)');
  const block = match![0];
  assert.ok(block.includes('mode: "retry"'), 'RETRY_THEME_IMAGE payload must send a literal mode: "retry"');
  assert.ok(!/feedback/i.test(block), 'RETRY_THEME_IMAGE payload must not include a feedback field');
});

test('media/main.js still uses the saveRosterOrder wire string and posts savedRosterOrder-driven restore logic', () => {
  const src = readMainJs();
  assert.ok(src.includes(`"${MSG.SAVE_ROSTER_ORDER}"`) || src.includes(`'${MSG.SAVE_ROSTER_ORDER}'`));
  assert.ok(src.includes('savedRosterOrder'));
});
