/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Regression: the panel-open heal rendered the CLAUDE.md "Specialist roster"
// BEFORE the keyword migration rewrote agent-keywords.json, leaving the roster
// one panel-open behind. _healKeywordsThenDoctrine orders them correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doctrineRosterOrdering-"));
}

test("one heal pass moves keyword file AND CLAUDE.md roster to the new uefn-auditor keywords", () => {
  const root = tmpRoot();
  const claudeDir = path.join(root, ".claude");
  fs.mkdirSync(path.join(claudeDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "tycoon"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.local.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "tycoon-claude-hook.cjs" }] }] } })
  );
  const OLD = "verse|uefn|fortnite|verse-audit|verse-review|verse-lint";
  const NEW = "auditor|lint|deprecation|deprecated|compliance";
  fs.writeFileSync(
    path.join(claudeDir, "agents", "uefn-auditor.md"),
    `---
name: uefn-auditor
description: audits verse
---
# Auditor

## Keywords (for task routing)
${OLD}
`
  );
  fs.writeFileSync(
    path.join(claudeDir, "tycoon", "agent-keywords.json"),
    JSON.stringify({ agents: { "uefn-auditor": { pattern: OLD } } }, null, 2)
  );

  const P = TycoonPanel.prototype as any;
  const fakeThis: any = { _projectRoot: () => root };
  for (const m of [
    "_hooksInstalledForRoot",
    "_settingsReferencesHook",
    "_readKeywordsConfig",
    "_ensureAgentKeywordsSeeded",
    "_ensureDelegationDoctrineCurrent",
    "_buildClaudeMdDoctrine",
    "_buildDoctrineRoster",
    "_resolveReviewAgentId",
    "_healKeywordsThenDoctrine",
  ]) {
    fakeThis[m] = P[m];
  }
  // Pre-seed CLAUDE.md with a roster row showing the old keywords.
  fakeThis._ensureDelegationDoctrineCurrent();
  const before = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(before.includes(OLD.split("|").join(", ")), "precondition: roster shows old keywords");

  fakeThis._healKeywordsThenDoctrine();

  const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, "tycoon", "agent-keywords.json"), "utf8"));
  assert.equal(cfg.agents["uefn-auditor"].pattern, NEW);
  const after = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(after.includes(NEW.split("|").join(", ")), "roster shows new keywords in the same pass");
  assert.ok(!after.includes(OLD.split("|").join(", ")), "old keywords gone from roster");
});
