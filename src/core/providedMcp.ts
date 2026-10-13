/**
 * Wording, sanitizer and confirm text for MCP servers owned by a separately installed product
 * (catalog `providedBy`; today only uefn-bridge from Trashbyrd's Power Tools).
 */

/** Shown on the MCP tab / pack row when no uefn-bridge entry exists anywhere. */
export const POWER_TOOLS_MCP_MISSING =
  "Provided by Trashbyrd's Power Tools — install Power Tools, then click Enable MCP here.";

const ALLOWED_KEYS = new Set(["command", "args", "env"]);
const MAX_CONFIG_CHARS = 2000;
const BLOCKED_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PYTHONPATH|PYTHONSTARTUP|PATH|COMSPEC|npm_config_.*)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp("[\u0000-\u001f\u007f\u0085\u2028\u2029]");

export type ProvidedMcpSanitized =
  | { ok: true; config: { command: string; args?: string[]; env?: Record<string, string> } }
  | { ok: false; error: string };

/**
 * Reduce a project .mcp.json entry to the only shape we will register: stdio `command`, `args`, `env`.
 * Anything else (url/type/headers/cwd/unknown keys, control characters, code-loading env keys, oversize) is refused.
 */
export function sanitizeProvidedMcpEntry(id: string, raw: unknown): ProvidedMcpSanitized {
  const no = (why: string): ProvidedMcpSanitized => ({ ok: false, error: `The ${id} entry in .mcp.json was not enabled: ${why}` });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return no("it is not an object.");
  const cfg = raw as Record<string, unknown>;
  if (cfg.url !== undefined && cfg.command !== undefined) return no("it has both url and command.");
  if (cfg.url !== undefined) return no("remote (url) servers are not supported here.");
  if (cfg.type !== undefined && cfg.type !== "stdio") return no(`type "${String(cfg.type)}" is not stdio.`);
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(k) && k !== "type") return no(`unsupported key "${k}" (only command, args and env are allowed).`);
  }
  if (typeof cfg.command !== "string" || cfg.command.trim() === "") return no("it has no command.");
  const out: { command: string; args?: string[]; env?: Record<string, string> } = { command: cfg.command };
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || !cfg.args.every((a) => typeof a === "string")) return no("args must be a list of strings.");
    out.args = cfg.args as string[];
  }
  if (cfg.env !== undefined) {
    if (cfg.env === null || typeof cfg.env !== "object" || Array.isArray(cfg.env)) return no("env must be an object of strings.");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
      if (typeof v !== "string") return no(`env ${k} must be a string.`);
      if (BLOCKED_ENV.test(k)) return no(`env key ${k} changes how processes load code, so it is refused.`);
      env[k] = v;
    }
    out.env = env;
  }
  const strings = [out.command, ...(out.args ?? []), ...Object.entries(out.env ?? {}).flat()];
  if (strings.some((x) => CONTROL_RE.test(x))) return no("it contains control characters or newlines.");
  if (JSON.stringify(out, null, 2).length > MAX_CONFIG_CHARS) return no(`it is longer than ${MAX_CONFIG_CHARS} characters.`);
  return { ok: true, config: out };
}

/** Modal `detail` for Enable: exactly the JSON that will be registered. */
export function providedMcpConfirmDetail(id: string, config: unknown, homepage?: string): string {
  return (
    `Registers "${id}" for your Claude Code sessions, exactly as below:\n\n${JSON.stringify(config, null, 2)}` +
    `${homepage ? `\n\nSource: ${homepage}` : ""}\n\nOnly enable it if you recognise this command.`
  );
}
