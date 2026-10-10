# Codex Provider

## Problem / Opportunity

TycoonAgents' core already generalized its one Claude-Code-specific coupling: `src/core/provider.ts` defines a vendor-neutral `Provider { id; start(emit); stop() }` interface, `src/core/mappingRegistry.ts` dispatches record→`NormalizedEvent` mapping by provider id, and `src/core/providerSelection.ts`'s `PROVIDER_IDS` (currently `["claude-code", "opencode"]`, ~line 23) already anticipates a third entry. TycoonAgents also already talks to OpenAI's Codex CLI today, but only as an MCP tool: `.claude/agents/codex-reviewer.md` calls `codex`/`codex-reply` through the `codex` MCP server (`media/mcp/catalog.json:193-220`) for adversarial review, and `src/providers/codex/codexDiscovery.ts` already content-verifies the bundled Codex binary. What's missing is Codex as a *primary runtime* — a `CodexProvider` that turns Codex's own agent activity into the same normalized event stream `ClaudeCodeProvider` and `OpenCodeProvider` produce, so a user running Codex natively (not just as a review sub-tool) gets the same panel visualization, and so TycoonAgents' delegation/routing model can, where Codex's own primitives allow it, extend onto a third vendor instead of being Anthropic/OpenCode-only.

Findings below are sourced from two Codex/gpt-6-astra review passes (via the existing `codex` MCP server) run against this codebase's assumptions. Each claim is marked **certain** (Codex CLI content directly observed/confirmed) or **must-verify** (asserted by the review pass but not yet independently confirmed against a running instance — M0's job).

## Target Users

Developers who run OpenAI's Codex CLI (via a ChatGPT subscription, per the existing `codex` MCP catalog entry's auth note) as an agent harness alongside or instead of Claude Code/OpenCode, and want the same TycoonAgents panel/HUD activity visualization Claude Code and OpenCode users get today. Secondary: TycoonAgents maintainers validating that the two-provider registry seam (`src/core/mappingRegistry.ts`, `PROVIDER_IDS`) generalizes to a third vendor without another retrofit, and evaluating whether a Codex-side dispatcher can extend keyword/fallback delegation routing beyond Anthropic and OpenCode workers.

## Goals & Success Metrics

- A user can select "Codex (Experimental)" as the active provider (VS Code setting + standalone CLI flag, matching the existing "OpenCode (Experimental)" label pattern) and see panel activity driven by real Codex session events, with zero behavior change to Claude Code or OpenCode when either remains selected.
- `PROVIDER_IDS` gains `"codex"`; `providerFactory.ts`'s switch gains a `case "codex"`; a `CodexProvider` mapper registers into `mappingRegistry` via `registerAllMappers.ts`, exactly parallel to the OpenCode addition — no new coupling reintroduced into `src/core/state.ts`.
- The standalone host's provider selection is audited and extended in lockstep with the VS Code extension — no duplicated selection logic, per the existing `providerSelection.ts` single-source-of-truth pattern.
- M0's spike produces a GO/NO-GO decision before any Codex-provider production code is written; a NO-GO blocks M2+ and requires this PRD to be amended, not silently worked around.
- No telemetry exists in this codebase to measure adoption; out of scope here, same as the OpenCode PRD's position.

## Core Features

