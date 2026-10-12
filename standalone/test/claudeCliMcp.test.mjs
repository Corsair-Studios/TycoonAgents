// TycoonAgents standalone — coverage for hooks/claude-cli-mcp.cjs, the
// zero-dependency MCP stdio server bridging Claude to the user's own
// `claude` CLI login (see that file's header comment for the wire
// contract, and the SECURITY note on why nothing here ever uses a shell).
// Mirrors standalone/test/openaiCompatMcp.test.mjs's technique: spawn the
// real .cjs, drive it over stdin/stdout with real JSON-RPC lines, and point
// CLAUDE_CLI_BIN at a fake `claude` — either the JS file directly, or an
// npm-shim-shaped .cmd that references it, to exercise shim resolution too.
//
// Node built-ins only (node:test, node:assert, node:child_process, node:fs,
// node:os, node:path, node:url).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'claude-cli-mcp.cjs');

const FIXTURE_RESULT = {
  session_id: 'fixture-session-id',
  total_cost_usd: 0.0159636,
  num_turns: 1,
  is_error: false,
  result: 'OK',
  usage: {
    input_tokens: 10,
    output_tokens: 51,
    cache_read_input_tokens: 21526,
    cache_creation_input_tokens: 6301,
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': {
      inputTokens: 909, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 0.000954, canonicalModel: 'claude-haiku-4-5',
    },
    'claude-haiku-4-5': {
      inputTokens: 10, outputTokens: 51, cacheReadInputTokens: 21526, cacheCreationInputTokens: 6301,
      costUSD: 0.0149096, canonicalModel: 'claude-haiku-4-5',
    },
  },
};

/** Writes a fake `claude` JS entry point at <dir>/fake-claude.mjs. It reads
 * the prompt from stdin (mirroring the real CLI's -p/stdin behavior), logs
 * argv (JSON) to argvLogPath and the stdin prompt (raw text) to
 * stdinLogPath, then prints stdoutJson (or hangs, if opts.hang) and exits 0.
 * If the delivered prompt contains " & echo INJECTED & " and this ever ran
 * through a shell, an INJECTED marker file would appear next to the log —
 * the injection test asserts it never does. */
function writeFakeClaudeJs(dir, stdoutJson, argvLogPath, stdinLogPath, opts = {}) {
  const scriptPath = path.join(dir, 'fake-claude.mjs');
  const markerPath = path.join(dir, 'INJECTED');
  if (opts.hang) {
    fs.writeFileSync(scriptPath, `setInterval(() => {}, 1000);\n`);
    return scriptPath;
  }
  const body = `
import fs from 'node:fs';
const argv = process.argv.slice(2);
try { fs.writeFileSync(${JSON.stringify(argvLogPath)}, JSON.stringify(argv)); } catch {}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  try { fs.writeFileSync(${JSON.stringify(stdinLogPath)}, stdin); } catch {}
  process.stdout.write(${JSON.stringify(JSON.stringify(stdoutJson))});
  process.exit(0);
});
`;
  fs.writeFileSync(scriptPath, body);
  return scriptPath;
}

/** Writes an npm-shim-shaped .cmd at <dir>/fake-claude.cmd that references
 * jsEntryPath via %dp0%, mirroring the real shape npm generates (see
 * node_modules/.bin/*.cmd for the template this reproduces). */
function writeFakeClaudeCmdShim(dir, jsEntryPath) {
  const cmdPath = path.join(dir, 'fake-claude.cmd');
  const jsName = path.basename(jsEntryPath);
  const body = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%${jsName}" %*\r\n`;
  fs.writeFileSync(cmdPath, body);
  return cmdPath;
}

function spawnMcpServer(env) {
  const child = spawn(process.execPath, [HOOK_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c));
  return { child, getStderr: () => Buffer.concat(stderrChunks).toString('utf8') };
}

function makeLineReader(child) {
  let buffer = '';
  const pending = [];
  const resolvers = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      if (resolvers.length > 0) resolvers.shift()(line);
      else pending.push(line);
    }
  });
  return function nextLine(timeoutMs = 5000) {
    if (pending.length > 0) return Promise.resolve(pending.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a line from the MCP server')), timeoutMs);
      resolvers.push((line) => { clearTimeout(timer); resolve(line); });
    });
  };
}

function send(child, obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

async function initializeAndListTools(child, nextLine) {
  send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const initLine = JSON.parse(await nextLine());
  assert.equal(initLine.id, 1);
  assert.equal(initLine.result.serverInfo.name, 'claude-cli-mcp');

  send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

  send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listLine = JSON.parse(await nextLine());
  assert.equal(listLine.id, 2);
  assert.equal(listLine.result.tools.length, 1);
  assert.equal(listLine.result.tools[0].name, 'claude');
}

async function callClaude(child, nextLine, argsObj) {
  send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'claude', arguments: argsObj } });
  const line1 = JSON.parse(await nextLine());
  if (line1.id === 3) return line1;
  const line2 = JSON.parse(await nextLine());
  return line2.id === 3 ? line2 : line1;
}

