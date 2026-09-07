/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// discoverEpicMcp() (src/providers/uefn/epicMcpDiscovery.ts) takes an
// injectable `probe` seam (EpicMcpProbeFn) as its second parameter, so these
// tests stub reachability per-URL and never open a real socket. This mirrors
// test/codexDiscovery.test.ts's env-snapshot discipline: UEFN_EPIC_MCP_URL
// is process-global, so every test that touches it saves and restores the
// prior value, even on failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverEpicMcp,
  findHttpMcpUrls,
  isConformingInitializeResult,
  type EpicMcpProbeFn,
} from "../src/providers/uefn/epicMcpDiscovery";

const OVERRIDE_ENV_VAR = "UEFN_EPIC_MCP_URL";
const DEFAULT_EPIC_MCP_URL = "http://127.0.0.1:8000/mcp";

function snapshotEnv(): string | undefined {
  return process.env[OVERRIDE_ENV_VAR];
}

function restoreEnv(snap: string | undefined): void {
  if (snap === undefined) delete process.env[OVERRIDE_ENV_VAR];
  else process.env[OVERRIDE_ENV_VAR] = snap;
}

/** A probe stub that never resolves true for anything — stands in for "nothing reachable". */
const neverReachable: EpicMcpProbeFn = async () => false;

/** A probe stub that resolves true only for the exact URL(s) given. */
function reachableOnly(...urls: string[]): EpicMcpProbeFn {
  const set = new Set(urls);
  return async (url: string) => set.has(url);
}

function makeTempProjectRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeMcpConfig(dir: string, content: string): void {
  writeFileSync(join(dir, ".mcp.json"), content, "utf8");
}

