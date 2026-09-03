/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Shipped OpenCode plugin (plan p5-t2). Loads from .opencode/plugin/ as a
 * SINGLE file with no imports beyond node builtins — OpenCode auto-installs
 * @opencode-ai/plugin's types for editor support, but this file must not
 * depend on that package (or any other) at runtime, mirroring
 * hooks/tycoon-claude-hook.cjs's zero-dep posture.
 *
 * Source of truth for payload shapes and the mapping below:
 * docs/opencode-probe-findings.md. Anything not resolved there is called out
 * in this file's comments rather than guessed.
 *
 * Mirrors hooks/tycoon-claude-hook.cjs's file formats exactly:
 *   - <activityDir>/activity.jsonl: one JSON line per HookRecord-shaped event
 *   - <activityDir>/active-agent.json: { version, agentId, timestamp, stack }
 *     push/pop, same shape as the Claude hook's pushActiveAgent/pop.
 * activityDir = TYCOON_ACTIVITY_DIR env override, else <directory>/.claude/tycoon.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types (kept local — no cross-package import at runtime; shapes mirror
// src/providers/claude-code/hookRecord.ts's HookRecord as closely as an
// OpenCode-sourced record can).
// ---------------------------------------------------------------------------

type OpenCodeHookEventName = "UserPromptSubmit" | "PreToolUse" | "SubagentStop" | "Stop" | "PluginError";

interface OpenCodeHookRecord {
  event: OpenCodeHookEventName;
  provider: "opencode";
  at: number;
  tool?: string;
  workerId?: string;
  tokens?: number;
  cacheReadTokens?: number;
  model?: string;
  vendor?: string;
  costModelClass?: "metered" | "subscription" | "local";
  agentDescription?: string;
  parentId?: string;
  sessionId?: string;
  error?: string;
}

interface ActiveAgentEntry {
  agentId: string;
  timestamp: number;
  model?: string;
  subagentType?: string;
  parentId?: string;
  sessionId?: string;
}

interface ActiveAgentFile {
  version: 1;
  agentId: string;
  timestamp: number;
  stack: ActiveAgentEntry[];
}

// Minimal shape of the SDK client used here — kept structural (no import of
// @opencode-ai/sdk) so the plugin has zero runtime dependencies.
interface OpenCodeClientLike {
  session: {
    messages: (opts: { path: { id: string } }) => Promise<{
      data?: Array<{ info?: Record<string, unknown> }>;
    }>;
  };
}

export interface PluginDeps {
  directory: string;
  client?: OpenCodeClientLike;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STRING_BYTES = 8 * 1024; // 8 KB, per brief

// OpenCode tool name -> the Claude-style tool name TycoonAgents' mapper
// understands (see the PreToolUse "other tools" row in the findings' mapping
// table). mcp__<server>__<tool> names are left untouched so backend routing
// (buildMcpBackendRouting-equivalent below) still applies.
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
};

function mapToolName(rawTool: string): string {
  if (TOOL_NAME_MAP[rawTool]) return TOOL_NAME_MAP[rawTool];
  return rawTool;
}

// ---------------------------------------------------------------------------
// String truncation (mirrors standalone/spike/opencode-probe-plugin.ts's
// truncateDeep, scoped to top-level string fields on a flat record here since
// HookRecord-shaped lines are flat).
// ---------------------------------------------------------------------------

function truncateString(value: string): string {
  if (value.length > MAX_STRING_BYTES) {
    const truncatedCount = value.length - MAX_STRING_BYTES;
    return value.slice(0, MAX_STRING_BYTES) + `…[truncated ${truncatedCount} chars]`;
  }
  return value;
}

function truncateRecordStrings<T extends object>(record: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record) as Array<keyof T & string>) {
    const v = (record as Record<string, unknown>)[key];
    out[key] = typeof v === "string" ? truncateString(v) : v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// File I/O helpers — deliberately simple (single-process plugin, no
// multi-process lock contention like the Claude hook's short-lived CLI
// invocations), but still defensive against a missing dir or malformed JSON.
// ---------------------------------------------------------------------------

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8"))) as T;
  } catch {
    return null;
  }
}

