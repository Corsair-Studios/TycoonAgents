/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// The default "blender" entry is the official Blender Lab server; the community
// bridge is a separate, labelled entry that tells users to disable telemetry.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

interface Entry {
  id: string;
  note?: string;
  thirdParty?: boolean;
  config?: { command?: string; args?: string[] };
}

const catalog = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "media", "mcp", "catalog.json"), "utf8")
) as Entry[];
const packs = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "media", "packs", "catalog.json"), "utf8")
) as Array<{ id: string; mcp?: string }>;

test("blender entry launches the official Blender Lab server with no absolute paths", () => {
  const e = catalog.find((x) => x.id === "blender");
  assert.ok(e);
  assert.equal(e!.thirdParty, false);
  assert.equal(e!.config?.command, "uvx");
  assert.ok(e!.config!.args!.some((a) => a.includes("projects.blender.org/lab/blender_mcp")));
  assert.ok(!JSON.stringify(e!.config).match(/[A-Za-z]:\|\/Users\/|\/home\//));
  assert.match(e!.note!, /5\.1/);
  assert.match(e!.note!, /without any guards/);
});

test("blender-community entry is labelled and carries the telemetry-off instruction", () => {
  const e = catalog.find((x) => x.id === "blender-community");
  assert.ok(e);
  assert.equal(e!.thirdParty, true);
  assert.deepEqual(e!.config, { command: "uvx", args: ["blender-mcp"] });
  assert.match(e!.note!, /Allow Telemetry/);
  assert.match(e!.note!, /Edit > Preferences > Add-ons > MCP for Blender > Telemetry & Privacy/);
});

test("the blender pack keeps pointing at the official blender entry", () => {
  const pack = packs.find((p) => p.id === "blender");
  assert.equal(pack?.mcp, "blender");
});
