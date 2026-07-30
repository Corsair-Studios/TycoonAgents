/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFsError } from "../src/host/vscode/fsErrors";

// src/host/vscode/fsErrors.ts has zero vscode/fs dependency (pure function
// over `err`/`destPath`), so it's imported and exercised directly — no
// module stubbing needed, unlike the panel.ts-fronted tests elsewhere in
// this suite.

function nodeErr(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test("describeFsError: explicit ENAMETOOLONG gets long-path remedy text naming LongPathsEnabled", () => {
  const err = nodeErr("ENAMETOOLONG: name too long", "ENAMETOOLONG");
  const dest = "C:\\short\\dest.txt"; // short on purpose -- ENAMETOOLONG alone must be enough to classify
  const result = describeFsError(err, dest);
  assert.match(result, /LONG PATH/);
  assert.match(result, /LongPathsEnabled/);
  assert.match(result, new RegExp(dest.length.toString()));
});

test("describeFsError: ENOENT with a destination path over 250 chars is classified as a masked long path", () => {
  const dest = "C:\\" + "a".repeat(260);
  assert.ok(dest.length > 250, "sanity: fixture destination must exceed the 250-char threshold");
  const err = nodeErr("ENOENT: no such file or directory", "ENOENT");
  const result = describeFsError(err, dest);
  assert.match(result, /LONG PATH/);
  assert.match(result, /LongPathsEnabled/);
  assert.match(result, /commonly reports a too-long destination path as ENOENT/);
  assert.match(result, new RegExp(dest.length.toString()));
});

test("describeFsError: ENOENT with a short destination path stays generic — no long-path claim", () => {
  const dest = "C:\\project\\.claude\\skills\\foo\\missing-parent\\file.txt";
  assert.ok(dest.length <= 250, "sanity: fixture destination must stay under the threshold");
  const err = nodeErr("ENOENT: no such file or directory", "ENOENT");
  const result = describeFsError(err, dest);
  assert.equal(result, err.message);
  assert.doesNotMatch(result, /LONG PATH/);
  assert.doesNotMatch(result, /LongPathsEnabled/);
});

test("describeFsError: EACCES stays generic, original message (with its code) preserved verbatim", () => {
  const err = nodeErr("EACCES: permission denied, open 'C:\\locked\\file.txt'", "EACCES");
  const dest = "C:\\locked\\file.txt";
  const result = describeFsError(err, dest);
  assert.equal(result, err.message);
  assert.match(result, /EACCES/);
  assert.doesNotMatch(result, /LONG PATH/);
});

test("describeFsError: a non-Error thrown value is stringified rather than throwing itself", () => {
  const result = describeFsError("plain string failure", "C:\\short.txt");
  assert.equal(result, "plain string failure");
});
