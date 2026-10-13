"use strict";
/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan p22-t5: pure Codex spawn-routing logic, consumed by
 * hooks/tycoon-codex-hook.cjs's pre_tool_use / subagent_start handling.
 *
 * Mirrors the five-priority routing order implemented inline in
 * .claude/tycoon/tycoon-claude-hook.cjs (~lines 1389-1460): description
 * prefix "agent-id:", "AGENT:agent-id" marker in the full prompt, an
 * explicit name/agent-role field matching a known agent file, and finally
 * keyword scoring against .claude/tycoon/agent-keywords.json (description
 * weighted DESCRIPTION_WEIGHT above prompt body, same as the Claude hook).
 * Falls back to keywordsConfig.fallback_agent when nothing matches.
 *
 * Two things the Claude router does not need to do, that this one does:
 *   - Nested-delegation denial: if the calling thread is itself a bound
 *     worker (present in activeAgentStack), every spawn attempt is denied,
 *     mirroring decideSpawn()'s LEAF_WORKER_DENY_MESSAGE in
 *     hooks/delegationEnforcement.js (same message text, reused verbatim
 *     rather than duplicated, so the two hosts report an identical reason).
 *   - Vendor gating: Codex can only actually run an OpenAI-vendor
 *     specialist. When the resolved specialist's vendor is anything else
 *     and no dispatcher bridge is configured, the caller must NOT silently
 *     substitute another model — this module returns a deny decision plus
 *     a ready-to-append ProviderError HookRecord instead.
 *
 * Zero I/O in resolveCodexSpecialist itself (pure function, easy to unit
 * test) — the small amount of fs work needed to build its inputs
 * (agent-keywords.json, the known-agent-id set, vendor/model per agent id)
 * lives in the loader helpers below, kept separate so tests can supply
 * synthetic inputs directly.
 */

const fs = require("fs");
const path = require("path");

const { LEAF_WORKER_DENY_MESSAGE } = require("./delegationEnforcement.js");

const DESCRIPTION_WEIGHT = 1000;

function wordSetOf(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/**
 * Same scoring algorithm as tycoon-claude-hook.cjs's inline
 * matchAgentFromKeywords: description words score DESCRIPTION_WEIGHT each,
 * prompt-body words score 1 each, so a keyword only in the (truncated)
 * prompt body can never outrank one actually named in the description.
 */
function isBadKeywordSegment(seg) {
  return seg.includes("**") || seg.length > 80 || seg.split(/\s+/).filter(Boolean).length > 6;
}

function matchAgentFromKeywords(description, keywordsConfig, promptText) {
  if (!keywordsConfig || !keywordsConfig.agents) return null;
  const hasSplit = typeof promptText === "string";
  const descWords = wordSetOf(description);
  const promptWords = hasSplit ? wordSetOf(promptText) : null;

  let bestAgent = null;
  let bestScore = 0;
  let bestKeyword = "";
  for (const [agentId, cfg] of Object.entries(keywordsConfig.agents)) {
    if (!cfg || typeof cfg.pattern !== "string" || !cfg.pattern) continue;
    if (cfg.pattern.trim() === "") continue;
    let descScore = 0;
    let promptScore = 0;
    let firstMatch = "";
    for (const kw of cfg.pattern.split("|")) {
      const norm = kw.toLowerCase().trim();
      if (!norm || isBadKeywordSegment(norm)) continue;
      if (descWords.has(norm)) {
        descScore++;
        if (!firstMatch) firstMatch = kw;
      } else if (hasSplit && promptWords.has(norm)) {
        promptScore++;
        if (!firstMatch) firstMatch = kw;
      }
    }
    const score = hasSplit ? descScore * DESCRIPTION_WEIGHT + promptScore : descScore;
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agentId;
      bestKeyword = firstMatch;
    }
  }
  return bestScore > 0 ? { agentId: bestAgent, matchedKeyword: bestKeyword } : null;
}

/**
 * Loads .claude/tycoon/agent-keywords.json. Path resolution:
 * TYCOON_AGENT_KEYWORDS_PATH override first, else
 * <projectRoot>/.claude/tycoon/agent-keywords.json. Throws an explicit
 * Error (never fails silently) when the file is missing or unparsable —
 * callers decide whether that's fatal or a fail-open no-routing case.
 */
