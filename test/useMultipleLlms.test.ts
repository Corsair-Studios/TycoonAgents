/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for plan task p18-t3: readUseMultipleLlms/writeUseMultipleLlms
// added to src/core/providerSelection.ts, persisting the `useMultipleLlms`
// key in <root>/.claude/tycoon/execution.json alongside the existing
// `provider` key (never clobbering it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUseMultipleLlms, writeUseMultipleLlms } from "../src/core/providerSelection";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "use-multiple-llms-"));
}

function execJsonPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "execution.json");
}

test("readUseMultipleLlms: defaults to false when execution.json is missing", () => {
  const root = tmpRoot();
  assert.equal(readUseMultipleLlms(root), false);
});

test("readUseMultipleLlms: defaults to false when the key is absent", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(execJsonPath(root), JSON.stringify({ provider: "opencode" }), "utf8");
  assert.equal(readUseMultipleLlms(root), false);
});

test("writeUseMultipleLlms: persists true and preserves the existing provider key", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(execJsonPath(root), JSON.stringify({ provider: "opencode" }), "utf8");

  writeUseMultipleLlms(root, true);

  const written = JSON.parse(fs.readFileSync(execJsonPath(root), "utf8"));
  assert.equal(written.useMultipleLlms, true);
  assert.equal(written.provider, "opencode");
  assert.equal(readUseMultipleLlms(root), true);
});

test("writeUseMultipleLlms: round trip true -> false, provider key still preserved", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "tycoon"), { recursive: true });
  fs.writeFileSync(execJsonPath(root), JSON.stringify({ provider: "claude-code" }), "utf8");

  writeUseMultipleLlms(root, true);
  assert.equal(readUseMultipleLlms(root), true);

  writeUseMultipleLlms(root, false);
  const written = JSON.parse(fs.readFileSync(execJsonPath(root), "utf8"));
  assert.equal(written.useMultipleLlms, false);
  assert.equal(written.provider, "claude-code");
  assert.equal(readUseMultipleLlms(root), false);
});

test("writeUseMultipleLlms: creates execution.json when none exists yet", () => {
  const root = tmpRoot();
  assert.equal(fs.existsSync(execJsonPath(root)), false);

  writeUseMultipleLlms(root, true);

  assert.equal(fs.existsSync(execJsonPath(root)), true);
  const written = JSON.parse(fs.readFileSync(execJsonPath(root), "utf8"));
  assert.equal(written.useMultipleLlms, true);
});
