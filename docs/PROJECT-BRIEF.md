# Project Brief — TycoonAgents

> The canonical statement of intent for this project. TycoonAgents checks every phase's delivered work against this document. Keep it current — when intent changes, change it here first.

## 1. One-liner
An AI build-harness first and a game-style visualization second: TycoonAgents routes coding work across a fleet of sub-agents on cost-appropriate models, and renders their activity as a builder/tycoon simulation.

## 2. Problem & motivation
Running every task on one expensive model wastes tokens, and agent activity is opaque — it's hard to see who is working, what they cost, or whether they have drifted from intent. TycoonAgents makes multi-agent builds both **cost-efficient** (a coordinator delegates to cheaper specialist models) and **legible** (a panel worth watching, with per-agent cost and throughput), and adds a planning flow that catches drift before it compounds.

## 3. Goals
- Cost-efficient delegation: an Opus coordinator delegates to Sonnet specialists and a Haiku search agent.
- A live visualization of per-agent activity: who's active, work completed, token cost, tasks completed, response rate, MCP usage.
- A planning pipeline (Site Survey → Crew Assembly → Master Plan → Build & Inspect) with per-phase acceptance gates that prevent drift.
- Source-agnostic via a provider abstraction (Claude Code first; other harnesses / local / API later).
- Art-as-data: an external theme builder and community themes.
- A skills system with an integrated panel browser.
- UEFN Power Tools (Node MCP server + Python bridge) for live UEFN editing.

## 4. Non-goals
- Not a replacement for the user's agent CLI/IDE — TycoonAgents visualizes and orchestrates, it doesn't replace Claude Code.
- No cross-session persistence in v1 (session-ephemeral; the state model is designed so persistence can be added later).
- Not a round-trippable visual code editor (the Verse blueprint viewer is a backlog, derived-view idea only).
- Never stamps or attributes the user's own generated code.

## 5. Target users
- Developers using Claude Code (and later other agent harnesses) who want cost-efficient multi-agent builds with visibility.
- UEFN / Fortnite creators working in Verse, via the Power Tools.
- Teams sharing a repo where not everyone uses agents (per-developer agent artifacts must stay out of the shared repo).

## 6. Scope
**Must-have (v1):**
- Normalized event model + Provider interface; a Claude Code provider.
- A host-agnostic, unit-tested state model.
- A canvas renderer with one default theme.
- The cost-efficient roster: 3 core agents (orchestrator, fallback, search-retrieval = Haiku) + derived Sonnet specialists.
- Panel hamburger hub with run control + debug/diagnostics.
- Per-agent metrics display.

**Nice-to-have (later):**
- Theme manifest schema + standalone theme builder.
- Skills panel browser + registry.
- Planning flow surfaced in the panel (Brief / Roadmap / gates).
- A second provider (local/API) to prove the abstraction.
- Graphify integration (search acceleration + Site Survey context).
- Achievements / badges.
- UEFN Power Tools packaging and dual-ship.

## 7. Constraints
- **Stack / platform:** TypeScript; VS Code extension first with a host-agnostic core; canvas 2D renderer; Node `.cjs` hooks. Power Tools: Node MCP server + Python bridge.
- **Integrations:** Claude Code hooks; MCP; Graphify (MIT); UEFN / Unreal Revision Control.
- **Performance / scale:** lightweight, smooth canvas animation with many concurrent agents.
- **Timeline / budget:** token-cost efficiency is a first-class product goal (Haiku/Sonnet/Opus split); default parallel limit of 2 Sonnet workers.
- **Other:** MIT license; **clean-room** — tracked files carry no reference to predecessor tooling or IP; ship-the-plugin-not-the-framework; cross-platform; shared-repo hygiene.

## 8. Success criteria
- From the panel, a user can see at a glance which agents are active, what each has done, and what each costs.
- Delegated work runs on the cost-appropriate model (search = Haiku, specialists = Sonnet, coordination = Opus) — measurably cheaper than single-model.
- A new project can flow Site Survey → approved Brief → Roadmap → phased build with working review gates.
- Adding a new provider never touches the renderer.
- A theme can be swapped with no code change.
- The tracked repo contains zero predecessor/IP references.

## 9. Existing assets & references
- `docs/DESIGN.md` (full design), `docs/DISTRIBUTION.md`, `docs/ATTRIBUTION.md`, `docs/BACKLOG.md`, `docs/templates/`.
- Repo: `Corsair-Studios/TycoonAgents` (private).
- Current code: `src/core/`, `src/providers/claude-code/`, `src/host/vscode/`, `media/`, `test/`.
- Graphify: https://github.com/safishamsi/graphify

## 10. Domain glossary
- **Worker:** a spawned sub-agent, shown building on the site.
- **Core agents:** orchestrator, fallback, search-retrieval — the three that always install.
- **Specialist:** a project-derived agent (e.g. coding, testing).
- **Provider:** an adapter that turns a tool's activity into normalized events.
- **Theme:** an art-as-data bundle (sprites, structures, manifest).
- **Gate:** a per-phase review checkpoint (`stop`/`auto`).
- **Site Survey / Crew Assembly / Master Plan / Build & Inspect:** the four planning stages.
- **Power Tools:** the UEFN MCP + Python component.

## 11. Open questions & risks
- Name finalization + trademark check ("Tycoon" is heavy in gaming; display-name candidate "Agent Tycoon").
- Release model: VS Code Marketplace, standalone, or both.
- Whether to design web-playable from day one (affects host-abstraction effort).
- Graphify dependency adoption.
- Verse parsing feasibility for the backlog blueprint viewer.

---
*Status:* draft · *Approved by:* <pending> · *Last updated:* 2026-06-22
