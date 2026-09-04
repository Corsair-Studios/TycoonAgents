# Routing Profile

## Problem / Opportunity

TycoonAgents assumes Claude sits at the top today: `src/core/providerSelection.ts` resolves a single `ProviderId` (`claude-code` default, `opencode`) for the whole *host*, and per-agent model choice is a static string in `.claude/agents/*.md` frontmatter (`model:` alias, optionally a `backend:` block per `src/core/agentBackend.ts` — `vendor`, `transport` `claude-native|mcp|openai-compatible`, `model`, `costModelClass` `metered|subscription|local`, `endpointEnv`/`apiKeyEnv`). That's enough for the VS Code product, which reasonably assumes Claude orchestrates and only individual agents opt into a foreign vendor via `backend:` (the Multi-LLM pack — codex-reviewer, gemini-reviewer, kimi-reviewer, claude-worker — `media/packs/catalog.json` id `multi-llm`). It is not enough for a standalone user with no Claude subscription at all: they need to pick the orchestrator itself (even a free OpenCode Zen model) and every subagent's model independently, including local LLMs, with no assumption that any tier defaults to Anthropic. Model choice today is also frontmatter-only — nothing tracks which provider actually executed a task when a fallback fired, nothing gives the OpenCode host the same delegation enforcement Claude gets from `hooks/tycoon-claude-hook.cjs`, and there is no UI for any of this that doesn't require hand-editing an agent `.md` file. This PRD proposes one project-level **routing profile** that is the single source of truth for orchestrator + per-agent model assignment, generates both hosts' configs from it, and tracks fallback execution and cost by actual vendor.

## Target Users

- **Standalone users with no Claude subscription** — the primary driver (2026-09-03 user direction: "a tester who no longer uses VS Code is waiting on this"). They run OpenCode, pick a free or metered orchestrator model, and assign every subagent — including ones backed by a local/VM-hosted OpenAI-compatible endpoint — from one panel.
- **VS Code users** who still want Claude at the top by default but occasionally want a subagent on a different vendor (already served today by `backend:` + the Multi-LLM pack) and want to see fallback and per-vendor cost in the existing metrics board.
- **TycoonAgents maintainers** who need one config format both host generators (`scripts/generate-opencode-config.mjs`, and a to-be-added Claude-frontmatter writer) consume, instead of the current split between agent-`.md` frontmatter and `.claude/tycoon/opencode-models.json` overrides.

## Goals & Success Metrics

- A project has exactly one `.claude/tycoon/routing.json` that fully determines the orchestrator's model and every agent's model/vendor/transport; `.claude/agents/*.md` frontmatter and OpenCode's generated config are both *derived* from it, never edited by hand for routing purposes.
- The VS Code panel and the standalone build get the same "Routing" screen (parity requirement, no VS Code-only routing UI).
- Delegation enforcement — orchestrator direct-edit block, keyword routing, the single review-gate pass, leaf-worker no-further-spawn — is provably present in the OpenCode plugin path, not just the Claude hook path. Success metric: the existing `tycoon-ready-test` skill (or an equivalent benchmark) passes at parity on both hosts.
- Every activity record (Claude hook and OpenCode plugin) that ran on a fallback provider carries `fallbackOf` naming the originally-assigned slot, and the metrics board (`media/main.js`) rolls up totals per vendor/`costModelClass` including fallback-attributed cost.
- No telemetry beyond the existing `activity.jsonl`/metrics board exists in the codebase; this PRD does not add a new telemetry system, only extends the existing one.

## Core Features

