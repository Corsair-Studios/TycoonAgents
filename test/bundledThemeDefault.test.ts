/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * Guards the first-run default-theme path:
 *
 *   1-4. src/host/vscode/bundledThemeSeeds.ts `seedBundledThemes` seeds every
 *        bundled theme in media/themes/<dir>/manifest.json that global storage
 *        does not already have -- a PER-THEME presence check, not the old
 *        "only seed when the theme list is empty" rule -- never overwrites,
 *        and never throws (failures land in `skipped`).
 *   5.   themeService.loadLatestTheme precedence: newest NON-bundled (user)
 *        theme wins outright; else DEFAULT_THEME_ID when installed; else the
 *        newest of whatever remains. A persisted choice always wins.
 *   6.   panel.ts awaits the seed promise, bounded by THEME_SEED_WAIT_MS,
 *        before the first loadLatestTheme, so a fresh install shows the
 *        bundled theme instead of THEME_NONE.
 *
 * Both the seeding code and themeService pull in siblings that
 * `import * as vscode from 'vscode'`, which Node cannot resolve outside the
 * extension host. We stub the module loader the same way
 * test/themeDiskSizeRawExclusion.test.ts does -- but unlike that test, the
 * seeding code READS its bundled sources through real vscode API surface
 * (`Uri.joinPath`, `workspace.fs.readDirectory/readFile`, `FileType`), so the
 * stub is a small node-fs-backed implementation of exactly those, rooted at a
 * temp "extension" directory. The WRITE side still goes through an injected
 * ThemeFileStore (themeFileStore.ts's documented test escape hatch).
 */

// --- vscode module stub -------------------------------------------------

interface StubUri {
  fsPath: string;
  path: string;
  scheme: 'file';
}

function makeUri(fsPath: string): StubUri {
  return { fsPath, path: fsPath.replace(/\\/g, '/'), scheme: 'file' };
}

const vscodeStub = {
  __esModule: true,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    file: (p: string): StubUri => makeUri(p),
    joinPath: (base: StubUri, ...segments: string[]): StubUri =>
      makeUri(path.join(base.fsPath, ...segments)),
  },
  workspace: {
    fs: {
      async readDirectory(uri: StubUri): Promise<Array<[string, number]>> {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : entry.isFile() ? 1 : 0]);
      },
      async readFile(uri: StubUri): Promise<Uint8Array> {
        return fsp.readFile(uri.fsPath);
      },
      async writeFile(uri: StubUri, data: Uint8Array): Promise<void> {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, data);
      },
      async stat(uri: StubUri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
        const s = await fsp.stat(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      },
      async createDirectory(uri: StubUri): Promise<void> {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
    },
  },
};

/**
 * Anything panel.ts touches that the seeding path doesn't model resolves to an
 * inert self-returning stub, so `require`-ing panel.ts for `waitForBundledThemes`
 * cannot fail on an unmodelled vscode API.
 */
function inertStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
      if (!(prop in t)) t[prop] = new Proxy(function stub() {}, handler);
      return t[prop];
    },
    apply: () => new Proxy({}, handler),
    construct: () => new Proxy({}, handler),
  };
  return new Proxy({}, handler);
}
const permissiveVscode = new Proxy(vscodeStub as Record<string, unknown>, {
  get(target, prop) {
    if (prop in target) return (target as Record<string | symbol, unknown>)[prop as string];
    return (inertStub() as Record<string | symbol, unknown>)[prop as string];
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return permissiveVscode;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { seedBundledThemes } = require('../src/host/vscode/bundledThemeSeeds') as
  typeof import('../src/host/vscode/bundledThemeSeeds');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const themeService = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  configureThemeFileStore,
  resetThemeFileStoreForTests,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');

type ThemeFileStore = import('../src/extension/themeFileStore').ThemeFileStore;
type ThemeFileStoreEntry = import('../src/extension/themeFileStore').ThemeFileStoreEntry;
type ThemeFileStoreStat = import('../src/extension/themeFileStore').ThemeFileStoreStat;

const DEFAULT_ID = 'catopia';

// --- node-fs ThemeFileStore (same shape as themeDiskSizeRawExclusion) ----

function createFsThemeFileStore(root: string): ThemeFileStore {
  const resolve = (relativePath: string): string => path.join(root, ...relativePath.split('/').filter(Boolean));
  return {
    async readFile(relativePath) {
      return fsp.readFile(resolve(relativePath));
    },
    async writeFile(relativePath, data) {
      const target = resolve(relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
    },
    async readdir(relativePath): Promise<ThemeFileStoreEntry[]> {
      const entries = await fsp.readdir(resolve(relativePath), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
    async mkdirp(relativePath) {
      await fsp.mkdir(resolve(relativePath), { recursive: true });
    },
    async remove(relativePath, options) {
      await fsp.rm(resolve(relativePath), { recursive: options?.recursive ?? false, force: true });
    },
    async exists(relativePath) {
      try {
        await fsp.access(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async stat(relativePath): Promise<ThemeFileStoreStat> {
      const s = await fsp.stat(resolve(relativePath));
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
    },
    async rename(fromRelativePath, toRelativePath) {
      await fsp.rename(resolve(fromRelativePath), resolve(toRelativePath));
    },
  };
}

// --- fixtures -----------------------------------------------------------

function manifestFor(themeId: string, displayName = themeId): Record<string, unknown> {
  return {
    manifest_version: '1.0.0',
    theme_id: themeId,
    display_name: displayName,
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
}

/** Writes a fake "extension" tree with media/themes/<id>/{manifest,frames}.json. */
async function makeBundle(root: string, themeIds: string[]): Promise<StubUri> {
  for (const themeId of themeIds) {
    const dir = path.join(root, 'media', 'themes', themeId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifestFor(themeId)));
    await fsp.writeFile(
      path.join(dir, 'frames.json'),
      JSON.stringify({ agents_atlas: [`data:image/png;base64,${themeId}`] }),
    );
  }
  return makeUri(root);
}

/** Writes a theme straight into storage in the modern themes/<id>/ layout. */
async function writeStorageTheme(storage: string, themeId: string, mtimeMs?: number): Promise<void> {
  const dir = path.join(storage, 'themes', themeId);
  await fsp.mkdir(dir, { recursive: true });
  const manifest = path.join(dir, 'manifest.json');
  await fsp.writeFile(manifest, JSON.stringify(manifestFor(themeId)));
  await fsp.writeFile(path.join(dir, 'frames.json'), JSON.stringify({ agents_atlas: ['data:image/png;base64,x'] }));
  if (mtimeMs !== undefined) {
    const when = new Date(mtimeMs);
    await fsp.utimes(manifest, when, when);
  }
}

async function withTempRoots(
  body: (extensionRoot: string, storageRoot: string) => Promise<void>,
): Promise<void> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-seed-default-'));
  const extensionRoot = path.join(base, 'extension');
  const storageRoot = path.join(base, 'storage');
  await fsp.mkdir(extensionRoot, { recursive: true });
  await fsp.mkdir(storageRoot, { recursive: true });
  configureThemeFileStore(createFsThemeFileStore(storageRoot));
  try {
    await body(extensionRoot, storageRoot);
  } finally {
    resetThemeFileStoreForTests();
    await fsp.rm(base, { recursive: true, force: true });
  }
}

const legacyManifest = (storage: string, id: string): string => path.join(storage, `${id}_manifest.json`);
const legacyFrames = (storage: string, id: string): string => path.join(storage, `${id}_frames.json`);

// --- 1. fresh storage ---------------------------------------------------

test('seedBundledThemes seeds the bundled default into empty storage, and is a no-op on a second call', async () => {
  await withTempRoots(async (extensionRoot, storageRoot) => {
    const extensionUri = await makeBundle(extensionRoot, [DEFAULT_ID]);

    const first = await seedBundledThemes(extensionUri as never, {});
    assert.ok(first.seeded.includes(DEFAULT_ID), `expected ${DEFAULT_ID} in seeded, got ${JSON.stringify(first)}`);

    const manifestAfter = await fsp.readFile(legacyManifest(storageRoot, DEFAULT_ID), 'utf8');
    const framesAfter = await fsp.readFile(legacyFrames(storageRoot, DEFAULT_ID), 'utf8');
    assert.equal(JSON.parse(manifestAfter).theme_id, DEFAULT_ID);
    assert.ok(framesAfter.length > 0, 'frames must be seeded alongside the manifest');

    const second = await seedBundledThemes(extensionUri as never, {});
    assert.ok(second.skipped.includes(DEFAULT_ID), 'a second seed must skip the already-present theme');
    assert.deepEqual(second.seeded, [], 'a second seed must write nothing');
    assert.equal(await fsp.readFile(legacyManifest(storageRoot, DEFAULT_ID), 'utf8'), manifestAfter);
    assert.equal(await fsp.readFile(legacyFrames(storageRoot, DEFAULT_ID), 'utf8'), framesAfter);
  });
});

// --- 2. regression: storage non-empty but missing the bundled theme -----

test('seedBundledThemes still seeds when storage holds only an unrelated user theme (old list-empty rule)', async () => {
  await withTempRoots(async (extensionRoot, storageRoot) => {
    const extensionUri = await makeBundle(extensionRoot, [DEFAULT_ID]);
    await writeStorageTheme(storageRoot, 'user_made_theme');

    const result = await seedBundledThemes(extensionUri as never, {});
    assert.ok(
      result.seeded.includes(DEFAULT_ID),
      `per-theme presence check required: a non-empty theme list must not block seeding (${JSON.stringify(result)})`,
    );
    await fsp.access(legacyManifest(storageRoot, DEFAULT_ID));
  });
});

// --- 3. never overwrite -------------------------------------------------

test('seedBundledThemes never overwrites a bundled theme the user has already modified', async () => {
  await withTempRoots(async (extensionRoot, storageRoot) => {
    const extensionUri = await makeBundle(extensionRoot, [DEFAULT_ID]);
    await writeStorageTheme(storageRoot, DEFAULT_ID);
    const modifiedPath = path.join(storageRoot, 'themes', DEFAULT_ID, 'manifest.json');
    const modified = { ...manifestFor(DEFAULT_ID), display_name: 'User Edited Name' };
    await fsp.writeFile(modifiedPath, JSON.stringify(modified));

    const result = await seedBundledThemes(extensionUri as never, {});
    assert.ok(result.skipped.includes(DEFAULT_ID), 'an already-installed theme must be skipped');
    const after = JSON.parse(await fsp.readFile(modifiedPath, 'utf8')) as { display_name: string };
    assert.equal(after.display_name, 'User Edited Name', 'the user copy must survive untouched');
  });
});

// --- 4. unreadable bundled source ---------------------------------------

test('seedBundledThemes resolves (never throws) when a bundled theme cannot be read', async () => {
  await withTempRoots(async (extensionRoot) => {
    const extensionUri = await makeBundle(extensionRoot, [DEFAULT_ID, 'broken_theme']);
    // frames.json missing => the manifest (and its theme_id) is readable, but
    // the copy fails: the id must land in `skipped`, not blow up activation.
    await fsp.rm(path.join(extensionRoot, 'media', 'themes', 'broken_theme', 'frames.json'));
    // manifest.json unparseable => the id is unknowable; must be silently passed over.
    const unparseable = path.join(extensionRoot, 'media', 'themes', 'no_manifest');
    await fsp.mkdir(unparseable, { recursive: true });
    await fsp.writeFile(path.join(unparseable, 'manifest.json'), '{ not json');

    const result = await seedBundledThemes(extensionUri as never, {});
    assert.ok(result.seeded.includes(DEFAULT_ID), 'a healthy sibling theme must still be seeded');
    assert.ok(result.skipped.includes('broken_theme'), `broken_theme must be reported skipped: ${JSON.stringify(result)}`);
    assert.ok(!result.seeded.includes('no_manifest'), 'an unparseable manifest must not be seeded');
  });
});

test('seedBundledThemes resolves with an empty result when media/themes does not exist at all', async () => {
  await withTempRoots(async (extensionRoot) => {
    const result = await seedBundledThemes(makeUri(extensionRoot) as never, {});
    assert.deepEqual(result, { seeded: [], skipped: [] });
  });
});

// --- 5. loadLatestTheme's default/user-theme precedence -----------------

/*
 * Precedence contract:
 *   (1) any NON-bundled (user-generated) theme exists -> newest of those, even
 *       when the bundled default was seeded later and has a newer mtime;
 *   (2) else the bundled DEFAULT_THEME_ID when installed;
 *   (3) else newest of whatever remains.
 * A persisted user choice is passed explicitly and always wins.
 */

test('themeService exports DEFAULT_THEME_ID and BUNDLED_THEME_IDS', async () => {
  const svc = themeService as unknown as { DEFAULT_THEME_ID?: string; BUNDLED_THEME_IDS?: readonly string[] };
  assert.equal(svc.DEFAULT_THEME_ID, DEFAULT_ID, 'DEFAULT_THEME_ID must be "catopia"');
  assert.ok(
    Array.isArray(svc.BUNDLED_THEME_IDS) && svc.BUNDLED_THEME_IDS.includes(DEFAULT_ID),
    'BUNDLED_THEME_IDS must exist and list the bundled default, so user themes can be told apart from seeds',
  );
});

test('loadLatestTheme picks the user theme over the bundled default even when the default is newer', async () => {
  await withTempRoots(async (_extensionRoot, storageRoot) => {
    // The user made their theme first; the default was seeded afterwards, so
    // pure mtime ordering would wrongly pick the seed.
    await writeStorageTheme(storageRoot, 'user_made_theme', Date.now() - 60_000);
    await writeStorageTheme(storageRoot, DEFAULT_ID, Date.now());

    const loaded = await themeService.loadLatestTheme({});
    assert.ok(loaded, 'a theme must load');
    assert.equal(
      loaded!.manifest.theme_id,
      'user_made_theme',
      "a user-generated theme must win over a bundled seed regardless of mtime",
    );
  });
});

test('loadLatestTheme picks the newest user theme when several exist', async () => {
  await withTempRoots(async (_extensionRoot, storageRoot) => {
    await writeStorageTheme(storageRoot, 'older_user_theme', Date.now() - 120_000);
    await writeStorageTheme(storageRoot, 'newer_user_theme', Date.now() - 10_000);
    await writeStorageTheme(storageRoot, DEFAULT_ID, Date.now());

    const loaded = await themeService.loadLatestTheme({});
    assert.equal(loaded?.manifest.theme_id, 'newer_user_theme');
  });
});

test('loadLatestTheme falls back to the bundled default when it is the only theme installed', async () => {
  await withTempRoots(async (_extensionRoot, storageRoot) => {
    await writeStorageTheme(storageRoot, DEFAULT_ID, Date.now());
    const loaded = await themeService.loadLatestTheme({});
    assert.equal(loaded?.manifest.theme_id, DEFAULT_ID);
  });
});

/*
 * loadLatestTheme takes no preference argument under the current contract --
 * the precedence rules above are the whole story, and a persisted user choice
 * is honoured by the caller loading that id directly via loadTheme.
 */
test('loadTheme returns the requested id, so a persisted choice bypasses the precedence rules', async () => {
  await withTempRoots(async (_extensionRoot, storageRoot) => {
    await writeStorageTheme(storageRoot, DEFAULT_ID, Date.now());
    await writeStorageTheme(storageRoot, 'user_made_theme', Date.now() - 60_000);

    assert.equal((await themeService.loadTheme({}, DEFAULT_ID))?.manifest.theme_id, DEFAULT_ID);
    assert.equal((await themeService.loadTheme({}, 'user_made_theme'))?.manifest.theme_id, 'user_made_theme');
  });
});

// --- 6. panel ordering --------------------------------------------------

/*
 * panel.ts is a ~2700-line vscode-host module with no injectable seam for the
 * seed wait, so this asserts the contract structurally against its source:
 * the bounded-wait constant exists, is small enough not to hang activation,
 * and the seed promise is actually awaited before the first loadLatestTheme /
 * THEME_NONE decision. Replace with a behavioural test once panel.ts exposes
 * the wait as an exported helper (see open issue in the handoff).
 */
test('panel.ts awaits the bundled-seed promise, bounded, before deciding THEME_NONE', async () => {
  const panelSource = await fsp.readFile(
    path.resolve(__dirname, '..', '..', 'src', 'host', 'vscode', 'panel.ts'),
    'utf8',
  );
  const waitSource = await fsp.readFile(
    path.resolve(__dirname, '..', '..', 'src', 'host', 'vscode', 'themeReady.ts'),
    'utf8',
  );
  const constant = /THEME_SEED_WAIT_MS\s*=\s*(\d+)/.exec(waitSource);
  assert.ok(constant, 'themeReady.ts must define THEME_SEED_WAIT_MS to bound the wait on seeding');
  const waitMs = Number(constant![1]);
  assert.ok(waitMs > 0 && waitMs <= 10_000, `THEME_SEED_WAIT_MS must be a small positive bound, got ${waitMs}`);

  const themeNoneIndex = panelSource.indexOf('MSG.THEME_NONE');
  assert.ok(themeNoneIndex > 0, 'panel.ts must still have a THEME_NONE fallback');
  const awaitsSeed = /await\s+waitForBundledThemes\(/.test(panelSource);
  assert.ok(
    awaitsSeed,
    'panel.ts must await the seed promise (bounded by THEME_SEED_WAIT_MS) before the first loadLatestTheme',
  );
});

test('extension.ts exports the seed promise the panel waits on', async () => {
  const source = await fsp.readFile(
    path.resolve(__dirname, '..', '..', 'src', 'host', 'vscode', 'extension.ts'),
    'utf8',
  );
  assert.match(
    source,
    /export\s+let\s+bundledThemesReady/,
    'extension.ts must expose the seed promise so the panel can await it',
  );
  assert.match(source, /bundledThemesReady\s*=\s*seedBundledThemes\(/, 'the exported promise must be the real seed run');
});

test('waitForBundledThemes resolves as soon as seeding finishes, and gives up at the bound', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const panel = require('../src/host/vscode/panel') as typeof import('../src/host/vscode/panel');
  const { waitForBundledThemes, THEME_SEED_WAIT_MS } = panel;
  assert.ok(THEME_SEED_WAIT_MS > 0 && THEME_SEED_WAIT_MS <= 10_000, 'the wait must be a small positive bound');

  // A seed that finishes: the wait ends with it, well before the bound.
  let settled = false;
  const seeding = new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 50));
  const startedAt = Date.now();
  await waitForBundledThemes(seeding, 5_000);
  assert.ok(settled, 'the wait must not return before seeding resolves');
  assert.ok(Date.now() - startedAt < 2_000, 'the wait must end with the seed, not run to the bound');

  // A seed that never settles: bounded, so the panel still renders.
  await waitForBundledThemes(new Promise<void>(() => {}), 30);

  // A failing seed must not reject, and undefined resolves immediately.
  await waitForBundledThemes(Promise.reject(new Error('seed blew up')), 30);
  await waitForBundledThemes(undefined);
});

/*
 * BUNDLED_THEME_IDS is what loadLatestTheme uses to tell a shipped seed from a
 * theme the user generated. Ship a new theme under media/themes/ without
 * adding its id to that constant and it would be mistaken for a user theme,
 * outranking the user's own work on load.
 */
test('BUNDLED_THEME_IDS matches the theme_ids actually shipped under media/themes/', async () => {
  const bundledDir = path.resolve(__dirname, '..', '..', 'media', 'themes');
  const entries = await fsp.readdir(bundledDir, { withFileTypes: true });
  const onDisk: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await fsp.readFile(path.join(bundledDir, entry.name, 'manifest.json'), 'utf8');
    const themeId = (JSON.parse(raw) as { theme_id?: string }).theme_id;
    assert.ok(themeId, `media/themes/${entry.name}/manifest.json must declare a theme_id`);
    onDisk.push(themeId!);
  }
  assert.ok(onDisk.length > 0, 'at least one bundled theme must ship');
  assert.deepEqual(
    [...themeService.BUNDLED_THEME_IDS].sort(),
    onDisk.sort(),
    'BUNDLED_THEME_IDS (src/extension/themeService.ts) must list exactly the theme_ids shipped under media/themes/',
  );
});

test('src/extension/main.ts uses themeService.loadLatestTheme instead of defining its own', async () => {
  const source = await fsp.readFile(
    path.resolve(__dirname, '..', '..', 'src', 'extension', 'main.ts'),
    'utf8',
  );
  assert.ok(
    !/function\s+loadLatestTheme\s*\(/.test(source),
    'main.ts must not define a private loadLatestTheme -- the Theater view has to share themeService\'s ' +
      'default-theme precedence and its bounded wait on bundled seeding',
  );
  assert.match(
    source,
    /loadLatestTheme/,
    'main.ts must still resolve a theme -- via themeService.loadLatestTheme',
  );
});
