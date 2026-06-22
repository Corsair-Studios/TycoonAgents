# TycoonAgents — Design

> **v0 working draft.** This is an original specification; the implementation is built **from this document**.

---

## 1. Vision
TycoonAgents turns the activity of AI coding agents into a **builder/tycoon simulation**. Each agent is a worker; each unit of work is a construction action; a session produces a built-up site. The goal is a panel you *want* to watch — visible progress that accumulates as your agents work.

## 2. Core metaphor: agents -> workers -> buildings
- **Agent = Worker.** Spawning a sub-agent spawns a worker who walks onto the site. An agent's role/type maps to a worker class (outfit + tools).
- **Tool activity = construction action.** Reads/edits/searches/shell/MCP calls map to worker actions (surveying, hammering, hauling, wiring).
- **Task completion = a finished structure/module.** Over a session, the site fills in.
- **Idle/blocked = a worker waiting** (leaning on a tool, standing by a blueprint).

## 3. Worker states (animation states)
Driven by a **normalized activity event stream** (see section 6), not by any one provider's specifics:

| State | Trigger (normalized event) | Visual |
|---|---|---|
| `arrive` | worker/agent spawned | walks in from the edge |
| `walk` | moving to a work site | walking |
| `build` | tool activity in progress | hammering / assembling |
| `haul` | file write / large operation | carrying materials |
| `survey` | read / search | inspecting a blueprint |
| `wait` | blocked / awaiting input | idle near the site |
| `celebrate` | task completed | brief flourish |
| `leave` | agent/worker stopped | walks off / tips hat |

The precise event->state mapping is owned by the provider + a small mapping config, so it can be tuned without touching the renderer.

## 3.1 Character animation set
Workers *build, move, sit, and gather* — so TycoonAgents needs a richer animation set than a desk-bound visualizer. Each theme supplies these per character; the theme manifest (section 5) enumerates them and allows per-character variants.

Initial required clips:
- **walk** — locomotion to/from sites.
- **idle (arms down)** — facing camera, neutral.
- **idle (arms up)** — alternate idle / reaching.
- **build (set)** — several construction actions (hammer, assemble, haul, wire), mapped from activity kinds.
- **sit** — idle, seated.
- **gather** — grouping around objects when idle (the campfire / water-cooler equivalent).
- **arrive / leave** — entrance and exit.
- **celebrate / dance** — task-completion flourish. **The dance varies per character** and is expected to be AI-image-generated, so the manifest must allow each character its own unique dance clip(s).

This is the initial contract the theme manifest schema must cover; expect it to grow.

## 4. The world / build site
- A plot that **fills in as work happens**. The default flagship theme is a **construction site that grows into a small settlement** (the most legible mapping for "agents building software").
- Tycoon elements to layer in: a build queue, progress/milestone meters, optional resources, and (later) cross-session persistence.
- Alternate worlds (factory floor, space colony, workshop) ship as **themes**, not code — see section 5.

## 5. External theme builder
The key architectural split: **art is data, not code.**
- A **theme** is a bundle: character sprites/animations, structure art, a world tileset, and a **manifest** that maps worker-states (section 3) and build-stages to assets.
- Themes load at runtime from a themes directory. Users author and share them without touching the engine.
- A separate, standalone **theme builder** tool (outside the plugin) creates/edits theme bundles.
- This makes the visualization layer demonstrably its own system, and opens it to community content.
- Deliverable: a **versioned theme manifest schema** — the stable contract between themes and the renderer. (Schema TBD; see section 9.)

## 6. Multi-LLM provider abstraction
The visualization is **source-agnostic**.
- Define a **Provider** interface that emits normalized events: `WorkerSpawned`, `WorkerActivity{kind}`, `TaskCompleted`, `WorkerStopped`, `Error`, `SessionStart/Stop`.
- Planned providers:
  - **Claude Code** — hook-based (hooks emit normalized events).
  - **Other agent harnesses / CLIs.**
  - **Local models** (e.g. Ollama) or a direct **API** loop.
- The core state model and renderer consume only normalized events — never provider internals. Adding a provider never touches the renderer.

## 7. Architecture (layers)
1. **Providers** — adapters that turn a tool's activity into normalized events.
2. **Event bus** — the normalized stream.
3. **State model** — workers, world/build progress, resources. Pure and testable; **host-agnostic**.
4. **Renderer** — the animated panel (canvas). Consumes state + the active theme.
5. **Theme layer** — external theme data + manifest.
6. **Host** — VS Code extension first; the core stays host-agnostic so web/desktop hosts are possible later.

Design rule: **dependencies point inward toward the state model.** The state model knows nothing about VS Code, Claude, or any provider.

---

