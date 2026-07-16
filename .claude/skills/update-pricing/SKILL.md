---
name: update-pricing
description: >
  Refresh the metrics panel's per-model token cost table from Anthropic's live
  published API pricing. Use when the user says "update pricing", "refresh
  pricing", runs /update-pricing, or asks to pull the latest Claude token rates
  into the cost estimate.
---

# Update Pricing

Refresh `MODEL_PRICE_PER_MTOK` in `media/main.js` from Anthropic's current
published API token rates. The metrics panel shows a rough per-agent cost
"lens" using a single BLENDED $/million-tokens number per model family (we only
track TOTAL tokens — no input/output/cache split), computed as a **3:1
input:output blend**: `(3*input + output) / 4`.

Follow these steps exactly.

## 1. Fetch the live rates
WebFetch the Claude API pricing; try in order until you get the per-model
input/output $/MTok table:
1. `https://claude.com/pricing#api` — the user's canonical source (API-rates anchor).
2. `https://platform.claude.com/docs/en/about-claude/pricing` — authoritative docs
   mirror with a clean "Model pricing" table; use this if the first doesn't
   surface the token table.
Ask for each model's **Base Input Tokens** $/MTok and **Output Tokens** $/MTok.

## 2. Pick the rate per family
Use the **latest, non-deprecated, non-retired** model per family:
- **opus** → newest `Claude Opus 4.x` not marked deprecated/retired.
- **sonnet** → newest `Claude Sonnet`; if a dated introductory-vs-standard split
  is shown, use the rate **in effect today** and note the upcoming change.
- **haiku** → newest `Claude Haiku`.
- **fable** → `Claude Fable 5` (or its successor).
Use the standard Base Input + Output columns — ignore Batch / Fast-mode / cache columns.

## 3. Compute the blended values
Per family: `blended = round((3*input + output) / 4)` (whole dollars; one decimal
only if < 1). Example with mid-2026 rates: opus $5/$25 -> 10; sonnet $2/$10 -> 4;
haiku $1/$5 -> 2; fable $10/$50 -> 20.

## 4. Update the code
In `media/main.js`:
- Set `const MODEL_PRICE_PER_MTOK = { opus: <n>, sonnet: <n>, haiku: <n>, fable: <n> };`.
- Update the JSDoc above it: refresh each `$<in> in / $<out> out -> (3*in+out)/4 = $<blend>`
  line, the model versions referenced, any dated-rate note, and the
  `(rates confirmed ~YYYY-MM)` stamp to today's month.

## 5. Verify + report
- Run `node --check media/main.js` and `npm run check:webview` — both must pass.
- Report a table of OLD -> NEW blended values per family and the source rates used.
- If any family's rate can't be found, DO NOT guess — leave it unchanged and flag it.

## 6. Ship
Show the OLD->NEW diff, then release from repo root:
`npm run release -- patch "chore(metrics): refresh MODEL_PRICE_PER_MTOK from live Anthropic API rates (<summary>)"`
Webview-only (no BRIDGE_VERSION bump, no UEFN copy). This project always pushes to main.
