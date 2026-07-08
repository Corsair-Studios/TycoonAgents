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
import {
  detectEngineSetups,
  computeEngineChips,
  mcpEntryForEngine,
  decideEngineState,
} from "../src/host/vscode/engineDetect.js";

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

// ---------------------------------------------------------------------------
// mcpEntryForEngine — well-known + future-proofing substring lookup
// ---------------------------------------------------------------------------

describe("mcpEntryForEngine", () => {
  test("returns undefined when there is no mcpServers block", () => {
    assert.equal(mcpEntryForEngine({}, "roblox"), undefined);
    assert.equal(mcpEntryForEngine(null, "roblox"), undefined);
    assert.equal(mcpEntryForEngine(undefined, "roblox"), undefined);
  });

  test("resolves a known stdio server name (roblox-studio) as non-http", () => {
    const mcp = { mcpServers: { "roblox-studio": { command: "<path>", args: [] } } };
    const entry = mcpEntryForEngine(mcp, "roblox");
    assert.ok(entry);
    assert.equal(entry!.name, "roblox-studio");
    assert.equal(entry!.isHttp, false);
    assert.equal(entry!.url, undefined);
  });

  test("resolves a known http/url server (unreal-engine-mcp) as http, with url", () => {
    const mcp = { mcpServers: { "unreal-engine-mcp": { type: "http", url: "http://127.0.0.1:8000/mcp" } } };
    const entry = mcpEntryForEngine(mcp, "unreal");
    assert.ok(entry);
    assert.equal(entry!.name, "unreal-engine-mcp");
    assert.equal(entry!.isHttp, true);
    assert.equal(entry!.url, "http://127.0.0.1:8000/mcp");
  });

  test("future-proofing: substring match for an engine with no known server name (godot)", () => {
    const mcp = { mcpServers: { "my-godot-bridge": { command: "godot-mcp" } } };
    const entry = mcpEntryForEngine(mcp, "godot");
    assert.ok(entry);
    assert.equal(entry!.name, "my-godot-bridge");
    assert.equal(entry!.isHttp, false);
  });

  test("no match when no server name relates to the engine", () => {
    const mcp = { mcpServers: { github: { command: "npx" } } };
    assert.equal(mcpEntryForEngine(mcp, "blender"), undefined);
  });

  test("tolerates a flat config without an mcpServers wrapper", () => {
    const mcp = { blender: { command: "uvx", args: ["blender-mcp"] } };
    const entry = mcpEntryForEngine(mcp, "blender");
    assert.ok(entry);
    assert.equal(entry!.name, "blender");
  });
});

// ---------------------------------------------------------------------------
// decideEngineState — pure state-ladder decision
// ---------------------------------------------------------------------------

describe("decideEngineState", () => {
  test("http mcp entry + probed connected -> connected", () => {
    const state = decideEngineState({
      mcpEntry: { name: "unreal-engine-mcp", isHttp: true, url: "http://x" },
      probedConnected: true,
      packInstalled: false,
      projectDetected: true,
    });
    assert.equal(state, "connected");
  });

  test("http mcp entry + probe not connected -> offline", () => {
    const state = decideEngineState({
      mcpEntry: { name: "unreal-engine-mcp", isHttp: true, url: "http://x" },
      probedConnected: false,
      packInstalled: true,
      projectDetected: true,
    });
    assert.equal(state, "offline");
  });

  test("stdio mcp entry -> configured, regardless of pack/project", () => {
    const state = decideEngineState({
      mcpEntry: { name: "roblox-studio", isHttp: false },
      packInstalled: false,
      projectDetected: false,
    });
    assert.equal(state, "configured");
  });

  test("no mcp entry, pack installed -> ready", () => {
    const state = decideEngineState({ packInstalled: true, projectDetected: false });
    assert.equal(state, "ready");
  });

  test("no mcp entry, no pack, project detected -> setup", () => {
    const state = decideEngineState({ packInstalled: false, projectDetected: true });
    assert.equal(state, "setup");
  });

  test("nothing present -> undefined (no chip)", () => {
    const state = decideEngineState({ packInstalled: false, projectDetected: false });
    assert.equal(state, undefined);
  });
});

// ---------------------------------------------------------------------------
// computeEngineChips — end-to-end union of project/pack/mcp signals
// ---------------------------------------------------------------------------

describe("computeEngineChips", () => {
  test("pack installed with no project detected still yields a ready chip", () => {
    const root = tmpRoot();
    try {
      // No project.godot on disk, but the pack's agent file is installed.
      makeFile(root, ".claude", "agents", "godot.md");
      const chips = computeEngineChips(root, null);
      const chip = chips.find((c) => c.id === "godot");
      assert.ok(chip, "pack-installed-only should still surface a chip");
      assert.equal(chip!.state, "ready");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("stdio mcp entry outranks a bare detected project -> configured", () => {
    const root = tmpRoot();
    try {
      makeFile(root, "default.project.json");
      const mcp = { mcpServers: { "roblox-studio": { command: "<path>", args: [] } } };
      const chips = computeEngineChips(root, mcp);
      const chip = chips.find((c) => c.id === "roblox");
      assert.ok(chip);
      assert.equal(chip!.state, "configured");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("http mcp entry uses the supplied probe callback", () => {
    const root = tmpRoot();
    try {
      makeFile(root, "My.uproject");
      const mcp = { mcpServers: { "unreal-engine-mcp": { type: "http", url: "http://127.0.0.1:8000/mcp" } } };
      const connectedChips = computeEngineChips(root, mcp, () => true);
      assert.equal(connectedChips.find((c) => c.id === "unreal")!.state, "connected");

      const offlineChips = computeEngineChips(root, mcp, () => false);
      assert.equal(offlineChips.find((c) => c.id === "unreal")!.state, "offline");

      const unprobedChips = computeEngineChips(root, mcp);
      assert.equal(unprobedChips.find((c) => c.id === "unreal")!.state, "offline");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("chips are sorted alphabetically by label", () => {
    const root = tmpRoot();
    try {
      makeFile(root, "project.godot");
      makeFile(root, "default.project.json");
      makeFile(root, "ProjectSettings", "ProjectVersion.txt");
      const chips = computeEngineChips(root, null);
      const labels = chips.map((c) => c.label);
      const sorted = [...labels].sort((a, b) => a.localeCompare(b));
      assert.deepEqual(labels, sorted);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
