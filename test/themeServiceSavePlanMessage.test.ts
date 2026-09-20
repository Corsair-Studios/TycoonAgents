/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p76-t3/p77-t3: panel message-boundary coverage for SAVE_THEME_PLAN/THEME_PLAN_SAVED,
// following test/themeServiceMessageBoundary.test.ts's pattern: this task may
// not edit panel.ts, so it replicates panel.ts's two relevant one-line pieces
// (themeServiceMessagePayload at ~203-210, and the SAVE_THEME_PLAN branch's
// exact success/error reply shapes at ~2775-2803) and exercises them against
// the real MSG_SCHEMAS.SAVE_THEME_PLAN (src/host/vscode/messages.ts ~937), the
// real saveThemePlan (src/extension/themeService.ts ~2199), and (p77-t3) the
// real getThemeBoardCounts (src/extension/themeService.ts ~634) whose spread
// result panel.ts now appends to the THEME_PLAN_SAVED payload, rather than
// instantiating the full TycoonPanel class (which needs a live vscode.Uri /
// webview / extension context this test suite cannot construct).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MSG, MSG_SCHEMAS } from '../src/host/vscode/messages';

const PANEL_TS_PATH = path.join(process.cwd(), 'src', 'host', 'vscode', 'panel.ts');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module');
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(t, prop) {
      if (prop === '__esModule') return true;
      if (!(prop in t)) t[prop] = new Proxy(function stub() {}, handler);
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
const { saveThemePlan, listThemes, getThemeBoardCounts } = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  configureThemeFileStore,
  resetThemeFileStoreForTests,
} = require('../src/extension/themeFileStore') as typeof import('../src/extension/themeFileStore');
type ThemeFileStore = import('../src/extension/themeFileStore').ThemeFileStore;
type ThemeFileStoreEntry = import('../src/extension/themeFileStore').ThemeFileStoreEntry;
type ThemeFileStoreStat = import('../src/extension/themeFileStore').ThemeFileStoreStat;

