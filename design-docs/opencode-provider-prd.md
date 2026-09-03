# OpenCode Provider

## Problem / Opportunity

TycoonAgents' core (`src/core/state.ts`, `src/core/provider.ts`) already defines a provider-neutral `Provider { id; start(emit); stop() }` interface and a `NormalizedEvent` stream, but only one provider exists — `ClaudeCodeProvider`, hardcoded at `src/host/vscode/extension.ts:98`. Today TycoonAgents can only visualize and monitor Claude Code sessions. OpenCode (v1.18.26) is a separate agent harness with its own agent/subagent model, plugin hook system, and `opencode serve` REST+SSE event API. Adding OpenCode as a second, user-selectable primary runtime lets TycoonAgents users who run OpenCode get the same activity visualization, cost tracking, and multi-agent monitoring without switching tools — and forces the one latent coupling in core (`state.ts:8` imports `mapHookRecord` from `src/providers/claude-code`) to become a real, provider-neutral seam instead of an assumption that happened to hold with one provider.

## Target Users

Developers who run OpenCode (via `.opencode/agents/*.md` or `opencode.json` "agent" definitions) as their primary coding-agent harness and want the TycoonAgents VS Code panel or standalone web viewer to show live agent activity, delegation, and token/cost metrics the same way it does for Claude Code today. Secondary: TycoonAgents maintainers who need the provider seam generalized before a third provider (e.g. a future Codex or local-model provider, per `docs/provider-contract.md`) can be added without repeating this refactor.

## Goals & Success Metrics

- A user can select "OpenCode" as the active provider (VS Code setting + standalone CLI flag) and see the same panel/HUD behavior OpenCode's activity produces as Claude Code's does today, with zero visible change to Claude Code behavior when it remains selected (default).
- `src/core/state.ts` has no provider-specific import; a provider-neutral mapping registry replaces the direct `mapHookRecord` import, and both the extension and the standalone consume that registry via one shared config source (no duplicated mapping logic between `src/host/vscode/` and `standalone/`).
- `.claude/agents/*.md` remains the single canonical agent roster; an OpenCode config (opencode.json agent entries or `.opencode/agents/*.md`) is generated from it, never hand-maintained separately.
- Existing tests (`test/mapHookRecord.test.ts`, `test/state.test.ts`, `standalone/test/installHook.test.mjs`) continue to pass unmodified in behavior for the claude-code path; new tests cover the OpenCode mapping path at parity.
- No telemetry exists in the codebase today to measure adoption; this PRD proposes tracking provider-selection distribution only if/when a telemetry system is added elsewhere — out of scope here.

## Core Features

- Provider-neutral record→NormalizedEvent mapping registry (planned) — replaces `state.ts`'s direct `mapHookRecord` import with a lookup keyed by provider id, resolvable from both the extension's TypeScript build and the standalone's compiled `out/` require path.
- OpenCode plugin (planned) — a `.opencode/plugins/*.ts` (or configured npm plugin) that observes OpenCode's `tool.execute.before/after`, `session.created/idle/deleted/status/updated`, `message.updated`, `message.part.updated` hooks and writes HookRecord-compatible lines to `activity.jsonl`, matching the existing Claude Code hook's wire format (`docs/CLAUDE-CODE-PROVIDER.md`).
- `OpenCodeProvider` (planned) — implements `Provider` from `src/core/provider.ts`, tailing the same activity file shape the plugin produces, id `"opencode"`.
- Provider-selection setting (planned) — a new `tycoonagents.provider` VS Code setting (enum: `claude-code` default, `opencode`) alongside existing `tycoonagents.autoShow`/`idleFreezeMinutes`/`sanityCapMinutes`, and an equivalent standalone CLI flag reading the same config source.
- Agent roster translator (planned) — converts `.claude/agents/*.md` frontmatter (model, description, tier) into `opencode.json` "agent" entries or `.opencode/agents/*.md`, with `model` accepting any `"provider/model-id"` string; also generates/manages an `AGENTS.md` block from `CLAUDE.md` (OpenCode reads `AGENTS.md` first, `CLAUDE.md` as fallback).
- Pricing generalization (planned) — `media/main.js`'s `MODEL_PRICE_PER_MTOK`/`COST_WEIGHT` and its Anthropic-only `/^claude-(opus|sonnet|haiku|fable)(-\d+)+$/i` model-id regex generalized to a per-model table keyed by `"provider/model"`, falling back to an event-supplied cost when OpenCode's event payload carries one (unconfirmed, see Risks).