- **Routing profile schema** (planned) — `.claude/tycoon/routing.json`, one per project, described under Design below.
- **Profile → Claude frontmatter generator** (planned) — writes/updates each `.claude/agents/<id>.md`'s `backend:` block (and top-level `model:`) from the profile's per-agent slot, so `parseAgentBackend()` (`src/core/agentBackend.ts`) sees profile-sourced data without changing its own parsing contract.
- **Profile → OpenCode config generator** (planned, extends `scripts/generate-opencode-config.mjs`) — model resolution gains a new highest-priority source: the routing profile's per-agent slot, ahead of the existing `.claude/tycoon/opencode-models.json` override (which becomes a legacy/manual escape hatch, not the primary path).
- **OpenCode plugin enforcement parity** (planned, extends `hooks/tycoon-opencode-plugin.ts`) — ports the Claude hook's (`hooks/tycoon-claude-hook.cjs`) orchestrator direct-tool-call nudge/block, keyword-based agent routing (`matchAgentFromKeywords`), the fallback-agent-of-last-resort behavior, and the leaf-worker no-spawn rule into OpenCode's `tool.execute.before/after` hooks.
- **Fallback execution + tracking** (planned) — each routing slot carries an ordered fallback chain; when the assigned provider/model fails or is unavailable, execution falls through the chain and the resulting activity record's `fallbackOf` field names the originally-assigned slot id so the panel can show a "ran on fallback" badge instead of silently misattributing cost/identity.
- **Routing panel screen** (planned, replaces plan phase p8's agent-builder scope) — orchestrator slot picker, per-agent table (provider, model, transport, cost class, fallback chain), a Custom endpoint slot for VM-hosted/local models, free-text model entry (no code change needed for a newly released model id), and a credential-env-var name field with a live set/unset probe — never a key input field.
- **Per-vendor / per-cost-class metrics rollup** (planned, extends the existing `PRICE_TABLE`/`resolvePriceKey`/`costModelClass` logic in `media/main.js`) — totals broken out by vendor and by `metered|subscription|local`, plus a count of fallback-attributed executions.

## User Flows

1. **Standalone user with no Claude subscription sets up routing**: opens the Routing panel screen (standalone build), picks an orchestrator slot pointing at a free OpenCode Zen model (no credential needed), assigns each subagent row a provider/model — some local (transport `openai-compatible`, `costModelClass: local`, pointing at a VM endpoint via `endpointEnv`), some subscription-backed. Saves; the profile writes `.claude/tycoon/routing.json`; the generators regenerate `.opencode/agents/*.md`/`opencode.json` and `.claude/agents/*.md` `backend:` blocks to match.
2. **VS Code user keeps Claude at the top, adds one foreign reviewer**: profile's orchestrator slot stays `claude-code` (default, unchanged behavior); one agent row is set to `codex-reviewer`'s existing MCP transport. Regeneration touches only that agent's frontmatter; every other agent and the orchestrator slot are untouched — parity with today's Multi-LLM-pack flow, now sourced from the profile instead of a hand-edited `backend:` block.
3. **A fallback fires**: the assigned model for an agent slot is unreachable (credential unset, endpoint down); the runtime executes the slot's next fallback-chain entry instead. The resulting `HookRecord`/OpenCode activity line carries `fallbackOf: "<original-slot-id>"`; the panel shows a "ran on fallback" badge on that agent and the metrics board attributes cost to the vendor that actually ran, not the one assigned.
4. **Checking cost/usage totals**: metrics board's existing per-agent cost line (`media/main.js` `modelPricePerMtok`/`costModelClass` call sites) gains a per-vendor and per-cost-class rollup row, and a separate fallback-execution count, without changing today's per-agent numbers for the non-fallback path.
5. **Credential status probe, no key storage**: the panel's per-agent row shows the configured `endpointEnv`/`apiKeyEnv` *names* plus a set/unset badge (probed via `process.env` presence check only); OpenCode-native providers show OpenCode's own auth-store status instead of a TycoonAgents-tracked env var, since OpenCode already owns that credential store.

## Non-Functional Requirements

- **No secret storage**: the profile, the generators, and the panel never read, write, or transmit an API key or OAuth token — only environment-variable *names* and boolean set/unset status. This is a hard non-goal (see Milestones & Scope), enforced by review of every new file this PRD's milestones touch.
- **No OAuth flows to any vendor**: TycoonAgents does not become an auth broker for any provider; OpenCode's own auth store is authoritative for OpenCode-native providers, and vendor CLI bridges (`hooks/claude-cli-mcp.cjs`, `openai-compatible-mcp.cjs`) remain the only subscription-auth path, unchanged by this PRD.
- **Backward compatibility**: an existing project with no `routing.json` must behave exactly as today — `resolveProviderId()`'s existing precedence (`TYCOON_PROVIDER` → `tycoonagents.provider` → `execution.json` → `claude-code` default) and `.claude/tycoon/opencode-models.json` overrides both keep working unchanged; the profile is additive, resolved only when present.
- **Path/environment discovery**: any new file location (routing.json path, VM/local-endpoint discovery) follows `docs/PATH-DISCOVERY.md` — explicit env override first, multiple independent signals, fail loudly listing every path tried, never a silent empty/success result.
- **Enforcement parity, not superset**: the OpenCode plugin's ported enforcement must match the Claude hook's *documented* behavior (orchestrator block, keyword routing, single review pass, leaf no-spawn) — it does not need to exceed it, and any OpenCode-native hook richness beyond that mapping stays out of scope, per the existing OpenCode-provider PRD's own scope discipline.
- **Determinism**: profile → generator output is idempotent — running a generator twice against an unchanged profile produces byte-identical `.claude/agents/*.md`/`opencode.json` output, matching `scripts/generate-opencode-config.mjs`'s existing determinism guarantee.

## Tech Stack

- TypeScript core (`src/core/providerSelection.ts`, `src/core/agentBackend.ts`, `src/core/modelAliases.ts`), compiled to `out/`, consumed by both the VS Code extension and the standalone's `sharedLogic.mjs` pattern.
- Zero-dep Node scripts: `scripts/generate-opencode-config.mjs` (extended), a new Claude-frontmatter generator counterpart.
- Zero-dep hook/plugin runtimes: `hooks/tycoon-claude-hook.cjs` (reference implementation to port from), `hooks/tycoon-opencode-plugin.ts` (extension target), `hooks/claude-cli-mcp.cjs`/`hooks/openai-compatible-mcp.cjs` (unchanged CLI bridges).
- `media/main.js` (metrics board: `PRICE_TABLE`, `resolvePriceKey`, `costModelClass`, `modelPricePerMtok`) extended, not rewritten.
- Panel UI: VS Code webview (existing `media/` panel surface) plus the standalone equivalent — same screen, two hosts, per the parity requirement.
- `docs/AGENT-BACKENDS.md`, `docs/OPENCODE-PROVIDER.md` as the existing docs this PRD's M4 extends.

## Milestones & Scope

In scope: M0–M4 below (schema + generators, plugin enforcement + benchmark, fallback/tracking, Routing UI, docs/release). Deferred/non-goals: storing any secret or credential value, OAuth integration with any vendor, a third host beyond VS Code + standalone, and — per plan.json phase p8's 2026-09-03 note — this PRD explicitly supersedes p8's original agent-builder-UI scope; p8 should not proceed independently once this plan is registered.

## Risks & Open Questions

- **UNCONFIRMED — orchestration quality on free/low-tier models.** A free OpenCode Zen model as orchestrator may route and enforce poorly compared to Claude. M1's ready-test-parity benchmark must produce a go/no-go before the Routing UI (M3) presents free models as a first-class orchestrator option without a caveat.
- **UNCONFIRMED — OpenCode API drift** beyond what `docs/opencode-probe-findings.md` already captured for the base OpenCode provider work; this PRD's plugin enforcement extension may hit payload shapes not covered by that earlier spike.
- **Local-model token accounting**: local/VM-hosted models may not report token counts at all; cost/usage tracking for `costModelClass: local` may need to fall back to wall-clock time-based accounting instead of token-based, which changes the metrics board's display shape for those rows.
- **Profile vs. frontmatter precedence**: once `routing.json` exists, is a hand-edited `backend:` block in an agent `.md` ever authoritative, or always overwritten on next generation? This PRD proposes profile-always-wins (frontmatter is a generated artifact, matching the existing OpenCode-config precedent), but this is a design decision this PRD flags rather than silently assumes — confirm before M0 implementation locks it in.
- **Migration from `.claude/tycoon/opencode-models.json`**: existing projects using that override file need a defined one-time migration path into `routing.json` (or documented coexistence) rather than a silent behavior change.

# Milestone Plan

## Overview

This plan introduces `.claude/tycoon/routing.json` as the single source of truth for orchestrator and per-agent model/vendor/transport assignment across both TycoonAgents hosts (VS Code, standalone), replacing the current split between agent-frontmatter `backend:` blocks and the OpenCode-only `opencode-models.json` override, and closes the enforcement gap between Claude Code (hook-enforced delegation) and OpenCode (plugin-enforced, currently at parity only for basic activity mapping). Milestones are sequenced by dependency; no fixed calendar timeframe.

## Milestone 1: M0 — Routing Schema + Generators

**Goal**
Define the routing profile schema and make both host generators consume it as their highest-priority model/vendor source, with zero behavior change for projects that have no profile.

**Deliverables**
- `.claude/tycoon/routing.json` schema, documented in `docs/AGENT-BACKENDS.md` (or a new `docs/ROUTING-PROFILE.md`): `orchestrator` slot, `agents: { <agentId>: slot }` map, each slot shaped like `Backend` (`src/core/agentBackend.ts`) plus `fallback: slot[]` and `credentialEnv`/`endpointEnv` naming (no values), and a `defaults` block.
- A schema-loader module (e.g. `src/core/routingProfile.ts`) mirroring `providerSelection.ts`'s discovery style: read `.claude/tycoon/routing.json` if present, validate, return `undefined` on absence (never throw on a missing file — only on a present-but-invalid one, matching `resolveProviderId`'s existing error contract).
- `scripts/generate-opencode-config.mjs`'s `resolveModel()` gains a new top-priority source: the profile's per-agent slot, checked before the existing `opencode-models.json` override.
- A new Claude-frontmatter generator that writes each agent's `backend:` block from the profile's slot, matching `parseAgentBackend()`'s expected shape exactly.
- `--check` mode (mirroring the existing `--check` flag) for both generators.

