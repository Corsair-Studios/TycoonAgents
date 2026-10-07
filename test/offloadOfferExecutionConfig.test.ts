/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// p102-t3: the credit-pressure offload offer was removed. Projects that ran an
// older build may still carry `offloadOfferDismissed` / `offloadOfferAccepted`
// in .claude/tycoon/execution.json. This pins that such files still load and
// that the surviving merge-writers keep (never choke on) those legacy keys.

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
const { seedProjectPlanEnabledDefault } = require("../src/host/vscode/panel") as typeof import("../src/host/vscode/panel");

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "offloadOfferExecutionConfig-"));
}

test("legacy execution.json with offload-offer keys still loads: seeding preserves them and sets projectPlanEnabled", () => {
  const root = tmpRoot();
  try {
    const configPath = path.join(root, ".claude", "tycoon", "execution.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ delegation_mode: "flat", offloadOfferDismissed: true, offloadOfferAccepted: true }, null, 2),
    );
    seedProjectPlanEnabledDefault(root);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.projectPlanEnabled, true);
    assert.equal(config.delegation_mode, "flat");
    assert.equal(config.offloadOfferDismissed, true, "legacy key is kept, not choked on");
    assert.equal(config.offloadOfferAccepted, true, "legacy key is kept, not choked on");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
