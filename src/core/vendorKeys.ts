/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// Vendor key spec: the single source of truth for which environment variable
// NAMES a bridged vendor actually reads. On the Claude Code and Codex hosts
// the MCP bridges (hooks/openai-compatible-mcp.cjs VENDOR_DEFAULTS,
// hooks/gemini-mcp-wrapper.cjs, the Codex/Claude CLI bridges) read FIXED
// names chosen by model prefix, so the Routing screen must show those names
// read-only instead of asking the user to type names that would be ignored.
// "Custom endpoint..." slots keep free-form NAME fields; the OpenCode host
// (scripts/generate-opencode-config.mjs) and, since the custom-endpoint
// change, the Claude Code / Codex bridges resolve those names (validated by
// the custom* helpers at the bottom of this file).
//
// Names only, never values. No `vscode` import: reaches the webview through
// RoutingPresets.vendorKeys (routingHostOps.ts buildPresets), the same way
// the vendor/model presets do. A test asserts the openai-compatible rows
// match hooks/openai-compatible-mcp.cjs VENDOR_DEFAULTS.
// ---------------------------------------------------------------------------

export interface VendorKeyRow {
  /** Fixed env var name the bridge reads. */
  env: string;
  /** "credential" (secret, password input) or "endpoint" (plain URL). */
  kind: "credential" | "endpoint";
  label: string;
  /** A missing required row blocks Test connection ("missing key"). */
  required: boolean;
  /** Endpoint rows: the URL the bridge uses when the env var is unset. */
  defaultValue?: string;
  note?: string;
}

export interface VendorKeyTestTarget {
  /** .mcp.json server name / bridge. */
  server: "openai-compatible" | "gemini";
  /** Cheapest real tool: a 1-token chat, or the bridge's ping tool. */
  tool: "chat" | "ping";
}

export interface VendorKeySpec {
  id: string;
  label: string;
  /** Slot vendor names this spec applies to (lower-case). */
  vendors: string[];
  /** Model-id prefix the bridge routes on, e.g. "xai/". */
  modelPrefix?: string;
  auth: "key" | "signin";
  /** Sign-in vendors: the CLI whose login is used ("Codex", "Claude", "Antigravity"). */
  signIn?: string;
  rows: VendorKeyRow[];
  /** null: no cheap real call exists, so no Test button is offered. */
  test: VendorKeyTestTarget | null;
  /** Model used for the Test call when the slot's model does not carry modelPrefix. */
  testModel?: string;
}

const KEY_LABEL = "API key";
const URL_LABEL = "Base URL";

export const VENDOR_KEY_SPECS: VendorKeySpec[] = [
  {
    id: "xai",
    label: "xAI",
    vendors: ["xai"],
    modelPrefix: "xai/",
    auth: "key",
    rows: [
      { env: "XAI_API_KEY", kind: "credential", label: KEY_LABEL, required: true },
      { env: "XAI_BASE_URL", kind: "endpoint", label: URL_LABEL, required: false, defaultValue: "https://api.x.ai/v1" },
    ],
    test: { server: "openai-compatible", tool: "chat" },
    testModel: "xai/grok-build-0.1",
  },
  {
    id: "mistral",
    label: "Mistral",
    vendors: ["mistral"],
    modelPrefix: "mistral/",
    auth: "key",
    rows: [
      { env: "MISTRAL_API_KEY", kind: "credential", label: KEY_LABEL, required: true },
      { env: "MISTRAL_BASE_URL", kind: "endpoint", label: URL_LABEL, required: false, defaultValue: "https://api.mistral.ai/v1" },
    ],
    test: { server: "openai-compatible", tool: "chat" },
    testModel: "mistral/mistral-large-latest",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    vendors: ["moonshot"],
    modelPrefix: "moonshot/",
    auth: "key",
    rows: [
      { env: "MOONSHOT_API_KEY", kind: "credential", label: KEY_LABEL, required: true },
      { env: "MOONSHOT_BASE_URL", kind: "endpoint", label: URL_LABEL, required: false, defaultValue: "https://api.moonshot.ai/v1" },
    ],
    test: { server: "openai-compatible", tool: "chat" },
    testModel: "moonshot/kimi-k2.6",
  },
  {
    id: "openai",
    label: "OpenAI",
    vendors: ["openai"],
    auth: "signin",
    signIn: "Codex",
    rows: [],
    test: null,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    vendors: ["anthropic"],
    auth: "signin",
    signIn: "Claude",
    rows: [],
    test: null,
  },
  {
    id: "google",
    label: "Google",
    vendors: ["google"],
    auth: "signin",
    signIn: "Antigravity",
    // Only the Gemini CLI backend (GEMINI_MCP_BACKEND=gemini) reads a key.
    rows: [
      { env: "GEMINI_API_KEY", kind: "credential", label: "Gemini API key", required: false, note: "Gemini CLI backend only" },
    ],
    test: { server: "gemini", tool: "ping" },
  },
];