## User Flows

1. **Select OpenCode in VS Code**: user opens Settings, sets `tycoonagents.provider` to `opencode` (or `.claude/tycoon/execution.json`-equivalent config, TBD in M2), reloads/restarts the extension; `extension.ts` instantiates `OpenCodeProvider` instead of `ClaudeCodeProvider`; the panel renders identically in shape (same webview, same `media/main.js`) driven by OpenCode-sourced `NormalizedEvent`s.
2. **Select OpenCode in standalone**: user passes the equivalent CLI flag/env var to the standalone entrypoint; `standalone/src/sharedLogic.mjs` resolves the same provider-neutral mapping module (compiled `out/`) the extension uses, and `activityWatcher.mjs` continues polling the same `activity.jsonl` shape, now written by the OpenCode plugin instead of the Claude Code hook.
3. **Agent roster sync**: user edits `.claude/agents/some-agent.md`; runs the roster translator (script or install-hook-triggered); `opencode.json`/`.opencode/agents/*.md` and the `AGENTS.md` managed block are regenerated to match, with no manual edit to OpenCode's own config files.
4. **Fallback / misconfiguration**: OpenCode binary/config directory not found — the discovery ladder (env override → multiple signals → fail loudly) reports every path tried and names the override variable, per `docs/PATH-DISCOVERY.md`; the extension does not silently fall back to Claude Code without telling the user.

## Non-Functional Requirements

- **Determinism / no regression**: with `provider = claude-code` (default), extension and standalone behavior must be byte-for-byte unchanged — enforced by keeping existing tests green with zero edits to their assertions.
- **No duplicated logic across surfaces**: the mapping registry and provider-selection config must be single-sourced; a drift-guard test (in the style of `standalone/test/messageContract.test.mjs`) should assert the standalone's compiled mapping module matches the extension's source, as already done for `MSG.STATE`.
- **Path/environment discovery**: OpenCode binary and config directory resolution follows `docs/PATH-DISCOVERY.md`'s ladder — `OPENCODE_CONFIG_DIR`/`OPENCODE_BIN` env overrides first, then multiple independent signals, never a single guess, and a listing-every-path-tried error on total failure (never a silent empty/success result).
- **Scope isolation**: no change touches Trashbird's Power Tools (UEFN bridge, scalar MCP, `media/uefn-bridge/`, any MCP registration) — those ship and are owned separately.
- **Security**: the OpenCode plugin only reads OpenCode's own event/hook payloads and writes to the existing activity file location; it does not execute or proxy arbitrary commands from event payloads.

## Tech Stack

- TypeScript core (`src/core/`, `src/providers/`, `src/host/vscode/`), compiled to `out/` and required by the dependency-free standalone (`standalone/src/`, plain Node.js, zero npm deps) per the existing `sharedLogic.mjs` pattern.
- New: an OpenCode plugin authored in TypeScript per OpenCode's plugin signature `async ({project, client, $, directory, worktree}) => ({hooks})`, registered via `.opencode/plugins/*.ts` or the `plugin` array in `opencode.json`.
- `media/main.js`/`media/style.css` served unmodified in shape to both surfaces; only the pricing table logic changes.
- Test runner: existing `test/*.test.ts` (Vitest per project convention) and `standalone/test/*.test.mjs`.

## Milestones & Scope

