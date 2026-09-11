# Codex cross-vendor bridge — GO/NO-GO (p22-t6)

## Context

If Codex becomes a supported top layer, its custom agents can only run OpenAI
models natively — there is no Codex-native way to point an agent at Anthropic
(Haiku/Sonnet) or a local Ollama model. Reaching those workers requires a
Tycoon-owned bridge: an MCP server or CLI wrapper that Codex calls as a tool,
which then does the cross-vendor call itself. This mirrors the pattern already
built for OpenCode: OpenCode has no Claude-subscription auth path, so
Anthropic models there are API-key metered only, and both Claude and Codex
subscriptions reach *other* hosts only through their own vendor CLIs
(`claude -p`, `codex mcp-server`) — never a third-party OAuth token (memory:
`opencode-no-claude-subscription`, `subscription-cli-bridges`).

Existing building blocks to reuse:
- `hooks/claude-cli-mcp.cjs` — zero-dep MCP stdio server wrapping
  `claude -p --output-format json --max-turns N --model M --permission-mode
  <mode>` (+ `--allowedTools`, `--append-system-prompt`), prompt over stdin,
  never a shell. Env overrides: `CLAUDE_CLI_BIN`, `CLAUDE_CLI_MODEL`,
  `CLAUDE_CLI_PERMISSION_MODE`, `CLAUDE_CLI_CWD`, `CLAUDE_CLI_TIMEOUT_MS`
  (claude-cli-mcp.cjs:144-150, 402-479). Cataloged as `claude-cli`
  (media/mcp/catalog.json:223-242).
- `hooks/openai-compatible-mcp.cjs` — same protocol skeleton, one `chat` tool
  against any `/v1/chat/completions` endpoint (vLLM, Ollama, LM Studio, or a
  hosted OpenAI-compatible API like Kimi/Qwen), env `OPENAI_COMPAT_BASE_URL` /
  `OPENAI_COMPAT_API_KEY` (cataloged `openai-compatible`,
  media/mcp/catalog.json:266-287). This is the local-Ollama path.
- `gemini` catalog entry (media/mcp/catalog.json:255-265) shows the same
  shim-over-vendor-CLI pattern for a third vendor.
- `scripts/generate-opencode-config.mjs:605,631` — how OpenCode already wires
  an `openai-compatible` vendor slot (`@ai-sdk/openai-compatible`) from
  per-agent model config plus env/file secrets; the same slot shape can drive
  a Tycoon dispatcher's routing table.
- `design-docs/codex-provider-prd.md` (Core Features) already calls for a
  Tycoon MCP dispatcher owning routing/enforcement rather than leaning on
  Codex-native primitives.
- `docs/codex-harness-findings.md:23-45,64-94` — Codex hooks never fired
  across 5 exec runs regardless of config placement or trust flags; only
  `notify` (single fire on turn completion, no per-tool/per-subagent detail)
  was confirmed live. First real Codex call in that spike ran ~20s cold.

## Option A — single Tycoon dispatcher MCP server

One `delegate(specialist, task)` tool, registered once in Codex's
`[mcp_servers.*]` config, internally routing by specialist to: `claude -p`
(Anthropic), the `openai-compatible` HTTP path (Ollama/local, or hosted
OpenAI-compatible vendors), and a Gemini shim, reusing the three existing
hook scripts as internal modules rather than three separate MCP registrations.

- **Reach**: every specialist reachable through one Codex tool call; the
  dispatcher owns the specialist→transport map (mirrors the PRD's stated
  design).
- **Secrets**: env var names only (`CLAUDE_CLI_BIN`, `OPENAI_COMPAT_BASE_URL`,
  `OPENAI_COMPAT_API_KEY`, `GEMINI_API_KEY`), same as the existing hooks — no
  new secret-handling surface.
- **Leaf/no-nesting enforcement**: centralized in one place — the dispatcher
  can refuse a `delegate` call whose task text implies further delegation, or
  simply never exposes a delegation-capable tool to the child call. Single
  enforcement point is easiest to audit and keep correct.