function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    if (process.platform === "win32") {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, data, "utf8");
    } catch {
      /* best-effort: never let a state write crash the plugin */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function resolveActivityDir(directory: string): string {
  const override = process.env.TYCOON_ACTIVITY_DIR;
  if (override && override.trim() !== "") return override;
  return path.join(directory, ".claude", "tycoon");
}

let loggedFetchUsageError = false;

// ---------------------------------------------------------------------------
// Agent backend routing (mirrors hooks/tycoon-claude-hook.cjs's
// buildMcpBackendRouting/lookupMcpBackend, reusing the SAME compiled module
// via require(path.join(__dirname,'agentBackend.js')) with a legacy
// fallback). Only used to resolve vendor/model/costModelClass for a `task`
// spawn (from the agent's own .claude/agents/<subagent_type>.md when it
// exists) and for mcp__<server>__<tool> routing.
// ---------------------------------------------------------------------------

interface AgentBackendModule {
  readAgentFrontmatter: (mdText: string) => Record<string, unknown>;
  parseAgentBackend: (frontmatter: Record<string, unknown>) => {
    vendor: string;
    transport: string;
    mcpServer?: string;
    tools?: string[];
    model: string;
    costModelClass: "metered" | "subscription" | "local";
  };
}

let agentBackendModule: AgentBackendModule | null | undefined; // undefined = not attempted

function getAgentBackendModule(): AgentBackendModule | null {
  if (agentBackendModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      agentBackendModule = require(path.join(__dirname, "agentBackend.js")) as AgentBackendModule;
    } catch {
      agentBackendModule = null;
      try {
        process.stderr.write(
          "[tycoon-opencode-plugin] agentBackend.js not available next to the plugin — mcp backend routing and per-agent model/vendor resolution disabled.\n"
        );
      } catch {
        /* never let a warning break the plugin */
      }
    }
  }
  return agentBackendModule;
}

function readAgentBackendFromFile(
  agentsDir: string,
  agentId: string
): { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" } {
  const mod = getAgentBackendModule();
  if (!mod) return {};
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return {};
    const text = fs.readFileSync(mdPath, "utf8");
    const frontmatter = mod.readAgentFrontmatter(text);
    const backend = mod.parseAgentBackend(frontmatter);
    return { vendor: backend.vendor, model: backend.model, costModelClass: backend.costModelClass };
  } catch {
    return {};
  }
}

interface McpRouting {
  exact: Map<string, { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" }>;
  prefixes: Array<{ prefix: string; entry: { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" } }>;
}

function buildMcpBackendRouting(agentsDir: string): McpRouting | null {
  const mod = getAgentBackendModule();
  if (!mod) return null;
  const exact: McpRouting["exact"] = new Map();
  const prefixes: McpRouting["prefixes"] = [];
  let files: string[];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { exact, prefixes };
  }
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(agentsDir, file), "utf8");
    } catch {
      continue;
    }
    let backend: ReturnType<AgentBackendModule["parseAgentBackend"]>;
    try {
      const frontmatter = mod.readAgentFrontmatter(text);
      backend = mod.parseAgentBackend(frontmatter);
    } catch {
      continue;
    }
    if (!backend || (backend.transport !== "mcp" && backend.transport !== "openai-compatible")) continue;
    if (!backend.mcpServer) continue;
    const entry = { vendor: backend.vendor, model: backend.model, costModelClass: backend.costModelClass };
    const serverPrefix = "mcp__" + backend.mcpServer + "__";
    if (Array.isArray(backend.tools) && backend.tools.length > 0) {
      for (const tool of backend.tools) exact.set(serverPrefix + tool, entry);
    } else {
      prefixes.push({ prefix: serverPrefix, entry });
    }
  }
  return { exact, prefixes };
}

function lookupMcpBackend(
  routing: McpRouting | null,
  toolName: string
): { vendor?: string; model?: string; costModelClass?: "metered" | "subscription" | "local" } | undefined {
  if (!routing) return undefined;
  const hit = routing.exact.get(toolName);
  if (hit) return hit;
  for (const { prefix, entry } of routing.prefixes) {
    if (toolName.indexOf(prefix) === 0) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Active-agent stack — push/pop, mirroring hooks/tycoon-claude-hook.cjs's
// pushActiveAgent/popMatchedAgent file format exactly ({version, agentId,
// timestamp, stack}). No lock file here: OpenCode plugin hooks run
// in-process and sequentially per event, unlike the Claude hook's
// short-lived, potentially-concurrent CLI invocations.
// ---------------------------------------------------------------------------

function readActiveAgentFile(activeAgentFile: string): ActiveAgentFile {
  const existing = readJsonSafe<ActiveAgentFile>(activeAgentFile);
  if (existing && Array.isArray(existing.stack)) return existing;
  return { version: 1, agentId: "none", timestamp: 0, stack: [] };
}

function pushActiveAgent(activeAgentFile: string, entry: ActiveAgentEntry): void {
  const existing = readActiveAgentFile(activeAgentFile);
  const stack = existing.stack.slice();
  stack.push(entry);
  atomicWriteSync(
    activeAgentFile,
    JSON.stringify({ version: 1, agentId: entry.agentId, timestamp: entry.timestamp, stack }, null, 2)
  );
}

// Pop by workerId+sessionId match (highest priority — exact), falling back to
// LIFO, matching the Claude hook's fallback-to-LIFO posture when no better
// discriminator matches.
function popActiveAgent(
  activeAgentFile: string,
  opts: { workerId?: string; sessionId?: string }
): ActiveAgentEntry | null {
  const existing = readActiveAgentFile(activeAgentFile);
  const stack = existing.stack.slice();
  if (stack.length === 0) return null;

  let removedIdx = -1;
  if (opts.sessionId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].sessionId === opts.sessionId) {
        removedIdx = i;
        break;
      }
    }
  }
  if (removedIdx < 0 && opts.workerId) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].agentId === opts.workerId) {
        removedIdx = i;
        break;
      }
    }
  }

  const popped = removedIdx >= 0 ? stack.splice(removedIdx, 1)[0] : stack.pop() ?? null;
  const topAgentId = stack.length > 0 ? stack[stack.length - 1].agentId : "none";
  atomicWriteSync(
    activeAgentFile,
    JSON.stringify({ version: 1, agentId: topAgentId, timestamp: Date.now(), stack }, null, 2)
  );
  return popped;
}

