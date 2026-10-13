/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { LATEST_MODEL_IDS } from "../../core/modelAliases";

/** Short model labels TycoonAgents exposes in the Settings GUI. */
export type ModelShort = "opus" | "sonnet" | "haiku" | "fable";

/**
 * Map of short model label -> the value written to an agent .md's `model:`
 * frontmatter. For opus/sonnet/haiku we intentionally write the BARE ALIAS,
 * which Claude Code resolves to the LATEST model of that family automatically
 * (so the mapping never goes stale). Fable has no auto-latest alias, so it uses
 * the newest concrete id from LATEST_MODEL_IDS (modelAliases.ts). These values MUST match the Claude Code
 * hook's expectations exactly (see tycoon-claude-hook.cjs).
 */
const SHORT_TO_ID: Record<ModelShort, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  fable: LATEST_MODEL_IDS.fable,
};

/**
 * Derive a short model label from a full model id via case-insensitive
 * substring match. Returns undefined for ids that match none of the known
 * families. Pure (no fs/vscode), so this is unit-testable.
 */
export function shortFromModelId(
  id: string | undefined
): ModelShort | undefined {
  if (id === undefined) {
    return undefined;
  }
  const lower = id.toLowerCase();
  if (lower.includes("opus")) {
    return "opus";
  }
  if (lower.includes("sonnet")) {
    return "sonnet";
  }
  if (lower.includes("haiku")) {
    return "haiku";
  }
  if (lower.includes("fable")) {
    return "fable";
  }
  return undefined;
}

/**
 * Resolve a short model label to its full model id. Returns undefined for
 * unknown labels. Inverse of shortFromModelId for the three known families.
 */
export function modelIdFromShort(short: string): string | undefined {
  return SHORT_TO_ID[short as ModelShort];
}

/** Detect the dominant newline style of a document; defaults to "\n". */
function detectNewline(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Validate a webview-supplied agent id before it is interpolated into a
 * filesystem path (`.claude/agents/<id>.md`). Only lowercase/uppercase
 * letters, digits, `_`, and `-` are allowed, and the id must start with an
 * alphanumeric character — this rejects `..`, path separators (`/`, `\`),
 * absolute paths, and the empty string, so a malicious/buggy webview message
 * can never escape the agents directory. Pure (no fs/vscode).
 */
export function isSafeAgentId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(id);
}

/**
 * Set the `model:` value in an agent markdown file's YAML frontmatter.
 *
 * - If frontmatter exists with a `model:` line, its value is replaced.
 * - If frontmatter exists without a `model:` line, `model: <id>` is inserted
 *   as the first line inside the frontmatter block.
 * - If there is no frontmatter, a new block is prepended:
 *   `---\nmodel: <id>\n---\n` followed by the original content.
 *
 * The document's newline style (`\n` or `\r\n`) is detected and reused so the
 * rest of the content is preserved exactly. Pure (no fs/vscode).
 */
export function setFrontmatterModel(
  content: string,
  fullModelId: string
): string {
  const nl = detectNewline(content);
  const lines = content.split(/\r\n|\n/);

  // Frontmatter requires the very first line to be exactly "---".
  const hasFrontmatter = lines.length > 0 && lines[0] === "---";

  if (!hasFrontmatter) {
    return `---${nl}model: ${fullModelId}${nl}---${nl}${content}`;
  }

  // Find the closing "---" of the frontmatter block.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }

  // Malformed (no closing fence): treat as no frontmatter and prepend.
  if (closeIdx === -1) {
    return `---${nl}model: ${fullModelId}${nl}---${nl}${content}`;
  }

  // Look for an existing model: line inside the block (between 1 and closeIdx).
  const modelLineIdx = lines
    .slice(1, closeIdx)
    .findIndex((l) => /^\s*model\s*:/.test(l));

  if (modelLineIdx !== -1) {
    // findIndex was on the sliced array; offset by 1 for the real index.
    const realIdx = modelLineIdx + 1;
    lines[realIdx] = `model: ${fullModelId}`;
  } else {
    // Insert as the first line inside the frontmatter block.
    lines.splice(1, 0, `model: ${fullModelId}`);
  }

  return lines.join(nl);
}

/**
 * Set the routing `pattern` for an agent in the agent-keywords config,
 * returning a NEW object (the input is never mutated). Creates the `agents`
 * map and/or the agent entry as needed while preserving every other agent and
 * top-level key (e.g. `fallback_agent`). Pure (no fs/vscode).
 */
export function setKeywordPattern(
  config: Record<string, any>,
  agentId: string,
  pattern: string
): Record<string, any> {
  const prevAgents =
    config && typeof config.agents === "object" && config.agents !== null
      ? config.agents
      : {};
  const entry = { ...(prevAgents[agentId] ?? {}), pattern };
  // A NEW key lands before the catch-all so primary-agent stays last (config
  // order breaks score ties); an existing key keeps its position.
  const catchAll = "primary-agent";
  if (!(agentId in prevAgents) && agentId !== catchAll && catchAll in prevAgents) {
    const nextAgents: Record<string, any> = {};
    for (const [k, v] of Object.entries(prevAgents)) {
      if (k === catchAll) nextAgents[agentId] = entry;
      nextAgents[k] = v;
    }
    return { ...config, agents: nextAgents };
  }
  return { ...config, agents: { ...prevAgents, [agentId]: entry } };
}

/**
 * Remove an agent's entry from the agent-keywords config, returning a NEW
 * object (the input is never mutated). A no-op (returns `config` unchanged)
 * when `agents` is missing/malformed or the agent id isn't present, so
 * callers can call this unconditionally without existence checks. Every
 * other agent and top-level key (e.g. `fallback_agent`) is preserved.
 * Inverse of {@link setKeywordPattern}. Pure (no fs/vscode).
 */
export function removeKeywordPattern(
  config: Record<string, any>,
  agentId: string
): Record<string, any> {
  if (
    !config ||
    typeof config.agents !== "object" ||
    config.agents === null ||
    !(agentId in config.agents)
  ) {
    return config;
  }
  const nextAgents = { ...config.agents };
  delete nextAgents[agentId];
  return { ...config, agents: nextAgents };
}
