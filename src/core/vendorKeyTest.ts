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
import * as http from "http";
import * as https from "https";
import {
  vendorKeySpecById,
  VENDOR_KEY_SPECS,
  customEndpointNameProblem,
  customEndpointUrlProblem,
  customKeyNameProblem,
  type VendorKeySpec,
} from "./vendorKeys";

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
  | "invalid_config"
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
  invalid_config: "Not tested:",
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
  /** Abort callbacks for direct HTTP tests (custom endpoints). */
  aborts: Set<() => void>;
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
    for (const a of Array.from(f.aborts)) {
      try {
        a();
      } catch {
        /* already gone */
      }
    }
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
  const slot: InFlight = { children: new Set(), aborts: new Set(), cancelled: false };
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

// ---------------------------------------------------------------------------
// Custom endpoint test: any OpenAI-compatible server named by the slot's
// endpointEnv / apiKeyEnv variable NAMES. The webview sends a slot identifier
// plus those NAMES only; the base URL and key are resolved here (process env,
// then the per-user store), the names and URL are validated with the shared
// rules in vendorKeys.ts, and the key is sent to exactly that URL. Cheapest
// call: a 1-token chat with the slot's model, or GET /models without a model.
// Redirects are never followed (node http does not), so the key cannot be
// forwarded to another host.
// ---------------------------------------------------------------------------

export interface RunCustomEndpointTestOptions {
  /** Stable slot identifier from the webview (field key prefix); only used for the in-flight guard and result routing. */
  slotId: string;
  /** Env var NAMES from the slot (validated here, never trusted). */
  endpointEnv: string;
  apiKeyEnv?: string;
  /** The slot's custom vendor name and model; a leading "<vendor>/" is dropped before the request. */
  vendor?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Project root whose .mcp.json env blocks are untrusted for base URLs. */
  projectRoot?: string;
}

/** Variable NAMES declared in any env block of the project's .mcp.json (repo-controlled, so untrusted for base URLs). */
export function declaredMcpEnvNames(projectRoot: string | undefined): Set<string> {
  const names = new Set<string>();
  const dirs = [projectRoot, process.env["TYCOON_PROJECT_DIR"], process.env["CLAUDE_PROJECT_DIR"], process.cwd()].filter((d): d is string => !!d);
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
      const servers = ((j && j["mcpServers"]) || j || {}) as Record<string, unknown>;
      for (const e of Object.values(servers)) {
        const env = e && typeof e === "object" ? (e as { env?: unknown }).env : undefined;
        if (env && typeof env === "object") for (const k of Object.keys(env as object)) names.add(k);
      }
    } catch {
      /* no/invalid .mcp.json: nothing declared */
    }
  }
  return names;
}

/** Base URL that may receive a key: the per-user store, or the real env when the name is not declared in .mcp.json. */
export function resolveTrustedUrl(name: string, env: NodeJS.ProcessEnv, projectRoot: string | undefined): { trusted?: string; untrusted?: string } {
  const fromEnv = typeof env[name] === "string" && env[name] !== "" ? env[name] : undefined;
  let stored: string | undefined;
  try {
    stored = localEnvGetValue(name) || undefined;
  } catch {
    /* fail-open */
  }
  if (!declaredMcpEnvNames(projectRoot).has(name)) return { trusted: fromEnv || stored };
  return { trusted: stored, untrusted: fromEnv };
}

const SLOT_ID_RE = /^[A-Za-z0-9_.:[\]-]{1,120}$/;

/** Result vendor id for a custom slot test (what the webview keys its result line on). */
export function customTestResultId(slotId: string): string {
  return `custom:${slotId}`;
}

function resolveNamed(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env[name];
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  try {
    const stored = localEnvGetValue(name);
    if (typeof stored === "string" && stored !== "") return stored;
  } catch {
    /* fail-open */
  }
  return undefined;
}

function upstreamModel(vendor: string | undefined, model: string): string {
  const prefix = String(vendor ?? "").toLowerCase() + "/";
  return prefix.length > 1 && model.toLowerCase().startsWith(prefix) && model.length > prefix.length ? model.slice(prefix.length) : model;
}

function endpointUrl(baseUrl: string, tail: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return (/\/v1$/.test(trimmed) ? trimmed : trimmed + "/v1") + tail;
}

interface HttpOutcome {
  status?: number;
  body?: string;
  error?: "timeout" | "network" | "cancelled";
  detail?: string;
}

