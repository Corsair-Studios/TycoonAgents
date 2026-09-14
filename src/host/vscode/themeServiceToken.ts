/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * VS Code adapter for {@link ThemeServiceTokenStore} (src/core/themeServiceClient.ts).
 * Backed ONLY by vscode.SecretStorage — never the extension's persisted
 * key/value state, user/workspace settings, or a workspace file, since the
 * device token must never be visible in a synced settings.json or a
 * project-tracked file (same posture as src/core/localEnvStore.ts for the
 * standalone host).
 */

// Type-only import: this file must not require the `vscode` module at
// runtime so it stays testable without a real extension host — the actual
// SecretStorage instance is injected by the caller (extension.ts).
import type * as vscode from "vscode";
import type { ThemeServiceTokenStore } from "../../core/themeServiceClient";

export const THEME_SERVICE_SECRET_KEY = "tycoonagents.themeService.deviceToken";

export function createVsCodeThemeServiceTokenStore(secrets: vscode.SecretStorage): ThemeServiceTokenStore {
  return {
    async get(): Promise<string | null> {
      const value = await secrets.get(THEME_SERVICE_SECRET_KEY);
      return value ?? null;
    },
    async set(token: string): Promise<void> {
      await secrets.store(THEME_SERVICE_SECRET_KEY, token);
    },
    async clear(): Promise<void> {
      await secrets.delete(THEME_SERVICE_SECRET_KEY);
    },
  };
}
