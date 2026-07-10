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
  removeLegacyThemeEntry,
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
// migration removed: composite-only reads, legacy entries are cold
// ---------------------------------------------------------------------------

test("readCompositeWithMigration reads ONLY the composite key — a legacy plain-themeId entry is never migrated in", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  const legacyOnlyStore: Record<string, string[]> = { cobra_command: ["legacy_badge_1", "legacy_badge_2"] };

  const result = readCompositeWithMigration(legacyOnlyStore, scope, "cobra_command");

  // Cold: the composite key doesn't exist, so the legacy value is never surfaced.
  assert.equal(result.value, undefined);
  assert.equal(result.migrated, false);
  // Never mutated or copied — same store reference, legacy key untouched.
  assert.equal(result.store, legacyOnlyStore);
  assert.deepEqual(legacyOnlyStore, { cobra_command: ["legacy_badge_1", "legacy_badge_2"] });
});

test("readCompositeWithMigration returns the composite value when present, ignoring any legacy entry", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  let store: Record<string, string[]> = { cobra_command: ["legacy_badge"] };
  store = writeComposite(store, scope, "cobra_command", ["composite_badge"]);

  const result = readCompositeWithMigration(store, scope, "cobra_command");

  assert.deepEqual(result.value, ["composite_badge"]);
  assert.equal(result.migrated, false);
  assert.equal(result.store, store);
});

test("readCompositeWithMigration returns undefined and never migrates when neither key exists", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  const result = readCompositeWithMigration({}, scope, "unknown_theme");
  assert.equal(result.value, undefined);
  assert.equal(result.migrated, false);
});

// ---------------------------------------------------------------------------
// removeLegacyThemeEntry
// ---------------------------------------------------------------------------

test("removeLegacyThemeEntry deletes the plain-themeId key and reports changed:true", () => {
  const store: Record<string, string[]> = { cobra_command: ["legacy"], other_theme: ["x"] };
  const { store: next, changed } = removeLegacyThemeEntry(store, "cobra_command");
  assert.equal(changed, true);
  assert.equal("cobra_command" in next, false);
  assert.deepEqual(next["other_theme"], ["x"]);
  // Input untouched.
  assert.deepEqual(store["cobra_command"], ["legacy"]);
});

test("removeLegacyThemeEntry is a no-op (same reference, changed:false) when there's no legacy key", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  const store: Record<string, string[]> = { [compositeKey(scope, "cobra_command")]: ["a"] };
  const { store: next, changed } = removeLegacyThemeEntry(store, "cobra_command");
  assert.equal(changed, false);
  assert.equal(next, store);
});

// ---------------------------------------------------------------------------
// reset-style removal (composite + legacy) leaves a subsequent read cold
// ---------------------------------------------------------------------------

test("after removing both the composite and legacy entries, a subsequent read is cold (no resurrection)", () => {
  const scope = projectScopeKey("D:/ACode/ProjectA");
  let store: Record<string, string[]> = { cobra_command: ["legacy"] };
  store = writeComposite(store, scope, "cobra_command", ["composite"]);

  const afterComposite = removeProjectThemeEntry(store, scope, "cobra_command");
  const { store: afterBoth } = removeLegacyThemeEntry(afterComposite, "cobra_command");

  const result = readCompositeWithMigration(afterBoth, scope, "cobra_command");
  assert.equal(result.value, undefined);
  assert.equal(result.migrated, false);
  assert.equal("cobra_command" in afterBoth, false);
  assert.equal(compositeKey(scope, "cobra_command") in afterBoth, false);
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