## 8. Decisions (v0 defaults — set while you were away; revisit freely)
I made reasonable calls so the foundation isn't blocked. Override any of these:
- **Project/repo name:** `TycoonAgents` (matches the directory + attribution). Candidate display name: **"Agent Tycoon"** — pending a trademark sanity-check ("Tycoon" is heavy in gaming).
- **Default world theme:** construction-site-that-grows-into-a-settlement.
- **Progression:** **session-ephemeral** for v1; the state model is designed so a persistent save file can be added later without rework.
- **First host:** VS Code extension; core kept host-agnostic.
- **Renderer:** canvas-based 2D sprite animation (proven, lightweight, theme-friendly).
- **License:** MIT — open source and free (decided 2026-06-21).
- **Repo structure:** monorepo; the UEFN **Power Tools** live at `packages/uefn-power-tools/` as the single source of truth, with the standalone distribution published from it (decided 2026-06-21). See `DISTRIBUTION.md`.
- **Power Tools license:** MIT, included in the suite (decided 2026-06-21).

## 9. Open — needs your call
- **Name finalization + trademark check.**
- **Release/distribution model:** VS Code Marketplace, standalone, or both.
- **Whether to design web-playable from day one** (affects host abstraction effort).

## 10. Planning & onboarding flow

Before any building starts, TycoonAgents runs a planning pipeline that turns intent into an approved, phased plan. The planner is itself visualized agent work — an Opus "foreman" coordinator runs intake and planning before the project's specialists exist.

### 10.1 Site Survey — context acquisition
- **Existing codebase:** review it (search-retrieval on Haiku + an architect pass) to produce a **context model** of structure, stack, and conventions.
- **Empty directory:** enter a guided dialogue — what is being built, goals, constraints, target users — and ask for any existing documentation. If there is none, **offer to co-author it**.
- **Output:** one approved **Project Brief** (`docs/PROJECT-BRIEF.md`), the canonical statement of intent. All later review is checked against it.
- **Brief contents** (template: `docs/templates/PROJECT-BRIEF.template.md`): one-liner; problem & motivation; goals and **non-goals**; target users; scope (must-have vs later); constraints (stack, integrations, performance, timeline/budget); **success criteria** (observable — these seed phase acceptance criteria); existing assets; glossary; open questions & risks.

### 10.2 Crew Assembly — roster derivation (adaptive)
- Every project installs the same **three core agents**: the **orchestrator** (coordinator), the **fallback agent**, and **search-retrieval** (always Haiku).
- From the brief, TycoonAgents then **derives the project's specialists** — which to add (e.g. coding, testing, VS Code integration, UX/UI, workspace-monitor) and the model each runs on, using the cost-aware Haiku/Sonnet/Opus split.
- The user approves the proposed roster; TycoonAgents then scaffolds `.claude/agents/` to match.
- **Output:** an approved, project-specific roster — the three core agents plus the derived specialists.

### 10.3 The Master Plan — phase rollout
- Decompose the brief into **phases**, each a coherent, *demoable* increment with its own tasks (assigned to specialists).
- Each phase declares **acceptance criteria up front**, derived from the brief — this is what makes drift detectable.
- Each phase also carries a **gate policy** (see Build & Inspect), chosen here and approved by the user.
- **Output:** an approved **Roadmap** (`docs/ROADMAP.md`).
- **Phase shape** (template: `docs/templates/ROADMAP.template.md`): each phase has a one-line goal; tasks tagged with the owning specialist; **acceptance criteria** pinned before work starts (traceable to Brief success criteria); a **review method** (the exact demo the user runs to verify real behavior); a **gate** (`stop`/`auto`) with a risk level; dependencies; and a milestone badge. Status moves planned → in-progress → in-review → accepted.

### 10.4 Build & Inspect — execution with review gates
- Specialists build a phase. At the phase boundary, the phase's **gate** decides whether to stop:
  - **Configurable per phase.** Each phase's gate is set in the Master Plan — ambiguous or high-risk phases **hard-stop** for explicit sign-off; low-risk phases may **auto-proceed**. The default is stop.
- At a stop, TycoonAgents presents the **real, running result** (a live demo) next to the phase's pre-stated acceptance criteria. The user verifies **demonstrated behavior vs. stated intent**:
  - **Match** → mark the phase accepted and proceed.
  - **Drift, misunderstanding, or tangent** → capture the correction and **re-plan** the phase (and any affected downstream phases) before continuing.
- Drift protection is concrete: because intent was pinned to each phase *before* coding, the gate is a comparison against criteria, not a judgment call.

### 10.5 Game mapping
A phase is a **structure** on the site; its tasks are agents constructing it; completion makes the structure *stand*; the gate is the user **inspecting the building** before the crew moves on; acceptance awards a **milestone badge**. Planning and review are first-class parts of the simulation, not a side panel.

### 10.6 Artifacts
- `docs/PROJECT-BRIEF.md` and `docs/ROADMAP.md` are **user-owned project content** — committed, human-readable, and kept free of TycoonAgents-internal references per the attribution & licensing policy.
- Phase and gate **state** for the visualization lives in the managed `.claude/` area, not in the user's committed docs.

