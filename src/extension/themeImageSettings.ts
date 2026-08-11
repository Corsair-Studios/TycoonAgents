import * as vscode from 'vscode';
import { resolveImageModel, resolveImageQuality } from './imageModels';

export type ThemeImageProvider = 'gemini' | 'openai';

export interface ResolvedThemeImageSettings {
  provider: ThemeImageProvider;
  apiKey: string | undefined;
  configured: boolean;
  /** Resolved model id to request — the user's override, or the latest default. */
  model: string;
  /**
   * Resolved OpenAI image `quality` ('low' | 'medium' | 'high') — the user's
   * override, or 'medium'. OpenAI-only: undefined when provider is 'gemini',
   * since Gemini has no `quality` parameter and must never receive one.
   */
  quality: string | undefined;
}

const SECRET_KEYS: Record<ThemeImageProvider, string> = {
  gemini: 'tycoonagents.themeImage.geminiApiKey',
  openai: 'tycoonagents.themeImage.openaiApiKey',
};
const PROVIDER_STORAGE_KEY = 'tycoonagents.themeImage.provider';

/**
 * Settings key per provider holding the user's model override. Empty/unset
 * means "always use the latest recommended model" — see imageModels.ts.
 * Mirrors the flat `tycoonagents.geminiApiKey` / `tycoonagents.openaiApiKey`
 * naming already used for the API key settings (not namespaced under
 * `themeImage.`, despite the secret-storage keys above being namespaced).
 */
const MODEL_SETTING_KEYS: Record<ThemeImageProvider, string> = {
  gemini: 'geminiModel',
  openai: 'openaiModel',
};

/**
 * Settings key holding the user's OpenAI image `quality` override
 * ('low' | 'medium' | 'high'). OpenAI-only — Gemini has no equivalent
 * parameter, see imageModels.ts's IMAGE_QUALITY_OPTIONS doc comment. Empty/
 * unset means "medium", matching the value this replaced when quality was
 * hardcoded.
 */
const OPENAI_QUALITY_SETTING_KEY = 'openaiImageQuality';

export function normalizeThemeImageProvider(value: unknown): ThemeImageProvider {
  return value === 'gemini' ? 'gemini' : 'openai';
}

export async function getConfiguredThemeImageProvider(
  secrets: vscode.SecretStorage,
): Promise<ThemeImageProvider> {
  const storedProvider = await secrets.get(PROVIDER_STORAGE_KEY);
  if (storedProvider) return normalizeThemeImageProvider(storedProvider);

  const configured = vscode.workspace
    .getConfiguration('tycoonagents')
    .get<string>('themeImageProvider', 'openai');
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
  const model = resolveThemeImageModel(provider);
  const quality = provider === 'openai' ? resolveThemeImageQuality() : undefined;
  return { provider, apiKey, configured: Boolean(apiKey), model, quality };
}

/**
 * Resolve the configured model override for a provider, falling back to the
 * latest recommended model (see imageModels.ts) when unset/blank. No secret
 * storage involved — model ids aren't sensitive, so this reads straight from
 * VS Code settings.
 */
export function resolveThemeImageModel(provider: ThemeImageProvider): string {
  const config = vscode.workspace.getConfiguration('tycoonagents');
  const stored = config.get<string>(MODEL_SETTING_KEYS[provider]);
  return resolveImageModel(provider, stored);
}

/**
 * Resolve the configured OpenAI image `quality` override, falling back to
 * 'medium' when unset/blank/unrecognized (see {@link resolveImageQuality}).
 * OpenAI-only — callers must not apply this to Gemini requests.
 */
export function resolveThemeImageQuality(): string {
  const config = vscode.workspace.getConfiguration('tycoonagents');
  const stored = config.get<string>(OPENAI_QUALITY_SETTING_KEY);
  return resolveImageQuality(stored);
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

/**
 * Persist only the provider + per-provider model override — never touches
 * the API key secret. Used by the webview's provider/model dropdown
 * `change` listeners so a selection survives closing/reopening the panel
 * without requiring a Save click (which also carries the api_key field and
 * would otherwise risk clobbering the stored key with a blank one).
 */
export async function saveThemeImagePreference(
  secrets: vscode.SecretStorage,
  { provider: providerValue, model: modelValue, quality: qualityValue }: { provider: unknown; model: unknown; quality?: unknown },
): Promise<ThemeImageProvider> {
  const provider = normalizeThemeImageProvider(providerValue);
  await secrets.store(PROVIDER_STORAGE_KEY, provider);

  const config = vscode.workspace.getConfiguration('tycoonagents');
  if (config.inspect<string>('themeImageProvider')) {
    try {
      await config.update('themeImageProvider', provider, vscode.ConfigurationTarget.Global);
    } catch (err) {
      console.warn('TycoonAgents: Could not mirror theme image provider to User Settings:', err);
    }
  }

  const model = typeof modelValue === 'string' ? modelValue.trim() : '';
  const modelConfigKey = MODEL_SETTING_KEYS[provider];
  if (config.inspect<string>(modelConfigKey)) {
    try {
      await config.update(modelConfigKey, model, vscode.ConfigurationTarget.Global);
    } catch (err) {
      console.warn(`TycoonAgents: Could not save ${modelConfigKey} to User Settings:`, err);
    }
  }

  // Quality is OpenAI-only (see OPENAI_QUALITY_SETTING_KEY doc comment) — a
  // quality value is only persisted when the preference being saved is for
  // 'openai'; the Gemini branch never writes this key.
  if (provider === 'openai') {
    const quality = typeof qualityValue === 'string' ? qualityValue.trim() : '';
    if (config.inspect<string>(OPENAI_QUALITY_SETTING_KEY)) {
      try {
        await config.update(OPENAI_QUALITY_SETTING_KEY, quality, vscode.ConfigurationTarget.Global);
      } catch (err) {
        console.warn(`TycoonAgents: Could not save ${OPENAI_QUALITY_SETTING_KEY} to User Settings:`, err);
      }
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
