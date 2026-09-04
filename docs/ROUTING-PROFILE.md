# Routing Profile

`.claude/tycoon/routing.json` lets a project declare, per agent, which
vendor/model/transport serves it — one file that both the Claude Code
frontmatter generator and the OpenCode config generator read as their
highest-priority source. It is entirely optional: a project with no
`routing.json` behaves exactly as it does today.

See `src/core/routingProfile.ts` for the loader/validator implementation and
`design-docs/routing-profile-prd.md` for the full PRD and milestone plan.

## File location

`<project>/.claude/tycoon/routing.json`, one per project.

## Top-level shape

```ts
interface RoutingProfile {
  version: 1;
  orchestrator?: RoutingSlot;
  agents: Record<string, RoutingSlot>;
  defaults?: Partial<RoutingSlot>;
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `version` | `1` | required | Only `1` is currently valid. |
| `orchestrator` | `RoutingSlot` | none | Slot for the top-level orchestrator. Merged over `defaults`. |
| `agents` | `Record<string, RoutingSlot>` | `{}` (required key) | Keyed by agent id (matches `.claude/agents/<id>.md`'s filename stem). |
| `defaults` | `Partial<RoutingSlot>` | none | Fields applied to every agent/orchestrator slot before that slot's own fields override them. |

## RoutingSlot fields

```ts
interface RoutingSlot {
  vendor?: string;
  transport?: "claude-native" | "mcp" | "openai-compatible";
  mcpServer?: string;
  tools?: string[];
  model?: string;
  costModelClass?: "metered" | "subscription" | "local";
  endpointEnv?: string;
  credentialEnv?: string;
  fallback?: RoutingSlot[];
}
```

| Field | Type | Default | Example |
| --- | --- | --- | --- |
| `vendor` | `string` | `"anthropic"` (when the slot is converted to a `Backend`) | `"opencode"`, `"anthropic"`, `"moonshot"` |
| `transport` | `"claude-native" \| "mcp" \| "openai-compatible"` | `"claude-native"` | `"mcp"` |
| `mcpServer` | `string` | none | `"codex"` (required when `transport: "mcp"`) |
| `tools` | `string[]` | none | `["mcp__codex__exec"]` |
| `model` | `string` | none | `"anthropic/claude-sonnet-4-6"` or a bare alias like `"sonnet"` |
| `costModelClass` | `"metered" \| "subscription" \| "local"` | `"metered"` | `"subscription"` |
| `endpointEnv` | `string` (env var **name**, never a value) | none | `"KIMI_ENDPOINT_URL"` |
| `credentialEnv` | `string` (env var **name**, never a value) | none | `"KIMI_API_KEY"` |
| `fallback` | `RoutingSlot[]` | none | Ordered chain tried in order if the primary slot fails. Max depth 3. |

### `credentialEnv` replaces `apiKeyEnv`

`src/core/agentBackend.ts`'s `Backend` type uses `apiKeyEnv`. Routing profile
slots use `credentialEnv` instead — same meaning (the *name* of an
environment variable holding a credential, never the value itself), renamed
for clarity now that routing.json also carries `endpointEnv` for the same
slot. `routingSlotToBackend()` maps `credentialEnv → apiKeyEnv` when adapting
a resolved slot into the existing `Backend` shape, so generators built
against `Backend`/`parseAgentBackend()` need no changes.

## The no-secrets rule

No field whose name matches `/key|secret|token|password/i` is permitted
anywhere in routing.json **except** `credentialEnv` and `endpointEnv` — and
those two may only ever hold an environment variable *name*, never a value.
The loader rejects any other matching field with:

> `secrets must not be stored in routing.json; use env var names`

The check matches property names, so a non-secret field containing key, secret, token, or password (for example `tokenBudget`) is also rejected; rename such fields rather than expecting an exemption.

This mirrors the PRD's Non-Functional Requirement that no secret or
credential value is ever stored in project files — only variable names and
booleans.

## Resolution

- `resolveAgentSlot(profile, agentId)` — merges `defaults` then
  `agents[agentId]` (agent-specific fields win). Returns `null` when the
  agent has no entry in `agents` and `defaults.model` is unset — meaning the
  profile has nothing to say about that agent.
- `resolveOrchestratorSlot(profile)` — merges `defaults` then `orchestrator`.
  Returns `null` when neither is present.
- `routingSlotToBackend(slot)` — adapts a resolved slot to the existing
  `Backend` shape (`src/core/agentBackend.ts`), filling `vendor`,
  `transport`, `model`, and `costModelClass` with the same defaults
  `parseAgentBackend()` uses for an agent with no `backend:` block, so a
  partial slot degrades gracefully.

## Precedence rule (decided)

**`routing.json` always wins.** For any agent it covers, the profile
overrides both:

1. that agent's `.claude/agents/<id>.md` frontmatter `backend:` block, and
2. any entry for that agent in `.claude/tycoon/opencode-models.json`.

An agent's hand-edited frontmatter `backend:` block remains authoritative
**only** for agents absent from the profile (no `routing.json` at all, or an
`agents` map that doesn't mention that agent id). This matches the existing
precedent set by the OpenCode-config generator, where a generated artifact is
never hand-preserved once a higher-priority source exists — see
`design-docs/routing-profile-prd.md`'s Risks section ("Profile vs. frontmatter
precedence").

`.claude/tycoon/opencode-models.json` is **deprecated**: with a `routing.json`
present, it is consulted only as a manual escape hatch for agents the profile
doesn't cover (see Migration below). With no `routing.json` present at all,
existing `opencode-models.json` behavior is unchanged — this file is purely
additive.

## Loader contract

`loadRoutingProfile(projectRoot: string): { profile: RoutingProfile | null; path: string; errors: string[] }`

- File absent → `{ profile: null, path, errors: [] }`. Never throws.
- File present and valid → `{ profile, path, errors: [] }`.
- File present and invalid (bad JSON, wrong `version`, malformed `agents`,
  a bad enum value, a disallowed secret-like field name, a `fallback` chain
  deeper than 3) → `{ profile: null, path, errors }`, one message per
  problem, each naming the offending JSON path (e.g.
  `agents.kimi-reviewer.transport: invalid value "ssh" — allowed: claude-native, mcp, openai-compatible`).

## Full example

```jsonc
{
  "version": 1,
  "orchestrator": {
    "vendor": "opencode",
    "transport": "openai-compatible",
    "model": "opencode/big-pickle",
    "costModelClass": "local",
    "endpointEnv": "OPENCODE_ENDPOINT_URL"
  },
  "agents": {
    "coding-specialist": {
      "vendor": "anthropic",
      "transport": "claude-native",
      "model": "anthropic/claude-sonnet-4-6",
      "costModelClass": "subscription"
    },
    "kimi-reviewer": {
      "vendor": "moonshot",
      "transport": "openai-compatible",
      "model": "moonshot/kimi-k2",
      "costModelClass": "local",
      "endpointEnv": "KIMI_ENDPOINT_URL",
      "credentialEnv": "KIMI_API_KEY",
      "fallback": [
        {
          "vendor": "openai",
          "transport": "mcp",
          "mcpServer": "codex",
          "tools": ["mcp__codex__exec"],
          "model": "openai/gpt-5.4-mini",
          "costModelClass": "subscription"
        }
      ]
    }
  },
  "defaults": {
    "costModelClass": "metered"
  }
}
```

In this example: the orchestrator runs on a locally-hosted `big-pickle`
model through OpenCode; `coding-specialist` is pinned to the Claude
subscription via the native transport; `kimi-reviewer` runs against a local
OpenAI-compatible endpoint and falls back to Codex (via MCP) if that
endpoint is unavailable. Any agent not listed here (e.g. `search-retrieval`)
falls back to its own frontmatter `backend:` block, since the profile says
nothing about it.

## Migration from `opencode-models.json`

`.claude/tycoon/opencode-models.json` previously let a project override an
agent's OpenCode model without touching frontmatter. Once a project adopts
`routing.json`:

1. For each agent entry in `opencode-models.json`, add an equivalent
   `RoutingSlot` under `agents.<id>` in `routing.json` (at minimum, carry the
   `model` string over).
2. Once every agent covered by `opencode-models.json` has a corresponding
   `routing.json` entry, `opencode-models.json` can be deleted — routing.json
   supersedes it for those agents.
3. The generator (`scripts/generate-opencode-config.mjs`, p12-t3) checks
   `routing.json` first; `opencode-models.json` is consulted only for agents
   the profile doesn't mention, so a partial migration is safe — nothing
   breaks for agents not yet migrated.

No code change is required to add a newly-released model: set `model` to
any `"provider/model"` string in the relevant slot.