/** Spec for a slot vendor (case-insensitive), or null for an unknown/custom vendor (free-form fields stay). */
export function vendorKeySpecFor(vendor: string | undefined | null): VendorKeySpec | null {
  const v = String(vendor ?? "").trim().toLowerCase();
  if (!v) return null;
  return VENDOR_KEY_SPECS.find((s) => s.vendors.includes(v)) ?? null;
}

export function vendorKeySpecById(id: string | undefined | null): VendorKeySpec | null {
  return VENDOR_KEY_SPECS.find((s) => s.id === id) ?? null;
}

/** Every env var name any spec reads (for envProbe seeding). */
export function allVendorKeyEnvNames(): string[] {
  const names = new Set<string>();
  for (const s of VENDOR_KEY_SPECS) for (const r of s.rows) names.add(r.env);
  return Array.from(names);
}

/** One-line sign-in text, e.g. "Uses your Codex sign-in - no key needed". */
export function signInNote(spec: VendorKeySpec): string {
  return `Uses your ${spec.signIn ?? spec.label} sign-in — no key needed`;
}

// ---------------------------------------------------------------------------
// Custom endpoint ("Custom endpoint..." vendor): any OpenAI-compatible server
// (Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek...). The slot names two
// env vars, endpointEnv (base URL) and apiKeyEnv (optional key). The bridge
// resolves them from the process env then the per-user store, so several
// custom endpoints can exist side by side. Because a user-chosen NAME decides
// which stored secret is sent to which URL, both names and the URL are checked
// here. The same rules are mirrored in hooks/openai-compatible-mcp.cjs and
// hooks/dispatcherAdapters.cjs (those files ship without this module); a test
// asserts all three agree. Names only, never values.
// ---------------------------------------------------------------------------

/** apiKeyEnv must look like a credential variable. */
export const CUSTOM_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*(_API_KEY|_KEY|_TOKEN)$/;
/** endpointEnv must be an upper-case variable name ending in _BASE_URL. */
export const CUSTOM_ENDPOINT_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}_BASE_URL$/;

/** Every credential name a fixed vendor spec reads; never sent to a custom endpoint. */
function fixedSpecKeyNames(): string[] {
  const out: string[] = [];
  for (const s of VENDOR_KEY_SPECS) for (const r of s.rows) if (r.kind === "credential") out.push(r.env);
  return out;
}