test("UEFN_EPIC_MCP_URL override wins over .mcp.json and default, and is the only candidate tried", async () => {
  const snap = snapshotEnv();
  const dir = makeTempProjectRoot("epic-mcp-override-");
  try {
    const overrideUrl = "http://127.0.0.1:9999/mcp";
    process.env[OVERRIDE_ENV_VAR] = overrideUrl;
    // .mcp.json present with its own http entry, and the probe would also
    // accept the default URL — neither should ever be consulted once the
    // override is set.
    writeMcpConfig(
      dir,
      JSON.stringify({
        mcpServers: { "my-epic-server": { type: "http", url: "http://127.0.0.1:8001/mcp" } },
      }),
    );

    const probe = reachableOnly(overrideUrl, "http://127.0.0.1:8001/mcp", DEFAULT_EPIC_MCP_URL);
    const result = await discoverEpicMcp(dir, probe);

    assert.equal(result.available, true);
    assert.equal(result.url, overrideUrl);
    assert.deepEqual(result.triedUrls, [overrideUrl], "override must be the ONLY candidate tried");
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".mcp.json entry under an arbitrary key name (not 'unreal-engine-mcp') is still discovered", async () => {
  const snap = snapshotEnv();
  const dir = makeTempProjectRoot("epic-mcp-arbitrary-key-");
  try {
    delete process.env[OVERRIDE_ENV_VAR];
    const arbitraryUrl = "http://127.0.0.1:8123/mcp";
    writeMcpConfig(
      dir,
      JSON.stringify({
        mcpServers: {
          "totally-different-name": { type: "http", url: arbitraryUrl },
          // Mirrors the project's own real .mcp.json: stdio servers mixed
          // in alongside the http one.
          "uefn-bridge": { command: "node", args: ["uefn-server.mjs"] },
          codex: { command: "codex", args: ["mcp-server"] },
        },
      }),
    );

    const probe = reachableOnly(arbitraryUrl);
    const result = await discoverEpicMcp(dir, probe);

    assert.equal(
      result.available,
      true,
      "an http entry under an arbitrary key name must be discovered by content, not by key name",
    );
    assert.equal(result.url, arbitraryUrl);
    assert.ok(result.triedUrls.includes(arbitraryUrl));
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findHttpMcpUrls: ignores non-http (stdio) entries and finds http entries regardless of key name", () => {
  const config = {
    mcpServers: {
      "uefn-bridge": { command: "node", args: ["uefn-server.mjs"] },
      "my-epic-server": { type: "http", url: "http://127.0.0.1:8000/mcp" },
      codex: { command: "codex", args: ["-c", 'model="gpt-6"', "mcp-server"] },
    },
  };

  const urls = findHttpMcpUrls(config);

  assert.deepEqual(urls, ["http://127.0.0.1:8000/mcp"]);
});

test(".mcp.json missing entirely falls back to the default URL without throwing", async () => {
  const snap = snapshotEnv();
  const dir = makeTempProjectRoot("epic-mcp-missing-");
  try {
    delete process.env[OVERRIDE_ENV_VAR];
    // No .mcp.json written at all.

    const probe = reachableOnly(DEFAULT_EPIC_MCP_URL);
    await assert.doesNotReject(async () => {
      const result = await discoverEpicMcp(dir, probe);
      assert.equal(result.available, true);
      assert.equal(result.url, DEFAULT_EPIC_MCP_URL);
      assert.ok(result.triedUrls.includes(DEFAULT_EPIC_MCP_URL));
    });
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".mcp.json with malformed JSON does not throw, falls back to the default URL", async () => {
  const snap = snapshotEnv();
  const dir = makeTempProjectRoot("epic-mcp-malformed-");
  try {
    delete process.env[OVERRIDE_ENV_VAR];
    writeMcpConfig(dir, "{ this is not valid JSON ,,, ");

    const probe = reachableOnly(DEFAULT_EPIC_MCP_URL);
    const result = await discoverEpicMcp(dir, probe);

    assert.equal(result.available, true);
    assert.equal(result.url, DEFAULT_EPIC_MCP_URL);
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing reachable: returns available:false with triedUrls populated and a reason naming UEFN_EPIC_MCP_URL — never a clean/empty success shape", async () => {
  const snap = snapshotEnv();
  const dir = makeTempProjectRoot("epic-mcp-unreachable-");
  try {
    delete process.env[OVERRIDE_ENV_VAR];
    writeMcpConfig(
      dir,
      JSON.stringify({ mcpServers: { "my-epic-server": { type: "http", url: "http://127.0.0.1:8001/mcp" } } }),
    );

    const result = await discoverEpicMcp(dir, neverReachable);

    assert.equal(result.available, false);
    assert.equal(result.url, null, "url must be null on total failure, not a stray candidate");
    assert.ok(result.triedUrls.length > 0, "triedUrls must be populated, not empty");
    assert.ok(result.reason, "reason must be present on failure");
    assert.ok(
      result.reason!.includes(OVERRIDE_ENV_VAR),
      "reason must name UEFN_EPIC_MCP_URL as the override, per docs/PATH-DISCOVERY.md",
    );
    // Explicitly reject a clean/empty success shape: available:false must
    // never be paired with an empty triedUrls or a missing reason.
    assert.notDeepEqual(result, { available: false, url: null, triedUrls: [] });
  } finally {
    restoreEnv(snap);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server answering initialize with EMPTY serverInfo name/title/version is still detected as available (Epic's real measured behavior)", () => {
  // This is Epic's real measured shape (docs/UEFN-MCP-COMPARISON.md):
  // serverInfo.name/.title/.version are all empty strings. The conformance
  // check must look only at result.capabilities and must never key off
  // serverInfo.name — a test asserting a non-empty name would encode a bug.
  const bodyWithEmptyServerInfo = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "", title: "", version: "" },
    },
  };

  assert.equal(
    isConformingInitializeResult(bodyWithEmptyServerInfo),
    true,
    "empty serverInfo strings must still count as a conforming, available server",
  );
});

test("isConformingInitializeResult: rejects a result missing capabilities, and rejects non-object bodies", () => {
  assert.equal(isConformingInitializeResult({ jsonrpc: "2.0", id: 1, result: { serverInfo: {} } }), false);
  assert.equal(isConformingInitializeResult({ jsonrpc: "2.0", id: 1, result: { capabilities: null } }), false);
  assert.equal(isConformingInitializeResult(null), false);
  assert.equal(isConformingInitializeResult("not an object"), false);
  assert.equal(isConformingInitializeResult(undefined), false);
});
