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

/*
 * Coverage for `_detectLegacyArtifactsOnLoad` (src/host/vscode/panel.ts,
 * ~7439-7456), the once-per-panel-open wrapper around the pre-existing
 * `_detectLegacyArtifacts` scan (Hook Doctor's "Run Doctor" uses the same
 * scan). Delivery of the resulting notice as MSG.LEGACY_ARTIFACTS_DETECTED
 * happens in the MSG.READY handler and is NOT covered here — it is pure
 * `this._panel.webview.postMessage(...)` wiring around a real vscode
 * WebviewPanel, which this file's headless technique cannot construct (see
 * the note at the bottom of this file). `_detectLegacyArtifactsOnLoad`
 * itself is reachable headlessly because it only touches `this._projectRoot`,
 * `this._readSettingsTolerant`, and `this._detectLegacyArtifacts` — none of
 * which reference `vscode` — using the same "bind private prototype methods
 * onto a fakeThis, call with .call(fakeThis)" technique as
 * test/panelUrcIgnore.test.ts's `_handleAddGitignoreEntries` coverage.
 */

// panel.ts does `import * as vscode from "vscode"` at module scope. Stub the
// module loader (same technique as test/panelUrcIgnore.test.ts) so this
// file's require of panel.js resolves under plain `node --test`.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelLegacyArtifactsNotice-"));
}

function callDetectOnLoad(overrides: { projectRoot?: string; detectLegacyArtifacts?: unknown } = {}): { artifactCount: number; foreignHookCount: number } | null {
  const fakeThis = {
    _projectRoot: () => overrides.projectRoot ?? "",
    _readSettingsTolerant: (TycoonPanel.prototype as any)._readSettingsTolerant,
    _detectLegacyArtifacts:
      overrides.detectLegacyArtifacts ?? (TycoonPanel.prototype as any)._detectLegacyArtifacts,
  };
  return (TycoonPanel.prototype as any)._detectLegacyArtifactsOnLoad.call(fakeThis);
}

test("_detectLegacyArtifactsOnLoad returns null when no workspace root is open (empty project root)", () => {
  const result = callDetectOnLoad({ projectRoot: "" });
  assert.equal(result, null);
});

test("_detectLegacyArtifactsOnLoad returns null for a clean project with no .claude dir at all", () => {
  const root = tmpRoot();
  try {
    const result = callDetectOnLoad({ projectRoot: root });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad returns null for a project with a .claude dir but zero leftover artifacts", () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    const result = callDetectOnLoad({ projectRoot: root });
    assert.equal(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad counts known legacy state files (e.g. hook-config.json, active-agent.json)", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "hook-config.json"), "{}");
    fs.writeFileSync(path.join(claudeDir, "active-agent.json"), "{}");

    const result = callDetectOnLoad({ projectRoot: root });
    assert.ok(result, "expected a non-null notice once leftover files exist");
    assert.equal(result?.artifactCount, 2);
    assert.equal(result?.foreignHookCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad counts orphaned agent-activity-*.json spool files", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "agent-activity-abc123.json"), "[]");
    fs.writeFileSync(path.join(claudeDir, "agent-activity-def456.json"), "[]");
    // A file that merely contains the substring but doesn't match the
    // pattern anchors must not be counted.
    fs.writeFileSync(path.join(claudeDir, "not-agent-activity-shaped.txt"), "x");

    const result = callDetectOnLoad({ projectRoot: root });
    assert.ok(result);
    assert.equal(result?.artifactCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad counts foreign hook commands wired into settings.local.json", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "node .claude/hooks/session-stop.cjs" }],
            },
          ],
        },
      })
    );

    const result = callDetectOnLoad({ projectRoot: root });
    assert.ok(result, "expected a non-null notice once a foreign hook command is wired in");
    assert.equal(result?.artifactCount, 0);
    assert.equal(result?.foreignHookCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad combines leftover files and foreign hook commands from both settings files", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "agent-registry.json"), "{}");
    fs.writeFileSync(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "node .claude/hooks/task-stop.cjs" }] }] },
      })
    );
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SubagentStop: [
            { matcher: "", hooks: [{ type: "command", command: "node .claude/hooks/teammate-idle.cjs" }] },
          ],
        },
      })
    );

    const result = callDetectOnLoad({ projectRoot: root });
    assert.ok(result);
    assert.equal(result?.artifactCount, 1);
    assert.equal(result?.foreignHookCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad does not count our OWN tycoon-claude-hook.cjs command as foreign", () => {
  const root = tmpRoot();
  try {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "node .claude/tycoon/tycoon-claude-hook.cjs Stop" }] }],
        },
      })
    );

    const result = callDetectOnLoad({ projectRoot: root });
    assert.equal(result, null, "our own hook command must never be reported as a leftover foreign artifact");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad swallows any scan failure and returns null rather than throwing", () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    const result = callDetectOnLoad({
      projectRoot: root,
      detectLegacyArtifacts: () => {
        throw new Error("simulated scan failure");
      },
    });
    assert.equal(result, null, "a throwing scan must resolve to null, never propagate");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("_detectLegacyArtifactsOnLoad swallows a throwing _projectRoot and returns null rather than throwing", () => {
  const fakeThis = {
    _projectRoot: () => {
      throw new Error("simulated projectRoot failure");
    },
    _readSettingsTolerant: (TycoonPanel.prototype as any)._readSettingsTolerant,
    _detectLegacyArtifacts: (TycoonPanel.prototype as any)._detectLegacyArtifacts,
  };
  const result = (TycoonPanel.prototype as any)._detectLegacyArtifactsOnLoad.call(fakeThis);
  assert.equal(result, null);
});

/*
 * NOT covered here, stated plainly: the MSG.READY handler's delivery of
 * MSG.LEGACY_ARTIFACTS_DETECTED (panel.ts ~694-710) — reading
 * `this._pendingLegacyArtifactsNotice` and calling
 * `this._panel.webview.postMessage(...)`. That handler is a closure captured
 * inside the real `TycoonPanel` constructor over a real
 * `vscode.WebviewPanel` (`this._panel`), registered via
 * `webview.onDidReceiveMessage`. Reaching it headlessly would require either
 * fully constructing a TycoonPanel (which the vscode Proxy stub above cannot
 * provide a working webview/onDidReceiveMessage/postMessage triple for — the
 * constructor also touches ExtensionContext, globalState, and multiple other
 * real vscode surfaces well beyond the scope of this fix) or extracting that
 * handler into a standalone, injectable function the way
 * `_detectLegacyArtifactsOnLoad` itself already is. A future refactor that
 * wants this path headlessly testable should pull the MSG.READY body's
 * "if (this._pendingLegacyArtifactsNotice) { ... }" block out into its own
 * private method (e.g. `_deliverPendingLegacyArtifactsNotice(postMessage)`)
 * taking the post function as a parameter, mirroring how
 * `_detectLegacyArtifactsOnLoad` was itself split out of `_detectLegacyArtifacts`.
 */
