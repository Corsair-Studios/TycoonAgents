---
name: tycoon-ready-test
description: >
  Run the TycoonAgents ready test — spawn all configured agents in parallel and verify they
  light up in the TycoonAgents agent visualization. Use when the user says "ready test",
  "tycoon agents ready test", "run ready test", or asks to "test the agents".
---

# TycoonAgents Ready Test

**IMPORTANT:** When the user says "ready test", "tycoon agents ready test", "run ready test", or asks to "test the agents", execute this TycoonAgents visualization test procedure.

The TycoonAgents ready test verifies that all agents can be triggered correctly and appear in the TycoonAgents VS Code extension visualization. This test spawns all configured agents in parallel and confirms they light up in the agent visualization.

## Harness

This skill is for the **Claude Code harness**, which has the Task/Agent tool. The Codex harness has no Task tool, so this procedure does not apply there: on Codex, run one delegate call per agent instead (`mcp__tycoon__delegate` with `specialist: "<agent-id>"` and a task asking it to reply "OK" and name its model) and report the same table from the results. Codex is otherwise out of scope for this skill.

## Purpose

- Verify the hook system is working and detecting agent activity
- Test that keyword routing sends tasks to the correct agents
- Confirm every agent runs as ITSELF (its own file, model, and tools) via the Task tool
- Confirm bridge agents really reach their foreign model, not a Claude stand-in
- Validate the visualization shows all agents becoming active

## Procedure

1. **Discover agents dynamically** - Scan the `.claude/agents/` directory (or path shown in debug panel) to find all `*.md` agent definition files
2. **Exclude team leads** - Skip any agent whose frontmatter contains `tier: lead`. Leads (e.g. `build-lead`, `quality-lead`) are coordinators that own their own worker agents; spawning a lead directly would double-spawn its workers, so leads are excluded from the ready test entirely (not even counted as an implicit pass)
3. **Note implicit tests** - Coordinators pass implicitly (light up on user prompts); fallback agents pass implicitly (light up as fallback worker)
4. **Read each agent file** - Note its `name` and whether its frontmatter has a `backend:` block or `mcpServer` (a **bridge agent**: codex-reviewer, gemini-reviewer, grok/kimi/mistral-reviewer, claude-worker, and similar)
5. **Spawn parallel tasks** - Use the Task tool to spawn ONE task for EACH worker agent simultaneously, all in a single message. Set `subagent_type` to the agent's name exactly as in `.claude/agents/<name>.md` (e.g. `subagent_type: "coding-specialist"`), so the agent's own file, model, and tools load. Never use `general-purpose` or `Explore` as a stand-in: a generic subagent is not the agent and would pass falsely. Format the task description as `<agent-id>: <keywords> check` (e.g. `coding-specialist: implement code fix check`); the hook maps the spawn to the right agent from `subagent_type` and from this explicit-name prefix. Do not override the model. Spawning every agent at once intentionally exceeds the configured sonnet parallel-agent limit as a visualization stress test - by design.
6. **Brief each agent** - Keep the prompt short. Every agent must reply with: its name, the model it is running on, and "ready". Do not give it real work. A non-bridge agent must make no tool calls and reply in one line. A bridge agent must also reply in one line and must follow the **Bridge ping** rules below.
7. **Wait for completion** - All agents should complete their simple verification task
8. **Report results** - Use the Report Format below

## Bridge ping

For a bridge agent, "ready" is not enough. The agent chooses ONE route before calling: its own vendor MCP tool (the `mcpServer`/`tools` in its frontmatter) if that server is configured; else `mcp__tycoon__delegate` with `specialist: "<its own id>"` if that tool is present; else it reports `bridge not installed`. It then makes exactly ONE minimal call on that route: reply "OK" in 5 tokens or fewer, cheapest model and lowest effort, no files, no tools. The agent reports the answering vendor/model taken from the tool result (not from itself). Rules:

- If neither route exists in the session, report `bridge not installed` and suggest starting a new chat: a server installed or changed since this chat began only loads in a new one.
- If the call errors with an auth, key, or login problem, report `key or login missing`.
- After the single chosen call there is no retry on another route, and never answer the ping as itself (as a Claude model). Any other error is a failure.

## Important Notes

See **Procedure** above for the full workflow (discovery, exclusions, spawning, and reporting rules).

## Example Execution

See **Procedure** above — the steps there are the execution sequence.

## Report Format

Report ALL agents discovered. Keep each response cell to a few words:

```
**Ready test complete. X passed, W warnings, Y failed.**

| Agent | Status | Response |
|-------|--------|----------|
| orchestrator | ✅ pass | Lights up on user prompts (implicit test) |
| primary-agent | ✅ pass | Lights up as fallback worker |
| [specialist] | ✅ pass | ready, running on <model> |
| [bridge agent] | ✅ pass | answered by <vendor/model> |
| [bridge agent] | ⚠️ bridge not installed | MCP tool unavailable; start a new chat |
| [bridge agent] | ⚠️ key/login missing | auth error from bridge |
| [specialist] | ❌ failed | [short reason] |

**Summary:** N agents total, X passed, W warnings, Y failed.
```

- List every agent discovered from the agents directory
- Coordinator and fallback agents count as passed (they light up via implicit mechanisms)
- A bridge agent passes only when the ping was answered by the foreign vendor/model; the two ⚠️ statuses count as warnings, not passes
- Calculate totals dynamically from discovered agents

## Troubleshooting

If an agent fails to appear in the visualization:
- Check that `subagent_type` equals the agent name and the task description starts with `<agent-id>:`
- Verify the hooks in the repo-root `hooks/` directory are properly configured
- Ensure the TycoonAgents extension is running and the webview is visible
