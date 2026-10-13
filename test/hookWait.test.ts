import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HOOK_WAIT_GRACE_MS,
  isWaitingForFirstHookEvent,
  readHooksChangedAt,
  readLastHookEventAt,
  recordHooksChanged,
  recordHookEventSeen,
  scanHookEvents,
} from "../src/host/vscode/hookWait";
import { MSG } from "../src/host/vscode/messages";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hook-wait-"));
}
function writeActivity(root: string, lines: object[], mode: "w" | "a" = "w"): void {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l) + "\n").join("");
  if (mode === "w") fs.writeFileSync(path.join(dir, "activity.jsonl"), body);
  else fs.appendFileSync(path.join(dir, "activity.jsonl"), body);
}
function touchActivity(root: string, at: number): void {
  writeActivity(root, [{ event: "PreToolUse", at }]);
}
function waitingNow(root: string, changedAt: number, now: number): boolean {
  return isWaitingForFirstHookEvent({ installed: true, changedAt, lastEventAt: readLastHookEventAt(root), now });
}
test("banner is shown after an install with no events once the grace period passed", () => {
  const root = tmpRoot();
  const t0 = 1_000_000;
  recordHooksChanged(root, t0);
  const args = { installed: true, changedAt: readHooksChangedAt(root), lastEventAt: readLastHookEventAt(root) };
  assert.equal(args.changedAt, t0);
  assert.equal(args.lastEventAt, null);
  assert.equal(isWaitingForFirstHookEvent({ ...args, now: t0 + HOOK_WAIT_GRACE_MS - 1 }), false, "inside the 2 min grace");
  assert.equal(isWaitingForFirstHookEvent({ ...args, now: t0 + HOOK_WAIT_GRACE_MS }), true);
});

test("banner clears on the first event after the change", () => {
  const root = tmpRoot();
  const t0 = 2_000_000;
  recordHooksChanged(root, t0);
  const now = t0 + 130_000;
  const scan = { offset: undefined as number | undefined };
  scanHookEvents(root, scan, now);
  assert.equal(waitingNow(root, t0, now), true);
  touchActivity(root, t0 + 5_000);
  scanHookEvents(root, scan, now);
  assert.equal(readLastHookEventAt(root), t0 + 5_000, "ms event timestamp is used, not mtime");
  assert.equal(waitingNow(root, t0, now), false);
});

test("not shown when the last event is newer than the change", () => {
  assert.equal(isWaitingForFirstHookEvent({ installed: true, changedAt: 1000, lastEventAt: 5000, now: 999_999 }), false);
  assert.equal(isWaitingForFirstHookEvent({ installed: true, changedAt: 1000, lastEventAt: 1000, now: 999_999 }), false);
});

test("older event than the change keeps waiting; never shown when not installed or never changed", () => {
  assert.equal(isWaitingForFirstHookEvent({ installed: true, changedAt: 5000, lastEventAt: 1000, now: 999_999 }), true);
  assert.equal(isWaitingForFirstHookEvent({ installed: false, changedAt: 5000, lastEventAt: null, now: 999_999 }), false);
  assert.equal(isWaitingForFirstHookEvent({ installed: true, changedAt: null, lastEventAt: null, now: 999_999 }), false);
});

test("the banner never shows right on load: grace also counts from the panel opening", () => {
  const t0 = 1_000;
  const args = { installed: true, changedAt: t0, lastEventAt: null };
  const opened = t0 + 5_000_000; // stale change stamp, panel just opened
  assert.equal(isWaitingForFirstHookEvent({ ...args, now: opened + 1_000, observedSince: opened }), false);
  assert.equal(isWaitingForFirstHookEvent({ ...args, now: opened + HOOK_WAIT_GRACE_MS - 1, observedSince: opened }), false);
  assert.equal(isWaitingForFirstHookEvent({ ...args, now: opened + HOOK_WAIT_GRACE_MS, observedSince: opened }), true);
  assert.equal(HOOK_WAIT_GRACE_MS, 120_000);
});

test("metrics reset during waiting does not clear the banner", () => {
  const root = tmpRoot();
  const t0 = 3_000_000;
  recordHooksChanged(root, t0);
  writeActivity(root, [{ event: "PreToolUse", at: t0 - 50_000 }]); // old event from before the change
  const scan = { offset: undefined as number | undefined };
  scanHookEvents(root, scan, t0 + 1);
  assert.equal(waitingNow(root, t0, t0 + 130_000), true);
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "activity.jsonl"), ""); // panel metrics reset: mtime = now
  scanHookEvents(root, scan, t0 + 59_000);
  assert.equal(waitingNow(root, t0, t0 + 130_000), true, "reset must not look like a hook event");
});

test("metrics reset when healthy does not show the banner", () => {
  const root = tmpRoot();
  const t0 = 4_000_000;
  recordHooksChanged(root, t0);
  writeActivity(root, [{ event: "PreToolUse", at: t0 + 2_000 }]);
  const scan = { offset: undefined as number | undefined };
  scanHookEvents(root, scan, t0 + 3_000);
  assert.equal(waitingNow(root, t0, t0 + 130_000), false);
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "activity.jsonl"), "");
  scanHookEvents(root, scan, t0 + 59_000);
  assert.equal(waitingNow(root, t0, t0 + 130_000), false, "persisted marker survives the reset");
});

test("a real event after a reset clears the banner; the marker never moves backwards", () => {
  const root = tmpRoot();
  const t0 = 5_000_000;
  recordHooksChanged(root, t0);
  const scan = { offset: undefined as number | undefined };
  writeActivity(root, [{ event: "PreToolUse", at: t0 - 1 }]);
  scanHookEvents(root, scan, t0);
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "activity.jsonl"), "");
  scanHookEvents(root, scan, t0 + 100);
  writeActivity(root, [{ event: "SubagentStop", at: t0 + 30_000 }], "a");
  scanHookEvents(root, scan, t0 + 31_000);
  assert.equal(waitingNow(root, t0, t0 + 130_000), false);
  recordHookEventSeen(root, 1);
  assert.equal(readLastHookEventAt(root), t0 + 30_000);
});

test("marker read is null when missing or corrupt", () => {
  const root = tmpRoot();
  assert.equal(readHooksChangedAt(root), null);
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "tycoon", "hooks-changed.json"), "not json");
  assert.equal(readHooksChangedAt(root), null);
});

test("panel wires the reload message and stamps every hooks write site", () => {
  assert.equal(MSG.RELOAD_WINDOW, "reloadWindow");
  assert.equal(MSG.HOOK_WAIT, "hookWait");
  const src = fs.readFileSync(path.join(process.cwd(), "src", "host", "vscode", "panel.ts"), "utf8");
  assert.match(src, /MSG\.RELOAD_WINDOW\)\s*\{\s*void vscode\.commands\.executeCommand\("workbench\.action\.reloadWindow"\)/);
  assert.ok((src.match(/recordHooksChanged\(root\)/g) ?? []).length >= 7, "install, fix, silent repair, matcher heal, absolute heal, hook-copy refresh, codex install");
  assert.match(src, /\(hookHealth as \{ waiting\?: boolean \}\)\.waiting = true/);
});
