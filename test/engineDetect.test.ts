/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { detectEngineSetups } from "../src/host/vscode/engineDetect.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir(root: string, ...parts: string[]): void {
  fs.mkdirSync(path.join(root, ...parts), { recursive: true });
}

function makeFile(root: string, ...parts: string[]): void {
  const full = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "engineDetect-"));
}

// ---------------------------------------------------------------------------
// Case 1: empty dir → []
// ---------------------------------------------------------------------------

test("detectEngineSetups: empty dir -> []", () => {
  const root = tmpRoot();
  try {
    const chips = detectEngineSetups(root);
    assert.deepEqual(chips, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 2: project.godot only → godot chip, state:"setup"
// ---------------------------------------------------------------------------

test("detectEngineSetups: project.godot only -> godot chip, state:setup", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "project.godot");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "godot");
    assert.ok(chip, "should have a godot chip");
    assert.equal(chip!.state, "setup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 3: project.godot + .claude/agents/godot.md → state:"ready"
// ---------------------------------------------------------------------------

test("detectEngineSetups: project.godot + .claude/agents/godot.md -> godot chip, state:ready", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "project.godot");
    makeFile(root, ".claude", "agents", "godot.md");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "godot");
    assert.ok(chip, "should have a godot chip");
    assert.equal(chip!.state, "ready");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 4: ProjectSettings/ProjectVersion.txt → unity chip, state:"setup"
// ---------------------------------------------------------------------------

test("detectEngineSetups: ProjectSettings/ProjectVersion.txt -> unity chip, state:setup", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "ProjectSettings", "ProjectVersion.txt");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "unity");
    assert.ok(chip, "should have a unity chip");
    assert.equal(chip!.state, "setup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 5: My.uproject (no Content/Verse, no .verse) → unreal chip, state:"setup"
// ---------------------------------------------------------------------------

test("detectEngineSetups: My.uproject without UEFN markers -> unreal chip, state:setup", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "My.uproject");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "unreal");
    assert.ok(chip, "should have an unreal chip");
    assert.equal(chip!.state, "setup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 6: My.uproject + Content/Verse/ dir → UEFN exclusion → []
// ---------------------------------------------------------------------------

test("detectEngineSetups: My.uproject + Content/Verse dir -> NO unreal chip (UEFN exclusion)", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "My.uproject");
    makeDir(root, "Content", "Verse");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "unreal");
    assert.equal(chip, undefined, "unreal chip must be absent when Content/Verse dir exists");
    assert.deepEqual(chips, [], "result should be empty (no other engines)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 7a: default.project.json → roblox chip, state:"setup"
// ---------------------------------------------------------------------------

test("detectEngineSetups: default.project.json (Rojo) -> roblox chip, state:setup", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "default.project.json");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "roblox");
    assert.ok(chip, "should have a roblox chip");
    assert.equal(chip!.state, "setup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 7b: place.rbxlx → roblox chip, state:"setup"
// ---------------------------------------------------------------------------

test("detectEngineSetups: place.rbxlx -> roblox chip, state:setup", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "place.rbxlx");
    const chips = detectEngineSetups(root);
    const chip = chips.find((c) => c.id === "roblox");
    assert.ok(chip, "should have a roblox chip");
    assert.equal(chip!.state, "setup");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 8: project.godot + ProjectSettings/ProjectVersion.txt → two chips
// ---------------------------------------------------------------------------

test("detectEngineSetups: project.godot + ProjectSettings/ProjectVersion.txt -> two chips (godot + unity)", () => {
  const root = tmpRoot();
  try {
    makeFile(root, "project.godot");
    makeFile(root, "ProjectSettings", "ProjectVersion.txt");
    const chips = detectEngineSetups(root);
    const godot = chips.find((c) => c.id === "godot");
    const unity = chips.find((c) => c.id === "unity");
    assert.ok(godot, "should have a godot chip");
    assert.ok(unity, "should have a unity chip");
    assert.equal(chips.length, 2, "should have exactly two chips");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