**Acceptance Criteria**
- With no `routing.json` present, both generators produce byte-identical output to today's behavior — verified by running the existing OpenCode generator test suite unmodified.
- With a `routing.json` present, a test asserts an agent's generated `backend:` block and OpenCode config entry both match the profile's slot for that agent, and that `opencode-models.json` is ignored for any agent the profile covers.
- `routingProfile.ts`'s loader returns `undefined` for a missing file and throws a descriptive error (naming the file path and the invalid field) for a malformed one, matching `resolveProviderId`'s existing error-message pattern.
- Re-running both generators twice against an unchanged profile produces byte-identical output.

**Risks**
Profile-vs-frontmatter precedence (see PRD Risks) must be decided before this milestone's generator logic is written, not discovered mid-implementation.

## Milestone 2: M1 — OpenCode Plugin Enforcement + Ready-Test Parity Benchmark

**Goal**
Port the Claude hook's delegation enforcement into the OpenCode plugin so routing-profile-driven delegation stays effective when Claude isn't present at all, and prove parity with a benchmark.

**Deliverables**
- `hooks/tycoon-opencode-plugin.ts` extended with: an orchestrator-direct-tool-call nudge/block (mirroring `tycoon-claude-hook.cjs`'s compliance-nudge and deny-on-spawn logic), keyword-based agent routing (`matchAgentFromKeywords` equivalent) reading the same `agent-keywords.json`, a single review-gate pass equivalent, and the leaf-worker no-further-spawn deny (mirroring the `"Blocked: you are a leaf worker..."` message).
- `AGENTS.md`'s managed block (generated by `scripts/generate-opencode-config.mjs`) extended with the doctrine text needed for OpenCode's own model to understand and follow these rules, since OpenCode has no equivalent of `CLAUDE.md`'s always-loaded project instructions guarantee without it being named in `AGENTS.md`.
- A ready-test-parity benchmark: an extension of the `tycoon-ready-test` skill (or a standalone equivalent) that spawns the same agent roster under both Claude Code and OpenCode and asserts each fires the same enforcement events (block, keyword-route, review-gate) for the same inputs.

**Acceptance Criteria**
- A test scenario reproducing each of the four ported enforcement behaviors passes under the OpenCode plugin at parity with the existing Claude hook test coverage for the same scenario.
- The benchmark runs against a real or fixture-based OpenCode agent roster (naming which — "big-pickle" or an equivalent test project, per the brief) and reports pass/fail per enforcement rule, not just an aggregate pass.
- No change to `hooks/tycoon-claude-hook.cjs`'s own behavior — this milestone only ports logic into the OpenCode side.

**Sequencing Notes**
Independent of M0's schema (enforcement doesn't need a profile to exist), but should land before M3 (Routing UI) claims parity as a selling point.

