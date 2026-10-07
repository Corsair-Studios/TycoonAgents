/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// "Test connection" for the Routing screen's fixed vendor key rows. Shared by
// the VS Code panel and the standalone server so both behave identically.
// Spawns the vendor's real bridge (as the dispatcher does, reusing
// hooks/dispatcherBridgeClient.cjs as a library) and makes the cheapest real
// call: a 1-token chat on the openai-compatible bridge, or the Gemini
// bridge's ping tool. The result is mapped from the bridge envelope
// (status + error.kind from hooks/bridge-result.cjs) to a small closed set of
// states. No key value is ever read into the result, logged, or returned:
// the only text that leaves is a redacted, length-capped bridge message.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as childProcess from "child_process";

import { getValue as localEnvGetValue, hasValue as localEnvHasValue } from "./localEnvStore";
import { vendorKeySpecById, VENDOR_KEY_SPECS, type VendorKeySpec } from "./vendorKeys";

export type VendorKeyTestState =
  | "ok"
  | "missing_key"
  | "auth"
  | "not_found"
  | "timeout"
  | "network"
  | "not_installed"
  | "custom_url"
  | "busy"
  | "error";

export interface VendorKeyTestResult {
  vendor: string;
  state: VendorKeyTestState;
  message: string;
}

export interface BridgeAttemptLike {
  status?: string;
  summary?: string;
  error?: { kind?: string; message?: string };
}

export const VENDOR_KEY_TEST_TIMEOUT_MS = 20000;
const BRIDGE_STEP_TIMEOUT_MS = 15000;
const MESSAGE_MAX = 200;

const STATE_TEXT: Record<VendorKeyTestState, string> = {
  ok: "Connection works.",
  missing_key: "Missing key: set the value first.",
  auth: "Auth rejected: the provider refused this key.",
  not_found: "Model not found at this endpoint.",
  timeout: "Timed out after 20 seconds.",
  network: "Could not reach the endpoint.",
  not_installed: "The bridge for this vendor is not installed in this project.",
  custom_url: "Custom base URL in use.",
  busy: "Already testing.",
  error: "The test call failed.",
};

/** Pure mapping of a normalized bridge attempt (dispatcherBridgeClient.normalizeAttempt) to a test state. */
export function mapBridgeAttempt(attempt: BridgeAttemptLike | null | undefined): VendorKeyTestState {
  if (!attempt) return "error";
  if (attempt.status === "ok") return "ok";
  if (attempt.status === "timeout") return "timeout";
  switch (attempt.error?.kind) {
    case "auth":
      return "auth";
    case "not_found":
      return "not_found";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "cli_missing":
    case "not_configured":
      return "not_installed";
    default:
      return "error";
  }
}

/** Every value of every spec credential name (env + per-user store), any length. */
function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const spec of VENDOR_KEY_SPECS) {
    for (const row of spec.rows) {
      if (row.kind !== "credential") continue;
      const fromEnv = env[row.env];
      if (typeof fromEnv === "string" && fromEnv !== "") out.add(fromEnv.trim() || fromEnv);
      try {
        const stored = localEnvGetValue(row.env);
        if (typeof stored === "string" && stored !== "") out.add(stored.trim() || stored);
      } catch {
        /* fail-open */
      }
    }
  }
  // Longest first so a value that contains another is fully replaced.
  return Array.from(out).sort((a, b) => b.length - a.length);
}

/**
 * Exfil guard: a key may only be sent over https to the spec's default host.
 * Returns the offending host when `url` is anything else, else undefined.
 * `allowLocalHttp` (generic OPENAI_COMPAT local endpoint) additionally allows
 * http for localhost / 127.0.0.1 / ::1.
 */
export function offHostForKey(url: string, defaultUrl: string | undefined, allowLocalHttp = false): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "(invalid URL)";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (allowLocalHttp && u.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(host)) return undefined;
  if (u.protocol !== "https:") return u.host || "(invalid URL)";
  if (defaultUrl) {
    try {
      if (new URL(defaultUrl).hostname === host) return undefined;
    } catch {
      /* fall through */
    }
    return u.host;
  }
  return allowLocalHttp ? undefined : u.host;
}

function redact(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) t = t.split(s).join("[redacted]");
  t = t.replace(/\b(?:sk|xai|key)-[A-Za-z0-9_-]{12,}/g, "[redacted]");
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  return t.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
}

function makeResult(vendor: string, state: VendorKeyTestState, detail: string | undefined, secrets: string[]): VendorKeyTestResult {
  const base = STATE_TEXT[state];
  const extra = detail && state !== "ok" ? redact(detail, secrets) : "";
  return { vendor, state, message: extra ? `${base} ${extra}` : base };
}

