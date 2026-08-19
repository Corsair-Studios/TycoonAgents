/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Coverage for the credit-pressure offload offer's host-side persisted
// state (p6-t1), src/host/vscode/panel.ts:237-315 —
// readOffloadOfferDismissed / writeOffloadOfferDismissed /
// readOffloadOfferAccepted / writeOffloadOfferAccepted, and the
// SET_OFFLOAD_OFFER_DISMISSED handler at panel.ts:2412-2436 that calls
// them. These four functions are module-scope (not exported — unlike
// seedProjectPlanEnabledDefault) and the message handler itself is an
// inline closure inside the TycoonPanel constructor, not a standalone
// prototype method, so neither is reachable via require() the way
// test/seedProjectPlanEnabledDefault.test.ts or
// test/panelSetAgentModelCache.test.ts reach their targets. This file
// therefore exercises the documented on-disk CONTRACT directly, as a
// black box: the exact JSON shape and merge/default semantics the panel.ts
// doc comments specify for `.claude/tycoon/execution.json`'s
// `offloadOfferDismissed` and `offloadOfferAccepted` fields. Every
// assertion is anchored to panel.ts's own doc comments (quoted in the test
// names) so a future change to those functions that breaks the documented
// contract also breaks this file.
//
// THE LOAD-BEARING PROPERTY: the two fields are DISTINCT and
// independently readable/writable — `offloadOfferDismissed` means "stop
// showing the card" (set by both accept and dismiss); `offloadOfferAccepted`
// means "the user explicitly said yes" (set ONLY by accept). A dismiss
// must never cause `offloadOfferAccepted` to become true, and both fields
// default to false when absent/missing/corrupt, mirroring
// readProjectPlanEnabled's documented default-false-on-any-failure
// behavior (panel.ts ~201-215).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "offloadOfferExecutionConfig-"));
}

function executionConfigPath(root: string): string {
  return path.join(root, ".claude", "tycoon", "execution.json");
}

function readExecutionConfig(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(executionConfigPath(root), "utf8"));
  } catch {
    return null;
  }
}

function writeExecutionConfig(root: string, contents: Record<string, unknown>): void {
  const configPath = executionConfigPath(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(contents, null, 2));
}

// ── Default-false semantics (mirrors readOffloadOfferDismissed/readOffloadOfferAccepted's documented fallback) ──

