/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * VS Code adapter for {@link ThemeServiceCreditsCache} (follow-up fix to the
 * Theme Builder credits chip disappearing during a slow/cold-start refresh —
 * the webview's own localStorage cache isn't a guaranteed durable store, so
 * this backs the same "last known balance" with `context.globalState`
 * instead: a per-device Memento that survives a webview reload, a private
 * window, cleared site data, and a full VS Code restart.
 *
 * Stores ONLY a user id (the Theme Service account email, used purely as an
 * opaque key so a stale balance never displays under a different signed-in
 * account) and a credits number — never a session token, never anything
 * secret. NOT registered via `globalState.setKeysForSync`, so it stays this
 * device's own record, matching themeServiceDeviceState.ts's posture.
 */

import type * as vscode from "vscode";
import type { ThemeServiceCreditsCache } from "./themeServiceHost";

export const THEME_SERVICE_CREDITS_CACHE_KEY = "tycoonagents.themeService.cachedCredits";

interface StoredCreditsRecord {
  userId: string;
  credits: number;
}

function isStoredCreditsRecord(v: unknown): v is StoredCreditsRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as StoredCreditsRecord).userId === "string" &&
    (v as StoredCreditsRecord).userId.length > 0 &&
    typeof (v as StoredCreditsRecord).credits === "number" &&
    Number.isFinite((v as StoredCreditsRecord).credits)
  );
}

export function createVsCodeThemeServiceCreditsCache(globalState: vscode.Memento): ThemeServiceCreditsCache {
  return {
    get(): { userId: string; credits: number } | undefined {
      const raw = globalState.get<unknown>(THEME_SERVICE_CREDITS_CACHE_KEY);
      return isStoredCreditsRecord(raw) ? { userId: raw.userId, credits: raw.credits } : undefined;
    },
    async set(userId: string, credits: number): Promise<void> {
      if (!userId || typeof credits !== "number" || !Number.isFinite(credits)) return;
      await globalState.update(THEME_SERVICE_CREDITS_CACHE_KEY, { userId, credits });
    },
    async clear(): Promise<void> {
      await globalState.update(THEME_SERVICE_CREDITS_CACHE_KEY, undefined);
    },
  };
}
