# TycoonAgents — Design

> **v0 working draft.** Authored fresh as a clean-room specification. The implementation is built **from this document**, not ported from any prior codebase. Lineage with earlier work (e.g. OfficeAgents) is conceptual — the *idea* of visualizing agent activity — not code or assets.

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
  - **Claude Code** — hook-based (the approach proven by the v1 bridge).
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

## 8. Relationship to OfficeAgents (v1)
- OfficeAgents is treated as **v1** — the working bridge that already demonstrates the core idea and can be shown to employers today.
- TycoonAgents is a **fresh, independent build** from this spec: new core loop (build-progression), new interface, external theme builder, multi-LLM. The only thing carried over is the *idea*, which is not ownable; the code and assets are written fresh.

---

## 9. Decisions (v0 defaults — set while you were away; revisit freely)
I made reasonable calls so the foundation isn't blocked. Override any of these:
- **Project/repo name:** `TycoonAgents` (matches the directory + attribution). Candidate display name: **"Agent Tycoon"** — pending a trademark sanity-check ("Tycoon" is heavy in gaming).
- **Default world theme:** construction-site-that-grows-into-a-settlement.
- **Progression:** **session-ephemeral** for v1; the state model is designed so a persistent save file can be added later without rework.
- **First host:** VS Code extension; core kept host-agnostic.
- **Renderer:** canvas-based 2D sprite animation (proven, lightweight, theme-friendly).
- **License:** MIT — open source and free (decided 2026-06-21).

## 10. Open — needs your call
- **Name finalization + trademark check.**
- **Release/distribution model:** VS Code Marketplace, standalone, or both.
- **Whether to design web-playable from day one** (affects host abstraction effort).

## 11. Suggested build order (when implementation starts)
1. Define the **normalized event types** + the **Provider** interface (section 6).
2. Build the **state model** (section 7.3) with unit tests — no rendering, no host.
3. Stand up the **Claude Code provider** (hook -> normalized events).
4. Minimal **canvas renderer** + a single built-in default theme.
5. Define the **theme manifest schema**; move the default theme to load *through* it.
6. Extract the **standalone theme builder**.
7. Add a second provider (local/API) to prove the abstraction.

## 12. Attribution & licensing
- Every source file carries the header in [`CODE-HEADER.md`](CODE-HEADER.md).
- License: **MIT** — see `LICENSE`.

## 13. Distribution, packaging & repo hygiene
- **License:** MIT — free, open source; the repo is public for anyone to use (`LICENSE`).
- **Ship the plugin, not the framework.** The published VS Code extension (VSIX) must contain ONLY the runtime plugin. Exclude the build/dev framework, generators, tests, design docs, and any meta-tooling used to *build* the plugin. This is enforced by **`.vscodeignore`** (vsce uses `.vscodeignore`, not `.gitignore`); maintain it exclude-by-default and verify each release's contents.
- **Multi-agent support.** The shippable VS Code version targets **Claude Code agents** first; the provider abstraction (section 6) is what lets it support other vendors' agents later without touching the renderer.
- **End-user team hygiene (important).** Many users share a repo with teammates who do NOT use Claude Code (or any agent). Their per-developer agent artifacts — `.claude/`, `CLAUDE.md`, local settings/agent files — must not get force-committed and pollute a shared repo. TycoonAgents should make this easy: on setup, add the recommended ignore entries to the user's project `.gitignore` (and/or document the set).
- **Unreal Engine / Fortnite (UEFN) users:** UEFN projects use **Unreal Revision Control (URC)**, whose ignore file is **`.urcignore`** at the project root (uses `.NET` file-globbing syntax). For UEFN users, add the per-developer agent artifacts there — e.g. `CLAUDE.md` and `.claude/**` — so they're excluded from URC check-ins. This is the UEFN equivalent of the `.gitignore` rule in the previous bullet. (Confirmed pattern: an existing UEFN project's `.urcignore` already excludes `CLAUDE.md` and `.claude/**`.)
