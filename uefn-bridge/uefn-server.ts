// Vendored from Trashbyrd's Power Tools. Source for the bundled media/uefn-bridge/uefn-server.mjs.
// Rebuild via `npm run bundle:uefn`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Bridge directory — honor env var or fall back to OS temp dir (matching Python's tempfile.gettempdir())
const BRIDGE_DIR = process.env.UEFN_BRIDGE_DIR ?? path.join(os.tmpdir(), "uefn_bridge");

// Session-token compat matrix (cheap partial IPC isolation, not full auth —
// the shared temp dir is still world-readable; this only stops
// *unintentional* cross-session command delivery, e.g. a leftover MCP
// server from a previous session talking to a freshly restarted bridge):
//
//   new server x new bridge  -> isolated. Server reads the token the bridge
//                                published in heartbeat.json and echoes it
//                                on every command; bridge rejects anything
//                                that doesn't match.
//   new server x old bridge  -> tokenless. heartbeat.json has no `token`
//                                field, so the server omits `token` from
//                                commands; old bridge ignores unknown
//                                command fields either way, so this is
//                                identical to pre-token behavior.
//   old server x new bridge  -> commands rejected. An un-upgraded server
//                                never sends a token, so the bridge treats
//                                every command as a mismatch and drops it
//                                (logged once). Requires upgrading the
//                                server to interoperate.
//   old server x old bridge  -> unchanged, tokenless.
const HEARTBEAT_PATH = path.join(BRIDGE_DIR, "heartbeat.json");

async function readBridgeToken(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(HEARTBEAT_PATH, "utf8");
    const heartbeat = JSON.parse(raw) as { token?: unknown };
    return typeof heartbeat.token === "string" ? heartbeat.token : undefined;
  } catch {
    // heartbeat.json missing/unreadable/stale — bridge not started yet, or
    // an old bridge build that never wrote a token. Either way, fall back
    // to a tokenless command (see compat matrix above).
    return undefined;
  }
}

// Serialize all requests — Python only handles one command.json at a time
let requestChain: Promise<unknown> = Promise.resolve();
let counter = 0;

async function callBridge(method: string, params: Record<string, unknown>): Promise<unknown> {
  // Queue behind any in-flight request
  const result = requestChain.then(() => _callBridgeNow(method, params));
  // Keep the chain alive even if this call errors
  requestChain = result.catch(() => undefined);
  return result;
}

async function _callBridgeNow(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `${Date.now()}_${++counter}`;
  const commandPath = path.join(BRIDGE_DIR, "command.json");
  const commandTmpPath = path.join(BRIDGE_DIR, `command_${id}.tmp`);
  const responsePath = path.join(BRIDGE_DIR, `response_${id}.json`);

  const token = await readBridgeToken();
  const payload = JSON.stringify(token ? { id, method, params, token } : { id, method, params });

  // Atomic write: write to .tmp then rename (mirrors Python's os.replace)
  await fs.mkdir(BRIDGE_DIR, { recursive: true });
  await fs.writeFile(commandTmpPath, payload, "utf8");
  await fs.rename(commandTmpPath, commandPath);

  // Poll for response every 200ms, timeout at 30s
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const raw = await fs.readFile(responsePath, "utf8");
      // Delete response file before parsing to avoid re-processing
      await fs.unlink(responsePath).catch(() => undefined);
      const response = JSON.parse(raw) as {
        id: string;
        result: unknown;
        error: string | null;
        timestamp: string;
      };
      if (response.error) {
        throw new BridgeError(response.error);
      }
      return response.result;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      // File not yet written — keep polling
    }
  }

  throw new TimeoutError(`Bridge timeout after 30s waiting for response_${id}.json`);
}

class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// Helper: build MCP tool result
function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Helper: call bridge and wrap result/error uniformly
async function bridgeTool(method: string, params: Record<string, unknown>) {
  try {
    const result = await callBridge(method, params);
    return ok(result);
  } catch (e) {
    if (e instanceof BridgeError) return err(`Bridge error: ${e.message}`);
    if (e instanceof TimeoutError) return err(`Bridge error: ${e.message}`);
    return err(`Bridge error: ${String(e)}`);
  }
}

// Helper: strip undefined fields from params
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "trashbyrd-uefn",
  version: "1.0.0",
  description: "Trashbyrd's Power Tools — UEFN Bridge",
});

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "uefn_status",
  { description: "Check UEFN bridge connectivity.", inputSchema: {} },
  async () => bridgeTool("status", {})
);

server.registerTool(
  "uefn_list_devices",
  { description: "List all Creative devices in the level.", inputSchema: {} },
  async () => bridgeTool("list_devices", {})
);

