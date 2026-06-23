/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

"use strict";

const fs = require("fs");
const path = require("path");

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync("/dev/stdin", "utf8");
  } catch {
    // stdin not available or empty; nothing to record
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Resolve project root: the hook lives at <root>/hooks/, so go one level up.
  const projectRoot =
    process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, "..");

  // Resolve activity dir: prefer explicit override, else <root>/.claude/tycoon/.
  const activityDir =
    process.env.TYCOON_ACTIVITY_DIR ||
    path.join(projectRoot, ".claude", "tycoon");

  try {
    fs.mkdirSync(activityDir, { recursive: true });
  } catch {
    process.exit(0);
  }

  const activityFile = path.join(activityDir, "activity.jsonl");

  /** @type {{ event: string; tool?: string; workerId?: string; tokens?: number; at: number }} */
  const record = {
    event: payload.hook_event_name || "",
    at: Date.now(),
  };

  if (payload.tool_name) {
    record.tool = payload.tool_name;
  }

  if (payload.session_id) {
    record.workerId = payload.session_id;
  }

  // Capture token usage on SubagentStop events.
  if (payload.hook_event_name === "SubagentStop" && payload.usage) {
    const u = payload.usage;
    const tokens =
      typeof u.total_tokens === "number"
        ? u.total_tokens
        : (u.input_tokens || 0) +
          (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0);
    if (tokens > 0) {
      record.tokens = tokens;
    }
  }

  try {
    fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // ignore FS errors
  }

  process.exit(0);
}

main();
