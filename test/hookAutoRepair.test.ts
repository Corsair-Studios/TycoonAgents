import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { silentRepairLocalHooks, backupSettingsCopy } from "../src/host/vscode/hookAutoRepair";
import { TYCOON_HOOK_SLOTS } from "../src/host/vscode/hookInstall";

const CMD = `node "C:/ext/tycoon-claude-hook.cjs"`;
const OLD = `node "C:/old/tycoon-claude-hook.cjs"`;

function mk(local?: string, shared?: string): { root: string; lp: string; sp: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-ar-"));
  fs.mkdirSync(path.join(root, ".claude"));
  const lp = path.join(root, ".claude", "settings.local.json");
  const sp = path.join(root, ".claude", "settings.json");
  if (local !== undefined) fs.writeFileSync(lp, local);
  if (shared !== undefined) fs.writeFileSync(sp, shared);
  return { root, lp, sp };
}
function staleSettings(): any {
  const hooks: any = {};
  for (const s of TYCOON_HOOK_SLOTS) {
    hooks[s.event] = hooks[s.event] ?? [];
    hooks[s.event].push({ matcher: s.matcher, hooks: [{ type: "command", command: OLD }] });
  }
  hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "node user-hook.js" }] });
  return { permissions: { allow: ["x"] }, hooks };
}

test("stale Tycoon hooks are repaired; user hooks and keys preserved; shared untouched", () => {
  const shared = JSON.stringify({ a: 1 });
  const { root, lp, sp } = mk(JSON.stringify(staleSettings()), shared);
  const r = silentRepairLocalHooks(root, CMD);
  assert.equal(r.status, "repaired");
  const out = JSON.parse(fs.readFileSync(lp, "utf8"));
  assert.deepEqual(out.permissions, { allow: ["x"] });
  const text = JSON.stringify(out);
  assert.ok(!text.includes("C:/old"));
  assert.ok(text.includes("node user-hook.js"));
  assert.equal(fs.readFileSync(sp, "utf8"), shared);
});

test("second run is a no-op (no write)", () => {
  const { root, lp } = mk(JSON.stringify(staleSettings()));
  silentRepairLocalHooks(root, CMD);
  const before = fs.readFileSync(lp, "utf8");
  fs.utimesSync(lp, new Date(1000), new Date(1000));
  const r = silentRepairLocalHooks(root, CMD);
  assert.equal(r.status, "skipped");
  assert.equal(fs.statSync(lp).mtimeMs, 1000);
  assert.equal(fs.readFileSync(lp, "utf8"), before);
});

test("project with no Tycoon hooks is untouched", () => {
  const content = JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "node mine.js" }] }] } });
  const { root, lp } = mk(content);
  assert.equal(silentRepairLocalHooks(root, CMD).status, "skipped");
  assert.equal(fs.readFileSync(lp, "utf8"), content);
});

test("missing settings.local.json is not created", () => {
  const { root, lp } = mk();
  assert.equal(silentRepairLocalHooks(root, CMD).status, "skipped");
  assert.equal(fs.existsSync(lp), false);
});

test("invalid JSON is never rewritten", () => {
  const content = `{ "hooks": { tycoon-claude-hook.cjs `;
  const { root, lp } = mk(content);
  assert.equal(silentRepairLocalHooks(root, CMD).status, "skipped");
  assert.equal(fs.readFileSync(lp, "utf8"), content);
});

test("hooks split across settings files are left alone", () => {
  const content = JSON.stringify(staleSettings());
  const { root, lp } = mk(content, content);
  assert.equal(silentRepairLocalHooks(root, CMD).status, "skipped");
  assert.equal(fs.readFileSync(lp, "utf8"), content);
});

function allSlotsSettings(cmd: string): any {
  const hooks: any = {};
  for (const s of TYCOON_HOOK_SLOTS) {
    hooks[s.event] = hooks[s.event] ?? [];
    hooks[s.event].push({ matcher: s.matcher, hooks: [{ type: "command", command: cmd }] });
  }
  return { hooks };
}
function hasSlot(settings: any, slot: { event: string; matcher: string }): boolean {
  return (settings.hooks?.[slot.event] ?? []).some((e: any) => e.matcher === slot.matcher);
}
const markerOf = (root: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(root, ".claude", "tycoon", "hook-slots.json"), "utf8")).slots;

