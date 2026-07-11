# Improvement: the delegation tip / keyword-routing panel should be roster- and data-driven

## Context
The "Copy delegation tip" button and the KEYWORD ROUTING panel currently emit a
generic, hardcoded string. Observed output on a project whose roster has 7
agents (orchestrator + search-retrieval, coding-specialist, ui-page-builder,
integration-specialist, primary-agent, reviewer):

> "Delegate all searches and file reads to sub-agents per CLAUDE.md -
>  search-retrieval for lookups, coding-specialist for edits."

Meanwhile the same panel's DELEGATION HEALTH section showed:
- Low delegation · 0%
- Orchestrator delegated 0 tasks; did 0 searches and 1 edit directly.
- Delegations: 0
- Direct searches (Grep/Glob): 0 — delegate to search-retrieval
- Direct edits: 1 — delegate to coding-specialist
- Direct file reads: 5 — **allowed for known files**

## Problems

### 1. The tip contradicts the panel's own data
The tip says "delegate all searches **and file reads**," but the health line
says "Direct file reads: 5 — **allowed for known files**." CLAUDE.md explicitly
permits reading a known file path directly. The tip tells the user to delegate
the one category the panel itself labels as allowed. Over-delegating reads is
wasteful and contradicts the doctrine.

### 2. The tip is mis-targeted vs the actual counters
Health data: 0 direct searches, 5 allowed reads, **1 direct edit**. The only
real leak was the single edit — yet the tip emphasized "searches and file reads"
(the two categories that were 0 / allowed) and buried the edit. A useful tip
names only the categories that actually leaked this session.

### 3. The tip names 2 of 6 specialists
It cited only search-retrieval + coding-specialist and omitted the agents most
relevant to this project (a Next.js web client mid-monetization): 
integration-specialist (RevenueCat/payments/ads) and ui-page-builder (pages/
components), plus reviewer (the review gate) and primary-agent (fallback).

### 4. It's static, not generated from state the panel already has
- KEYWORD ROUTING shows `kw1|kw2|kw3` placeholders for 5 of 6 agents and
  "Routing health: not enough data" — only `reviewer` has real keywords. So the
  router literally cannot route by keyword, and silently falls back to the
  2-agent string.
- The panel already knows the installed roster (it lists every agent) and the
  live leak counters. The tip should be composed from those, not hardcoded.

## What it should output (data-driven; example for the session above)

    Low delegation (0%). This session: 1 edit made directly; 5 reads (fine —
    known files allowed); 0 direct searches.
    -> Your 1 direct edit should have gone to coding-specialist.
       Nothing to fix on searches/reads.

    Route by task type:
    - Grep/Glob & lookups          -> search-retrieval (Haiku, ~40x cheaper)
    - edits / fixes / refactors    -> coding-specialist
    - RevenueCat / payments / ads  -> integration-specialist
    - Next.js pages / components   -> ui-page-builder
    - verify each change before done -> reviewer
    - unmatched                    -> primary-agent
    Keep direct: known-file reads, coordination, talking to the user.

## Implementation suggestions
1. **Generate the tip from live counters + installed roster.**
   - List only the leak categories with count > 0 (skip "searches" when 0, skip
     "reads" always unless a policy explicitly forbids known-file reads).
   - Enumerate every installed agent with a one-line "route this here" hint built
     from its role/keywords, not a fixed 2-agent list.
2. **Never instruct delegating known-file reads** — mirror the doctrine the panel
   already states ("allowed for known files").
3. **Surface unconfigured routing** instead of silently defaulting: e.g.
   "5 of 6 agents have no routing keywords set — routing health is unreliable
   until you Save keywords." Optionally auto-suggest keywords parsed from each
   agent's frontmatter.
4. **Seed KEYWORD ROUTING from the agent files.** Each `.claude/agents/*.md`
   already carries keywords; pre-fill the inputs from them rather than showing
   `kw1|kw2|kw3` placeholders.

## Roster reference (this project — for building the generated tip/keywords)
- search-retrieval (haiku) — search, find, look, where, locate, explore, grep,
  glob, lookup, file, pattern, reference, documentation
- coding-specialist (sonnet) — implement, code, fix, bug, refactor, create, add,
  update, modify, write, function, class, module, feature
- ui-page-builder (sonnet) — page, component, ui, layout, screen, render, view,
  tailwind, dark-mode, card, grid
- integration-specialist (sonnet) — integration, sdk, revenuecat, payments,
  google-ads, adsense, webhook, billing, paywall, subscription
- reviewer (sonnet) — review, verify, approve, correctness, quality, regression
- primary-agent (sonnet) — general, handle, task, fallback, default, misc,
  various, mixed, other, remaining
- orchestrator — coordinator; delegates, does not implement directly
