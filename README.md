# TycoonAgents

**TycoonAgents is an AI build harness first, and a visualization second.** It's built to make the most of your tokens: instead of running everything on one expensive model, it routes work to a fleet of sub-agents — each on the model that fits the job — so your project gets built in the most cost-effective way possible. A heavyweight model coordinates and makes the calls; cheaper, faster models pick up the work they're suited for.

Sitting on top of that harness is a live, game-style visualization of your agent fleet.

> **Status:** v0 — foundation & design. See [docs/DESIGN.md](docs/DESIGN.md) for the full product & architecture design.

## What the visualization shows
At a glance, per agent:
- **Who's active** — which workers are working right now
- **Work completed** — how much each agent has gotten done
- **Token cost** — what each agent is costing you
- **Tasks completed** — how many tasks each agent has finished
- **Response rate** — how reliably each agent responds
- **MCP usage** — how many times each agent has called an MCP

## The tycoon layer
- **Build & defend** — agents work on objects across your site and defend the base from incoming attacks.
- **Achievements & badges** — earn badges for milestones as you complete your codebase.
- **Theme builder** — create and share your own themes; characters, structures, and worlds are user-authored data loaded at runtime.

## Multi-LLM
A provider abstraction so agent activity can come from Claude Code, other agent harnesses, or local/API models.

## UEFN Power Tools
TycoonAgents includes a **UEFN component** for Unreal Editor for Fortnite: a **Node.js MCP server** paired with a **Python bridge** that let your agents inspect and edit a *live* UEFN level. The Python bridge runs inside UEFN and communicates over file-based IPC; the MCP server exposes its capabilities to Claude Code agents as tools — `uefn_status`, `uefn_list_devices`, `uefn_get_property`, `uefn_set_property`, `uefn_select_actor`, `uefn_run_audit`, and `uefn_get_level_info`.

## Project layout
- [`docs/DESIGN.md`](docs/DESIGN.md) — product & architecture design (start here).
- [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) — layered attribution policy (significant files only, harness footprint, panel UI credit).

## Attribution
Authored by **TycoonAgents** — https://x.com/thetrashbyrd
Releases: _link TBD_.

Attribution is intentionally light (see [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md)): a short, removable header on *significant* files only, a one-line footprint in the managed block of `CLAUDE.md` / agent files, and a clickable credit in the panel UI — TycoonAgents never stamps the user's own generated code.

## License
**MIT** — free and open source. See [LICENSE](LICENSE). Anyone is welcome to use it.
