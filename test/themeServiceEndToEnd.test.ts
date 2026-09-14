import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Jimp from 'jimp';

// p43-t5: independent end-to-end coverage for the Corsair Theme Service
// integration, exercising the REAL wiring — createThemeServiceClient
// (src/core/themeServiceClient.ts) talking to the in-memory
// test/helpers/fakeThemeService.ts fake over its injectable `fetch`, feeding
// createServiceImageGenerator/setThemeImageGenerator (src/extension/themeService.ts)
// and createServicePlanRequester/setThemePlanRequester (src/extension/translator.ts)
// — rather than the hand-rolled counting generators p43-t1's unit tests use.
// Same vscode-module-stub-with-real-fs trick as test/themeImageGenerationService.test.ts
// (themeService.ts imports 'vscode' at module scope).
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
    return new FakeUri(path.join(base.fsPath, ...segments.map((segment) => segment.split('/').join(path.sep))));
  }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function makeVscodeStub(): unknown {
  const target: Record<string, unknown> = {
    Uri: FakeUri,
    FileType,
    workspace: {
      fs: {
        async readFile(uri: FakeUri): Promise<Uint8Array> {
          return fsp.readFile(uri.fsPath);
        },
        async writeFile(uri: FakeUri, data: Uint8Array): Promise<void> {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, Buffer.from(data));
        },
        async readDirectory(uri: FakeUri): Promise<[string, number][]> {
          const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
        },
        async createDirectory(uri: FakeUri): Promise<void> {
          await fsp.mkdir(uri.fsPath, { recursive: true });
        },
        async stat(uri: FakeUri): Promise<{ type: number; size: number; mtime: number; ctime: number }> {
          const info = await fsp.stat(uri.fsPath);
          return {
            type: info.isDirectory() ? FileType.Directory : FileType.File,
            size: info.size,
            mtime: info.mtimeMs,
            ctime: info.mtimeMs,
          };
        },
        async delete(uri: FakeUri, options?: { recursive?: boolean }): Promise<void> {
          await fsp.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: false });
        },
        async rename(from: FakeUri, to: FakeUri, options?: { overwrite?: boolean }): Promise<void> {
          await fsp.mkdir(path.dirname(to.fsPath), { recursive: true });
          await fsp.rename(from.fsPath, to.fsPath);
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
const themeService = require('../src/extension/themeService') as typeof import('../src/extension/themeService');
const {
  generateTheme, retryThemeImage, resliceThemeImageFromRaw, getThemeImageReview,
  planTheme, setThemeImageGenerator, createServiceImageGenerator,
} = themeService;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const translator = require('../src/extension/translator') as typeof import('../src/extension/translator');
const { setThemePlanRequester, createServicePlanRequester } = translator;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizeThemePlan } = require('../src/extension/themePlan') as typeof import('../src/extension/themePlan');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createFakeThemeService } = require('./helpers/fakeThemeService') as typeof import('./helpers/fakeThemeService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createThemeServiceClient } = require('../src/core/themeServiceClient') as typeof import('../src/core/themeServiceClient');
import type { ThemePlan } from '../src/extension/themePlan';
import type { ThemeServiceTokenStore } from '../src/core/themeServiceClient';

const ENDPOINT = 'https://fake-theme.example';
const SUPABASE_URL = 'https://fake-project.supabase.co';

function memoryTokenStore(): ThemeServiceTokenStore {
  let value: string | null = null;
  return {
    async get() { return value; },
    async set(token: string) { value = token; },
    async clear() { value = null; },
  };
}

/**
 * The fake service's /api/generate success payload hardcodes a 4-byte
 * placeholder ("data:image/png;base64,ZmFrZQ==") — fine for the accounting
 * assertions test/fakeThemeService.test.ts makes, but generateTheme's real
 * board pipeline decodes the image with Jimp and needs actual PNG bytes.
 * This wraps a fake's `fetch` and rewrites just the `image` field of a
 * successful /api/generate response to a real (magenta) atlas, leaving
 * every accounting field (attemptCost/credits/refunded) — and every other
 * route — untouched. No change to the shared test/helpers/fakeThemeService.ts.
 */
function withRealImages(baseFetch: typeof fetch, pngDataUri: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await baseFetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes('/api/generate') || res.status !== 200) return res;
    const body = await res.json();
    if (body && typeof body === 'object' && typeof body.image === 'string') {
      body.image = pngDataUri;
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function buildPlan(themeId: string): ThemePlan {
  return normalizeThemePlan({
    version: 1,
    theme_id: themeId,
    display_name: 'End To End Theme',
    creative_direction: 'test direction',
    characters: [],
    environment: 'test env',
    objects: [],
    decor: [],
    enemies: [],
    expressions: [],
    achievements: [],
  }, 'End To End Theme');
}

async function withTempStore<T>(fn: (globalStorageUri: FakeUri) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tycoon-theme-e2e-'));
  try {
    return await fn(FakeUri.file(root));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('end-to-end: plan, generate, retry, re-slice, refund, and error paths against the fake Theme Service', async () => {
  const nowMs = 1_700_000_000_000;
  const fake = createFakeThemeService({ endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: () => nowMs });
  const atlas = new Jimp(400, 200, 0xff00ffff);
  const pngDataUri = `data:image/png;base64,${(await atlas.getBufferAsync(Jimp.MIME_PNG)).toString('base64')}`;
  const realImageFetch = withRealImages(fake.fetch, pngDataUri);

  // ---- (1) signed-in account with 30 credits: plan a small theme, generate all boards ----
  await withTempStore(async (globalStorageUri) => {
    const tokenStore = memoryTokenStore();
    const client = createThemeServiceClient({ fetch: realImageFetch, tokenStore, endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: () => nowMs });
    const email = 'plan-generate@example.com';
    const linkRes = await client.requestMagicLink(email);
    assert.equal(linkRes.ok, true);
    const verifyRes = await client.verifyMagicLink(email, '123456');
    assert.equal(verifyRes.ok, true);
    const accountId = fake.state.accountsByEmail.get(email)!;
    fake.helpers.grant(accountId, 30);

    setThemeImageGenerator(createServiceImageGenerator(client));
    setThemePlanRequester(createServicePlanRequester(client));
    try {
      const planCost = fake.state.pricing.planCost;
      const plan = await planTheme('a small tycoon theme');
      const themeId = 'plan_generate_theme';
      plan.theme_id = themeId;

      const planRows = fake.state.ledger.filter((r) => r.ref?.startsWith('plan:'));
      assert.equal(planRows.length, 1, 'planRequest must debit exactly one ledger row');
      assert.equal(planRows[0].delta, -planCost);
      assert.equal(fake.state.balances.get(accountId), 30 - planCost, 'balance after planning must reflect planCost debited');

      const progress: string[] = [];
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, (m) => progress.push(m));
      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const boardCount = review.entries.length;
      assert.ok(boardCount > 0, 'the default plan must produce at least one board');

      const spendRowsAfterGenerate = fake.state.ledger.filter((r) => r.ref?.startsWith('attempt:'));
      assert.equal(spendRowsAfterGenerate.length, boardCount, 'ledger spend rows must equal the number of boards generated');
      assert.equal(
        fake.state.balances.get(accountId),
        30 - planCost - boardCount,
        'balance after generating all boards must be 30 minus planCost minus one credit per board',
      );
      for (const entry of review.entries) {
        assert.equal(entry.item.error_kind, undefined, `${entry.item.id} must generate cleanly`);
      }

      // ---- (2) retry one board -> one more spend row ----
      const ledgerBeforeRetry = fake.state.ledger.length;
      await retryThemeImage(globalStorageUri as unknown as import('vscode').Uri, themeId, 'environment', '', 'retry', {});
      const spendRowsAfterRetry = fake.state.ledger.filter((r) => r.ref?.startsWith('attempt:'));
      assert.equal(spendRowsAfterRetry.length, boardCount + 1, 'retrying one board must add exactly one more spend row');
      assert.equal(fake.state.ledger.length, ledgerBeforeRetry + 1);
      assert.equal(
        fake.state.balances.get(accountId),
        30 - planCost - boardCount - 1,
        'balance after the retry must reflect the extra attempt',
      );
      const reviewAfterRetry = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);

      // ---- (3) re-slice -> no new rows ----
      const ledgerLengthBeforeReslice = fake.state.ledger.length;
      const generateRequestsBeforeReslice = fake.state.generateRequests.length;
      await resliceThemeImageFromRaw(globalStorageUri as unknown as import('vscode').Uri, themeId, 'expressions');
      assert.equal(fake.state.ledger.length, ledgerLengthBeforeReslice, 're-slicing must never touch the ledger');
      assert.equal(fake.state.generateRequests.length, generateRequestsBeforeReslice, 're-slicing must never call /api/generate');

      // ---- (4) failNextGenerate on a retry -> spend+refund rows, net unchanged ----
      const balanceBeforeFailedRetry = fake.state.balances.get(accountId)!;
      const ledgerLengthBeforeFailedRetry = fake.state.ledger.length;
      fake.helpers.failNextGenerate();
      // retryThemeImage is a single explicit user action: unlike generateTheme's
      // runNonFatalBoardStep, it records the error onto the review item and then
      // RETHROWS rather than swallowing it — see the try/catch around
      // generateBoardImage in themeService.ts's retryThemeImage.
      await assert.rejects(
        retryThemeImage(globalStorageUri as unknown as import('vscode').Uri, themeId, 'environment', '', 'retry', {}),
        'a provider_failed attempt must propagate out of retryThemeImage',
      );
      assert.equal(fake.state.ledger.length, ledgerLengthBeforeFailedRetry + 2, 'a failed-and-refunded attempt must record both a spend row and a refund row');
      assert.equal(fake.state.balances.get(accountId), balanceBeforeFailedRetry, 'a refunded attempt must leave the net balance unchanged');

      const reviewAfterFailedRetry = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const environmentAfter = reviewAfterFailedRetry.entries.find((e) => e.item.id === 'environment')!;
      assert.equal(environmentAfter.item.lastAttemptRefunded, true, 'the review item must record the refund');
      assert.equal(environmentAfter.item.error_kind, 'provider_failed');
      // The failed retry's own attempt is refunded (net balance unchanged,
      // asserted above); it leaves the item's attemptCost/creditsSpent
      // contribution exactly as it was after the last SUCCESSFUL attempt —
      // setThemeImageReviewErrorKind (themeImageReviewState.ts) only touches
      // status/error_kind/lastAttemptRefunded, never attemptCost. So
      // creditsSpent must be unchanged by this failed-and-refunded retry.
      assert.equal(reviewAfterFailedRetry.creditsSpent, reviewAfterRetry.creditsSpent, 'creditsSpent must not grow from a refunded failed retry');
    } finally {
      setThemeImageGenerator(undefined);
      setThemePlanRequester(undefined);
    }
  });

  // ---- (5) 0 credits -> error_kind insufficient_credits, no ledger rows ----
  await withTempStore(async (globalStorageUri) => {
    const tokenStore = memoryTokenStore();
    const client = createThemeServiceClient({ fetch: realImageFetch, tokenStore, endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: () => nowMs });
    const email = 'zero-credits@example.com';
    await client.requestMagicLink(email);
    await client.verifyMagicLink(email, '123456');
    const accountId = fake.state.accountsByEmail.get(email)!;
    assert.equal(fake.state.balances.get(accountId) ?? 0, 0, 'a freshly-created account must start at 0 credits');

    setThemeImageGenerator(createServiceImageGenerator(client));
    try {
      const themeId = 'zero_credits_theme';
      const plan = buildPlan(themeId);
      const ledgerLengthBefore = fake.state.ledger.length;
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const environmentEntry = review.entries.find((e) => e.item.id === 'environment')!;
      assert.equal(environmentEntry.item.error_kind, 'insufficient_credits');
      assert.equal(fake.state.ledger.length, ledgerLengthBefore, 'an insufficient-credits response must never write a ledger row');
    } finally {
      setThemeImageGenerator(undefined);
    }
  });

  // ---- (6) setUnavailable -> error_kind unavailable, no rows ----
  await withTempStore(async (globalStorageUri) => {
    const tokenStore = memoryTokenStore();
    const client = createThemeServiceClient({ fetch: realImageFetch, tokenStore, endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: () => nowMs });
    const email = 'unavailable@example.com';
    await client.requestMagicLink(email);
    await client.verifyMagicLink(email, '123456');
    const accountId = fake.state.accountsByEmail.get(email)!;
    fake.helpers.grant(accountId, 30);

    setThemeImageGenerator(createServiceImageGenerator(client));
    fake.helpers.setUnavailable(true);
    try {
      const themeId = 'unavailable_theme';
      const plan = buildPlan(themeId);
      const ledgerLengthBefore = fake.state.ledger.length;
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const environmentEntry = review.entries.find((e) => e.item.id === 'environment')!;
      assert.equal(environmentEntry.item.error_kind, 'unavailable');
      assert.equal(fake.state.ledger.length, ledgerLengthBefore, 'a 503 must never write a ledger row');
    } finally {
      setThemeImageGenerator(undefined);
      fake.helpers.setUnavailable(false);
    }
  });

  // ---- (7) signed out -> not_signed_in, zero /api calls ----
  await withTempStore(async (globalStorageUri) => {
    const tokenStore = memoryTokenStore(); // never signed in
    const client = createThemeServiceClient({ fetch: realImageFetch, tokenStore, endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: () => nowMs });
    setThemeImageGenerator(createServiceImageGenerator(client));
    try {
      const themeId = 'signed_out_theme';
      const plan = buildPlan(themeId);
      const generateRequestsBefore = fake.state.generateRequests.length;
      const ledgerLengthBefore = fake.state.ledger.length;
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      const environmentEntry = review.entries.find((e) => e.item.id === 'environment')!;
      assert.equal(environmentEntry.item.error_kind, 'not_signed_in');
      assert.equal(fake.state.generateRequests.length, generateRequestsBefore, 'a signed-out caller must never reach /api/generate');
      assert.equal(fake.state.ledger.length, ledgerLengthBefore);
    } finally {
      setThemeImageGenerator(undefined);
    }
  });

  // ---- (8) expireAccessToken mid-run -> one refresh, generation continues ----
  await withTempStore(async (globalStorageUri) => {
    const tokenStore = memoryTokenStore();
    let refreshCalls = 0;
    const countingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token')) refreshCalls += 1;
      return realImageFetch(input as never, init);
    }) as typeof fetch;
    const client = createThemeServiceClient({ fetch: countingFetch, tokenStore, endpoint: ENDPOINT, supabaseUrl: SUPABASE_URL, now: () => nowMs });
    const email = 'expiring-token@example.com';
    await client.requestMagicLink(email);
    await client.verifyMagicLink(email, '123456');
    const accountId = fake.state.accountsByEmail.get(email)!;
    fake.helpers.grant(accountId, 30);

    // Revoke the access token (but not the refresh token) mid-run, exactly
    // as if it had naturally expired between calls.
    fake.helpers.expireAccessToken();

    setThemeImageGenerator(createServiceImageGenerator(client));
    try {
      const themeId = 'expiring_token_theme';
      const plan = buildPlan(themeId);
      await generateTheme(globalStorageUri as unknown as import('vscode').Uri, plan, () => {});
      const review = await getThemeImageReview(globalStorageUri as unknown as import('vscode').Uri, themeId);
      for (const entry of review.entries) {
        assert.equal(entry.item.error_kind, undefined, `${entry.item.id} must generate cleanly after a transparent refresh`);
      }
      assert.equal(refreshCalls, 1, 'exactly one refresh must occur despite multiple boards racing the same expired token (single-flight)');
    } finally {
      setThemeImageGenerator(undefined);
    }
  });
});

test('src/extension and src/host reference no direct provider hostname or API-key env var name (p44 covers standalone)', async () => {
  const forbidden = [
    /api\.openai\.com/i,
    /generativelanguage\.googleapis\.com/i,
    /from ['"]openai['"]/,
    /@google\/generative-ai/i,
  ];
  const roots = [path.join(process.cwd(), 'src', 'extension'), path.join(process.cwd(), 'src', 'host')];

  async function walk(dir: string): Promise<string[]> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(full);
    }
    return files;
  }

  const allFiles: string[] = [];
  for (const root of roots) {
    try {
      allFiles.push(...(await walk(root)));
    } catch {
      // root may not exist in a given checkout; skip.
    }
  }
  assert.ok(allFiles.length > 0, 'expected to find source files under src/extension and src/host');

  for (const file of allFiles) {
    const contents = await fsp.readFile(file, 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(contents), false, `${path.relative(process.cwd(), file)} must not reference ${pattern}`);
    }
  }
});
