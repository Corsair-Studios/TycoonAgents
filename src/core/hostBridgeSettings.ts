/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// ---------------------------------------------------------------------------
// p101-t2/t5/t6: host-side facts about the project's `.mcp.json` bridge
// servers, shared by panel.ts and standalone/src/server.mjs (via
// routingHostOps.buildRoutingView). Pure Node, no vscode import.
//
//  - Gemini backend (GEMINI_MCP_BACKEND "agy" | "gemini") read from / written
//    to the `gemini` server's env block. Absent means "agy": the wrapper
//    treats an empty/missing value as agy (hooks/gemini-mcp-wrapper.cjs
//    resolveAgy(): `if (backend && backend !== "agy") return skipped`).
//  - A read-only list of env settings that live OUTSIDE the panel, with the
//    effective value and where it comes from.
//  - The server names present in .mcp.json, so the webview can warn about a
//    slot whose mcpServer is missing.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

export type GeminiBackend = "agy" | "gemini";

export const GEMINI_SERVER_NAME = "gemini";
export const GEMINI_BACKEND_ENV = "GEMINI_MCP_BACKEND";

export interface McpJsonInfo {
  /** .mcp.json exists and parsed to an object. */
  present: boolean;
  /** Server name -> its env block (string values only). */
  servers: Record<string, Record<string, string>>;
  error?: string;
}

export interface GeminiBackendInfo {
  /** A `gemini` server entry exists in .mcp.json (the control can write only when true). */
  serverPresent: boolean;
  value: GeminiBackend;
  /** "mcp-json" when GEMINI_MCP_BACKEND is set in the server env, else the wrapper default. */
  source: "mcp-json" | "default";
}

export type ExternalSettingSource = "default" | "environment" | "mcp-json";

export interface ExternalSetting {
  name: string;
  value: string;
  source: ExternalSettingSource;
  /** Server name when source is "mcp-json". */
  server?: string;
  /** What the value means when unset / the default's origin, plain text. */
  note: string;
  /** Where to change it, plain text. */
  where: string;
}

export interface HostBridgeInfo {
  mcpJsonPresent: boolean;
  mcpServers: string[];
  gemini: GeminiBackendInfo;
  externalSettings: ExternalSetting[];
}

