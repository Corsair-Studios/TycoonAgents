# OpenCode hook-probe spike (plan p3-t1)

Throwaway. Purpose: capture the *exact* payload shapes OpenCode sends to
plugin hooks, so a later phase can map them to TycoonAgents' activity
records instead of guessing from docs.

Docs read for this spike: https://opencode.ai/docs/plugins and
https://opencode.ai/docs/agents, both reporting "Last updated: September 2,
2026" at fetch time.

## 1. Install OpenCode

Per the docs, any of:

```sh
npm i -g opencode-ai
# or
curl -fsSL https://opencode.ai/install | bash
# or (Homebrew, if on macOS)
brew install sst/tap/opencode
```

Record the exact version you end up with:

```sh
opencode --version
```
Paste that output into your report back.

## 2. Register the probe plugin

OpenCode loads local plugin files from `.opencode/plugin/` (or via the
`plugin` array in `opencode.json` pointing at a file/module). From the repo
root:

```sh
mkdir -p .opencode/plugin
cp standalone/spike/opencode-probe-plugin.ts .opencode/plugin/opencode-probe-plugin.ts
```

(Symlinking instead of copying is fine too â€” either way it must resolve
under `.opencode/plugin/` or be listed in `opencode.json`'s `plugin` array
for OpenCode to load it.)

The subagent definition at `.opencode/agents/probe-sub.md` needs no extra
registration â€” OpenCode discovers `.opencode/agents/*.md` automatically.

## 3. Run the scenario

From the repo root:

```sh
opencode
```

Then, in the OpenCode TUI/chat:

1. Send exactly: `Use @probe-sub to say hello, then reply done`
2. Wait for it to finish.
3. In a second prompt, ask the subagent to itself delegate to another
   subagent, to test recursion, e.g.: `Now have probe-sub delegate this
   same task to another subagent and report what happened.`
4. Quit OpenCode.

## 4. Where the log lands

`.opencode/plugin/probe-log.jsonl` — it writes beside the plugin file
itself (`path.join(__dirname, "probe-log.jsonl")`), not under
`standalone/spike/`. One JSON object per line, shaped
`{ "hook": string, "at": epoch-ms, "payload": ... }`. Any string field over
8 KB (e.g. base64 image parts) is truncated with a
`…[truncated N chars]` marker. A handler that throws logs a
`{ "hook": "PROBE_ERROR", "error": ... }` line instead of crashing OpenCode.

## 5. What to send back

- `.opencode/plugin/probe-log.jsonl` (the full file from your run)
- The `opencode --version` output
- Anything that looked wrong or empty (e.g. a hook that never fired, or a
  payload that was just `{}`)

## Findings from a real run

- OpenCode does **not** deliver `session.*`/`message.*` as top-level hook
  keys. Only `tool.execute.before`/`tool.execute.after` fired that way.
  All bus events (session created/idle, message updated, message part
  updated, etc.) come through a single `event` hook:
  `event: async ({ event }) => { ... }` where `event.type` is e.g.
  `"session.created"`, `"message.updated"`, `"message.part.updated"`,
  `"session.idle"`, and `event.properties` is the payload. See
  `.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`.
- Model id format: OpenCode rejected `anthropic/claude-haiku-4-5` in an
  agent file and suggested the bare `claude-haiku-4-5` instead (no
  provider prefix in that context).
- With OpenCode Zen, the model actually running reports
  `providerID: "opencode"`, `modelID: "big-pickle"` — not the id you'd
  expect from the display name.

## Do not commit the log

`probe-log.jsonl` is runtime output, not source â€” it has been added to the
repo's `.gitignore`. Don't force-add it.
