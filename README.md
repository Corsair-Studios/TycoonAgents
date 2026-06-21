# TycoonAgents

A live, game-style visualization of AI coding-agent activity — reframed as a builder/tycoon simulation. Instead of office workers typing at desks, animated workers move around a build site and **construct** structures as your agents do real work. Watching your agent fleet should feel like watching something get *built*.

> **Status:** v0 — foundation & design.
> This is a **clean-room build** from the specification in [docs/DESIGN.md](docs/DESIGN.md). No code is ported from any prior project; the implementation is written fresh from this design. Shared lineage with earlier work is *conceptual* (the idea/genre of visualizing agent activity), not code.

## Highlights (planned)
- **Tycoon build-progression** — work *simulates construction*, not just status. A session builds up a site.
- **External theme builder** — characters, structures, and worlds are user-authored **data**, loaded at runtime. Art lives outside the engine; the community can make and share themes.
- **Multi-LLM** — a provider abstraction so activity can come from Claude Code, other agent harnesses, or local/API models.

## Project layout
- [`docs/DESIGN.md`](docs/DESIGN.md) — product & architecture design (start here).
- [`docs/CODE-HEADER.md`](docs/CODE-HEADER.md) — required attribution header for every source file.

## Attribution
Authored by **TycoonAgents** — https://x.com/thetrashbyrd
Releases: _repository not yet created — link TBD_.

Every source file carries a short attribution header (see `docs/CODE-HEADER.md`). The header is a courtesy credit, **not** a restriction — end users are free to remove it.

## License
TBD — to be chosen before any public release.
