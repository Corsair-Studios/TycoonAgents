# Claude Code Provider

The Claude Code provider bridges Claude Code hook firings into the TycoonAgents normalized event stream. It works by having a lightweight Node.js hook script write one JSON line per hook event to a shared JSONL file, which `ClaudeCodeProvider` tails on a poll interval and emits as `NormalizedEvent`s.

---

## IPC Contract: HookRecord

The hook script and the provider share one wire format — `HookRecord` (defined in `src/providers/claude-code/hookRecord.ts`):

```ts
interface HookRecord {
  event: "UserPromptSubmit" | "PreToolUse" | "SubagentStop" | "Stop";
  tool?: string;     // PreToolUse only, e.g. "Task", "Read", "mcp__server__tool"
  workerId?: string; // session/agent id from the hook payload when available
  at: number;        // epoch ms (Date.now())
}
```

Each line in the activity file is one `JSON.stringify(record)` call — no trailing commas, no pretty-printing.

---

## Hook Script: `hooks/tycoon-claude-hook.cjs`

Claude Code invokes the hook by piping the raw hook payload JSON to stdin. The script:

1. Reads all of stdin (`fs.readFileSync("/dev/stdin")`).
2. Parses the payload and extracts `hook_event_name`, `tool_name`, and `session_id`.
3. Writes a `HookRecord` line to `$TYCOON_ACTIVITY_DIR/activity.jsonl` (creating the directory if needed).
4. Always exits with code 0.

No npm dependencies — plain Node.js built-ins only (`fs`, `os`, `path`).

---

## Environment Variable: `TYCOON_ACTIVITY_DIR`

| Variable | Default | Purpose |
|---|---|---|
| `TYCOON_ACTIVITY_DIR` | `os.tmpdir()/tycoonagents` | Directory for `activity.jsonl`. Set this to a stable path so the provider and hook agree on the file location. |

Both the hook script and the provider consumer must use the same directory. When running `ClaudeCodeProvider`, pass the same resolved path:

```ts
new ClaudeCodeProvider({ activityFile: path.join(activityDir, "activity.jsonl") });
```

---

## `.claude/settings.json` Wiring Snippet

