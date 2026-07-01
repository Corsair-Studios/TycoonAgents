/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  for (let i = 0; i < 3; i++) {
    try {
      if (process.platform === "win32" && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tmp, filePath);
      return;
    } catch {
      if (i === 2) {
        fs.writeFileSync(filePath, data, "utf8");
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        return;
      }
      // brief spin before retry
      const end = Date.now() + 50;
      while (Date.now() < end) { /* busy wait */ }
    }
  }
}

function acquireLock(lockPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30000) { fs.unlinkSync(lockPath); continue; }
        } catch { /* stale check failed, keep waiting */ }
        const end = Date.now() + 10;
        while (Date.now() < end) { /* spin */ }
      } else {
        return false;
      }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Model defaults (sourced from CLAUDE.md model assignments)
// ---------------------------------------------------------------------------
const MODEL_DEFAULTS = {
  "orchestrator":      "claude-opus-4-6",
  "search-retrieval":  "claude-haiku-4-5-20251001",
  "primary-agent":     "claude-sonnet-4-6",
  "coding-specialist": "claude-sonnet-4-6",
  "testing-specialist":"claude-sonnet-4-6",
  "vscode-integration":"claude-sonnet-4-6",
  "ux-ui-designer":    "claude-sonnet-4-6",
  "workspace-monitor": "claude-sonnet-4-6",
};

const SHORTHAND_MODEL = {
  "opus":   "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "haiku":  "claude-haiku-4-5-20251001",
  "fable":  "claude-fable-5",
};

function resolveModel(rawModel, agentId) {
  if (rawModel) {
    return SHORTHAND_MODEL[rawModel.toLowerCase()] || rawModel;
  }
  return MODEL_DEFAULTS[agentId] || "claude-sonnet-4-6";
}

// ---------------------------------------------------------------------------
// Agent description from frontmatter
// ---------------------------------------------------------------------------
function readAgentDescription(agentsDir, agentId) {
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return undefined;
    const content = fs.readFileSync(mdPath, "utf8");
    // Extract description from YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    return descMatch ? descMatch[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Agent model from frontmatter (source of truth edited by the Settings GUI)
// ---------------------------------------------------------------------------
function readAgentModel(agentsDir, agentId) {
  try {
    const mdPath = path.join(agentsDir, agentId + ".md");
    if (!fs.existsSync(mdPath)) return undefined;
    const content = fs.readFileSync(mdPath, "utf8");
    // Extract model from YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return undefined;
    const modelMatch = fmMatch[1].match(/^model:\s*(.+)$/m);
    return modelMatch ? modelMatch[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Keyword-based agent matching
// ---------------------------------------------------------------------------
function matchAgentFromKeywords(searchText, keywordsConfig) {
  if (!keywordsConfig || !keywordsConfig.agents) return null;
  const words = new Set(
    searchText.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(Boolean)
  );
  let bestAgent = null, bestScore = 0, bestKeyword = "";
  for (const [agentId, cfg] of Object.entries(keywordsConfig.agents)) {
    if (!cfg.pattern) continue;
    let score = 0, firstMatch = "";
    for (const kw of cfg.pattern.split("|")) {
      if (words.has(kw.toLowerCase().trim())) {
        score++;
        if (!firstMatch) firstMatch = kw;
      }
    }
    if (score > bestScore) { bestScore = score; bestAgent = agentId; bestKeyword = firstMatch; }
  }
  return bestScore > 0 ? { agentId: bestAgent, matchedKeyword: bestKeyword } : null;
}

// ---------------------------------------------------------------------------
// Active-agent stack: push on spawn, pop on SubagentStop
// ---------------------------------------------------------------------------
function pushActiveAgent(activeAgentFile, entry) {
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) return;
  try {
    const existing = readJsonSafe(activeAgentFile) || { version: 1, agentId: "none", timestamp: 0, stack: [] };
    const stack = Array.isArray(existing.stack) ? existing.stack : [];
    stack.push(entry);
    atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: entry.agentId, timestamp: entry.timestamp, stack }, null, 2));
  } finally {
    releaseLock(lockPath);
  }
}

// Reset the active-agent stack to empty. Called at the start of each turn
// (UserPromptSubmit) so that sub-agents left over from an INTERRUPTED turn —
// which never fire SubagentStop and thus never get popped — don't cause the
// next turn's orchestrator tool calls to be mis-attributed. In a normal turn
// the stack is already empty here, so this is a no-op. Best-effort: any error
// (missing file/dir, lock contention, write failure) is swallowed.
function clearActiveStack(activeAgentFile) {
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) return;
  try {
    atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: "none", timestamp: Date.now(), stack: [] }, null, 2));
  } catch { /* best-effort cleanup */ } finally {
    releaseLock(lockPath);
  }
}

