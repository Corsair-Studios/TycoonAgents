/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_PROJECT_SCOPE,
  projectScopeKey,
  compositeKey,
  readCompositeWithMigration,
  writeComposite,
  removeProjectThemeEntry,
  removeThemeEverywhere,
  shouldWarnOnThemeSwitch,
} from "../src/host/vscode/progressScope";

// ---------------------------------------------------------------------------
// projectScopeKey
// ---------------------------------------------------------------------------

test("projectScopeKey is stable for the same root and differs across roots", () => {
  const a1 = projectScopeKey("D:/ACode/ProjectA");
  const a2 = projectScopeKey("D:/ACode/ProjectA");
  const b = projectScopeKey("D:/ACode/ProjectB");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("projectScopeKey normalizes case and slash style so the same project always scopes the same", () => {
  const forward = projectScopeKey("D:/ACode/ProjectA");
  const backward = projectScopeKey("D:\\ACode\\ProjectA");
  const lower = projectScopeKey("d:/acode/projecta");
  assert.equal(forward, backward);
  assert.equal(forward, lower);
});

test("projectScopeKey falls back to a shared constant for no workspace", () => {
  assert.equal(projectScopeKey(""), NO_PROJECT_SCOPE);
  assert.equal(projectScopeKey(undefined), NO_PROJECT_SCOPE);
  assert.equal(projectScopeKey(null), NO_PROJECT_SCOPE);
});

// ---------------------------------------------------------------------------
// composite key read/write isolates by project AND theme
// ---------------------------------------------------------------------------

test("composite key isolates entries by project and by theme", () => {
  const scopeA = projectScopeKey("D:/ACode/ProjectA");
  const scopeB = projectScopeKey("D:/ACode/ProjectB");

  let store: Record<string, string[]> = {};
  store = writeComposite(store, scopeA, "cobra_command", ["badge_1"]);
  store = writeComposite(store, scopeB, "cobra_command", ["badge_2", "badge_3"]);
  store = writeComposite(store, scopeA, "other_theme", ["badge_4"]);

  const readA = readCompositeWithMigration(store, scopeA, "cobra_command");
  const readB = readCompositeWithMigration(store, scopeB, "cobra_command");
  const readAOther = readCompositeWithMigration(store, scopeA, "other_theme");

  assert.deepEqual(readA.value, ["badge_1"]);
  assert.deepEqual(readB.value, ["badge_2", "badge_3"]);
  assert.deepEqual(readAOther.value, ["badge_4"]);
  // Same theme_id, different project => genuinely different keys.
  assert.notEqual(compositeKey(scopeA, "cobra_command"), compositeKey(scopeB, "cobra_command"));
});

// ---------------------------------------------------------------------------
// legacy -> composite migration
// ---------------------------------------------------------------------------

test("readCompositeWithMigration copies a legacy plain-themeId entry forward once, preserving the value", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  const legacyStore: Record<string, string[]> = { cobra_command: ["legacy_badge_1", "legacy_badge_2"] };

  const first = readCompositeWithMigration(legacyStore, scope, "cobra_command");
  assert.equal(first.migrated, true);
  assert.deepEqual(first.value, ["legacy_badge_1", "legacy_badge_2"]);
  // Input store is untouched; a NEW store is returned with the composite key added.
  assert.equal(legacyStore["cobra_command"] !== undefined, true);
  assert.deepEqual(first.store[compositeKey(scope, "cobra_command")], ["legacy_badge_1", "legacy_badge_2"]);
  // Legacy key is left in place (harmless — another project may still migrate from it).
  assert.deepEqual(first.store["cobra_command"], ["legacy_badge_1", "legacy_badge_2"]);

  // Second read (against the migrated store) is a normal composite hit, not another migration.
  const second = readCompositeWithMigration(first.store, scope, "cobra_command");
  assert.equal(second.migrated, false);
  assert.deepEqual(second.value, ["legacy_badge_1", "legacy_badge_2"]);
});

test("readCompositeWithMigration lets a SECOND project also migrate from the same legacy entry", () => {
  const scopeA = projectScopeKey("D:/ACode/ProjectA");
  const scopeB = projectScopeKey("D:/ACode/ProjectB");
  const legacyStore: Record<string, number> = { cobra_command: 7 };

  const migratedForA = readCompositeWithMigration(legacyStore, scopeA, "cobra_command").store;
  const migratedForB = readCompositeWithMigration(migratedForA, scopeB, "cobra_command");

  assert.equal(migratedForB.migrated, true);
  assert.equal(migratedForB.value, 7);
  assert.equal(migratedForB.store[compositeKey(scopeA, "cobra_command")], 7);
  assert.equal(migratedForB.store[compositeKey(scopeB, "cobra_command")], 7);
});

test("readCompositeWithMigration returns undefined and does not migrate when neither key exists", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  const result = readCompositeWithMigration({}, scope, "unknown_theme");
  assert.equal(result.value, undefined);
  assert.equal(result.migrated, false);
});