function peekActiveAgent(activeAgentFile: string): ActiveAgentEntry | null {
  const existing = readActiveAgentFile(activeAgentFile);
  return existing.stack.length > 0 ? existing.stack[existing.stack.length - 1] : null;
}

// ---------------------------------------------------------------------------
// activity.jsonl append + PluginError guard
// ---------------------------------------------------------------------------

function appendActivity(activityFile: string, record: OpenCodeHookRecord): void {
  try {
    fs.mkdirSync(path.dirname(activityFile), { recursive: true });
    fs.appendFileSync(activityFile, JSON.stringify(truncateRecordStrings(record)) + "\n", "utf8");
  } catch {
    /* best-effort: a broken activity log must never crash the plugin */
  }
}

function writePluginError(activityFile: string, now: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  appendActivity(activityFile, {
    event: "PluginError",
    provider: "opencode",
    at: now,
    error: truncateString(message),
  });
}

// ---------------------------------------------------------------------------
// Token fetch (SubagentStop): client.session.messages, summed over assistant
// messages. Per the findings, this SDK round-trip is the reliable source
// (the inline message.updated tokens field is an UNRESOLVED fast-path, not
// used here). On failure: omit tokens (never fabricate), log to stderr once.
// ---------------------------------------------------------------------------

async function fetchSessionTokens(
  client: OpenCodeClientLike | undefined,
  sessionId: string
): Promise<{ tokens?: number; cacheReadTokens?: number }> {
  if (!client) return {};
  try {
    const res = await client.session.messages({ path: { id: sessionId } });
    const messages = res?.data ?? [];
    let total = 0;
    let cacheRead = 0;
    for (const m of messages) {
      const info = m?.info as
        | { role?: string; tokens?: { input?: number; output?: number; cache?: { read?: number } } }
        | undefined;
      if (!info || info.role !== "assistant") continue;
      const t = info.tokens;
      if (!t) continue;
      total += Number(t.input ?? 0) + Number(t.output ?? 0);
      cacheRead += Number(t.cache?.read ?? 0);
    }
    return {
      tokens: total > 0 ? total : undefined,
      cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
    };
  } catch (err) {
    if (!loggedFetchUsageError) {
      loggedFetchUsageError = true;
      try {
        process.stderr.write(
          "[tycoon-opencode-plugin] client.session.messages failed — SubagentStop tokens omitted: " +
            (err instanceof Error ? err.message : String(err)) +
            "\n"
        );
      } catch {
        /* ignore */
      }
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Prompt-submit dedupe (session.created with no parentID fires once per
// session; a root-session user message.updated could also fire for the same
// turn — dedupe within 1s per sessionId per findings section (d)).
// ---------------------------------------------------------------------------

function makeSubmitDedupe() {
  const lastSubmitAt = new Map<string, number>();
  return (sessionId: string, now: number): boolean => {
    const prev = lastSubmitAt.get(sessionId);
    lastSubmitAt.set(sessionId, now);
    if (prev !== undefined && now - prev < 1000) return true; // duplicate, skip
    return false;
  };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function createPlugin(deps: PluginDeps) {
  const { directory, client } = deps;
  const now = deps.now ?? (() => Date.now());

  const activityDir = resolveActivityDir(directory);
  const activityFile = path.join(activityDir, "activity.jsonl");
  const activeAgentFile = path.join(activityDir, "active-agent.json");
  const agentsDir = path.join(directory, ".claude", "agents");

  const isDuplicateSubmit = makeSubmitDedupe();
  // sessionID -> true once its first user message.updated has fired, so a
  // later user message.updated in the SAME root session (a later turn) still
  // maps to UserPromptSubmit rather than being suppressed forever — only the
  // 1s window above dedupes session.created vs. the first message.updated
  // for the SAME turn.
  const seenRootSessions = new Set<string>();
  // Track parentID per sessionID so session.idle can tell Stop from
  // SubagentStop without re-deriving it (OpenCode's session.idle payload
  // carries only sessionID — see findings section (d)/(a)).
  const sessionParent = new Map<string, string | undefined>();

  const mcpRouting = buildMcpBackendRouting(agentsDir);

  function recordUserPromptSubmit(sessionId: string) {
    if (isDuplicateSubmit(sessionId, now())) return;
    appendActivity(activityFile, {
      event: "UserPromptSubmit",
      provider: "opencode",
      at: now(),
      sessionId,
    });
  }

  function handleSessionCreated(properties: Record<string, unknown> | undefined) {
    const info = properties?.["info"] as { id?: string; parentID?: string } | undefined;
    const sessionId = info?.id;
    if (!sessionId) return;
    sessionParent.set(sessionId, info?.parentID);
    if (!info?.parentID) {
      recordUserPromptSubmit(sessionId);
    }
  }

  function handleMessageUpdated(properties: Record<string, unknown> | undefined) {
    const info = properties?.["info"] as { role?: string; sessionID?: string } | undefined;
    const sessionId = info?.sessionID ?? (properties?.["sessionID"] as string | undefined);
    if (!info || info.role !== "user" || !sessionId) return;
    const parentId = sessionParent.get(sessionId);
    if (parentId) return; // only root-session user messages map to UserPromptSubmit
    if (seenRootSessions.has(sessionId)) return; // dedupe: session.created already fired this turn's submit
    seenRootSessions.add(sessionId);
    recordUserPromptSubmit(sessionId);
  }

  function handleSessionIdle(properties: Record<string, unknown> | undefined) {
    const sessionId =
      (properties?.["sessionID"] as string | undefined) ??
      ((properties?.["info"] as { id?: string } | undefined)?.id);
    if (!sessionId) return;
    const parentId = sessionParent.get(sessionId);
    if (parentId) {
      // SubagentStop for a subagent session going idle without a matching
      // tool.execute.after (defensive path — the primary SubagentStop path
      // is tool.execute.after for tool 'task', below).
      return;
    }
    appendActivity(activityFile, {
      event: "Stop",
      provider: "opencode",
      at: now(),
      sessionId,
    });
  }

  async function handleToolExecuteBefore(input: {
    tool?: string;
    sessionID?: string;
    callID?: string;
    args?: Record<string, unknown>;
  }) {
    const rawTool = input?.tool ?? "";
    const sessionId = input?.sessionID;
    const args = input?.args ?? {};

    if (rawTool === "task") {
      const workerId = typeof args["subagent_type"] === "string" ? (args["subagent_type"] as string) : undefined;
      const agentDescription = typeof args["description"] === "string" ? (args["description"] as string) : undefined;
      const backend = workerId ? readAgentBackendFromFile(agentsDir, workerId) : {};

      const parentEntry = sessionId ? undefined : peekActiveAgent(activeAgentFile) ?? undefined;
      const parentId = parentEntry?.agentId && parentEntry.agentId !== "none" ? parentEntry.agentId : undefined;

      if (workerId) {
        pushActiveAgent(activeAgentFile, {
          agentId: workerId,
          timestamp: now(),
          subagentType: workerId,
          parentId,
          sessionId,
        });
      }

      const record: OpenCodeHookRecord = {
        event: "PreToolUse",
        provider: "opencode",
        at: now(),
        tool: "Task",
        workerId,
        agentDescription,
        sessionId,
        parentId: sessionId, // parent SESSION id per findings (payload[0].sessionID = parent)
      };
      if (backend.vendor) record.vendor = backend.vendor;
      if (backend.model) record.model = backend.model;
      if (backend.costModelClass) record.costModelClass = backend.costModelClass;
      appendActivity(activityFile, record);
      return;
    }

    const top = peekActiveAgent(activeAgentFile);
    const workerId = top && top.agentId !== "none" ? top.agentId : "orchestrator";
    const mappedTool = mapToolName(rawTool);
    const record: OpenCodeHookRecord = {
      event: "PreToolUse",
      provider: "opencode",
      at: now(),
      tool: mappedTool,
      workerId,
      sessionId,
    };
    const mcpBackend = lookupMcpBackend(mcpRouting, mappedTool);
    if (mcpBackend) {
      if (mcpBackend.vendor) record.vendor = mcpBackend.vendor;
      if (mcpBackend.model) record.model = mcpBackend.model;
      if (mcpBackend.costModelClass) record.costModelClass = mcpBackend.costModelClass;
    }
    appendActivity(activityFile, record);
  }

  async function handleToolExecuteAfter(
    input: { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
    output: { title?: string; metadata?: Record<string, unknown>; output?: string }
  ) {
    if (input?.tool !== "task") return;

    const metadata = (output?.metadata ?? {}) as {
      parentSessionId?: string;
      sessionId?: string;
      model?: { providerID?: string; modelID?: string };
    };
    const childSessionId = metadata.sessionId;
    const workerId =
      (typeof input.args?.["subagent_type"] === "string" ? (input.args["subagent_type"] as string) : undefined) ??
      (childSessionId ? popActiveAgent(activeAgentFile, { sessionId: childSessionId })?.agentId : undefined) ??
      "unknown";

    // Pop the stack entry now regardless of which branch resolved workerId
    // above (popActiveAgent is idempotent against an already-missing entry).
    if (childSessionId) popActiveAgent(activeAgentFile, { sessionId: childSessionId, workerId });

    const model =
      metadata.model?.providerID && metadata.model?.modelID
        ? `${metadata.model.providerID}/${metadata.model.modelID}`
        : undefined;

    const { tokens, cacheReadTokens } = childSessionId
      ? await fetchSessionTokens(client, childSessionId)
      : {};

    const record: OpenCodeHookRecord = {
      event: "SubagentStop",
      provider: "opencode",
      at: now(),
      workerId,
      sessionId: metadata.parentSessionId ?? input.sessionID,
    };
    if (model) record.model = model;
    if (tokens !== undefined) record.tokens = tokens;
    if (cacheReadTokens !== undefined) record.cacheReadTokens = cacheReadTokens;
    appendActivity(activityFile, record);
  }

  return {
    // Event dispatcher, exported so tests can call it directly without going
    // through OpenCode's actual plugin registration shape.
    dispatchEvent: async (evt: { type: string; properties?: Record<string, unknown> }) => {
      try {
        const type = evt?.type ?? "";
        const properties = evt?.properties;
        if (type === "session.created") {
          handleSessionCreated(properties);
        } else if (type === "message.updated") {
          handleMessageUpdated(properties);
        } else if (type === "session.idle") {
          handleSessionIdle(properties);
        }
      } catch (err) {
        writePluginError(activityFile, now(), err);
      }
    },
    toolExecuteBefore: async (input: {
      tool?: string;
      sessionID?: string;
      callID?: string;
      args?: Record<string, unknown>;
    }) => {
      try {
        await handleToolExecuteBefore(input);
      } catch (err) {
        writePluginError(activityFile, now(), err);
      }
    },
    toolExecuteAfter: async (
      input: { tool?: string; sessionID?: string; callID?: string; args?: Record<string, unknown> },
      output: { title?: string; metadata?: Record<string, unknown>; output?: string }
    ) => {
      try {
        await handleToolExecuteAfter(input, output);
      } catch (err) {
        writePluginError(activityFile, now(), err);
      }
    },
    // Exposed for tests / debugging.
    _paths: { activityFile, activeAgentFile, activityDir },
  };
}

// ---------------------------------------------------------------------------
// OpenCode plugin entrypoint. Structural shape matches @opencode-ai/plugin's
// Plugin type (ctx: {client, project, worktree, directory, ...}) => Hooks,
// without importing that package. The `event` hook is the ONE hook OpenCode
// actually delivers session.*/message.* bus events through (confirmed by the
// probe spike); tool.execute.before/after are separate top-level hooks.
// ---------------------------------------------------------------------------

const TycoonOpenCodePlugin = async (ctx: { client?: OpenCodeClientLike; directory?: string }) => {
  const directory = typeof ctx?.directory === "string" ? ctx.directory : process.cwd();
  const plugin = createPlugin({ directory, client: ctx?.client });

  return {
    event: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
      await plugin.dispatchEvent(input?.event ?? { type: "" });
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      await plugin.toolExecuteBefore({ ...input, args: output?.args });
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
      output: { title: string; metadata: Record<string, unknown>; output: string }
    ) => {
      await plugin.toolExecuteAfter(input, output);
    },
  };
};

export default TycoonOpenCodePlugin;