// Read the first user-message text from a sub-agent transcript, used to
// disambiguate parallel agents that share the same subagent_type.
function firstUserTextFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== "string") return "";
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.role === "user" || (msg.message && msg.message.role === "user")) {
          const msgObj = msg.message || msg;
          const content = msgObj.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .map((c) => (typeof c === "string" ? c : (c.text || "")))
              .join(" ");
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* transcript not accessible */ }
  return "";
}

// Pop the stopped sub-agent from the stack. Disambiguate parallel agents by
// (0) transcript keyword match, (1) subagentType match, else (2) LIFO pop.
// Disambiguate and remove the stopped sub-agent using a prioritized match strategy.
function popMatchedAgent(activeAgentFile, opts) {
  const subagentType = (opts && opts.subagentType) || "";
  const transcriptPath = opts && opts.transcriptPath;
  const keywordsConfig = opts && opts.keywordsConfig;
  const lockPath = activeAgentFile + ".lock";
  if (!acquireLock(lockPath, 5000)) return null;
  try {
    const data = readJsonSafe(activeAgentFile);
    if (!data) return null;
    const stack = Array.isArray(data.stack) ? data.stack : [];
    if (stack.length === 0) return null;

    let removedIdx = -1;

    // Priority 0: transcript-based keyword match against agents present in the stack.
    if (transcriptPath && keywordsConfig) {
      const firstUserText = firstUserTextFromTranscript(transcriptPath);
      if (firstUserText) {
        const m = matchAgentFromKeywords(firstUserText, keywordsConfig);
        if (m) {
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].agentId === m.agentId) { removedIdx = i; break; }
          }
        }
      }
    }

    // Priority 1: match by subagentType embedded in the stack entry.
    if (removedIdx < 0 && subagentType) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const e = stack[i];
        if (e.subagentType && e.subagentType.toLowerCase() === subagentType) { removedIdx = i; break; }
      }
    }

    // Priority 2: LIFO fallback.
    const popped = removedIdx >= 0 ? stack.splice(removedIdx, 1)[0] : stack.pop();
    const topAgentId = stack.length > 0 ? stack[stack.length - 1].agentId : "none";
    atomicWriteSync(activeAgentFile, JSON.stringify({ version: 1, agentId: topAgentId, timestamp: Date.now(), stack }, null, 2));
    return popped || null;
  } finally {
    releaseLock(lockPath);
  }
}

// 4-priority sub-agent token extraction: total_tokens verbatim -> component sum
// -> last transcript usage line -> regex on tool_response. SubagentStop payloads
// usually omit `usage`, so the transcript fallback (priority 3) is what actually
// yields a number.
function extractSubagentTokens(payload) {
  try {
    const usageObj = payload.usage || payload.tool_usage;
    if (usageObj && typeof usageObj === "object") {
      if (typeof usageObj.total_tokens === "number" && usageObj.total_tokens > 0) {
        return usageObj.total_tokens;
      }
      const sum =
        Number(usageObj.input_tokens || 0) +
        Number(usageObj.output_tokens || 0) +
        Number(usageObj.cache_creation_input_tokens || 0);
      if (sum > 0) return sum;
    }

    const transcriptPath = payload.agent_transcript_path || payload.transcript_path;
    if (transcriptPath && typeof transcriptPath === "string") {
      try {
        const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
        // Walk backward; only the LAST usage line reflects the agent's cumulative
        // total (summing every line overcounts massively).
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].trim()) continue;
          try {
            const msg = JSON.parse(lines[i]);
            const u = msg.usage || (msg.message && msg.message.usage);
            if (u && typeof u === "object") {
              const sum =
                Number(u.input_tokens || 0) +
                Number(u.output_tokens || 0) +
                Number(u.cache_creation_input_tokens || 0) +
                Number(u.cache_read_input_tokens || 0);
              return sum > 0 ? sum : undefined;
            }
          } catch { /* skip malformed line */ }
        }
      } catch { /* transcript not accessible */ }
    }

    const toolResponse =
      typeof payload.tool_response === "string"
        ? payload.tool_response
        : (payload.tool_response && JSON.stringify(payload.tool_response)) || "";
    const m = toolResponse.match(/total_tokens[:\s]+(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0) return n;
    }
  } catch { /* never crash the hook over token extraction */ }
  return undefined;
}

