/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p102-t3: the credit-pressure offload offer (card + "Route next task to
// Codex" button + REQUEST_OFFLOAD_OFFER_STATE / OFFLOAD_OFFER_STATE /
// SET_OFFLOAD_OFFER_DISMISSED) was removed entirely. This is the regression
// guard that it stays gone on every surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MSG, MSG_SCHEMAS } from "../src/host/vscode/messages";

const FORBIDDEN = /CreditPressureOffer|credit-pressure-offer|OFFLOAD_OFFER|OffloadOffer|offloadProviderAvailable|Route next task to Codex/;

test("no offload-offer code remains in the webview, hosts or wire contract", () => {
  const files = [
    "media/main.js",
    "media/style.css",
    "src/host/vscode/panel.ts",
    "src/host/vscode/messages.ts",
    "standalone/src/server.mjs",
  ];
  for (const rel of files) {
    const text = readFileSync(join(process.cwd(), rel), "utf8");
    assert.ok(!FORBIDDEN.test(text), `${rel} still references the removed offload offer`);
  }
});

test("MSG and MSG_SCHEMAS no longer define the offload-offer messages", () => {
  for (const key of ["REQUEST_OFFLOAD_OFFER_STATE", "OFFLOAD_OFFER_STATE", "SET_OFFLOAD_OFFER_DISMISSED"]) {
    assert.ok(!(key in MSG), `MSG.${key} should be gone`);
    assert.ok(!(key in (MSG_SCHEMAS as Record<string, unknown>)), `MSG_SCHEMAS.${key} should be gone`);
  }
});
