# Roadmap — TycoonAgents

> **Historical document (June 2026) — frozen.** This is the original v0 plan the project was built from; it is intentionally not updated. Current state lives in the release history (git log), docs/plan/, and the shipped extension itself.

> The phased plan derived from the Project Brief. Each phase is a coherent, demoable increment whose acceptance criteria are pinned *before* work starts — that's how drift is caught at the gate.

## Sequencing rationale
Build inward-out, matching the architecture (DESIGN §7): a tested event → state core first, then the renderer, then the per-agent metrics that are the product's core value, then the panel hub, then the systems that layer on it (themes, skills, planning), then multi-provider and shipping. The Claude Code provider, state model, and a minimal renderer are already scaffolded, so Phase 1 hardens rather than greenfields.

## Crew (derived roster)
- **Core:** orchestrator · fallback · search-retrieval (Haiku)
- **Specialists:** coding-specialist (Sonnet) · testing-specialist (Sonnet) · vscode-integration (Sonnet) · ux-ui-designer (Sonnet) · workspace-monitor (Sonnet)

## Legend
- **Gate:** `stop` (hard-stop for sign-off) · `auto` (proceed if criteria met). Risk drives the choice.
- **Status:** planned · in-progress · in-review · accepted

---

## Phase 1 — Foundation hardening
- **Goal:** a stable normalized-event → state → canvas pipeline driven by the Claude Code provider.
- **Tasks:**
  - [ ] Solidify normalized event types + Provider interface — *coding-specialist*
  - [ ] State-model unit coverage (host-agnostic) — *testing-specialist*
  - [ ] Claude Code hook → normalized events — *coding-specialist*
  - [ ] Minimal canvas renderer + one built-in default theme — *ux-ui-designer*
- **Acceptance criteria:**
  - `tycoonagents.demo` animates workers through arrive/build/haul/survey/celebrate states.
  - Live mode reflects real Claude Code agent activity.
  - State-model unit tests pass.
- **Review method:** F5 → open panel → run demo, then run a real agent task; observe workers.
- **Gate:** stop · **Risk:** med
- **Depends on:** current scaffold
- **Milestone badge:** Foundation laid
- **Status:** planned

## Phase 2 — Per-agent metrics
- **Goal:** the panel shows accurate per-agent metrics.
- **Tasks:**
  - [ ] Capture metrics in state from events/hooks — *workspace-monitor*
  - [ ] Correct per-agent model attribution (config fallback) — *workspace-monitor*
  - [ ] Render per-agent readouts — *ux-ui-designer*
- **Acceptance criteria:**
  - Selecting/hovering an agent shows model, active status, tasks completed, token cost, MCP-call count, response rate.
  - Displayed numbers match actual activity (search-retrieval shows Haiku).
- **Review method:** run a multi-agent session; compare panel metrics to ground truth.
- **Gate:** stop · **Risk:** med
- **Depends on:** Phase 1
- **Milestone badge:** Dashboard online
- **Status:** planned

## Phase 3 — Panel menu hub (hamburger) + two-way messaging
- **Goal:** the DOM-overlay hub with run control + debug/diagnostics, and a webview↔host command channel.
- **Tasks:**
  - [ ] Two-way message protocol (`{type:"command",...}`) — *vscode-integration*
  - [ ] Hamburger DOM overlay + sections + `D` hotkey — *ux-ui-designer*
  - [ ] Run control (Live/Demo/reset); debug overlay; doctor + bug report — *vscode-integration* / *workspace-monitor*
- **Acceptance criteria:**
  - Hamburger and `D` open the hub; Live ⇄ Demo + reset work.
  - Debug overlay shows agent paths/states + routing log; doctor reports install health; commands round-trip to host.
- **Review method:** open hub, toggle demo, run doctor, toggle debug overlay.
- **Gate:** stop · **Risk:** med
- **Depends on:** Phase 2
- **Milestone badge:** Site trailer set up
- **Status:** planned

## Phase 4 — Theme manifest (art-as-data)
- **Goal:** the default theme loads through a versioned manifest.
- **Tasks:**
  - [ ] Define the versioned theme manifest schema (incl. the §3.1 animation set) — *coding-specialist* / *ux-ui-designer*
  - [ ] Refactor the renderer to load the default theme through the manifest — *ux-ui-designer*