test('tools/call claude (fake CLI launched directly as a .js file) returns text, mapped usage/model_usage, and passes the right flags + stdin prompt', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  // Point CLAUDE_CLI_BIN straight at the .js — it has no .cmd/.bat
  // extension, so resolveSpawnTarget spawns it directly (as if it were a
  // native binary); Node run it as `process.execPath <jsEntry>` only via
  // the shim path, so here it must be executable on its own account for
  // non-Windows. On Windows a bare .mjs isn't directly spawnable either, so
  // route CLAUDE_CLI_BIN through node explicitly using a tiny wrapper.
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child, getStderr } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);

    const callLine = await callClaude(child, nextLine, { prompt: 'Reply with the single word OK.', model: 'claude-haiku-4-5', max_turns: 1 });

    assert.equal(callLine.result.isError, false, `expected no error, got: ${JSON.stringify(callLine.result)}`);
    assert.equal(callLine.result.content[0].type, 'text');
    assert.ok(callLine.result.content[0].text.endsWith('OK'), callLine.result.content[0].text);

    const sc = callLine.result.structuredContent;
    assert.deepEqual(sc.usage, { input_tokens: 10, output_tokens: 51, cache_read_tokens: 21526, cache_creation_tokens: 6301 });
    assert.equal(sc.cost_usd, 0.0159636);
    assert.equal(sc.session_id, 'fixture-session-id');
    assert.equal(sc.num_turns, 1);
    assert.equal(sc.is_error, false);
    assert.ok(sc.model_usage['anthropic/claude-haiku-4-5'], 'expected model_usage keyed anthropic/claude-haiku-4-5');
    assert.equal(sc.model_usage['anthropic/claude-haiku-4-5'].inputTokens, 919);
    assert.equal(sc.model_usage['anthropic/claude-haiku-4-5'].outputTokens, 111);

    const argv = JSON.parse(fs.readFileSync(argvLogPath, 'utf8'));
    assert.ok(argv.includes('-p'), 'expected -p');
    assert.ok(!argv.includes('Reply with the single word OK.'), 'the prompt must NEVER appear as an argv element');
    assert.ok(argv.includes('--output-format') && argv.includes('json'), 'expected --output-format json');
    assert.ok(argv.includes('--model') && argv.includes('claude-haiku-4-5'), 'expected --model claude-haiku-4-5');
    assert.ok(argv.includes('--max-turns') && argv.includes('1'), 'expected --max-turns 1');
    assert.ok(argv.includes('--permission-mode') && argv.includes('plan'), 'expected --permission-mode plan (default)');

    const stdinText = fs.readFileSync(stdinLogPath, 'utf8');
    assert.equal(stdinText, 'Reply with the single word OK.', 'the prompt must be delivered verbatim over stdin');

    assert.equal(getStderr(), '', 'server must not write anything to stderr on a clean run');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tools/call claude (fake CLI resolved via an npm-shim-shaped .cmd) resolves the .js entry and spawns it directly, no shell', { skip: process.platform !== 'win32' ? false : false }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-shim-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const cmdShim = writeFakeClaudeCmdShim(tmpDir, jsEntry);

  const { child, getStderr } = spawnMcpServer({ CLAUDE_CLI_BIN: cmdShim });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);

    const callLine = await callClaude(child, nextLine, { prompt: 'hello via shim' });

    if (process.platform === 'win32') {
      assert.equal(callLine.result.isError, false, `expected shim resolution to succeed, got: ${JSON.stringify(callLine.result)}`);
      assert.ok(callLine.result.content[0].text.endsWith('OK'), callLine.result.content[0].text);
      const stdinText = fs.readFileSync(stdinLogPath, 'utf8');
      assert.equal(stdinText, 'hello via shim');
    } else {
      // Off Windows, a .cmd is not treated as a shim at all — resolveSpawnTarget
      // spawns it as a plain (non-executable-as-a-script) binary, which fails
      // to exec; that failure must still be isError, never a shell fallback.
      assert.equal(callLine.result.isError, true);
    }

    assert.equal(getStderr(), '', 'server must not write anything to stderr on a clean run');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SECURITY: a prompt containing shell metacharacters is delivered verbatim over stdin, never interpreted by a shell', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-injection-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const markerPath = path.join(tmpDir, 'INJECTED');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const injectionPrompt = `" & echo INJECTED > "${markerPath}" & "`;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: injectionPrompt });
    assert.equal(callLine.result.isError, false, `expected no error, got: ${JSON.stringify(callLine.result)}`);

    const stdinText = fs.readFileSync(stdinLogPath, 'utf8');
    assert.equal(stdinText, injectionPrompt, 'the fake CLI must receive the prompt verbatim on stdin');
    assert.equal(fs.existsSync(markerPath), false, 'no INJECTED marker file must ever be created — the prompt must never reach a shell');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a hanging CLI process times out via CLAUDE_CLI_TIMEOUT_MS and reports isError naming the variable', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-hang-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath, { hang: true });
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin, CLAUDE_CLI_TIMEOUT_MS: '500' });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: 'hello' });
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /CLAUDE_CLI_TIMEOUT_MS/);
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a missing claude binary reports isError listing tried paths and naming CLAUDE_CLI_BIN', async () => {
  const env = { ...process.env, CLAUDE_CLI_BIN: 'nonexistent-claude-binary-xyz', PATH: '', Path: '' };
  const child = spawn(process.execPath, [HOOK_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: 'hello' });
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /nonexistent-claude-binary-xyz/);
  } finally {
    child.kill();
  }
});

