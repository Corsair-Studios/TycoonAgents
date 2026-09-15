/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * VS Code host-side glue for the Corsair Theme Service (p42-t1). Owns:
 *  - the panel-message handlers for THEME_SERVICE_* (see messages.ts)
 *  - the in-memory PKCE code-verifier held between THEME_SERVICE_GOOGLE_START
 *    and the deep-link/pasted-code completion
 *  - status refresh on webview focus, and a bounded poll while a checkout is
 *    pending
 *
 * No `vscode` import is required to be free of side effects at module load
 * (only types are used from it, same posture as themeServiceToken.ts) so
 * this stays unit-testable without a real extension host. The concrete
 * `vscode.SecretStorage`/`openExternal`/URI-handler wiring lives in
 * panel.ts / extension.ts, which own the actual `vscode` calls.
 *
 * Never posts a token: {@link ThemeServiceStatus}-shaped payloads only ever
 * carry signedIn/email/provider/credits/pricing/pendingCheckout/error.
 */

import type * as vscode from "vscode";
import {
  createThemeServiceClient,
  type ThemeServiceClient,
  type ThemeServiceStatus,
  type ThemeServicePricing,
  type ThemeServiceError,
} from "../../core/themeServiceClient";
import { createVsCodeThemeServiceTokenStore } from "./themeServiceToken";

export interface ThemeServiceHostStatus {
  signedIn: boolean;
  email?: string;
  provider?: string;
  credits?: number;
  locked?: boolean;
  strikes?: number;
  pricing?: ThemeServicePricing;
  pendingCheckout?: boolean;
  error?: { kind: string; message: string };
}

