# Adding a non-Anthropic agent

A short guide for wiring a foreign-LLM-backed agent (OpenAI Codex, Google Gemini, Moonshot Kimi,
or any OpenAI-compatible endpoint) into a project. Written after a real onboarding attempt hit
every one of these gaps first — see `docs/codex-reviewer-onboarding-friction-2026-09-18.md` for
the full postmortem this guide fixes.

## 1. Install the MCP server

Use **Add an agent from another provider** on the Agents screen (it registers the server for you), or copy the relevant entry from
`.mcp.json.example` into your project's `.mcp.json`. The Codex entry launches the bundled
`codex-mcp-launcher.cjs` launcher (copied into `.claude/hooks/` by the hook installer —
`MCP_BRIDGE_HOOK_FILES` in `src/host/vscode/hookInstall.ts`), never `codex mcp-server` directly.
The launcher discovers the Codex binary and prefers the newest Codex CLI, serving a 0.154+ build
through `codex-app-server-mcp.cjs` — a shim over Codex's `app-server` protocol. It uses a legacy
build's native `mcp-server` subcommand (removed in codex-cli 0.154+) only when nothing newer is found:

```json
"codex": {
  "command": "node",
  "args": [
    ".claude/hooks/codex-mcp-launcher.cjs",
    "-c", "model=\"gpt-6.1-sol\"",
    "-c", "model_reasoning_effort=\"low\"",
    "-c", "approval_policy=\"never\"",
    "-c", "sandbox_mode=\"read-only\""
  ]
}
```

Run "Install Hooks" (or the portable/team install path) at least once so `.claude/hooks/` actually
has `codex-mcp-launcher.cjs` and its fallback companion `codex-app-server-mcp.cjs` — a stale
`.mcp.json` pointing at a path that doesn't exist yet is the single most common failure here.

## 2. Copy the agent template — never hand-write the frontmatter

Start from `.claude/agents/codex-reviewer.md` in this repo (or the matching entry in
`media/packs/catalog.json` under `FOREIGN_LLM_AGENTS`, `src/host/vscode/packCatalog.ts`). The
frontmatter shape that works:

```yaml
---
name: codex-reviewer
description: "..."
model: sonnet
disallowedTools: Agent
backend:
  vendor: openai
  transport: mcp
  mcpServer: codex
  tools: [codex, codex-reply]
  model: openai/gpt-6.1-sol
  costModelClass: subscription
---
```

**The top-level `model:` must always be a Claude alias** (`sonnet`, `haiku`, `opus`, ...), never
the vendor's model slug. Claude Code sends the top-level `model:` straight to the Anthropic API to
run the agent itself — a vendor slug there 404s before the agent ever reaches its MCP backend. The
vendor's actual model lives only in the nested `backend.model` field, which the tycoon hooks read
for MCP routing. If you hand-edit a foreign-backend agent file and accidentally put the vendor slug
at the top level, the installer's frontmatter repair
(`resyncAgentFrontmatterFields` in `src/host/vscode/packCatalog.ts`) rewrites it back to a Claude
alias on the next load and preserves the original value under `backend.model` if that field was
missing.

## 3. Routing entries

`routing.json` and `routing.resolved.json` use **different shapes** for the same information.
`routing.resolved.json` is normally the one the fallback chain reads at runtime
(`hooks/tycoon-claude-hook.cjs` ~1852, ~2146), and it is generated FROM `routing.json` by
`scripts/apply-routing-profile.mjs` (run this after hand-editing `routing.json`, or via the panel's
routing UI, which runs it for you). As of p69-t3, if you hand-edit `routing.json` and skip that
regen step, the hook now falls back to reading `routing.json`'s flat entry directly for that agent
(`readFlatRoutingAgentEntry` in `tycoon-claude-hook.cjs`) — a hand edit is no longer silently inert,
but running `apply-routing-profile.mjs` is still the supported path since it also repairs the agent
`.md`'s own `backend:` frontmatter block.