// ---------------------------------------------------------------------------
// scoped reset removes only the current project+theme entry
// ---------------------------------------------------------------------------

test("removeProjectThemeEntry clears only the current project+theme entry; other keys survive", () => {
  const scopeA = projectScopeKey("D:/ACode/ProjectA");
  const scopeB = projectScopeKey("D:/ACode/ProjectB");
  let store: Record<string, string[]> = {};
  store = writeComposite(store, scopeA, "cobra_command", ["a1"]);
  store = writeComposite(store, scopeB, "cobra_command", ["b1"]);
  store = writeComposite(store, scopeA, "other_theme", ["a2"]);
  store["cobra_command"] = ["legacy"]; // legacy key, must also survive

  const next = removeProjectThemeEntry(store, scopeA, "cobra_command");

  assert.equal(compositeKey(scopeA, "cobra_command") in next, false);
  assert.deepEqual(next[compositeKey(scopeB, "cobra_command")], ["b1"]);
  assert.deepEqual(next[compositeKey(scopeA, "other_theme")], ["a2"]);
  assert.deepEqual(next["cobra_command"], ["legacy"]);
});

test("removeProjectThemeEntry is a no-op (same reference) when there's nothing to remove", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  const store: Record<string, string[]> = { [compositeKey(scope, "other")]: ["x"] };
  const next = removeProjectThemeEntry(store, scope, "cobra_command");
  assert.equal(next, store);
});

// ---------------------------------------------------------------------------
// full theme deletion removes every project's entry + the legacy key
// ---------------------------------------------------------------------------

test("removeThemeEverywhere removes the legacy key and every project's composite key for that theme, leaving others intact", () => {
  const scopeA = projectScopeKey("D:/ACode/ProjectA");
  const scopeB = projectScopeKey("D:/ACode/ProjectB");
  let store: Record<string, string[]> = {};
  store = writeComposite(store, scopeA, "cobra_command", ["a1"]);
  store = writeComposite(store, scopeB, "cobra_command", ["b1"]);
  store = writeComposite(store, scopeA, "other_theme", ["a2"]);
  store["cobra_command"] = ["legacy"];

  const next = removeThemeEverywhere(store, "cobra_command");

  assert.equal(compositeKey(scopeA, "cobra_command") in next, false);
  assert.equal(compositeKey(scopeB, "cobra_command") in next, false);
  assert.equal("cobra_command" in next, false);
  assert.deepEqual(next[compositeKey(scopeA, "other_theme")], ["a2"]);
});

test("removeThemeEverywhere does not false-positive on theme_ids that are suffixes of other keys", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  let store: Record<string, number> = {};
  store = writeComposite(store, scope, "supercobra", 1);
  const next = removeThemeEverywhere(store, "cobra");
  assert.deepEqual(next, store);
});

// ---------------------------------------------------------------------------
// theme-switch warning decision
// ---------------------------------------------------------------------------

test("shouldWarnOnThemeSwitch warns only when switching away from a theme with >=1 badge", () => {
  assert.equal(shouldWarnOnThemeSwitch("cobra_command", "cyberpunk_2049", 3), true);
  assert.equal(shouldWarnOnThemeSwitch("cobra_command", "cyberpunk_2049", 0), false);
  assert.equal(shouldWarnOnThemeSwitch("cobra_command", "cobra_command", 5), false);
  assert.equal(shouldWarnOnThemeSwitch(undefined, "cyberpunk_2049", 5), false);
  assert.equal(shouldWarnOnThemeSwitch("", "cyberpunk_2049", 5), false);
});
