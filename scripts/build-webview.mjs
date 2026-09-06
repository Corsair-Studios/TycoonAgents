#!/usr/bin/env node
// Concatenates media/src/main/*.js (in filename order) into media/main.js.
// Run via `npm run build:webview`. See media/src/main/ for the source parts.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const partsDir = join(repoRoot, "media", "src", "main");
const outFile = join(repoRoot, "media", "main.js");

const HEADER =
  "// GENERATED from media/src/main/*.js — edit the parts, then run npm run build:webview\n";

// Returns the ordered list of parts with enough info for a caller to locate
// a byte/line offset back to the owning source file: { name, content, startLine }
// where startLine is the 1-based line number the part's content begins at in
// the concatenated output (after HEADER, which occupies line 1).
export function buildWebviewParts() {
  const files = readdirSync(partsDir)
    .filter((f) => f.endsWith(".js"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No source parts found in ${partsDir}`);
  }
  let line = HEADER.split("\n").length; // HEADER ends with \n, so this is line 2
  const parts = [];
  for (const f of files) {
    // Normalize to LF regardless of the part file's on-disk line endings, so
    // a CRLF checkout of a part never changes the generated output.
    const content = readFileSync(join(partsDir, f), "utf8").replace(/\r\n/g, "\n");
    parts.push({ name: f, content, startLine: line });
    line += content.split("\n").length - 1;
  }
  return parts;
}

export function buildWebviewSource() {
  const parts = buildWebviewParts();
  return HEADER + parts.map((p) => p.content).join("");
}

function main() {
  const out = buildWebviewSource();
  writeFileSync(outFile, out);
  console.log(`Wrote ${outFile} from ${readdirSync(partsDir).filter((f) => f.endsWith(".js")).length} parts.`);
}

// Only run when invoked directly (not when imported by check:webview-sync).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
