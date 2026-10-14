---
name: update-pricing
description: >
  Refresh the metrics panel's per-model token cost table from Anthropic's and
  OpenAI's live published API pricing. Use when the user says "update pricing",
  "refresh pricing", runs /update-pricing, or asks to pull the latest Claude or
  OpenAI token rates into the cost estimate.
---

# Update Pricing

Refresh `PRICE_TABLE` in `media/src/main/080-packs-events.js` (`MODEL_PRICE_PER_MTOK`
is derived from it; `media/main.js` is generated, never edit it) from Anthropic's
and OpenAI's current published API token rates. This table drives only the panel's relative
"N× cheaper" badges (e.g. per-agent "vs. orch." and the Delegation tab's
ratio line) — no dollar amount is ever rendered in the Metrics or Delegation
tabs, so the blended $/million-tokens number per model family exists purely
as an internal comparison unit, computed as a **3:1 input:output blend**:
`(3*input + output) / 4`.

Multipliers are SAME-VENDOR only: Anthropic-vs-Anthropic and OpenAI-vs-OpenAI.
Foreign-vendor rows show billing-type labels (Sub / API / Local), never a
multiplier, and no dollar amount is ever displayed. Do not change that rule
while refreshing rates.

Follow these steps exactly.

## 1. Fetch the live rates
WebFetch the Claude API pricing; try in order until you get the per-model
input/output $/MTok table:
1. `https://claude.com/pricing#api` — the user's canonical source (API-rates anchor).
2. `https://platform.claude.com/docs/en/about-claude/pricing` — authoritative docs
   mirror with a clean "Model pricing" table; use this if the first doesn't
   surface the token table.
Ask for each model's **Base Input Tokens** $/MTok and **Output Tokens** $/MTok.

Second source, OpenAI: WebFetch `https://developers.openai.com/api/docs/pricing`
and ask for the **standard** (not batch, cached, priority or flex) input and
output $/MTok of the `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna` families.

## 2. Pick the rate per family
Use the **latest, non-deprecated, non-retired** model per family:
- **opus** → newest `Claude Opus 4.x` not marked deprecated/retired.
- **sonnet** → newest `Claude Sonnet`; if a dated introductory-vs-standard split
  is shown, use the rate **in effect today** and note the upcoming change.
- **haiku** → newest `Claude Haiku`. Haiku has tiered pricing: use the
  "up to 100k tokens" tier (note the over-100k rate in the JSDoc).
- **fable** → `Claude Fable 5` (or its successor).
Use the standard Base Input + Output columns — ignore Batch / Fast-mode / cache columns.
OpenAI rows (`openai/<id>`): per tier, the newest non-deprecated model in each
family — **astra** (Opus-tier), **sol** (Sonnet-tier), **luna** (Haiku-tier);
use the standard short-context rate. If a model isn't listed, leave its row
unchanged and flag it.

## 3. Compute the blended values
Per family (Anthropic and OpenAI alike): `blended = round((3*input + output) / 4)` (whole dollars; one decimal
only if < 1). Example with mid-2026 rates: opus $5/$25 -> 10; sonnet $2/$10 -> 4;
haiku $1/$5 -> 2; fable $10/$50 -> 20. Keep sub-dollar blends precise
(e.g. $0.10/$0.50 -> 0.2). `weight` tracks the tier (opus 12, sonnet 3, haiku
0.08, fable 30; OpenAI astra 30, sol 3, luna 0.08).

## 4. Update the code
In `media/src/main/080-packs-events.js`:
- Update the `anthropic/*` and `openai/*` rows of `PRICE_TABLE` (alias rows and
  exact-id rows; keep older exact-id rows so history keeps its rate).
  `MODEL_PRICE_PER_MTOK` derives from the alias rows automatically.
- Update the JSDoc above `PRICE_TABLE`: refresh each `$<in> in / $<out> out -> (3*in+out)/4 = $<blend>`
  line, the model versions referenced, any dated-rate note, and the
  `(rates confirmed ~YYYY-MM)` stamp to today's month.

## 5. Verify + report
- Run `npm run build:webview`, then `node --check media/main.js` and
  `npm run check:webview` — all must pass. Run `test/pricing.test.ts` and
  `test/vsOrchRawRateBadge.test.ts`; fix tests that hard-code old ratios.
- Report a table of OLD -> NEW blended values per family and the source rates used.
- If any family's rate can't be found, DO NOT guess — leave it unchanged and flag it.

## 6. Ship
Show the OLD->NEW diff, then release from repo root:
`npm run release -- patch "chore(metrics): refresh PRICE_TABLE from live Anthropic/OpenAI API rates (<summary>)"`
Webview-only (no BRIDGE_VERSION bump, no UEFN copy). This project always pushes to main.
