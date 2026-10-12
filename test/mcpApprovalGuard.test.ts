/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpApprovalWatcher, runApprovalGuard, runApprovalGuardDeferred, revocationMessage, GUARD_WATCH_GLOBS } from "../src/host/vscode/mcpApprovalGuard";
import { bridgeFilesForConfig } from "../src/host/vscode/hookInstall";
import { resolveConfigForPlatform, withDispatcherProjectDir } from "../src/host/vscode/mcpCatalog";
import { beginHookWrite, endHookWrite, isHookWriteActive, onHookWritesIdle, withHookWrite } from "../src/core/hookWriteGate";
import type { ApprovalEnv } from "../src/core/mcpApproval";

const REPO = process.cwd();
const MEDIA = path.join(REPO, "media");
const CATALOG: any[] = JSON.parse(fs.readFileSync(path.join(MEDIA, "mcp", "catalog.json"), "utf8"));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "guard-home-"));
const ENV: ApprovalEnv = {
  homeDir: HOME,
  resolveSrc: (f) => {
    const p = path.join(REPO, "hooks", f);
    return fs.existsSync(p) ? p : undefined;
  },
};

function projectWithApprovedClaudeCli(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const r = resolveConfigForPlatform(CATALOG.find((e) => e.id === "claude-cli"), process.platform) as any;
  const cfg = withDispatcherProjectDir("claude-cli", r.config, root);
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  for (const f of bridgeFilesForConfig(cfg)) fs.copyFileSync(path.join(REPO, "hooks", f), path.join(root, ".claude", "hooks", f));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "claude-cli": cfg } }));
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["claude-cli"] }));
  return root;
}

test("guard revokes a modified approved server and posts the warning", () => {
  const root = projectWithApprovedClaudeCli();
  try {
    const seen: string[] = [];
    const push = (m: string): void => { seen.push(m); };
    assert.deepEqual(runApprovalGuard(root, MEDIA, ENV, push), []);
    assert.deepEqual(seen, []);
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\n//x\n");
    assert.deepEqual(runApprovalGuard(root, MEDIA, ENV, push), ["claude-cli"]);
    assert.deepEqual(seen, [revocationMessage("claude-cli")]);
    assert.equal(seen[0], "TycoonAgents removed approval for claude-cli: its files changed since approval. Reinstall hooks from TycoonAgents, then approve again in Claude Code.");
    assert.deepEqual(runApprovalGuard(root, MEDIA, ENV, push), []);
    assert.equal(seen.length, 1, "no repeat notification once revoked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watcher watches hooks and .mcp.json and debounces bursts to one check", async () => {
  const subs: Array<{ glob: string; fire: () => void; disposed: boolean }> = [];
  let checks = 0;
  const w = new McpApprovalWatcher(
    "/p",
    (_root, glob, onEvent) => {
      const s = { glob, fire: onEvent, disposed: false };
      subs.push(s);
      return { dispose: () => { s.disposed = true; } };
    },
    () => { checks++; },
    20,
  );
  assert.deepEqual(subs.map((s) => s.glob), [...GUARD_WATCH_GLOBS]);
  assert.deepEqual([...GUARD_WATCH_GLOBS], [".claude/hooks/**", ".mcp.json"]);
  for (let i = 0; i < 5; i++) subs[i % 2].fire();
  assert.equal(checks, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(checks, 1);
  subs[0].fire();
  w.dispose();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(checks, 1, "disposed watcher never checks");
  assert.ok(subs.every((s) => s.disposed));
});

test("hook write gate nests, releases on throw, and notifies when idle", () => {
  let idle = 0;
  const off = onHookWritesIdle(() => { idle++; });
  try {
    beginHookWrite();
    beginHookWrite();
    endHookWrite();
    assert.equal(isHookWriteActive(), true);
    assert.equal(idle, 0);
    endHookWrite();
    assert.equal(isHookWriteActive(), false);
    assert.equal(idle, 1);
    assert.throws(() => withHookWrite(() => { throw new Error("x"); }));
    assert.equal(isHookWriteActive(), false);
    assert.equal(idle, 2);
  } finally {
    off();
  }
});

test("watcher skips its check while hooks are being written and runs once after", async () => {
  let busy = true;
  let idleCb: () => void = () => undefined;
  let fire: () => void = () => undefined;
  let checks = 0;
  const w = new McpApprovalWatcher(
    "/p",
    (_r, _g, onEvent) => { fire = onEvent; return { dispose() {} }; },
    () => { checks++; },
    10,
    () => busy,
    (cb) => { idleCb = cb; return () => undefined; },
  );
  fire();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(checks, 0, "no check during a hook write");
  busy = false;
  idleCb();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(checks, 1, "one check after the write ends");
  w.dispose();
});

test("deferred guard does not revoke when the change heals during the recheck delay", async () => {
  const root = projectWithApprovedClaudeCli();
  try {
    const file = path.join(root, ".claude", "hooks", "claudePermissionMode.cjs");
    const good = fs.readFileSync(file);
    fs.appendFileSync(file, "\n//half-copied\n");
    const seen: string[] = [];
    const ids = await runApprovalGuardDeferred(root, MEDIA, ENV, (m) => seen.push(m), {
      sleep: async (ms) => { if (ms > 0) fs.writeFileSync(file, good); },
    });
    assert.deepEqual(ids, []);
    assert.deepEqual(seen, []);
    const local = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(local.enabledMcpjsonServers, ["claude-cli"], "approval kept");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deferred guard revokes a change that persists, and skips while a hook write is active", async () => {
  const root = projectWithApprovedClaudeCli();
  try {
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\n//x\n");
    const seen: string[] = [];
    const noSleep = async (): Promise<void> => undefined;
    assert.deepEqual(await runApprovalGuardDeferred(root, MEDIA, ENV, (m) => seen.push(m), { sleep: noSleep, isBusy: () => true }), []);
    assert.equal(seen.length, 0);
    const revoked: string[] = await runApprovalGuardDeferred(root, MEDIA, ENV, (m) => seen.push(m), { sleep: noSleep, isBusy: () => false });
    assert.deepEqual(revoked, ["claude-cli"]);
    assert.deepEqual(seen, [revocationMessage("claude-cli")]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
