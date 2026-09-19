# Codex reviewer onboarding friction (2026-09-17/18)

Postmortem for TycoonAgents maintainers: what it took to add a Codex-backed reviewer agent to a consumer project (`D:\ACode\MPGames`), the defects hit along the way, and recommended fixes.

## Setup

The user asked for a new agent `codex-reviewer` on their Codex subscription, model "Codex Astra", low effort, review-only, triggered only on an explicit "Codex review". Environment: Windows 11, Codex CLI 0.155.0 (installed mid-way, logged in via ChatGPT), TycoonAgents hook at `.claude/tycoon/tycoon-claude-hook.cjs` in the consumer project.

## Friction points (in order encountered)

### 1. No template or docs for a non-Anthropic backend

The consumer project had nothing to start from. The `routing.json` agents map was empty; the only hint was a comment in `.claude/tycoon/fallbackChain.js:40` referencing a `codex-reviewer.md` that did not exist in the project. The canonical example lives only in the TycoonAgents repo (`.claude/agents/codex-reviewer.md`, `.mcp.json.example`).

### 2. Keyword routing trap

`.claude/hooks/task-start.js` and `tycoon-claude-hook.cjs` tokenize task text into single words and match each pattern segment with `searchWords.has(kw)`. Multi-word patterns like `"codex review"` can never match, and `"review"` alone routed the request to the plain reviewer. The fix required single tokens (`codex|astra`) AND placing the entry first in `agent-keywords.json`, because ties resolve by object order (strict `score > bestScore`, no weights). `DESCRIPTION_WEIGHT=1000` also means the trigger word must be in the Task description, not the prompt. None of this is documented for agent authors, and the legacy agents' `agent-keywords.json` entries are malformed (the generator slurped whole prose blocks as patterns).

### 3. Fallback chain only reads routing.resolved.json

The fallback chain is read only from `routing.resolved.json` (hook lines ~1852, 2146), never `routing.json`. The script that regenerates the resolved file (`scripts/apply-routing-profile.mjs`, referenced in a hook comment) is not present in the consumer project, so a hand edit to `routing.json` was silently inert until `routing.resolved.json` was hand-populated in a different nested shape (`agents[id].backend` object + `fallback` array) than `routing.json`'s flat entry. The frontmatter `fallback:` key in the agent `.md` is ignored by `agentBackend.js`; only the routing files count. Backend `reasoningEffort` frontmatter is dropped by `parseAgentBackend`'s whitelist (`agentBackend.js` ~148-162), so effort can only be set via the MCP launch `-c` flags.

### 4. Catalog and example launch a removed command

The MCP catalog entry "Codex (OpenAI)" and `.mcp.json.example` both launch `codex mcp-server`, which Codex CLI 0.154+ removed (0.155 falls through to the interactive TUI and dies with "stdin is not a terminal"). The repo already contains the replacement bridge `hooks/codex-app-server-mcp.cjs` (MCP to `codex app-server` translator), but the catalog, example, and docs still point at `mcp-server`. The catalog's Install button would have overwritten the working config.

### 5. Model naming

`codex-astra` (the natural guess from the user's phrase "Codex Astra") is rejected: `The 'codex-astra' model is not supported when using Codex with a ChatGPT account.` The real slug is `gpt-6-astra`, discoverable only via `codex debug models` or `~/.codex/models_cache.json`. The hook's legacy default literal is already `"gpt-6-astra"` (`tycoon-claude-hook.cjs` ~471) but the catalog pins `gpt-5.6-sol`. Efforts supported for `gpt-6-astra`: low/medium/high/xhigh/max/ultra, default low.

### 6. Windows spawn bug in the bridge

`codex-mcp-launcher.cjs` discovery returns the bare name `codex` for the npm-global shim, but `codex-app-server-mcp.cjs:205` only sets `shell:true` for `.cmd`/`.bat` paths, so spawn fails with ENOENT and the pending `tools/call` hangs until the 600 s timeout instead of surfacing an error. Workaround used: `CODEX_CLI_PATH` pointing at the real exe (`npm root -g`/`@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`), placed in the consumer's `.claude/settings.local.json` env. Setting `CODEX_CLI_PATH=codex.cmd` also worked, and the session rollout proved the quoted `-c` args survived, contradicting the launcher's own header comment (lines 54-65) that `.cmd` shims mangle quoted args.

### 7. Cost and coordination

The whole thing took two specialist rounds, two review rounds with required changes, four exploration agents, and multiple live probes. Verification that finally proved it: MCP `initialize`/`tools/list`/`tools/call` returning "OK", with the `~/.codex/sessions` rollout recording model `gpt-6-astra`, `reasoning_effort` low, sandbox read-only, approval never.

## Recommended fixes

- [ ] Update the catalog, `.mcp.json.example`, and docs to launch `hooks/codex-app-server-mcp.cjs` and default to `gpt-6-astra`.
- [ ] Fix the bridge to reuse the launcher's `needsShell()` and reject the pending call on child `"error"`.
- [ ] Make discovery resolve the npm shim to the real exe on Windows.
- [ ] Ship `apply-routing-profile` (or have the hook fall back to `routing.json` when `routing.resolved.json` has no entry).
- [ ] Honor `reasoningEffort` in `parseAgentBackend`, or document that `-c` flags are the only path.
- [ ] Document keyword tokenization rules and tie-break order for agent authors, and regenerate `agent-keywords.json` for legacy agents.
- [ ] Add an "add a non-Anthropic agent" guide with a copyable `codex-reviewer` template.
- [ ] Surface model-slug errors from Codex in the hook's provider-failure classification, with a hint to run `codex debug models`.

## Final working configuration (consumer side)

- `.mcp.json`: `node .claude/hooks/codex-app-server-mcp.cjs` with `-c model="gpt-6-astra" -c model_reasoning_effort="low" -c approval_policy="never" -c sandbox_mode="read-only"`.
- Agent frontmatter `backend`: vendor `openai`, transport `mcp`, mcpServer `codex`, model `openai/gpt-6-astra`, costModelClass `subscription`, tools `[codex, codex-reply]`.
- Fallback to `anthropic/sonnet` in both `routing.json` and `routing.resolved.json`.
- `CODEX_CLI_PATH` in `.claude/settings.local.json`.


One problem remains in the agent definition itself. In codex-reviewer.md, the top-level frontmatter sets the agent's own model to openai/gpt-6-astra. Claude Code reads that field as the model to run the agent on, sends it to the Anthropic API, and gets a 404. The first attempt died before it ever reached the MCP server. The test only passed because I overrode the model to Sonnet on the spawn.

The fix is a one-line change to that frontmatter: set the top-level model: to a Claude model such as sonnet, and keep the backend: block as is since that's what the tycoon hooks read for the Codex routing. If TycoonAgents regenerates that file, the fix belongs in its config rather than the file. Say the word and I'll delegate the edit, or I'll keep passing the model override whenever you ask for a Codex review.