export interface ThemeServiceHostOptions {
  secrets: vscode.SecretStorage;
  /** Opens a URL in the user's default browser (vscode.env.openExternal). */
  openExternal: (url: string) => void | Thenable<void>;
  /** Posts the current status to the webview. */
  postStatus: (status: ThemeServiceHostStatus) => void;
  /** Injectable client for tests; defaults to a real one on the VS Code token store. */
  client?: ThemeServiceClient;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const CHECKOUT_POLL_INTERVAL_MS = 5_000;
const CHECKOUT_POLL_MAX_MS = 10 * 60_000;

function toErrorPayload(error: ThemeServiceError): { kind: string; message: string } {
  return { kind: error.kind, message: error.message };
}

export interface ThemeServiceHost {
  handleGetStatus(): Promise<void>;
  /** Same computation as handleGetStatus but returns instead of posting — used by OPEN_THEME_BUILDER's THEME_BUILDER_OPENED reply. */
  getStatusSnapshot(): Promise<ThemeServiceHostStatus>;
  handleRequestMagicLink(email: string): Promise<void>;
  handleVerify(email: string, code: string): Promise<void>;
  handleGoogleStart(): Promise<void>;
  handleGoogleComplete(code: string | undefined): Promise<void>;
  handleSignOut(): Promise<void>;
  handleBuyCredits(pack: string): Promise<void>;
  /** Called by the registered vscode.window.registerUriHandler on a deep-link callback. */
  handleUriCallback(code: string): Promise<void>;
  /**
   * The shared {@link ThemeServiceClient} this host was built on (p43-t1) —
   * lets panel.ts wire `themeService.setThemeImageGenerator` to the same
   * authenticated client instance used for status/checkout, instead of
   * constructing a second one.
   */
  getClient(): ThemeServiceClient;
  start(): void;
  dispose(): void;
}

/**
 * Factory. `client` defaults to a real {@link createThemeServiceClient} built
 * on the VS Code SecretStorage-backed token store — inject a fake in tests.
 */
export function createThemeServiceHost(opts: ThemeServiceHostOptions): ThemeServiceHost {
  const client: ThemeServiceClient =
    opts.client ?? createThemeServiceClient({ tokenStore: createVsCodeThemeServiceTokenStore(opts.secrets) });
  const now = opts.now ?? (() => Date.now());
  const setIntervalImpl = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let disposed = false;
  let pendingGoogleCodeVerifier: string | null = null;
  let lastKnownCredits: number | undefined;
  let pendingCheckout = false;
  let pollHandle: unknown | undefined;
  let pollDeadline = 0;
  let lastCachedPricing: ThemeServicePricing | undefined;

  function stopPoll(): void {
    if (pollHandle !== undefined) {
      clearIntervalImpl(pollHandle);
      pollHandle = undefined;
    }
    pendingCheckout = false;
  }

  async function buildStatus(): Promise<ThemeServiceHostStatus> {
    const res = await client.getStatus();
    if (!res.ok) {
      return { signedIn: false, pendingCheckout, error: toErrorPayload(res.error) };
    }
    const status: ThemeServiceStatus = res.value;
    // Refetch pricing on every status build (it can change server-side);
    // the cached copy is kept only as a fallback when the refetch fails.
    const pricingRes = await client.getPricing();
    if (pricingRes.ok) lastCachedPricing = pricingRes.value;
    return {
      signedIn: status.signedIn,
      email: status.email,
      provider: status.role,
      credits: status.credits,
      locked: status.locked,
      strikes: status.strikes,
      pricing: lastCachedPricing,
      pendingCheckout,
    };
  }

  async function postFreshStatus(): Promise<void> {
    if (disposed) return;
    const status = await buildStatus();
    opts.postStatus(status);
  }

  async function pollTick(): Promise<void> {
    if (disposed) return;
    if (now() >= pollDeadline) {
      stopPoll();
      await postFreshStatus();
      return;
    }
    const res = await client.getStatus();
    if (res.ok && res.value.signedIn) {
      const credits = res.value.credits;
      if (lastKnownCredits !== undefined && credits !== undefined && credits > lastKnownCredits) {
        lastKnownCredits = credits;
        stopPoll();
        await postFreshStatus();
        return;
      }
      if (credits !== undefined) lastKnownCredits = credits;
    }
    // Keep polling; no separate status post per tick beyond the terminal ones
    // above, to avoid spamming the webview every 5s.
  }

  function startPoll(): void {
    stopPoll();
    pendingCheckout = true;
    pollDeadline = now() + CHECKOUT_POLL_MAX_MS;
    pollHandle = setIntervalImpl(() => {
      void pollTick();
    }, CHECKOUT_POLL_INTERVAL_MS);
  }

  async function completeGoogle(authCode: string | undefined): Promise<void> {
    if (!authCode || authCode.length === 0) return;
    const codeVerifier = pendingGoogleCodeVerifier;
    if (!codeVerifier) {
      opts.postStatus({ signedIn: false, pendingCheckout, error: { kind: "not_signed_in", message: "no pending Google sign-in" } });
      return;
    }
    pendingGoogleCodeVerifier = null;
    const res = await client.completeGoogleSignIn({ authCode, codeVerifier });
    if (!res.ok) {
      opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
      return;
    }
    await postFreshStatus();
  }

  return {
    async handleGetStatus() {
      await postFreshStatus();
    },

    async getStatusSnapshot() {
      return buildStatus();
    },

    async handleRequestMagicLink(email) {
      const res = await client.requestMagicLink(email);
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      await postFreshStatus();
    },

    async handleVerify(email, code) {
      const res = await client.verifyMagicLink(email, code);
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      await postFreshStatus();
    },

    async handleGoogleStart() {
      // publisher.name for the vscode:// deep-link scheme, resolved by the
      // caller (panel.ts) via package.json — kept here only as documentation
      // of the redirect shape the caller must pass through startGoogleSignIn.
      const redirectTo = "vscode://tycoonagents.tycoonagents/theme-service-auth";
      const res = await client.startGoogleSignIn({ redirectTo });
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      pendingGoogleCodeVerifier = res.value.codeVerifier;
      await opts.openExternal(res.value.browserUrl);
    },

    async handleGoogleComplete(code) {
      await completeGoogle(code);
    },

    async handleUriCallback(code) {
      await completeGoogle(code);
    },

    getClient() {
      return client;
    },

    async handleSignOut() {
      await client.signOut();
      stopPoll();
      lastKnownCredits = undefined;
      await postFreshStatus();
    },

    async handleBuyCredits(pack) {
      // Refetch pricing immediately before checkout so the pack picker (and
      // any price shown to the user) reflects current pricing at purchase
      // time; keep the cached copy if this refetch fails.
      const pricingRes = await client.getPricing();
      if (pricingRes.ok) lastCachedPricing = pricingRes.value;
      const res = await client.createCheckoutSession(pack);
      if (!res.ok) {
        opts.postStatus({ signedIn: false, pendingCheckout, error: toErrorPayload(res.error) });
        return;
      }
      const statusRes = await client.getStatus();
      lastKnownCredits = statusRes.ok ? statusRes.value.credits : undefined;
      await opts.openExternal(res.value.url);
      startPoll();
      await postFreshStatus();
    },

    start() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      stopPoll();
      pendingGoogleCodeVerifier = null;
    },
  };
}