test("no .bak is written beside settings.local.json", () => {
  const { root, lp } = mk(JSON.stringify(staleSettings()));
  assert.equal(silentRepairLocalHooks(root, CMD).status, "repaired");
  assert.equal(fs.existsSync(`${lp}.bak`), false);
  assert.equal(fs.readdirSync(path.join(root, ".claude")).filter((f) => f.endsWith(".bak") || f.endsWith(".tmp")).length, 0);
});

test("atomic write: failed rename leaves original intact and cleans the temp file", () => {
  const original = JSON.stringify(staleSettings());
  const { root, lp } = mk(original);
  const failing: any = { ...fs, renameSync: () => { throw new Error("EPERM"); } };
  const r = silentRepairLocalHooks(root, CMD, failing);
  assert.equal(r.status, "skipped");
  assert.equal(fs.readFileSync(lp, "utf8"), original);
  assert.deepEqual(fs.readdirSync(path.join(root, ".claude")).filter((f) => f.endsWith(".tmp")), []);
});

test("first run without a marker adds every missing slot and writes the marker", () => {
  const s = allSlotsSettings(CMD);
  const removed = TYCOON_HOOK_SLOTS[0];
  s.hooks[removed.event] = s.hooks[removed.event].filter((e: any) => e.matcher !== removed.matcher);
  const { root, lp } = mk(JSON.stringify(s));
  assert.equal(silentRepairLocalHooks(root, CMD).status, "repaired");
  assert.ok(hasSlot(JSON.parse(fs.readFileSync(lp, "utf8")), removed));
  assert.equal(markerOf(root).length, TYCOON_HOOK_SLOTS.length);
});

test("a slot the user removed after the marker is not re-added", () => {
  const { root, lp } = mk(JSON.stringify(allSlotsSettings(OLD)));
  silentRepairLocalHooks(root, CMD); // fixes stale, writes marker
  const s = JSON.parse(fs.readFileSync(lp, "utf8"));
  const removed = TYCOON_HOOK_SLOTS[0];
  s.hooks[removed.event] = s.hooks[removed.event].filter((e: any) => e.matcher !== removed.matcher);
  if (s.hooks[removed.event].length === 0) delete s.hooks[removed.event];
  const text = JSON.stringify(s);
  fs.writeFileSync(lp, text);
  assert.equal(silentRepairLocalHooks(root, CMD).status, "skipped");
  assert.equal(fs.readFileSync(lp, "utf8"), text);
  // stale fixes still apply while the removed slot stays removed
  const other = TYCOON_HOOK_SLOTS[TYCOON_HOOK_SLOTS.length - 1];
  const s2 = JSON.parse(text);
  for (const e of s2.hooks[other.event]) if (e.matcher === other.matcher) e.hooks[0].command = OLD;
  fs.writeFileSync(lp, JSON.stringify(s2));
  assert.equal(silentRepairLocalHooks(root, CMD).status, "repaired");
  const out = JSON.parse(fs.readFileSync(lp, "utf8"));
  assert.equal(hasSlot(out, removed), false);
  assert.ok(!JSON.stringify(out).includes("C:/old"));
});

test("a newly introduced slot (not in the marker) is added", () => {
  const { root, lp } = mk(JSON.stringify(allSlotsSettings(CMD)));
  const newSlot = TYCOON_HOOK_SLOTS[0];
  const s = JSON.parse(fs.readFileSync(lp, "utf8"));
  s.hooks[newSlot.event] = s.hooks[newSlot.event].filter((e: any) => e.matcher !== newSlot.matcher);
  fs.writeFileSync(lp, JSON.stringify(s));
  // marker from an older version that did not know newSlot
  const mp = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(mp, { recursive: true });
  const older = TYCOON_HOOK_SLOTS.slice(1).map((x) => `${x.event}|${x.matcher}`);
  fs.writeFileSync(path.join(mp, "hook-slots.json"), JSON.stringify({ slots: older }));
  assert.equal(silentRepairLocalHooks(root, CMD).status, "repaired");
  assert.ok(hasSlot(JSON.parse(fs.readFileSync(lp, "utf8")), newSlot));
  assert.ok(markerOf(root).includes(`${newSlot.event}|${newSlot.matcher}`));
});

test("backupSettingsCopy writes under .claude/tycoon, never beside settings, and never overwrites", () => {
  const { root } = mk("{}");
  backupSettingsCopy(root, "first");
  backupSettingsCopy(root, "second");
  const bak = path.join(root, ".claude", "tycoon", "settings.local.json.bak");
  assert.equal(fs.readFileSync(bak, "utf8"), "first");
  assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json.bak")), false);
});
