/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// The Codex notify hook and the dispatcher MCP are machine-wide: they must
// find the project from where Codex runs (payload cwd / process cwd), never
// from their own file location. Hook cases spawn the real script as a child
// process; no network, no timers.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

const HOOK = path.resolve(__dirname, "..", "..", "hooks", "tycoon-codex-hook.cjs");
const DISPATCHER = path.resolve(__dirname, "..", "..", "hooks", "tycoon-dispatcher-mcp.cjs");

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeProject(): string {
  const dir = tmp("tycoon-projres-");
  fs.mkdirSync(path.join(dir, ".claude", "tycoon"), { recursive: true });
  return dir;
}

function runHook(payload: Record<string, unknown>, opts: { cwd: string; claudeProjectDir?: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: tmp("tycoon-projres-home-") };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.TYCOON_CODEX_BRIDGE;
  if (opts.claudeProjectDir) env.CLAUDE_PROJECT_DIR = opts.claudeProjectDir;
  return spawnSync(process.execPath, [HOOK, JSON.stringify(payload)], {
    cwd: opts.cwd,
    env,
    input: "",
    encoding: "utf8",
  });
}

function readRecords(project: string): Array<Record<string, unknown>> {
  const file = path.join(project, ".claude", "tycoon", "activity.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const NOTIFY = { type: "agent-turn-complete", "thread-id": "thread-projres-1" };

test("hook: payload cwd inside a TycoonAgents project writes records there", () => {
  const project = makeProject();
  const elsewhere = tmp("tycoon-projres-other-");
  const r = runHook({ ...NOTIFY, cwd: project }, { cwd: elsewhere });
  assert.equal(r.status, 0);
  const events = readRecords(project).map((x) => x.event);
  assert.deepEqual(events, ["UserPromptSubmit", "Stop"]);
  assert.equal(fs.existsSync(path.join(elsewhere, ".claude")), false);
});

test("hook: payload cwd in a subfolder walks up to the project", () => {
  const project = makeProject();
  const sub = path.join(project, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  runHook({ ...NOTIFY, cwd: sub }, { cwd: tmp("tycoon-projres-other-") });
  assert.equal(readRecords(project).length, 2);
  assert.equal(fs.existsSync(path.join(sub, ".claude")), false);
});

test("hook: process cwd is used when the payload has no cwd", () => {
  const project = makeProject();
  runHook({ ...NOTIFY }, { cwd: project });
  assert.equal(readRecords(project).length, 2);
});

test("hook: no .claude/tycoon anywhere -> nothing written, no directories created", () => {
  const bare = tmp("tycoon-projres-bare-");
  const r = runHook({ ...NOTIFY, cwd: bare }, { cwd: bare });
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readdirSync(bare), []);
});

test("hook: CLAUDE_PROJECT_DIR wins over payload cwd", () => {
  const overrideProject = makeProject();
  const cwdProject = makeProject();
  runHook({ ...NOTIFY, cwd: cwdProject }, { cwd: cwdProject, claudeProjectDir: overrideProject });
  assert.equal(readRecords(overrideProject).length, 2);
  assert.equal(readRecords(cwdProject).length, 0);
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rollout = require("../../hooks/codexRollout.cjs") as {
  findTycoonProjectRoot: (d: string) => string | null;
  resolveProjectRoot: (c: string[], env?: NodeJS.ProcessEnv) => string | null;
};

test("codexRollout.resolveProjectRoot: env wins, then first candidate with a marker, else null", () => {
  const a = makeProject();
  const b = makeProject();
  const bare = tmp("tycoon-projres-bare-");
  assert.equal(rollout.resolveProjectRoot([bare, a], {}), a);
  assert.equal(rollout.resolveProjectRoot([path.join(b, "x"), a], {}), b);
  assert.equal(rollout.resolveProjectRoot([bare], {}), null);
  assert.equal(rollout.resolveProjectRoot([a], { CLAUDE_PROJECT_DIR: b }), b);
});

function withCwdAndEnv<T>(cwd: string, projectDir: string | undefined, fn: () => T): T {
  const prevCwd = process.cwd();
  const prevEnv = process.env.TYCOON_PROJECT_DIR;
  if (projectDir === undefined) delete process.env.TYCOON_PROJECT_DIR;
  else process.env.TYCOON_PROJECT_DIR = projectDir;
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(prevCwd);
    if (prevEnv === undefined) delete process.env.TYCOON_PROJECT_DIR;
    else process.env.TYCOON_PROJECT_DIR = prevEnv;
  }
}

function loadDispatcher(): { resolveActivityFile: () => string; resolveProjectDir: () => string | null } {
  delete require.cache[require.resolve(DISPATCHER)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(DISPATCHER);
}

test("dispatcher: cwd in a project resolves its activity file; subfolder walks up", () => {
  const project = makeProject();
  const sub = path.join(project, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  const mod = loadDispatcher();
  withCwdAndEnv(sub, undefined, () => {
    assert.equal(mod.resolveProjectDir(), project);
    assert.equal(mod.resolveActivityFile(), path.join(project, ".claude", "tycoon", "activity.jsonl"));
  });
});

test("dispatcher: TYCOON_PROJECT_DIR wins over cwd", () => {
  const override = makeProject();
  const cwdProject = makeProject();
  const mod = loadDispatcher();
  withCwdAndEnv(cwdProject, override, () => {
    assert.equal(mod.resolveProjectDir(), override);
  });
});

test("dispatcher: no marker above cwd -> null (the source checkout's own marker is NOT used)", () => {
  const bare = tmp("tycoon-projres-bare-");
  const mod = loadDispatcher();
  withCwdAndEnv(bare, undefined, () => {
    assert.equal(mod.resolveProjectDir(), null);
    assert.throws(() => mod.resolveActivityFile(), /couldn't tell which project/);
    assert.deepEqual(fs.readdirSync(bare), []);
  });
});

test("dispatcher copied into <project>/.claude/hooks resolves the project root via its own location", () => {
  const project = makeProject();
  const hooksDir = path.join(project, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const srcHooks = path.dirname(DISPATCHER);
  for (const f of fs.readdirSync(srcHooks)) {
    const from = path.join(srcHooks, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(hooksDir, f));
  }
  const copied = path.join(hooksDir, "tycoon-dispatcher-mcp.cjs");
  delete require.cache[require.resolve(copied)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(copied) as { resolveProjectDir: () => string | null; resolveActivityFile: () => string };
  const outside = tmp("tycoon-projres-bare-");
  withCwdAndEnv(outside, undefined, () => {
    assert.equal(mod.resolveProjectDir(), project);
    assert.equal(mod.resolveActivityFile(), path.join(project, ".claude", "tycoon", "activity.jsonl"));
  });
});

type Call = { projectDir: string; threadId?: string } | null;
function loadDispatcherAsync(): { resolveProjectForCall: (a: Record<string, unknown>) => Promise<Call>; handleDelegateTool: (a: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> } {
  delete require.cache[require.resolve(DISPATCHER)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(DISPATCHER);
}

/** Writes a rollout shaped like Codex 0.162's: session_meta first line, then a code-mode exec call of the delegate tool. */
function todayDir(home: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return path.join(home, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
}

function writeRollout(home: string, threadId: string, cwd: string, task: string, shape: "exec" | "function_call" = "exec", ageMs = 0): void {
  const dir = todayDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() - ageMs).toISOString();
  const meta = { timestamp: stamp, ordinal: 0, type: "session_meta", payload: { id: threadId, cwd, thread_source: "user", originator: "codex-tui" } };
  const call =
    shape === "exec"
      ? { type: "custom_tool_call", name: "exec", call_id: "c1", input: "const result = await tools.mcp__tycoon__delegate({specialist:\"reviewer\",task:" + JSON.stringify(task) + "});text(result);" }
      : { type: "function_call", name: "mcp__tycoon__delegate", call_id: "c1", arguments: JSON.stringify({ task }) };
  const lines = [meta, { timestamp: stamp, ordinal: 1, type: "response_item", payload: call }];
  fs.writeFileSync(path.join(dir, "rollout-2026-10-08T14-00-00-" + threadId + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function withCodexHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = { h: process.env.CODEX_HOME, d: process.env.TYCOON_ROLLOUT_MATCH_DELAY_MS };
  process.env.CODEX_HOME = home;
  process.env.TYCOON_ROLLOUT_MATCH_DELAY_MS = "0";
  try {
    return await fn();
  } finally {
    if (prev.h === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.h;
    if (prev.d === undefined) delete process.env.TYCOON_ROLLOUT_MATCH_DELAY_MS; else process.env.TYCOON_ROLLOUT_MATCH_DELAY_MS = prev.d;
  }
}

test("dispatcher: rollout match picks the project of the session that made this call", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const projA = makeProject();
  const projB = makeProject();
  writeRollout(home, "thread-aaa", path.join(projA, "src"), "task for project A");
  writeRollout(home, "thread-bbb", projB, "task for project B", "function_call");
  const mod = loadDispatcherAsync();
  const outside = tmp("tycoon-projres-bare-");
  const prevCwd = process.cwd();
  delete process.env.TYCOON_PROJECT_DIR;
  process.chdir(outside);
  try {
    await withCodexHome(home, async () => {
      assert.deepEqual(await mod.resolveProjectForCall({ task: "task for project A" }), { projectDir: projA, threadId: "thread-aaa" });
      assert.deepEqual(await mod.resolveProjectForCall({ task: "task for project B" }), { projectDir: projB, threadId: "thread-bbb" });
    });
  } finally {
    process.chdir(prevCwd);
  }
});

test("dispatcher: no rollout match -> null, and delegate returns isError without writing", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const proj = makeProject();
  // Old delegate call (30 min) in a recently touched rollout must not be chosen.
  writeRollout(home, "thread-ccc", proj, "some other task", "exec", 30 * 60 * 1000);
  const mod = loadDispatcherAsync();
  const outside = tmp("tycoon-projres-bare-");
  const prevCwd = process.cwd();
  delete process.env.TYCOON_PROJECT_DIR;
  process.chdir(outside);
  try {
    await withCodexHome(home, async () => {
      assert.equal(await mod.resolveProjectForCall({ task: "unmatched task" }), null);
      const r = await mod.handleDelegateTool({ task: "unmatched task" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /couldn't tell which project/);
    });
  } finally {
    process.chdir(prevCwd);
  }
  assert.equal(readRecords(proj).length, 0);
});

test("dispatcher: matched session outside any TycoonAgents project -> null (no guessing)", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  writeRollout(home, "thread-ddd", tmp("tycoon-projres-bare-"), "lonely task");
  const mod = loadDispatcherAsync();
  const prevCwd = process.cwd();
  delete process.env.TYCOON_PROJECT_DIR;
  process.chdir(tmp("tycoon-projres-bare-"));
  try {
    await withCodexHome(home, async () => {
      assert.equal(await mod.resolveProjectForCall({ task: "lonely task" }), null);
    });
  } finally {
    process.chdir(prevCwd);
  }
});

test("dispatcher: dynamically built task (no literal match) falls back to the one recent tycoon rollout", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const proj = makeProject();
  writeRollout(home, "thread-eee", proj, "text the call never contains verbatim");
  const mod = loadDispatcherAsync();
  const prevCwd = process.cwd();
  delete process.env.TYCOON_PROJECT_DIR;
  process.chdir(tmp("tycoon-projres-bare-"));
  try {
    await withCodexHome(home, async () => {
      assert.deepEqual(await mod.resolveProjectForCall({ task: "prefix " + "built-" + Date.now() }), { projectDir: proj, threadId: "thread-eee" });
    });
  } finally {
    process.chdir(prevCwd);
  }
});

test("dispatcher: two recent threads in the same project -> newest call wins", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const proj = makeProject();
  writeRollout(home, "thread-old", proj, "alpha", "exec", 60 * 1000);
  writeRollout(home, "thread-new", proj, "beta", "exec", 5 * 1000);
  const mod = loadDispatcherAsync();
  const prevCwd = process.cwd();
  delete process.env.TYCOON_PROJECT_DIR;
  process.chdir(tmp("tycoon-projres-bare-"));
  try {
    await withCodexHome(home, async () => {
      assert.deepEqual(await mod.resolveProjectForCall({ task: "dynamic-unmatched" }), { projectDir: proj, threadId: "thread-new" });
    });
  } finally {
    process.chdir(prevCwd);
  }
});

async function inBare<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prevCwd = process.cwd();
  delete process.env.TYCOON_PROJECT_DIR;
  process.chdir(tmp("tycoon-projres-bare-"));
  try {
    return await withCodexHome(home, fn);
  } finally {
    process.chdir(prevCwd);
  }
}

test("dispatcher: two concurrent recent sessions in different projects -> fallback refuses to guess", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  writeRollout(home, "thread-p1", makeProject(), "alpha", "exec", 10 * 1000);
  writeRollout(home, "thread-p2", makeProject(), "beta", "exec", 5 * 1000);
  const mod = loadDispatcherAsync();
  await inBare(home, async () => {
    assert.equal(await mod.resolveProjectForCall({ task: "dynamic-unmatched" }), null);
    const r = await mod.handleDelegateTool({ task: "dynamic-unmatched" });
    assert.equal(r.isError, true);
  });
});

test("dispatcher: a short task substring in an older session is not chosen (call timestamp outside the window)", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const oldProj = makeProject();
  writeRollout(home, "thread-oldsess", oldProj, "please run tests now", "exec", 30 * 60 * 1000);
  const mod = loadDispatcherAsync();
  await inBare(home, async () => {
    assert.equal(await mod.resolveProjectForCall({ task: "run tests" }), null);
  });
});

test("dispatcher: single-quoted and unicode-escaped task literals in the exec source still match", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const proj = makeProject();
  const dir = todayDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const lines = [
    { timestamp: stamp, type: "session_meta", payload: { id: "thread-sq", cwd: proj } },
    { timestamp: stamp, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.mcp__tycoon__delegate({task:'it\\'s caf\\u00e9'})" } },
  ];
  fs.writeFileSync(path.join(dir, "rollout-x-thread-sq.jsonl"), lines.map((l) => JSON.stringify(l)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  const mod = loadDispatcherAsync();
  await inBare(home, async () => {
    assert.deepEqual(await mod.resolveProjectForCall({ task: "it's café" }), { projectDir: proj, threadId: "thread-sq" });
  });
});

test("dispatcher: orchestrator start re-opens after a Stop and is not duplicated while open", async () => {
  const proj = makeProject();
  fs.mkdirSync(path.join(proj, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".claude", "agents", "coding-specialist.md"), "---\nmodel: sonnet\n---\nbody");
  const activity = path.join(proj, ".claude", "tycoon", "activity.jsonl");
  const prev = process.env.TYCOON_PROJECT_DIR;
  const prevThread = process.env.TYCOON_CODEX_THREAD_ID;
  const prevAdapter = process.env.TYCOON_DISPATCH_ADAPTER;
  process.env.TYCOON_PROJECT_DIR = proj;
  process.env.TYCOON_CODEX_THREAD_ID = "thread-reopen";
  process.env.TYCOON_DISPATCH_ADAPTER = "stub";
  try {
    const mod = loadDispatcherAsync();
    const starts = () => readRecords(proj).filter((r) => r.event === "UserPromptSubmit" && r.sessionId === "thread-reopen").length;
    await mod.handleDelegateTool({ specialist: "coding-specialist", task: "first" });
    await mod.handleDelegateTool({ specialist: "coding-specialist", task: "second, same turn" });
    assert.equal(starts(), 1);
    fs.appendFileSync(activity, JSON.stringify({ event: "Stop", provider: "codex", sessionId: "thread-reopen", at: Date.now() }) + String.fromCharCode(10));
    await mod.handleDelegateTool({ specialist: "coding-specialist", task: "next turn" });
    assert.equal(starts(), 2);
  } finally {
    if (prev === undefined) delete process.env.TYCOON_PROJECT_DIR; else process.env.TYCOON_PROJECT_DIR = prev;
    if (prevThread === undefined) delete process.env.TYCOON_CODEX_THREAD_ID; else process.env.TYCOON_CODEX_THREAD_ID = prevThread;
    if (prevAdapter === undefined) delete process.env.TYCOON_DISPATCH_ADAPTER; else process.env.TYCOON_DISPATCH_ADAPTER = prevAdapter;
  }
});

test("dispatcher: rollout match wins over a different marked project in process.cwd() (long-lived codex.exe)", async () => {
  const home = tmp("tycoon-projres-codexhome-");
  const cwdProject = makeProject();
  const testbed = makeProject();
  writeRollout(home, "thread-testbed", testbed, "task from the testbed");
  const mod = loadDispatcherAsync();
  const prevCwd = process.cwd();
  const prevThread = process.env.TYCOON_CODEX_THREAD_ID;
  delete process.env.TYCOON_PROJECT_DIR;
  process.env.TYCOON_CODEX_THREAD_ID = "stale-env-thread";
  process.chdir(cwdProject);
  try {
    await withCodexHome(home, async () => {
      assert.deepEqual(await mod.resolveProjectForCall({ task: "task from the testbed" }), { projectDir: testbed, threadId: "thread-testbed" });
    });
  } finally {
    process.chdir(prevCwd);
    if (prevThread === undefined) delete process.env.TYCOON_CODEX_THREAD_ID; else process.env.TYCOON_CODEX_THREAD_ID = prevThread;
  }
});