server.registerTool(
  "uefn_get_property",
  {
    description: "Read a property from an actor.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to query"),
      property_name: z.string().describe("Name of the property to read"),
    },
  },
  async (args) => bridgeTool("get_property", compact({ actor_label: args.actor_label, property_name: args.property_name }))
);

server.registerTool(
  "uefn_set_property",
  {
    description: "Set a property on an actor.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to update"),
      property_name: z.string().describe("Name of the property to set"),
      value: z.string().describe("Value to assign"),
    },
  },
  async (args) => bridgeTool("set_property", compact({ actor_label: args.actor_label, property_name: args.property_name, value: args.value }))
);

server.registerTool(
  "uefn_select_actor",
  {
    description: "Select an actor in the UEFN viewport.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to select"),
    },
  },
  async (args) => bridgeTool("select_actor", compact({ actor_label: args.actor_label }))
);

server.registerTool(
  "uefn_run_audit",
  { description: "Run a full device audit.", inputSchema: {} },
  async () => bridgeTool("run_audit", {})
);

server.registerTool(
  "uefn_get_level_info",
  { description: "Get metadata about the current UEFN level.", inputSchema: {} },
  async () => bridgeTool("get_level_info", {})
);

server.registerTool(
  "uefn_batch_set",
  {
    description: "Set a property on a filtered set of actors.",
    inputSchema: {
      property_name: z.string().describe("Property to set on matched actors"),
      value: z.string().describe("Value to assign"),
      filter_type: z.string().optional().describe("Filter type (e.g. 'class', 'label')"),
      filter_value: z.string().optional().describe("Filter value to match against"),
      dry_run: z.boolean().optional().describe("If true, preview changes without applying"),
    },
  },
  async (args) =>
    bridgeTool("batch_set", compact({ filter_type: args.filter_type, filter_value: args.filter_value, property_name: args.property_name, value: args.value, dry_run: args.dry_run }))
);

server.registerTool(
  "uefn_batch_get",
  {
    description: "Read a property from a filtered set of actors.",
    inputSchema: {
      property_name: z.string().describe("Property to read from matched actors"),
      filter_type: z.string().optional().describe("Filter type (e.g. 'class', 'label')"),
      filter_value: z.string().optional().describe("Filter value to match against"),
    },
  },
  async (args) =>
    bridgeTool("batch_get", compact({ filter_type: args.filter_type, filter_value: args.filter_value, property_name: args.property_name }))
);

server.registerTool(
  "uefn_texture_find",
  {
    description: "Find texture references in the project.",
    inputSchema: {
      texture_name: z.string().describe("Texture name to search for"),
      match_mode: z.string().optional().describe("Match mode: 'exact', 'contains', etc."),
      project_only: z.boolean().optional().describe("Restrict search to project assets only"),
    },
  },
  async (args) =>
    bridgeTool("texture_find", compact({ texture_name: args.texture_name, match_mode: args.match_mode, project_only: args.project_only }))
);

server.registerTool(
  "uefn_texture_summary",
  {
    description: "Get a grouped texture usage summary.",
    inputSchema: {
      texture_name: z.string().describe("Texture name to summarize"),
      match_mode: z.string().optional().describe("Match mode: 'exact', 'contains', etc."),
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) =>
    bridgeTool("texture_summary", compact({ texture_name: args.texture_name, match_mode: args.match_mode, project_only: args.project_only }))
);

server.registerTool(
  "uefn_texture_on_actor",
  {
    description: "List textures referenced by an actor.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to inspect"),
    },
  },
  async (args) => bridgeTool("texture_on_actor", compact({ actor_label: args.actor_label }))
);

server.registerTool(
  "uefn_material_browse",
  {
    description: "Browse project materials.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("material_browse", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_material_unused",
  {
    description: "Find unused materials in the project.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("material_unused", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_niagara_browse",
  {
    description: "Browse Niagara particle systems.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("niagara_browse", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_niagara_usage",
  {
    description: "Show Niagara particle system usage across the level.",
    inputSchema: {},
  },
  async () => bridgeTool("niagara_usage", {})
);

server.registerTool(
  "uefn_dependency_scan",
  {
    description: "Scan asset dependencies.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("dependency_scan", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_health_scan",
  {
    description: "Run a health scan on the project.",
    inputSchema: {},
  },
  async () => bridgeTool("health_scan", {})
);

server.registerTool(
  "uefn_asset_sweep",
  {
    description: "Sweep and report on project assets.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("asset_sweep", compact({ project_only: args.project_only }))
);

// ── Start ─────────────────────────────────────────────────────────────────────

console.error(`[trashbyrd-uefn] Starting MCP server. Bridge dir: ${BRIDGE_DIR}`);

const transport = new StdioServerTransport();
await server.connect(transport);
