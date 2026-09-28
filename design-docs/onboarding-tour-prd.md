# Onboarding Tour & Routing Confidence PRD

**Status:** Proposed — to be decomposed into plan phases
**Audience:** solo devs and small teams

## Problem / Opportunity

TycoonAgents is an idle-tycoon visualization of your AI agent team, not a game. As the team works, completed tasks build objects that fill the stage, rivals appear while agents are active and attack the built objects, the team repairs objects and fights rivals off, and turrets help once unlocked. Rebirth resets the stage for permanent perks and tiers, and some surprises unlock as you rebirth.

Today a new user lands on an empty stage with no explanation of this loop, no way to see it happen without doing real work first, and no guided path through delegation, harness choice, other-AI fallback, or theming. The first-run wizard (media/src/main/010-modals-badges-rebirth.js ~1357-1419) only installs the stage and optional pieces — it never explains what any of it means, and it sets no completion flag. There is also no demo/idle mode: a user cannot see the loop animate until their own agents actually run. Separately, users have no fast way to check whether their keyword routing is actually correct — the only existing check (the ready test) proves agents appear on the stage, not that prompts route to the right specialist.

## Target Users

Solo devs and small teams adopting TycoonAgents to visualize their Claude Code (and optionally OpenCode (Experimental)/Codex (Experimental)) agent team. They are technical enough to edit keyword config but not necessarily familiar with the product's tycoon metaphor or its Settings surface on first install.

## Goals & Success Metrics

- Increase the share of new installs that reach a working, understood setup without filing a support issue.
- Give users a fast, honest signal on whether their keyword routing is correct, separate from whether the visualization is wired up.
- Metrics to track (none exist today; to be added):
  - Tour completion rate (finished all stops vs. started).
  - Tour skip rate, and which stop most users skip from.
  - First-week support/issue volume referencing setup or routing confusion, before vs. after.
  - Token-free routing check pass rate at first run vs. after a fix.

## Core Features

- **Coach-mark tour** (planned) — six stops over the real panel, offered once after first-run setup completes, skippable, restartable from the Menu, completion remembered per user, keyboard accessible, harness-branched text, all steps in one data file.
- **Demo/idle mode** (planned, new) — a short simulated burst of activity (a mock task completing, an object building) so stop 1 can show the loop without requiring real agent work.
- **Token-free routing check** (planned, new) — a pure keyword scorer that predicts, per sample prompt, which agent wins, run against samples derived from each agent's own keyword patterns, shown as a pass/fail table with specific, actionable failure copy.
- **Live ready test integration** (existing, relabeled) — the current tycoon-ready-test skill, exposed in the tour/routing UI as an optional step labeled to make clear it only confirms agents render on stage, not that routing is correct.
- **First-visit hints** (planned) — one-time, dismissible callouts for routing/fallback badges, plan gates, and theme review, independent of the six-stop tour.
- **Data-tour anchors** (planned, new) — stable `data-tour` attributes added to panel elements that today have no stable id (notably Settings), so the tour and its future maintenance don't depend on fragile selectors.

## User Flows