Register the hook script for all relevant Claude Code hook events. The script path here is relative to your project root — adjust as needed.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/tycoon-claude-hook.cjs"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Task|Agent|Skill|Read|Write|Edit|MultiEdit|Grep|Glob|Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/tycoon-claude-hook.cjs"
          }
        ]
      },
      {
        "matcher": "mcp__",
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/tycoon-claude-hook.cjs"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/tycoon-claude-hook.cjs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/tycoon-claude-hook.cjs"
          }
        ]
      }
    ]
  }
}
```

> **Note:** An automated installer for this settings snippet is future work. This is the manual wiring contract — copy the above into your project's `.claude/settings.json` and adjust paths as needed.

---

## Event Mapping

| HookRecord event | NormalizedEvent |
|---|---|
| `UserPromptSubmit` | `SessionStart` |
| `Stop` | `SessionStop` |
| `SubagentStop` | `WorkerStopped` |
| `PreToolUse` + spawn tool (Task/Agent/Skill) | `WorkerSpawned` |
| `PreToolUse` + other tool | `WorkerActivity` |

**`toolToActivityKind` mapping:**

| Tool | ActivityKind |
|---|---|
| `Read`, `Grep`, `Glob` | `survey` |
| `Write` | `haul` |
| `Edit`, `MultiEdit`, `NotebookEdit` | `build` |
| `Bash`, `PowerShell` | `shell` |
| `mcp__*` | `wire` |
| anything else | `build` (default) |

---

## Install & path resolution (lessons learned)

### Project-dir & activity-path resolution

- The hook resolves the project root from the `CLAUDE_PROJECT_DIR` environment variable, which Claude Code sets in the hook environment. If that variable is absent, the script walks up from `__filename` three levels (`<projectRoot>/.claude/hooks/<hook>.cjs` → `.claude/hooks/` → `.claude/` → project root).
- It derives the activity path from that root — e.g. `<projectRoot>/.claude/tycoon/activity.jsonl` — so the hook (writer) and the extension (reader) agree on the location deterministically, without requiring any external env var to be pre-set.
- **Reconciliation with `TYCOON_ACTIVITY_DIR`:** treat that variable as an optional override. When it is set, the hook uses it verbatim; otherwise the `CLAUDE_PROJECT_DIR`-derived path above is the default. The failure mode to avoid is writer and reader disagreeing because neither path was set consistently — the `CLAUDE_PROJECT_DIR` fallback eliminates that risk for typical installs.
- The doctor/verify command **must** print the actual resolved activity path and the list of registered hooks — never assume them from configuration alone.

### Events to register (one unified hook)

Use a **single** hook script (`tycoon-claude-hook.cjs`) registered for all relevant events; it branches internally on `hook_event_name`.

| Event | Matcher | Meaning |
|---|---|---|
| `UserPromptSubmit` | _(none)_ | Session/orchestrator becomes active |
| `PreToolUse` | `Task\|Agent\|Skill` | Worker spawned — route to `agentId`, push onto active-agent stack |
| `PreToolUse` | `Read\|Write\|Edit\|Grep\|Glob\|Bash` | Tool activity — attribute to the agent at the top of the stack |
| `PreToolUse` | `mcp__` | MCP call — attribute to the agent at the top of the stack |
| `SubagentStop` | _(none)_ | Worker stopped — capture tokens, pop active-agent stack |
| `Stop` | _(none)_ | Session end |
| `TaskCompleted` | _(none)_ | Task completion event |

> **Windows note:** Invoke the script with the full path to `node.exe` if `node` is not on the system PATH inside the hook environment (e.g. `C:\Program Files\nodejs\node.exe .claude\hooks\tycoon-claude-hook.cjs`). Relative script paths are resolved relative to the project root when Claude Code fires the hook.

### Token capture (on SubagentStop)

Read per-agent token counts from the hook payload's `usage` field:

1. Prefer `usage.total_tokens` if present.
2. Otherwise sum: `input_tokens + output_tokens + cache_creation_input_tokens` (add `cache_read_input_tokens` if present).
3. If the payload contains no `usage` field, fall back to the agent's transcript `.jsonl` and read the last entry that carries a `usage` key.

Attribute the captured count to the agent that was just popped from the active-agent stack.

### Metric sourcing (for the agent-activity panel)

- **Name** — title-cased form of the agent id (e.g. `coding-specialist` → `Coding Specialist`).
- **Tasks completed** — count of `TaskCompleted` or `SubagentStop` events attributed to that agent.
- **MCP calls** — count of `PreToolUse` events whose `tool_name` matches `mcp__*`, attributed via the active-agent stack.
- **Time spent** — cumulative active wall-clock time from spawn timestamp to stop timestamp per agent; apply an idle timeout to avoid inflating time when the agent is blocked waiting for I/O.
- **Tokens** — per token-capture above, accumulated across all invocations of the agent within the session.
- **Response %** — this is **not** a standard hook-derived value. It must be explicitly defined (e.g. as a task-success ratio: `TaskCompleted` count ÷ total `WorkerSpawned` count for that agent) or omitted from the panel entirely.

### Install robustness

See `docs/DISTRIBUTION.md` for the full install contract. Key constraint: the installer merges hook entries over an existing `.claude/settings.json` (never overwrites it wholesale), validates that each hook is registered for the correct event and matcher, and fails loudly — printing the resolved activity path and the full registered-hook list — rather than silently continuing with a misconfigured state.

---

## v1 Worker Identity Simplification

In v1, worker identity is the `session_id` from the Claude Code hook payload. Claude Code does not currently expose a per-sub-agent identifier in the hook payload, so parent-to-sub-agent correlation (linking a `WorkerSpawned` to the exact child that later fires `SubagentStop`) is not implemented. This is noted as a future refinement in `mapHookRecord.ts`.
