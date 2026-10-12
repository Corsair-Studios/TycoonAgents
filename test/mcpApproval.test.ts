import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  tycoonServerDefsFromMedia,
  computeMcpApprovalState,
  approveTycoonMcpServers,
  removeTycoonMcpApprovals,
  mcpEntryMatchesOurs,
  repairTycoonHookCopies,
  revokeTycoonMcpApproval,
  nodeLauncherInProject,
  autoRevokeChangedApprovals,
} from "../src/core/mcpApproval";
import type { ApprovalEnv } from "../src/core/mcpApproval";
import { bridgeFilesForConfig } from "../src/host/vscode/hookInstall";
import { resolveConfigForPlatform, withDispatcherProjectDir } from "../src/host/vscode/mcpCatalog";
import { MSG_SCHEMAS } from "../src/host/vscode/messages";

/*
 * Explicit "Approve TycoonAgents servers" action: only servers TycoonAgents
 * installed (id AND exact command), never third-party, never user-rejected;
 * writes settings.local.json only, on request.
 */

const REPO = process.cwd();
const DEFS = tycoonServerDefsFromMedia(path.join(REPO, "media"));
const MCP_CATALOG: any[] = JSON.parse(fs.readFileSync(path.join(REPO, "media", "mcp", "catalog.json"), "utf8"));
const OURS = Object.keys(DEFS);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-approval-"));
}

const HOME = tmp();
const ENV: ApprovalEnv = {
  homeDir: HOME,
  resolveSrc: (f) => {
    const p = path.join(REPO, "hooks", f);
    return fs.existsSync(p) ? p : undefined;
  },
};

/** Copy the hook files `id` needs into root/.claude/hooks, like the installer does. */
function installHooks(root: string, id: string): void {
  const files = bridgeFilesForConfig(genuine(root, id));
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(REPO, "hooks", f), path.join(root, ".claude", "hooks", f));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
}

/** The entry TycoonAgents itself would write for `id` in `root`. */
function genuine(root: string, id: string): unknown {
  const entry = MCP_CATALOG.find((e) => e.id === id);
  const r = resolveConfigForPlatform(entry, process.platform);
  assert.ok(r.ok);
  return withDispatcherProjectDir(id, (r as any).config, root);
}

function writeMcp(root: string, servers: Record<string, unknown>): void {
  for (const id of Object.keys(servers)) if (OURS.includes(id) && JSON.stringify(servers[id]) === JSON.stringify(genuine(root, id))) installHooks(root, id);
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

function writeSettings(root: string, file: string, data: unknown): void {
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", file), typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function readLocal(root: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"));
}

test("our server ids are derived from the bridge pack and catalog, not a hand list", () => {
  for (const id of ["tycoon", "codex", "claude-cli", "gemini", "openai-compatible"]) assert.ok(OURS.includes(id), id);
  for (const id of ["playwright", "filesystem", "github", "uefn-bridge", "blender"]) assert.ok(!OURS.includes(id), id);
});

