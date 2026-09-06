#!/usr/bin/env node
// Rebuilds media/main.js from media/src/main/*.js in memory and fails if it
// differs from the committed media/main.js. Catches drift between the
// source parts and the generated file. Run via `npm run check:webview-sync`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildWebviewParts } from "./build-webview.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outFile = join(repoRoot, "media", "main.js");

const HEADER =
  "// GENERATED from media/src/main/*.js — edit the parts, then run npm run build:webview\n";

const parts = buildWebviewParts();
// Normalize line endings on both sides so a CRLF checkout of either the
// parts or the on-disk media/main.js does not fail the check.
const expected = (HEADER + parts.map((p) => p.content).join("")).replace(/\r\n/g, "\n");
const actual = readFileSync(outFile, "utf8").replace(/\r\n/g, "\n");

if (expected !== actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const maxLen = Math.max(expectedLines.length, actualLines.length);
  let firstDiffLine = -1;
  for (let i = 0; i < maxLen; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      firstDiffLine = i + 1;
      break;
    }
  }

  let owningPart = "(header)";
  for (const p of parts) {
    const partLineCount = p.content.split("\n").length - 1;
    if (firstDiffLine >= p.startLine && firstDiffLine < p.startLine + partLineCount) {
      owningPart = p.name;
      break;
    }
  }

  console.error(
    "media/main.js is out of sync with media/src/main/*.js.\n" +
      `First difference at generated line ${firstDiffLine}, owned by media/src/main/${owningPart}.\n` +
      "Run `npm run build:webview` and commit the result."
  );
  process.exit(1);
}

console.log("media/main.js is in sync with media/src/main/*.js.");
