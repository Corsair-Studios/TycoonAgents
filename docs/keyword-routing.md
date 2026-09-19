# Keyword routing

When the orchestrator spawns a subagent via the Task tool, the
`tycoon-claude-hook.cjs` hook decides which agent in the visualization the
spawn is attributed to. For a Task call it does this by scoring the Task's
`description` and `prompt` text against each agent's keyword pattern in
`.claude/tycoon/agent-keywords.json`. This page explains the rules an agent
author needs to know to make routing actually match their agent.

## The description is tokenized, and weighted above the prompt

The hook lowercases the Task's `description` and `prompt`, strips everything
that isn't a letter or digit down to whitespace, and splits on whitespace
into a set of single words (`wordSetOf` in `hooks/tycoon-claude-hook.cjs`).
Each agent's keyword pattern is checked against both word sets, but a match
in the description is worth 1000x a match in the prompt
(`DESCRIPTION_WEIGHT = 1000`, `matchAgentFromKeywords`). In practice this
means a prompt body that happens to mention another agent's keyword cannot
outscore a description that actually names the right domain — prompt matches
only break ties between descriptions that score equally (including zero).

The practical consequence: **the trigger word has to be in the Task
description**, not buried only in the prompt. A description like "Fix the
login bug" routes on `fix`, `login`, and `bug`; a description like "Handle
this" with the real detail only in the prompt will not reliably route to the
right specialist.

## A pattern is single tokens joined by `|`

Each entry in `agent-keywords.json` looks like:

```json
{ "agents": { "coding-specialist": { "pattern": "implement|code|fix|bug|refactor" } } }
```

The pattern is split on `|` into segments, each lowercased and trimmed, and
compared for exact membership against the description/prompt word sets.
Because the split happens on `|` only, a segment that itself contains a
space — e.g. `"cross vendor"` — is never split further. It can never match a
single tokenized word, so it can never fire. Only single-word segments
(`vendor`, `cross-vendor` with a hyphen, `codex`, `implement`) are valid
routing tokens.

## Ties resolve by object order

`matchAgentFromKeywords` iterates `Object.entries(keywordsConfig.agents)` and
only replaces the current best match when a later agent scores strictly
higher (`score > bestScore`). On a tie, whichever agent appears earlier in
`agent-keywords.json` keeps the match. This is why every specialist must be
listed **before** the Wildcard Agent (`primary-agent`, id `primary-agent`)
in the config: if the wildcard were listed first, any specialist that ties
its score would lose the match to the wildcard instead of winning it.

## The Keyword health card

The Agents screen's Keyword health card runs `computeKeywordHealth` (in
`src/core/keywordHealth.ts`) against the current roster and
`agent-keywords.json`, and can flag:

- `no_keywords` — an agent has no pattern and no body/default fallback to
  seed one, so it can never be routed to by keyword.
- `dangling_ref` — `agent-keywords.json` has an entry for an agent id with
  no matching `.claude/agents/<id>.md` file.
- `pending_reconcile` — an agent file exists but has no
  `agent-keywords.json` entry yet; the next reconcile will seed one.
- `multi_word_segment` — a pattern segment contains whitespace (a space
  where `|` was meant), so it can never match a single tokenized word.
- `prose_pattern` — a segment (or whole pattern) reads as prose: more than
  3 words, or over 200 characters.
- `duplicate_keyword` — the same token appears in more than one agent's
  pattern; the earlier-listed agent wins the tie per the ordering rule
  above.
- `wildcard_first` — `primary-agent` is listed before a specialist agent in
  `agent-keywords.json`, so it could steal ties it shouldn't win.

**Fix all** runs `normalizeAgentKeywords`, which: reconciles dangling refs
and missing entries, seeds empty patterns from an agent's body keywords or
the built-in defaults, splits multi-word segments into individual tokens,
drops prose segments and prose-length patterns entirely, dedupes tokens
(keeping the first occurrence), and moves `primary-agent` to the end of the
config so it never precedes a specialist. It is idempotent — running it
again on its own output makes no further changes.

## Wildcard fall-through and unmatched-word chips

The health view also surfaces `computeWildcardStats`: how many Task spawns
this session landed on `primary-agent` via keyword scoring
(`routingMethod === "keyword"`), and the most frequent description/prompt
words from those fall-through spawns that don't already appear in any
agent's pattern. Those unmatched-word chips are a direct signal for which
keyword to add to a specialist's pattern so the next similar Task routes
correctly instead of falling through to the wildcard.
