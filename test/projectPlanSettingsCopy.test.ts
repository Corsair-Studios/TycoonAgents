import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const src = fs.readFileSync(path.join(REPO_ROOT, "media", "src", "main", "100-slot-editor-settings.js"), "utf8");

test("Settings Project Plan label drops 'experimental' and hint drops 'Off by default'", () => {
  assert.ok(src.includes('planTitle.textContent = "Project Plan (optional)"'));
  assert.ok(!/Project Plan \(optional, experimental\)/.test(src));
  assert.ok(src.includes("On by default"));
  assert.ok(!src.includes("Opt-in phase/task planning workflow"));
});

test("Settings Project Plan section has no Reinstall / Repair button (auto-heal covers missing/damaged files)", () => {
  assert.ok(!src.includes("Reinstall / Repair skill"));
  assert.ok(!src.includes("projectPlanAction"));
});

test("OpenCode and Codex harness labels stay Experimental", () => {
  assert.ok(src.includes('label: "OpenCode (Experimental)"'));
  assert.ok(src.includes('label: "Codex (Experimental)"'));
});
