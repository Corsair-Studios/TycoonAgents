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
// Only the OpenCode host (scripts/generate-opencode-config.mjs) honours
// custom names, and "Custom endpoint..." slots keep the free-form fields.
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
