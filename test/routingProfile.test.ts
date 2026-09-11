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
  hasHandWrittenBackendBlock,
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
// p25-t2: top-level defaultFallback
// ---------------------------------------------------------------------------

test("loadRoutingProfile: valid top-level defaultFallback loads", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaultFallback: {
      vendor: "openai",
      transport: "openai-compatible",
      model: "openai/gpt-5.4-mini",
      costModelClass: "metered",
      endpointEnv: "OPENAI_ENDPOINT",
    },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.deepEqual(errors, []);
  assert.ok(profile);
  assert.equal(profile!.defaultFallback?.model, "openai/gpt-5.4-mini");
});

test("loadRoutingProfile: defaultFallback with invalid vendor type is rejected naming defaultFallback", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaultFallback: { vendor: 42 },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => e.startsWith("defaultFallback.vendor")));
});

test("loadRoutingProfile: defaultFallback with invalid transport is rejected naming defaultFallback", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaultFallback: { transport: "carrier-pigeon" },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => e.startsWith("defaultFallback.transport")));
});

test("loadRoutingProfile: defaultFallback nesting deeper than MAX_FALLBACK_DEPTH is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaultFallback: {
      vendor: "a",
      fallback: [
        {
          vendor: "b",
          fallback: [
            {
              vendor: "c",
              fallback: [{ vendor: "d", fallback: [{ vendor: "e" }] }],
            },
          ],
        },
      ],
    },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /defaultFallback/.test(e) && /exceeds max fallback depth/i.test(e)));
});

test("loadRoutingProfile: secret-like property inside defaultFallback is rejected", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaultFallback: { vendor: "a", apiKey: "sk-nope" },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.equal(profile, null);
  assert.ok(errors.some((e) => /secrets must not be stored/i.test(e)));
});

test("loadRoutingProfile: defaultFallback is not inherited into a per-agent merge across vendors", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      foo: { vendor: "different-vendor", model: "different/model" },
    },
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
    defaultFallback: { vendor: "openai", model: "openai/gpt-5.4-mini" },
  });
  const { profile, errors } = loadRoutingProfile(root);
  assert.deepEqual(errors, []);
  assert.ok(profile);
  const resolved = resolveAgentSlot(profile, "foo");
  // defaultFallback is a separate top-level value — mergeSlots() never sets
  // `.fallback` on a resolved slot from it.
  assert.equal(resolved?.fallback, undefined);
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

// Shared detector matrix (p21-t7 Part A): apply-routing-profile.mjs and
// generate-opencode-config.mjs both load this exact function from
// out/src/core/routingProfile.js — this is the single source of truth for
// the "hand-written backend: block" detection they used to duplicate.
test("hasHandWrittenBackendBlock: hand-written block (no managed marker) is true", () => {
  const text = ["---", "name: foo", "backend:", "  vendor: acme", "  model: x", "---", "body"].join("\n");
  assert.equal(hasHandWrittenBackendBlock(text), true);
});

test("hasHandWrittenBackendBlock: managed block (marker as first child) is false", () => {
  const text = [
    "---",
    "name: foo",
    "backend:",
    "  # managed-by: tycoon-routing",
    "  vendor: acme",
    "  model: x",
    "---",
    "body",
  ].join("\n");
  assert.equal(hasHandWrittenBackendBlock(text), false);
});

test("hasHandWrittenBackendBlock: no backend block at all is false", () => {
  const text = ["---", "name: foo", "role: worker", "---", "body"].join("\n");
  assert.equal(hasHandWrittenBackendBlock(text), false);
});

test("hasHandWrittenBackendBlock: CRLF line endings are handled the same as LF", () => {
  const text = ["---", "name: foo", "backend:", "  vendor: acme", "  model: x", "---", "body"].join("\r\n");
  assert.equal(hasHandWrittenBackendBlock(text), true);
});

test("hasHandWrittenBackendBlock: CRLF managed block is still detected as managed", () => {
  const text = [
    "---",
    "name: foo",
    "backend:",
    "  # managed-by: tycoon-routing",
    "  vendor: acme",
    "  model: x",
    "---",
    "body",
  ].join("\r\n");
  assert.equal(hasHandWrittenBackendBlock(text), false);
});

test("hasHandWrittenBackendBlock: 'backend' text in the body (outside frontmatter) is ignored", () => {
  const text = [
    "---",
    "name: foo",
    "role: worker",
    "---",
    "This agent talks about its backend: it uses acme under the hood.",
  ].join("\n");
  assert.equal(hasHandWrittenBackendBlock(text), false);
});