test('missing prompt argument returns isError, no CLI spawned', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-noprompt-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, {});
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /prompt/);
    assert.equal(fs.existsSync(argvLogPath), false, 'CLI should never have been spawned');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validation: an invalid model is rejected before spawning', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-badmodel-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: 'hello', model: 'sonnet; rm -rf /' });
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /Invalid model/);
    assert.equal(fs.existsSync(argvLogPath), false, 'CLI should never have been spawned');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validation: an invalid allowed_tools entry is rejected before spawning', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-badtools-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: 'hello', allowed_tools: ['Bash(git *) & echo pwned'] });
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /Invalid allowed_tools entry/);
    assert.equal(fs.existsSync(argvLogPath), false, 'CLI should never have been spawned');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validation: system with a control character is rejected before spawning', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-badsystem-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: 'hello', system: 'bad\x01system' });
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /Invalid system/);
    assert.equal(fs.existsSync(argvLogPath), false, 'CLI should never have been spawned');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validation: a nonexistent cwd is rejected before spawning', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-test-badcwd-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;

  const { child } = spawnMcpServer({ CLAUDE_CLI_BIN: bin });
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    const callLine = await callClaude(child, nextLine, { prompt: 'hello', cwd: path.join(tmpDir, 'does-not-exist') });
    assert.equal(callLine.result.isError, true);
    assert.match(callLine.result.content[0].text, /Invalid cwd/);
    assert.equal(fs.existsSync(argvLogPath), false, 'CLI should never have been spawned');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function permissionModeArgv(envMode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-mcp-perm-'));
  const argvLogPath = path.join(tmpDir, 'argv.json');
  const stdinLogPath = path.join(tmpDir, 'stdin.txt');
  const jsEntry = writeFakeClaudeJs(tmpDir, FIXTURE_RESULT, argvLogPath, stdinLogPath);
  const bin = process.platform === 'win32'
    ? (() => {
        const cmdPath = path.join(tmpDir, 'direct-node.cmd');
        fs.writeFileSync(cmdPath, `@ECHO off\r\nnode "${jsEntry}" %*\r\n`);
        return cmdPath;
      })()
    : jsEntry;
  const env = { CLAUDE_CLI_BIN: bin };
  if (envMode === undefined) delete process.env.CLAUDE_CLI_PERMISSION_MODE;
  else env.CLAUDE_CLI_PERMISSION_MODE = envMode;
  const { child } = spawnMcpServer(env);
  const nextLine = makeLineReader(child);
  try {
    await initializeAndListTools(child, nextLine);
    await callClaude(child, nextLine, { prompt: 'hi', model: 'claude-haiku-4-5', max_turns: 1 });
    return JSON.parse(fs.readFileSync(argvLogPath, 'utf8'));
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('CLAUDE_CLI_PERMISSION_MODE: bypassPermissions, dontAsk and unknown values fall back to plan; no skip-permissions flag ever', async () => {
  for (const bad of ['bypassPermissions', 'dontAsk', 'nonsense', '--dangerously-skip-permissions']) {
    const argv = await permissionModeArgv(bad);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan', bad);
    assert.ok(!argv.some((a) => /dangerously-skip-permissions|bypassPermissions|dontAsk/.test(a)), bad);
  }
});

test('CLAUDE_CLI_PERMISSION_MODE: acceptEdits is honored as an explicit operator opt-in', async () => {
  const argv = await permissionModeArgv('acceptEdits');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('CLAUDE_CLI_PERMISSION_MODE: plan and default are honored', async () => {
  for (const ok of ['plan', 'default']) {
    const argv = await permissionModeArgv(ok);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], ok);
  }
});
