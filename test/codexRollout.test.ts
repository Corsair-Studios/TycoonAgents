/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Plan p30-t2: hooks/codexRollout.cjs's findRolloutFile must search both
// CODEX_HOME/sessions and CODEX_HOME/archived_sessions (app-server threads
// archive their rollout under the latter, per docs/codex-harness-findings.md
// ~line 393+). Exercises findRolloutFile directly against isolated temp
// CODEX_HOME trees built per test (no injected env dependency on the real
// machine's home directory).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const codexRollout = require("../../hooks/codexRollout.cjs") as {
  findRolloutFile: (threadId: string, codexHome: string | null, env?: NodeJS.ProcessEnv) => string | null;
};

function makeCodexHome(): string {
  return mkdtempSync(join(tmpdir(), "codex-rollout-test-"));
}

function writeRollout(root: string, datePart: string, fileName: string, mtime: Date): string {
  const dir = join(root, datePart);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, fileName);
  writeFileSync(full, "");
  utimesSync(full, mtime, mtime);
  return full;
}

test("findRolloutFile: fixture rollout only in archived_sessions is found", () => {
  const home = makeCodexHome();
  try {
    const archivedDir = join(home, "archived_sessions");
    const expected = writeRollout(
      archivedDir,
      "2026/09/10",
      "2026-09-10T10-00-00-thread-abc.jsonl",
      new Date("2026-09-10T10:00:00Z"),
    );

    const found = codexRollout.findRolloutFile("thread-abc", home);
    assert.equal(found, expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("findRolloutFile: newest by mtime wins regardless of root", () => {
  const home = makeCodexHome();
  try {
    const sessionsDir = join(home, "sessions");
    const archivedDir = join(home, "archived_sessions");

    // Filename in sessions/ sorts lexicographically later than the
    // archived_sessions candidate, but its mtime is OLDER — mtime, not
    // filename, must decide across roots.
    const sessionsFile = writeRollout(
      sessionsDir,
      "2026/09/10",
      "2026-09-10T09-00-00-thread-xyz.jsonl",
      new Date("2026-09-10T09:00:00Z"),
    );
    const archivedFile = writeRollout(
      archivedDir,
      "2026/09/10",
      "2026-09-10T08-00-00-thread-xyz.jsonl",
      new Date("2026-09-10T12:00:00Z"),
    );

    const found = codexRollout.findRolloutFile("thread-xyz", home);
    assert.equal(found, archivedFile);
    assert.notEqual(found, sessionsFile);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("findRolloutFile: no directories at all returns null without throwing", () => {
  const home = makeCodexHome();
  try {
    assert.doesNotThrow(() => {
      const found = codexRollout.findRolloutFile("thread-none", home);
      assert.equal(found, null);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