test("only our genuine present ids are pending; third-party ids never", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: genuine(root, "codex"), playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] } });
    const st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual(st.pending, ["codex", "tycoon"]);
    const res = approveTycoonMcpServers(root, DEFS, undefined, false, ENV);
    assert.equal(res.ok, true);
    const local = readLocal(root);
    assert.deepEqual(local.enabledMcpjsonServers.sort(), ["codex", "tycoon"]);
    assert.equal(local.permissions, undefined, "no allow rules unless opted in");
    assert.equal(local.enableAllProjectMcpServers, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a forged entry with our id but a different command is never approved", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: { command: "node", args: ["evil/run.js"] }, codex: genuine(root, "codex") });
    const st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual(st.pending, ["codex"]);
    assert.deepEqual(st.foreign, ["tycoon"]);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], true, ENV).ok, false);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
    // Other forgery shapes: different launcher, extra env, extra key.
    const g = genuine(root, "claude-cli") as any;
    assert.equal(mcpEntryMatchesOurs(root, "claude-cli", { ...g, command: "bash" }, DEFS["claude-cli"]), false);
    assert.equal(mcpEntryMatchesOurs(root, "claude-cli", { ...g, command: "C:/tmp/node.exe" }, DEFS["claude-cli"]), false);
    assert.equal(mcpEntryMatchesOurs(root, "claude-cli", { ...g, env: { NODE_OPTIONS: "--require x" } }, DEFS["claude-cli"]), false);
    assert.equal(mcpEntryMatchesOurs(root, "claude-cli", { ...g, url: "http://x" }, DEFS["claude-cli"]), false);
    assert.equal(mcpEntryMatchesOurs(root, "claude-cli", { ...g, args: [...g.args, "--extra"] }, DEFS["claude-cli"]), false);
    // Remove leaves a forged id's pre-existing entries alone.
    writeSettings(root, "settings.local.json", { enabledMcpjsonServers: ["tycoon", "codex"], permissions: { allow: ["mcp__tycoon"] } });
    const rm = removeTycoonMcpApprovals(root, DEFS, ENV);
    assert.deepEqual(rm.ids, ["codex"]);
    assert.deepEqual(readLocal(root).enabledMcpjsonServers, ["tycoon"]);
    assert.deepEqual(readLocal(root).permissions.allow, ["mcp__tycoon"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("path separators and quoting are normalised when matching", () => {
  const root = tmp();
  try {
    const g = genuine(root, "tycoon") as any;
    const script = String(g.args[0]);
    const variants = [
      { ...g, args: [script.split("/").join("\\")] },
      { ...g, args: [`"${script}"`] },
      { ...g, command: '"node"' },
      { ...g, command: "node.exe" },
      { ...g, args: [`./${script}`] },
      { ...g, args: [`${root.split(path.sep).join("\\")}\\${script.split("/").join("\\")}`] },
      { ...g, args: [`${root.split(path.sep).join("/")}/${script}`] },
    ];
    for (const v of variants) assert.equal(mcpEntryMatchesOurs(root, "tycoon", v, DEFS["tycoon"]), true, JSON.stringify(v));
    assert.equal(mcpEntryMatchesOurs(root, "tycoon", { ...g, args: [`${root}/elsewhere/${script}`] }, DEFS["tycoon"]), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the gemini backend env the panel writes still counts as ours", () => {
  const root = tmp();
  try {
    const g = genuine(root, "gemini") as any;
    assert.equal(mcpEntryMatchesOurs(root, "gemini", { ...g, env: { ...g.env, GEMINI_MCP_BACKEND: "gemini" } }, DEFS["gemini"]), true);
    assert.equal(mcpEntryMatchesOurs(root, "gemini", { ...g, env: { ...g.env, GEMINI_MCP_BACKEND: "x; rm" } }, DEFS["gemini"]), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("servers the user disabled are never re-approved and shown as rejected", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: genuine(root, "codex") });
    writeSettings(root, "settings.local.json", { disabledMcpjsonServers: ["codex"] });
    const st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual(st.pending, ["tycoon"]);
    assert.deepEqual(st.rejected, ["codex"]);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon", "codex"], true, ENV).ok, false);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, ENV).ok, true);
    assert.deepEqual(readLocal(root).enabledMcpjsonServers, ["tycoon"]);
    assert.deepEqual(readLocal(root).disabledMcpjsonServers, ["codex"]);
    // A rejection recorded in the shared settings.json is respected too.
    writeSettings(root, "settings.json", { disabledMcpjsonServers: ["tycoon"] });
    fs.rmSync(path.join(root, ".claude", "settings.local.json"));
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).pending, ["codex"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("already approved servers are not pending (local or shared settings)", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: genuine(root, "codex") });
    writeSettings(root, "settings.json", { enabledMcpjsonServers: ["tycoon"] });
    writeSettings(root, "settings.local.json", { enabledMcpjsonServers: ["codex"] });
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).pending, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("allow rules are written only when opted in, for the same ids only; settings.json untouched; other keys kept", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), github: { type: "http", url: "https://x/" } });
    const shared = JSON.stringify({ permissions: { allow: ["Bash(ls)"] } });
    writeSettings(root, "settings.json", shared);
    writeSettings(root, "settings.local.json", { hooks: { Stop: [] }, permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm)"] } });
    const res = approveTycoonMcpServers(root, DEFS, ["tycoon"], true, ENV);
    assert.equal(res.ok, true);
    const local = readLocal(root);
    assert.deepEqual(local.enabledMcpjsonServers, ["tycoon"]);
    assert.deepEqual(local.permissions.allow, ["Bash(git status)", "mcp__tycoon"]);
    assert.deepEqual(local.permissions.deny, ["Bash(rm)"]);
    assert.deepEqual(local.hooks, { Stop: [] });
    assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"), shared);
    assert.deepEqual(fs.readdirSync(path.join(root, ".claude")).sort(), ["hooks", "settings.json", "settings.local.json"], "no temp file left behind");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unparseable settings.local.json is not overwritten", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon") });
    writeSettings(root, "settings.local.json", "{ not json");
    assert.equal(computeMcpApprovalState(root, DEFS, ENV).localUnreadable, true);
    const res = approveTycoonMcpServers(root, DEFS, ["tycoon"], true, ENV);
    assert.equal(res.ok, false);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"), "{ not json");
    const rm = removeTycoonMcpApprovals(root, DEFS, ENV);
    assert.equal(rm.ok, false);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "settings.local.json"), "utf8"), "{ not json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the host rejects forged ids: not ours, not present, or third-party", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] } });
    for (const bad of [["playwright"], ["tycoon", "playwright"], ["gemini"], ["../x"], ["__proto__"], ["enableAllProjectMcpServers"]]) {
      const res = approveTycoonMcpServers(root, DEFS, bad, true, ENV);
      assert.equal(res.ok, false, bad.join());
    }
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false, "nothing written on refusal");
    assert.equal(MSG_SCHEMAS.APPROVE_TYCOON_MCP.safeParse({ type: "approveTycoonMcp", ids: ["tycoon"], allowTools: false }).success, true);
    assert.equal(MSG_SCHEMAS.APPROVE_TYCOON_MCP.safeParse({ type: "approveTycoonMcp", ids: [1] }).success, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remove deletes only entries this action can add and keeps everything else", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: genuine(root, "codex") });
    writeSettings(root, "settings.local.json", {
      env: { A: "1" },
      enabledMcpjsonServers: ["tycoon", "playwright", "codex"],
      disabledMcpjsonServers: ["gemini"],
      permissions: { allow: ["mcp__tycoon", "mcp__playwright", "Bash(ls)", "mcp__codex"] },
    });
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).removable, ["codex", "tycoon"]);
    const res = removeTycoonMcpApprovals(root, DEFS, ENV);
    assert.equal(res.ok, true);
    assert.deepEqual(res.ids, ["codex", "tycoon"]);
    const local = readLocal(root);
    assert.deepEqual(local.enabledMcpjsonServers, ["playwright"]);
    assert.deepEqual(local.permissions.allow, ["mcp__playwright", "Bash(ls)"]);
    assert.deepEqual(local.disabledMcpjsonServers, ["gemini"]);
    assert.deepEqual(local.env, { A: "1" });
    // Nothing to remove and no file: no-op, no file created.
    const empty = tmp();
    try {
      assert.deepEqual(removeTycoonMcpApprovals(empty, DEFS, ENV), { ok: true, ids: [] });
      assert.equal(fs.existsSync(path.join(empty, ".claude")), false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("content check: a modified or missing script or require-closure file is not approved", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), "claude-cli": genuine(root, "claude-cli") });
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).pending, ["claude-cli", "tycoon"]);
    // Tamper with a transitive dependency (not the entry script itself).
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\nrequire('child_process').exec('x');\n");
    let st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual([...st.modified].sort(), ["claude-cli", "tycoon"], "a shared dependency taints every server that requires it");
    assert.deepEqual(st.pending, []);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, ENV).ok, false);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
    // Repair re-copies from the installed extension, then approval is possible.
    assert.equal(repairTycoonHookCopies(root, DEFS, ENV).ok, true);
    st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual(st.modified, []);
    assert.deepEqual(st.pending, ["claude-cli", "tycoon"]);
    // A missing file is also a mismatch.
    fs.rmSync(path.join(root, ".claude", "hooks", "bridge-result.cjs"));
    assert.ok(computeMcpApprovalState(root, DEFS, ENV).modified.includes("claude-cli"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** File symlinks need privilege on Windows; returns false (so the caller can skip) when they are not allowed. */
function tryFileSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  }
}

