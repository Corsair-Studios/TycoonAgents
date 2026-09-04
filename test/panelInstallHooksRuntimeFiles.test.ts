/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Regression coverage: `_handleInstallHooks` (src/host/vscode/panel.ts,
 * ~5687-5756) must copy hooks/fallbackChain.js into `.claude/tycoon/`
 * alongside agentBackend.js/modelAliases.js/delegationEnforcement.js.
 * tycoon-claude-hook.cjs's PostToolUse/Task fallback branch lazy-requires
 * `./fallbackChain.js` relative to the copied hook, so a VS Code install
 * missing this file left that branch permanently no-op (fails open, never
 * throws, so the gap was silent). `_handleInstallHooks` itself can't be
 * invoked headlessly without a real vscode.WebviewPanel (see
 * test/panelLegacyArtifactsNotice.test.ts's note on that), so this is a
 * source-scan assertion rather than a behavioral one — it fails loudly if
 * the fallbackChain.js copy block is ever removed or left unpaired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PANEL_SRC = fs.readFileSync(
  path.join(process.cwd(), "src", "host", "vscode", "panel.ts"),
  "utf8",
);

test("_handleInstallHooks resolves fallbackChain.js as a runtime file to copy", () => {
  assert.match(
    PANEL_SRC,
    /resolveRuntimeFile\(\s*["']fallbackChain\.js["']\s*\)/,
    "panel.ts must call resolveRuntimeFile(\"fallbackChain.js\") — it is lazy-required " +
      "at runtime by tycoon-claude-hook.cjs's PostToolUse/Task fallback branch",
  );
});

test("_handleInstallHooks copies fallbackChain.js into tycoonDir", () => {
  assert.match(
    PANEL_SRC,
    /copyFileSync\(\s*fallbackChainSrc\s*,\s*path\.join\(tycoonDir,\s*["']fallbackChain\.js["']\)\s*\)/,
    "fallbackChain.js source, once resolved, must be copied into .claude/tycoon/",
  );
});

test("fallbackChain.js copy sits alongside delegationEnforcement.js's copy (same install step)", () => {
  const delegationIdx = PANEL_SRC.indexOf('"delegationEnforcement.js"');
  const fallbackIdx = PANEL_SRC.indexOf('"fallbackChain.js"');
  assert.ok(delegationIdx !== -1, "delegationEnforcement.js reference must exist");
  assert.ok(fallbackIdx !== -1, "fallbackChain.js reference must exist");
  // Both belong to the same best-effort runtime-file copy block in
  // _handleInstallHooks — they should be within a few hundred characters of
  // each other, not scattered across unrelated parts of the file.
  assert.ok(
    Math.abs(fallbackIdx - delegationIdx) < 1500,
    "fallbackChain.js copy should live in the same block as delegationEnforcement.js's copy",
  );
});
