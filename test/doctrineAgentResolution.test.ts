/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Doctrine generation fixes: review/edit id resolution, journal exception,
// delegation-language guard, and roster freshness after a pack install.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module");
const originalLoad = NodeModule._load;
function makeVscodeStub(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === "__esModule") return true;
      if (!(prop in target)) target[prop] = new Proxy(function stub() {}, handler);
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
import { renderDelegationDoctrine, type DoctrineRosterAgent } from "../src/host/vscode/delegationDoctrine";

const row = (id: string): DoctrineRosterAgent => ({ id, taskTypes: `${id}-keywords` });

test("review id: reviewer, else uefn-auditor (any project), else testing-specialist, else Fallback Agent", () => {
  const withReviewer = renderDelegationDoctrine("flat", true, [row("testing-specialist")], "reviewer");
  assert.match(withReviewer, /the `reviewer` agent/);
  const audit = renderDelegationDoctrine("flat", true, [row("uefn-auditor"), row("testing-specialist")], undefined, 3, false, false);
  assert.match(audit, /the `uefn-auditor` agent/);
  const testing = renderDelegationDoctrine("flat", true, [row("testing-specialist")], undefined, 3, false, false);
  assert.match(testing, /the `testing-specialist` agent/);
  const none = renderDelegationDoctrine("flat", true, [row("search-retrieval")], undefined, 3, false, false);
  assert.match(none, /routes the\nchange to the review agent \(the Fallback Agent when no reviewer is installed\) for a correctness/);
});

test("panel _resolveReviewAgentId follows file existence in the same order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewId-"));
  const agents = path.join(root, ".claude", "agents");
  fs.mkdirSync(agents, { recursive: true });
  const resolve = (): string | undefined =>
    (TycoonPanel.prototype as unknown as { _resolveReviewAgentId(r: string): string | undefined })._resolveReviewAgentId.call({}, root);
  assert.equal(resolve(), undefined);
  fs.writeFileSync(path.join(agents, "testing-specialist.md"), "---\nname: testing-specialist\n---\n");
  assert.equal(resolve(), "testing-specialist");
  fs.writeFileSync(path.join(agents, "uefn-auditor.md"), "---\nname: uefn-auditor\n---\n");
  assert.equal(resolve(), "uefn-auditor");
  fs.writeFileSync(path.join(agents, "reviewer.md"), "---\nname: reviewer\n---\n");
  assert.equal(resolve(), "reviewer");
});

test("edit id: verse-expert only on a UEFN project; otherwise the Fallback Agent", () => {
  const roster = [row("verse-expert"), row("search-retrieval")];
  const nonUefn = renderDelegationDoctrine("flat", false, roster, undefined, 3, false, false);
  assert.match(nonUefn, /ALWAYS delegate to the appropriate specialist \(see the roster below\), or the Fallback Agent if none fits\.\*\*/);
  assert.match(nonUefn, /including docs and markdown → the appropriate specialist \(see the roster below\), or the Fallback Agent if none fits\./);
  assert.doesNotMatch(nonUefn, /ALWAYS delegate to verse-expert/);
  const uefn = renderDelegationDoctrine("flat", false, roster, undefined, 3, false, true);
  assert.match(uefn, /ALWAYS delegate to verse-expert\.\*\*/);
  const coding = renderDelegationDoctrine("flat", false, [row("coding-specialist"), row("verse-expert")], undefined, 3, false, false);
  assert.match(coding, /ALWAYS delegate to coding-specialist\.\*\*/);
});

test("doctrine permits the orchestrator to write the session-journal summary", () => {
  const out = renderDelegationDoctrine("flat", true, [row("coding-specialist")]);
  assert.match(out, /The single allowed direct write: you may update the `summary` field of\n`\.claude\/session-journal\.json` yourself/);
});

test("delegation-language guard: pre-existing doctrine sentences are all still present", () => {
  const out = renderDelegationDoctrine("flat", true, [row("coding-specialist"), row("testing-specialist")]);
  const must = [
    "Delegate implementation work to specialist agents via the Task tool rather\nthan doing it inline.",
    "This is MANDATORY, not a\npreference — the orchestrator coordinates work, it does not do the work.",
    "**NEVER Edit or Write files directly — ALWAYS delegate to coding-specialist.**",
    "**NEVER grep, glob, search, or read across multiple files to understand the\ncode yourself — ALWAYS delegate to search-retrieval (Haiku).**",
    "The ONLY reads you may do directly are a SINGLE, specific, already-known\nfile path.",
    "Reading three or more files to answer one question is a survey, not a\nlookup. Delegate it.",
    "You may also ANSWER A ONE-OFF QUESTION directly.",
    "Anything that does not clearly match a specialist's keywords → the Fallback Agent, per the rule below — never yourself.",
    "A change is always verified by someone other than the agent that authored",
    "is a single review gate, not an open-ended loop",
    "The user is the final reviewer",
    "### Review model tiering",
  ];
  for (const m of must) assert.ok(out.includes(m), `missing: ${m}`);
});

test("roster includes web-qa right after a Playwright QA pack install (no panel reopen)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packRoster-"));
  const claudeDir = path.join(root, ".claude");
  fs.mkdirSync(path.join(claudeDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "tycoon"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, "settings.local.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "tycoon-claude-hook.cjs" }] }] } })
  );
  // The Proxy stub is a thenable when awaited; give the confirm modal a real answer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (vscodeStub as any).window.showWarningMessage = async () => "Install";
  const proto = TycoonPanel.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  let healed = 0;
  const posted: unknown[] = [];
  const self = Object.create(TycoonPanel.prototype) as Record<string, unknown>;
  Object.assign(self, {
    _extensionUri: { fsPath: path.resolve(__dirname, "..", "..") },
    _panel: { webview: { postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); } } },
    _projectRoot: () => root,
    _runtime: { ingest: () => undefined },
    _disposed: false,
    _useLocalMcp: () => false,
    _registerLocalMcpConfig: async () => undefined,
  });
  const realHeal = proto._healKeywordsThenDoctrine;
  self._healKeywordsThenDoctrine = (...a: unknown[]) => {
    healed++;
    return realHeal.apply(self, a);
  };
  await proto._handleInstallPack.call(self, "playwright", true);
  const result = posted.find((m) => (m as { id?: string }).id === "playwright") as { ok?: boolean; error?: string } | undefined;
  assert.ok(result?.ok, `install failed: ${JSON.stringify(result)}`);
  assert.equal(healed >= 1, true, "install handler must call _healKeywordsThenDoctrine");
  assert.ok(fs.existsSync(path.join(claudeDir, "agents", "web-qa.md")));
  const claudeMd = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.match(claudeMd, /\| web-qa \|/);
});
