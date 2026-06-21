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

## v1 Worker Identity Simplification

In v1, worker identity is the `session_id` from the Claude Code hook payload. Claude Code does not currently expose a per-sub-agent identifier in the hook payload, so parent-to-sub-agent correlation (linking a `WorkerSpawned` to the exact child that later fires `SubagentStop`) is not implemented. This is noted as a future refinement in `mapHookRecord.ts`.
