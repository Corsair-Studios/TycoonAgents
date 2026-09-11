/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Plan p29-t3: shared reader for <tycoonDir>/gate-events.jsonl, extracted
 * from hooks/tycoon-claude-hook.cjs's readUnseenGateEvents / sanitizeGateText
 * / formatGateEventLine (~lines 49-160 there) so the Codex dispatcher and the
 * OpenCode plugin can surface the same "Plan gate update: ..." lines without
 * duplicating the parsing/sanitizing logic. The Claude hook itself is left
 * untouched and does NOT import this module.
 *
 * Cursor file name is a parameter (default "gate-events.cursor") so each
 * harness tracks its own read position in the SAME gate-events.jsonl file
 * without consuming another harness's cursor — pass "gate-events.opencode.cursor"
 * / "gate-events.codex.cursor" from the respective caller.
 */

"use strict";

const fs = require("fs");
const path = require("path");

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
      const end = Date.now() + 50;
      while (Date.now() < end) { /* brief spin before retry */ }
    }
  }
}

/**
 * Read gate events appended to <tycoonDir>/gate-events.jsonl since the last
 * recorded cursor (tracked in <tycoonDir>/<cursorFileName>), then advance the
 * cursor to the file's current size. Malformed lines are skipped. A missing
 * cursor file is treated as offset 0. If the events file has shrunk below the
 * stored cursor (rotated/truncated), the cursor resets to 0.
 * @param {string} tycoonDir
 * @param {string} [cursorFileName]
 * @returns {Array<Record<string, unknown>>}
 */
function readUnseenGateEvents(tycoonDir, cursorFileName) {
  // Cursor advances at read time, before the caller does anything with the
  // returned events — if the caller fails after this call returns, those
  // events are dropped (never re-surfaced). Accepted tradeoff.
  const eventsPath = path.join(tycoonDir, "gate-events.jsonl");
  const cursorPath = path.join(tycoonDir, cursorFileName || "gate-events.cursor");

  let size;
  try {
    size = fs.statSync(eventsPath).size;
  } catch {
    return []; // no events file yet
  }

  let cursor = 0;
  try {
    const raw = fs.readFileSync(cursorPath, "utf8").trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) cursor = parsed;
  } catch { /* missing cursor = 0 */ }

  if (cursor > size) cursor = 0; // file shrank below cursor: reset

  if (cursor >= size) return []; // nothing new

  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  try {
    const fd = fs.openSync(eventsPath, "r");
    try {
      const len = size - cursor;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, cursor);
      const chunk = buf.toString("utf8");
      const lines = chunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsedLine = JSON.parse(trimmed);
          if (parsedLine && typeof parsedLine === "object") events.push(parsedLine);
        } catch { /* skip malformed line */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return []; // read failed: fail open, no events surfaced this call
  }

  try {
    atomicWriteSync(cursorPath, String(size));
  } catch { /* best-effort: a failed cursor write may re-surface events next call */ }

  return events;
}

/**
 * Collapse newlines/tabs to single spaces, strip other control chars, trim,
 * and cap to maxLen (appending an ellipsis when truncated).
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeGateText(value, maxLen) {
  if (typeof value !== "string" || !value) return "";
  // eslint-disable-next-line no-control-regex
  let s = value.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

/**
 * Format one gate event into a single line of context text.
 * @param {Record<string, unknown>} evt
 * @returns {string}
 */
function formatGateEventLine(evt) {
  const gate = typeof evt.gate === "string" ? evt.gate : "pending";
  const phaseNumRaw = evt.phaseNum;
  const phaseNum = typeof phaseNumRaw === "number" && Number.isFinite(phaseNumRaw) ? phaseNumRaw : null;
  const rawName = typeof evt.name === "string" && evt.name ? evt.name : (typeof evt.phaseId === "string" ? evt.phaseId : "unknown");
  const name = sanitizeGateText(rawName, 120) || "unknown";
  const phaseId = sanitizeGateText(evt.phaseId, 32);
  const ts = typeof evt.ts === "string" ? evt.ts : "";
  const source = typeof evt.source === "string" ? evt.source : "unknown";
  const phaseLabel = phaseNum !== null ? `phase ${phaseNum}` : (phaseId ? `phase ${phaseId}` : "phase ?");
  return `Plan gate update: ${phaseLabel} ${name} ${gate}${ts ? ` at ${ts}` : ""} (${source}).`;
}

/**
 * Format a list of unseen gate events into the newline-joined block of lines
 * callers prepend/inject into a model's context. Returns "" when there are
 * no events.
 * @param {Array<Record<string, unknown>>} events
 * @returns {string}
 */
function formatGateEventLines(events) {
  if (!events || events.length === 0) return "";
  return events.map(formatGateEventLine).join("\n");
}

module.exports = {
  readUnseenGateEvents,
  sanitizeGateText,
  formatGateEventLine,
  formatGateEventLines,
};
