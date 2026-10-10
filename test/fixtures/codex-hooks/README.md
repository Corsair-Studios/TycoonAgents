# Codex hook fixtures

Path placeholders used throughout these fixtures: `<SCRATCH_PROJECT>` = the isolated scratch
project directory (`.../scratchpad/codex-spike/project`), `<SCRATCH_CODEX_HOME>` = the isolated
`CODEX_HOME` directory (`.../scratchpad/codex-spike/home`).

## Update (retry pass) — `notify` fires; `hooks` still does not

A second pass added `codex-home-config.toml.tried` (isolated `CODEX_HOME/config.toml`) with a
top-level `notify = ["node", ".../notify.js"]` and a `[projects.'<scratch project path>']
trust_level = "trusted"` entry (format copied verbatim from the real `~/.codex/config.toml`,
which contains only `[windows] sandbox = "elevated"` and one `[projects.'d:\<projects>\tycoonagents']
trust_level = "trusted"` block — no hooks/trust-related keys at all). `state_5.sqlite` was
`strings`-scanned read-only; it contains no hook-trust table content (only the literal words
`hook`/`hooks` from an unrelated captured text, no `trusted_hash`/schema).

**`notify` fired successfully** — `notify-agent-turn-complete.jsonl` is a real, captured
`agent-turn-complete` payload: `{type, thread-id, turn-id, cwd, client, input-messages,
last-assistant-message}`. This is the "historically reliable" mechanism per the task brief, and
is the one concrete, verified fixture from this spike.

**`hooks` still never fired** even with the project marked `trusted` in the isolated home's
config and `[hooks]` (snake_case, `--strict-config`-valid) placed in the *project*-scoped
`.codex/config.toml` (`project-config.toml.tried`) per the app's own error message, which
confirmed `notify` is **not** a valid project-local key ("Ignored unsupported project-local
config keys ...: notify") while `hooks` produced no such rejection — i.e. `hooks` is accepted at
project scope, but still never executes. Root cause remains unconfirmed. `app-server` JSON-RPC
driving (initialize/thread/turn over stdio) was identified (`codex app-server --help`) but not
exercised — out of this pass's time budget.

`rollout-agent-turn-01a083bf.jsonl` is the native session rollout for the same run that produced
the notify fixture (redacted paths/tokens), included per the rollout-fallback instruction. Its
item/event type names: `session_meta`, `turn_context`, `response_item` (kinds `message`,
`input_text`/`output_text`, `Text`), `event_msg` (kinds `UserMessage`, `AgentMessage`,
`task_started`, `task_complete`, `token_count`), `token_usage_record`, `world_state`. No
hook-specific item types (`HookStarted`/`HookCompleted`/`HookPrompt`) appear in this rollout,
consistent with hooks not having fired.


- codex-cli version: **0.153.0** (update to 0.153.4 available, not installed for this spike)
- Binary: bundled with the OpenAI ChatGPT VS Code extension at
  `%USERPROFILE%\.vscode\extensions\openai.chatgpt-26.901.22334-win32-x64\bin\windows-x86_64\codex.exe`
  (used directly by path; project's `codexDiscovery.ts` was not invoked — noted as a gap, this
  path matches what that module is expected to resolve).
- Date: 2026-09-08/09
- Isolated `CODEX_HOME`: a scratch dir under the session scratchpad; `auth.json` was copied in
  from the real `~/.codex` (ChatGPT-plan auth, ChatGPT account, `gpt-6-astra` model family).
  `TEMP`/`TMP` were also redirected to a non-OS-temp scratch dir because codex refuses to create
  PATH-alias helper binaries when `CODEX_HOME` resolves under the Windows temp directory.

## Result: no hook fired in any attempt

`test/fixtures/codex-hooks/` contains no per-event fixture files (SessionStart.json,
PreToolUse.json, etc.) because **no hook ever executed** across 5 `codex exec` runs, despite:

- `codex features list` reporting `hooks stable true` and `multi_agent stable true`.
- A project `.codex/config.toml` with a `[hooks]` table (see `config.toml.tried`) covering
  SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart,
  SubagentStop, Stop — tried once in PascalCase keys, once in snake_case keys (event names as
  emitted by the binary's own strings: `session_start`, `pre_tool_use`, etc.).
- `--strict-config` accepting the snake_case `[hooks.<event>]` schema without error (so the
  keys/shape are at least well-formed for this version).
- `--enable hooks`, `-c features.hooks=true`, and `--dangerously-bypass-hook-trust` all passed
  (the bypass flag visibly took effect — it printed the two warning items captured in
  `run4-exec-json-stream.jsonl`).
- The hook command script (`record.js`) never ran: `raw-hooks.jsonl` was never created in the
  scratch project despite the script writing unconditionally on any stdin.
- No `HookStarted`/`HookCompleted` item ever appeared in the `--json` event stream (see
  `run4-exec-json-stream.jsonl` — only `thread.started`, `error` (the bypass-trust warnings),
  `turn.started`, `agent_message`, `turn.completed`).
- A separate run with `--enable multi_agent` also produced no `CollabAgentSpawnBegin/End` events
  (the binary strings show these event names exist, e.g. for TUI-driven multi-agent sessions, but
  a plain `codex exec` prompt with no explicit subagent-spawn instruction did not trigger one;
  time budget did not allow iterating on a prompt that reliably invokes the collab-agent tool).

**Working hypothesis, not confirmed:** `HookHandlerConfig` carries a `state: HookStateToml {
enabled, trusted_hash }` field distinct from the config's own hook definitions. That suggests
hook activation may require a persisted "trust" record written by an *interactive* `codex`
session (accepting a hook-trust prompt) before `codex exec` will run it, and
`--dangerously-bypass-hook-trust` may only skip the *interactive confirmation*, not the
*persisted-trust-record requirement* — i.e. there may be no trust record to bypass into, or
`exec` requires a different mechanism (`state_path`/`codex trust`) not exposed in `--help`.
This project's `codex trust` / equivalent subcommand was not found in top-level `--help`, and time
budget did not allow deeper reverse-engineering (app-server RPCs, `debug app-server`, or
disassembly of the trust-check).

## What is captured here instead

- `config.toml.tried` — the exact hook config attempted (final snake_case version).
- `record.js` — the fixture-recording script every hook command pointed at (never invoked).
- `run4-stderr-bypass-trust.txt` / `run4-exec-json-stream.jsonl` — stderr and the full `--json`
  event stream from the run using `--strict-config --enable hooks --dangerously-bypass-hook-trust`,
  showing the bypass-trust warning fired but no hook events followed.

## Commands used (representative)

```
set CODEX_HOME=<scratch>\home
set TEMP=<scratch>\faketemp
set TMP=<scratch>\faketemp
codex.exe --strict-config exec --json --sandbox read-only --skip-git-repo-check ^
  --enable hooks --dangerously-bypass-hook-trust ^
  "Say hello. Respond with one short sentence, do not use tools." < NUL
```

Earlier attempts (all equally hook-silent, not separately archived): PascalCase event keys, no
`--strict-config`, no `--dangerously-bypass-hook-trust`, `--enable multi_agent` + `--enable hooks`
combined, and a first run without the `TEMP` override (which produced a distinct warning:
"Refusing to create helper binaries under temporary dir ... codex_home: ...\Temp\...").

## Redactions

`run4-exec-json-stream.jsonl` contains only synthetic prompt text and no auth tokens. The scratch
`auth.json` (copied from the real `~/.codex`, containing live ChatGPT OAuth tokens) was **not**
copied into this fixtures directory and was deleted with the rest of the scratch project.