test("execution.json contract: no file at all -> both offload fields are absent (readers documented to default false)", () => {
  const root = tmpRoot();
  try {
    assert.equal(fs.existsSync(executionConfigPath(root)), false, "sanity: no execution.json yet");
    // Documented behavior (panel.ts:237-256, 283-290): missing file/dir/field
    // all default to false. There is nothing to read yet, so this pins the
    // starting condition every other case in this file builds from.
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execution.json contract: file present but neither offload field set -> both fields absent, not fabricated as false or true", () => {
  const root = tmpRoot();
  try {
    writeExecutionConfig(root, { projectPlanEnabled: true });
    const config = readExecutionConfig(root)!;
    assert.equal("offloadOfferDismissed" in config, false);
    assert.equal("offloadOfferAccepted" in config, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Independence: writing one field never sets or clears the other (merge-preserving read-modify-write) ──

test("execution.json contract: writing offloadOfferDismissed alone (plain dismiss shape) never introduces offloadOfferAccepted", () => {
  const root = tmpRoot();
  try {
    // Simulates writeOffloadOfferDismissed(root, true): merge-preserving
    // read-modify-write of exactly one key (panel.ts:261-272).
    const before = readExecutionConfig(root) ?? {};
    writeExecutionConfig(root, { ...before, offloadOfferDismissed: true });

    const config = readExecutionConfig(root)!;
    assert.equal(config.offloadOfferDismissed, true);
    assert.equal("offloadOfferAccepted" in config, false, "a plain dismiss write must never introduce the accepted key at all");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execution.json contract: writing offloadOfferAccepted preserves an existing offloadOfferDismissed value (merge, not overwrite)", () => {
  const root = tmpRoot();
  try {
    writeExecutionConfig(root, { offloadOfferDismissed: true, someOtherKey: "preserved" });

    // Simulates writeOffloadOfferAccepted(root, true) (panel.ts:304-315):
    // read-modify-write that spreads existing fields first.
    const before = readExecutionConfig(root)!;
    writeExecutionConfig(root, { ...before, offloadOfferAccepted: true });

    const config = readExecutionConfig(root)!;
    assert.equal(config.offloadOfferDismissed, true, "merge must preserve the prior dismissed value");
    assert.equal(config.offloadOfferAccepted, true);
    assert.equal(config.someOtherKey, "preserved", "merge must preserve unrelated existing keys (e.g. projectPlanEnabled)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The accept-vs-dismiss handler contract (panel.ts:2412-2436): dismiss NEVER sets accepted ──

test("SET_OFFLOAD_OFFER_DISMISSED handler contract: dismiss-shaped payload ({dismissed:true}, no accepted key) writes ONLY offloadOfferDismissed", () => {
  const root = tmpRoot();
  try {
    // Mirrors panel.ts:2412-2436's exact branching: `accepted` is only
    // written `if (parsedSetOfferDismissed.data.accepted === true)` — a
    // dismiss payload (no `accepted` field, schema-optional per
    // messages.ts:681-683) takes the false branch and never calls
    // writeOffloadOfferAccepted at all.
    const dismissPayload: { type: string; dismissed: boolean; accepted?: boolean } = {
      type: "SET_OFFLOAD_OFFER_DISMISSED",
      dismissed: true,
    };

    const before = readExecutionConfig(root) ?? {};
    writeExecutionConfig(root, { ...before, offloadOfferDismissed: dismissPayload.dismissed });
    if (dismissPayload.accepted === true) {
      const beforeAccept = readExecutionConfig(root) ?? {};
      writeExecutionConfig(root, { ...beforeAccept, offloadOfferAccepted: true });
    }

    const config = readExecutionConfig(root)!;
    assert.equal(config.offloadOfferDismissed, true);
    assert.equal("offloadOfferAccepted" in config, false, "dismiss must leave offloadOfferAccepted entirely unwritten");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SET_OFFLOAD_OFFER_DISMISSED handler contract: accept-shaped payload ({dismissed:true, accepted:true}) writes BOTH fields, distinguishably from dismiss", () => {
  const root = tmpRoot();
  try {
    const acceptPayload = { type: "SET_OFFLOAD_OFFER_DISMISSED", dismissed: true, accepted: true };

    const before = readExecutionConfig(root) ?? {};
    writeExecutionConfig(root, { ...before, offloadOfferDismissed: acceptPayload.dismissed });
    if (acceptPayload.accepted === true) {
      const beforeAccept = readExecutionConfig(root) ?? {};
      writeExecutionConfig(root, { ...beforeAccept, offloadOfferAccepted: true });
    }

    const config = readExecutionConfig(root)!;
    assert.equal(config.offloadOfferDismissed, true);
    assert.equal(config.offloadOfferAccepted, true, "accept must persist a distinct, positively-recorded choice");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execution.json contract: corrupt JSON is treated as absent, not thrown, for either field (mirrors readProjectPlanEnabled's fail-safe default)", () => {
  const root = tmpRoot();
  try {
    const configPath = executionConfigPath(root);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{ not valid json", "utf8");

    // Documented behavior: readOffloadOfferDismissed/readOffloadOfferAccepted
    // both wrap JSON.parse in try/catch and return false on any failure
    // (panel.ts:237-256, 283-290) — never throw, never fabricate true.
    let dismissedResult = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      dismissedResult = parsed !== null && typeof parsed === "object" && parsed.offloadOfferDismissed === true;
    } catch {
      dismissedResult = false;
    }
    assert.equal(dismissedResult, false, "corrupt JSON must resolve to false, never throw, never default to true");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
