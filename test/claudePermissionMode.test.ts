// Shared Claude CLI permission-mode policy (hooks/claudePermissionMode.cjs) and a
// repo-wide guard that no source file passes a permission-bypassing mode to a spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const policy = require(path.join(process.cwd(), "hooks", "claudePermissionMode.cjs")) as {
  validPermissionMode: (v: unknown) => string | undefined;
  safePermissionMode: (v: unknown, fallback: string) => string;
  resolveClaudePermissionMode: (info: unknown, env?: string) => string;
};

function projectWithAgent(id: string, md: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-mode-"));
  fs.mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "agents", `${id}.md`), md);
  return dir;
}

test("validPermissionMode rejects bypassPermissions, dontAsk, auto and unknown values", () => {
  for (const bad of ["bypassPermissions", "dontAsk", "auto", "", "nonsense", undefined, 7]) {
    assert.equal(policy.validPermissionMode(bad), undefined, String(bad));
  }
  for (const ok of ["plan", "default", "acceptEdits"]) assert.equal(policy.validPermissionMode(ok), ok);
});

test("safePermissionMode falls back to the safe base for rejected values", () => {
  assert.equal(policy.safePermissionMode("bypassPermissions", "plan"), "plan");
  assert.equal(policy.safePermissionMode("dontAsk", "plan"), "plan");
  assert.equal(policy.safePermissionMode(undefined, "plan"), "plan");
  assert.equal(policy.safePermissionMode("default", "plan"), "default");
  assert.equal(policy.safePermissionMode("x", "bypassPermissions"), "plan");
});

test("resolveClaudePermissionMode: env only downgrades, bad values keep the base", () => {
  const dir = projectWithAgent("coding-specialist", "---\nname: coding-specialist\ntools: Edit, Write\n---\n");
  const info = { workerId: "coding-specialist", projectDir: dir };
  try {
    assert.equal(policy.resolveClaudePermissionMode(info, undefined), "acceptEdits");
    assert.equal(policy.resolveClaudePermissionMode(info, "plan"), "plan");
    assert.equal(policy.resolveClaudePermissionMode(info, "default"), "default");
    for (const bad of ["bypassPermissions", "dontAsk", "nonsense"]) {
      assert.equal(policy.resolveClaudePermissionMode(info, bad), "acceptEdits", bad);
    }
    assert.equal(policy.resolveClaudePermissionMode({ workerId: "code-reviewer", projectDir: dir }, "acceptEdits"), "plan");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no source file passes bypassPermissions, dontAsk or --dangerously-skip-permissions to a spawn", () => {
  const root = process.cwd();
  const roots = ["hooks", "src", path.join("standalone", "src"), "scripts"];
  const skipDirs = new Set(["node_modules", "out", "dist", ".git"]);
  const exts = new Set([".cjs", ".js", ".mjs", ".ts"]);
  // Files that name the modes only to reject them.
  const allow = new Set([path.join("hooks", "claudePermissionMode.cjs")]);
  const bad = /dangerously-skip-permissions|["'`]bypassPermissions["'`]|["'`]dontAsk["'`]/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.has(path.extname(e.name))) {
        const rel = path.relative(root, full);
        if (allow.has(rel)) continue;
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        lines.forEach((l, i) => {
          if (bad.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)) offenders.push(`${rel}:${i + 1}: ${l.trim()}`);
        });
      }
    }
  };
  for (const r of roots) if (fs.existsSync(path.join(root, r))) walk(path.join(root, r));
  assert.deepEqual(offenders, []);
});
