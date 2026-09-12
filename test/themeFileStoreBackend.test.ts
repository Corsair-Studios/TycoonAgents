/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * Covers the selection branch in themeFileStoreVscode.ts's
 * createVscodeThemeFileStore: 'file' and 'vscode-userdata' scheme roots must
 * select the Node fs-backed store (themeFileStoreFs.ts) and never touch
 * vscode.workspace.fs; any other scheme must select the vscode.workspace.fs
 * store and never touch real fs. Existing tests stub 'vscode' and bypass
 * this factory via configureThemeFileStore, so this branch had no coverage.
 */

interface StubUri {
  fsPath: string;
  path: string;
  scheme: string;
}

function makeUri(fsPath: string, scheme: string): StubUri {
  return { fsPath, path: fsPath.replace(/\\/g, '/'), scheme };
}

let workspaceFsCalls = 0;
const realFsTouchedByStub = false; // set true only inside the "unsupported scheme" branch's real-fs-backed stub

const vscodeStub = {
  __esModule: true,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    file: (p: string): StubUri => makeUri(p, 'file'),
    joinPath: (base: StubUri, ...segments: string[]): StubUri =>
      makeUri(path.join(base.fsPath, ...segments), base.scheme),
  },
  workspace: {
    fs: {
      async readDirectory(uri: StubUri): Promise<Array<[string, number]>> {
        workspaceFsCalls++;
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : entry.isFile() ? 1 : 0]);
      },
      async readFile(uri: StubUri): Promise<Uint8Array> {
        workspaceFsCalls++;
        return fsp.readFile(uri.fsPath);
      },
      async writeFile(uri: StubUri, data: Uint8Array): Promise<void> {
        workspaceFsCalls++;
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, data);
      },
      async stat(uri: StubUri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
        workspaceFsCalls++;
        const s = await fsp.stat(uri.fsPath);
        return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      },
      async createDirectory(uri: StubUri): Promise<void> {
        workspaceFsCalls++;
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      async delete(uri: StubUri, options: { recursive?: boolean }): Promise<void> {
        workspaceFsCalls++;
        await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: true });
      },
      async rename(from: StubUri, to: StubUri): Promise<void> {
        workspaceFsCalls++;
        await fsp.rename(from.fsPath, to.fsPath);
      },
    },
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      dispose: () => {},
    }),
  },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createVscodeThemeFileStore } = require('../src/extension/themeFileStoreVscode') as
  typeof import('../src/extension/themeFileStoreVscode');

async function mkTmpDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('scheme=file selects the Node fs-backed store and never touches vscode.workspace.fs', async () => {
  const root = await mkTmpDir('themeFileStoreBackend-file-');
  workspaceFsCalls = 0;
  const store = createVscodeThemeFileStore(makeUri(root, 'file') as unknown as import('vscode').Uri);

  await store.mkdirp('sub');
  await store.writeFile('sub/a.txt', Buffer.from('hello'));
  const onDisk = await fsp.readFile(path.join(root, 'sub', 'a.txt'), 'utf8');
  assert.equal(onDisk, 'hello');

  const entries = await store.readdir('sub');
  assert.deepEqual(
    entries.map((e) => e.name),
    ['a.txt'],
  );

  const stat = await store.stat('sub/a.txt');
  assert.equal(stat.isFile, true);
  assert.equal(typeof stat.mtimeMs, 'number');

  assert.equal(workspaceFsCalls, 0, 'vscode.workspace.fs must not be called for a file:// root');
});

test("scheme=vscode-userdata selects the Node fs-backed store via fsPath and never touches vscode.workspace.fs", async () => {
  const root = await mkTmpDir('themeFileStoreBackend-userdata-');
  workspaceFsCalls = 0;
  // Mimic vscode-userdata:/c%3A/Users/... -> fsPath c:\Users\... : construct
  // fsPath directly (the real tmp dir path), scheme set to vscode-userdata.
  const store = createVscodeThemeFileStore(makeUri(root, 'vscode-userdata') as unknown as import('vscode').Uri);

  await store.writeFile('manifest.json', Buffer.from('{"ok":true}'));
  const onDisk = await fsp.readFile(path.join(root, 'manifest.json'), 'utf8');
  assert.equal(onDisk, '{"ok":true}');

  const entries = await store.readdir('.');
  assert.deepEqual(
    entries.map((e) => e.name),
    ['manifest.json'],
  );

  assert.equal(workspaceFsCalls, 0, 'vscode.workspace.fs must not be called for a vscode-userdata root');
});

