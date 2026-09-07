/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p19-t3 / p20-t2: the Settings "Agents" and "Keyword routing" sections moved
// into the Agents modal (formerly Routing; #menu-routing id kept, label now
// "Agents" — see renderRoutingModal, media/main.js ~18250-18260). This is a
// source-text (grep-based) drift guard, not a DOM-driven one: these wire
// strings are posted from the Agents modal itself (setAgentModel,
// setAgentKeywords, removeAgent, clearAgentRoute, saveRouting, getRouting).
// setUseMultipleLlms is NOT checked here any more: p20-t2 removed the
// Settings screen's "Use multiple LLMs" checkbox entirely, and media/main.js
// no longer posts that message at all (grepped: zero occurrences) — its MSG
// constant stays declared in src/host/vscode/messages.ts for backward wire
// compatibility, but nothing in the webview sends it, so asserting it's
// still posted would be testing a message the UI can no longer produce.
// The shared, honestly-testable property across the remaining wire strings
// is simpler and more durable: the literal wire string must still exist as
// an argument to a `vscode.postMessage(...)` call somewhere in media/main.js,
// so the host's message.ts handlers (src/host/vscode/messages.ts) keep
// matching. A rename on either side (webview or host) would otherwise
// regress silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAIN_JS_PATH = join(process.cwd(), "media", "main.js");
const MESSAGES_TS_PATH = join(process.cwd(), "src", "host", "vscode", "messages.ts");

const src = readFileSync(MAIN_JS_PATH, "utf8");

/**
 * True if `wireValue` appears as a `type: "<wireValue>"` (or `type: CONST`
 * resolving to that literal, handled by the caller passing the resolved
 * regex) argument inside a `vscode.postMessage({ ... })` call anywhere in
 * media/main.js. Scans line-by-line with a small forward window so a
 * multi-line postMessage object literal is still matched.
 */
function postsLiteralType(wireValue: string): boolean {
  const re = new RegExp(`vscode\\.postMessage\\(\\{[^}]*type:\\s*"${wireValue}"`, "g");
  return re.test(src);
}

test("Agents/Settings screens: setAgentModel is still posted with its unchanged wire string", () => {
  assert.ok(postsLiteralType("setAgentModel"), 'expected a `vscode.postMessage({ type: "setAgentModel", ... })` call in media/main.js');
});

test("Agents/Settings screens: setAgentKeywords is still posted with its unchanged wire string", () => {
  assert.ok(postsLiteralType("setAgentKeywords"), 'expected a `vscode.postMessage({ type: "setAgentKeywords", ... })` call in media/main.js');
});

test("Agents/Settings screens: removeAgent is still posted with its unchanged wire string", () => {
  assert.ok(postsLiteralType("removeAgent"), 'expected a `vscode.postMessage({ type: "removeAgent", ... })` call in media/main.js');
});

test("Agents screen: openAgentFile is still posted with its unchanged wire string", () => {
  assert.ok(postsLiteralType("openAgentFile"), 'expected a `vscode.postMessage({ type: "openAgentFile", ... })` call in media/main.js');
});

test("p20-t2: setUseMultipleLlms is no longer posted anywhere in media/main.js (the checkbox was removed)", () => {
  assert.equal(
    postsLiteralType("setUseMultipleLlms"),
    false,
    'the "Use multiple LLMs" checkbox was removed from Settings (p20-t2) — media/main.js should no longer post { type: "setUseMultipleLlms", ... }',
  );
});

test("Agents modal (classic density): clearAgentRoute is posted with its unchanged wire string", () => {
  assert.ok(postsLiteralType("clearAgentRoute"), 'expected a `vscode.postMessage({ type: "clearAgentRoute", ... })` call in media/main.js');
});

// getRouting/saveRouting are posted via the ROUTING_MSG constant object
// (`vscode.postMessage({ type: ROUTING_MSG.GET })` /
// `vscode.postMessage({ type: ROUTING_MSG.SAVE, ... })`), not a literal
// string at the call site — verify both the constant's value AND that the
// constant-based call sites still exist, so a rename of either the constant
// or the call site is caught.
test("Agents modal: getRouting is still the ROUTING_MSG.GET wire value, posted via vscode.postMessage(ROUTING_MSG.GET)", () => {
  const constMatch = src.match(/ROUTING_MSG\s*=\s*\{[^}]*GET:\s*"([^"]+)"/);
  assert.ok(constMatch, "expected a ROUTING_MSG object literal declaring GET: \"...\" in media/main.js");
  assert.equal(constMatch![1], "getRouting", "ROUTING_MSG.GET's wire value must stay \"getRouting\"");
  assert.match(src, /vscode\.postMessage\(\{\s*type:\s*ROUTING_MSG\.GET\s*\}\)/, "expected a `vscode.postMessage({ type: ROUTING_MSG.GET })` call site");
});

test("Agents modal: saveRouting is still the ROUTING_MSG.SAVE wire value, posted via vscode.postMessage(ROUTING_MSG.SAVE, ...)", () => {
  const constMatch = src.match(/ROUTING_MSG\s*=\s*\{[^}]*SAVE:\s*"([^"]+)"/);
  assert.ok(constMatch, "expected a ROUTING_MSG object literal declaring SAVE: \"...\" in media/main.js");
  assert.equal(constMatch![1], "saveRouting", "ROUTING_MSG.SAVE's wire value must stay \"saveRouting\"");
  assert.match(src, /vscode\.postMessage\(\{\s*type:\s*ROUTING_MSG\.SAVE[^)]*\}\)/, "expected a `vscode.postMessage({ type: ROUTING_MSG.SAVE, ... })` call site");
});

// Cross-check against the host's own source of truth (messages.ts), the
// same source-of-truth-vs-actual-behavior technique
// standalone/test/messageContract.test.mjs uses for MSG.STATE — a webview
// wire string with no matching host handler constant is exactly the kind of
// silent drift this file exists to catch.
test("DRIFT GUARD: every message name checked here also exists as a wire value in src/host/vscode/messages.ts's MSG object", () => {
  const messagesSrc = readFileSync(MESSAGES_TS_PATH, "utf8");
  for (const wire of ["setAgentModel", "setAgentKeywords", "removeAgent", "openAgentFile", "clearAgentRoute", "setUseMultipleLlms", "getRouting", "saveRouting"]) {
    assert.match(
      messagesSrc,
      new RegExp(`:\\s*"${wire}"`),
      `expected messages.ts's MSG object to still declare a "${wire}" wire value`,
    );
  }
});