## 11. Skills

TycoonAgents ships a first-class, clean-room **skills system** — reusable capability packs (each a `SKILL.md` plus assets) that agents can invoke. Unlike a one-time install dump, the catalog stays visible and manageable so it never gets lost.

### 11.1 Integrated panel browser
- Skills are browsed, installed, and removed **inside the TycoonAgents panel** — installed and available skills are always visible, with one-click install/remove **per project**.
- Each skill shows: name, description, category, source (bundled/remote), and which agent(s) it routes to.

### 11.2 Registry
- A TycoonAgents **skills registry** (its own schema) lists every known skill with: `id`, `name`, `description`, `category`, `source` (bundled vs remote URL), and `agentKeywords` (so a skill ties into the same keyword routing as agents).
- **Bundled** skills ship with TycoonAgents; **remote** skills are fetched from a declared URL on demand. Both appear in the browser; only installed ones land in the project.

### 11.3 Install model
- Installing copies a skill into the managed `.claude/skills/<id>/` and is **idempotent** — re-install/upgrade never silently clobbers user edits (merge or prompt, per the install-robustness rules in the Distribution section).
- A **doctor/verify** command lists exactly which skills are installed and from where — the visible-state principle, so the catalog never "gets lost" after install.
- Removal is clean: no orphaned hooks or keyword entries left behind.

### 11.4 Clean-room & provenance
- TycoonAgents authors its **own** registry, installer, and curation. Skills that merely wrap public tools (e.g. git, a browser-automation CLI, deploy CLIs, third-party LLM CLIs) are fine to offer; no predecessor registry code, curation, or wording is carried over.
- Each skill records its **source/provenance** so third-party skills are attributed and TycoonAgents-original skills are marked as such.

### 11.5 Default set (lean)
- Ship a small, broadly useful **default bundle** (e.g. a session-orientation skill, a git workflow skill, a browser-automation skill, a skill-authoring skill) plus the **UEFN / Power Tools** skills that pair with that component. Everything else is browsable, not force-installed — avoiding the "dozens of skills dumped, then lost" problem.

### 11.6 Game mapping
- A skill is **equipment** the crew can be issued; installing one equips the relevant specialist, shown in the panel. Browsing the catalog is visiting the **tool shed**.

## 12. Suggested build order (when implementation starts)
1. Define the **normalized event types** + the **Provider** interface (section 6).
2. Build the **state model** (section 7.3) with unit tests — no rendering, no host.
3. Stand up the **Claude Code provider** (hook -> normalized events).
4. Minimal **canvas renderer** + a single built-in default theme.
5. Define the **theme manifest schema**; move the default theme to load *through* it.
6. Extract the **standalone theme builder**.
7. Add a second provider (local/API) to prove the abstraction.

## 13. Attribution & licensing
- Attribution policy: see [`ATTRIBUTION.md`](ATTRIBUTION.md) — significant files only, a footprint line in managed `CLAUDE.md` / agent files, and the panel-UI credit; never stamps user-generated code.
- License: **MIT** — see `LICENSE`.

## 14. Distribution, packaging & repo hygiene
- **See [`DISTRIBUTION.md`](DISTRIBUTION.md)** for the full install-robustness + dual-ship requirements (single source of truth, ship-plugin-not-framework, doctor/repair, merge-over-existing, cross-platform).
- **License:** MIT — free, open source; the repo is public for anyone to use (`LICENSE`).
- **Ship the plugin, not the framework.** The published VS Code extension (VSIX) must contain ONLY the runtime plugin. Exclude the build/dev framework, generators, tests, design docs, and any meta-tooling used to *build* the plugin. This is enforced by **`.vscodeignore`** (vsce uses `.vscodeignore`, not `.gitignore`); maintain it exclude-by-default and verify each release's contents.
- **Multi-agent support.** The shippable VS Code version targets **Claude Code agents** first; the provider abstraction (section 6) is what lets it support other vendors' agents later without touching the renderer.
- **End-user team hygiene (important).** Many users share a repo with teammates who do NOT use Claude Code (or any agent). Their per-developer agent artifacts — `.claude/`, `CLAUDE.md`, local settings/agent files — must not get force-committed and pollute a shared repo. TycoonAgents should make this easy: on setup, add the recommended ignore entries to the user's project `.gitignore` (and/or document the set).
- **Unreal Engine / Fortnite (UEFN) users:** UEFN projects use **Unreal Revision Control (URC)**, whose ignore file is **`.urcignore`** at the project root (uses `.NET` file-globbing syntax). For UEFN users, add the per-developer agent artifacts there — e.g. `CLAUDE.md` and `.claude/**` — so they're excluded from URC check-ins. This is the UEFN equivalent of the `.gitignore` rule in the previous bullet. (Confirmed pattern: an existing UEFN project's `.urcignore` already excludes `CLAUDE.md` and `.claude/**`.)