function loadAgentKeywords(projectRoot) {
  const overridePath = process.env.TYCOON_AGENT_KEYWORDS_PATH;
  const resolvedPath =
    overridePath && overridePath.trim()
      ? overridePath.trim()
      : path.join(projectRoot || process.cwd(), ".claude", "tycoon", "agent-keywords.json");
  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`codexRouting: agent-keywords.json not found at ${resolvedPath} (set TYCOON_AGENT_KEYWORDS_PATH to override): ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`codexRouting: agent-keywords.json at ${resolvedPath} is not valid JSON: ${err.message}`);
  }
}

/** Set of installed agent ids, from <agentsDir>/*.md basenames. Fail-open: [] on any read error. */
function listKnownAgentIds(agentsDir) {
  try {
    return new Set(
      fs
        .readdirSync(agentsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Parses the YAML-ish frontmatter of a .claude/agents/<id>.md file for its
 * vendor/model. Handles both shapes seen in the roster: a top-level
 * `model:` line (e.g. "sonnet", "anthropic/haiku" — vendor inferred as
 * "anthropic" when the model has no "/" or starts with "anthropic/"), and
 * an explicit `backend:` block with its own `vendor:`/`model:` lines (used
 * by the cross-vendor reviewers), which wins when present. Fail-open:
 * returns undefined on any read/parse error rather than throwing — a
 * broken frontmatter file must never crash routing.
 */
function parseAgentVendor(agentFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(agentFilePath, "utf8");
  } catch {
    return undefined;
  }
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const fm = fmMatch[1];

  let topModel;
  const topModelMatch = fm.match(/^model:\s*(.+)$/m);
  if (topModelMatch) topModel = topModelMatch[1].trim();

  let backendVendor;
  let backendModel;
  const backendBlockMatch = fm.match(/^backend:\s*\n((?:[ \t]+.+\n?)+)/m);
  if (backendBlockMatch) {
    const block = backendBlockMatch[1];
    const vendorMatch = block.match(/^\s*vendor:\s*(.+)$/m);
    const modelMatch = block.match(/^\s*model:\s*(.+)$/m);
    if (vendorMatch) backendVendor = vendorMatch[1].trim();
    if (modelMatch) backendModel = modelMatch[1].trim();
  }

  const model = backendModel || topModel;
  let vendor = backendVendor;
  if (!vendor && model) {
    vendor = model.includes("/") ? model.split("/")[0] : "anthropic";
  }
  if (!vendor && !model) return undefined;
  return { vendor, model };
}

/** Builds an agentId -> {vendor, model} map for every *.md file in agentsDir. Fail-open per-file. */
function buildVendorMap(agentsDir) {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return map;
  }
  for (const f of files) {
    const id = f.slice(0, -3);
    const info = parseAgentVendor(path.join(agentsDir, f));
    if (info) map.set(id, info);
  }
  return map;
}

/**
 * Pure routing decision for one Codex spawn attempt.
 *
 * @param {object} ctx
 * @param {{name?:string, subagent_type?:string, description?:string, prompt?:string, agent?:string, agent_role?:string, role?:string}} ctx.toolInput
 * @param {Array<{agentId:string}>} [ctx.activeAgentStack] non-empty means the calling thread is
 *   itself a bound worker -> nested delegation, always denied.
 * @param {object} [ctx.keywordsConfig] parsed agent-keywords.json (see loadAgentKeywords).
 * @param {Set<string>} [ctx.knownAgentIds] valid agent ids (see listKnownAgentIds).
 * @param {(agentId:string) => {vendor?:string, model?:string}|undefined} [ctx.vendorOf]
 * @param {boolean} [ctx.dispatcherConfigured] when true, a non-OpenAI specialist is allowed
 *   through (a dispatcher bridge is assumed to run it) instead of being denied.
 * @returns {{workerId: string|null, source: "explicit"|"keyword"|"fallback", denied: boolean, reason?: string, message?: string, matchedKeyword?: string, providerError?: object}}
 */
function resolveCodexSpecialist(ctx) {
  const {
    toolInput = {},
    activeAgentStack = [],
    keywordsConfig,
    knownAgentIds,
    vendorOf,
    dispatcherConfigured = false,
  } = ctx || {};

  // Nested delegation: the calling thread is itself a bound worker.
  if (Array.isArray(activeAgentStack) && activeAgentStack.length > 0) {
    return {
      workerId: null,
      source: "fallback",
      denied: true,
      reason: "nested-delegation",
      message: LEAF_WORKER_DENY_MESSAGE,
    };
  }

  const exists = (id) => (knownAgentIds ? knownAgentIds.has(id) : false);
  const description = String(toolInput.description || "");
  const fullPrompt = String(toolInput.prompt || "");
  const promptWindow = fullPrompt.slice(0, 500);

  let workerId = null;
  let source = null;
  let matchedKeyword = "";

  // Priority 1: description prefix "agent-id:" / "agent-id —" / "agent-id -"
  const prefixMatch = description.match(/^\s*([a-z0-9][a-z0-9-]*)\s*(?::|—|-)\s/i);
  if (prefixMatch) {
    const id = prefixMatch[1].toLowerCase();
    if (exists(id)) {
      workerId = id;
      source = "explicit";
      matchedKeyword = prefixMatch[1];
    }
  }

  // Priority 2: explicit "AGENT:<agent-id>" marker anywhere in the full prompt.
  if (!workerId) {
    const overrideMatch = fullPrompt.match(/AGENT:\s?([a-z0-9-]+)/i);
    if (overrideMatch) {
      const id = overrideMatch[1].toLowerCase().replace(/\s+/g, "-");
      if (exists(id)) {
        workerId = id;
        source = "explicit";
        matchedKeyword = overrideMatch[1];
      }
    }
  }

  // Priority 3: exact "name" field match.
  if (!workerId) {
    const nameField = String(toolInput.name || "").toLowerCase().replace(/\s+/g, "-");
    if (nameField && exists(nameField)) {
      workerId = nameField;
      source = "explicit";
      matchedKeyword = toolInput.name;
    }
  }

  // Priority 4: agent-role-shaped field (agent / agent_role / role / subagent_type),
  // tolerant of whichever Codex actually calls it (field names are inferred; no
  // live spawn_agent payload exists yet, see docs/codex-harness-findings.md).
  if (!workerId) {
    const roleField = String(toolInput.agent || toolInput.agent_role || toolInput.role || toolInput.subagent_type || "")
      .toLowerCase()
      .replace(/\s+/g, "-");
    if (roleField && exists(roleField)) {
      workerId = roleField;
      source = "explicit";
      matchedKeyword = roleField;
    }
  }

  // Priority 5: keyword scoring (description weighted far above prompt body).
  if (!workerId && keywordsConfig) {
    const m = matchAgentFromKeywords(description, keywordsConfig, promptWindow);
    if (m) {
      workerId = m.agentId;
      source = "keyword";
      matchedKeyword = m.matchedKeyword;
    }
  }

  // Fallback agent.
  if (!workerId && keywordsConfig && keywordsConfig.fallback_agent) {
    workerId = keywordsConfig.fallback_agent;
    source = "fallback";
  }

  if (!workerId) {
    return { workerId: null, source: "fallback", denied: true, reason: "no-match" };
  }

  // Vendor gate: never silently substitute another model.
  const info = vendorOf ? vendorOf(workerId) : undefined;
  const vendor = info && info.vendor;
  const model = info && info.model;
  if (vendor && vendor !== "openai" && !dispatcherConfigured) {
    return {
      workerId,
      source,
      matchedKeyword,
      denied: true,
      reason: "specialist-unavailable",
      providerError: {
        event: "ProviderError",
        provider: "codex",
        reason: "specialist-unavailable",
        workerId,
        model,
        vendor,
      },
    };
  }

  return { workerId, source, denied: false, matchedKeyword };
}

module.exports = {
  DESCRIPTION_WEIGHT,
  matchAgentFromKeywords,
  loadAgentKeywords,
  listKnownAgentIds,
  parseAgentVendor,
  buildVendorMap,
  resolveCodexSpecialist,
};
