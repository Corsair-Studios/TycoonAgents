import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentFilesAdded, listAgentFiles, newChatNoticeText } from "../src/host/vscode/newChatNotice";

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

test("notice text names the right harness", () => {
  assert.match(newChatNoticeText("claude-code"), /Start a new Claude chat/);
  assert.match(newChatNoticeText("codex"), /Start a new Codex session/);
});

test("panel shows the notice only from the install handler, gated on a new agent file", () => {
  assert.match(PANEL_SRC, /agentFilesAdded\(agentFilesBefore, listAgentFiles\(root\)\)/);
  assert.match(PANEL_SRC, /if \(newChatNeeded\) \{\s*void vscode\.window\.showInformationMessage\(newChatNoticeText\("claude-code"\)\)/);
  assert.equal(PANEL_SRC.split("newChatNoticeText(").length - 1, 2 + 0, "only the install handler (Claude + Codex) uses the notice");
  const heal = PANEL_SRC.slice(PANEL_SRC.indexOf("private _ensureWorkerAgentsInstalled"), PANEL_SRC.indexOf("private _ensureWorkerAgentsInstalled") + 2500);
  assert.doesNotMatch(heal, /newChatNotice/);
});
