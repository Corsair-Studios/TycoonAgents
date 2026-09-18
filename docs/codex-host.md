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
`~/.local/bin`, and finally the newest OpenAI VS Code extension bundle. It prefers a discovered
binary that still exposes `mcp-server`, and otherwise falls back to
`hooks/codex-app-server-mcp.cjs`, a shim over Codex's `app-server` protocol that exposes the same
`codex` and `codex-reply` tools. The project pins `@openai/codex` `0.153.0` as a devDependency for
this reason. The fallback shim is Experimental.

## Reviewer model and MCP approval (Experimental)

The `codex-reviewer` agent defaults to `gpt-5.6-sol`, the cheapest model a ChatGPT-account login
accepts; `gpt-6-astra` is available as a higher tier for deeper reviews. As noted above, the
`CODEX_BINARY_PATH` (`CODEX_CLI_PATH` in `hooks/codex-mcp-launcher.cjs`) override skips the
discovery ladder entirely and spawns that binary directly. On first use, Claude Code asks once
per project to approve the project-level Codex MCP server before it will run; use
`claude mcp list` to see its current approval state or approve it manually.

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