In scope for this plan: the M0–M5 milestones below (spike, core seam, OpenCode plugin+provider, roster translator, pricing generalization, docs/release). Deferred: any third provider, the app-server v2 JSON-RPC surface for either Codex or OpenCode, streaming/partial-output handling, and any change to Trashbird's Power Tools. See Milestone Plan below for the full breakdown.

## Risks & Open Questions

- **UNCONFIRMED — exact `tool.execute.before` payload shape for the Task tool** (agent/model identification fields). M0 spike must confirm before M2 can implement the plugin's spawn/worker-identification mapping.
- **UNCONFIRMED — whether per-message token/cost appears in OpenCode event payloads.** If absent, M4's cost-from-events path is unavailable and pricing must rely entirely on the static per-model table.
- **UNCONFIRMED — whether OpenCode subagents can recurse** (subagent spawning subagent), which affects whether `parentId`/delegation-mode tracking (mirrored from `tycoon-claude-hook.cjs:88-172`) needs a different depth model.
- **UNCONFIRMED — explicit user-prompt-submitted event.** If OpenCode has no direct equivalent to Claude Code's `UserPromptSubmit` hook, `SessionStart` normalization may need to derive from `session.created` instead, which is a different trigger semantics.
- All four items above are addressed by the M0 go/no-go spike; a "no-go" on any core-identification item (agent/model ID in tool.execute.before) blocks M2 and requires this PRD to be amended, not worked around silently.
- **Coupling risk**: `state.ts:8`'s current direct import of `mapHookRecord` is the only thing standing between "add a second provider" and "duplicate the state module." M1 must land the registry seam before any OpenCode-specific code is written, or the seam will be retrofitted under pressure.
- **Scope-creep risk**: OpenCode's plugin hooks are much richer than what Claude Code's single hook script exposes (per-part message streaming, permission-asked events); this PRD deliberately maps only to the existing `HookRecord` surface (event/tool/workerId/tokens/model/etc.) rather than expanding `NormalizedEvent` shapes speculatively.

# Milestone Plan

## Overview

This plan adds OpenCode as a second, user-selectable `Provider` implementation in TycoonAgents, generalizing the one Claude Code-specific seam in `src/core/state.ts` and extending provider selection, agent-roster generation, and cost/pricing to be provider-neutral, without touching Trashbird's Power Tools or changing default (Claude Code) behavior. No fixed calendar timeframe; milestones are sequenced by dependency, sized to land independently.

## Milestone 1: M0 — OpenCode API Spike

**Goal**
Resolve the four UNCONFIRMED OpenCode API facts before any production code depends on them; produce a go/no-go decision.

**Deliverables**
- A throwaway OpenCode plugin at `standalone/spike/opencode-probe-plugin.ts` (or equivalent scratch location, deleted or archived at milestone end) that logs, to a local file, the full payload of: `tool.execute.before`/`after` for the Task tool, `session.created`, `message.updated`, and `message.part.updated`.
- A findings doc `docs/opencode-probe-findings.md` recording, for each of the four UNCONFIRMED items in the PRD's Risks section: the actual payload shape observed (or "not observed, still unconfirmed" if the spike could not trigger it), with literal JSON examples.
- A go/no-go recommendation line at the top of that doc.

**Acceptance Criteria**
- `docs/opencode-probe-findings.md` exists and contains a literal JSON payload example for at least `tool.execute.before` (Task tool) and `session.created`; any item not resolved is explicitly labeled "UNRESOLVED" rather than omitted.
- The go/no-go line is present and unambiguous (`GO` or `NO-GO`, with a one-sentence reason).
- If `NO-GO`, M2 is blocked and this PRD's Risks section is amended before proceeding; if `GO`, M1 may start in parallel with M0's write-up.

