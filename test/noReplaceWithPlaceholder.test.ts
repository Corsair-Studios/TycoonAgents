/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p65-t4: a source grep guarding against a leftover "REPLACE_WITH"
// placeholder token making it into shipped code (src/ and standalone/src/).
// Deterministic, no network: walks the two trees on disk and greps text
// files only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md"]);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (TEXT_EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function assertNoPlaceholder(root: string): void {
  const files = collectFiles(root);
  assert.ok(files.length > 0, `expected to find source files under ${root}`);
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (text.includes("REPLACE_WITH")) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `found leftover "REPLACE_WITH" placeholder(s) in: ${offenders.join(", ")}`);
}

test("src/ contains no leftover REPLACE_WITH placeholder token", () => {
  assertNoPlaceholder(join(process.cwd(), "src"));
});

test("standalone/src/ contains no leftover REPLACE_WITH placeholder token", () => {
  assertNoPlaceholder(join(process.cwd(), "standalone", "src"));
});
