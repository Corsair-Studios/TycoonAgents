/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import * as path from "path";

// Project-aware status detection for non-UEFN game engines. UEFN has its own
// live-heartbeat chip (computed in panel.ts); these engines have no bridge of
// their own, so their chip reflects a ladder of: a live/probed MCP connection,
// a configured-but-unprobed MCP entry, an installed pack/skill, or a bare
// detected project with nothing set up yet.

export type EngineState = "connected" | "configured" | "ready" | "offline" | "setup";

export interface EngineChip {
  id: string;
  label: string;
  state: EngineState;
  detail: string;
}

/** A resolved `.mcp.json` server entry for a given engine id. Pure lookup result. */
export interface EngineMcpEntry {
  /** The server's key in `mcpServers`, e.g. "roblox-studio". */
  name: string;
  /** True for HTTP/SSE-based servers (cheaply probeable); false for stdio ones. */
  isHttp: boolean;
  /** The server's URL, present only when `isHttp` is true. */
  url?: string;
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** List the entries of a directory, or [] on any error. */
function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// MCP entry lookup — maps an engine id to its `.mcp.json` server entry, if any.
// ---------------------------------------------------------------------------

/** Well-known `.mcp.json` server keys per engine, matching media/mcp/catalog.json ids. */
const KNOWN_MCP_SERVER_NAMES: Record<string, string[]> = {
  uefn: ["uefn-bridge"],
  roblox: ["roblox-studio"],
  blender: ["blender"],
  unreal: ["unreal-engine-mcp"],
  godot: [],
  unity: [],
};

function mcpServersOf(mcpConfig: unknown): Record<string, unknown> | undefined {
  if (mcpConfig === null || typeof mcpConfig !== "object") {
    return undefined;
  }
  // Mirrors panel.ts's tolerant read: prefer `.mcpServers`, fall back to the
  // bare object for malformed/flat configs.
  const servers = (mcpConfig as Record<string, unknown>).mcpServers ?? mcpConfig;
  if (servers === null || typeof servers !== "object") {
    return undefined;
  }
  return servers as Record<string, unknown>;
}

function httpUrlOf(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }
  const url = (entry as Record<string, unknown>).url;
  return typeof url === "string" && url !== "" ? url : undefined;
}

function isHttpEntry(entry: unknown, url: string | undefined): boolean {
  if (url !== undefined) {
    return true;
  }
  if (entry === null || typeof entry !== "object") {
    return false;
  }
  const type = (entry as Record<string, unknown>).type;
  return type === "http" || type === "sse";
}

/**
 * Resolve the `.mcp.json` server entry for `engineId`, if one is configured.
 * Checks the well-known server name for the engine first (matching the MCP
 * catalog), then falls back to any server key that contains the engine id as
 * a substring — future-proofing for engines (godot/unity/unreal) that don't
 * yet have a first-party catalog entry but might gain one, or a user-added
 * custom entry. Pure — no fs/network access.
 */
export function mcpEntryForEngine(
  mcpConfig: Record<string, unknown> | null | undefined,
  engineId: string
): EngineMcpEntry | undefined {
  const servers = mcpServersOf(mcpConfig);
  if (!servers) {
    return undefined;
  }
  const keys = Object.keys(servers);
  const known = KNOWN_MCP_SERVER_NAMES[engineId] ?? [];
  let name = keys.find((k) => known.includes(k));
  if (name === undefined) {
    const needle = engineId.toLowerCase();
    name = keys.find((k) => k.toLowerCase().includes(needle));
  }
  if (name === undefined) {
    return undefined;
  }
  const entry = servers[name];
  const url = httpUrlOf(entry);
  return { name, isHttp: isHttpEntry(entry, url), url };
}

// ---------------------------------------------------------------------------
// State ladder — pure decision, given already-resolved inputs.
// ---------------------------------------------------------------------------

/**
 * Decide an engine's chip state from already-resolved facts (top wins):
 * - an HTTP MCP entry is probed live: "connected" | "offline"
 * - a stdio MCP entry is configured (can't be cheaply probed): "configured"
 * - no MCP entry, but the pack/skill is installed: "ready"
 * - no MCP entry, no pack, but the project is detected: "setup"
 * - none of the above: undefined (no chip)
 *
 * `probedConnected` is only meaningful when `mcpEntry.isHttp` is true; the
 * actual network probe is intentionally kept out of this function so it stays
 * synchronous and unit-testable — callers own the fetch and pass in the
 * cached result.
 */
export function decideEngineState(opts: {
  mcpEntry?: EngineMcpEntry;
  probedConnected?: boolean;
  packInstalled: boolean;
  projectDetected: boolean;
}): EngineState | undefined {
  const { mcpEntry, probedConnected, packInstalled, projectDetected } = opts;
  if (mcpEntry) {
    if (mcpEntry.isHttp) {
      return probedConnected ? "connected" : "offline";
    }
    return "configured";
  }
  if (packInstalled) {
    return "ready";
  }
  if (projectDetected) {
    return "setup";
  }
  return undefined;
}

