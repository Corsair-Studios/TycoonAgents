/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Returns true when `existing.mcpServers` is an object that contains the key
 * `id`. Pure helper for inspecting a project's parsed `.mcp.json` object.
 */
export function hasMcpServer(existing: Record<string, unknown>, id: string): boolean {
  const servers = existing.mcpServers;
  if (servers === null || typeof servers !== "object") {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(servers, id);
}

/**
 * Pure merge of a single MCP server entry into a parsed `.mcp.json` object.
 * Returns a NEW object: the top level and the `mcpServers` map are shallow
 * cloned (mcpServers defaults to `{}`), then `mcpServers[id]` is set to
 * `config`. All other servers and top-level keys are preserved. The input is
 * never mutated. No fs/vscode usage, so this is unit-testable.
 */
export function mergeMcpServer(
  existing: Record<string, unknown>,
  id: string,
  config: unknown
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const srcServers = existing.mcpServers;
  const servers: Record<string, unknown> =
    srcServers !== null && typeof srcServers === "object"
      ? { ...(srcServers as Record<string, unknown>) }
      : {};
  servers[id] = config;
  result.mcpServers = servers;
  return result;
}

/**
 * Pure removal of a single MCP server entry from a parsed `.mcp.json` object.
 * Returns a NEW object: the top level and the `mcpServers` map are shallow
 * cloned, then `mcpServers[id]` is deleted. The `mcpServers` key is always
 * present in the result (defaulting to `{}`), so an emptied config keeps its
 * `{ mcpServers: {} }` shape. All other servers and top-level keys are
 * preserved. The input is never mutated. No fs/vscode usage, so this is
 * unit-testable.
 */
/**
 * Pure merge of a server id into a parsed `settings.local.json`/`settings.json`
 * object's `enabledMcpjsonServers` array, so Claude Code auto-approves a
 * project `.mcp.json` server instead of leaving it "Pending approval" for
 * non-interactive sessions. Returns a NEW object: the top level is shallow
 * cloned, `enabledMcpjsonServers` is cloned (defaulting to `[]` when absent
 * or not an array), and `id` is appended only if not already present
 * (idempotent). All other keys (e.g. `env`, `hooks`, `permissions`) are
 * preserved untouched. The input is never mutated. No fs/vscode usage, so
 * this is unit-testable. A blank/whitespace-only `id` is rejected: the
 * input is returned unchanged (no throw) since there is no valid server id
 * to enable.
 */
export function mergeEnabledMcpJsonServer(
  existing: Record<string, unknown>,
  id: string
): Record<string, unknown> {
  if (!id || id.trim().length === 0) {
    return existing;
  }
  const result: Record<string, unknown> = { ...existing };
  const srcList = existing.enabledMcpjsonServers;
  // When enabledMcpjsonServers already exists but isn't an array (e.g. a
  // hand-edited or corrupted settings file), it's replaced with a fresh
  // array rather than preserved or thrown on — the field is documented as
  // an array, so a non-array value is treated as absent.
  const list: unknown[] = Array.isArray(srcList) ? [...srcList] : [];
  if (!list.includes(id)) {
    list.push(id);
  }
  result.enabledMcpjsonServers = list;
  return result;
}

export function removeMcpServer(
  existing: Record<string, unknown>,
  id: string
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const srcServers = existing.mcpServers;
  const servers: Record<string, unknown> =
    srcServers !== null && typeof srcServers === "object"
      ? { ...(srcServers as Record<string, unknown>) }
      : {};
  delete servers[id];
  result.mcpServers = servers;
  return result;
}

/**
 * p99-t2: the dispatcher catalog entry (id "tycoon") must still find its
 * project when Claude Code launches it from a subdirectory, so at install time
 * the resolved project root is written into its env as TYCOON_PROJECT_DIR
 * (docs/PATH-DISCOVERY.md: resolved at install time, never hard-coded in the
 * repo). Any other id, or a non-object config, is returned unchanged. Pure.
 */
export function withDispatcherProjectDir(id: string, config: unknown, projectRoot: string): unknown {
  if (id !== "tycoon" || config === null || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const cfg = config as Record<string, unknown>;
  const env = cfg.env !== null && typeof cfg.env === "object" ? (cfg.env as Record<string, unknown>) : {};
  return { ...cfg, env: { ...env, TYCOON_PROJECT_DIR: projectRoot.replace(/\\/g, "/") } };
}

/** Per-OS `{command, args}` override for a catalog entry (key = `process.platform`). */
export interface McpPlatformOverride {
  command: string;
  args?: string[];
}

/**
 * Optional catalog-entry field: `platforms: { win32?, darwin?, linux? }`.
 * Each present key overrides the entry's base `config` command/args on that OS
 * (other base keys such as `type`/`env` are kept). An entry whose base config
 * has no command or url and no override for the current OS is unsupported there.
 */
export interface McpPlatformsEntry {
  config: unknown;
  platforms?: Partial<Record<"win32" | "darwin" | "linux", McpPlatformOverride>>;
}

export type ResolvedMcpConfig =
  | { ok: true; config: unknown }
  | { ok: false; error: string };

/**
 * Pure: pick the install config for `platform` (a `process.platform` value).
 * No `platforms` map -> the base config unchanged. With one, the platform's
 * command/args are merged over the base; if there is no override and the base
 * has neither a command nor a url, the result is an explicit unsupported error.
 */
export function resolveConfigForPlatform(
  entry: McpPlatformsEntry & { id?: string },
  platform: string
): ResolvedMcpConfig {
  const platforms = entry.platforms;
  if (platforms === undefined || platforms === null) {
    return { ok: true, config: entry.config };
  }
  const base =
    entry.config !== null && typeof entry.config === "object"
      ? (entry.config as Record<string, unknown>)
      : {};
  const override = Object.prototype.hasOwnProperty.call(platforms, platform)
    ? (platforms as Record<string, McpPlatformOverride | undefined>)[platform]
    : undefined;
  if (override !== undefined) {
    return {
      ok: true,
      config: { ...base, command: override.command, args: [...(override.args ?? [])] },
    };
  }
  if (typeof base.command === "string" || typeof base.url === "string") {
    return { ok: true, config: entry.config };
  }
  const name = entry.id ?? "This server";
  return { ok: false, error: `${name} is not supported on this OS (${platform}); no command is defined for it.` };
}
