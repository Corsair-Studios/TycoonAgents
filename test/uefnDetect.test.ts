/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { detectUefnProject } from "../src/host/vscode/uefnDetect";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uefn-detect-test-"));
}

test("verse file in root -> detected true, signals includes verse-files", () => {
  const tmp = makeTmp();
  try {
    fs.writeFileSync(path.join(tmp, "foo.verse"), "");
    const result = detectUefnProject(tmp);
    assert.equal(result.detected, true);
    assert.ok(result.signals.includes("verse-files"), "expected verse-files signal");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("uproject file in root -> detected true, signals includes uproject", () => {
  const tmp = makeTmp();
  try {
    fs.writeFileSync(path.join(tmp, "My.uproject"), "{}");
    const result = detectUefnProject(tmp);
    assert.equal(result.detected, true);
    assert.ok(result.signals.includes("uproject"), "expected uproject signal");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Content/Verse dir -> detected true, signals includes content-verse", () => {
  const tmp = makeTmp();
  try {
    fs.mkdirSync(path.join(tmp, "Content", "Verse"), { recursive: true });
    const result = detectUefnProject(tmp);
    assert.equal(result.detected, true);
    assert.ok(result.signals.includes("content-verse"), "expected content-verse signal");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("empty dir -> detected false, signals empty", () => {
  const tmp = makeTmp();
  try {
    const result = detectUefnProject(tmp);
    assert.equal(result.detected, false);
    assert.deepEqual(result.signals, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
