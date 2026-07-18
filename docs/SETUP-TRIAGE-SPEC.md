# TycoonAgents — Context-Aware Setup Triage (Design Spec)

**Status:** Design — not built. Decomposed into `.claude/tycoon/plan.json` for gated execution.
**Origin:** User request, 2026-07-17.

## 1. Principle

The install / first-run screen should scan the target folder **deterministically**, recommend one of three branches, and let the user act — but any step requiring intelligence (writing a PRD/GDD, reading code to recommend a roster) is done by a **skill running in the user's Claude Code session**, never by the plugin. The plugin only does deterministic work: scan, list, install/remove agent files, write `plan.json`, install a skill, copy a prompt. This preserves the project's hard rule: **the shipped plugin makes zero runtime AI calls.**

## 2. The classifier (deterministic, in-plugin)

A fast, capped folder scan producing signals:

- `hasClaudeArtifacts` — `CLAUDE.md`, `.claude/` (agents/skills/settings), `.mcp.json`, or other LLM artifacts (`AGENTS.md`, `.cursor/`, `.windsurf/`, Copilot config).
- `hasDesignDoc` — a PRD/GDD-like doc (heuristic on name: PRD/GDD/design/spec/requirements in `*.md`/`*.docx`, or a `docs/plan/` dir).
- `hasSourceCode` — count of recognized source files by extension (excluding config/docs/lockfiles).
- `isUefn` — reuse `detectUefnProject` (`.verse` / `.uproject` / `Content/Verse`).
- `isEmpty` — no source and no docs (ignore `.git`, `LICENSE`, a lone `README`).

**Decision tree (precedence):**
1. `hasClaudeArtifacts` → **Branch A** (review/reconcile existing).
2. else `isEmpty` → **Branch B** (scaffold PRD/GDD).
3. else (`hasSourceCode` or `hasDesignDoc`, no Claude) → **Branch C** (review → suggest agents).

`isUefn` is a **modifier** on any branch (roster suggestions become UEFN-aware and route through the pack conflict gate). Sub-case: `hasDesignDoc && !hasSourceCode && !hasClaude` → offer "generate a plan from your existing PRD/GDD" (the project-plan skill already consumes design docs). The recommendation is a *default*, not a lock — the user can choose any branch.

## 3. Branch specs

**A — Existing setup → Review & reconcile** (mostly exists today)
- Show what was found: agents count, hooks state, delegation-doctrine drift, legacy/foreign blocks (OfficeAgents carryover), keyword-table drift.
- Actions, each opt-in and already-built: install/refresh hooks, reconcile doctrine, remove legacy/foreign blocks, keyword reconcile, agent-file refresh.

**B — Empty → Scaffold PRD/GDD** (uses the existing `design-doc` skill)
- UX: "Start with a plan" → **Create PRD** / **Create GDD**.
- Delivery: installs the `design-doc` skill (media/skills mirror) and drops a tailored prompt into the session; Claude Code generates the doc. Output chains into the project-plan skill (doc → `plan.json`).

**C — Code, no LLM artifacts → Review & suggest agents** (needs a NEW `project-review` skill)
- UX: "Set up agents for this project" → **Review**.
- Delivery: installs a new `project-review` skill + copies a prompt. Claude Code inspects languages/frameworks/layout and emits a **structured recommendation** (agent ids + rationale + suggested keywords). The plugin then installs the *approved* agents deterministically. Suggestion = skill; install = plugin. UEFN-aware (routes through the conflict gate).

## 4. Zero-AI boundary

- **Plugin (deterministic):** detection, listing, installing/removing agent files, writing `plan.json`, copying prompts, installing skills.
- **Skills (Claude Code in user session):** generate PRD/GDD, analyze code → suggest roster.

## 5. Sequencing

1. **Classifier + IPC + triage card** — deterministic, testable, safe (the shell).
2. **Branch A surfacing** — wire existing reconciles into the card (cheap).
3. **Branch B** — design-doc skill wiring.
4. **Branch C** — new project-review skill (the novel value).

## 6. Open decisions (resolve during execution, with the user)

- **"Empty" definition:** does a README/LICENSE-only folder count as empty? A fresh `git init` with a `.gitignore`?
- **Recommend vs present:** auto-highlight the detected branch, or show all three equally?
- **PRD vs GDD:** auto-pick from project signals (game assets → GDD) or always ask?
- **Branch C output:** after the skill suggests a roster, auto-install the approved set, or just write `CLAUDE.md` + let the user install per-agent?
- **⚠ .docx tension:** the design-doc plan mentioned `.docx`, but **no-new-dependencies** is a hard rule — emitting real `.docx` needs a library. Options: ship Markdown-only, or hand-roll a minimal `.docx` (a zip of XML) without a dep. Needs an explicit call.

## 7. Related

- `context-aware-setup-triage` memory (vision), `design-doc-feature-plan` (Branch B), `worker-roster-install-project-aware` (Branch C tailors beyond the lean default), `self-contained-hook-driven-no-runtime-ai` (the zero-AI boundary).
