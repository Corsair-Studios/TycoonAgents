/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * Coverage for scripts/check-no-absolute-paths.mjs's base64 data-URL
 * neutralization (findLeaksInContent / neutralizeDataUrls, exported for
 * testing — see the guard at the bottom of the script that keeps the real
 * disk-walking main() from running on import).
 *
 * Regression target: a bundled theme's frames.json embeds ~8.8 MB of
 * data:image/png;base64,... payloads. Random base64 bytes can coincidentally
 * match the "home-path" pattern (or others), producing a false-positive
 * FAILED build gate. The fix neutralizes well-formed data-URL payloads
 * before running the path patterns, without blinding the guard to a REAL
 * leaked path sitting anywhere else in the same file (even the same line).
 */

const SCRIPT_URL = pathToFileURL(join(process.cwd(), "scripts", "check-no-absolute-paths.mjs")).href;

// This test file compiles to CommonJS (tsconfig.json: module: "commonjs"),
// and tsc downlevels a plain `import(...)` expression there to `require(...)`,
// which cannot load an ESM .mjs module. Go through `new Function` so the
// dynamic import survives untouched by the compiler and Node's native ESM
// loader handles it at runtime — the standard CJS-importing-ESM trick.
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

async function loadScript() {
  return dynamicImport(SCRIPT_URL) as Promise<{
    neutralizeDataUrls: (content: string) => string;
    findLeaksInContent: (content: string) => Array<{ line: number; pattern: string; snippet: string }>;
  }>;
}

test("a base64 data URL whose payload happens to contain a path-looking substring does not trip the guard", async () => {
  const { findLeaksInContent } = await loadScript();
  // This payload is deliberately constructed to contain "/home/someone" and
  // "C:/" -looking substrings inside the base64 alphabet itself.
  const payload = "iVBORw0KGgoAAAAhomeXsomeoneYAAlvC3AZfooCcolonslashbar";
  const content = `{"frames":["data:image/png;base64,${payload}"]}`;
  const hits = findLeaksInContent(content);
  assert.deepEqual(hits, [], `expected no leaks inside a base64 payload, got: ${JSON.stringify(hits)}`);
});

test("a genuine absolute path still trips the guard: Windows drive path", async () => {
  const { findLeaksInContent } = await loadScript();
  const content = 'const p = "C:\\\\Users\\\\someone\\\\project\\\\file.json";';
  const hits = findLeaksInContent(content);
  assert.ok(hits.length > 0, "expected at least one leak for a Windows drive path");
  assert.ok(hits.some((h) => h.pattern === "windows-drive-path" || h.pattern === "users-path"));
});

test("a genuine absolute path still trips the guard: /home/... style path", async () => {
  const { findLeaksInContent } = await loadScript();
  const content = 'const p = "/home/someone/project/file.json";';
  const hits = findLeaksInContent(content);
  assert.ok(hits.length > 0, "expected at least one leak for a /home/... path");
  assert.ok(hits.some((h) => h.pattern === "home-path"));
});

test("a data URL plus a real path on the SAME line still reports the real path leak", async () => {
  const { findLeaksInContent } = await loadScript();
  const payload = "iVBORw0KGgoAAAANSUhEUgAAAhUAAALvCAYAAADS7TcBAA15DUlEQVR4AXTBT8s97GLf1fW59";
  const content = `{"icon":"data:image/png;base64,${payload}","note":"see C:\\\\Users\\\\someone\\\\notes.txt"}`;
  const hits = findLeaksInContent(content);
  assert.ok(hits.length > 0, "expected the real path on the same line to still be caught");
  assert.ok(
    hits.every((h) => !h.snippet.includes(payload)),
    "the reported snippet should not contain the raw base64 payload — it should be neutralized",
  );
});

test("neutralizeDataUrls only strips well-formed data:<mime>;base64,<payload> URLs, not arbitrary long alphanumeric runs", async () => {
  const { neutralizeDataUrls } = await loadScript();
  const longRun = "A".repeat(500) + "0123456789".repeat(50);
  const content = `{"blob":"${longRun}"}`;
  const result = neutralizeDataUrls(content);
  assert.equal(result, content, "a long alphanumeric run with no data: prefix must be left untouched");
});

test("neutralizeDataUrls preserves line count/structure (does not delete lines)", async () => {
  const { neutralizeDataUrls } = await loadScript();
  const payload = "iVBORw0KGgoAAAANSUhEUgAAAhUAAALvCAYAAADS7TcBAA15DUlEQVR4AXTBT8s97G";
  const content = [
    "line one",
    `"data:image/png;base64,${payload}"`,
    "line three with C:\\\\Users\\\\someone\\\\file.txt",
  ].join("\n");
  const result = neutralizeDataUrls(content);
  assert.equal(result.split("\n").length, 3, "neutralization must not change the number of lines");
  assert.ok(result.includes("line three with"), "unrelated lines must be preserved verbatim");
});