const CUSTOM_KEY_DENY_BASE = ["GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "VERCEL_TOKEN", "CF_API_TOKEN", "DEPLOY_TOKEN", "PYPI_TOKEN", "CODECOV_TOKEN", "SONAR_TOKEN", "TERRAFORM_TOKEN", "TF_TOKEN"];
const CUSTOM_KEY_DENY_EXACT: string[] = Array.from(new Set([...CUSTOM_KEY_DENY_BASE, ...fixedSpecKeyNames()])).sort();
const CUSTOM_KEY_DENY_PREFIX: string[] = ["ANTHROPIC_", "ASANA_", "ATLASSIAN_", "AWS_", "AZURE_", "BITBUCKET_", "CF_", "CIRCLECI_", "CLAUDE_", "CLOUDFLARE_", "DATADOG_", "DD_", "DIGITALOCEAN_", "DOCKER_", "EXPO_", "FIREBASE_", "GCLOUD_", "GCP_", "GH_", "GITHUB_", "GITLAB_", "GPG_", "HEROKU_", "HF_", "HUGGINGFACE_", "JIRA_", "LINEAR_", "NETLIFY_", "NOTION_", "NPM_", "PAGERDUTY_", "PGP_", "RENDER_", "SENDGRID_", "SENTRY_", "SLACK_", "SSH_", "STRIPE_", "SUPABASE_", "TRAVIS_", "TWILIO_", "TYCOON_", "VERCEL_"];
const CUSTOM_KEY_DENY_SUBSTR: string[] = ["GPG", "PASSPHRASE", "PASSWORD", "PGP", "PRIVATE_KEY", "SSH"];

/** The rule data itself; a test deep-equals this against both hook copies. */
export const CUSTOM_ENDPOINT_RULES = {
  keyNameRe: CUSTOM_KEY_NAME_RE.source,
  endpointNameRe: CUSTOM_ENDPOINT_NAME_RE.source,
  denyExact: CUSTOM_KEY_DENY_EXACT,
  denyPrefix: CUSTOM_KEY_DENY_PREFIX,
  denySubstr: CUSTOM_KEY_DENY_SUBSTR,
};

/** Returns a user-facing reason when `name` may not be used as a custom endpoint's key variable, else undefined. */
export function customKeyNameProblem(name: string, baseUrl?: string, endpointEnv?: string): string | undefined {
  if (typeof name !== "string" || !CUSTOM_KEY_NAME_RE.test(name)) {
    return `API key variable "${String(name).slice(0, 60)}" must look like a credential name, e.g. GROQ_API_KEY (upper case, ending in _API_KEY, _KEY or _TOKEN).`;
  }
  if (name === "OPENAI_COMPAT_API_KEY") {
    if (endpointEnv === "OPENAI_COMPAT_BASE_URL") return undefined;
    return "OPENAI_COMPAT_API_KEY belongs to the generic OPENAI_COMPAT_BASE_URL endpoint only; use a dedicated variable (e.g. MYPROVIDER_API_KEY).";
  }
  if (name === "OPENAI_API_KEY") {
    let host = "";
    try { host = new URL(baseUrl || "").hostname.toLowerCase(); } catch { /* no URL */ }
    if (host === "api.openai.com") return undefined;
    return "OPENAI_API_KEY is only sent to api.openai.com; use a separate variable (e.g. MYPROVIDER_API_KEY) for another endpoint.";
  }
  if (
    CUSTOM_KEY_DENY_EXACT.includes(name) ||
    CUSTOM_KEY_DENY_PREFIX.some((p) => name.startsWith(p)) ||
    CUSTOM_KEY_DENY_SUBSTR.some((s) => name.includes(s))
  ) {
    return `${name} is a credential for another service and is never sent to a custom endpoint; use a dedicated variable (e.g. MYPROVIDER_API_KEY).`;
  }
  return undefined;
}

/** Returns a user-facing reason when `name` may not be used as a custom endpoint's base URL variable. */
export function customEndpointNameProblem(name: string): string | undefined {
  if (typeof name !== "string" || !CUSTOM_ENDPOINT_NAME_RE.test(name)) {
    return `Base URL variable "${String(name).slice(0, 60)}" must be an upper-case variable name ending in _BASE_URL, e.g. OLLAMA_BASE_URL.`;
  }
  return undefined;
}

/** Base URL rule: https, or http only for localhost / 127.0.0.1 / ::1; no embedded credentials. */
export function customEndpointUrlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return "The base URL is not a valid URL.";
  }
  if (u.username || u.password) return "The base URL must not contain credentials.";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host)) return undefined;
  return "The base URL must use https (http is only allowed for localhost, 127.0.0.1 or ::1).";
}
