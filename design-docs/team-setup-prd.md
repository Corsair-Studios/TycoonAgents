# Team Setup Export and Apply

## Problem / Opportunity

TycoonAgents installs are machine-specific by design: `.claude/tycoon/` (routing.json, plan.json) and `.claude/session-journal.json` are gitignored by both hosts (`panel.ts` `_handleAddGitignoreEntries`, ~5066-5109; mirrored in `server.mjs` ~2518-2534) because they hold per-machine state. Committed material — `.claude/agents/*.md`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/skills/` — is path-free by convention, so a teammate cloning gets roster and doctrine but not routing, env-var requirements, or a readiness check. Worse, `hookInstall.ts` (~line 225) writes hook `command` strings into shared, committed `.claude/settings.json` — a baked-in absolute path means teammate B's hooks point at teammate A's disk.

There is no supported way to hand a teammate "the same team, working on their machine." This PRD defines an export/apply/readiness/drift loop closing that gap.

## Target Users

Indie teams and small studios sharing one git repository who want every contributor's Claude Code session to use the same agent roster, routing policy, and delegation doctrine, without hand-configuring routing.json or debugging a cloned hook.

## Goals & Success Metrics

- A teammate cloning the repo and running "Apply team setup" ends up with working hooks, seeded agents, and matching routing, with zero manual JSON editing.
- "N of M agents ready" is visible in both the VS Code panel and standalone UI before anyone tries to use the team.
- No export ever contains a secret value or absolute path — enforced by a grep gate, not code review.
- No install-success telemetry exists today; this PRD proposes the readiness report itself as the tracked signal (ready count over time, local-only, never uploaded).

## Core Features

1. **Export team setup** (planned) — writes committed `.claude/tycoon-team.json`.
2. **Apply team setup** (planned) — re-runs installers from the manifest.
3. **Readiness report** (planned) — per-agent CLI/env/model status, panel + standalone.
4. **Drift prompt** (planned) — "Team setup changed, apply?" when the manifest is newer than the last-applied stamp.
5. **Portable hooks** (planned, prerequisite) — fixes `hookInstall.ts` baking absolute paths into `.claude/settings.json`.

None exist today; all build on existing installer functions already run per-host.

## User Flows

- **Export (owner machine):** Owner clicks "Export team setup" (panel or standalone). Exporter reads roster, routing profile, skills, MCP catalog, delegation mode/parallel limit, and (if present) plan pointer; strips values to env var *names* + set/unset flags; runs the grep; writes `.claude/tycoon-team.json`; owner commits.
- **Apply (teammate machine, fresh clone):** Teammate clones, opens the panel. Panel detects the manifest with no local-applied stamp and offers "Apply team setup." Apply re-runs the now-portable hook installer, seeds agents from the roster, writes `.claude/tycoon/routing.json` from the routing profiles, applies skills/MCP selections, and records an applied stamp (manifest date) locally.
- **Readiness check (either machine, any time):** A "Team Readiness" view lists per agent: vendor CLI found, env vars set/unset (names only), a cheap reachability probe where one exists, and the fallback that would be used. Summary line: "N of M agents ready."
- **Drift (later):** Owner changes and pushes `tycoon-team.json`. Teammate pulls, opens the panel; it compares the manifest's date against the last-applied stamp and shows a one-line re-apply prompt. Declining leaves local setup untouched.

## Non-Functional Requirements

- **Security:** never write secret values or absolute paths into `.claude/tycoon-team.json`; export runs a grep before the write and refuses on a match, enforced by a test.
- **Portability:** hook commands in `.claude/settings.json` resolve via the `docs/PATH-DISCOVERY.md` ladder (override-var first, then relative/discovered), not a baked-in absolute path — a fix to `hookInstall.ts`, not new scope.
- **Idempotency:** re-running Apply on an already-applied machine is a no-op except where the manifest changed (mirrors `hookInstall.ts`'s `isPureOurs`/`alreadyOurs` pattern).
- **Fail-open:** readiness probes that can't determine status report "unknown," never silently "ready."
- None enforced today since the feature doesn't exist; M1/M4 add the grep test and portability fix.

## Tech Stack

TypeScript across both hosts: `panel.ts` (VS Code extension) and `standalone/src/server.mjs`, sharing installer logic (delegation-doctrine module, `writeExecutionConfig`/`readExecutionConfig`, `hookInstall.ts`). Secrets live in `src/core/localEnvStore.ts`, out of scope for export. Ignored local state lives under `.claude/tycoon/`.

## Milestones & Scope

In scope: schema + portable hooks + export (M1), apply-on-fresh-clone (M2), readiness + drift (M3), docs/tests/release (M4). Deferred: cloud sync, accounts, secret/theme/plan/app-data sync (see Out of Scope).

## Risks & Open Questions

- **Not independently verified this pass:** the exact body of `hookCommand` construction in `hookInstall.ts` beyond confirming it's written at line ~225; M1 requires a fresh read before the fix lands.
- Routing profiles may name a vendor/model a teammate's setup doesn't support (no Claude subscription) — Apply falls back via the existing tracked-fallback mechanism, not fail outright.
- Version mismatch (older/newer TycoonAgents applying a manifest) needs an explicit "unsupported schema version" error, never a partial apply.
- Drift depends on an applied-stamp in the ignored folder — deleting `.claude/tycoon/` loses drift history and simply re-prompts apply.

---

# Team Setup Export and Apply — Milestone Plan

## Overview

Four milestones deliver a portable, secret-free way to share a TycoonAgents team configuration through git: fix hook portability and define/export the manifest (M1), consume it on a fresh clone (M2), surface readiness and drift (M3), then document/test/release (M4). Target: one release cycle, sequential.

## Milestone 1: Portable Hooks and Manifest Schema Plus Export

**Goal**
Hook installation stops baking absolute paths into shared `.claude/settings.json`, and an owner can export a secret-free, path-free team manifest to committed `.claude/tycoon-team.json`.

**Deliverables**
- Fix `src/host/vscode/hookInstall.ts` (~line 225 `hookCommand` construction) so the written `command` resolves via discovery (relative path or override-variable) instead of a baked-in absolute path.
- Define the `tycoon-team.json` schema: schema version, roster (agent ids + display names), per-agent routing profile (vendor/model, fallback chain, cost class), required env var names with set/unset flag, enabled skills, MCP catalog choices, delegation mode + parallel limit, optional plan pointer (path only), exporter version and export date.
- Export action in both hosts (panel button, standalone route) assembling the manifest from current roster/routing/skills/MCP/delegation state and writing `.claude/tycoon-team.json` (not under `.claude/tycoon/`, so committed by default).
- Secret/absolute-path grep gate over the assembled JSON before write; write refused with an explicit error on any match.

**Acceptance Criteria**
- A hook installed on machine A, committed, then checked out fresh on machine B with no shared filesystem, still fires (simulated via fake HOME/project root; Node script fakes, never compiled binaries, per project test convention).
- Exporting with an env var set to a real-looking secret value fails the write and names the offending field, never the value.
- The exported manifest contains zero absolute paths (no `C:\`, `/Users/`, `/home/`) and zero values under the env-vars section (names + boolean only).
- Re-exporting unchanged config produces a byte-identical manifest except the export date field.

**Risks**
Touches security-relevant hook-install code (Sonnet-tier review required). Keep the fix limited to `hookCommand` construction, reviewed against `isPureOurs`/dedup logic.

## Milestone 2: Apply on a Fresh Clone with Installers

**Goal**
A teammate with a fresh clone and no prior TycoonAgents install can run "Apply team setup" and end up with the roster, routing, skills, and MCP catalog the manifest describes.

**Deliverables**
- Apply action in both hosts reading `.claude/tycoon-team.json` and re-invoking existing installers: agent seeding, `.claude/tycoon/routing.json` write, opencode config write, MCP catalog application, and the now-portable M1 hook install.
- Schema-version check: an unsupported manifest version produces an explicit error and stops apply (never a silent partial apply).
- Applied-stamp write to `.claude/tycoon/` recording the manifest's export date, used by M3's drift check.

**Acceptance Criteria**
- Fresh-clone simulation (empty `.claude/tycoon/`, no prior hook entries) followed by Apply produces a working hook entry, a routing.json matching the manifest's profiles, and agent files matching the roster.
- Applying a manifest with a bumped major schema version fails with a named error rather than partially writing config.
- Re-running Apply twice on an unchanged manifest is a no-op (no duplicate hook entries, no routing.json rewrite).
- Applying over existing different local routing overwrites only team-managed fields; per-user secrets in `localEnvStore.ts` are untouched.

**Risks**
A teammate's machine may lack a vendor CLI or credential the manifest assumes — Apply must not hard-fail; it applies what it can and lets M3's readiness report surface the gap.

## Milestone 3: Readiness Report and Drift Prompt

**Goal**
Anyone can see, per agent, whether their machine can actually run the team, and is proactively told when the shared manifest has changed since they last applied it.

**Deliverables**
- Readiness report: per-agent vendor CLI detection (Claude, Codex launcher, OpenCode, local endpoint), env var set/unset (names only), a cheap reachability probe per vendor where one exists, and the fallback that would actually be used if primary is unreachable.
- Rendered in the VS Code panel and standalone UI, ending with "N of M agents ready."
- Drift check on panel open comparing the manifest's export date against M2's applied-stamp; shows a one-line "Team setup changed, apply?" prompt when newer.

**Acceptance Criteria**
- A machine missing one vendor CLI marks only that agent (and any agent whose fallback also fails) not-ready, with a matching summary count.
- No env var value ever appears in report output, logs, or UI — only name and set/unset boolean.
- Re-committing an edited manifest, then reopening the panel on a machine that applied the prior version, shows the drift prompt; declining leaves config unchanged; accepting re-runs Apply and clears the prompt.
- Readiness renders with identical structure across the VS Code panel and standalone UI.

**Risks**
Reachability probes calling a real vendor endpoint cost money/quota per run — make probes opt-in or short-TTL cached, never automatic on every panel open. Drift false-positives if clocks differ — compare the manifest's embedded date field, not filesystem mtimes.

## Milestone 4: Docs, Tests, Packaging Grep, Release

**Goal**
The feature is documented, covered by tests at the level CLAUDE.md's Tests coding standard requires, and cannot regress the secret/path-safety guarantees in future packaging.

**Deliverables**
- README/docs section describing Export, Apply, Readiness, and Drift, cross-referenced from `docs/PATH-DISCOVERY.md`.
- Test suite covering M1-M3 acceptance criteria end-to-end (export → commit → simulated fresh clone → apply → readiness → drift), deterministic, no real timers/network, reviewed per CLAUDE.md's review-pass rule.
- Packaging-time grep step running the M1 secret/absolute-path check against any bundled `tycoon-team.json`, failing the build on a match.
- Release notes entry and version bump.

**Acceptance Criteria**
- Full test suite passes in CI, including the new team-setup suite, on the existing green baseline.
- Packaging fails a build when a fixture manifest contains a fake absolute path, and passes on the real manifest.
- Docs reviewed against the actual shipped UI for accuracy — no described button or field that doesn't exist.

**Risks**
Doc drift if M1-M3 change after doc-writing starts — write docs last, against merged M1-M3 code, not this PRD's description.

## Sequencing Notes

M1 precedes M2: Apply depends on the portable-hook fix and the finalized schema. M2 precedes M3: readiness is only meaningful once Apply produces a running team, and drift needs M2's applied-stamp. M4 depends on M1-M3 being feature-complete since its tests exercise the full loop.

## Out of Scope

Syncing secrets/credential values (stays in `src/core/localEnvStore.ts`). Syncing themes, generated assets, or per-user app data. Syncing plan state (`.claude/tycoon/plan.json` stays local/ignored; the manifest carries only an optional path pointer). Cloud sync or hosted accounts — this feature is git-commit-based only.
