/*
 * Foreign-LLM CLI calls made through Bash/PowerShell (codex exec, gemini -p, ...):
 * classifier, inline-copy parity with the hook, hook start/end records, state counters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { classifyForeignCli } from "../src/core/foreignCli";
import { applyEvent, initialWorldState, IN_FLIGHT_CEILING_MS, creditedElapsed } from "../src/core/state";
import { mapHookRecord } from "../src/providers/claude-code/mapHookRecord";
import { TYCOON_HOOK_SLOTS, mergeTycoonHooks, migrateLegacyHookMatchers } from "../src/host/vscode/hookInstall";

const HOOK_PATH = join(process.cwd(), "hooks", "tycoon-claude-hook.cjs");

const POSITIVES: Array<[string, { vendor: string; cli: string; model: string | null }]> = [
  [`codex exec -m gpt-6.1-terra -s workspace-write -C D:\\proj "Read BRIEF.md and do it."`, { vendor: "openai", cli: "codex", model: "gpt-6.1-terra" }],
  [`codex e --model gpt-6.1-terra "do it"`, { vendor: "openai", cli: "codex", model: "gpt-6.1-terra" }],
  [`codex exec --model=gpt-6 "x"`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`codex exec -c model="gpt-6.1-sol" "x"`, { vendor: "openai", cli: "codex", model: "gpt-6.1-sol" }],
  [`codex exec "no model given"`, { vendor: "openai", cli: "codex", model: null }],
  [`cd /tmp/proj && codex exec -m gpt-6 'say "hi"' 2>&1 | tee out.txt`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`"C:\\Users\\me\\AppData\\codex.exe" exec -m gpt-6 "x"`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`C:\\tools\\codex.cmd exec -m gpt-6 "x"`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`& "C:\\Program Files\\codex\\codex.exe" exec -m gpt-6 "x"`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`OPENAI_API_KEY=abc /usr/local/bin/codex exec -m gpt-6 "x"`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`bash -c 'codex exec -m gpt-6 "x"'`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`powershell -Command "codex exec -m gpt-6 'x'"`, { vendor: "openai", cli: "codex", model: "gpt-6" }],
  [`gemini -p "summarize" -m gemini-2.5-pro`, { vendor: "google", cli: "gemini", model: "gemini-2.5-pro" }],
  [`gemini "summarize this repo"`, { vendor: "google", cli: "gemini", model: null }],
  [`opencode run -m openai/gpt-6 "x"`, { vendor: "openai", cli: "opencode", model: "openai/gpt-6" }],
  [`opencode run "x"`, { vendor: "opencode", cli: "opencode", model: null }],
  [`ollama run llama3.2 "hi"`, { vendor: "local", cli: "ollama", model: "llama3.2" }],
  ["cat > f.txt <<'EOF'\nnotes\nEOF\ncodex exec -m gpt-6 \"x\"", { vendor: "openai", cli: "codex", model: "gpt-6" }],
  ["codex exec -m gpt-6 - <<'EOF'\nprompt text\nEOF", { vendor: "openai", cli: "codex", model: "gpt-6" }],
  ["$p = @'\nhello\n'@\ncodex exec -m gpt-6 $p", { vendor: "openai", cli: "codex", model: "gpt-6" }],
];

const NEGATIVES = [
  `codex --version`, `codex debug models`, `codex login`, `codex --help`, `codex exec --help`, `codex`,
  `which codex`, `where.exe codex`, `echo "codex exec -m gpt-6"`, `grep -rn "codex exec" src`, `cat codex.exe`,
  `claude -p "hello"`, `gemini`, `gemini --version`, `gemini mcp list`, `gemini -m gemini-2.5-pro`,
  `opencode --version`, `opencode run -m anthropic/claude-sonnet "x"`, `opencode auth login`,
  "cat > f <<'EOF'\ncodex exec -m gpt-6 x\nEOF",
  "cat <<EOF\ncodex exec x\nEOF",
  "cat <<-\"END\"\n\tgemini -p hi\n\tEND\necho done",
  "$p = @'\ncodex exec -m gpt-6 x\n'@\nWrite-Output $p",
  "$p = @\"\nollama run llama3\n\"@",
  `ollama list`, `ollama pull llama3`, `ollama run --help`, `git commit -m "use codex exec"`, `npm test`, ``,
];

test("classifier: foreign CLI invocations are detected with vendor, cli and model", () => {
  for (const [cmd, want] of POSITIVES) assert.deepEqual(classifyForeignCli(cmd), want, cmd);
});

test("classifier: version/help/login, mentions in other commands, and same-vendor claude are ignored", () => {
  for (const cmd of NEGATIVES) assert.equal(classifyForeignCli(cmd), null, cmd);
  assert.equal(classifyForeignCli(undefined), null);
  assert.equal(classifyForeignCli(42), null);
});

test("hook inline copy matches src/core/foreignCli.ts for every case", () => {
  const src = readFileSync(HOOK_PATH, "utf8");
  const start = src.indexOf("// Foreign-LLM CLI classifier");
  const end = src.indexOf("// Resolve which stack entry a non-spawn tool call");
  assert.ok(start > 0 && end > start, "inline classifier block not found");
  const fn = vm.runInNewContext(`(function(){${src.slice(start, end)}\nreturn classifyForeignCli;})()`) as (c: unknown) => unknown;
  for (const [cmd] of POSITIVES) assert.deepEqual(JSON.parse(JSON.stringify(fn(cmd))), classifyForeignCli(cmd), cmd);
  for (const cmd of NEGATIVES) assert.equal(fn(cmd), null, cmd);
});

function runHook(root: string, payload: Record<string, unknown>) {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0, r.stderr);
}
function activity(root: string): Array<Record<string, any>> {
  const f = join(root, ".claude", "tycoon", "activity.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("hook: codex exec logs a start record with foreignCli and toolUseId; codex --version logs none; PostToolUse writes nothing for Bash", () => {
  const root = mkdtempSync(join(tmpdir(), "tycoon-foreigncli-"));
  try {
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    const cmd = `codex exec -m gpt-6.1-terra -s workspace-write "Read BRIEF.md and do it."`;
    runHook(root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_1", session_id: "s1", tool_input: { command: cmd } });
    runHook(root, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_1", session_id: "s1", tool_input: { command: cmd } });
    const recs = activity(root);
    const pre = recs.find((r) => r.event === "PreToolUse" && r.tool === "Bash");
    assert.ok(pre, "start record expected");
    assert.deepEqual(pre!.foreignCli, { vendor: "openai", cli: "codex", model: "gpt-6.1-terra" });
    assert.equal(pre!.toolUseId, "toolu_1");
    assert.equal(recs.filter((r) => r.event === "PostToolUse").length, 0);

    const before = activity(root).length;
    runHook(root, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_2", session_id: "s1", tool_input: { command: "codex --version" } });
    const added = activity(root).slice(before);
    assert.ok(added.every((r) => r.foreignCli === undefined && r.toolUseId === undefined), "no foreign marker for codex --version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook install: PowerShell pre-hook is wired; no Post slot for shell commands; earlier dev-build Post slots are removed", () => {
  assert.ok(TYCOON_HOOK_SLOTS.some((s) => s.event === "PreToolUse" && s.matcher === "PowerShell"));
  assert.ok(!TYCOON_HOOK_SLOTS.some((s) => s.matcher === "Bash|PowerShell"));
  const ours = [{ type: "command", command: "node /x/hooks/tycoon-claude-hook.cjs" }];
  const foreign = [{ type: "command", command: "node /x/other.js" }];
  const existing: any = {
    hooks: {
      PostToolUse: [{ matcher: "Bash|PowerShell", hooks: ours }, { matcher: "mcp__.*", hooks: ours }],
      PostToolUseFailure: [{ matcher: "Bash|PowerShell", hooks: ours }, { matcher: "Bash|PowerShell", hooks: foreign }],
    },
  };
  const merged: any = mergeTycoonHooks(existing, "node /x/hooks/tycoon-claude-hook.cjs");
  assert.ok(!merged.hooks.PostToolUse.some((e: any) => e.matcher === "Bash|PowerShell"));
  assert.ok(merged.hooks.PostToolUse.some((e: any) => e.matcher === "mcp__.*"));
  assert.equal(merged.hooks.PostToolUseFailure.filter((e: any) => e.matcher === "Bash|PowerShell").length, 1, "foreign entry kept");
  const healed = migrateLegacyHookMatchers(existing);
  assert.equal(healed.changed, true);
  assert.ok(!(healed.settings as any).hooks.PostToolUse.some((e: any) => e.matcher === "Bash|PowerShell"));
});

test("state: a foreign CLI call counts as an MCP call, stays in flight, extends the clock, and is retired by its end record", () => {
  const T0 = 1_800_000_000_000;
  const foreignCli = { vendor: "openai", cli: "codex", model: "gpt-6.1-terra" };
  let s = initialWorldState();
  for (const e of mapHookRecord({ event: "PreToolUse", tool: "Bash", toolUseId: "t1", workerId: "artist", at: T0, foreignCli } as any)) s = applyEvent(s, e);
  let m = s.agentMetrics.find((a) => a.id === "artist")!;
  assert.equal(m.mcpCount, 1);
  assert.equal(m.foreignCliCalls, 1);
  assert.deepEqual(m.lastForeignCli, foreignCli);
  assert.equal(m.inFlightCalls?.length, 1);
  assert.deepEqual(m.inFlightCalls![0]!.foreign, foreignCli);
  const late = T0 + 20 * 60_000;
  assert.equal(creditedElapsed(m.workStartAt, m.lastActivityAt, late, s.idleFreezeMs, m.inFlightCalls), 20 * 60_000);
  assert.equal(creditedElapsed(m.workStartAt, m.lastActivityAt, T0 + IN_FLIGHT_CEILING_MS * 2, s.idleFreezeMs, m.inFlightCalls), IN_FLIGHT_CEILING_MS);

  // No end record exists: the worker's next activity ends the foreign call.
  for (const e of mapHookRecord({ event: "PreToolUse", tool: "Read", workerId: "artist", at: T0 + 60_000 } as any)) s = applyEvent(s, e);
  m = s.agentMetrics.find((a) => a.id === "artist")!;
  assert.equal(m.inFlightCalls, undefined);
  assert.equal(m.mcpCount, 1);
  assert.equal(m.foreignCliCalls, 1);
});

test("state: a second foreign call replaces the first, and an unrelated worker's activity does not end it", () => {
  const T0 = 1_800_000_000_000;
  const fc = { vendor: "openai", cli: "codex", model: null };
  let s = initialWorldState();
  const pre = (w: string, at: number, extra: any = {}) => mapHookRecord({ event: "PreToolUse", tool: "Bash", workerId: w, at, ...extra } as any);
  for (const e of pre("artist", T0, { foreignCli: fc, toolUseId: "a" })) s = applyEvent(s, e);
  for (const e of pre("other", T0 + 1000)) s = applyEvent(s, e);
  assert.equal(s.agentMetrics.find((a) => a.id === "artist")!.inFlightCalls?.length, 1);
  for (const e of pre("artist", T0 + 2000, { foreignCli: fc, toolUseId: "b" })) s = applyEvent(s, e);
  const m = s.agentMetrics.find((a) => a.id === "artist")!;
  assert.equal(m.inFlightCalls?.length, 1);
  assert.equal(m.inFlightCalls![0]!.id, "b");
  assert.equal(m.foreignCliCalls, 2);
});
