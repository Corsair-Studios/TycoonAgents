# Agent Backend Declarations

Status: schema + parser only (plan task p2-t1). This does NOT change hook
behavior — `hooks/tycoon-claude-hook.cjs` still hardcodes its `mcp__codex__`
special case (lines ~1336-1376) and does not yet call `parseAgentBackend`. A
later task wires that in.

## Relationship to routing.json and fallback chains

This document covers the per-agent `backend:` frontmatter schema and its
defaults/validation only. A project-wide `.claude/tycoon/routing.json`
profile (schema, precedence, migration from `opencode-models.json`) that
overrides these `backend:` blocks — plus how a `RoutingSlot.fallback` chain
is detected, recorded, and re-dispatched at runtime, and every activity
record field it produces — is documented in `docs/ROUTING-PROFILE.md`. See
`docs/OPENCODE-PROVIDER.md` for the OpenCode-side generation and enforcement
counterpart.

## Purpose

Every `.claude/agents/*.md` subagent can declare a `backend:` block in its
YAML frontmatter describing which LLM vendor/transport actually executes it.
Today only Claude-native agents and the hardcoded Codex MCP special case
exist; this schema lets future foreign-LLM agents (Gemini, Kimi, Qwen, or any
OpenAI-compatible endpoint on a VM) be described declaratively instead of
adding another hardcoded branch to the hook.

Parser: `src/core/agentBackend.ts` → compiles to `out/src/core/agentBackend.js`.
Alias table: `src/core/modelAliases.ts` (`MODEL_ALIASES`,
`resolveModelAlias`) — the same opus/sonnet/haiku/fable table the hook keeps
as `SHORTHAND_MODEL` (hooks/tycoon-claude-hook.cjs lines ~105-110). The two
copies are intentionally separate for now: the hook is a standalone zero-dep
`.cjs` that must run even when `out/` hasn't been built. A future task may
have the hook `require("../out/src/core/modelAliases.js")` instead of
keeping its own copy.

## Schema

```yaml
backend:
  vendor: string            # anthropic | openai | google | moonshot | alibaba | local | any string
  transport: claude-native | mcp | openai-compatible
  mcpServer: string         # required when transport is 'mcp' — id in .mcp.json, e.g. 'codex'
  tools: [string]           # MCP tool names the agent calls, e.g. [codex, codex-reply]
  model: string             # 'provider/model' form, e.g. openai/gpt-6-astra, google/gemini-2.5-pro, moonshot/kimi-k2
  costModelClass: metered | subscription | local
  endpointEnv: string       # required when transport is 'openai-compatible' — env var holding base_url
  apiKeyEnv: string
```

