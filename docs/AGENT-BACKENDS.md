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

### claude-native (explicit, though this is also the default)

```yaml
---
model: sonnet
backend:
  vendor: anthropic
  transport: claude-native
  model: anthropic/claude-sonnet-4-6
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

At runtime, a caller resolves `endpointEnv`/`apiKeyEnv` by reading
`process.env.OPENAI_COMPAT_BASE_URL` / `process.env.OPENAI_COMPAT_API_KEY` —
this schema only names which env vars to read, per this repo's
[Path & Environment Discovery](../CLAUDE.md#path--environment-discovery-core-principle)
principle of never baking a machine-specific URL or secret into a file.

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

### Getting these agents on a fresh install

A fresh install obtains these four agents via the optional **Multi-LLM
agents** pack (`media/packs/catalog.json`, id `multi-llm`) from the panel's
Packs view. Install it only after configuring the matching MCP server
(codex, gemini, openai-compatible, or claude-cli); the pack has no single
MCP dependency, so the panel does not show a needs-MCP badge for it.
