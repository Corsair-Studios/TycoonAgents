/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * VS Code adapter for {@link ThemeServiceDeviceState} (p62-t2/referral
 * pre-fill gating) — separate from themeServiceToken.ts on purpose: that
 * file owns the device TOKEN only and is asserted by test to never touch
 * `globalState` (the token itself must live only in SecretStorage). This
 * file holds a single non-secret boolean ("has this device ever completed
 * a sign-in"), backed by `context.globalState` — a per-device Memento,
 * distinct from workspace state and never a project file. It is NOT
 * registered via `context.globalState.setKeysForSync`, so it stays this
 * device's own record.
 */

import type * as vscode from "vscode";
import type { ThemeServiceDeviceState } from "./themeServiceHost";

export const THEME_SERVICE_HAS_SIGNED_IN_KEY = "tycoonagents.themeService.hasEverSignedIn";

export function createVsCodeThemeServiceDeviceState(globalState: vscode.Memento): ThemeServiceDeviceState {
  return {
    async hasEverSignedIn(): Promise<boolean> {
      return globalState.get<boolean>(THEME_SERVICE_HAS_SIGNED_IN_KEY, false) === true;
    },
    async markSignedIn(): Promise<void> {
      await globalState.update(THEME_SERVICE_HAS_SIGNED_IN_KEY, true);
    },
  };
}