function httpRequest(
  url: string,
  method: "GET" | "POST",
  body: unknown,
  apiKey: string | undefined,
  timeoutMs: number,
  slot: InFlight
): Promise<HttpOutcome> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ error: "network", detail: "invalid URL" });
      return;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = { Accept: "application/json" };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    let settled = false;
    const lib = u.protocol === "https:" ? https : http;
    const abort = (): void => {
      req.destroy();
      finish({ error: "cancelled" });
    };
    const finish = (o: HttpOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      slot.aborts.delete(abort);
      resolve(o);
    };
    const req = lib.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (data.length < 4000) data += c;
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body: data }));
        res.on("error", (e) => finish({ error: "network", detail: e.message }));
      }
    );
    slot.aborts.add(abort);
    const timer = setTimeout(() => {
      req.destroy();
      finish({ error: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("error", (e) => finish({ error: "network", detail: (e as NodeJS.ErrnoException).code || e.message }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Maps an HTTP status (+ body) from the endpoint to a test state. */
export function mapCustomHttpStatus(status: number, body: string, hasModel: boolean): VendorKeyTestState {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return hasModel ? "not_found" : "error";
  if (status === 400 && hasModel && /model/i.test(body) && /(not\s*found|does not exist|unknown|invalid|unsupported)/i.test(body)) return "not_found";
  return "error";
}

export async function runCustomEndpointTest(opts: RunCustomEndpointTestOptions): Promise<VendorKeyTestResult> {
  const slotId = typeof opts.slotId === "string" ? opts.slotId : "";
  if (!SLOT_ID_RE.test(slotId)) return { vendor: "custom", state: "invalid_config", message: "Not tested: unknown slot." };
  const id = customTestResultId(slotId);
  if (inFlight.has(id)) return { vendor: id, state: "busy", message: STATE_TEXT.busy };
  const slot: InFlight = { children: new Set(), aborts: new Set(), cancelled: false };
  inFlight.set(id, slot);
  try {
    const r = await runCustomEndpointTestInner(opts, id, slot);
    return slot.cancelled ? { vendor: id, state: "error", message: "Test cancelled." } : r;
  } finally {
    inFlight.delete(id);
  }
}

async function runCustomEndpointTestInner(opts: RunCustomEndpointTestOptions, id: string, slot: InFlight): Promise<VendorKeyTestResult> {
  const env = opts.env ?? process.env;
  const secrets = collectSecrets(env);
  const invalid = (detail: string): VendorKeyTestResult => makeResult(id, "invalid_config", detail, secrets);

  const endpointEnv = String(opts.endpointEnv ?? "");
  const nameProblem = customEndpointNameProblem(endpointEnv);
  if (nameProblem) return invalid(nameProblem);
  const urlRes = resolveTrustedUrl(endpointEnv, env, opts.projectRoot);
  const rawUrl = urlRes.trusted || urlRes.untrusted;
  if (!rawUrl) return invalid(`${endpointEnv} is not set. Use Set value to store the base URL.`);
  const baseUrl = rawUrl.trim();
  const urlProblem = customEndpointUrlProblem(baseUrl);
  if (urlProblem) return invalid(urlProblem);

  let apiKey: string | undefined;
  const keyEnv = opts.apiKeyEnv ? String(opts.apiKeyEnv) : "";
  if (keyEnv) {
    const keyProblem = customKeyNameProblem(keyEnv, baseUrl, endpointEnv);
    if (keyProblem) return invalid(keyProblem);
    apiKey = resolveNamed(keyEnv, env);
    if (!apiKey) {
      let local = false;
      try {
        const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
        local = h === "localhost" || h === "127.0.0.1" || h === "::1";
      } catch {
        /* not local */
      }
      if (!local) return makeResult(id, "missing_key", undefined, secrets);
    }
    if (apiKey && !urlRes.trusted) {
      return invalid(`${endpointEnv} is declared in this project's .mcp.json, so its value cannot receive an API key: the base URL must be set in your user settings (Set value…), not in project files.`);
    }
  }
  const allSecrets = apiKey ? [apiKey, apiKey.trim(), ...secrets].filter(Boolean).sort((a, b) => b.length - a.length) : secrets;

  const total = opts.timeoutMs ?? VENDOR_KEY_TEST_TIMEOUT_MS;
  const model = opts.model && opts.model.length <= 200 ? upstreamModel(opts.vendor, opts.model.trim()) : "";
  const out = model
    ? await httpRequest(endpointUrl(baseUrl, "/chat/completions"), "POST", { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }, apiKey, total, slot)
    : await httpRequest(endpointUrl(baseUrl, "/models"), "GET", undefined, apiKey, total, slot);
  if (out.error === "timeout") return makeResult(id, "timeout", undefined, allSecrets);
  if (out.error === "cancelled") return { vendor: id, state: "error", message: "Test cancelled." };
  if (out.error) return makeResult(id, "network", out.detail, allSecrets);
  const state = mapCustomHttpStatus(out.status ?? 0, out.body ?? "", !!model);
  const detail = state === "ok" ? undefined : `HTTP ${out.status}: ${out.body ?? ""}`;
  return makeResult(id, state, detail, allSecrets);
}
