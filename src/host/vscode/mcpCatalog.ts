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
 * repo). The "gemini" entry gets the same variable: its wrapper only reads
 * project files named in a prompt from inside that root. Any other id, or a non-object config, is returned unchanged. Pure.
 */
export function withDispatcherProjectDir(id: string, config: unknown, projectRoot: string): unknown {
  if ((id !== "tycoon" && id !== "gemini") || config === null || typeof config !== "object" || Array.isArray(config)) {
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

/**
 * Extracts the package spec an `npx` / `uvx` / `pipx run` launch command would
 * fetch, or null when the command is not one of those launchers (or names no
 * package). Pure; used by the catalog pin check and the "unpinned" UI hint.
 */
export function launcherPackageSpec(cfg: unknown): string | null {
  if (cfg === null || typeof cfg !== "object") {
    return null;
  }
  const c = cfg as { command?: unknown; args?: unknown };
  if (typeof c.command !== "string" || !Array.isArray(c.args)) {
    return null;
  }
  const base = c.command.split("\\").join("/").split("/").pop()!.toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
  const args = c.args.filter((a): a is string => typeof a === "string");
  if (base === "npx") {
    return args.find((a) => !a.startsWith("-")) ?? null;
  }
  if (base === "uvx" || base === "pipx") {
    const rest = base === "pipx" ? args.filter((a) => a !== "run") : args;
    const fromIdx = rest.indexOf("--from");
    if (fromIdx >= 0 && typeof rest[fromIdx + 1] === "string") {
      return rest[fromIdx + 1];
    }
    return rest.find((a) => !a.startsWith("-")) ?? null;
  }
  return null;
}

/**
 * True when `cfg` launches a package via npx/uvx/pipx without an exact
 * version (no version, `@latest`, or a dist-tag-like spec). Configs that do not
 * use those launchers are never "unpinned".
 */
export function isUnpinnedMcpConfig(cfg: unknown): boolean {
  const spec = launcherPackageSpec(cfg);
  if (spec === null) {
    return false;
  }
  if (spec.includes("==")) {
    return false; // PEP 440 exact pin
  }
  const body = spec.startsWith("@") ? spec.slice(1) : spec;
  const at = body.indexOf("@");
  if (at < 0) {
    return true;
  }
  const ver = body.slice(at + 1).split("#")[0];
  return ver === "" || /^(latest|next|beta|alpha|canary|rc)$/i.test(ver);
}
