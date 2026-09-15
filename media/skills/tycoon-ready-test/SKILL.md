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
5. **Spawn parallel tasks** - Use the Task tool to spawn a verification task for EACH worker agent simultaneously. Every spawn uses `model: haiku` and a task description formatted as `<agent-id>: <keywords> check` (e.g. `coding-specialist: implement code fix check`) so the hook's explicit-name prefix attributes the spawn correctly; use `subagent_type: "Explore"` for a read-only agent and `subagent_type: "general-purpose"` otherwise. This intentionally exceeds the configured sonnet parallel-agent limit as a visualization stress test — by design.
6. **Wait for completion** - All agents should complete their simple verification task
7. **Report results** - Confirm which agents responded successfully

## Important Notes

See **Procedure** above for the full workflow (discovery, exclusions, spawning, and reporting rules).

## Example Execution

See **Procedure** above — the steps there are the execution sequence.

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
