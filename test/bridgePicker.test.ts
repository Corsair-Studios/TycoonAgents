import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BRIDGE_PACK_ID,
  buildBridgePicker,
  buildOtherAgent,
  describeBridgeSetup,
  installBridgeSelection,
  installMcpEntry,
  validateOtherSpec,
} from "../src/core/bridgeSetup";
import type { McpInstallOutcome, OtherAgentSpec } from "../src/core/bridgeSetup";
import { parseAgentBackend, readAgentFrontmatter } from "../src/core/agentBackend";
import { MSG_SCHEMAS } from "../src/host/vscode/messages";
import { isUnpinnedMcpConfig, resolveConfigForPlatform } from "../src/host/vscode/mcpCatalog";
import type { PackAgent } from "../src/host/vscode/packCatalog";

/*
 * Multi-LLM pack picker: only the ticked models are installed, each with the MCP
 * server it needs (the openai-compatible server once), "Other" endpoints are
 * validated and carry env var NAMES only, no approval key is ever written, and
 * the Codex harness (dispatcher) never gets a .mcp.json entry.
 */

const REPO = process.cwd();
const PACK = (JSON.parse(fs.readFileSync(path.join(REPO, "media", "packs", "catalog.json"), "utf8")) as any[]).find((p) => p.id === BRIDGE_PACK_ID);
const PACK_AGENTS: PackAgent[] = PACK.agents;
const MCP_CATALOG: any[] = JSON.parse(fs.readFileSync(path.join(REPO, "media", "mcp", "catalog.json"), "utf8"));

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-picker-"));
}

function agentFiles(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, ".claude", "agents")).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function mcpServers(root: string): string[] {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers ?? {}).sort();
  } catch {
    return [];
  }
}

/** Real catalog install with a spy so the number of installs per server id is observable. */
function spyInstaller(root: string, calls: string[]): (id: string) => McpInstallOutcome {
  return (id) => {
    calls.push(id);
    return installMcpEntry(root, id, MCP_CATALOG, {
      platform: process.platform,
      resolveTokens: (c) => JSON.parse(JSON.stringify(c).split("${EXTENSION_DIR}").join("/ext")),
      finalize: (_id, c) => c,
      afterWrite: () => undefined,
    });
  };
}

function baseArgs(root: string, calls: string[], extra: Partial<Parameters<typeof installBridgeSelection>[0]> = {}) {
  return {
    root,
    packAgents: PACK_AGENTS,
    selectedAgentIds: [] as string[],
    others: [] as OtherAgentSpec[],
    harness: "claude-code",
    claudeSubscriptionOptIn: false,
    installMcp: spyInstaller(root, calls),
    ...extra,
  };
}

const LOCAL: OtherAgentSpec = { agentId: "local-llama", label: "Local Llama", model: "llama3", endpointEnv: "OLLAMA_BASE_URL", apiKeyEnv: "OLLAMA_API_KEY" };

test("the multi-llm catalog entry is a picker pack and no longer claims a single mcp server", () => {
  assert.equal(PACK.picker, "bridges");
  assert.equal(PACK.mcp, null);
  assert.equal(PACK_AGENTS.length, 6);
});

