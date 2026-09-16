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
 * this is unit-testable.
 */
export function mergeEnabledMcpJsonServer(
  existing: Record<string, unknown>,
  id: string
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const srcList = existing.enabledMcpjsonServers;
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