**Risks**
UNCONFIRMED orchestration quality on low-tier orchestrator models may cause the benchmark to fail for reasons unrelated to the plugin's own correctness — the benchmark's report must distinguish "enforcement code is wrong" from "the model didn't follow the enforced instruction."

## Milestone 3: M2 — Fallback Chains + Activity/Pricing Tracking

**Goal**
A slot's fallback chain actually executes on failure, and every activity record and metrics rollup reflects the provider that actually ran, not just the one assigned.

**Deliverables**
- Fallback execution logic (host-appropriate: extension-side for Claude Code, plugin-side for OpenCode) that, on an unreachable/failing assigned provider for a slot, falls through to the next `fallback[]` entry in the profile.
- `fallbackOf` field added to the `HookRecord`/OpenCode activity record shape, naming the originally-assigned slot id whenever a fallback fired.
- `media/main.js` metrics board extended: per-vendor and per-`costModelClass` total rows, plus a fallback-execution count, computed from `fallbackOf`-tagged records without changing existing non-fallback per-agent totals.
- Local/VM-hosted model token accounting: if M0's schema work confirms no token data is available for `costModelClass: local`, a documented time-based accounting fallback (per PRD Risks) instead of a silent zero.

**Acceptance Criteria**
- A test simulating an unreachable primary provider for a slot asserts execution proceeds on the first working fallback entry and the resulting record carries `fallbackOf` set to the original slot id.
- A test asserts the metrics board's per-vendor/per-cost-class rollup sums correctly across a fixture set of records including at least one fallback-tagged record, attributing its cost to the vendor that ran, not the one assigned.
- Existing (non-fallback) per-agent cost numbers are unchanged before/after this milestone for a fixture set of records with no `fallbackOf` field.