function peekActiveAgent(activeAgentFile) {
  try {
    const data = readJsonSafe(activeAgentFile);
    if (!data) return null;
    const stack = Array.isArray(data.stack) ? data.stack : [];
    return stack.length > 0 ? stack[stack.length - 1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator per-turn token delta (main session has no SubagentStop, so we
// read the transcript on Stop and diff against the previous turn's cumulative).
// ---------------------------------------------------------------------------
function captureOrchestratorTokens(payload, tycoonDir) {
  try {
    const transcriptPath = payload.transcript_path;
    if (!transcriptPath || typeof transcriptPath !== "string") return {};
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");

    let total = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const u = msg.usage || (msg.message && msg.message.usage);
        if (u && typeof u === "object") {
          total +=
            Number(u.input_tokens || 0) +
            Number(u.output_tokens || 0) +
            Number(u.cache_creation_input_tokens || 0);
        }
      } catch { /* skip malformed line */ }
    }

    // Most recent assistant entry carries the live model id.
    let model;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const msg = JSON.parse(lines[i]);
        const m = (msg.message && msg.message.model) || msg.model;
        if (m && typeof m === "string") { model = m; break; }
      } catch { /* skip */ }
    }

    const stateFile = path.join(tycoonDir, "orchestrator-token-state.json");
    const prev = readJsonSafe(stateFile);
    let delta = total;
    if (
      prev &&
      prev.transcriptPath === transcriptPath &&
      typeof prev.lastTotal === "number" &&
      total >= prev.lastTotal
    ) {
      delta = total - prev.lastTotal;
    }
    atomicWriteSync(stateFile, JSON.stringify({ transcriptPath, lastTotal: total }));

    return { tokens: delta > 0 ? delta : undefined, model };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(raw) {
  const projectRoot =
    process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..");

  const tycoonDir = path.join(projectRoot, ".claude", "tycoon");
  try { fs.mkdirSync(tycoonDir, { recursive: true }); } catch { process.exit(0); }

  const agentsDir = path.join(projectRoot, ".claude", "agents");
  const keywordsConfig = readJsonSafe(path.join(tycoonDir, "agent-keywords.json"));
  const fallbackAgent = keywordsConfig ? (keywordsConfig.fallback_agent || "primary-agent") : "primary-agent";
  const activeAgentFile = path.join(tycoonDir, "active-agent.json");
  const activityFile = path.join(tycoonDir, "activity.jsonl");

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const hookEvent = payload.hook_event_name || "";
  const toolName = payload.tool_name || "";
  const toolInput = payload.tool_input || payload || {};

  const at = Date.now();

  // -------------------------------------------------------------------------
  // SubagentStop: pop the matching agent off the stack and capture its tokens.
  // SubagentStop payloads usually omit tool_input/usage, so we fall back to
  // payload.agent_type for matching and the transcript for the token count.
  // -------------------------------------------------------------------------
  if (hookEvent === "SubagentStop") {
    const ssInput = payload.tool_input || {};
    const subagentType = (ssInput.subagent_type || payload.agent_type || "").toLowerCase();
    const transcriptPath = payload.agent_transcript_path || payload.transcript_path;

    const popped = popMatchedAgent(activeAgentFile, { subagentType, transcriptPath, keywordsConfig });
    const workerId = (popped && popped.agentId) || "orchestrator";

    /** @type {Record<string, unknown>} */
    const record = {
      event: hookEvent,
      workerId,
      at,
    };

    if (popped && popped.model) record.model = popped.model;

    const tokens = extractSubagentTokens(payload);
    if (tokens !== undefined && tokens > 0) record.tokens = tokens;

    try {
      fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
    } catch { /* ignore */ }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // PreToolUse: spawn events get full attribution; other tools get activity
  // -------------------------------------------------------------------------
  if (hookEvent === "PreToolUse") {
    const isSpawn = toolName === "Task" || toolName === "Agent";
    const isSkill = toolName === "Skill";

    if (isSpawn) {
      // --- Agent attribution (4-priority routing) ---
      const subagentType = toolInput.subagent_type || "";
      const description = toolInput.description || "";
      const prompt = (toolInput.prompt || "").substring(0, 500);
      const searchText = (description + " " + prompt).toLowerCase();

      let agentId = "unknown";
      let routingMethod = "fallback";
      let matchedKeyword = "";

      // Priority 0: Agent tool "name" param -> exact agent id
      const agentName = (toolInput.name || "").toLowerCase().replace(/\s+/g, "-");
      if (agentName && fs.existsSync(path.join(agentsDir, agentName + ".md"))) {
        agentId = agentName;
        routingMethod = "name";
        matchedKeyword = toolInput.name;
      }

      // Priority 1: Explicit subagent_type that maps to a known agent file
      if (agentId === "unknown" && subagentType) {
        const normalized = subagentType.toLowerCase().replace(/\s+/g, "-");
        if (normalized !== "general-purpose" && normalized !== "general" && normalized !== "explore") {
          if (fs.existsSync(path.join(agentsDir, normalized + ".md"))) {
            agentId = normalized;
            routingMethod = "explicit";
            matchedKeyword = subagentType;
          }
        }
        // Explore -> search-retrieval alias
        if (agentId === "unknown" && normalized === "explore") {
          agentId = "search-retrieval";
          routingMethod = "explicit";
          matchedKeyword = subagentType;
        }
        // Try keyword fallback on subagentType text when not a file match
        if (agentId === "unknown" && keywordsConfig) {
          const m = matchAgentFromKeywords(normalized.replace(/-/g, " "), keywordsConfig);
          if (m) { agentId = m.agentId; matchedKeyword = m.matchedKeyword; routingMethod = "explicit"; }
        }
      }

      // Priority 2: Keyword matching on description + prompt
      if (agentId === "unknown" && keywordsConfig) {
        const m = matchAgentFromKeywords(searchText, keywordsConfig);
        if (m) { agentId = m.agentId; matchedKeyword = m.matchedKeyword; routingMethod = "keyword"; }
      }

      // Priority 3: Fallback
      if (agentId === "unknown") {
        agentId = fallbackAgent;
        routingMethod = "fallback";
      }

      const rawModel = toolInput.model;
      // Priority: explicit Task model -> agent .md frontmatter model -> MODEL_DEFAULTS.
      // resolveModel applies SHORTHAND to any provided value and falls back to
      // MODEL_DEFAULTS[agentId] when the value is falsy.
      const model = resolveModel(rawModel || readAgentModel(agentsDir, agentId), agentId);
      const agentDescription = readAgentDescription(agentsDir, agentId);

      const stackEntry = { agentId, model, timestamp: at, subagentType };
      pushActiveAgent(activeAgentFile, stackEntry);

      /** @type {Record<string, unknown>} */
      const record = {
        event: hookEvent,
        tool: toolName,
        workerId: agentId,
        model,
        description,
        routingMethod,
        matchedKeyword,
        at,
      };
      if (agentDescription) record.agentDescription = agentDescription;
      if (payload.session_id) record.sessionId = payload.session_id;

      try {
        fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
      } catch { /* ignore */ }
      process.exit(0);
    }

    if (isSkill) {
      // Attribute Skill calls to the currently active agent (stack top)
      const top = peekActiveAgent(activeAgentFile);
      const skillAgentId = (top && top.agentId && top.agentId !== "none") ? top.agentId : "orchestrator";
      const skillName = toolInput.skill || description || "unknown-skill";

      /** @type {Record<string, unknown>} */
      const record = {
        event: hookEvent,
        tool: toolName,
        workerId: skillAgentId,
        skillName,
        at,
      };
      if (payload.session_id) record.sessionId = payload.session_id;

      try {
        fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
      } catch { /* ignore */ }
      process.exit(0);
    }

    // Non-spawn tool activity (Read, Edit, Bash, mcp__*, etc.)
    if (toolName) {
      const top = peekActiveAgent(activeAgentFile);
      // Direct tool calls with no sub-agent on the stack belong to the
      // orchestrator (the main session), not a raw session-id row.
      const workerId = (top && top.agentId && top.agentId !== "none")
        ? top.agentId
        : "orchestrator";

      /** @type {Record<string, unknown>} */
      const record = {
        event: hookEvent,
        tool: toolName,
        workerId,
        at,
      };
      if (payload.session_id) record.sessionId = payload.session_id;

      try {
        fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
      } catch { /* ignore */ }
    }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Stop: end of the main turn. Finalize the orchestrator with its per-turn
  // token delta + model so its row shows real usage (not 0).
  // -------------------------------------------------------------------------
  if (hookEvent === "Stop") {
    const { tokens, model } = captureOrchestratorTokens(payload, tycoonDir);
    /** @type {Record<string, unknown>} */
    const record = { event: hookEvent, workerId: "orchestrator", at };
    if (tokens !== undefined) record.tokens = tokens;
    if (model) record.model = model;
    try {
      fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
    } catch { /* ignore */ }
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Other events (UserPromptSubmit, etc.) — pass through as-is
  // -------------------------------------------------------------------------
  // UserPromptSubmit always fires at the start of a turn. If the previous turn
  // was interrupted, its sub-agents never fired SubagentStop and remain on the
  // stack, so reset it here before passing through. (Still maps downstream to
  // SessionStart as before — this only adds the stack reset as a side effect.)
  if (hookEvent === "UserPromptSubmit") {
    clearActiveStack(activeAgentFile);
  }

  /** @type {Record<string, unknown>} */
  const record = {
    event: hookEvent,
    at,
  };
  if (toolName) record.tool = toolName;
  if (payload.session_id) record.sessionId = payload.session_id;

  try {
    fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
  } catch { /* ignore */ }

  process.exit(0);
}

// Read the hook payload from stdin via the streaming API. This is fully
// cross-platform (works on Windows and POSIX) and avoids the EAGAIN / ENOENT
// pitfalls of synchronous fd-0 or /dev/stdin reads.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => main(input));
process.stdin.on("error", () => process.exit(0));