- **activity.jsonl visibility**: the dispatcher can emit one record per
  `delegate` call with `provider: "codex"` and the resolved specialist,
  keeping the visualization whole even though hooks are silent under Codex
  (per the harness findings) — this is the only option that gets structured
  per-task events without relying on Codex hooks at all.
- **Cost**: subscription-rate for Anthropic (via `claude -p`, same seat as
  claude-worker), free/local for Ollama, metered per-token for any hosted
  OpenAI-compatible vendor behind the same tool.
- **Latency**: one dispatcher process reused across calls avoids repeated
  MCP-server cold starts; each `claude -p` call still pays its own CLI
  startup (not separately measured here — reuse claude-cli-mcp's own
  per-call spawn, no persistent session). Codex's own first-call latency is
  ~20s regardless (docs/codex-harness-findings.md:5).
- **Risks**: new code to build and maintain (the dispatcher itself); a single
  process is a single point of failure for every cross-vendor call; routing
  bugs are harder to isolate than with per-vendor servers.

## Option B — one MCP entry per vendor, routing left to AGENTS.md

Register `claude-cli`, `openai-compatible`, and `gemini` each as their own
`[mcp_servers.*]` entry (config blocks already exist verbatim in
media/mcp/catalog.json:223-312), and rely on Codex's AGENTS.md-equivalent
instructions to tell it which tool to call for which specialist.

- **Reach**: same three vendors, no new server code — pure config reuse.
- **Secrets**: identical env vars, no change.
- **Leaf/no-nesting enforcement**: NOT centralized — depends entirely on
  prompt-level instructions Codex may or may not honor, with no code-level
  backstop. Weakest option on this axis.
- **activity.jsonl visibility**: none, unless each hook script is separately
  modified to emit records — and Codex hooks are confirmed silent
  (docs/codex-harness-findings.md:23-45), so there is no lifecycle signal to
  hang a record off of; only `notify`'s single turn-complete event exists,
  which carries no specialist/tool identity.
- **Cost/latency**: same per-vendor costs as Option A; more MCP server cold
  starts if Codex spins each up independently rather than reusing one
  process, otherwise comparable.
- **Risks**: routing correctness rests on the model following instructions
  rather than code; delegation depth is unenforced; visualization gap is
  worse than Option A.

## Option C — Codex native agents only

Do not build a bridge. Codex custom agents run OpenAI models exclusively;
Anthropic and local-Ollama specialists are simply unavailable under a Codex
top layer.

- **Reach**: OpenAI models only.
- **Secrets/enforcement/visibility**: no new surface, but also no
  Anthropic/local coverage — the roster's Anthropic-only specialists
  (coding-specialist, testing-specialist, ux-ui-designer, vscode-integration,
  workspace-monitor, search-retrieval) would need OpenAI-model equivalents or
  go missing under Codex.
- **Cost/latency**: only Codex's own ~20s-cold, subscription-metered calls
  apply.
- **Risks**: breaks parity with the Claude-top-layer roster; likely
  unacceptable if Codex is meant to be a peer top layer rather than a
  narrower one.

## Recommendation

**GO on Option A.** It is the only option that both reuses 100% of existing
vendor-call code (no new Anthropic/Ollama/Gemini transport logic, only a
routing layer) and gives Codex-driven work a real activity.jsonl signal,
which Option B cannot produce given that Codex hooks are confirmed non-
functional in this codebase's own spike. Option B's per-vendor registration
is simpler to write but pushes leaf/no-nesting enforcement and visualization
entirely onto unenforceable prompt instructions, which is a regression from
how Claude-side delegation is enforced today. Option C is a fallback only if
the dispatcher proves infeasible.

What would flip this: if a follow-up spike (per
docs/codex-harness-findings.md:104-105, driving `app-server` JSON-RPC
directly instead of `exec --json`) finds that Codex *does* expose live
per-tool-call or per-subagent events through that channel, Option B's
visibility gap closes and its simplicity becomes more attractive relative to
building and maintaining a dispatcher. Until that's confirmed, Option A is
the only path with real observability.

Decision: GO — Option A (single Tycoon dispatcher MCP server), recorded 2026-09-08.