- `CodexProvider` (planned) — implements `Provider` from `src/core/provider.ts`, id `"codex"`, in `src/providers/codex/index.ts`.
- `mapCodexRecord.ts` (planned) — record→`NormalizedEvent[]` mapper following the OpenCode plugin contract shape: `provider: "codex"` plus versioned `eventId`, `invocationId`, `nativeThreadId`, `source`, `outcome`. Roster identity (which named specialist ran) is kept separate from invocation identity (a session/thread id) — the existing shared mapper path rejects a bare UUID worker id, so Codex records must carry a resolvable roster name distinctly from `nativeThreadId`. Concurrent invocations of one specialist are supported (multiple live `invocationId`s under one roster identity); token/cost fields Codex doesn't expose are omitted, never fabricated as zero.
- Binary discovery reuse (shipped, binary-location only) — `src/providers/codex/codexDiscovery.ts`'s `discoverCodexBinary()` already content-verifies the Codex CLI (checks `codex-cli ` version-string prefix, per `docs/PATH-DISCOVERY.md`'s content-over-name-matching rule) across PATH, npm global, Homebrew, home-relative, and the bundled OpenAI ChatGPT VS Code extension signal — **certain**: on this machine it resolves codex-cli 0.153.0 at `C:\Users\<you>\.vscode\extensions\openai.chatgpt-26.901.22334-win32-x64\bin\windows-x86_64\codex.exe`. This path is discovered, never hardcoded, per `docs/PATH-DISCOVERY.md`; `CodexProvider`'s own session/activity discovery is new work — `codexDiscovery.ts` only resolves the binary, not a running session's event source.
- Config/feature surface (must-verify unless noted) — **certain**: `features.multi_agent=true`, `features.multi_agent_v2=false`, `features.hooks=true`; `multi_agent_mode` and `plugin_hooks` are removed config keys (do not reintroduce them); `--enable NAME` sets `features.NAME`; `--strict-config` rejects unknown config fields; a `--dangerously-bypass-hook-trust` flag exists on the hook-trust path, semantics unverified. **Must-verify**: `[agents]` `max_threads`/`max_depth`, per-role `[agents.<role>]` config shape, `[mcp_servers.tycoon]` registration shape, top-level `notify=["program","arg"]` (historically fired on `agent-turn-complete`), the full hook payload/blocking schema, and which models are permitted under ChatGPT-subscription auth (confirmed: `gpt-6` is rejected, `gpt-6-astra` works — same finding already encoded in `.claude/agents/codex-reviewer.md`'s frontmatter and `media/mcp/catalog.json`'s codex launch args).
- Delegation/dispatch (planned, must-verify scope) — Codex's native agent spawn/wait/message primitives are the rough equivalent of the Task tool but do not reproduce TycoonAgents' keyword routing, and do not run Anthropic- or Google-backed workers. A Tycoon MCP dispatcher tool (specialist name + task in, routed through explicit-name → keyword → fallback resolution, out to a worker adapter) is the proposed owner of routing and leaf-restriction enforcement for Codex-originated delegation. Enforcement is bounded: the dispatcher only governs calls that go through it — a native Codex agent spawn or shell escape that bypasses the dispatcher is not stopped by it, and this limit must be measured, not assumed, in M0.
- Event source ranking (must-verify, ordered) — 1) a Tycoon MCP dispatcher (highest fidelity, in-band with delegation), 2) a wrapper process around `codex exec --json`, 3) the rollout JSONL under the Codex home sessions directory (flagged fragile: internal schema, and this build carries rollout-migration logic that could shift the format between versions), 4) the `notify` hook (coarsest, turn-complete only). Codex's `app-server` mode must be evaluated against `exec --json` before this ranking is finalized — not yet compared. Multiple sources, where combined, are normalized with explicit provenance and deduplicated, never silently merged.
- Config generation (planned) — extends `scripts/generate-opencode-config.mjs`'s pattern (routing precedence preserved, managed `AGENTS.md` block ownership at ~line 572) to emit Codex-specific instructions and `[agents.<role>]` entries where the must-verify config shape confirms support — written so it does not fight the OpenCode generator over the same managed block.
- Panel/settings label (decided) — the Codex host option is labeled **"Codex (Experimental)"**, matching the "OpenCode (Experimental)" label already shipped for the OpenCode option.

## User Flows