function describeState(label: string, state: EngineState, mcpName: string | undefined): string {
  switch (state) {
    case "connected":
      return `${label} MCP connected (${mcpName ?? "server"}) — live tools available.`;
    case "offline":
      return `${label} MCP configured (${mcpName ?? "server"}) but not responding — start the local server.`;
    case "configured":
      return `${label} MCP configured (${mcpName ?? "server"}) — start its local server to enable live tools.`;
    case "ready":
      return `${label} project detected — pack/skill installed.`;
    case "setup":
      return `${label} project detected — install the ${label} pack from the catalog to set up its agents.`;
  }
}

// ---------------------------------------------------------------------------
// Project + pack-install detection per engine.
// ---------------------------------------------------------------------------

interface EngineDescriptor {
  id: string;
  label: string;
  projectDetected: (entries: string[], hasExt: (ext: string) => boolean) => boolean;
  packInstalled: () => boolean;
}

function buildDescriptors(root: string): EngineDescriptor[] {
  const claude = path.join(root, ".claude");

  return [
    {
      id: "godot",
      label: "Godot",
      projectDetected: () => existsSafe(path.join(root, "project.godot")),
      packInstalled: () =>
        existsSafe(path.join(claude, "agents", "godot.md")) ||
        existsSafe(path.join(claude, "skills", "godot")),
    },
    {
      id: "unity",
      label: "Unity",
      projectDetected: () =>
        existsSafe(path.join(root, "ProjectSettings", "ProjectVersion.txt")) ||
        (existsSafe(path.join(root, "ProjectSettings")) && existsSafe(path.join(root, "Assets"))),
      packInstalled: () =>
        existsSafe(path.join(claude, "agents", "unity.md")) ||
        existsSafe(path.join(claude, "skills", "unity")),
    },
    {
      id: "unreal",
      label: "Unreal",
      // *.uproject present, but exclude UEFN projects (Content/Verse or *.verse)
      projectDetected: (_entries, hasExt) => {
        const isUefn = existsSafe(path.join(root, "Content", "Verse")) || hasExt(".verse");
        return hasExt(".uproject") && !isUefn;
      },
      packInstalled: () => existsSafe(path.join(claude, "skills", "unreal-engine")),
    },
    {
      id: "roblox",
      label: "Roblox",
      // a .rbxl/.rbxlx place, or a Rojo project file
      projectDetected: (entries, hasExt) => {
        const hasRojo =
          existsSafe(path.join(root, "default.project.json")) ||
          entries.some((e) => e.toLowerCase().endsWith(".project.json"));
        return hasExt(".rbxl") || hasExt(".rbxlx") || hasRojo;
      },
      packInstalled: () =>
        existsSafe(path.join(claude, "agents", "roblox.md")) ||
        existsSafe(path.join(claude, "skills", "roblox")),
    },
    {
      id: "blender",
      label: "Blender",
      projectDetected: (_entries, hasExt) => hasExt(".blend"),
      packInstalled: () =>
        existsSafe(path.join(claude, "agents", "blender.md")) ||
        existsSafe(path.join(claude, "skills", "blender")),
    },
  ];
}

/**
 * Compute status chips for the non-UEFN engines under `root`: the UNION of
 * project detection, pack-install detection, and any `.mcp.json` entry for
 * that engine. A chip appears whenever any of those three signals is present
 * (matching UEFN's own chip, which is always shown once its bridge is
 * installed). `probeConnected` is an optional synchronous lookup (e.g. backed
 * by a cache the caller refreshes out-of-band) used only for HTTP MCP
 * entries; omit it (or return undefined) to treat every HTTP entry as
 * "offline" until a probe result is available.
 *
 * Chips are sorted alphabetically by label; callers that also show a UEFN
 * chip are expected to prepend it.
 */
export function computeEngineChips(
  root: string,
  mcpConfig: Record<string, unknown> | null | undefined,
  probeConnected?: (engineId: string) => boolean | undefined
): EngineChip[] {
  const chips: EngineChip[] = [];
  if (!root) {
    return chips;
  }

  try {
    const entries = listDir(root);
    const hasExt = (ext: string): boolean => entries.some((e) => e.toLowerCase().endsWith(ext));

    for (const d of buildDescriptors(root)) {
      const projectDetected = d.projectDetected(entries, hasExt);
      const packInstalled = d.packInstalled();
      const mcpEntry = mcpEntryForEngine(mcpConfig, d.id);
      const state = decideEngineState({
        mcpEntry,
        probedConnected: mcpEntry?.isHttp ? probeConnected?.(d.id) : undefined,
        packInstalled,
        projectDetected,
      });
      if (state === undefined) {
        continue;
      }
      chips.push({
        id: d.id,
        label: d.label,
        state,
        detail: describeState(d.label, state, mcpEntry?.name),
      });
    }
  } catch {
    return [];
  }

  chips.sort((a, b) => a.label.localeCompare(b.label));
  return chips;
}

/**
 * Detect non-UEFN engine projects under `root` from disk alone (no MCP
 * awareness). Returns a chip ONLY for engines whose project is detected or
 * whose pack is installed; state is "ready" when installed, else "setup".
 * Thin wrapper over `computeEngineChips` kept for callers that don't have a
 * `.mcp.json` to pass (its output for those two states is identical either
 * way, since no MCP entry can outrank them).
 */
export function detectEngineSetups(root: string): EngineChip[] {
  return computeEngineChips(root, null);
}
