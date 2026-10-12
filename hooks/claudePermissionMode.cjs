"use strict";
/**
 * Shared Claude CLI permission-mode policy. Every path that spawns `claude`
 * (dispatcher anthropicAdapter, claude-cli-mcp.cjs bridge) takes its
 * --permission-mode from here. Only plan, default and acceptEdits can ever be
 * returned: bypassPermissions, dontAsk and unknown values are rejected, so no
 * launcher can pass a mode that skips the user permission prompts.
 * Dependency-free apart from fs/path so copied hooks resolve it.
 */
const fs = require("fs");
const path = require("path");

/**
 * Permission mode for the `claude -p` child. Base mode, first match wins:
 *   1. the agent file's `permissionMode:` frontmatter line
 *   2. role default: `plan` (read-only) for reviewers/search/audit agents, for
 *      agents whose `tools:` list has no edit tool or whose `disallowedTools`
 *      lists Edit/Write, and for unknown agents or files with no frontmatter;
 *      `acceptEdits` for other (builder) agents, including frontmatter with no
 *      `tools:` line.
 * env CLAUDE_CLI_PERMISSION_MODE can only DOWNGRADE that base (plan < default
 * < acceptEdits); it never upgrades a read-only role. Only plan, acceptEdits
 * and default are accepted anywhere; any other value (e.g. bypassPermissions,
 * dontAsk) is ignored, so the dispatcher never bypasses the user's permissions.
 * acceptEdits children run with cwd = project (CLAUDE_CLI_CWD ignored), no
 * --add-dir, a leaf preamble, Task/Agent disallowed and hooks skipped
 * (TYCOON_BRIDGE_CHILD=1); every other mode keeps the isolated scratch dir.
 */
const ALLOWED_PERMISSION_MODES = ["plan", "acceptEdits", "default"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const READ_ONLY_NAME_RE = /review|search|retriev|audit|explore/i;

function validPermissionMode(value) {
  const v = typeof value === "string" ? value.trim().replace(/^["']|["']$/g, "") : "";
  return ALLOWED_PERMISSION_MODES.includes(v) ? v : undefined;
}

/** Top-level frontmatter scalar/list values of an agent .md: { key: raw text incl. continuation lines }. */
function readAgentFrontmatter(agentFilePath) {
  let raw;
  try {
    raw = fs.readFileSync(agentFilePath, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  } catch {
    return undefined;
  }
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const out = {};
  let key;
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      key = m[1];
      out[key] = m[2];
    } else if (key && /^\s+\S/.test(line)) {
      out[key] += " " + line.trim();
    }
  }
  return out;
}

/** True when the agent's backend block declares transport: mcp (a wrapper around a bridge tool). */
function isBridgeWrapperFrontmatter(fm) {
  return !!fm && typeof fm.backend === "string" && /\btransport:\s*mcp(?=[\s]|$)/i.test(fm.backend);
}

function toolTokens(text) {
  return String(text || "").split(/[\s,\[\]'"]+/).map((s) => s.replace(/^-+/, "").trim()).filter(Boolean);
}

const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2 };

/** envValue is the raw CLAUDE_CLI_PERMISSION_MODE; it can only downgrade the role base. */
function resolveClaudePermissionMode(agentInfo, envValue) {
  const base = baseClaudePermissionMode(agentInfo);
  const fromEnv = validPermissionMode(envValue);
  return fromEnv && MODE_RANK[fromEnv] <= MODE_RANK[base] ? fromEnv : base;
}

/** For launchers with no agent role (the claude-cli MCP bridge): a valid operator value, else the safe fallback. */
function safePermissionMode(value, fallback) {
  return validPermissionMode(value) || validPermissionMode(fallback) || "plan";
}

function baseClaudePermissionMode(agentInfo) {
  const workerId = agentInfo && typeof agentInfo.workerId === "string" ? agentInfo.workerId : "";
  const projectDir = agentInfo && typeof agentInfo.projectDir === "string" ? agentInfo.projectDir : "";
  if (!workerId || !projectDir || !/^[\w.-]+$/.test(workerId)) return "plan";
  const fm = readAgentFrontmatter(path.join(projectDir, ".claude", "agents", `${workerId}.md`));
  if (!fm) return "plan";
  const fromFile = validPermissionMode(fm.permissionMode);
  if (fromFile) return fromFile;
  if (READ_ONLY_NAME_RE.test(workerId)) return "plan";
  // Bridge wrappers (backend.transport: mcp) restrict tools only to force the wrapper through its
  // bridge tool; the dispatcher runs the backend directly, so those lists say nothing about the role.
  // Only the claude-cli wrapper is a builder; any other bridge wrapper stays read-only.
  if (isBridgeWrapperFrontmatter(fm)) return /\bmcpServer:\s*["']?claude-cli["']?(?=[\s]|$)/i.test(fm.backend) ? "acceptEdits" : "plan";
  if (typeof fm.tools === "string" && !toolTokens(fm.tools).some((t) => EDIT_TOOLS.includes(t))) return "plan";
  if (toolTokens(fm.disallowedTools).some((t) => t === "Edit" || t === "Write")) return "plan";
  return "acceptEdits";
}

/** True for review/search/audit roles and agents without edit tools: the shared read-only classifier (Claude `plan`, Codex `read-only` sandbox). */
function isReadOnlyAgent(agentInfo) {
  return baseClaudePermissionMode(agentInfo) === "plan";
}

module.exports = {
  ALLOWED_PERMISSION_MODES,
  validPermissionMode,
  safePermissionMode,
  baseClaudePermissionMode,
  resolveClaudePermissionMode,
  isReadOnlyAgent,
};