test("content check: a junction or symlink for .claude/hooks is refused and never repaired through the link", () => {
  const root = tmp();
  const outside = tmp();
  try {
    writeMcp(root, { "claude-cli": genuine(root, "claude-cli") });
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).pending, ["claude-cli"]);
    fs.renameSync(path.join(root, ".claude", "hooks"), path.join(outside, "hooks"));
    fs.symlinkSync(path.join(outside, "hooks"), path.join(root, ".claude", "hooks"), "junction");
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).modified, ["claude-cli"]);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["claude-cli"], false, ENV).ok, false);
    assert.equal(repairTycoonHookCopies(root, DEFS, ENV).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("content check: a symlinked hook script with identical content is refused", (ctx) => {
  const root = tmp();
  const outside = tmp();
  try {
    writeMcp(root, { "claude-cli": genuine(root, "claude-cli") });
    const script = path.join(root, ".claude", "hooks", "claude-cli-mcp.cjs");
    const copy = path.join(outside, "claude-cli-mcp.cjs");
    fs.copyFileSync(script, copy);
    fs.rmSync(script);
    if (!tryFileSymlink(copy, script)) return ctx.skip("file symlinks not permitted here");
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).modified, ["claude-cli"]);
    assert.equal(repairTycoonHookCopies(root, DEFS, ENV).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("PATH hijack: a node launcher in the project folder makes nothing approvable", () => {
  for (const [platform, name] of [["win32", "node.cmd"], ["win32", "node.exe"], ["linux", "node"]] as const) {
    const root = tmp();
    try {
      writeMcp(root, { tycoon: genuine(root, "tycoon") });
      const env: ApprovalEnv = { ...ENV, platform };
      assert.equal(nodeLauncherInProject(root, platform), null);
      fs.writeFileSync(path.join(root, name), "x");
      assert.equal(nodeLauncherInProject(root, platform), name);
      const st = computeMcpApprovalState(root, DEFS, env);
      assert.equal(st.pathHijack, name);
      assert.deepEqual(st.pending, []);
      const res = approveTycoonMcpServers(root, DEFS, ["tycoon"], false, env);
      assert.equal(res.ok, false);
      assert.match(String(res.error), /launcher/);
      assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rejections in ~/.claude.json (matched to this project) and ~/.claude/settings.json are respected; unreadable fails closed", () => {
  const root = tmp();
  const home = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: genuine(root, "codex"), gemini: genuine(root, "gemini") });
    const env: ApprovalEnv = { ...ENV, homeDir: home };
    // win32 matching ignores case and separator style.
    const key = root.split(path.sep).join("/").toUpperCase();
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [key]: { disabledMcpjsonServers: ["codex"] }, "/other": { disabledMcpjsonServers: ["tycoon"] } } }));
    assert.deepEqual(computeMcpApprovalState(root, DEFS, { ...env, platform: "win32" }).rejected, ["codex"]);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { disabledMcpjsonServers: ["codex"] } } }));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ disabledMcpjsonServers: ["gemini"] }));
    const st = computeMcpApprovalState(root, DEFS, env);
    assert.deepEqual(st.rejected, ["codex", "gemini"]);
    assert.deepEqual(st.pending, ["tycoon"]);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["codex"], false, env).ok, false);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, env).ok, true);
    // Unreadable ~/.claude.json: fail closed.
    fs.writeFileSync(path.join(home, ".claude.json"), "{ nope");
    fs.rmSync(path.join(root, ".claude", "settings.local.json"));
    const bad = computeMcpApprovalState(root, DEFS, env);
    assert.equal(bad.homeUnreadable, true);
    assert.deepEqual(bad.pending, []);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, env).ok, false);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
    // A missing ~/.claude.json is fine.
    fs.rmSync(path.join(home, ".claude.json"));
    assert.deepEqual(computeMcpApprovalState(root, DEFS, env).pending, ["codex", "tycoon"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("writing is refused when .claude is a junction or settings.local.json is a symlink", (ctx) => {
  const root = tmp();
  const outside = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon") });
    // .claude as a junction to a folder elsewhere (hooks live there too, so only the settings path check can refuse).
    fs.renameSync(path.join(root, ".claude"), path.join(outside, ".claude"));
    fs.symlinkSync(path.join(outside, ".claude"), path.join(root, ".claude"), "junction");
    assert.equal(computeMcpApprovalState(root, DEFS, ENV).unsafeSettingsPath, true);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, ENV).ok, false);
    assert.equal(removeTycoonMcpApprovals(root, DEFS, ENV).ok, false);
    assert.equal(fs.existsSync(path.join(outside, ".claude", "settings.local.json")), false);
    fs.rmSync(path.join(root, ".claude"), { recursive: true, force: false });
    fs.renameSync(path.join(outside, ".claude"), path.join(root, ".claude"));
    const target = path.join(outside, "real.json");
    fs.writeFileSync(target, "{}");
    if (!tryFileSymlink(target, path.join(root, ".claude", "settings.local.json"))) return ctx.skip("file symlinks not permitted here");
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, ENV).ok, false);
    assert.equal(removeTycoonMcpApprovals(root, DEFS, ENV).ok, false);
    assert.equal(fs.readFileSync(target, "utf8"), "{}");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("tycoon (the dispatcher) is not approvable while any sibling bridge entry is foreign or modified", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: { command: "node", args: ["evil.js"] }, "claude-cli": genuine(root, "claude-cli") });
    let st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual(st.dispatcherBlockedBy, ["codex"]);
    assert.deepEqual(st.pending, ["claude-cli"]);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, ENV).ok, false);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["claude-cli"], false, ENV).ok, true);
    // A modified sibling script is inside the dispatcher's own hashed closure, so tycoon itself is modified too.
    writeMcp(root, { tycoon: genuine(root, "tycoon"), "claude-cli": genuine(root, "claude-cli") });
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claude-cli-mcp.cjs"), "\n//x\n");
    st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual([...st.modified].sort(), ["claude-cli", "tycoon"]);
    assert.deepEqual(st.pending, []);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["tycoon"], false, ENV).ok, false);
    // A sibling that is absent does not block.
    writeMcp(root, { tycoon: genuine(root, "tycoon") });
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).dispatcherBlockedBy, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project .claude/out folder (require fallback) makes every server modified", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), "openai-compatible": genuine(root, "openai-compatible") });
    assert.equal(computeMcpApprovalState(root, DEFS, ENV).outFallback, false);
    fs.mkdirSync(path.join(root, ".claude", "out"));
    const st = computeMcpApprovalState(root, DEFS, ENV);
    assert.equal(st.outFallback, true);
    assert.deepEqual([...st.modified].sort(), ["openai-compatible", "tycoon"]);
    assert.deepEqual(st.pending, []);
    assert.equal(approveTycoonMcpServers(root, DEFS, ["openai-compatible"], false, ENV).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the closure includes localEnvStore.js and the CommonJS package.json marker", () => {
  const root = tmp();
  try {
    writeMcp(root, { "openai-compatible": genuine(root, "openai-compatible") });
    assert.ok(fs.existsSync(path.join(root, ".claude", "hooks", "localEnvStore.js")));
    fs.appendFileSync(path.join(root, ".claude", "hooks", "localEnvStore.js"), "\n//x\n");
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).modified, ["openai-compatible"]);
    installHooks(root, "openai-compatible");
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).pending, ["openai-compatible"]);
    fs.writeFileSync(path.join(root, ".claude", "hooks", "package.json"), JSON.stringify({ type: "commonjs", imports: { "#x": "./evil.js" } }));
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).modified, ["openai-compatible"]);
    // Repair restores the marker.
    assert.equal(repairTycoonHookCopies(root, DEFS, ENV).ok, true);
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).pending, ["openai-compatible"]);
    fs.rmSync(path.join(root, ".claude", "hooks", "package.json"));
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).modified, ["openai-compatible"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repair refuses when .claude/hooks/package.json is a link", (ctx) => {
  const root = tmp();
  const outside = tmp();
  try {
    writeMcp(root, { "claude-cli": genuine(root, "claude-cli") });
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claude-cli-mcp.cjs"), "\n//x\n");
    const target = path.join(outside, "package.json");
    fs.writeFileSync(target, JSON.stringify({ type: "commonjs" }));
    fs.rmSync(path.join(root, ".claude", "hooks", "package.json"));
    if (!tryFileSymlink(target, path.join(root, ".claude", "hooks", "package.json"))) return ctx.skip("file symlinks not permitted here");
    assert.equal(repairTycoonHookCopies(root, DEFS, ENV).ok, false);
    assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify({ type: "commonjs" }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("PATH hijack on win32 covers any node.<ext> (PATHEXT) and bare node; POSIX only exact node", () => {
  for (const name of ["node.vbs", "node.js", "node.WSH", "node.msc", "NODE.EXE", "node"]) {
    const root = tmp();
    try {
      fs.writeFileSync(path.join(root, name), "x");
      assert.equal(nodeLauncherInProject(root, "win32"), name, name);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, "nodemon.js"), "x");
    fs.writeFileSync(path.join(root, "node_modules.txt"), "x");
    assert.equal(nodeLauncherInProject(root, "win32"), null, "unrelated names are fine");
    fs.writeFileSync(path.join(root, "node.js"), "x");
    assert.equal(nodeLauncherInProject(root, "linux"), null, "POSIX does not run node.js as node");
    fs.writeFileSync(path.join(root, "node"), "x");
    assert.equal(nodeLauncherInProject(root, "linux"), "node");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("revocation: an approved server that later changed is flagged and revoking removes only that id and its allow rule", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), "claude-cli": genuine(root, "claude-cli"), codex: genuine(root, "codex") });
    assert.equal(approveTycoonMcpServers(root, DEFS, ["claude-cli", "codex", "tycoon"], true, ENV).ok, true);
    assert.deepEqual(computeMcpApprovalState(root, DEFS, ENV).changedApproved, []);
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claude-cli-mcp.cjs"), "\n//x\n");
    let st = computeMcpApprovalState(root, DEFS, ENV);
    // tycoon is flagged too, because its sibling claude-cli changed.
    assert.deepEqual(st.changedApproved, ["claude-cli", "tycoon"]);
    const res = revokeTycoonMcpApproval(root, DEFS, "claude-cli", ENV);
    assert.deepEqual(res.ids, ["claude-cli"]);
    const local = readLocal(root);
    assert.deepEqual([...local.enabledMcpjsonServers].sort(), ["codex", "tycoon"]);
    assert.deepEqual([...local.permissions.allow].sort(), ["mcp__codex", "mcp__tycoon"]);
    st = computeMcpApprovalState(root, DEFS, ENV);
    assert.deepEqual(st.changedApproved, ["tycoon"]);
    // Forged ids are refused.
    assert.equal(revokeTycoonMcpApproval(root, DEFS, "playwright", ENV).ok, false);
    assert.deepEqual(readLocal(root).enabledMcpjsonServers.sort(), ["codex", "tycoon"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("~/.claude.json matching also uses the realpath of the project root", () => {
  const real = tmp();
  const holder = tmp();
  const home = tmp();
  try {
    const linked = path.join(holder, "linked");
    fs.symlinkSync(real, linked, "junction");
    writeMcp(real, { codex: genuine(real, "codex"), gemini: genuine(real, "gemini") });
    const env: ApprovalEnv = { ...ENV, homeDir: home };
    // Claude Code recorded the rejection under the real path; the panel opened the project through a junction.
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [fs.realpathSync(real)]: { disabledMcpjsonServers: ["codex"] } } }));
    assert.deepEqual(computeMcpApprovalState(linked, DEFS, env).rejected, ["codex"]);
    // And the other way round: recorded under the junction path, opened by real path.
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [linked]: { disabledMcpjsonServers: ["gemini"] } } }));
    assert.deepEqual(computeMcpApprovalState(real, DEFS, env).rejected, ["gemini"]);
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("auto-revoke: approved id whose script was modified is revoked; third-party and other ids stay", () => {
  const root = tmp();
  try {
    writeMcp(root, { "claude-cli": genuine(root, "claude-cli"), playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] } });
    writeSettings(root, "settings.local.json", {
      enabledMcpjsonServers: ["claude-cli", "playwright"],
      permissions: { allow: ["mcp__claude-cli", "mcp__playwright", "Bash(ls)"] },
      other: 1,
    });
    assert.deepEqual(autoRevokeChangedApprovals(root, DEFS, ENV), { ok: true, ids: [] }, "unchanged installs are left alone");
    fs.appendFileSync(path.join(root, ".claude", "hooks", "claudePermissionMode.cjs"), "\n// tampered\n");
    const res = autoRevokeChangedApprovals(root, DEFS, ENV);
    assert.equal(res.ok, true);
    assert.ok(res.ids.includes("claude-cli"));
    const local = readLocal(root);
    assert.ok(!local.enabledMcpjsonServers.includes("claude-cli"));
    assert.ok(local.enabledMcpjsonServers.includes("playwright"), "third-party server untouched");
    assert.deepEqual(local.permissions.allow.filter((x: string) => x.includes("claude-cli")), []);
    assert.ok(local.permissions.allow.includes("mcp__playwright") && local.permissions.allow.includes("Bash(ls)"));
    assert.equal(local.other, 1);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.json")), false, "settings.json never written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-revoke: foreign entry and .claude/out fallback revoke ours only; unapproved ids are not touched", () => {
  const root = tmp();
  try {
    writeMcp(root, { tycoon: genuine(root, "tycoon"), codex: { command: "evil", args: [] } });
    writeSettings(root, "settings.local.json", { enabledMcpjsonServers: ["codex", "tycoon", "github"] });
    const res = autoRevokeChangedApprovals(root, DEFS, ENV);
    assert.ok(res.ids.includes("codex"));
    assert.ok(readLocal(root).enabledMcpjsonServers.includes("github"));
    fs.mkdirSync(path.join(root, ".claude", "out"), { recursive: true });
    autoRevokeChangedApprovals(root, DEFS, ENV);
    assert.deepEqual(readLocal(root).enabledMcpjsonServers, ["github"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-revoke: no settings.local.json means nothing is created", () => {
  const root = tmp();
  try {
    writeMcp(root, { codex: { command: "evil", args: [] } });
    assert.deepEqual(autoRevokeChangedApprovals(root, DEFS, ENV), { ok: true, ids: [] });
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
