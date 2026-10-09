/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests the project-side Codex uninstall leftovers: the AGENTS.md managed
// block, orphaned Codex-only hook copies, and stray mcp_servers.tycoon tables.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  removeCodexManagedAgentsBlock,
  removeOrphanCodexHookCopies,
  stripCodexBlock,
} from "../src/providers/codex/uninstallCodexExtras";
import { uninstallCodexHooks } from "../src/providers/codex/installCodexHooks";
import {
  buildDispatcherBlock,
  removeDispatcherFromConfigToml,
  uninstallCodexDispatcher,
} from "../src/providers/codex/installCodexDispatcher";

const START = "<!-- TYCOON-CODEX-MANAGED:START -->";
const END = "<!-- TYCOON-CODEX-MANAGED:END -->";
const BLOCK = `${START}\nCodex doctrine\n${END}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tycoon-uninstall-extras-"));
}

test("AGENTS.md: block appended behind user text is removed, user text is byte-identical", () => {
  assert.equal(stripCodexBlock(`# Mine\n\nrules\n\n${BLOCK}\n`), "# Mine\n\nrules\n");
  assert.equal(stripCodexBlock(`# Mine\n\n${BLOCK}\n\nmore user text\n`), "# Mine\n\nmore user text\n");
  assert.equal(stripCodexBlock("# Mine\nno block\n"), "# Mine\nno block\n");
});

test("AGENTS.md: other managed blocks are untouched, CRLF is kept", () => {
  const open = "<!-- TYCOON-OPENCODE-MANAGED:START -->\nx\n<!-- TYCOON-OPENCODE-MANAGED:END -->";
  assert.equal(stripCodexBlock(`${open}\n\n${BLOCK}\n`), `${open}\n`);
  assert.equal(stripCodexBlock(`a\r\n\r\n${BLOCK}\r\n`), "a\r\n");
});

