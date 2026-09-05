/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Tests for plan task p17-t2's contract additions to
// src/core/routingProfile.ts: resolveAgentSlot's `hasHandWrittenBackend`
// option, and same-vendor inheritance of transport/endpointEnv/
// credentialEnv/fallback from `defaults`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRoutingProfile, resolveAgentSlot } from "../src/core/routingProfile";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "routing-profile-defaults-"));
}

function writeRoutingObj(root: string, obj: unknown): void {
  const dir = path.join(root, ".claude", "tycoon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "routing.json"), JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// hasHandWrittenBackend option: defaults must NOT apply to an agent whose
// frontmatter has a hand-written backend: block.
// ---------------------------------------------------------------------------

test("resolveAgentSlot: defaults do NOT apply when hasHandWrittenBackend is true and agent has no explicit entry", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "codex-reviewer", { hasHandWrittenBackend: true });
  assert.equal(slot, null, "an agent with a hand-written backend block must not inherit defaults");
});

test("resolveAgentSlot: defaults DO apply when hasHandWrittenBackend is false/omitted and agent has no explicit entry", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "coding-specialist", { hasHandWrittenBackend: false });
  assert.ok(slot, "an agent with no hand-written backend block should inherit defaults");
  assert.equal(slot!.model, "anthropic/haiku");
});

test("resolveAgentSlot: an explicit agents[id] entry wins outright over hasHandWrittenBackend:true", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: { "coding-specialist": { model: "anthropic/opus" } },
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "coding-specialist", { hasHandWrittenBackend: true });
  assert.ok(slot);
  assert.equal(slot!.model, "anthropic/opus");
});

// A managed block (contains "# managed-by: tycoon-routing") counts as
// ABSENT for the purpose of this option — the caller (routingHostOps /
// the generator scripts) is responsible for that classification before
// calling resolveAgentSlot; this test documents the option's contract from
// resolveAgentSlot's own side: hasHandWrittenBackend:false must still let
// defaults apply even though frontmatter parsing found *a* backend: block
// (a managed one).
test("resolveAgentSlot: hasHandWrittenBackend:false lets defaults apply even when the caller found a (managed) backend block", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {},
    defaults: { vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "some-agent", { hasHandWrittenBackend: false });
  assert.ok(slot);
  assert.equal(slot!.model, "anthropic/haiku");
});

// ---------------------------------------------------------------------------
// Same-vendor inheritance: a per-agent entry with vendor === defaults.vendor
// (or no vendor) that omits transport/endpointEnv/credentialEnv/fallback
// inherits them from defaults. A different-vendor entry does NOT inherit
// those fields.
// ---------------------------------------------------------------------------

test("resolveAgentSlot: same-vendor per-agent entry inherits transport/endpointEnv/credentialEnv/fallback from defaults", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      "coding-specialist": { vendor: "moonshot", model: "moonshot/kimi-k2-pro" },
    },
    defaults: {
      vendor: "moonshot",
      transport: "openai-compatible",
      model: "moonshot/kimi-k2",
      costModelClass: "local",
      endpointEnv: "KIMI_ENDPOINT_URL",
      credentialEnv: "KIMI_API_KEY",
      fallback: [{ vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" }],
    },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "coding-specialist", { hasHandWrittenBackend: false });
  assert.ok(slot);
  assert.equal(slot!.model, "moonshot/kimi-k2-pro", "explicit per-agent model must win");
  assert.equal(slot!.vendor, "moonshot");
  assert.equal(slot!.transport, "openai-compatible", "same-vendor entry should inherit transport from defaults");
  assert.equal(slot!.endpointEnv, "KIMI_ENDPOINT_URL", "same-vendor entry should inherit endpointEnv from defaults");
  assert.equal(slot!.credentialEnv, "KIMI_API_KEY", "same-vendor entry should inherit credentialEnv from defaults");
  assert.ok(Array.isArray(slot!.fallback) && slot!.fallback!.length > 0, "same-vendor entry should inherit fallback from defaults");
});

test("resolveAgentSlot: per-agent entry with no vendor at all inherits transport/endpointEnv/credentialEnv/fallback from defaults", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      "coding-specialist": { model: "moonshot/kimi-k2-pro" },
    },
    defaults: {
      vendor: "moonshot",
      transport: "openai-compatible",
      model: "moonshot/kimi-k2",
      costModelClass: "local",
      endpointEnv: "KIMI_ENDPOINT_URL",
      credentialEnv: "KIMI_API_KEY",
    },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "coding-specialist", { hasHandWrittenBackend: false });
  assert.ok(slot);
  assert.equal(slot!.transport, "openai-compatible");
  assert.equal(slot!.endpointEnv, "KIMI_ENDPOINT_URL");
  assert.equal(slot!.credentialEnv, "KIMI_API_KEY");
});

test("resolveAgentSlot: different-vendor per-agent entry does NOT inherit endpointEnv/credentialEnv/transport/fallback from defaults", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      "coding-specialist": { vendor: "openai", model: "openai/gpt-5.4-mini" },
    },
    defaults: {
      vendor: "moonshot",
      transport: "openai-compatible",
      model: "moonshot/kimi-k2",
      costModelClass: "local",
      endpointEnv: "KIMI_ENDPOINT_URL",
      credentialEnv: "KIMI_API_KEY",
      fallback: [{ vendor: "anthropic", model: "anthropic/haiku", costModelClass: "subscription" }],
    },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "coding-specialist", { hasHandWrittenBackend: false });
  assert.ok(slot);
  assert.equal(slot!.vendor, "openai");
  assert.equal(slot!.endpointEnv, undefined, "different-vendor entry must not inherit defaults.endpointEnv");
  assert.equal(slot!.credentialEnv, undefined, "different-vendor entry must not inherit defaults.credentialEnv");
  assert.equal(slot!.fallback, undefined, "different-vendor entry must not inherit defaults.fallback");
});

test("resolveAgentSlot: per-agent entry's OWN transport/endpointEnv/credentialEnv/fallback are never overridden by defaults, same vendor or not", () => {
  const root = tmpRoot();
  writeRoutingObj(root, {
    version: 1,
    agents: {
      "coding-specialist": {
        vendor: "moonshot",
        transport: "mcp",
        model: "moonshot/kimi-k2-pro",
        endpointEnv: "OWN_ENDPOINT",
        credentialEnv: "OWN_CRED",
        fallback: [{ vendor: "openai", model: "openai/gpt-5.4-mini", costModelClass: "metered" }],
      },
    },
    defaults: {
      vendor: "moonshot",
      transport: "openai-compatible",
      model: "moonshot/kimi-k2",
      costModelClass: "local",
      endpointEnv: "KIMI_ENDPOINT_URL",
      credentialEnv: "KIMI_API_KEY",
    },
  });
  const { profile } = loadRoutingProfile(root);
  assert.ok(profile);
  const slot = resolveAgentSlot(profile, "coding-specialist", { hasHandWrittenBackend: false });
  assert.ok(slot);
  assert.equal(slot!.transport, "mcp");
  assert.equal(slot!.endpointEnv, "OWN_ENDPOINT");
  assert.equal(slot!.credentialEnv, "OWN_CRED");
  assert.equal(slot!.fallback?.[0]?.vendor, "openai");
});