`costModelClass` matches the concept frozen in `docs/provider-contract.md`
Section 4: `metered` (marginal per-token cost, e.g. the Anthropic API),
`subscription` (flat-rate/quota-window, e.g. Codex on a ChatGPT plan), or
`local` (runs on the user's own hardware, zero marginal cost).

## Default when `backend` is absent

```yaml
vendor: anthropic
transport: claude-native
model: anthropic/<resolved id>
costModelClass: metered
```

`<resolved id>` is the top-level `model:` value (e.g. `sonnet`) run through
`resolveModelAlias` from `src/core/modelAliases.ts` — the same alias
resolution the hook does today. If the top-level `model:` key is itself
missing, `<resolved id>` falls back to the literal string `unknown`.

## Validation rules

- `transport` must be one of `claude-native`, `mcp`, `openai-compatible`.
  Any other value throws: `Invalid backend.transport: <value> — allowed
  values are claude-native, mcp, openai-compatible`.
- `costModelClass` must be one of `metered`, `subscription`, `local`. Any
  other value throws the equivalent error naming `backend.costModelClass`.
- `transport: mcp` requires `mcpServer` — throws `Invalid backend: transport
  'mcp' requires \`mcpServer\`` when missing.
- `transport: openai-compatible` requires `endpointEnv` — throws `Invalid
  backend: transport 'openai-compatible' requires \`endpointEnv\`` when
  missing.
- `model` is required (either `backend.model` or, failing that, the
  top-level `model:` key) — throws `Invalid backend: \`model\` is required
  (provider/model form)` when neither is present.
- A `backend:` value that isn't a mapping throws `Invalid backend: expected
  an object, got <value>`.

## Examples

Model aliases (`sonnet`, `opus`, `haiku`, `fable`, or `anthropic/sonnet`) always resolve to the newest model in that family, so the examples below never pin a version; pin one explicitly (for example `anthropic/claude-sonnet-4-6`) only if you want that exact model.

### claude-native (explicit, though this is also the default)

```yaml
---
model: sonnet
backend:
  vendor: anthropic
  transport: claude-native
  model: anthropic/sonnet
  costModelClass: metered
---

# Coding Specialist
...
```

### mcp — Codex (matches `.claude/agents/codex-reviewer.md` conceptually;
that file is NOT edited by this task)

```yaml
---
model: sonnet
disallowedTools: Agent
backend:
  vendor: openai
  transport: mcp
  mcpServer: codex
  tools: [codex, codex-reply]
  model: openai/gpt-6-astra
  costModelClass: subscription
---

# Codex Reviewer
...
```

### openai-compatible — Kimi on a VM-hosted endpoint

```yaml
---
model: sonnet
backend:
  vendor: moonshot
  transport: openai-compatible
  model: moonshot/kimi-k2
  costModelClass: metered
  endpointEnv: OPENAI_COMPAT_BASE_URL
  apiKeyEnv: OPENAI_COMPAT_API_KEY
---

# Kimi Reviewer
...
```

### claude-native, foreign vendor — Grok (xAI) via OpenCode (native, no bridge)

OpenCode ships a built-in `xai` provider (https://opencode.ai/docs/providers/,
model ids in `xai/<model>` form), so under the OpenCode host this vendor runs
natively — no MCP bridge, no relaying agent, and no per-call Claude-token
overhead (`transport: claude-native` — this project's generic "handled
natively by the host, no bridge required" value, same as the `opencode`
vendor's own presets in `src/core/routingHostOps.ts`). Auth is `XAI_API_KEY`
(names only — the value is never stored in this repo; see
`src/core/localEnvStore.ts`). OpenCode's docs also describe a SuperGrok/
X Premium `/connect` OAuth login as an alternative to an API key; that path
is unverified here (sourced from a third-party guide, not confirmed against
a live OpenCode install).

```yaml
---
model: sonnet
backend:
  vendor: xai
  transport: claude-native
  model: xai/grok-4.7
  costModelClass: metered
  apiKeyEnv: XAI_API_KEY
---

# some-agent
...
```

Reasoning-effort control for Grok under OpenCode is not documented anywhere
this project has checked — `backend.reasoningEffort` (see above) is left
unset for this vendor rather than guessed at.

### openai-compatible, foreign vendor — Grok (xAI) via Claude Code (bridged)

Claude Code has no native Grok host. Under Claude Code, xAI's Grok is reached
the same way Kimi is (see the Kimi example above): a Claude subagent —
`grok-reviewer`, shipped in the optional "Multi-LLM agents" pack alongside
`kimi-reviewer` (`src/host/vscode/packCatalog.ts`'s `FOREIGN_LLM_AGENTS`,
`media/packs/catalog.json` id `multi-llm`) — relays the call through the same
`openai-compatible` MCP server (`hooks/openai-compatible-mcp.cjs`). This
wrapper spends a few Claude tokens per call on top of Grok's own token usage
(the relaying subagent's own turn), and Grok only ever sees what that agent
passes it in `prompt`/`messages`/`system` — never this conversation's wider
context.

xAI's API is itself OpenAI-compatible (base URL `https://api.x.ai/v1`, bearer
auth, `/v1/chat/completions` — verified against https://docs.x.ai), so rather
than requiring a second global MCP server process, `hooks/openai-compatible-
mcp.cjs` carries a small `VENDOR_DEFAULTS` table keyed by model-id prefix.
For a `xai/`-prefixed model, this bridge uses a **dedicated** endpoint/key
pair, completely separate from the generic `OPENAI_COMPAT_BASE_URL`/
`OPENAI_COMPAT_API_KEY` a Kimi/Qwen/local-endpoint user configures — the two
are never mixed, so a Kimi user's Grok calls can never leak to the Kimi host
under the Kimi key (or vice versa):

- **Base URL:** `XAI_BASE_URL` if set, else `https://api.x.ai/v1`.
- **API key:** `XAI_API_KEY` only — there is no fallback to
  `OPENAI_COMPAT_API_KEY` for a prefixed model. If `XAI_API_KEY` is unset,
  the bridge returns `isError:true` naming `XAI_API_KEY` (never a silent
  fallback, never a leaked value).
- **Model id:** the `xai/` prefix is stripped before the request reaches
  xAI (its API rejects the prefixed id) — pricing/metrics elsewhere in this
  project (`media/src/main/080-packs-events.js`'s `PRICE_TABLE`) still key
  off the prefixed id (`xai/grok-build-0.1`); the bridge is the only place
  that ever sees the stripped form, on the outgoing HTTP request only.

An unprefixed model (e.g. `moonshot/kimi-k2`) keeps today's
`OPENAI_COMPAT_BASE_URL`/`OPENAI_COMPAT_API_KEY` behavior unchanged. Set
`XAI_API_KEY` as an environment variable (`XAI_BASE_URL` only if you need to
override the default host) and no other configuration is required for the
bridge, per this repo's
[Path & Environment Discovery](../CLAUDE.md#path--environment-discovery-core-principle)
principle.

```yaml
---
model: sonnet
backend:
  vendor: xai
  transport: openai-compatible
  mcpServer: openai-compatible
  tools: [chat]
  model: xai/grok-build-0.1
  costModelClass: metered
  endpointEnv: XAI_BASE_URL
  apiKeyEnv: XAI_API_KEY
---

# grok-reviewer
...
```

`xai/grok-build-0.1` (fast/cheap, $1 in / $2 out per MTok) is the default
model for routine review calls; `xai/grok-4.7` (flagship reasoning, $2 in /
$6 out per MTok) is available on the same bridge for reviews that need it.
Both model ids are shared with the OpenCode-native preset above, so pricing
lookups (`media/src/main/080-packs-events.js`'s `PRICE_TABLE`) resolve
identically regardless of which path (native or bridged) produced the usage.

At runtime, a caller resolves `endpointEnv`/`apiKeyEnv` by reading
`process.env.OPENAI_COMPAT_BASE_URL` / `process.env.OPENAI_COMPAT_API_KEY` for
an unprefixed model, or `process.env.XAI_API_KEY` (and optionally
`process.env.XAI_BASE_URL`) for a `xai/`-prefixed one — this schema only
names which env vars to read, per this repo's
[Path & Environment Discovery](../CLAUDE.md#path--environment-discovery-core-principle)
principle of never baking a machine-specific URL or secret into a file.

#### Smoke-testing the bridge

`scripts/smoke-test-grok-bridge.mjs` (`npm run smoke-test:grok`) spawns the
real `hooks/openai-compatible-mcp.cjs` server and sends one tiny `chat` call
against `xai/grok-build-0.1`, printing only the model's reply and token
usage — never the key. The key is always read from the environment, never
passed as an argument. Run it with `XAI_API_KEY` set in the environment:

```
# bash/zsh
XAI_API_KEY=... npm run smoke-test:grok
```

```powershell
# PowerShell — if XAI_API_KEY is already set as a user/session env var,
# just run the script; otherwise set it for the session first:
$env:XAI_API_KEY = "..."
npm run smoke-test:grok
```

This makes a real call to `https://api.x.ai/v1` and spends a small amount of
real xAI credit; it is a manual, deliberate check, not part of the
automated test suite (`test/`, `standalone/test/`), which covers the bridge
with fakes/mocks only, no network.

## API

```ts
import { parseAgentBackend, readAgentFrontmatter, Backend } from "../src/core/agentBackend";
import { resolveModelAlias, MODEL_ALIASES } from "../src/core/modelAliases";

const frontmatter = readAgentFrontmatter(mdFileText);
const backend: Backend = parseAgentBackend(frontmatter);
```

`readAgentFrontmatter` is a minimal, zero-dependency parser matching the flat
`key: value` subset of YAML the hook's own `readAgentDescription` /
`readAgentModel` / `readAgentTier` helpers already rely on
(`hooks/tycoon-claude-hook.cjs` lines ~122-172): no nested mappings beyond
one level (the `backend:` block's own children), no multi-line scalars,
inline lists as `[a, b, c]` only.

## Subscription-backed CLI bridges

### Why

Some agents should run on a user's existing CLI subscription seat (Claude
Max/Pro, ChatGPT Plus/Pro) instead of a metered API key — the user already
pays for the seat, and TycoonAgents should let that quota do delegated work
without ever touching or forwarding the underlying credentials. The only
supported way to do this is through the vendor's own official CLI: a third
party impersonating that CLI's OAuth client to obtain tokens directly is
against the vendor's terms. TycoonAgents instead shells out to the CLI the
user already logged into (`claude`, `codex`) via a local MCP stdio server,
so auth stays entirely inside the vendor's own tool. This is a design
choice, not legal advice — a user with concerns about their subscription's
terms should check them directly.

### How

Two local, zero-dependency MCP servers implement this pattern:

- `hooks/claude-cli-mcp.cjs` — wraps `claude -p ... --output-format json`,
  catalog id `claude-cli` (media/mcp/catalog.json), agent
  `.claude/agents/claude-worker.md`.
- Codex's existing `codex mcp-server` integration (catalog id `codex`,
  agent `.claude/agents/codex-reviewer.md`) is the same pattern for OpenAI —
  `codex mcp-server` works identically whether launched from Claude Code or
  from OpenCode.

Both declare `backend.costModelClass: subscription` per the schema above,
and both spawn the vendor CLI as a child process per call rather than
holding any credential themselves.

### Caveats

- **User's choice, not a default.** These backends only activate when an
  agent's frontmatter names them (`mcpServer: claude-cli` / `mcpServer:
  codex`) — nothing routes to a subscription CLI implicitly.
- **The official CLI is the supported surface.** Any future subscription
  bridge added to this repo should follow the same shape: shell out to the
  vendor's own CLI, never re-implement or intercept its OAuth flow.
- **Slower per turn.** Spawning a full CLI process and waiting on its own
  agentic loop costs real wall-clock time per call — budget for it in
  `max_turns` and any caller-side timeout.
- **Restricted permission mode.** `claude-cli-mcp.cjs` defaults
  `--permission-mode` to `plan` (read-only planning) so a delegated call
  can't silently make unattended edits; a caller that needs write access
  must opt in explicitly (both `allowed_tools` and a permissive
  `CLAUDE_CLI_PERMISSION_MODE`).
- **Context budget via `cwd`.** Running with the caller's project as `cwd`
  loads that project's CLAUDE.md and file context into every call, inflating
  prompt-cache-creation tokens and cost; both bridges default to an isolated
  scratch working directory instead, and only load project context when a
  caller sets `cwd` deliberately.
- **Dispatcher `claude -p` children.** Read-only roles (reviewers, search,
  audit, agents without edit tools) run `--permission-mode plan` in the
  isolated scratch dir. Builder agents run `acceptEdits` with the project as
  `cwd` (edits stay inside the project; shell commands follow the project's
  own permission allow list), a leaf preamble, `Task`/`Agent` disallowed, and
  TycoonAgents hooks skipped via `TYCOON_BRIDGE_CHILD=1` (the dispatcher
  records the worker itself). An agent file can set `permissionMode:`;
  `CLAUDE_CLI_PERMISSION_MODE` can only lower the mode, and only `plan`,
  `acceptEdits` and `default` are accepted.

### Getting these agents on a fresh install

A fresh install obtains these agents — Codex Reviewer, Gemini Reviewer, Kimi
Reviewer, Grok Reviewer, and Claude Worker — via the optional **Multi-LLM
agents** pack (`media/packs/catalog.json`, id `multi-llm`) from the panel's
Packs view. Install it only after configuring the matching MCP server
(codex, gemini, openai-compatible — shared by Kimi Reviewer and Grok
Reviewer — or claude-cli); the pack has no single MCP dependency, so the
panel does not show a needs-MCP badge for it.
