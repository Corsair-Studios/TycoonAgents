/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

"use strict";

const fs = require("fs");
const os = require("os");
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

  const activityDir =
    process.env.TYCOON_ACTIVITY_DIR ||
    path.join(os.tmpdir(), "tycoonagents");

  try {
    fs.mkdirSync(activityDir, { recursive: true });
  } catch {
    process.exit(0);
  }

  const activityFile = path.join(activityDir, "activity.jsonl");

  /** @type {{ event: string; tool?: string; workerId?: string; at: number }} */
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

  try {
    fs.appendFileSync(activityFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // ignore FS errors
  }

  process.exit(0);
}

main();
