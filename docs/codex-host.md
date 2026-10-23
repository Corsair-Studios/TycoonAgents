# Codex host (Experimental) — implementation notes

TycoonAgents can read activity from [Codex CLI](https://github.com/openai/codex) via the same provider abstraction, alongside Claude Code and OpenCode. Codex support is Experimental.

- **Selection** — precedence highest to lowest: `TYCOON_PROVIDER=codex` environment variable, then the VS Code setting `tycoonagents.provider: "codex"`, then the `provider` key in `<projectDir>/.claude/tycoon/execution.json`, then the `claude-code` default (see `src/core/providerSelection.ts:13-18`). `--provider codex` in the standalone host maps to the same setting-level slot.
- **Per-agent attribution** — Codex has no per-agent hook payload the way Claude Code's hooks or OpenCode's plugin events do. Attribution is reconstructed from two sources instead: the `notify` command TycoonAgents registers in `CODEX_HOME/config.toml` (see `src/providers/codex/installCodexHooks.ts`), and Codex's own rollout/session metadata, which are cross-referenced to map a spawn back to the agent that made it.
- **Known tradeoff** — because attribution is reconstructed rather than pushed live per turn, a sub-agent mid a multi-turn exchange shows as *stopped* and then *reopened* between turns in the panel, instead of staying continuously "running" the way a Claude Code or OpenCode sub-agent does. This is a limitation of what Codex currently exposes, not a bug in the mapping.
- **Platforms** — the Codex binary is discovered on Windows, macOS, and Linux via PATH, the npm global install location, `~/.codex/bin`, Homebrew (`/opt/homebrew/bin` or `/usr/local/bin`, macOS only), and the bundled binary inside the OpenAI ChatGPT VS Code extension; set `CODEX_BINARY_PATH` (or its alias `CODEX_CLI_PATH`) to override discovery outright. `CODEX_HOME` (default `~/.codex`, using `USERPROFILE` on Windows) overrides where rollout/session files and `config.toml` are read from.

## Codex CLI 0.154 and later (Experimental)

codex-cli 0.154 removed the `mcp-server` stdio command that TycoonAgents' Codex MCP entry
previously launched directly. The Codex MCP entry now runs `node hooks/codex-mcp-launcher.cjs`,
which discovers the Codex binary at runtime — checking, in order, the `CODEX_BINARY_PATH` override
(or its alias `CODEX_CLI_PATH`),
the project's `node_modules`, `PATH`, the npm global install location, Homebrew, `~/.codex/bin`,
`~/.local/bin`, and finally the newest OpenAI VS Code extension bundle. It prefers the newest
Codex CLI it finds: a 0.154+ build is served through `hooks/codex-app-server-mcp.cjs`, a shim over
Codex's `app-server` protocol that exposes the same `codex` and `codex-reply` tools. A legacy build
with a native `mcp-server` subcommand is used only when nothing newer is found. Older builds
predate newer model catalogs, so the newest CLI is the one that accepts current models. The shim is Experimental.

## Reviewer model and MCP approval (Experimental)

The `codex-reviewer` agent defaults to `gpt-6.1-sol` (near-Astra at lower cost);
`gpt-6-astra` is the most capable tier for deeper reviews, `gpt-6-luna` the cheapest, with reasoning efforts
`low`, `medium`, `high`, `xhigh`, `max`, and `ultra` (default `low`). Accepted model slugs and
their supported efforts are account- and time-dependent — ChatGPT-account Codex auth has rejected
several plausible-looking slugs historically (see
`docs/codex-reviewer-onboarding-friction-2026-09-18.md`). Run `codex debug models` (or inspect
`~/.codex/models_cache.json`) to list the slugs your account actually accepts before changing a
`model=` launch arg or an agent's `backend.model`. As noted above, the
`CODEX_BINARY_PATH` (`CODEX_CLI_PATH` in `hooks/codex-mcp-launcher.cjs`) override skips the
discovery ladder entirely and spawns that binary directly. The project-level Codex MCP server is
registered automatically at local scope, with no approval prompt; start a new Claude
chat to load it, and use `claude mcp list` to see it.

## Token usage

Per-turn token usage from the Codex host is not available today, so the Metrics panel shows
"n/a" for Codex agents and excludes them from the token total. The notify entry point
(`hooks/tycoon-codex-hook.cjs`, `agent-turn-complete` payload) carries thread id, turn id, cwd,
input messages, and last assistant message, but no usage fields. The MCP `codex` and
`codex-reply` tool responses carry `structuredContent` with `threadId` and `content` only. Token
counts exist inside Codex (`TokenCountEvent` in `codex-rs` protocol) but are routed only to the
app-server JSON-RPC surface, which emits a per-turn `thread/tokenUsage/updated` notification. A
future task could capture that from the app-server adapter (`hooks/codex-app-server-mcp.cjs`)
and map it to the `HookRecord` `tokens` and `cacheReadTokens` fields; that would be the single
event to read. See `docs/codex-harness-findings.md` and `docs/codex-mcp-probe-findings.md` for
the underlying investigation.