```jsonc
// routing.json — flat entry. `fallback` is an array of the SAME flat shape
// (RoutingSlot, src/core/routingProfile.ts), not a bare model string.
{
  "agents": {
    "codex-reviewer": {
      "vendor": "openai",
      "model": "openai/gpt-6-astra",
      "costModelClass": "subscription",
      "fallback": [
        { "vendor": "anthropic", "model": "anthropic/sonnet", "costModelClass": "metered" }
      ]
    }
  }
}
```

```jsonc
// routing.resolved.json — nested backend object + fallback array of the
// same Backend shape (src/core/agentBackend.ts). Written by
// scripts/apply-routing-profile.mjs; never hand-edit this file.
{
  "agents": {
    "codex-reviewer": {
      "backend": { "vendor": "openai", "model": "openai/gpt-6-astra", "costModelClass": "subscription" },
      "fallback": [{ "vendor": "anthropic", "model": "anthropic/sonnet", "costModelClass": "metered" }]
    }
  }
}
```

The `fallback:` key inside the agent `.md` frontmatter itself is still **ignored** — only the
routing files count.

### reasoningEffort

`backend.reasoningEffort` in an agent's `.md` frontmatter (e.g. `reasoningEffort: low`) is parsed
and kept by `parseAgentBackend` (`hooks/agentBackend.js` / `src/core/agentBackend.ts`) as of p69-t3
— it no longer silently vanishes. Whether it actually changes what the model runs at depends on how
the MCP server was launched:

- **Via `hooks/codex-mcp-launcher.cjs`** (the `codex` catalog entry): set the `CODEX_REASONING_EFFORT`
  env var (e.g. in `.claude/settings.local.json`'s `env` block, or the launcher's own process env)
  and the launcher rewrites/appends `-c model_reasoning_effort="<value>"` in the args it hands to the
  Codex binary before exec (`applyReasoningEffortOverride` in `codex-mcp-launcher.cjs`), overriding
  whatever `-c model_reasoning_effort=` the static `.mcp.json` entry baked in.
- **Any other launch path** (a hand-written `.mcp.json` command, or a different launcher): there is
  no code that reads `backend.reasoningEffort` and rewrites that server's launch args for you — the
  static `-c model_reasoning_effort="..."` flags in your `.mcp.json`/catalog entry are the only path,
  and they apply to every agent sharing that MCP server, not per-agent.

## 4. CODEX_CLI_PATH (Windows)

If the bridge can't spawn the discovered `codex` binary (an npm-global shim resolving to a bare
name instead of the real `.exe`/`.cmd`), set `CODEX_CLI_PATH` in the project's
`.claude/settings.local.json` `env` block to the resolved binary path or `codex.cmd`. Never commit
an absolute machine path to a shipped file — this override belongs in `settings.local.json`, which
is per-machine and untracked.

## 5. Model slugs

Guessed model names are frequently rejected by ChatGPT-account Codex auth. Discover the actual
accepted slugs with:

```
codex debug models
```

or inspect `~/.codex/models_cache.json` directly. See `docs/codex-host.md` for the current default
(`gpt-6.1-sol`) and the higher-tier option (`gpt-6-astra`, efforts `low`/`medium`/`high`/`xhigh`/`max`/`ultra`).

## 6. Keyword routing

Task-routing keywords are tokenized into single words; multi-word phrases like `"codex review"`
never match. Use single tokens (e.g. `codex|astra`) and list them early in `agent-keywords.json` —
ties resolve by object order, and the description weight means the trigger word must appear in the
Task tool's `description` field, not just the prompt text.

### Keywords

See `docs/keyword-routing.md` for the full rules and what the Agents screen's Keyword health card
checks. For a foreign-LLM agent like `codex-reviewer`, the pattern must be single tokens joined by
`|` — `codex|astra`, not a phrase — and that entry must be listed in `agent-keywords.json` **before**
`primary-agent`, so a tie on a shared token resolves to the specialist instead of falling through to
the Wildcard Agent.
