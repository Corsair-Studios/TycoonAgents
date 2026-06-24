/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
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