1. **First run:** user completes the existing setup wizard (010-modals-badges-rebirth.js) → tour is offered once → user steps through 6 stops or skips → completion is recorded per user.
2. **Restart tour:** user opens Menu (#menu-btn / #menu-popover) → selects "Restart tour" → same 6 stops replay regardless of prior completion state.
3. **Routing check:** user opens the routing check surface (from Menu or Settings) → sees the token-free pass/fail table immediately, no network/model call → optionally clicks "Run live check" → sees the ready-test result labeled with its actual scope and cost.
4. **First-visit hints:** the first time the user sees a routing/fallback badge, a plan gate, or the theme review screen, a single dismissible callout explains it; it never reappears once dismissed.

## Non-Functional Requirements

- **Accessibility:** tour must be operable via keyboard alone (tab/enter/escape to advance, skip, and close); focus must move to each coach-mark's anchor.
- **Harness-awareness:** tour copy branches on active harness — Claude Code is the default voice; OpenCode and Codex steps are labeled "(Experimental)" per existing product convention (see keep-experimental-labels).
- **Data-driven:** all six stops, their anchor ids, and their copy live in one data file, not scattered across UI code, so translation/harness-branching and future edits stay centralized.
- **No token cost for the base routing check:** the token-free scorer must run entirely offline against agent-keywords.json; only the optional live check may spend model calls.
- **Persistence:** tour completion and dismissed first-visit hints are stored per user, not per project (no existing per-user store for this was found; needs a small addition — see Dependencies).
- **Never mislead on routing:** the live ready test must never be presented as proof of keyword correctness; the UI copy must state its actual scope every time it appears.

## Tech Stack

- Panel UI: existing media/src/main bundle (010/030/110 series files), shared by the VS Code extension and the standalone app (both serve media/main.js).
- Keyword routing data: `.claude/tycoon/agent-keywords.json` (pipe-delimited patterns).
- Keyword health baseline: `src/core/keywordHealth.ts` `computeKeywordHealth` — a static checker; the new token-free scorer is a related but distinct feature (it predicts routing outcomes for sample prompts rather than validating config shape).
- Ready test: `.claude/skills/tycoon-ready-test/SKILL.md`, spawns agents by explicit name prefix.
- Handbook: `media/handbook/ch-04.html` (tier perks), and a new/likely `ch-15` reference for other-AI fallback (to confirm exact chapter during implementation).

## Milestones & Scope

**In scope for this PRD's phases:**
- Coach-mark engine, data file format, and anchors.
- Demo/idle mode sufficient to animate stop 1.
- Tour content for all 6 stops, harness-branched.
- Token-free routing scorer and its pass/fail table UI.
- Relabeled live-check entry point.
- First-visit hints for routing/fallback, plan gates, theme review.
- Per-user persistence for tour completion and dismissed hints.

**Deferred / explicitly out of scope:**
- Any change to the actual keyword-routing engine itself.
- Video walkthrough production (tracked separately; see intro-video-script.md).
- Any new hotkeys or triggers to launch the tour (none are to be named per product decision).

### Suggested Phase Breakdown

1. **Coach-mark engine + anchors** — build the generic coach-mark component, add `data-tour` anchors to existing elements (#menu-btn, #menu-popover, #theme-picker-grid, #tab-theme-builder, .settings-multi-provider-row) and new ones (Settings has none today), and the per-user completion store.
2. **Tour content + demo mode** — author the 6-stop data file, harness-branch the copy, and build the demo/idle activity burst used in stop 1.
3. **Routing check** — implement the token-free scorer against agent-keywords.json, generate sample prompts from each agent's own keyword patterns, build the pass/fail table and its specific failure copy, and relabel the existing ready test as the optional live check.
4. **First-visit hints + video** — add the three one-time hint callouts (routing/fallback, plan gates, theme review) and align delivery with the intro video (design-docs/intro-video-script.md).

A plan for these phases gets registered later via the `project-plan` skill; this document is the design input to that decomposition, not the plan itself.

## Risks & Open Questions

- **UI drift:** as panel markup changes, tour anchors can silently break. Mitigate with `data-tour` attributes (rather than relying on incidental ids/classes) plus a test that asserts every tour step's anchor exists in the rendered DOM before release.
- **Demo mode fidelity:** a simulated activity burst must not be mistaken by the user for real agent work; needs a clear "demo" visual treatment.
- **Persistence gap:** no existing per-user (as opposed to per-project) store was confirmed for tour completion or dismissed hints; this needs a small new mechanism, to be scoped during phase 1.
- **Handbook chapter reference:** the fallback stop links to `media/handbook/ch-15.html`, which covers other AIs and fallback (confirmed to exist).
- **Scope of "OpenCode (Experimental)/Codex (Experimental) not yet supported":** the routing check must explicitly say when a harness isn't supported yet rather than silently showing Claude Code-only results.
- **False confidence risk:** the single biggest risk this PRD exists to address — a routing check that looks authoritative but isn't. All copy for both the token-free and live checks must be reviewed against the "never say generic broken" and "distinguish not-set-up from failing" requirements before release.

## Dependencies

- `.claude/tycoon/agent-keywords.json` as the source of truth for the token-free scorer's sample generation.
- `src/core/keywordHealth.ts` as a reference implementation for static config parsing (not reused wholesale, since it validates config shape rather than predicting routing outcomes).
- `.claude/skills/tycoon-ready-test/SKILL.md` for the live-check integration.
- A new per-user persistence mechanism for tour/hint completion (no existing one confirmed).
- `media/handbook/ch-04.html` and `media/handbook/ch-15.html` for in-tour deep links.