**Sequencing Notes**
Can run in parallel with M1 (M1 does not depend on OpenCode's real API — it only touches the mapping registry seam using the existing Claude Code mapper). M2 hard-blocks on M0's go/no-go.

**Risks**
OpenCode's plugin API or `opencode serve` behavior could differ from v1.18.26 docs at spike time (version drift) — mitigation: pin and record the exact OpenCode version used in the findings doc.

## Milestone 2: M1 — Core Seam: Provider-Neutral Mapping Registry

**Goal**
Remove the Claude-Code-specific import from `src/core/state.ts` so any provider's records can be mapped to `NormalizedEvent` through one shared, extensible registry, with the standalone consuming the same compiled module.

**Deliverables**
- A new module `src/core/mappingRegistry.ts` exporting a `registerMapper(providerId, mapperFn)` / `getMapper(providerId)` pair (or equivalent minimal registry API).
- `src/core/state.ts:8`'s direct `import { mapHookRecord } from "../providers/claude-code"` removed; `computeStateFromRecords`/`applyEvent` resolve the mapper via the registry instead, keyed by a provider id carried on each record or passed in explicitly.
- `src/providers/claude-code/index.ts` (or equivalent) registers its existing `mapHookRecord` into the registry at module load, preserving identical output for existing records.
- `standalone/src/sharedLogic.mjs:35-49` updated to `createRequire` the compiled `out/src/core/mappingRegistry.js` alongside the existing `out/src/core/state.js`, so the standalone gets the same registry lookup with zero duplicated mapping logic.

**Acceptance Criteria**
- `test/state.test.ts` and `test/mapHookRecord.test.ts` pass unmodified (same assertions, same expected output) against the refactored code.
- `grep -r "providers/claude-code" src/core/` returns no matches (the import is gone from core).
- `standalone/test/installHook.test.mjs` passes unmodified.
- A new unit test registers a dummy second mapper under a different provider id and asserts `computeStateFromRecords` dispatches to it correctly for records carrying that id, proving the registry is genuinely provider-neutral and not a single-branch shim.

**Sequencing Notes**
No dependency on M0. Must land before M2 (OpenCode provider needs the registry to register into) and before M3/M4.

**Risks**
Behavior-preservation risk for the default path — mitigated by running the full existing test suite before/after with no assertion changes permitted.

## Milestone 3: M2 — OpenCode Plugin + Provider

**Goal**
OpenCode activity becomes visible to TycoonAgents: a plugin emits HookRecord-compatible events, and an `OpenCodeProvider` consumes them exactly as `ClaudeCodeProvider` does today, selectable via one config source shared by both host surfaces.

**Deliverables**
- `.opencode/plugins/tycoon-activity.ts` implementing the plugin signature, writing `HookRecord`-shaped JSON lines (`event`, `at`, and best-effort `tool`/`workerId`/`model`/`tokens` per M0 findings) to the same `activity.jsonl` location resolved via `TYCOON_ACTIVITY_DIR` (or its OpenCode-context equivalent).
- `src/providers/opencode/index.ts` exporting `OpenCodeProvider implements Provider` (`id: "opencode"`), tailing that same activity file on the same poll pattern as `ClaudeCodeProvider`, registering its record mapper into the M1 registry.
- One shared provider-selection config source: a `tycoonagents.provider` VS Code setting added to `package.json` contributes, read by `src/host/vscode/extension.ts` (replacing the `:98` hardcode) — plus a standalone CLI flag/env var that reads the identical resolved value (e.g. both read from `.claude/tycoon/execution.json` or an equivalent single file), with no separate selection logic duplicated between the two surfaces.
- Discovery of the OpenCode binary/config directory (`OPENCODE_CONFIG_DIR`/`OPENCODE_BIN` env override first, then documented fallback signals) implemented per `docs/PATH-DISCOVERY.md`, failing loudly with every path tried when unresolved.

**Acceptance Criteria**
- With `tycoonagents.provider` unset or `"claude-code"`, `extension.ts` instantiates `ClaudeCodeProvider` exactly as before (existing extension tests/manual smoke pass unchanged).
- With `tycoonagents.provider = "opencode"`, `extension.ts` instantiates `OpenCodeProvider` instead — verified by a unit/integration test asserting the correct class is constructed for each setting value.
- A test drives a sample OpenCode-shaped activity line through `OpenCodeProvider` → `NormalizedEvent` → `computeStateFromRecords` and asserts a session/worker appears in resulting state, at parity with the equivalent Claude Code test case.
- Standalone accepts the equivalent CLI flag and selects the matching provider — verified by a `standalone/test/*.test.mjs` case.
- Simulating a missing OpenCode binary path produces an error listing every path tried and naming the override env var (no silent empty result).

**Sequencing Notes**
Hard-blocked on M0 `GO` and M1 landing. M3 (roster translator) can start in parallel once M2's provider skeleton exists, since the translator only needs the `.claude/agents/*.md` format and OpenCode's config schema, not the live plugin.

**Risks**
If M0 surfaces a `NO-GO` on Task-tool agent/model identification, worker-spawn attribution (`workerId`/`parentId`/`delegationMode`) may need a degraded mapping (e.g. session-level only, no per-subagent identification) — flagged here as a fallback design, not a blocker, since session-level visibility alone is still shippable.

## Milestone 4: M3 — Agent Roster Translator

**Goal**
`.claude/agents/*.md` stays the single canonical roster; OpenCode's own config is always a generated artifact, never hand-edited.

**Deliverables**
- A translator script/module (e.g. `scripts/generate-opencode-config.mjs` or `src/providers/opencode/rosterTranslator.ts`) that reads every `.claude/agents/*.md` frontmatter block (model, description, tier) and writes corresponding `opencode.json` `"agent"` entries (or `.opencode/agents/*.md` files), preserving each agent's `model` as a `"provider/model-id"` string.
- An `AGENTS.md` managed-block generator that mirrors the relevant portion of `CLAUDE.md` into `AGENTS.md` inside clearly delimited markers (e.g. `<!-- TYCOON-MANAGED:START -->` / `:END`), leaving any hand-written content outside the markers untouched.
- Wiring so the translator runs on demand (CLI invocation) and, if the install-hook path is chosen, on install/update, per the M2 provider-selection config.

**Acceptance Criteria**
- Running the translator against the repo's actual `.claude/agents/*.md` produces an `opencode.json`/`.opencode/agents/*.md` output containing one entry per existing agent file, each with `mode`, `model`, and `description` fields populated from that agent's frontmatter — verified by a test asserting entry count matches file count and spot-checking one agent's fields.
- Re-running the translator twice with no source changes produces byte-identical output (idempotent, no timestamp/order drift).
- `AGENTS.md`'s managed block is regenerated on a `CLAUDE.md` change and content outside the markers survives a regeneration — verified by a test that adds hand content outside the markers, regenerates, and asserts it is still present.

**Sequencing Notes**
Depends on M2's config-selection plumbing existing (so the translator's output path is known) but not on the live plugin being functional; can be developed in parallel with the back half of M2.

