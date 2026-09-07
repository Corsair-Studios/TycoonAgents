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

## Purpose

- Verify the hook system is working and detecting agent activity
- Confirm all agents can be spawned via the Task tool
- Test that keyword routing sends tasks to the correct agents
- Validate the visualization shows all agents becoming active

## Procedure

1. **Discover agents dynamically** - Scan the `.claude/agents/` directory (or path shown in debug panel) to find all `*.md` agent definition files
2. **Exclude team leads** - Skip any agent whose frontmatter contains `tier: lead`. Leads (e.g. `build-lead`, `quality-lead`) are coordinators that own their own worker agents; spawning a lead directly would double-spawn its workers, so leads are excluded from the ready test entirely (not even counted as an implicit pass)
3. **Note implicit tests** - Coordinators pass implicitly (light up on user prompts); fallback agents pass implicitly (light up as fallback worker)
4. **Read each agent file** - Extract the agent's purpose/role from the markdown to craft an appropriate test task
5. **Spawn parallel tasks** - Use the Task tool to spawn a verification task for EACH worker agent simultaneously. Every spawn uses `model: haiku` and a task description formatted as `<agent-id>: <keywords> check` (e.g. `coding-specialist: implement code fix check`) so the hook's explicit-name prefix attributes the spawn correctly; use `subagent_type: "Explore"` for a read-only agent and `subagent_type: "general-purpose"` otherwise
6. **Wait for completion** - All agents should complete their simple verification task
7. **Report results** - Confirm which agents responded successfully

## Important Notes

- **Coordinator roles pass implicitly** - Agents marked as orchestrators/coordinators light up on user prompts (tested by running the ready test itself)
- **Fallback agents pass implicitly** - The fallback worker (e.g. primary-agent) lights up when no specialist matches
- **All tasks must run in parallel** - This tests the visualization showing multiple agents active simultaneously; the ready test intentionally exceeds the configured sonnet parallel-agent limit as a visualization stress test — this is by design
- **Every verification spawn uses `model: haiku`** - regardless of the agent's configured model, since this test only proves spawning, routing, and visualization, not model quality; pair it with `subagent_type: "Explore"` for a read-only agent and `subagent_type: "general-purpose"` for any agent that would write
- **Task description format** - `<agent-id>: <keywords> check` (e.g. `search-retrieval: search find grep check`), so the hook's explicit-name prefix attributes the spawn to the right agent
- **Use exact keywords** - Include each agent's trigger keywords in the task description to ensure correct routing
- **Dynamic discovery** - Always scan the agents directory; do not use a hardcoded roster — agents vary per workspace
- **Team leads are excluded** - Any agent with `tier: lead` in its frontmatter (e.g. `build-lead`, `quality-lead`) is skipped entirely — it is not spawned and does not count toward pass/fail totals, since it coordinates its own workers rather than being a leaf worker itself
- **Craft tasks from agent definitions** - Read each agent's `.md` file to understand its role and create an appropriate test task

## Example Execution

```
1. Scan .claude/agents/*.md to discover all agent files
2. Read each agent file to understand its role
3. Note coordinator and fallback agents pass implicitly (they light up via other mechanisms)
4. Spawn parallel Task tool calls with tasks tailored to each specialist agent's role
5. Wait for all to complete
6. Report results using the format below (all agents count toward pass/fail totals)
```

## Report Format

Report ALL agents discovered:

```
**Ready test complete. X/Y agents responded successfully.**

| Agent | Status | Response |
|-------|--------|----------|
| orchestrator | ✅ pass | Lights up on user prompts (implicit test) |
| primary-agent | ✅ pass | Lights up as fallback worker |
| [specialist-1] | ✅ pass or ❌ fail | [response summary] |
| [specialist-2] | ✅ pass or ❌ fail | [response summary] |
| ... | ... | ... |

**Summary:** N agents total, X passed, Y failed.
```

- List every agent discovered from the agents directory
- Coordinator and fallback agents count as passed (they light up via implicit mechanisms)
- Show pass/fail for each specialist agent
- Calculate totals dynamically from discovered agents

## Troubleshooting

If an agent fails to appear in the visualization:
- Check that the task description contains the correct trigger keywords
- Verify the hooks in the repo-root `hooks/` directory are properly configured
- Ensure the TycoonAgents extension is running and the webview is visible
