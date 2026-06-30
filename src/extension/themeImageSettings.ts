import * as vscode from 'vscode';

export type ThemeImageProvider = 'gemini' | 'openai';

export interface ResolvedThemeImageSettings {
  provider: ThemeImageProvider;
  apiKey: string | undefined;
  configured: boolean;
}

const SECRET_KEYS: Record<ThemeImageProvider, string> = {
  gemini: 'tycoonagents.themeImage.geminiApiKey',
  openai: 'tycoonagents.themeImage.openaiApiKey',
};
const PROVIDER_STORAGE_KEY = 'tycoonagents.themeImage.provider';

export function normalizeThemeImageProvider(value: unknown): ThemeImageProvider {
  return value === 'openai' ? 'openai' : 'gemini';
}

export async function getConfiguredThemeImageProvider(
  secrets: vscode.SecretStorage,
): Promise<ThemeImageProvider> {
  const storedProvider = await secrets.get(PROVIDER_STORAGE_KEY);
  if (storedProvider) return normalizeThemeImageProvider(storedProvider);

  const configured = vscode.workspace
    .getConfiguration('tycoonagents')
    .get<string>('themeImageProvider', 'gemini');
  return normalizeThemeImageProvider(configured);
}

export async function resolveThemeImageSettings(
  secrets: vscode.SecretStorage,
  requestedProvider?: unknown,
): Promise<ResolvedThemeImageSettings> {
  const provider = requestedProvider === undefined
    ? await getConfiguredThemeImageProvider(secrets)
    : normalizeThemeImageProvider(requestedProvider);
  const apiKey = await resolveThemeImageApiKey(secrets, provider);
  return { provider, apiKey, configured: Boolean(apiKey) };
}

export async function getThemeImageConfigurationStatus(
  secrets: vscode.SecretStorage,
): Promise<Record<ThemeImageProvider, { configured: boolean }>> {
  const [geminiKey, openaiKey] = await Promise.all([
    resolveThemeImageApiKey(secrets, 'gemini'),
    resolveThemeImageApiKey(secrets, 'openai'),
  ]);
  return {
    gemini: { configured: Boolean(geminiKey) },
    openai: { configured: Boolean(openaiKey) },
  };
}

export async function saveThemeImageSettings(
  secrets: vscode.SecretStorage,
  providerValue: unknown,
  apiKeyValue: unknown,
): Promise<ThemeImageProvider> {
  const provider = normalizeThemeImageProvider(providerValue);
  const apiKey = typeof apiKeyValue === 'string' ? apiKeyValue.trim() : '';

  // An empty field means "keep the existing key" so users can change the
  // provider without having to paste a secret again.
  if (apiKey) {
    await secrets.store(SECRET_KEYS[provider], apiKey);
  }
  await secrets.store(PROVIDER_STORAGE_KEY, provider);

  // Mirror the selection into VS Code settings when the contribution is
  // registered. A running Extension Host may not know about a newly-added
  // package.json setting until it reloads, so this mirror must never prevent
  // the API key itself from being saved securely.
  const config = vscode.workspace.getConfiguration('tycoonagents');
  if (config.inspect<string>('themeImageProvider')) {
    try {
      await config.update('themeImageProvider', provider, vscode.ConfigurationTarget.Global);
    } catch (err) {
      console.warn('TycoonAgents: Could not mirror theme image provider to User Settings:', err);
    }
  }

  return provider;
}

async function resolveThemeImageApiKey(
  secrets: vscode.SecretStorage,
  provider: ThemeImageProvider,
): Promise<string | undefined> {
  const stored = await secrets.get(SECRET_KEYS[provider]);
  if (stored) return stored;

  // Preserve compatibility with the settings/environment-variable paths that
  // existed before the in-panel secret field was added.
  const config = vscode.workspace.getConfiguration('tycoonagents');
  if (provider === 'openai') {
    return config.get<string>('openaiApiKey') || process.env.OPENAI_API_KEY;
  }
  return config.get<string>('geminiApiKey') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}