test("AGENTS.md: a file holding only our block is deleted; one with user text is rewritten", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "AGENTS.md"), `${BLOCK}\n`, "utf8");
    assert.deepEqual(removeCodexManagedAgentsBlock(dir), { removed: true, deleted: true });
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);

    writeFileSync(join(dir, "AGENTS.md"), `user\n\n${BLOCK}\n`, "utf8");
    assert.deepEqual(removeCodexManagedAgentsBlock(dir), { removed: true, deleted: false });
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "user\n");
    assert.deepEqual(removeCodexManagedAgentsBlock(dir), { removed: false, deleted: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function hooksFixture(): { dir: string; hooks: string } {
  const dir = tmp();
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  return { dir, hooks };
}

const OURS = '/*\n * TycoonAgents - https://x.com/thetrashbyrd\n */\nmodule.exports = {};\n';

test("hook copies: ours are removed, a user file with a Codex name and a user-authored file stay", () => {
  const { dir, hooks } = hooksFixture();
  try {
    writeFileSync(join(hooks, "codexRollout.cjs"), OURS, "utf8");
    writeFileSync(join(hooks, "codexRouting.cjs"), "// user wrote this\n", "utf8");
    writeFileSync(join(hooks, "codex-mcp-launcher.cjs"), "// shipped copy without header\n", "utf8");
    writeFileSync(join(hooks, "my-own-hook.cjs"), OURS, "utf8");
    const removed = removeOrphanCodexHookCopies({
      projectDir: dir,
      resolveSource: (f) => (f === "codex-mcp-launcher.cjs" ? join(dir, "shipped-launcher.cjs") : undefined),
    });
    assert.deepEqual(removed, ["codexRollout.cjs"]);
    writeFileSync(join(dir, "shipped-launcher.cjs"), "// shipped copy without header\n", "utf8");
    assert.deepEqual(
      removeOrphanCodexHookCopies({ projectDir: dir, resolveSource: (f) => join(dir, "shipped-launcher.cjs") }),
      ["codex-mcp-launcher.cjs"],
    );
    assert.ok(existsSync(join(hooks, "codexRouting.cjs")));
    assert.ok(existsSync(join(hooks, "my-own-hook.cjs")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook copies: files a remaining .mcp.json server still needs are kept", () => {
  const { dir, hooks } = hooksFixture();
  try {
    for (const f of ["codexRollout.cjs", "codexRouting.cjs", "codex-mcp-launcher.cjs", "codex-app-server-mcp.cjs"]) {
      writeFileSync(join(hooks, f), OURS, "utf8");
    }
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { reviewer: { command: "node", args: [".claude/hooks/codex-app-server-mcp.cjs"] } } }),
      "utf8",
    );
    const removed = removeOrphanCodexHookCopies({ projectDir: dir });
    // The reviewer bridge needs codex-app-server-mcp.cjs and, transitively, codex-mcp-launcher.cjs.
    assert.deepEqual(removed.sort(), ["codexRollout.cjs", "codexRouting.cjs"]);
    assert.ok(existsSync(join(hooks, "codex-app-server-mcp.cjs")) && existsSync(join(hooks, "codex-mcp-launcher.cjs")));

    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { tycoon: { command: "node", args: [".claude/hooks/tycoon-dispatcher-mcp.cjs"] } } }),
      "utf8",
    );
    writeFileSync(join(hooks, "codexRollout.cjs"), OURS, "utf8");
    assert.deepEqual(removeOrphanCodexHookCopies({ projectDir: dir }).includes("codexRollout.cjs"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstallCodexHooks cleans AGENTS.md and orphan hook copies together; a harness switch alone calls none of this", () => {
  const { dir, hooks } = hooksFixture();
  const home = tmp();
  try {
    writeFileSync(join(hooks, "codexRollout.cjs"), OURS, "utf8");
    writeFileSync(join(dir, "AGENTS.md"), `user\n\n${BLOCK}\n`, "utf8");
    uninstallCodexHooks({ projectDir: dir, env: { CODEX_HOME: home } });
    assert.equal(existsSync(join(hooks, "codexRollout.cjs")), false);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "user\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

const S = "# tycoon-dispatcher: managed mcp server (do not edit by hand)";
const E = "# tycoon-dispatcher: end managed mcp server";

test("dispatcher uninstall: a tools.delegate table Codex moved outside the markers is removed with the rest of the namespace", () => {
  const text = [
    'model = "x"',
    "",
    S,
    "[mcp_servers.tycoon]",
    'command = "node"',
    E,
    "",
    "[mcp_servers.blender]",
    'command = "b"',
    "",
    "[mcp_servers.tycoon.tools.delegate]",
    'approval_mode = "approve"',
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
  ].join("\n");
  const out = removeDispatcherFromConfigToml(text);
  assert.ok(!out.includes("mcp_servers.tycoon") && !out.includes("approval_mode"));
  assert.equal(out, 'model = "x"\n\n[mcp_servers.blender]\ncommand = "b"\n\n[windows]\nsandbox = "elevated"\n');
});

test("dispatcher uninstall: stray tools.* alone are removed; a user's own main table is left alone", () => {
  const stray = '[mcp_servers.tycoon.tools.delegate]\napproval_mode = "approve"\n\n[other]\na = 1\n';
  assert.equal(removeDispatcherFromConfigToml(stray), "[other]\na = 1\n");
  const mine = '[mcp_servers.tycoon]\ncommand = "mine"\n';
  assert.equal(removeDispatcherFromConfigToml(mine), mine);
  const ours = '[mcp_servers.tycoon]\ncommand = "node"\nargs = ["/x/tycoon-dispatcher-mcp.cjs"]\n\n[other]\na = 1\n';
  assert.equal(removeDispatcherFromConfigToml(ours), "[other]\na = 1\n");
});

test("dispatcher uninstall on disk: install block then stray tools table, all gone, same reference when nothing to do", () => {
  const home = tmp();
  try {
    const block = buildDispatcherBlock({ nodePath: "node", serverScriptPath: "/p/tycoon-dispatcher-mcp.cjs" });
    writeFileSync(join(home, "config.toml"), `a = 1\n\n${block}\n\n[mcp_servers.tycoon.tools.delegate]\napproval_mode = "approve"\n`, "utf8");
    uninstallCodexDispatcher({ env: { CODEX_HOME: home } });
    assert.equal(readFileSync(join(home, "config.toml"), "utf8"), "a = 1\n");
    const plain = "a = 1\n";
    assert.equal(removeDispatcherFromConfigToml(plain), plain);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook copies: absolute and ${CLAUDE_PROJECT_DIR} references keep the files they need", () => {
  const { dir, hooks } = hooksFixture();
  try {
    const put = (): void => {
      for (const f of ["codexRollout.cjs", "codexRouting.cjs", "codex-mcp-launcher.cjs", "codex-app-server-mcp.cjs"]) {
        writeFileSync(join(hooks, f), OURS, "utf8");
      }
    };
    put();
    const abs = join(dir, ".claude", "hooks", "tycoon-dispatcher-mcp.cjs");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tycoon: { command: "node", args: [abs] } } }), "utf8");
    assert.deepEqual(removeOrphanCodexHookCopies({ projectDir: dir }).sort(), ["codex-app-server-mcp.cjs", "codex-mcp-launcher.cjs"]);

    put();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { tycoon: { command: "node", args: ["${CLAUDE_PROJECT_DIR}\\.claude\\hooks\\tycoon-dispatcher-mcp.cjs"] } } }),
      "utf8",
    );
    assert.deepEqual(removeOrphanCodexHookCopies({ projectDir: dir }).sort(), ["codex-app-server-mcp.cjs", "codex-mcp-launcher.cjs"]);
    assert.ok(existsSync(join(hooks, "codexRollout.cjs")) && existsSync(join(hooks, "codexRouting.cjs")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook copies: codexRollout/codexRouting stay while the dispatcher copy is in .claude/hooks, even with no .mcp.json entry", () => {
  const { dir, hooks } = hooksFixture();
  try {
    for (const f of ["codexRollout.cjs", "codexRouting.cjs", "tycoon-dispatcher-mcp.cjs"]) writeFileSync(join(hooks, f), OURS, "utf8");
    assert.deepEqual(removeOrphanCodexHookCopies({ projectDir: dir }), []);
    rmSync(join(hooks, "tycoon-dispatcher-mcp.cjs"));
    assert.deepEqual(removeOrphanCodexHookCopies({ projectDir: dir }).sort(), ["codexRollout.cjs", "codexRouting.cjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
