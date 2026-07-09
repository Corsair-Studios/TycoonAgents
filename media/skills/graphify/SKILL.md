---
name: graphify
description: Turn a codebase (plus docs, PDFs, images) into a queryable knowledge graph — map architecture and answer how-does-this-connect questions, with an interactive browser graph view.
---

# Graphify — Code Knowledge Graph

Graphify builds a searchable knowledge graph from your code and supporting documents, then lets you ask how pieces relate across the system. Code is parsed locally with tree-sitter (deterministic, no LLM, nothing leaves your machine); only docs/PDFs/images use an LLM.

## Install (one time)

Requires Python 3.10+ and `uv` (or `pipx`):

    uv tool install graphifyy
    graphify install

## Build the graph

From the project root, run `graphify extract .` (or `/graphify .` in a supported IDE). This writes a `graphify-out/` folder:
- `graph.html` — interactive force-directed graph; open in any browser to click nodes, filter, and search.
- `GRAPH_REPORT.md` — key concepts and suggested questions.
- `graph.json` — the graph as JSON for programmatic queries.

## View the visualization

Open `graphify-out/graph.html` in a browser — no server needed. This is a standalone view; it is NOT embedded in the TycoonAgents panel.

## Query

    graphify query "what connects auth to the database?"
    graphify path "UserService" "DatabasePool"
    graphify explain "RateLimiter"

Expose the graph to agents as an MCP server:

    python -m graphify.serve graphify-out/graph.json                              # stdio
    python -m graphify.serve graphify-out/graph.json --transport http --port 8080

## Notes
- Code extraction is fully local (tree-sitter AST) — no API key needed.
- Docs/PDFs/images require an LLM backend (`--anthropic`, `--openai`, `--gemini`, `--ollama`, …) and its API key.
- Optional exports to Neo4j/FalkorDB via `--neo4j` / `--falkordb`.
- Upstream: https://github.com/safishamsi/graphify