1. **Select Codex in VS Code**: user sets the provider setting to `codex` (mirroring `tycoonagents.provider = "opencode"`'s pattern); `providerFactory.ts` constructs `CodexProvider` instead of `ClaudeCodeProvider`/`OpenCodeProvider`; the panel renders identically in shape, driven by Codex-sourced `NormalizedEvent`s via the registered mapper.
2. **Select Codex in standalone**: user passes the equivalent CLI flag/env var; the standalone's provider-selection path (audited, not yet extended) resolves the same `codex` id through the shared `providerSelection.ts` module.
3. **Delegate through Codex**: a Codex-native agent spawn is routed through the Tycoon MCP dispatcher, which resolves the target specialist by explicit name, then keyword, then fallback (mirroring this repo's own CLAUDE.md delegation ladder) and enforces leaf-worker restrictions on the resulting child.
4. **Fallback / misconfiguration**: Codex binary not discoverable — `discoverCodexBinary()` throws `CodexDiscoveryError` listing every candidate tried and naming `CODEX_BINARY_PATH` as the override, per `docs/PATH-DISCOVERY.md`; the extension does not silently fall back to another provider without telling the user.

## Non-Functional Requirements

- **Determinism / no regression**: with the provider unset or set to `claude-code`/`opencode`, existing behavior is unchanged; enforced by keeping the existing provider-selection and mapping-registry tests green with zero assertion edits.
- **Discovery**: Codex binary and session/event-source discovery follow `docs/PATH-DISCOVERY.md`'s ladder — override variable first (`CODEX_BINARY_PATH` already exists for the binary; a session/`CODEX_HOME`-equivalent override is new work for M0/M1), then multiple independent signals, content-verified, fail-open per probe, and a listing-every-path-tried error on total failure.
- **Enforcement honesty**: any claim that the dispatcher enforces leaf-worker restrictions must be backed by a bypass-attempt test (M0 item 5) that actually denies the attempt — an unenforced claim must not ship labeled as enforced.
- **Scope isolation**: no change touches Trashbird's Power Tools (UEFN bridge, scalar MCP, `media/uefn-bridge/`) — those ship and are owned separately, same constraint as the OpenCode PRD.
- **Security**: `--sandbox read-only` and `--approval-policy never` (or their config-file equivalents) are used for read-only spike/audit work, matching the existing `codex-reviewer` agent's explicit-per-call-argument pattern (`.claude/agents/codex-reviewer.md`) — launch-time `-c` overrides are defaults, not a ceiling, and must not be relied on alone.

## Tech Stack

- TypeScript core (`src/core/`, `src/providers/`), compiled to `out/`, consumed by both the VS Code extension and the dependency-free standalone host, per the existing `providerFactory.ts` / `registerAllMappers.ts` pattern.
- Codex CLI (codex-cli 0.153.0 observed), invoked via `execFileSync`/spawned child process with `shell: true` on Windows (per `codexDiscovery.ts`'s documented ENOENT-vs-shell-not-recognized trap), and via the existing `codex` MCP server (`media/mcp/catalog.json`) for the dispatcher/review path.
- Config: Codex's `config.toml` (`[agents]`, `[agents.<role>]`, `[mcp_servers.tycoon]`, `notify`), generated/extended by `scripts/generate-opencode-config.mjs`'s pattern.
- Test runner: existing Vitest suite (`test/*.test.ts`).

## Milestones & Scope

In scope: M0 (spike/GO-NO-GO) through M4 (cross-platform hardening, coexistence, exit Experimental). Deferred: any provider beyond Codex, orchestration logic that goes beyond adapting Codex's existing activity streams (this PRD explicitly does not implement new orchestration), and any change to Trashbird's Power Tools. See Milestone Plan below.

## Risks & Open Questions

- **Verdict**: feasible, conditional on the M0 GO/NO-GO spike. Provider wiring adapts Codex's existing activity streams into the normalized event model; it does not implement orchestration Codex itself lacks.
- Every must-verify item listed under Core Features is, by definition, unconfirmed until M0 runs it against a live instance — a NO-GO on any core-identification item blocks M2 and requires this PRD to be amended, not worked around silently.
- **Enforcement limit**: the Tycoon MCP dispatcher only governs calls routed through it; a native Codex agent spawn or shell bypass is not caught by it. This must be measured (not assumed) via the bypass-attempt test in M0 item 5.
- **Event-source fragility**: the rollout JSONL fallback depends on Codex's internal schema and this build's own rollout-migration logic — a Codex version bump could silently break it; the ranking above deliberately treats it as third-choice, not primary.
- **Coexistence risk**: `CodexProvider` must tail/interpret its own event source independent of `ClaudeCodeProvider`/`OpenCodeProvider`, the same way OpenCode's provider was built to coexist per-record via `provider` field dispatch — a naive implementation could assume single-provider-per-file and break the existing dual-provider coexistence design.

# Milestone Plan

## Overview

Adds Codex as a third, user-selectable `Provider`, following the seam OpenCode already validated (`PROVIDER_IDS`, `mappingRegistry`, `providerFactory.ts`). Gated by an M0 spike because, unlike OpenCode's plugin-hook model, Codex's event surface is genuinely unconfirmed at several load-bearing points (delegation identification, hook payload shape, config schema). No fixed calendar timeframe.

## Milestone 1: M0 — Codex API Spike (GO/NO-GO)

**Goal**
Resolve the must-verify items above before any production code depends on them.

**Checklist**
1. Run `codex --version`, `codex --help`, `codex exec --help`, `codex app-server --help` against the discovered binary; record output verbatim. Done.
2. Set an isolated `CODEX_HOME` and run `codex features list` (or equivalent) to confirm the certain/must-verify feature-flag split above. Done.
3. Stand up an isolated `CODEX_HOME` configured with two specialist roles, a logging Tycoon MCP dispatcher stub, and a hook/notify recorder; run `--strict-config exec --sandbox read-only --json "Return M0_OK"` and confirm `--strict-config` rejects any unknown field while a valid minimal config succeeds.
4. Delegate two independent read-only tasks through the dispatcher stub; expect two distinguishable child sessions with correct parent links and terminal outcomes (not merged into one, not orphaned).
5. Attempt a dispatcher bypass (a native Codex agent spawn or shell escape that skips the dispatcher), force a worker failure, a cancellation mid-task, and a replay of a completed session — the bypass attempt must be denied wherever enforcement is claimed; every other case must produce exactly one terminal visualization state per child, not zero and not duplicates.

**Acceptance Criteria**
- A findings doc records, for each must-verify item, the literal observed output (or "UNRESOLVED" if the spike could not trigger it) — no item silently omitted.
- A GO/NO-GO line is present and unambiguous, with a one-sentence reason.
- GO requires: correlated lifecycle events across the two-delegation test (item 4), the routing/config shape items resolved (items 2-3), and the enforcement boundary in item 5 proven, not assumed.
- NO-GO blocks M2+; this PRD's Risks section must be amended before proceeding.

**Sequencing Notes**
Must complete (or reach a GO) before M2. M1 (provider skeleton/registry wiring) can start in parallel since it reuses the existing `mappingRegistry`/`PROVIDER_IDS` seam without depending on Codex's real event shape.

**Risks**
Codex CLI version drift between spike time and later milestones — mitigation: pin and record the exact `codex-cli` version in the findings doc, same discipline `codexDiscovery.ts` already applies via content-based verification.

## Milestone 2: M1 — Provider Skeleton + Registry Wiring

**Goal**
`codex` becomes a recognized `ProviderId` with a constructible (if minimal) `CodexProvider`, without depending on M0's real event shape.

**Deliverables**
- `PROVIDER_IDS` in `src/core/providerSelection.ts` (~line 23) extended to include `"codex"`.
- `src/providers/codex/index.ts` (`CodexProvider implements Provider`, id `"codex"`) and `src/providers/codex/mapCodexRecord.ts`, registering into `mappingRegistry` via the same pattern `src/providers/opencode/index.ts` uses.
- `src/host/vscode/providerFactory.ts` (~line 25) gains a `case "codex"` returning `new CodexProvider(...)`.
- `src/providers/registerAllMappers.ts` imports `./codex` alongside `./claude-code` and `./opencode`.
- The standalone host's provider-selection path audited for the same `codex` id support (no duplicated selection logic introduced).

**Acceptance Criteria**
- Existing provider-selection and mapping-registry tests pass unmodified for `claude-code`/`opencode`.
- A new test asserts `createProvider("codex", ...)` returns a `CodexProvider` instance and that an unrecognized id still throws via the existing exhaustive-switch default.
- `grep` confirms no new direct import bypasses the registry (mirrors M1's acceptance bar in the OpenCode PRD).

**Sequencing Notes**
No dependency on M0's real event data — only needs `Provider`/registry shapes, which are already stable from the OpenCode addition. Must land before M2.

**Risks**
Low — this milestone only replays an already-proven pattern for a third id.

## Milestone 3: M2 — Real Event Mapping, Config Generation, Roster Dispatch

**Goal**
`CodexProvider` emits real `NormalizedEvent`s from a live Codex session, and Codex config generation extends `scripts/generate-opencode-config.mjs`'s pattern without overwriting user config or fighting the OpenCode generator's managed `AGENTS.md` block.

**Deliverables**
- `mapCodexRecord.ts` implemented against M0's confirmed event-source ranking (dispatcher > `exec --json` wrapper > rollout JSONL > notify hook), producing records carrying `provider: "codex"`, `eventId`, `invocationId`, `nativeThreadId`, `source`, `outcome`.
- Config generation extended to emit Codex `[agents.<role>]` entries and instructions where M0 confirmed the shape, using the same managed-block-ownership discipline as `scripts/generate-opencode-config.mjs` (~line 572).
- The Tycoon MCP dispatcher tool implementing explicit-name → keyword → fallback routing for Codex-originated delegation, with leaf-worker enforcement.
- Panel/settings label "Codex (Experimental)" wired into the VS Code setting and standalone flag.

**Acceptance Criteria**
- A live (or recorded-fixture) Codex session drives at least one worker delegation through `CodexProvider` → `NormalizedEvent` → visible panel state, at parity with the equivalent Claude Code/OpenCode test cases.
- Config generation does not overwrite unrelated content in a shared managed block — verified by a test adding hand content outside markers, regenerating, and asserting survival (same pattern as the OpenCode PRD's M3).
- Dispatcher enforcement test from M0 item 5 is reproduced as an automated test, not just a manual spike finding.

**Sequencing Notes**
Hard-blocked on M0 GO and M1 landing.

**Risks**
If M0 found the rollout-JSONL fallback fragile, M2's event pipeline must degrade gracefully (coarser, session-level-only visibility) rather than silently breaking when the dispatcher/exec-json path is unavailable.

## Milestone 4: M3 — Authoritative Events, Dedup, Resume, Crash Handling, Visualization Identity

**Goal**
`CodexProvider` is reliable enough for continuous use: correct under restart, cancellation, and multi-source event overlap.

**Deliverables**
- Deduplication logic when more than one ranked event source is active simultaneously (e.g. both a dispatcher stream and a notify hook firing for the same turn).
- Reconnect/resume handling after a Codex process restart or a dropped `exec --json`/`app-server` connection.
- Stable parent/child id assignment across a session's full lifecycle, surviving cancellation and failure paths.

**Acceptance Criteria**
- A simulated mid-session crash-and-restart produces no duplicate or orphaned visualization nodes.
- Cancellation of an in-flight delegated task produces exactly one terminal outcome for that child, matching the acceptance bar M0 item 5 established manually.

**Sequencing Notes**
Depends on M2's real event mapping existing to dedup/resume against.

**Risks**
Codex's `app-server` mode (still unevaluated against `exec --json` as of M0) could change the resume/reconnect contract; if M0 only validated `exec --json`, this milestone must re-confirm `app-server` behavior before relying on it, or explicitly stay on `exec --json`.

## Milestone 5: M4 — Cross-Platform Discovery, Permissions, Mixed-Vendor Coexistence, Exit Experimental

**Goal**
Codex provider works the same way on macOS/Linux as Windows, coexists cleanly with Claude Code and OpenCode providers active on the same machine, and the "(Experimental)" label is removed once proven.

**Deliverables**
- `codexDiscovery.ts`'s existing cross-platform signals (Homebrew, home-relative, VS Code extension bundle) validated on macOS/Linux, not just the Windows path already confirmed.
- A coexistence test: `CodexProvider`, `ClaudeCodeProvider`, and `OpenCodeProvider` records interleaved in one activity source, each correctly dispatched by its own mapper via the `provider` field, mirroring `OpenCodeProvider`'s existing coexistence design.
- Permission/sandbox behavior audited across platforms (the `--dangerously-bypass-hook-trust` flag's semantics, unverified as of M0, must be resolved before this milestone can claim safe defaults).

**Acceptance Criteria**
- Discovery succeeds (or fails loudly with every path tried) on all three platforms — no silent empty result anywhere in the ladder.
- Mixed-provider coexistence test passes with all three providers' events correctly attributed.
- "Codex (Experimental)" label is removed only after this milestone's acceptance criteria are met and recorded.

**Sequencing Notes**
Last milestone; depends on M2 and M3 being functionally complete.

**Risks**
Cross-platform Codex CLI behavior (sandbox/approval semantics especially) may differ from the Windows-only findings this PRD currently cites — flagged explicitly rather than assumed portable.

## Sequencing Notes

M0 (spike) and M1 (registry skeleton) run in parallel — M1 has no dependency on Codex's real event shape. M2 hard-blocks on M0 GO and M1 landing. M3 depends on M2. M4 runs last, after M2 and M3 are functionally complete.

## Out of Scope

- A fourth provider, or any provider-neutral generalization beyond what M1 already reuses from the OpenCode addition.
- New orchestration logic Codex itself does not provide — this PRD adapts Codex's existing activity streams into TycoonAgents' event model; it does not build orchestration Codex lacks.
- Any change to Trashbird's Power Tools (UEFN bridge, scalar MCP, `media/uefn-bridge/`, any MCP server registration it owns).
- Changing Claude Code or OpenCode's default-provider behavior in any way.