test("picker installs only the selected agents", () => {
  const root = tmpProject();
  try {
    const calls: string[] = [];
    const res = installBridgeSelection(baseArgs(root, calls, { selectedAgentIds: ["codex-reviewer", "gemini-reviewer"] }));
    assert.equal(res.ok, true, res.errors.join(";"));
    assert.deepEqual(agentFiles(root), ["codex-reviewer.md", "gemini-reviewer.md"]);
    assert.deepEqual(res.installed.map((i) => i.agent.id).sort(), ["codex-reviewer", "gemini-reviewer"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty selection installs nothing", () => {
  const root = tmpProject();
  try {
    const res = installBridgeSelection(baseArgs(root, []));
    assert.equal(res.ok, false);
    assert.deepEqual(agentFiles(root), []);
    assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("each selected agent gets the server it needs in .mcp.json", () => {
  const root = tmpProject();
  try {
    const calls: string[] = [];
    const res = installBridgeSelection(
      baseArgs(root, calls, { selectedAgentIds: ["codex-reviewer", "gemini-reviewer", "claude-worker", "grok-reviewer"] }),
    );
    assert.equal(res.ok, true, res.errors.join(";"));
    assert.deepEqual(mcpServers(root), ["claude-cli", "codex", "gemini", "openai-compatible"]);
    for (const id of Object.keys(res.mcp)) assert.ok(res.mcp[id] === "installed", `${id}: ${JSON.stringify(res.mcp[id])}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a deselected model's server is not installed", () => {
  const root = tmpProject();
  try {
    installBridgeSelection(baseArgs(root, [], { selectedAgentIds: ["codex-reviewer"] }));
    assert.deepEqual(mcpServers(root), ["codex"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grok, kimi, mistral and an Other endpoint share the openai-compatible server, installed once", () => {
  const root = tmpProject();
  try {
    const calls: string[] = [];
    const res = installBridgeSelection(
      baseArgs(root, calls, { selectedAgentIds: ["grok-reviewer", "kimi-reviewer", "mistral-reviewer"], others: [LOCAL] }),
    );
    assert.equal(res.ok, true, res.errors.join(";"));
    assert.deepEqual(calls, ["openai-compatible"], "the shared server must be installed exactly once");
    assert.deepEqual(mcpServers(root), ["openai-compatible"]);
    assert.deepEqual(agentFiles(root), ["grok-reviewer.md", "kimi-reviewer.md", "local-llama.md", "mistral-reviewer.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no MCP approval key is written anywhere in the project", () => {
  const root = tmpProject();
  try {
    installBridgeSelection(baseArgs(root, [], { selectedAgentIds: PACK_AGENTS.map((a) => a.id), others: [LOCAL] }));
    const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp), ["mcpServers"]);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.json")), false);
    assert.equal(fs.existsSync(path.join(root, ".claude", "settings.local.json")), false);
    const all = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => fs.statSync(path.join(root, f)).isFile());
    for (const f of all) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      assert.ok(!/enabledMcpjsonServers|enableAllProjectMcpServers/.test(text), `${f} must not carry an approval key`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog entries for all bridge servers resolve to pinned launchers (no @latest)", () => {
  for (const id of ["codex", "gemini", "claude-cli", "openai-compatible"]) {
    const entry = MCP_CATALOG.find((e) => e.id === id);
    assert.ok(entry, id);
    const cfg = resolveConfigForPlatform(entry, process.platform);
    assert.ok(cfg.ok, id);
    if (cfg.ok) assert.equal(isUnpinnedMcpConfig(cfg.config), false, `${id} must not be an unpinned npx/uvx entry`);
  }
});

test("needs-setup badge data: an installed bridge agent with no server in .mcp.json needs setup, and clears once the server is added", () => {
  const root = tmpProject();
  try {
    installBridgeSelection(baseArgs(root, [], { selectedAgentIds: ["codex-reviewer"], harness: "codex" }));
    assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
    const ctx = { root, harness: "claude-code", env: {} as NodeJS.ProcessEnv, probe: () => ({}) };
    const before = describeBridgeSetup(ctx);
    assert.equal(before["codex-reviewer"].serverState, "missing");
    assert.equal(before["codex-reviewer"].needsSetup, true);
    assert.match(before["codex-reviewer"].reasons.join(" "), /codex/);
    installMcpEntry(root, "codex", MCP_CATALOG, {
      platform: process.platform,
      resolveTokens: (c) => c,
      finalize: (_i, c) => c,
      afterWrite: () => undefined,
    });
    const after = describeBridgeSetup(ctx);
    assert.equal(after["codex-reviewer"].serverState, "installed");
    assert.equal(after["codex-reviewer"].needsSetup, false);
    assert.equal(after["codex-reviewer"].keyState, "signin");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("needs-setup also fires when a required key is missing, naming the variable only", () => {
  const root = tmpProject();
  try {
    installBridgeSelection(baseArgs(root, [], { selectedAgentIds: ["grok-reviewer"] }));
    const missing = describeBridgeSetup({ root, harness: "claude-code", env: {}, probe: () => ({}) })["grok-reviewer"];
    assert.equal(missing.serverState, "installed");
    assert.equal(missing.keyState, "missing");
    assert.equal(missing.needsSetup, true);
    assert.ok(missing.env.some((e) => e.name === "XAI_API_KEY" && !e.present));
    const present = describeBridgeSetup({ root, harness: "claude-code", env: {}, probe: (names) => Object.fromEntries(names.map((n) => [n, { env: n === "XAI_API_KEY", stored: false }])) })["grok-reviewer"];
    assert.equal(present.needsSetup, false);
    assert.equal(present.keyState, "ok");
    // Presence flags and names only: no value-shaped field exists.
    assert.deepEqual(Object.keys(present.env[0]).sort(), ["kind", "name", "present", "required"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex harness: agent files are installed but .mcp.json is never written and no server install is attempted", () => {
  const root = tmpProject();
  try {
    const calls: string[] = [];
    const res = installBridgeSelection(
      baseArgs(root, calls, { harness: "codex", selectedAgentIds: ["codex-reviewer", "grok-reviewer"], others: [LOCAL] }),
    );
    assert.equal(res.ok, true, res.errors.join(";"));
    assert.equal(res.dispatcherHost, true);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
    assert.deepEqual(agentFiles(root), ["codex-reviewer.md", "grok-reviewer.md", "local-llama.md"]);
    const setup = describeBridgeSetup({ root, harness: "codex", env: {}, probe: () => ({}) });
    assert.equal(setup["codex-reviewer"].serverState, "dispatcher");
    assert.equal(setup["codex-reviewer"].needsSetup, false, "no badge for a server the dispatcher host never needs");
    assert.equal(setup["grok-reviewer"].needsSetup, true, "a missing key still needs setup on the dispatcher host");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("picker payload: nothing pre-checked beyond what is installed; per-model status; dispatcher flag", () => {
  const root = tmpProject();
  try {
    installBridgeSelection(baseArgs(root, [], { selectedAgentIds: ["gemini-reviewer"] }));
    const p = buildBridgePicker(PACK_AGENTS, { root, harness: "claude-code", env: {}, probe: () => ({}) });
    assert.deepEqual(p.models.map((m) => m.label), ["Codex", "Gemini", "Grok", "Kimi", "Mistral", "Claude worker (subscription)"]);
    assert.deepEqual(p.models.filter((m) => m.installed).map((m) => m.agentId), ["gemini-reviewer"]);
    const grok = p.models.find((m) => m.agentId === "grok-reviewer")!;
    assert.equal(grok.setup!.keyState, "missing");
    assert.equal(p.dispatcherHost, false);
    assert.equal(buildBridgePicker(PACK_AGENTS, { root, harness: "codex", env: {}, probe: () => ({}) }).dispatcherHost, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// "Other (OpenAI-compatible endpoint)"
// ---------------------------------------------------------------------------

test("Other: slug validation", () => {
  for (const bad of ["", "A", "Has Space", "../evil", "9lives", "x", "a".repeat(41), "under_score", "orchestrator", "primary-agent"]) {
    assert.ok(validateOtherSpec({ ...LOCAL, agentId: bad }, []).length > 0, JSON.stringify(bad));
  }
  assert.deepEqual(validateOtherSpec(LOCAL, []), []);
});

test("Other: refuses a name that collides with an existing agent or a pack agent, case-insensitively", () => {
  assert.match(validateOtherSpec(LOCAL, ["local-llama"]).join(" "), /already exists/);
  assert.match(validateOtherSpec({ ...LOCAL, agentId: "grok-reviewer" }, ["grok-reviewer"]).join(" "), /already exists/);
  const root = tmpProject();
  try {
    fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "agents", "local-llama.md"), "---\nname: local-llama\n---\nmine\n");
    const res = installBridgeSelection(baseArgs(root, [], { selectedAgentIds: ["codex-reviewer"], others: [LOCAL] }));
    assert.equal(res.ok, false);
    assert.match(res.errors.join(" "), /already exists/);
    assert.equal(fs.readFileSync(path.join(root, ".claude", "agents", "local-llama.md"), "utf8"), "---\nname: local-llama\n---\nmine\n", "the colliding agent is untouched");
    assert.equal(fs.existsSync(path.join(root, ".claude", "agents", "codex-reviewer.md")), false, "a bad Other installs nothing");
    // Two Others with the same name in one request also collide.
    const dup = installBridgeSelection(baseArgs(tmpProject(), [], { others: [{ ...LOCAL, agentId: "dup-one" }, { ...LOCAL, agentId: "dup-one" }] }));
    assert.equal(dup.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Other: env var names and base URL follow the custom-endpoint rules", () => {
  assert.ok(validateOtherSpec({ ...LOCAL, endpointEnv: "OLLAMA_URL" }, []).length > 0);
  assert.ok(validateOtherSpec({ ...LOCAL, endpointEnv: "ollama_base_url" }, []).length > 0);
  assert.ok(validateOtherSpec({ ...LOCAL, apiKeyEnv: "GITHUB_TOKEN" }, []).length > 0);
  assert.ok(validateOtherSpec({ ...LOCAL, apiKeyEnv: "OLLAMA_PASSWORD" }, []).length > 0);
  assert.ok(validateOtherSpec({ ...LOCAL, apiKeyEnv: "XAI_API_KEY" }, []).length > 0, "a fixed vendor's key may not be redirected to a custom endpoint");
  assert.deepEqual(validateOtherSpec({ ...LOCAL, apiKeyEnv: undefined }, []), [], "the key variable is optional");
  assert.deepEqual(validateOtherSpec({ ...LOCAL, baseUrl: "http://localhost:11434/v1" }, []), []);
  assert.deepEqual(validateOtherSpec({ ...LOCAL, baseUrl: "https://api.example.com/v1" }, []), []);
  assert.ok(validateOtherSpec({ ...LOCAL, baseUrl: "http://192.168.1.5:11434" }, []).length > 0);
  assert.ok(validateOtherSpec({ ...LOCAL, baseUrl: "https://user:pw@example.com/v1" }, []).length > 0);
  assert.ok(validateOtherSpec({ ...LOCAL, model: "xai/grok" }, []).length > 0, "built-in vendor prefixes route to fixed endpoints");
  assert.ok(validateOtherSpec({ ...LOCAL, model: "bad model;rm" }, []).length > 0);
});

test("Other: the agent file carries env var NAMES only and round-trips as a custom openai-compatible backend", () => {
  const root = tmpProject();
  try {
    const secretUrl = "http://localhost:11434/v1";
    const stored: Array<[string, string]> = [];
    const res = installBridgeSelection(
      baseArgs(root, [], { others: [{ ...LOCAL, baseUrl: secretUrl }], storeLocalValue: (n, v) => stored.push([n, v]) }),
    );
    assert.equal(res.ok, true, res.errors.join(";"));
    const text = fs.readFileSync(path.join(root, ".claude", "agents", "local-llama.md"), "utf8");
    const backend = parseAgentBackend(readAgentFrontmatter(text));
    assert.equal(backend.vendor, "custom");
    assert.equal(backend.transport, "openai-compatible");
    assert.equal(backend.mcpServer, "openai-compatible");
    assert.equal(backend.endpointEnv, "OLLAMA_BASE_URL");
    assert.equal(backend.apiKeyEnv, "OLLAMA_API_KEY");
    assert.equal(backend.model, "custom/llama3");
    assert.match(text, /OLLAMA_BASE_URL/);
    assert.ok(!text.includes(secretUrl) && !text.includes("11434"), "the base URL value never reaches the agent file");
    assert.ok(!fs.readFileSync(path.join(root, ".mcp.json"), "utf8").includes("11434"), "nor .mcp.json");
    assert.deepEqual(stored, [["OLLAMA_BASE_URL", secretUrl]], "the value goes to the per-user store seam only");
    assert.match(text, /^tycoon_pack: multi-llm$/m);
    assert.match(text, /## Keywords \(for task routing\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Other: more than one Other agent can be added, with a single shared server", () => {
  const root = tmpProject();
  try {
    const calls: string[] = [];
    const res = installBridgeSelection(
      baseArgs(root, calls, {
        others: [LOCAL, { agentId: "lm-studio", label: "LM Studio", model: "qwen2.5-coder", endpointEnv: "LMSTUDIO_BASE_URL", keywords: "lmstudio, local" }],
      }),
    );
    assert.equal(res.ok, true, res.errors.join(";"));
    assert.deepEqual(agentFiles(root), ["lm-studio.md", "local-llama.md"]);
    assert.deepEqual(calls, ["openai-compatible"]);
    const lm = parseAgentBackend(readAgentFrontmatter(fs.readFileSync(path.join(root, ".claude", "agents", "lm-studio.md"), "utf8")));
    assert.equal(lm.apiKeyEnv, undefined, "keyless local server");
    assert.equal(buildOtherAgent({ agentId: "lm-studio", label: "LM Studio", model: "m", endpointEnv: "LMSTUDIO_BASE_URL", keywords: "lmstudio, local" }).keywords, "lmstudio|local");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Other: shows in the picker with the same status badge data", () => {
  const root = tmpProject();
  try {
    installBridgeSelection(baseArgs(root, [], { others: [LOCAL] }));
    const probe = () => ({});
    const p = buildBridgePicker(PACK_AGENTS, { root, harness: "claude-code", env: {}, probe });
    assert.equal(p.others.length, 1);
    assert.equal(p.others[0].agentId, "local-llama");
    assert.equal(p.others[0].setup!.keyState, "missing", "base URL variable not set yet");
    assert.ok(p.others[0].setup!.env.some((e) => e.name === "OLLAMA_BASE_URL" && e.required && !e.present));
    const ok = describeBridgeSetup({ root, harness: "claude-code", env: {}, probe: (names) => Object.fromEntries(names.map((n) => [n, { env: false, stored: true }])) });
    assert.equal(ok["local-llama"].needsSetup, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("message schema: installPack accepts a picker selection and rejects unknown fields on an Other spec", () => {
  const good = MSG_SCHEMAS.INSTALL_PACK.safeParse({ type: "installPack", id: "multi-llm", selection: { agents: ["codex-reviewer"], others: [LOCAL] } });
  assert.equal(good.success, true);
  const bad = MSG_SCHEMAS.INSTALL_PACK.safeParse({ type: "installPack", id: "multi-llm", selection: { others: [{ ...LOCAL, apiKey: "sk-secret" }] } });
  assert.equal(bad.success, false, "a key value field is rejected, not ignored");
  assert.equal(MSG_SCHEMAS.INSTALL_BRIDGE_SERVER.safeParse({ type: "installBridgeServer", id: "codex-reviewer" }).success, true);
});

// ---------------------------------------------------------------------------
// Review fixes: unreadable .mcp.json, atomic write, reserved names, store conflicts.
// ---------------------------------------------------------------------------

const PLAIN_DEPS = {
  platform: process.platform,
  resolveTokens: (c: unknown) => c,
  finalize: (_i: string, c: unknown) => c,
  afterWrite: () => undefined,
};

test("an unparseable .mcp.json is never overwritten: install is skipped with a clear message", () => {
  const root = tmpProject();
  try {
    const bad = "{ not json";
    fs.writeFileSync(path.join(root, ".mcp.json"), bad);
    const out = installMcpEntry(root, "codex", MCP_CATALOG, PLAIN_DEPS);
    assert.ok(typeof out === "object" && out.status === "skipped");
    assert.match((out as { error: string }).error, /Couldn't read \.mcp\.json/);
    assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), bad);
    // A JSON array / scalar is also not a usable config.
    fs.writeFileSync(path.join(root, ".mcp.json"), "[]");
    assert.ok(typeof installMcpEntry(root, "codex", MCP_CATALOG, PLAIN_DEPS) === "object");
    assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), "[]");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installMcpEntry writes atomically (temp + rename) and cleans the temp file when the write fails", () => {
  const root = tmpProject();
  try {
    const seen: string[] = [];
    const ok = installMcpEntry(root, "codex", MCP_CATALOG, {
      ...PLAIN_DEPS,
      fsOps: {
        writeFileSync: ((p: any, d: any) => { seen.push("write:" + path.basename(String(p))); fs.writeFileSync(p, d); }) as typeof fs.writeFileSync,
        renameSync: ((a: any, b: any) => { seen.push("rename:" + path.basename(String(b))); fs.renameSync(a, b); }) as typeof fs.renameSync,
        unlinkSync: fs.unlinkSync,
      },
    });
    assert.equal(ok, "installed");
    assert.match(seen[0], /^write:\.mcp\.json\..*\.tmp$/);
    assert.equal(seen[1], "rename:.mcp.json");
    assert.deepEqual(mcpServers(root), ["codex"]);
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith(".tmp")), []);

    const root2 = tmpProject();
    try {
      fs.writeFileSync(path.join(root2, ".mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "x" } } }));
      const failed = installMcpEntry(root2, "codex", MCP_CATALOG, {
        ...PLAIN_DEPS,
        fsOps: {
          writeFileSync: ((p: any, d: any) => { fs.writeFileSync(p, d); }) as typeof fs.writeFileSync,
          renameSync: (() => { throw new Error("EPERM"); }) as typeof fs.renameSync,
          unlinkSync: fs.unlinkSync,
        },
      });
      assert.ok(typeof failed === "object" && failed.status === "skipped");
      assert.deepEqual(mcpServers(root2), ["keep"], "original file untouched");
      assert.deepEqual(fs.readdirSync(root2).filter((f) => f.endsWith(".tmp")), [], "temp cleaned up");
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Other: Windows reserved device names are rejected, case-insensitively", () => {
  const names = ["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)];
  for (const n of names) {
    assert.ok(validateOtherSpec({ ...LOCAL, agentId: n }, []).length > 0, n);
    assert.ok(validateOtherSpec({ ...LOCAL, agentId: n.toUpperCase() }, []).length > 0, n.toUpperCase());
  }
  assert.deepEqual(validateOtherSpec({ ...LOCAL, agentId: "console" }, []), []);
});

test("Other: a different value already stored for the base URL variable is not overwritten silently", () => {
  const root = tmpProject();
  try {
    const stored: Array<[string, string]> = [];
    const spec = { ...LOCAL, baseUrl: "http://localhost:11434/v1" };
    const conflict = installBridgeSelection(
      baseArgs(root, [], { others: [spec], storeLocalValue: (n, v) => stored.push([n, v]), getLocalValue: () => "https://other.example.com/v1" }),
    );
    assert.equal(conflict.ok, false);
    assert.match(conflict.errors.join(" "), /different base URL variable name/);
    assert.equal(stored.length, 0);
    assert.equal(agentFiles(root).length, 0, "nothing installed on a conflict");
    const same = installBridgeSelection(
      baseArgs(root, [], { others: [spec], storeLocalValue: (n, v) => stored.push([n, v]), getLocalValue: () => "http://localhost:11434/v1" }),
    );
    assert.equal(same.ok, true, same.errors.join(";"));
    const fresh = installBridgeSelection(
      baseArgs(root, [], { others: [{ ...spec, agentId: "another-one" }], storeLocalValue: (n, v) => stored.push([n, v]), getLocalValue: () => undefined }),
    );
    assert.equal(fresh.ok, true, fresh.errors.join(";"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