- **Acceptance criteria:**
  - Changing a manifest value changes visuals with no code change.
  - The default theme renders entirely through the manifest; the schema is versioned.
- **Review method:** edit a manifest field, reload, observe the change.
- **Gate:** stop · **Risk:** med
- **Depends on:** Phase 1
- **Milestone badge:** Themes unlocked
- **Status:** planned

## Phase 5 — Skills system (registry + panel browser)
- **Goal:** install/remove skills from the panel, per project, with doctor visibility.
- **Tasks:**
  - [ ] Registry schema + lean bundled set (incl. Graphify recommended) — *coding-specialist*
  - [ ] Idempotent install/remove engine — *vscode-integration*
  - [ ] Browser UI in the hub; wire `agentKeywords` routing — *ux-ui-designer*
- **Acceptance criteria:**
  - Browse the catalog in the panel; install lands in `.claude/skills/<id>/` idempotently; remove is clean; doctor lists what's installed.
- **Review method:** install then remove a skill from the panel; run doctor.
- **Gate:** stop · **Risk:** med
- **Depends on:** Phase 3
- **Milestone badge:** Tool shed stocked
- **Status:** planned

## Phase 6 — Planning flow + Graphify
- **Goal:** the planning pipeline is usable from the panel, with Graphify-powered Site Survey and search acceleration.
- **Tasks:**
  - [ ] Site Survey context model via Graphify; search-retrieval consults the graph (PreToolUse) — *workspace-monitor* / *coding-specialist*
  - [ ] Crew Assembly roster derivation from the Brief — *coding-specialist*
  - [ ] Master Plan / Roadmap generation; Build & Inspect gate UI — *ux-ui-designer* / *vscode-integration*
- **Acceptance criteria:**
  - Point at a repo → Graphify context model + a Brief draft; derive a roster; generate a Roadmap with per-phase acceptance criteria; a gate stops and surfaces a live demo for sign-off.
- **Review method:** run the flow on an empty dir and an existing repo; confirm a gate stops with a demo.
- **Gate:** stop · **Risk:** high
- **Depends on:** Phases 2, 5
- **Milestone badge:** Master plan approved
- **Status:** planned

## Phase 7 — Standalone theme builder + second provider
- **Goal:** prove the two big abstractions (art-as-data, source-agnostic).
- **Tasks:**
  - [ ] Standalone theme builder tool (authors/edits theme bundles) — *ux-ui-designer*
  - [ ] A second provider (local/API) emitting normalized events — *coding-specialist*
- **Acceptance criteria:**
  - A theme authored outside the plugin loads at runtime.
  - A local/API provider drives the panel with the renderer unchanged.
- **Review method:** load an externally-built theme; run the second provider and watch the same panel.
- **Gate:** stop · **Risk:** med
- **Depends on:** Phases 4, 1
- **Milestone badge:** Workshop opened
- **Status:** planned

## Phase 8 — UEFN Power Tools + dual-ship
- **Goal:** coexist with UEFN Power Tools as an independent third-party MCP and ship a clean plugin.
- **Tasks:**
  - [x] Power Tools stays the independent `Corsair-Studios/trashbyrds-uefn-power-tools` repo (single source of truth, publishes its own releases); Power Tools is not bundled, not downloaded — a third-party MCP the user installs (see `docs/POWER-TOOLS-COEXISTENCE.md`) — *coding-specialist*
  - [ ] Install robustness + doctor; ship-plugin-not-framework VSIX (`.vscodeignore`); repo hygiene (`.gitignore`/`.urcignore`) — *vscode-integration*
- **Acceptance criteria:**
  - The VSIX contains only the runtime plugin; doctor passes on a fresh checkout; the user's own Power Tools install works with the shipped catalog entry; per-developer agent artifacts are excluded from shared repos.
- **Review method:** build the VSIX, inspect its contents, run doctor on a clean checkout.
- **Gate:** stop · **Risk:** high
- **Depends on:** Phases 3, 5
- **Milestone badge:** Shipped
- **Status:** planned

---
**Backlog (not yet phased):** Verse Blueprint Viewer (see `BACKLOG.md`) · a deeper achievements/badges economy · cross-session persistence.

*Status:* draft · *Approved by:* <pending> · *Last updated:* 2026-06-22
