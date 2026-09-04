/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRoutingProfile,
  resolveAgentSlot,
  resolveOrchestratorSlot,
  routingSlotToBackend,
} from "../src/core/routingProfile";
import type { Backend } from "../src/core/agentBackend";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "routing-profile-"));
}

function writeRouting(root: string, content: string): string {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "routing.json");
  fs.writeFileSync(p, content);
  return p;
}

function writeRoutingObj(root: string, obj: unknown): string {
  return writeRouting(root, JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// 1. Absent file
// ---------------------------------------------------------------------------

test("loadRoutingProfile: absent file yields null profile and no errors", () => {
  const root = tmpRoot();
  const { profile, errors, path: p } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.deepEqual(errors, []);
  assert.ok(p.includes("routing.json"));
});

// ---------------------------------------------------------------------------
// 2. Invalid JSON
// ---------------------------------------------------------------------------

test("loadRoutingProfile: invalid JSON yields null profile and one error", () => {
  const root = tmpRoot();
  writeRouting(root, "{ not valid json ,,,");
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.equal(errors.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Version mismatch
// ---------------------------------------------------------------------------

test("loadRoutingProfile: version !== 1 produces an error naming version", () => {
  const root = tmpRoot();
  writeRoutingObj(root, { version: 2, agents: {} });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /version/i.test(e)));
});

// ---------------------------------------------------------------------------
// 4. agents not an object
// ---------------------------------------------------------------------------

test("loadRoutingProfile: agents not an object produces an error", () => {
  const root = tmpRoot();
  writeRoutingObj(root, { version: 1, agents: "not-an-object" });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /agents/i.test(e)));
});

// ---------------------------------------------------------------------------
// 5. Wrong field type, path named
// ---------------------------------------------------------------------------

test("loadRoutingProfile: wrong field type names the JSON path", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: { "coding-specialist": { model: 12345 } },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => e.includes("agents.coding-specialist.model")));
});

// ---------------------------------------------------------------------------
// 6. transport outside enum
// ---------------------------------------------------------------------------

test("loadRoutingProfile: transport outside enum is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: { foo: { transport: "carrier-pigeon" } },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => e.includes("agents.foo.transport")));
});

// ---------------------------------------------------------------------------
// 7. costModelClass outside enum
// ---------------------------------------------------------------------------

test("loadRoutingProfile: costModelClass outside enum is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: { foo: { costModelClass: "priceless" } },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => e.includes("agents.foo.costModelClass")));
});

// ---------------------------------------------------------------------------
// 8. fallback deeper than 3
// ---------------------------------------------------------------------------

test("loadRoutingProfile: fallback nesting deeper than 3 is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      foo: {
        vendor: "a",
        fallback: [
          {
            vendor: "b",
            fallback: [
              {
                vendor: "c",
                fallback: [
                  { vendor: "d", fallback: [{ vendor: "e" }] },
                ],
              },
            ],
          },
        ],
      },
    },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.length > 0);
});

// ---------------------------------------------------------------------------
// 9. secret-like property at top level
// ---------------------------------------------------------------------------

test("loadRoutingProfile: secret-like property name at top level is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    apiKey: "sk-should-not-be-here",
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /secrets must not be stored/i.test(e)));
});

// ---------------------------------------------------------------------------
// 10. secret-like property inside a slot
// ---------------------------------------------------------------------------

test("loadRoutingProfile: secret-like property inside a slot is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: { foo: { vendor: "a", token: "abc123" } },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /secrets must not be stored/i.test(e)));
});

// ---------------------------------------------------------------------------
// 11. secret-key rejection nested inside fallback depth
// ---------------------------------------------------------------------------

test("loadRoutingProfile: secret-like property nested inside a fallback entry is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      foo: {
        vendor: "a",
        fallback: [
          {
            vendor: "b",
            fallback: [{ vendor: "c", password: "hunter2" }],
          },
        ],
      },
    },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /secrets must not be stored/i.test(e)));
});

// ---------------------------------------------------------------------------
// 12. credentialEnv / endpointEnv are NOT flagged as secrets
// ---------------------------------------------------------------------------

test("loadRoutingProfile: credentialEnv and endpointEnv are exempt from the secret check", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      foo: {
        vendor: "a",
        credentialEnv: "MY_API_KEY_ENV",
        endpointEnv: "MY_ENDPOINT_ENV",
      },
    },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.deepEqual(errors, []);
  assert.ok(profile);
  assert.equal(profile!.agents.foo.credentialEnv, "MY_API_KEY_ENV");
});

