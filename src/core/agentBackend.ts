/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { resolveModelAlias } from "./modelAliases";

// ---------------------------------------------------------------------------
// Declarative backend description for a .claude/agents/*.md subagent.
// See docs/AGENT-BACKENDS.md for the full field reference and examples.
//
// This module does NOT change hook behavior (p2-t1 scope) — it only defines
// the schema and parser. hooks/tycoon-claude-hook.cjs still special-cases
// mcp__codex__ directly (lines ~1336-1376); a later task wires that special
// case through parseAgentBackend() instead.
// ---------------------------------------------------------------------------

export type Transport = "claude-native" | "mcp" | "openai-compatible";
export type CostModelClass = "metered" | "subscription" | "local";

export interface Backend {
  vendor: string;
  transport: Transport;
  mcpServer?: string;
  tools?: string[];
  model: string;
  costModelClass: CostModelClass;
  endpointEnv?: string;
  apiKeyEnv?: string;
}

const VALID_TRANSPORTS: Transport[] = ["claude-native", "mcp", "openai-compatible"];
const VALID_COST_MODEL_CLASSES: CostModelClass[] = ["metered", "subscription", "local"];

function isTransport(v: unknown): v is Transport {
  return typeof v === "string" && (VALID_TRANSPORTS as string[]).includes(v);
}

function isCostModelClass(v: unknown): v is CostModelClass {
  return typeof v === "string" && (VALID_COST_MODEL_CLASSES as string[]).includes(v);
}

/**
 * Extract the raw YAML frontmatter block (between the leading `---` markers)
 * from an agent .md file's text as a plain key: value map. This is a
 * minimal, zero-dependency parser matching the subset of YAML the hook's own
 * readAgentDescription/readAgentModel/readAgentTier already rely on
 * (hooks/tycoon-claude-hook.cjs lines ~122-172): flat `key: value` lines only,
 * no nesting, no multi-line scalars. `backend.*` sub-fields are parsed
 * separately by parseAgentBackend from their own `backend:` sub-block.
 */
export function readAgentFrontmatter(mdText: string): Record<string, unknown> {
  // Strip a UTF-8 BOM and normalize CRLF/CR line endings to LF so downstream
  // per-line regexes (which use `.` and thus would otherwise capture a
  // trailing \r into every value) behave identically regardless of the
  // source file's line-ending convention (Windows-authored CRLF included).
  const normalized = mdText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const fmMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const block = fmMatch[1];
  const result: Record<string, unknown> = {};

  // Locate a `backend:` block (a top-level key followed by indented lines)
  // and parse its indented children as backend.<key>: value / backend.<key>: [a, b].
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const topMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (topMatch && !/^\s/.test(line)) {
      const key = topMatch[1];
      const inlineValue = topMatch[2].trim();
      if (key === "backend" && inlineValue === "") {
        // Collect indented child lines belonging to this block.
        const backendObj: Record<string, unknown> = {};
        let j = i + 1;
        while (j < lines.length && /^\s+\S/.test(lines[j])) {
          const child = lines[j].match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
          if (child) {
            backendObj[child[1]] = parseScalarOrList(child[2].trim());
          }
          j++;
        }
        result[key] = backendObj;
        i = j;
        continue;
      }
      result[key] = inlineValue;
    }
    i++;
  }
  return result;
}

function parseScalarOrList(raw: string): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => stripQuotes(s.trim()));
  }
  return stripQuotes(raw);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function invalidField(field: string, value: unknown, allowed: readonly string[]): Error {
  return new Error(
    `Invalid backend.${field}: ${JSON.stringify(value)} — allowed values are ${allowed.join(", ")}`
  );
}

/**
 * Parse an agent's `backend:` frontmatter block into a fully-resolved
 * Backend. `frontmatter` is the object returned by readAgentFrontmatter (or
 * an equivalently-shaped object built by a caller) — it must carry the
 * top-level `model` key (the opus/sonnet/haiku/fable alias or a raw model
 * id) so defaults can be derived when `backend` is absent.
 */
export function parseAgentBackend(frontmatter: Record<string, unknown>): Backend {
  const rawBackend = frontmatter["backend"];
  const topLevelModel = typeof frontmatter["model"] === "string" ? (frontmatter["model"] as string) : undefined;

  if (rawBackend === undefined || rawBackend === null) {
    // A model value that already contains "/" is a provider/model id, not a
    // bare alias (opus/sonnet/haiku/fable) — keep it verbatim and derive the
    // vendor from its prefix instead of re-prefixing with "anthropic/",
    // which would otherwise double up (e.g. "openai/gpt-5.4-mini" becoming
    // "anthropic/openai/gpt-5.4-mini").
    if (topLevelModel && topLevelModel.includes("/")) {
      const prefix = topLevelModel.slice(0, topLevelModel.indexOf("/"));
      return {
        vendor: prefix || "anthropic",
        transport: "claude-native",
        model: topLevelModel,
        costModelClass: "metered",
      };
    }
    const resolved = resolveModelAlias(topLevelModel) || topLevelModel || "unknown";
    return {
      vendor: "anthropic",
      transport: "claude-native",
      model: `anthropic/${resolved}`,
      costModelClass: "metered",
    };
  }

  if (typeof rawBackend !== "object") {
    throw new Error(`Invalid backend: expected an object, got ${JSON.stringify(rawBackend)}`);
  }
  const b = rawBackend as Record<string, unknown>;

  const vendor = typeof b["vendor"] === "string" && b["vendor"] ? (b["vendor"] as string) : "anthropic";

  const transport = b["transport"];
  if (!isTransport(transport)) {
    throw invalidField("transport", transport, VALID_TRANSPORTS);
  }

  const costModelClass = b["costModelClass"];
  if (!isCostModelClass(costModelClass)) {
    throw invalidField("costModelClass", costModelClass, VALID_COST_MODEL_CLASSES);
  }

  const model = typeof b["model"] === "string" && b["model"] ? (b["model"] as string) : topLevelModel;
  if (!model) {
    throw new Error("Invalid backend: `model` is required (provider/model form)");
  }

  const mcpServer = typeof b["mcpServer"] === "string" ? (b["mcpServer"] as string) : undefined;
  if (transport === "mcp" && !mcpServer) {
    throw new Error("Invalid backend: transport 'mcp' requires `mcpServer`");
  }

  const endpointEnv = typeof b["endpointEnv"] === "string" ? (b["endpointEnv"] as string) : undefined;
  if (transport === "openai-compatible" && !endpointEnv) {
    throw new Error("Invalid backend: transport 'openai-compatible' requires `endpointEnv`");
  }

  const tools = Array.isArray(b["tools"]) ? (b["tools"] as unknown[]).filter((t) => typeof t === "string") as string[] : undefined;
  const apiKeyEnv = typeof b["apiKeyEnv"] === "string" ? (b["apiKeyEnv"] as string) : undefined;

  const result: Backend = {
    vendor,
    transport,
    model,
    costModelClass,
  };
  if (mcpServer) result.mcpServer = mcpServer;
  if (tools) result.tools = tools;
  if (endpointEnv) result.endpointEnv = endpointEnv;
  if (apiKeyEnv) result.apiKeyEnv = apiKeyEnv;
  return result;
}
