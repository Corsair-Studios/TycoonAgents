/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentMarkdown, LEAD_AGENTS, type PackAgent } from "../src/host/vscode/packCatalog";

// panel.ts does `import * as vscode from "vscode"` at module scope (needed by
// the rest of the class), but the two private methods under test here —
// `_installAgentFiles` and its only dependency `_readKeywordsConfig` — never
// touch the vscode API themselves (verified: both are pure fs/path). Stub the
// module loader (same technique as test/reviewSynthesis.test.ts) so this
// file's require of panel.js resolves under plain `node --test`, and we
// exercise the REAL production method rather than a reimplementation of it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) {
        target[prop] = new Proxy(function stub() {}, handler);
      }
      return target[prop];
    },
    apply() {
      return new Proxy({}, handler);
    },
    construct() {
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler);
}
const vscodeStub = makeVscodeStub();
NodeModule._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TycoonPanel } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelAgentFileInstall-"));
}

// `_installAgentFiles` only calls `this._readKeywordsConfig(root)`, which is
// itself pure fs/path (no other `this.*` access) — a minimal receiver
// carrying just that one bound method is enough to invoke the real method
// under test without constructing a full TycoonPanel (whose constructor does
// real webview/watcher setup that would need a much larger vscode stub).
function callInstallAgentFiles(root: string, agents: PackAgent[]): void {
  const fakeThis = {
    _readKeywordsConfig: (TycoonPanel.prototype as any)._readKeywordsConfig,
  };
  (TycoonPanel.prototype as any)._installAgentFiles.call(fakeThis, root, agents);
}

const leadAgent: PackAgent = LEAD_AGENTS[0]; // build-lead, tier: "lead"

function agentPathFor(root: string, agent: PackAgent): string {
  return path.join(root, ".claude", "agents", `${agent.id}.md`);
}

test("_installAgentFiles creates the agent file when absent", () => {
  const root = tmpRoot();
  try {
    callInstallAgentFiles(root, [leadAgent]);
    const p = agentPathFor(root, leadAgent);
    assert.ok(fs.existsSync(p), "agent file must be created");
    assert.equal(fs.readFileSync(p, "utf8"), buildAgentMarkdown(leadAgent));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installAgentFiles refreshes an existing OUR file (matching tier) with stale content", () => {
  const root = tmpRoot();
  try {
    const p = agentPathFor(root, leadAgent);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Simulate a pre-fix install: our tier marker present, but frontmatter
    // predates the name/description fix (the exact shape of the bug this
    // change repairs).
    const stale = "---\nmodel: sonnet\ntier: lead\n---\n\n# Build Lead\n\nSTALE BODY\n";
    fs.writeFileSync(p, stale);

    callInstallAgentFiles(root, [leadAgent]);

    const after = fs.readFileSync(p, "utf8");
    assert.equal(after, buildAgentMarkdown(leadAgent), "stale OUR file must be refreshed to current output");
    assert.ok(after.includes(`name: ${leadAgent.id}\n`), "refreshed file must carry the name: frontmatter fix");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installAgentFiles leaves a foreign/legacy same-named file byte-unchanged", () => {
  const root = tmpRoot();
  try {
    const p = agentPathFor(root, leadAgent);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // No tier: line at all -> not provably ours (a user's own build-lead.md).
    const foreign = "---\nmodel: opus\n---\n\n# My Own Build Lead\n\nDo not touch this.\n";
    fs.writeFileSync(p, foreign);

    callInstallAgentFiles(root, [leadAgent]);

    assert.equal(fs.readFileSync(p, "utf8"), foreign, "foreign file (no matching tier) must be left byte-unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installAgentFiles leaves a file with a DIFFERENT tier byte-unchanged", () => {
  const root = tmpRoot();
  try {
    const p = agentPathFor(root, leadAgent);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // tier: reviewer while leadAgent.tier is "lead" -> mismatched, not ours for this id.
    const mismatched = "---\nname: build-lead\ndescription: \"x\"\nmodel: sonnet\ntier: reviewer\n---\n\nbody\n";
    fs.writeFileSync(p, mismatched);

    callInstallAgentFiles(root, [leadAgent]);

    assert.equal(fs.readFileSync(p, "utf8"), mismatched, "tier-mismatched file must be left byte-unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installAgentFiles is idempotent — an already-current file is not rewritten", () => {
  const root = tmpRoot();
  try {
    const p = agentPathFor(root, leadAgent);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buildAgentMarkdown(leadAgent));

    // fs.writeFileSync is non-configurable on this Node's `fs` module object
    // (can't be spied via reassignment/defineProperty), so prove "no rewrite"
    // via mtime instead: stamp an arbitrary, deterministic past mtime, then
    // assert it is UNCHANGED after the call. A real rewrite would bump the
    // mtime to "now"; a skip leaves the stamped value exactly as set.
    const stampedMtime = new Date(2000, 0, 1);
    fs.utimesSync(p, stampedMtime, stampedMtime);
    const mtimeBefore = fs.statSync(p).mtimeMs;

    callInstallAgentFiles(root, [leadAgent]);

    const mtimeAfter = fs.statSync(p).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore, "no rewrite when existing content already matches desired output");
    assert.equal(fs.readFileSync(p, "utf8"), buildAgentMarkdown(leadAgent));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_installAgentFiles still writes the keyword routing entry for every agent, including left-alone foreign files", () => {
  const root = tmpRoot();
  try {
    const p = agentPathFor(root, leadAgent);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "---\nmodel: opus\n---\n\nforeign\n");

    callInstallAgentFiles(root, [leadAgent]);

    const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
    const cfg = JSON.parse(fs.readFileSync(keywordsPath, "utf8"));
    assert.equal(cfg.agents[leadAgent.id].pattern, leadAgent.keywords);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
