/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * p45-t2: one-time migration notice for users who stored an OpenAI/Gemini
 * image API key in SecretStorage before theme generation moved to the
 * Corsair Theme Service (through 0.0.613). Those keys are no longer read
 * anywhere in the extension. This module never deletes or logs the stored
 * value — it only checks whether a legacy secret is non-empty, once, and
 * tells the user it's safe to clear it themselves.
 */

// Legacy secret key names, as stored by the now-removed
// src/extension/themeImageSettings.ts (SECRET_KEYS).
export const LEGACY_PROVIDER_SECRET_KEYS = [
  "tycoonagents.themeImage.openaiApiKey",
  "tycoonagents.themeImage.geminiApiKey",
] as const;

const NOTICE_SHOWN_FLAG = "tycoonagents.themeService.providerKeyNoticeShown";

const NOTICE_MESSAGE =
  "Theme generation now runs through the Corsair Theme Service. The image API key you stored earlier is no longer used. You can clear it from VS Code's secret storage whenever you like; TycoonAgents will never delete it for you.";

export interface MinimalSecretStorage {
  get(key: string): Thenable<string | undefined>;
}

export interface MinimalMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ProviderKeyMigrationNoticeOptions {
  secrets: MinimalSecretStorage;
  globalState: MinimalMemento;
  showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
}

/**
 * Shows the migration notice once, the first time it's called after any
 * legacy provider key secret is found non-empty. Safe to call on every
 * activation — after the first run (key found or not) the globalState flag
 * short-circuits all future calls.
 */
export async function maybeShowProviderKeyMigrationNotice(
  opts: ProviderKeyMigrationNoticeOptions,
): Promise<void> {
  const { secrets, globalState, showInformationMessage } = opts;

  if (globalState.get<boolean>(NOTICE_SHOWN_FLAG, false)) {
    return;
  }

  let hasLegacyKey = false;
  for (const key of LEGACY_PROVIDER_SECRET_KEYS) {
    const value = await secrets.get(key);
    if (typeof value === "string" && value.length > 0) {
      hasLegacyKey = true;
      break;
    }
  }

  if (hasLegacyKey) {
    await showInformationMessage(NOTICE_MESSAGE, "OK");
  }

  await globalState.update(NOTICE_SHOWN_FLAG, true);
}