**Sequencing Notes**
Depends on M0 (needs the profile's `fallback[]` chain shape) and M1 (enforcement must already route correctly before fallback execution is layered on top).

**Risks**
Local-model time-based accounting is a genuinely different metric shape (seconds, not tokens) from everything else on the board — mitigation: display it in its own labeled row rather than forcing a fabricated token-equivalent number.

## Milestone 4: M3 — Routing Panel UI (VS Code + Standalone)

**Goal**
A user assigns the orchestrator and every agent's model from one panel screen, on both hosts, without ever entering a credential value — replacing plan phase p8's original agent-builder scope.

**Deliverables**
- A "Routing" panel screen: orchestrator slot picker, per-agent table (provider, model, transport, `costModelClass`, fallback chain editor), a Custom endpoint slot (free-text `endpointEnv` name + free-text model id, for VM-hosted/local models with no preset), and a credential-env-var-name field per slot with a live set/unset probe (`process.env` presence check, never a value read/write).
- Save action writes `.claude/tycoon/routing.json` and triggers both M0 generators (`--check` first, then a real write, matching the existing generator CLI contract).
- "Ran on fallback" badge on the agent table row, and per-vendor/per-cost-class totals surfaced on the same screen as the existing metrics board (M2's data).
- Standalone parity: the identical screen (or a faithful terminal/web equivalent, per the standalone's existing UI pattern) ships alongside the VS Code panel version, not after it.

**Acceptance Criteria**
- Saving a profile edit in the panel and re-opening the screen reflects the saved state — round-trip test against `routing.json`.
- No code path in the panel ever calls an API with a credential value, nor renders one — verified by a review pass explicitly checking every panel-to-generator and panel-to-filesystem call in this milestone's diff.
- The standalone screen and VS Code screen are demonstrably built from the same profile schema and generator calls (no duplicated routing logic between the two hosts), matching the OpenCode-provider PRD's existing "no duplicated logic across surfaces" precedent.

**Sequencing Notes**
Depends on M0 (schema + generators must exist to save/apply from), M1 (enforcement parity should exist before the UI markets free-model orchestration as fully supported), and M2 (fallback badge/totals need real data to display).

**Risks**
Plan phase p8 (superseded by this PRD per its 2026-09-03 note) must not proceed in parallel — the orchestrator should confirm p8 stays paused before this milestone starts.

## Milestone 5: M4 — Docs, Handbook, Release

**Goal**
The routing profile is documented at the same level as `docs/AGENT-BACKENDS.md` and `docs/OPENCODE-PROVIDER.md`, so a user or maintainer can adopt or extend it without reading source.

**Deliverables**
- `docs/ROUTING-PROFILE.md` (or a new section in `docs/AGENT-BACKENDS.md`) documenting the full schema, precedence rules, and a migration note from `.claude/tycoon/opencode-models.json`.
- README.md and the standalone README updated with a Routing panel walkthrough.
- `docs/OPENCODE-PROVIDER.md` updated to reference the ported enforcement rules from M1.

**Acceptance Criteria**
- Every new config key/env-var-name field introduced in M0–M3 appears in the new/updated doc (cross-check, same acceptance style as the OpenCode-provider PRD's M5).
- A fresh clone following only the doc can assign a free-model orchestrator and one local-endpoint agent, save, and see both hosts' generated config reflect it — recorded as a pass/fail smoke-test note in the PR description.

**Sequencing Notes**
Runs last, after M0–M3 are functionally complete.

**Risks**
Documentation drift if M0–M3 change after M4 is drafted — mitigation: M4 runs only after the others are merged, per the OpenCode-provider PRD's own precedent.

## Sequencing Notes

M0 (schema + generators) is the foundation every other milestone depends on. M1 (plugin enforcement) has no schema dependency and can start in parallel with M0. M2 (fallback + tracking) depends on both M0 (profile shape) and M1 (enforcement must route correctly first). M3 (Routing UI) depends on M0, M1, and M2. M4 (docs) runs last.

## Out of Scope

- Storing, transmitting, or displaying any credential/secret value — only environment-variable names and set/unset status, per the PRD's non-goals.
- OAuth integration with any vendor — subscription auth stays exclusively through the existing vendor-CLI bridges (`claude -p`, `codex mcp-server`).
- A third host beyond VS Code and standalone.
- Plan phase p8's original agent-builder-UI scope — explicitly superseded by this PRD's M3 per the 2026-09-03 plan.json note; p8 should not proceed independently once this plan is registered.
- Any change to Trashbyrd's Power Tools (UEFN bridge, scalar MCP, `media/uefn-bridge/`) — ships and is owned separately, unaffected by routing.