export function readMcpJson(root: string): McpJsonInfo {
  const file = path.join(root, ".mcp.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { present: false, servers: {} };
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { present: false, servers: {}, error: ".mcp.json is not a JSON object" };
    }
    const raw = (parsed as Record<string, unknown>)["mcpServers"];
    const servers: Record<string, Record<string, string>> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
        const env: Record<string, string> = {};
        const rawEnv = entry && typeof entry === "object" ? (entry as Record<string, unknown>)["env"] : undefined;
        if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
          for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
            if (typeof v === "string") env[k] = v;
          }
        }
        servers[name] = env;
      }
    }
    return { present: true, servers };
  } catch (err) {
    return { present: false, servers: {}, error: `.mcp.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function readGeminiBackend(mcp: McpJsonInfo): GeminiBackendInfo {
  const serverPresent = Object.prototype.hasOwnProperty.call(mcp.servers, GEMINI_SERVER_NAME);
  const raw = serverPresent ? (mcp.servers[GEMINI_SERVER_NAME][GEMINI_BACKEND_ENV] ?? "").trim().toLowerCase() : "";
  // Wrapper: empty or "agy" => agy; anything else is treated as the Gemini CLI path.
  if (raw === "") return { serverPresent, value: "agy", source: "default" };
  return { serverPresent, value: raw === "agy" ? "agy" : "gemini", source: "mcp-json" };
}

export interface SetGeminiBackendResult {
  ok: boolean;
  error?: string;
}

/**
 * Sets env.GEMINI_MCP_BACKEND on mcpServers.gemini and touches nothing else.
 *
 * Minimal diff: when the key already exists in the gemini server env, only its
 * string value is replaced in place (validated by re-parsing and checking that
 * only that key changed). Otherwise the file is re-serialised with
 * JSON.stringify (keeps key order, detected indent, EOL, BOM, trailing
 * newline). The write is atomic (temp file in the same directory, then
 * rename); if the file changed between the read and the write it is re-read
 * and the edit re-applied once, else the write is refused.
 */
export function setGeminiBackend(root: string, value: unknown): SetGeminiBackendResult {
  if (value !== "agy" && value !== "gemini") return { ok: false, error: 'value must be "agy" or "gemini"' };
  const file = path.join(root, ".mcp.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return { ok: false, error: ".mcp.json not found in the project" };
    }
    const edited = applyGeminiBackend(text, value);
    if ("error" in edited) return { ok: false, error: edited.error };
    let current: string;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      return { ok: false, error: ".mcp.json disappeared while editing" };
    }
    if (current !== text) continue; // concurrent edit: re-read and re-apply once
    if (edited.out === text) return { ok: true };
    const tmp = path.join(root, `.mcp.json.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmp, edited.out, "utf8");
      replaceFile(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      return { ok: false, error: `Could not write .mcp.json: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }
  return { ok: false, error: ".mcp.json changed while it was being updated; try again" };
}

/** rename over an existing file; Windows can refuse (EPERM/EEXIST/EBUSY), so retry then unlink-and-rename. */
function replaceFile(tmp: string, dest: string): void {
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EEXIST" && code !== "EBUSY" && code !== "EACCES") throw err;
    }
  }
  fs.unlinkSync(dest);
  fs.renameSync(tmp, dest);
}

function applyGeminiBackend(text: string, value: string): { out: string } | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { error: ".mcp.json is not valid JSON; fix it by hand first" };
  }
  const servers = doc && typeof doc === "object" ? (doc as Record<string, unknown>)["mcpServers"] : undefined;
  const entry = servers && typeof servers === "object" ? (servers as Record<string, unknown>)[GEMINI_SERVER_NAME] : undefined;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { error: 'No "gemini" server in .mcp.json; install the Gemini server first' };
  }
  const e = entry as Record<string, unknown>;
  const envObj = e["env"];
  if (envObj !== undefined && envObj !== null && (typeof envObj !== "object" || Array.isArray(envObj))) {
    return { error: 'The "gemini" server env block is not an object' };
  }

  // Preferred: replace just the existing string value, textually.
  const existing = envObj && typeof envObj === "object" ? (envObj as Record<string, unknown>)[GEMINI_BACKEND_ENV] : undefined;
  if (typeof existing === "string") {
    const re = new RegExp('("' + GEMINI_BACKEND_ENV + '"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', "g");
    const matches = text.match(re) ?? [];
    if (matches.length === 1) {
      const out = text.replace(re, (_m, pre: string) => `${pre}"${value}"`);
      try {
        const reparsed = JSON.parse(out.replace(/^\uFEFF/, "")) as Record<string, any>;
        const expected = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, any>;
        expected["mcpServers"][GEMINI_SERVER_NAME]["env"][GEMINI_BACKEND_ENV] = value;
        if (JSON.stringify(reparsed) === JSON.stringify(expected)) return { out };
      } catch {
        /* fall through to full serialisation */
      }
    }
  }

  if (e["env"] === undefined || e["env"] === null) e["env"] = {};
  (e["env"] as Record<string, unknown>)[GEMINI_BACKEND_ENV] = value;
  const indentMatch = /^([ \t]+)"/m.exec(text);
  const indent = indentMatch ? indentMatch[1] : 2;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = JSON.stringify(doc, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (/\n$/.test(text)) out += eol;
  if (text.charCodeAt(0) === 0xfeff) out = "\uFEFF" + out;
  return { out };
}

// ---------------------------------------------------------------------------
// Settings the panel shows read-only (p101-t5).
// ---------------------------------------------------------------------------

/** Names containing these fragments are never surfaced, whatever the caller asks for. */
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export interface ExternalSpec {
  name: string;
  /** Default shown when neither env nor .mcp.json sets it. */
  defaultValue: string;
  /** Where that default comes from (hook source, cited). */
  note: string;
  /** .mcp.json servers checked first, in order; any other server carrying the name is checked after. */
  servers: string[];
}

const EXTERNAL_SPECS: ExternalSpec[] = [
  {
    name: "TYCOON_BRIDGE_TIMEOUT_MS",
    defaultValue: "180000",
    // hooks/bridge-result.cjs: DEFAULT_TIMEOUT_MS = 180000 (line 57)
    note: "Shared bridge timeout in ms; 180000 by default (hooks/bridge-result.cjs). The codex bridges use 600000 when this is unset.",
    servers: ["gemini", "claude-cli", "codex", "openai-compatible", "tycoon"],
  },
  {
    name: "TYCOON_DISPATCH_STEP_TIMEOUT_MS",
    defaultValue: "180000",
    // hooks/tycoon-dispatcher-mcp.cjs:474 falls back to bridgeResult.DEFAULT_TIMEOUT_MS (180000)
    note: "Per-step budget for each fallback attempt in ms; 180000 by default (hooks/tycoon-dispatcher-mcp.cjs).",
    servers: ["tycoon"],
  },
  {
    name: "CODEX_MCP_TIMEOUT_MS",
    defaultValue: "600000",
    // hooks/codex-mcp-launcher.cjs: DEFAULT_MCP_TIMEOUT_MS = 600000, falls back to TYCOON_BRIDGE_TIMEOUT_MS first
    note: "Codex per-call timeout in ms; 600000 by default, or TYCOON_BRIDGE_TIMEOUT_MS when that is set (hooks/codex-mcp-launcher.cjs).",
    servers: ["codex"],
  },
  {
    name: "TYCOON_CODEX_BACKEND",
    defaultValue: "auto",
    // hooks/codex-mcp-launcher.cjs resolveBackendOverride(): mcp-server | app-server | auto
    note: "Codex bridge backend: mcp-server, app-server or auto (detects from the codex binary version; hooks/codex-mcp-launcher.cjs).",
    servers: ["codex"],
  },
  {
    name: "CODEX_REASONING_EFFORT",
    defaultValue: "(unset)",
    // hooks/codex-mcp-launcher.cjs applyReasoningEffortOverride(): allowlist low|medium|high|xhigh|max|ultra
    note: "Unset means the -c model_reasoning_effort flag already in the codex server args applies; allowed: low, medium, high, xhigh, max, ultra (hooks/codex-mcp-launcher.cjs).",
    servers: ["codex"],
  },
  {
    name: "TYCOON_AGY_PATH",
    defaultValue: "(unset)",
    // hooks/gemini-mcp-wrapper.cjs resolveAgy(): TYCOON_AGY_PATH, then PATH, then the agy install dir
    note: "Unset means agy is found on PATH, then in its install folder (hooks/gemini-mcp-wrapper.cjs). Only used on the Antigravity backend.",
    servers: ["gemini"],
  },
];

export function describeExternalSettings(mcp: McpJsonInfo, env: NodeJS.ProcessEnv, specs: readonly ExternalSpec[] = EXTERNAL_SPECS): ExternalSetting[] {
  const out: ExternalSetting[] = [];
  for (const spec of specs) {
    if (SECRET_NAME_RE.test(spec.name)) continue;
    const order = [...spec.servers.filter((s) => s in mcp.servers), ...Object.keys(mcp.servers).filter((s) => !spec.servers.includes(s))];
    let found: { server: string; value: string } | undefined;
    for (const server of order) {
      const v = mcp.servers[server][spec.name];
      if (typeof v === "string" && v.trim() !== "") {
        found = { server, value: v.trim() };
        break;
      }
    }
    const envVal = typeof env[spec.name] === "string" ? (env[spec.name] as string).trim() : "";
    const target = spec.servers.find((s) => s in mcp.servers) ?? spec.servers[0];
    const where = `Edit mcpServers.${target}.env in .mcp.json, or set the ${spec.name} user environment variable; then reload MCP servers.`;
    if (found) {
      // The server's own env block is applied over the inherited environment when the server starts.
      out.push({ name: spec.name, value: found.value, source: "mcp-json", server: found.server, note: spec.note, where });
    } else if (envVal !== "") {
      out.push({ name: spec.name, value: envVal, source: "environment", note: spec.note, where });
    } else {
      out.push({ name: spec.name, value: spec.defaultValue, source: "default", note: spec.note, where });
    }
  }
  return out;
}

export function buildHostBridgeInfo(root: string, env: NodeJS.ProcessEnv): HostBridgeInfo {
  const mcp = readMcpJson(root);
  return {
    mcpJsonPresent: mcp.present,
    mcpServers: Object.keys(mcp.servers).sort(),
    gemini: readGeminiBackend(mcp),
    externalSettings: describeExternalSettings(mcp, env),
  };
}