**Risks**
`.claude/agents/*.md` frontmatter fields not present in every existing agent file (e.g. missing `tier`) — mitigation: translator must define an explicit default/omission rule per field and document it, not fail on missing optional fields.

## Milestone 5: M4 — Metrics Generalization

**Goal**
Cost/pricing display works for OpenCode-sourced events without assuming an Anthropic-only model-id shape.

**Deliverables**
- `media/main.js`'s `MODEL_PRICE_PER_MTOK` (currently `:13494-13505`) restructured into a table keyed by `"provider/model"` (e.g. `"anthropic/claude-sonnet-4"`, `"opencode/<model>"`), with the existing four Anthropic entries preserved under their new keys.
- The Anthropic-only model-id regex (`media/main.js` near `:14954-14971`, `/^claude-(opus|sonnet|haiku|fable)(-\d+)+$/i`) replaced or supplemented with a provider-aware lookup that falls back to a documented default weight when a model id isn't in the table (never a silent zero-cost).
- If M0 confirmed per-event cost/token data in OpenCode payloads, a code path that prefers the event-supplied cost over the static table for OpenCode-sourced events; if M0 could not confirm it, this path is explicitly omitted and documented as deferred (not silently half-built).

**Acceptance Criteria**
- Existing Claude Code cost calculations produce identical numeric output before/after the refactor for the four existing model keys — verified by a test comparing computed cost for a fixed set of sample records pre- and post-change.
- A test asserts an OpenCode-sourced event with a `"opencode/<model>"`-shaped model id resolves to a non-zero, table-defined weight (or the event-supplied cost, if that path was built).
- An unknown/unrecognized model id resolves to the documented fallback weight, not a thrown error or `NaN`.

