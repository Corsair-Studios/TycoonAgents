// TycoonAgents standalone — Theme Service host wiring (p44-t1).
//
// Standalone analog of src/host/vscode/themeServiceHost.ts's
// createThemeServiceHost. Reuses the compiled, vscode-free
// out/src/host/vscode/themeServiceHost.js unchanged (it only ever imported
// `vscode` as a type — confirmed by grepping the compiled JS for
// require("vscode"), which finds nothing) — no theme-service business logic
// (status building, pricing refetch, checkout poll, Google PKCE handshake)
// is duplicated here. Only what genuinely differs per host is provided:
//   - the token store: createStandaloneThemeServiceTokenStore (device-token
//     file under app-data secrets/) instead of vscode.SecretStorage
//   - the URL opener: a spawned OS "open URL" command instead of
//     vscode.env.openExternal
//   - Google sign-in completion: VS Code has a registerUriHandler deep link
//     (vscode://...); standalone has no such handler, so this module runs a
//     short-lived loopback HTTP listener on 127.0.0.1 (random port) and
//     passes its URL as `redirectTo`. The pasted-code fallback
//     (THEME_SERVICE_GOOGLE_COMPLETE) still works identically to VS Code
//     while the listener is open.
//
// Node built-ins only.

import http from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createStandaloneThemeServiceTokenStore } from './themeServiceToken.mjs';
import { resolveAppDataDir, createAppData } from './appData.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root -> out/src/host/vscode/themeServiceHost.js
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const THEME_SERVICE_HOST_JS = path.join(REPO_ROOT, 'out', 'src', 'host', 'vscode', 'themeServiceHost.js');
const THEME_SERVICE_CLIENT_JS = path.join(REPO_ROOT, 'out', 'src', 'core', 'themeServiceClient.js');

const require = createRequire(import.meta.url);

function requireCompiled(modulePath, label) {
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      `[tycoonagents-standalone] themeServiceHost: ${label} not found at ${modulePath}. The compiled ` +
        '`out/` directory is missing or stale — run `npx tsc -p .` from the repo root first, then restart the ' +
        'standalone server.',
    );
  }
  return require(modulePath);
}

let _themeServiceHostModule;
function themeServiceHostModule() {
  if (!_themeServiceHostModule) {
    _themeServiceHostModule = requireCompiled(THEME_SERVICE_HOST_JS, 'out/src/host/vscode/themeServiceHost.js');
  }
  return _themeServiceHostModule;
}

let _themeServiceClientModule;
function themeServiceClientModule() {
  if (!_themeServiceClientModule) {
    _themeServiceClientModule = requireCompiled(THEME_SERVICE_CLIENT_JS, 'out/src/core/themeServiceClient.js');
  }
  return _themeServiceClientModule;
}

const GOOGLE_LOOPBACK_TIMEOUT_MS = 10 * 60_000;

// p62-t2: not a secret (a single boolean) — kept via createAppData's plain
// JSON file, never the secrets/ store used by themeServiceToken.mjs, and
// never a project file.
const DEVICE_STATE_FILE = 'theme-service-device-state.json';

/**
 * Standalone analog of createVsCodeThemeServiceDeviceState
 * (src/host/vscode/themeServiceToken.ts) — same
 * {@link import('../../src/host/vscode/themeServiceHost').ThemeServiceDeviceState}
 * contract, backed by a JSON file under the standalone app-data dir instead
 * of vscode.Memento.
 * @param {string} [appDataDir]
 */
function createStandaloneThemeServiceDeviceState(appDataDir) {
  const dir = appDataDir || resolveAppDataDir({ env: process.env });
  const appData = createAppData({ dir });
  return {
    async hasEverSignedIn() {
      const value = appData.readJson(DEVICE_STATE_FILE, { hasSignedIn: false });
      return Boolean(value && value.hasSignedIn === true);
    },
    async markSignedIn() {
      appData.writeJson(DEVICE_STATE_FILE, { hasSignedIn: true });
    },
  };
}

/** Opens `url` in the platform default browser. Mirrors the openAgentFile
 * opener pattern already used in server.mjs (spawn, detached, ignored
 * stdio) — never throws synchronously; logs and swallows spawn failures. */
