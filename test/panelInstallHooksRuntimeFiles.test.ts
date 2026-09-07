/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Regression coverage: `_handleInstallHooks` (src/host/vscode/panel.ts,
 * ~5793-5875) refreshes fallbackChain.js/agentBackend.js/modelAliases.js/
 * delegationEnforcement.js/tycoon-claude-hook.cjs in `.claude/tycoon/` via
 * `syncRuntimeFile` (src/host/vscode/hookInstall.ts), driven off the shared
 * `RUNTIME_HOOK_FILES` list. tycoon-claude-hook.cjs's PostToolUse/Task
 * fallback branch lazy-requires `./fallbackChain.js` relative to the copied
 * hook, so a VS Code install missing this file left that branch permanently
 * no-op (fails open, never throws, so the gap was silent). `_handleInstallHooks`
 * itself can't be invoked headlessly without a real vscode.WebviewPanel (see
 * test/panelLegacyArtifactsNotice.test.ts's note on that), so this is a
 * source-scan assertion rather than a behavioral one — it fails loudly if
 * the fallbackChain.js sync is ever removed or left unpaired from the rest
 * of RUNTIME_HOOK_FILES.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { RUNTIME_HOOK_FILES } from "../src/host/vscode/hookInstall";

const PANEL_SRC = fs.readFileSync(
  path.join(process.cwd(), "src", "host", "vscode", "panel.ts"),
  "utf8",
);

test("RUNTIME_HOOK_FILES lists every runtime file that must land in .claude/tycoon", () => {
  const expected = [
    "tycoon-claude-hook.cjs",
    "agentBackend.js",
    "modelAliases.js",
    "delegationEnforcement.js",
    "fallbackChain.js",
  ];
  for (const fileName of expected) {
    assert.ok(
      RUNTIME_HOOK_FILES.includes(fileName),
      `RUNTIME_HOOK_FILES must include "${fileName}"`,
    );
  }
});

test("_handleInstallHooks resolves fallbackChain.js as a runtime file to copy", () => {
  assert.match(
    PANEL_SRC,
    /resolveRuntimeFile\(\s*["']fallbackChain\.js["']\s*\)/,
    "panel.ts must call resolveRuntimeFile(\"fallbackChain.js\") — it is lazy-required " +
      "at runtime by tycoon-claude-hook.cjs's PostToolUse/Task fallback branch",
  );
});

test("_handleInstallHooks syncs fallbackChain.js into tycoonDir via syncRuntimeFile", () => {
  assert.match(
    PANEL_SRC,
    /syncCompanion\(\s*fallbackChainSrc\s*,\s*["']fallbackChain\.js["']\s*\)/,
    "fallbackChainSrc, once resolved, must be synced into .claude/tycoon/ via syncCompanion/syncRuntimeFile",
  );
});

test("fallbackChain.js sync sits alongside delegationEnforcement.js's sync (same install step)", () => {
  const delegationIdx = PANEL_SRC.indexOf('"delegationEnforcement.js"');
  const fallbackIdx = PANEL_SRC.indexOf('"fallbackChain.js"');
  assert.ok(delegationIdx !== -1, "delegationEnforcement.js reference must exist");
  assert.ok(fallbackIdx !== -1, "fallbackChain.js reference must exist");
  // Both belong to the same best-effort runtime-file sync block in
  // _handleInstallHooks — they should be within a few hundred characters of
  // each other, not scattered across unrelated parts of the file.
  assert.ok(
    Math.abs(fallbackIdx - delegationIdx) < 1500,
    "fallbackChain.js sync should live in the same block as delegationEnforcement.js's sync",
  );
});