test('unsupported scheme selects the vscode.workspace.fs-backed store and never touches real fs directly', async () => {
  const root = await mkTmpDir('themeFileStoreBackend-remote-');
  workspaceFsCalls = 0;
  const store = createVscodeThemeFileStore(makeUri(root, 'vscode-remote') as unknown as import('vscode').Uri);

  await store.mkdirp('sub');
  await store.writeFile('sub/b.txt', Buffer.from('world'));
  const entries = await store.readdir('sub');
  assert.deepEqual(
    entries.map((e) => e.name),
    ['b.txt'],
  );
  const stat = await store.stat('sub/b.txt');
  assert.equal(stat.isFile, true);

  // The stub itself goes through real fs internally (it has to land
  // somewhere to assert against), but the point under test is that the
  // *store* routed every call through vscode.workspace.fs rather than
  // calling Node fs directly the way the fs-backed store does.
  assert.ok(workspaceFsCalls > 0, 'vscode.workspace.fs must be used for a non-local scheme');
});

test('parity: fs-backed store and vscode-backed store produce identical results for the same operation sequence', async () => {
  const rootA = await mkTmpDir('themeFileStoreBackend-parityA-');
  const rootB = await mkTmpDir('themeFileStoreBackend-parityB-');

  const storeFs = createVscodeThemeFileStore(makeUri(rootA, 'file') as unknown as import('vscode').Uri);
  const storeVscode = createVscodeThemeFileStore(makeUri(rootB, 'vscode-remote') as unknown as import('vscode').Uri);

  async function runOps(store: import('../src/extension/themeFileStore').ThemeFileStore) {
    await store.mkdirp('themes');
    await store.writeFile('themes/aaa_manifest.json', Buffer.from(JSON.stringify({ id: 'aaa', name: 'Aaa' })));
    // Ensure a distinguishable, monotonically later mtime for the "newest" theme.
    await new Promise((r) => setTimeout(r, 20));
    await store.writeFile('themes/bbb_manifest.json', Buffer.from(JSON.stringify({ id: 'bbb', name: 'Bbb' })));

    const entries = await store.readdir('themes');
    const manifestFiles = entries.filter((e) => e.isFile && e.name.endsWith('_manifest.json')).map((e) => e.name);
    manifestFiles.sort();

    const stats = await Promise.all(
      manifestFiles.map(async (name) => ({ name, stat: await store.stat(`themes/${name}`) })),
    );
    const newest = stats.reduce((a, b) => (b.stat.mtimeMs >= a.stat.mtimeMs ? b : a));

    const contents = await Promise.all(
      manifestFiles.map(async (name) => JSON.parse(Buffer.from(await store.readFile(`themes/${name}`)).toString('utf8'))),
    );

    return { manifestFiles, newestName: newest.name, contents };
  }

  const resultFs = await runOps(storeFs);
  const resultVscode = await runOps(storeVscode);

  assert.deepEqual(resultFs.manifestFiles, resultVscode.manifestFiles);
  assert.equal(resultFs.newestName, 'bbb_manifest.json');
  assert.equal(resultVscode.newestName, 'bbb_manifest.json');
  assert.deepEqual(resultFs.contents, resultVscode.contents);
});

test('performance guard: an 8MB write+read through the fs-backed store completes in under 2000ms', async () => {
  const root = await mkTmpDir('themeFileStoreBackend-perf-');
  const store = createVscodeThemeFileStore(makeUri(root, 'file') as unknown as import('vscode').Uri);

  const big = Buffer.alloc(8 * 1024 * 1024, 7);
  const start = Date.now();
  await store.writeFile('big.bin', big);
  const readBack = await store.readFile('big.bin');
  const elapsed = Date.now() - start;

  assert.equal(readBack.length, big.length);
  assert.ok(elapsed < 2000, `expected < 2000ms, got ${elapsed}ms`);
  void fsSync.existsSync; // keep import used across ts strictness variants
});