// ---------------------------------------------------------------------------
// 13. Valid full example with orchestrator, 2-level fallback
// ---------------------------------------------------------------------------

test("loadRoutingProfile: valid full profile parses with orchestrator and nested fallback", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    orchestrator: {
      vendor: "opencode",
      transport: "openai-compatible",
      model: "opencode/big-pickle",
      costModelClass: "metered",
      endpointEnv: "OPENCODE_ENDPOINT",
      credentialEnv: "OPENCODE_API_KEY",
    },
    agents: {
      "coding-specialist": {
        vendor: "anthropic",
        transport: "claude-native",
        model: "anthropic/sonnet",
        costModelClass: "subscription",
        fallback: [
          {
            vendor: "openai",
            transport: "openai-compatible",
            model: "openai/gpt-5.4-mini",
            costModelClass: "metered",
            endpointEnv: "OPENAI_ENDPOINT",
            fallback: [
              {
                vendor: "moonshot",
                transport: "openai-compatible",
                model: "moonshot/kimi-k2",
                costModelClass: "local",
              },
            ],
          },
        ],
      },
    },
    defaults: {
      vendor: "anthropic",
      model: "anthropic/haiku",
      costModelClass: "subscription",
    },
  });

  const { profile, errors } = loadRoutingProfile(root);
  assert.deepEqual(errors, []);
  assert.ok(profile);
  assert.equal(profile!.version, 1);
  assert.equal(profile!.orchestrator?.model, "opencode/big-pickle");
  assert.equal(profile!.agents["coding-specialist"].fallback?.[0].fallback?.[0].vendor, "moonshot");
});

// ---------------------------------------------------------------------------
// resolveAgentSlot
// ---------------------------------------------------------------------------

test("resolveAgentSlot: defaults merged under the agent's slot, agent field wins", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      "coding-specialist": { model: "anthropic/opus" },
    },
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile!, "coding-specialist");
  assert.ok(slot);
  assert.equal(slot!.model, "anthropic/opus");
  assert.equal(slot!.vendor, "anthropic");
  assert.equal(slot!.costModelClass, "subscription");
});

test("resolveAgentSlot: no entry and no defaults.model resolves to null", () => {
  const root = tmpRoot();
  writeRoutingObj(root, { version: 1, agents: {} });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile!, "unknown-agent");
  assert.equal(slot, null);
});

test("resolveAgentSlot: no entry but defaults.model present resolves from defaults", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile!, "unknown-agent");
  assert.ok(slot);
  assert.equal(slot!.model, "anthropic/haiku");
});

// ---------------------------------------------------------------------------
// resolveOrchestratorSlot
// ---------------------------------------------------------------------------

test("resolveOrchestratorSlot: defaults merged under orchestrator", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    orchestrator: { model: "opencode/big-pickle" },
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveOrchestratorSlot(profile!);
  assert.ok(slot);
  assert.equal(slot!.model, "opencode/big-pickle");
  assert.equal(slot!.vendor, "anthropic");
});

test("resolveOrchestratorSlot: no orchestrator and no defaults.model resolves to null", () => {
  const root = tmpRoot();
  writeRoutingObj(root, { version: 1, agents: {} });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveOrchestratorSlot(profile!);
  assert.equal(slot, null);
});

// ---------------------------------------------------------------------------
// routingSlotToBackend
// ---------------------------------------------------------------------------

test("routingSlotToBackend: maps credentialEnv to apiKeyEnv and matches Backend field names", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      foo: {
        vendor: "opencode",
        transport: "openai-compatible",
        model: "opencode/big-pickle",
        costModelClass: "metered",
        endpointEnv: "OPENCODE_ENDPOINT",
        credentialEnv: "OPENCODE_API_KEY",
        tools: ["Read", "Edit"],
      },
    },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile!, "foo");
  assert.ok(slot);
  const backend: Backend = routingSlotToBackend(slot!);
  assert.equal(backend.vendor, "opencode");
  assert.equal(backend.transport, "openai-compatible");
  assert.equal(backend.model, "opencode/big-pickle");
  assert.equal(backend.costModelClass, "metered");
  assert.equal(backend.endpointEnv, "OPENCODE_ENDPOINT");
  assert.equal(backend.apiKeyEnv, "OPENCODE_API_KEY");
  assert.deepEqual(backend.tools, ["Read", "Edit"]);
  assert.equal((backend as unknown as Record<string, unknown>).credentialEnv, undefined);
});
