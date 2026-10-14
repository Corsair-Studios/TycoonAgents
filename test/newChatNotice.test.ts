import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentFilesAdded, agentsDirExists, claudeSetupNotice, listAgentFiles, newChatNoticeText } from "../src/host/vscode/newChatNotice";

const PANEL_SRC = fs.readFileSync(path.join(process.cwd(), "src", "host", "vscode", "panel.ts"), "utf8");

test("notice fires after first-run setup writes agent files, not on a no-op re-run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newchat-"));
  try {
    const before = listAgentFiles(root);
    fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "agents", "search-retrieval.md"), "x");
    const afterFirst = listAgentFiles(root);
    assert.equal(agentFilesAdded(before, afterFirst), true);
    // Second run: files already present, nothing new written.
    assert.equal(agentFilesAdded(afterFirst, listAgentFiles(root)), false);
    // Rewriting an existing file is not a new file.
    fs.writeFileSync(path.join(root, ".claude", "agents", "search-retrieval.md"), "y");
    assert.equal(agentFilesAdded(afterFirst, listAgentFiles(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("case A: a newly created agents directory asks for a window reload with a button", () => {
  const n = claudeSetupNotice(false, [], ["a.md"]);
  assert.ok(n);
  assert.equal(n.kind, "reload");
  assert.equal(n.message, "TycoonAgents is set up. Reload the window so Claude Code loads your new agents.");
  assert.equal(n.button, "Reload Window");
  assert.equal(n.command, "workbench.action.reloadWindow");
  assert.equal(n.statusLine, "Reload the window (Developer: Reload Window) to load your agents.");
});

test("case B: new files in an existing agents directory get the lighter new-chat message, no button", () => {
  const n = claudeSetupNotice(true, ["a.md"], ["a.md", "b.md"]);
  assert.ok(n);
  assert.equal(n.kind, "new-chat");
  assert.equal(n.message, "New agents added. Start a new Claude chat to use them.");
  assert.equal(n.button, undefined);
  assert.equal(n.command, undefined);
});

test("no-op re-run and heals stay silent", () => {
  assert.equal(claudeSetupNotice(true, ["a.md"], ["a.md"]), undefined);
  assert.equal(claudeSetupNotice(false, [], []), undefined);
});

test("agentsDirExists reflects the real directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newchat-dir-"));
  try {
    assert.equal(agentsDirExists(root), false);
    fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    assert.equal(agentsDirExists(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("notice text names the right harness", () => {
  assert.match(newChatNoticeText("codex"), /Start a new Codex session/);
});

test("panel shows the notice only from the install handler, gated on a new agent file", () => {
  assert.match(PANEL_SRC, /claudeSetupNotice\(agentsDirExistedBefore, agentFilesBefore, listAgentFiles\(root\)\)/);
  assert.match(PANEL_SRC, /if \(setupNotice\) \{/);
  assert.match(PANEL_SRC, /executeCommand\(command\)/);
  assert.equal(PANEL_SRC.split("claudeSetupNotice(").length - 1, 1, "only the install handler uses the Claude notice");
  assert.equal(PANEL_SRC.split("newChatNoticeText(").length - 1, 1, "only the Codex path uses the legacy notice text");
  const heal = PANEL_SRC.slice(PANEL_SRC.indexOf("private _ensureWorkerAgentsInstalled"), PANEL_SRC.indexOf("private _ensureWorkerAgentsInstalled") + 2500);
  assert.doesNotMatch(heal, /newChatNotice/);
});