function openExternalUrl(url) {
  const { spawn } = require('node:child_process');
  try {
    if (process.platform === 'win32') {
      // rundll32 url.dll,FileProtocolHandler <url> — unlike `cmd /c start`,
      // this never passes the URL through cmd.exe's shell parser, so `&`,
      // `%`, and `#` in the OAuth browserUrl (query-string separators/PKCE
      // params) survive intact instead of splitting the command or
      // triggering env-var expansion.
      spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (err) {
    console.error('[tycoonagents-standalone] themeServiceHost: failed to open browser URL:', err instanceof Error ? err.message : err);
  }
}

const CLOSE_TAB_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>TycoonAgents</title></head>' +
  '<body style="font:14px sans-serif;padding:2rem;">Signed in. You can close this tab and return to TycoonAgents.</body></html>';

/**
 * Starts a short-lived loopback HTTP listener for the Google OAuth redirect.
 * Resolves the redirect URL immediately (before any request arrives);
 * `onCode(code)` fires once a `GET /?code=...` request lands, after which
 * the listener responds with a "close this tab" page and stays open only
 * long enough to flush the response (it is the caller's job to close() it
 * once sign-in has been completed, matching handleGoogleComplete's
 * single-use-verifier posture).
 *
 * @param {(code: string) => void} onCode
 * @returns {Promise<{ redirectTo: string, port: number, close: () => void }>}
 */
function startGoogleLoopbackListener(onCode) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(CLOSE_TAB_HTML);
        if (code) onCode(code);
      } catch (err) {
        console.error('[tycoonagents-standalone] themeServiceHost: loopback listener request failed:', err instanceof Error ? err.message : err);
        try {
          res.writeHead(400).end();
        } catch {
          /* ignore */
        }
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        redirectTo: `http://127.0.0.1:${port}/`,
        port,
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

/**
 * Factory. Standalone analog of createThemeServiceHost (VS Code) — same
 * ThemeServiceHost interface (handleGetStatus/getStatusSnapshot/
 * handleRequestMagicLink/handleVerify/handleGoogleStart/
 * handleGoogleComplete/handleSignOut/handleBuyCredits/getClient/start/
 * dispose), plus `getLoopbackPort()` for tests to observe the open Google
 * loopback listener (undefined when none is open).
 *
 * @param {{
 *   openExternal?: (url: string) => void,
 *   postStatus: (status: object) => void,
 *   client?: object,
 *   appDataDir?: string,
 *   endpoint?: string,
 *   supabaseUrl?: string,
 *   supabaseAnonKey?: string,
 *   fetch?: typeof fetch,
 * }} opts
 */
export function createThemeServiceHost(opts) {
  const { createThemeServiceHost: createVsCodeHost } = themeServiceHostModule();

  // p64-t1: effective Theme Service endpoint host (hostname only), set only
  // when an override is in effect and this factory built the client itself
  // (a fully test-supplied opts.client owns its own endpoint — never
  // reported here). Read from THEME_SERVICE_ENDPOINT env var when
  // opts.endpoint isn't explicitly supplied (tests).
  let effectiveEndpointHost;
  let client = opts.client;
  if (!client) {
    const { createThemeServiceClient, resolveThemeServiceEndpoint } = themeServiceClientModule();
    const tokenStore = createStandaloneThemeServiceTokenStore({ appDataDir: opts.appDataDir });
    const rawEndpoint = opts.endpoint ?? process.env.THEME_SERVICE_ENDPOINT;
    const resolution = resolveThemeServiceEndpoint(rawEndpoint);
    if (resolution.warning) {
      console.warn(`[tycoonagents-standalone] ${resolution.warning}`);
    }
    if (resolution.overridden) {
      effectiveEndpointHost = new URL(resolution.endpoint).host;
    }
    client = createThemeServiceClient({
      tokenStore,
      fetch: opts.fetch,
      endpoint: resolution.overridden ? resolution.endpoint : undefined,
      supabaseUrl: opts.supabaseUrl,
      supabaseAnonKey: opts.supabaseAnonKey,
      clientVersion: opts.clientVersion,
    });
  }

  const openExternal = opts.openExternal ?? openExternalUrl;

  let loopback; // { redirectTo, port, close } | undefined
  let loopbackTimeoutHandle;
  let pendingCodeVerifier = null;

  function closeLoopback() {
    if (loopbackTimeoutHandle !== undefined) {
      clearTimeout(loopbackTimeoutHandle);
      loopbackTimeoutHandle = undefined;
    }
    if (loopback) {
      loopback.close();
      loopback = undefined;
    }
  }

  // The compiled VS Code host owns all status/pricing/checkout-poll/PKCE
  // logic unchanged; only openExternal/postStatus/client differ per host.
  const deviceState = createStandaloneThemeServiceDeviceState(opts.appDataDir);

  // p64-t1: inner (the compiled VS Code host) computes its own
  // effectiveEndpointHost from an endpointOverride never passed here (this
  // factory built `client` itself, above) — so it is always undefined on
  // inner's own statuses. Patch it in on every status this factory hands
  // back out, whichever path produced it.
  function withEndpointHost(status) {
    return effectiveEndpointHost ? { ...status, endpointHost: effectiveEndpointHost } : status;
  }

  const inner = createVsCodeHost({
    // `secrets` is never read when `client` is supplied (see
    // out/src/host/vscode/themeServiceHost.js: `opts.client ?? create...`)
    // — passed as undefined deliberately, not a fake vscode.SecretStorage.
    client,
    openExternal,
    postStatus: (status) => opts.postStatus(withEndpointHost(status)),
    deviceState,
  });

  // Overrides the VS Code host's vscode:// deep-link completion: reimplemented
  // here (not delegated to inner.handleGoogleComplete/handleUriCallback,
  // which read inner's OWN pendingGoogleCodeVerifier — never set, since
  // inner.handleGoogleStart is never called) using the identical client call
  // and error-payload posting shape as the VS Code host.
  async function handleGoogleComplete(code) {
    if (!code) return;
    const codeVerifier = pendingCodeVerifier;
    if (!codeVerifier) {
      opts.postStatus({ signedIn: false, pendingCheckout: false, error: { kind: 'not_signed_in', message: 'no pending Google sign-in' } });
      return;
    }
    pendingCodeVerifier = null;
    const res = await client.completeGoogleSignIn({ authCode: code, codeVerifier });
    if (!res.ok) {
      opts.postStatus({ signedIn: false, pendingCheckout: false, error: { kind: res.error.kind, message: res.error.message } });
      return;
    }
    // p62-t2: this path bypasses inner.handleGoogleComplete entirely (see
    // module doc above), so the first-sign-in/referral-apply bookkeeping
    // inner would otherwise do internally has to be invoked explicitly here.
    await inner.notifySignInSucceeded();
    opts.postStatus(withEndpointHost(await inner.getStatusSnapshot()));
  }

  // Overrides the VS Code host's vscode:// deep-link redirectTo: starts a
  // loopback listener first, then calls the SAME client.startGoogleSignIn.
  async function handleGoogleStart() {
    closeLoopback();
    try {
      const listener = await startGoogleLoopbackListener((code) => {
        void handleGoogleComplete(code).finally(() => closeLoopback());
      });
      loopback = listener;
      loopbackTimeoutHandle = setTimeout(() => {
        closeLoopback();
      }, GOOGLE_LOOPBACK_TIMEOUT_MS);
      loopbackTimeoutHandle.unref?.();
      const res = await client.startGoogleSignIn({ redirectTo: listener.redirectTo });
      if (!res.ok) {
        closeLoopback();
        opts.postStatus({ signedIn: false, pendingCheckout: false, error: { kind: res.error.kind, message: res.error.message } });
        return;
      }
      // Held in this factory's own closure (not inner's) — mirrors the VS
      // Code host's internal pendingGoogleCodeVerifier posture one level up.
      pendingCodeVerifier = res.value.codeVerifier;
      openExternal(res.value.browserUrl);
    } catch (err) {
      closeLoopback();
      opts.postStatus({
        signedIn: false,
        pendingCheckout: false,
        error: { kind: 'unavailable', message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return {
    handleGetStatus: () => inner.handleGetStatus(),
    getStatusSnapshot: async () => withEndpointHost(await inner.getStatusSnapshot()),
    handleRequestMagicLink: (email) => inner.handleRequestMagicLink(email),
    handleVerify: (email, code) => inner.handleVerify(email, code),
    handleGoogleStart,
    handleGoogleComplete,
    handleSignOut: () => inner.handleSignOut(),
    handleBuyCredits: (pack) => inner.handleBuyCredits(pack),
    handleSetReferralCode: (code) => inner.handleSetReferralCode(code),
    getClient: () => inner.getClient(),
    getEffectiveEndpointHost: () => effectiveEndpointHost,
    getLoopbackPort: () => loopback?.port,
    start: () => inner.start(),
    dispose: () => {
      closeLoopback();
      inner.dispose();
    },
  };
}