function createFsThemeFileStore(root: string): ThemeFileStore {
  const resolve = (relativePath: string): string => path.join(root, ...relativePath.split('/').filter(Boolean));
  return {
    async readFile(relativePath: string): Promise<Uint8Array> {
      return fsp.readFile(resolve(relativePath));
    },
    async writeFile(relativePath: string, data: Uint8Array | Buffer): Promise<void> {
      await fsp.writeFile(resolve(relativePath), data);
    },
    async readdir(relativePath: string): Promise<ThemeFileStoreEntry[]> {
      const entries = await fsp.readdir(resolve(relativePath), { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
    },
    async mkdirp(relativePath: string): Promise<void> {
      await fsp.mkdir(resolve(relativePath), { recursive: true });
    },
    async remove(relativePath: string, options?: { recursive?: boolean }): Promise<void> {
      await fsp.rm(resolve(relativePath), { recursive: options?.recursive ?? false, force: true });
    },
    async exists(relativePath: string): Promise<boolean> {
      try {
        await fsp.access(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async stat(relativePath: string): Promise<ThemeFileStoreStat> {
      const stat = await fsp.stat(resolve(relativePath));
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs };
    },
    async rename(fromRelativePath: string, toRelativePath: string): Promise<void> {
      await fsp.rename(resolve(fromRelativePath), resolve(toRelativePath));
    },
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-save-theme-plan-msg-'));
  configureThemeFileStore(createFsThemeFileStore(root));
  try {
    return await fn(root);
  } finally {
    resetThemeFileStoreForTests();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

// Exact replica of panel.ts's themeServiceMessagePayload(message) (~203-210).
function themeServiceMessagePayload(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const { type: _type, ...rest } = message as Record<string, unknown>;
  return rest;
}

/** Replica of panel.ts's SAVE_THEME_PLAN branch (~2773-2800): same schema
 * parse, same saveThemePlan call, same reply message shapes/order. */
async function handleSaveThemePlan(message: Record<string, unknown>): Promise<Array<{ type: string; payload: unknown }>> {
  const posted: Array<{ type: string; payload: unknown }> = [];
  const parsed = MSG_SCHEMAS.SAVE_THEME_PLAN.safeParse(themeServiceMessagePayload(message));
  if (!parsed.success) {
    posted.push({ type: MSG.THEME_GENERATION_ERROR, payload: { message: 'Invalid theme plan.' } });
    return posted;
  }
  try {
    const { theme_id, plan } = await saveThemePlan({} as any, parsed.data.plan as any, parsed.data.theme_id);
    const savedBoardCounts = await getThemeBoardCounts({} as any, theme_id);
    posted.push({ type: MSG.THEME_PLAN_SAVED, payload: { theme_id, plan, ...savedBoardCounts } });
    const themes = await listThemes({} as any);
    posted.push({ type: MSG.THEMES_LIST, payload: { themes } });
  } catch (err) {
    posted.push({ type: MSG.THEME_GENERATION_ERROR, payload: { message: err instanceof Error ? err.message : String(err) } });
  }
  return posted;
}

const validPlan = {
  display_name: 'Message Boundary Theme',
  creative_direction: 'Testing.',
  environment: 'A test room.',
};

test('saveThemePlan with a valid plan replies THEME_PLAN_SAVED then THEMES_LIST', async () => {
  await withTempRoot(async () => {
    const posted = await handleSaveThemePlan({ type: 'saveThemePlan', plan: validPlan });
    assert.equal(posted.length, 2);
    assert.equal(posted[0].type, MSG.THEME_PLAN_SAVED);
    assert.equal((posted[0].payload as any).theme_id, 'message_boundary_theme');
    assert.equal((posted[0].payload as any).hasBoards, false, 'a freshly saved empty-slot theme must report hasBoards:false');
    assert.equal((posted[0].payload as any).boardCount, 0);
    assert.equal(posted[1].type, MSG.THEMES_LIST);
    const themes = (posted[1].payload as any).themes;
    assert.ok(Array.isArray(themes) && themes.some((t: any) => t.theme_id === 'message_boundary_theme'));
  });
});

test('saveThemePlan with a malformed plan (plan not an object) replies the fixed "Invalid theme plan." error', async () => {
  await withTempRoot(async () => {
    const posted = await handleSaveThemePlan({ type: 'saveThemePlan', plan: 'not-an-object' });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, MSG.THEME_GENERATION_ERROR);
    assert.equal((posted[0].payload as any).message, 'Invalid theme plan.');
  });
});

test('saveThemePlan with a missing plan field replies the fixed "Invalid theme plan." error', async () => {
  await withTempRoot(async () => {
    const posted = await handleSaveThemePlan({ type: 'saveThemePlan' });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, MSG.THEME_GENERATION_ERROR);
    assert.equal((posted[0].payload as any).message, 'Invalid theme plan.');
  });
});

test('MSG_SCHEMAS.SAVE_THEME_PLAN rejects a theme_id longer than 40 characters', () => {
  const tooLong = 'a'.repeat(41);
  const result = MSG_SCHEMAS.SAVE_THEME_PLAN.safeParse({ plan: {}, theme_id: tooLong });
  assert.equal(result.success, false);
});

test('MSG_SCHEMAS.SAVE_THEME_PLAN accepts a theme_id of exactly 40 characters', () => {
  const exact = 'a'.repeat(40);
  const result = MSG_SCHEMAS.SAVE_THEME_PLAN.safeParse({ plan: {}, theme_id: exact });
  assert.equal(result.success, true);
});

// ── Source guard: panel.ts's SAVE_THEME_PLAN branch must still match the
// exact reply shapes handleSaveThemePlan() above replicates (panel.ts
// ~2773-2800), so this test fails loudly if that branch drifts instead of
// silently testing a stale replica.

test('source guard: panel.ts SAVE_THEME_PLAN branch still parses via themeServiceMessagePayload and replies THEME_PLAN_SAVED/THEMES_LIST/fixed error exactly as replicated here', () => {
  const src = readFileSync(PANEL_TS_PATH, 'utf8');
  const start = src.indexOf('message.type === MSG.SAVE_THEME_PLAN');
  assert.ok(start >= 0, 'panel.ts must still have a message.type === MSG.SAVE_THEME_PLAN branch');
  const end = src.indexOf('} else if (message.type === MSG.REGENERATE_BOARD', start);
  assert.ok(end > start, 'expected the SAVE_THEME_PLAN branch to be immediately followed by the REGENERATE_BOARD branch');
  const branch = src.slice(start, end);

  assert.match(
    branch,
    /const savedBoardCounts = await getThemeBoardCounts\(\s*this\._globalStorageUri,\s*theme_id,?\s*\);/,
    'branch must still compute savedBoardCounts via getThemeBoardCounts after saveThemePlan',
  );

  assert.match(
    branch,
    /MSG_SCHEMAS\.SAVE_THEME_PLAN\.safeParse\(themeServiceMessagePayload\(message\)\)/,
    'SAVE_THEME_PLAN branch must still validate via MSG_SCHEMAS.SAVE_THEME_PLAN.safeParse(themeServiceMessagePayload(message))',
  );
  assert.match(
    branch,
    /message:\s*"Invalid theme plan\."/,
    'a failed schema parse must still reply with the fixed "Invalid theme plan." error text',
  );
  assert.match(
    branch,
    /await saveThemePlan\(\s*this\._globalStorageUri,\s*parsedSavePlan\.data\.plan as Partial<ThemePlan>,\s*parsedSavePlan\.data\.theme_id,\s*\)/,
    'branch must still call saveThemePlan with the parsed plan and theme_id',
  );
  assert.match(
    branch,
    /type:\s*MSG\.THEME_PLAN_SAVED,\s*payload:\s*\{\s*theme_id,\s*plan,\s*\.\.\.savedBoardCounts\s*\}/,
    'success reply must still be { type: MSG.THEME_PLAN_SAVED, payload: { theme_id, plan, ...savedBoardCounts } }',
  );
  assert.match(
    branch,
    /const themes = await listThemes\(this\._globalStorageUri\);/,
    'branch must still refresh the themes list via listThemes after saving',
  );
  assert.match(
    branch,
    /type:\s*MSG\.THEMES_LIST,\s*payload:\s*\{\s*themes\s*\}/,
    'branch must still post { type: MSG.THEMES_LIST, payload: { themes } } after THEME_PLAN_SAVED',
  );

  // THEME_PLAN_SAVED must be posted before THEMES_LIST, matching this file's
  // replica ordering.
  const savedIdx = branch.indexOf('MSG.THEME_PLAN_SAVED');
  const listIdx = branch.indexOf('MSG.THEMES_LIST');
  assert.ok(savedIdx >= 0 && listIdx > savedIdx, 'THEME_PLAN_SAVED must be posted before THEMES_LIST in panel.ts');
});