**Sequencing Notes**
Depends on M2 (needs `NormalizedEvent`s actually carrying an OpenCode model id to test against) and on M0's cost-payload finding to decide scope of the event-cost path.

**Risks**
If OpenCode exposes many more distinct model ids than Claude Code's four, the static table could grow unmaintained — mitigation: document a manual-update process in M5's docs deliverable, same as the existing `update-pricing` skill does for Anthropic pricing.

## Milestone 6: M5 — Docs + Release

**Goal**
The new provider is documented and discoverable the same way `docs/CLAUDE-CODE-PROVIDER.md` documents the existing one, so users and future maintainers don't have to read source to use or extend it.

**Deliverables**
- `docs/OPENCODE-PROVIDER.md` written in parallel structure to `docs/CLAUDE-CODE-PROVIDER.md` (IPC contract, plugin script description, env vars, config wiring snippet).
- README.md updated with an OpenCode provider-selection section (mirroring the existing Claude Code setup instructions).
- Standalone README updated with the CLI flag/env var for provider selection.
- Install-hook/setup script updated (if applicable) to offer OpenCode plugin registration alongside the existing Claude Code hook registration, without altering the existing Claude Code install path.

**Acceptance Criteria**
- `docs/OPENCODE-PROVIDER.md` exists and documents every env var and config key introduced in M2-M4 (cross-check: every new identifier introduced in those milestones' deliverables appears in this doc).
- README.md and standalone README both mention `tycoonagents.provider`/the standalone equivalent flag with a working example value.
- A fresh clone following only the README's OpenCode section, plus a running OpenCode instance, can configure `tycoonagents.provider = "opencode"` and see the panel populate — verified manually once as a smoke test, recorded as a pass/fail note in the PR description.

**Sequencing Notes**
Depends on M2, M3, and M4 all being functionally complete (docs describe finished behavior, not planned behavior).

**Risks**
Documentation drift if M2-M4 change after M5 is drafted — mitigation: M5 is the last milestone, run only after the others are merged.

## Sequencing Notes

M0 (spike) and M1 (core seam) run in parallel — M1 has no dependency on real OpenCode behavior. M2 hard-blocks on M0's go/no-go and on M1 landing. M3 (roster translator) can start once M2's config-selection plumbing exists, in parallel with M2's plugin implementation finishing. M4 depends on M2 (needs real OpenCode-sourced events to test against) and on M0's cost-payload finding. M5 runs last, after M2-M4 are all merged.

## Out of Scope

- Any change to Trashbird's Power Tools: the UEFN bridge, scalar MCP, `media/uefn-bridge/`, or any MCP server registration — these ship separately and this plan must not modify, override, or re-register anything they own.
- A third provider (e.g. Codex per `docs/provider-contract.md`, or a local-model provider) — this plan generalizes the seam to two providers only; a third is a future plan that reuses M1's registry.
- The Codex app-server v2 JSON-RPC surface, streaming/partial-output handling, or tool-use/function-calling passthrough for either provider — explicitly out of scope per `docs/provider-contract.md`'s own scope note and not revisited here.
- Changing Claude Code's default-provider behavior in any way — it remains the default and must be byte-for-byte unchanged.
- Recursive subagent support beyond whatever OpenCode natively provides — M0 only investigates whether it exists; building new orchestration logic around it is out of scope.