export interface RunVendorKeyTestOptions {
  /** Spec id from vendorKeys.ts (never a free-form name from the webview). */
  vendorId: string;
  /** The slot's model id; only used when it carries the spec's modelPrefix. */
  model?: string;
  projectRoot: string;
  /** Directory holding dispatcherBridgeClient.cjs and the bridge scripts (extension/standalone hooks/). */
  hooksDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const BRIDGE_FILE: Record<string, string> = {
  "openai-compatible": "openai-compatible-mcp.cjs",
  gemini: "gemini-mcp-wrapper.cjs",
};

function hasKey(name: string, env: NodeJS.ProcessEnv): boolean {
  return (typeof env[name] === "string" && env[name] !== "") || localEnvHasValue(name);
}

interface BridgeClient {
  callBridgeTool: (o: Record<string, unknown>) => Promise<unknown>;
  normalizeAttempt: (call: unknown, slot?: { provider?: string; model?: string }) => BridgeAttemptLike;
  readServerEntry: (projectDir: string, name: string) => { entry?: unknown; error?: string };
}

interface InFlight {
  children: Set<childProcess.ChildProcess>;
  cancelled: boolean;
}
const inFlight = new Map<string, InFlight>();

function killChild(c: childProcess.ChildProcess): void {
  try {
    if (process.platform === "win32" && c.pid) {
      childProcess.spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    }
    c.kill();
  } catch {
    /* already gone */
  }
}

/** Kills every running test child (panel dispose / standalone shutdown) and marks the runs cancelled. */
export function cancelAllVendorKeyTests(): void {
  for (const f of inFlight.values()) {
    f.cancelled = true;
    for (const c of f.children) killChild(c);
  }
}

/** Loads a private copy of the bridge client whose spawned children are recorded in `track`. */
function loadClientTracked(file: string, track: Set<childProcess.ChildProcess>): BridgeClient {
  const key = require.resolve(file);
  const saved = require.cache[key];
  delete require.cache[key];
  // The real module object (an `import * as` namespace is a read-only copy).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("child_process") as { spawn: (...a: unknown[]) => childProcess.ChildProcess };
  const orig = cp.spawn;
  cp.spawn = function (this: unknown, ...a: unknown[]) {
    const child = orig.apply(this, a);
    if (a[0] !== "taskkill") track.add(child);
    return child;
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(key) as BridgeClient;
  } finally {
    cp.spawn = orig;
    if (saved) require.cache[key] = saved;
    else delete require.cache[key];
  }
}

export async function runVendorKeyTest(opts: RunVendorKeyTestOptions): Promise<VendorKeyTestResult> {
  if (inFlight.has(opts.vendorId)) return { vendor: opts.vendorId, state: "busy", message: STATE_TEXT.busy };
  const slot: InFlight = { children: new Set(), cancelled: false };
  inFlight.set(opts.vendorId, slot);
  try {
    const r = await runVendorKeyTestInner(opts, slot);
    return slot.cancelled ? { vendor: opts.vendorId, state: "error", message: "Test cancelled." } : r;
  } finally {
    inFlight.delete(opts.vendorId);
  }
}

async function runVendorKeyTestInner(opts: RunVendorKeyTestOptions, slot: InFlight): Promise<VendorKeyTestResult> {
  const env = opts.env ?? process.env;
  const spec = vendorKeySpecById(opts.vendorId);
  if (!spec || !spec.test) {
    return { vendor: opts.vendorId, state: "error", message: "No connection test is available for this vendor." };
  }
  const secrets = collectSecrets(env);

  for (const row of spec.rows) {
    if (row.required && !hasKey(row.env, env)) return makeResult(spec.id, "missing_key", undefined, secrets);
  }

  let client: BridgeClient;
  try {
    client = loadClientTracked(path.join(opts.hooksDir, "dispatcherBridgeClient.cjs"), slot.children);
  } catch {
    return makeResult(spec.id, "not_installed", "dispatcherBridgeClient.cjs could not be loaded.", secrets);
  }

  const server = spec.test.server;

  // Exfil guard: the key is only ever sent to the spec's default https host.
  const entryEnv = ((client.readServerEntry(opts.projectRoot, server).entry as { env?: Record<string, unknown> } | undefined)?.env ?? {}) as Record<string, unknown>;
  for (const row of spec.rows) {
    if (row.kind !== "endpoint") continue;
    const candidates: unknown[] = [env[row.env], entryEnv[row.env]];
    try {
      candidates.push(localEnvGetValue(row.env));
    } catch {
      /* fail-open */
    }
    for (const c of candidates) {
      if (typeof c !== "string" || c.trim() === "" || /^\$\{/.test(c.trim())) continue;
      const off = offHostForKey(c.trim(), row.defaultValue);
      if (off) return { vendor: spec.id, state: "custom_url", message: `Custom base URL in use: ${redact(off, secrets)} \u2014 not tested automatically` };
    }
  }

  let projectDir = opts.projectRoot;
  let tempDir: string | undefined;
  try {
    if (client.readServerEntry(projectDir, server).error) {
      // No .mcp.json entry: launch the bridge script directly, from the project's
      // .claude/hooks first, then the host's own hooks/ copy.
      const file = BRIDGE_FILE[server];
      const script = [path.join(opts.projectRoot, ".claude", "hooks", file), path.join(opts.hooksDir, file)].find((p) => fs.existsSync(p));
      if (!script) return makeResult(spec.id, "not_installed", undefined, secrets);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-keytest-"));
      fs.writeFileSync(
        path.join(tempDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { [server]: { command: process.execPath, args: [script] } } }),
        "utf8"
      );
      projectDir = tempDir;
    }

    const model =
      opts.model && spec.modelPrefix && opts.model.startsWith(spec.modelPrefix) && opts.model.length <= 200 ? opts.model : spec.testModel;
    const toolArgs: Record<string, unknown> = spec.test.tool === "chat" ? { model, prompt: "ping", max_tokens: 1 } : {};
    const total = opts.timeoutMs ?? VENDOR_KEY_TEST_TIMEOUT_MS;
    const stepMs = Math.min(BRIDGE_STEP_TIMEOUT_MS, Math.max(1000, total - 5000));
    const call = await client.callBridgeTool({
      projectDir,
      serverName: server,
      toolName: spec.test.tool,
      toolArgs,
      timeoutMs: stepMs,
      graceMs: Math.max(0, total - stepMs),
      env: { TYCOON_BRIDGE_TIMEOUT_MS: String(stepMs) },
    });
    const attempt = client.normalizeAttempt(call, { provider: spec.id, model: model ?? "" });
    return makeResult(spec.id, mapBridgeAttempt(attempt), attempt.error?.message, secrets);
  } catch (err) {
    return makeResult(spec.id, "error", err instanceof Error ? err.message : String(err), secrets);
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
