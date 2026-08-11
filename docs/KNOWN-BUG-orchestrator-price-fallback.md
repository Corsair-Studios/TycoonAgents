# Known Bug: `resolveOrchestratorPrice` silently falls back to Opus pricing

When no orchestrator metrics entry exists, or its model is unknown/unpriced,
`resolveOrchestratorPrice` returns Opus's $/Mtok rate instead of signaling
"unknown" — silently inflating every "Nx cheaper" figure derived from it.

## Location (current, verified 2026-08-11)

- `resolveOrchestratorPrice(metrics)` — `media/main.js:13215-13219`
- `MODEL_PRICE_PER_MTOK` — `media/main.js:13141`
  `const MODEL_PRICE_PER_MTOK = { opus: 10, sonnet: 4, haiku: 2, fable: 20 };`

## The offending line

```js
// media/main.js:13218
return price != null ? price : MODEL_PRICE_PER_MTOK.opus;
```

The function's own docstring (`media/main.js:13208-13214`) already documents
this as intentional: *"falling back to opus (10) when no orchestrator entry
is found or its model is unpriced."* That's the bug — a fallback dressed up
as a spec.

## Impact

Every dimensionless cost ratio computed from this price is wrong whenever
the real orchestrator model is Sonnet or Haiku: the panel divides by 10
(Opus) instead of 4 (Sonnet) or 2 (Haiku), so "Nx cheaper" reads lower than
reality, and the delegation-hero "% saved" headline understates savings.
This directly violates the project's standing rule that the metrics panel
must never fabricate a model id — here it's fabricating the *price* tied to
one.

Call sites, all consuming the fallback-tainted price:

1. `media/main.js:13527` — per-agent metrics table, `orchestratorPrice` used to size the "vs. orch." column.
2. `media/main.js:13629` — delegation-stats hero savings headline (`% saved` / counterfactual cost calc).
3. `media/main.js:15121` — per-agent stat chip's "vs. orch." ratio (`Nx cheaper` / `Nx pricier` / `same cost`).

## What is NOT affected

The orchestrator-model **display** shipped for feedback issues #24/#25
(commit `9d888fa`) is fine and unrelated. It reads the observed model via
the pre-existing `modelFamily()` helper and renders an honest "Unknown yet"
when nothing has been observed — it does not call `resolveOrchestratorPrice`
or touch `MODEL_PRICE_PER_MTOK` at all. Only the price/ratio math described
above is wrong; do not "fix" the display or assume it shares this bug.

## Fix options (undecided — maintainer to choose)

Removing the fallback outright isn't free: every call site divides by this
price to produce a ratio, so an unknown price becomes `NaN` or a
divide-by-zero, not just a missing number. Options:

- Suppress the ratio entirely when the orchestrator model is unknown —
  render "—" or hide the "vs. orch." stat / hero headline for that state.
- Propagate the uncertainty explicitly (e.g. return `null` from
  `resolveOrchestratorPrice` and have each of the three call sites branch
  on it) rather than assuming the most expensive model by default.

## Provenance

Found during feedback triage on 2026-08-11. Not yet filed upstream.
