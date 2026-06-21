# TycoonAgents

A live, game-style visualization of AI coding-agent activity — reframed as a builder/tycoon simulation. Instead of desk-bound workers typing at terminals, animated workers move around a build site and **construct** structures as your agents do real work. Watching your agent fleet should feel like watching something get *built*.

> **Status:** v0 — foundation & design.
> This is an original build from the specification in [docs/DESIGN.md](docs/DESIGN.md); the implementation is written fresh from this design.

## Highlights (planned)
- **Tycoon build-progression** — work *simulates construction*, not just status. A session builds up a site.
- **External theme builder** — characters, structures, and worlds are user-authored **data**, loaded at runtime. Art lives outside the engine; the community can make and share themes.
- **Multi-LLM** — a provider abstraction so activity can come from Claude Code, other agent harnesses, or local/API models.

## Project layout
- [`docs/DESIGN.md`](docs/DESIGN.md) — product & architecture design (start here).
- [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) — layered attribution policy (significant files only, harness footprint, panel UI credit).

## Attribution
Authored by **TycoonAgents** — https://x.com/thetrashbyrd
Releases: _repository not yet created — link TBD_.

Attribution is intentionally light (see [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md)): a short, removable header on *significant* files only, a one-line footprint in the managed block of `CLAUDE.md` / agent files, and a clickable credit in the panel UI — TycoonAgents never stamps the user's own generated code.

## License
**MIT** — free and open source. See [LICENSE](LICENSE). Anyone is welcome to use it.
