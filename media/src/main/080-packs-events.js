// Part: 80-packs-events
// Pack install/remove event handlers.
  function handlePackRemoved(id, ok, _results, error, cancelled) {
    if (!packsListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      packsListEl.querySelector(`[data-remove-pack-id="${CSS.escape(id)}"]`)
    );
    if (cancelled) {
      if (btn) {
        btn.textContent = "Remove";
        btn.removeAttribute("disabled");
      }
      return;
    }
    if (ok) {
      // Re-fetch so chips/buttons reflect real per-part removal results.
      vscode.postMessage({ type: "getPacks" });
    } else if (btn) {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
      }
    }
  }

  // ── Metrics panel ───────────────────────────────────────────────

  /**
   * Format a token count compactly.
   * < 1000      → "450"
   * 1k–999k     → "1.2k", "2.1k"  (trailing ".0" trimmed)
   * >= 1 000 000 → "1.5M"          (trailing ".0" trimmed)
   * @param {number} n
   * @returns {string}
   */
  function fmtTokens(n) {
    if (!n || n < 1000) return String(n ?? 0);
    if (n < 1_000_000) {
      const val = (n / 1000).toFixed(1).replace(/\.0$/, "");
      return `${val}k`;
    }
    const val = (n / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${val}M`;
  }

  /**
   * Format milliseconds as "Xm Ys".
   * @param {number} ms
   * @returns {string}
   */
  function fmtMs(ms) {
    if (!ms || ms < 0) return "0m 0s";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }

  /**
   * Format a tokens-per-second rate as "3.4 tok/s" (one decimal below 10,
   * whole numbers at/above 10) or "0 tok/s" for a non-positive/zero rate.
   * @param {number} tokensPerSec
   * @returns {string}
   */
  function fmtTokensPerSec(tokensPerSec) {
    const v = Number(tokensPerSec) || 0;
    if (v <= 0) return "0 tok/s";
    const val = v < 10 ? v.toFixed(1) : String(Math.round(v));
    return `${val} tok/s`;
  }

  /**
   * Blended $ per MILLION tokens and relative cost WEIGHT, keyed by
   * "provider/family" or "provider/<exact model id>". Anthropic rows are
   * derived from Anthropic's published API token rates using a 3:1
   * input:output blend (agentic work is input-heavy), i.e.
   * (3*input + output) / 4.
   *
   * The bare-alias rows (anthropic/opus|sonnet|haiku|fable) price the model
   * each alias resolves to TODAY, so an agent on `model: sonnet` is always
   * priced as the newest Sonnet. Exact-id rows (anthropic/claude-...) pin
   * the rate of that specific model and win over the alias row; older
   * exact-id rows are kept so historical metrics keep their original rate.
   * Alias rows, current as of 2026-10:
   *   opus    $4 in / $20 out  -> (3*4  + 20)/4 = $8    [Opus 5.5; older opus-4-x rows keep $5/$25 -> $10]
   *   sonnet  $2 in / $10 out  -> (3*2  + 10)/4 = $4    [Sonnet 5.5]
   *   haiku   $0.10 in / $0.50 out -> (3*0.1 + 0.5)/4 = $0.2   [Haiku 5.5, prompts up to 100k tokens; over 100k it is $0.50/$2.50 -> $1]
   *   fable   $10 in / $50 out -> (3*10 + 50)/4 = $20   [Fable 5.1]
   * Only TOTAL tokens are tracked per agent (no input/output/cache split), so
   * treat this as a rough estimate — RATIOS between models matter more than
   * absolute accuracy. These are API rates and do NOT reflect Claude
   * subscription (Max/Pro) billing. Run the /update-pricing skill to refresh
   * Anthropic rates from live prices. (rates confirmed ~2026-10)
   *
   * OpenAI rows (gpt-6-astra/gpt-6.1-sol/gpt-6.1-terra/gpt-6-luna, ~2026-10) use the same 3:1
   *   blend on OpenAI's published standard rates: astra $10/$50 -> 20, sol
   *   $2/$10 -> 4, terra $1/$5 -> 2, luna $0.10/$0.50 -> 0.2.
   *
   * PLACEHOLDERS — every other non-anthropic/non-gpt-6 row below is a rough seed, not a
   * verified published rate. Refresh via the update-pricing skill before
   * relying on these for anything but relative ordering.
   *
   * `weight` is a relative-cost figure used by savingsPct-style comparisons
   * (unitless, NOT a dollar figure); it need not track perMtok 1:1.
   * @type {Record<string, {perMtok:number, weight:number}>}
   */
  const PRICE_TABLE = {
    "anthropic/opus": { perMtok: 8, weight: 12 },
    "anthropic/sonnet": { perMtok: 4, weight: 3 },
    "anthropic/haiku": { perMtok: 0.2, weight: 0.08 },
    "anthropic/fable": { perMtok: 20, weight: 30 },
    // Exact current model ids (Claude docs models overview, 2026-10); these
    // win over the alias rows above. Refresh via the update-pricing skill.
    "anthropic/claude-fable-5-1": { perMtok: 20, weight: 30 }, // $10 in / $50 out
    "anthropic/claude-opus-5-5": { perMtok: 8, weight: 12 }, // $4 in / $20 out -> (12+20)/4
    // Historical Opus rows ($5 in / $25 out -> 10) so recorded metrics keep their real price.
    "anthropic/claude-opus-4-6": { perMtok: 10, weight: 15 },
    "anthropic/claude-opus-4-5": { perMtok: 10, weight: 15 },
    "anthropic/claude-opus-4": { perMtok: 30, weight: 45 }, // $15 in / $75 out -> (45+75)/4
    "anthropic/claude-opus-4-1": { perMtok: 30, weight: 45 },
    "anthropic/claude-opus-4-7": { perMtok: 10, weight: 15 },
    "anthropic/claude-opus-4-8": { perMtok: 10, weight: 15 },
    "anthropic/claude-opus-5": { perMtok: 10, weight: 15 },
    "anthropic/claude-sonnet-5": { perMtok: 4, weight: 3 }, // $2 in / $10 out, same as sonnet-5-5
    "anthropic/claude-sonnet-5-5": { perMtok: 4, weight: 3 }, // $2 in / $10 out
    "anthropic/claude-haiku-5-5": { perMtok: 0.2, weight: 0.08 }, // $0.10 in / $0.50 out (prompts <=100k)
    "anthropic/claude-haiku-4-5": { perMtok: 2, weight: 0.8 }, // $1 in / $5 out
    // placeholders — refresh via the update-pricing skill
    "openai/gpt-5": { perMtok: 8, weight: 12 },
    "openai/gpt-5.4-mini": { perMtok: 1.5, weight: 1 },
    // OpenAI GPT-6 lineup, standard short-context rates from
    // https://developers.openai.com/api/docs/pricing (confirmed ~2026-10), 3:1 blend.
    // Used for OpenAI-vs-OpenAI comparisons only; never against another vendor.
    "openai/gpt-6.1-sol": { perMtok: 4, weight: 3 }, // $2 in / $10 out -> (6+10)/4 (Sonnet-tier)
    "openai/gpt-6-astra": { perMtok: 20, weight: 30 }, // $10 in / $50 out -> (30+50)/4 (Opus-tier)
    "openai/gpt-6.1-terra": { perMtok: 2, weight: 1.5 }, // $1 in / $5 out -> (3+5)/4 (between Sol and Luna)
    "openai/gpt-6-luna": { perMtok: 0.2, weight: 0.08 }, // $0.10 in / $0.50 out -> (0.3+0.5)/4 (Haiku-tier)
    // Gemini 4 Argon standard rate after the introductory period (intro $2/$10 ends 2026-11-30),
    // https://ai.google.dev/gemini-api/docs/pricing (confirmed ~2026-10): $4 in / $20 out -> (12+20)/4.
    "google/gemini-4-argon": { perMtok: 8, weight: 12 },
    "google/gemini-2.5-pro": { perMtok: 6, weight: 8 },
    "google/gemini-2.5-flash": { perMtok: 1, weight: 0.6 },
    "moonshot/kimi-k2": { perMtok: 2, weight: 1.5 },
    "moonshot/kimi-k2.6": { perMtok: 2, weight: 1.5 },
    "alibaba/qwen3": { perMtok: 1.5, weight: 1 },
    // xAI Grok, via OpenCode's built-in xai provider (no native Claude/Codex
    // host) — source https://docs.x.ai/developers/models, fetched 2026-09-23,
    // <200k-token pricing tier. grok-4.7 (flagship reasoning): $2 in / $6 out
    // -> blended (3*2+6)/4 = 3. grok-build-0.1 (cheap/fast): $1 in / $2 out
    // -> blended (3*1+2)/4 = 1.25. Refresh via the update-pricing skill.
    "xai/grok-4.7": { perMtok: 3, weight: 4 },
    "xai/grok-build-0.1": { perMtok: 1.25, weight: 1 },
  };

  /** Legacy alias, kept for any external readers: opus/sonnet/haiku/fable -> perMtok only. */
  const MODEL_PRICE_PER_MTOK = {
    opus: PRICE_TABLE["anthropic/opus"].perMtok,
    sonnet: PRICE_TABLE["anthropic/sonnet"].perMtok,
    haiku: PRICE_TABLE["anthropic/haiku"].perMtok,
    fable: PRICE_TABLE["anthropic/fable"].perMtok,
  };

  /** Relative cost weight applied to a "subscription" cost-class model (flat-rate quota, no marginal $/token). */
  const SUBSCRIPTION_WEIGHT = 1;

  /** Fallback key for a model that resolves to none of the known providers/families — priced non-zero so it's never silently treated as free. */
  const DEFAULT_PRICE_KEY = "unknown/metered";
  if (!PRICE_TABLE[DEFAULT_PRICE_KEY]) {
    PRICE_TABLE[DEFAULT_PRICE_KEY] = { perMtok: 3, weight: 3 };
  }

  const LEGACY_CLAUDE_MODEL_ID_RE = /^claude-(opus|sonnet|haiku|fable)(-\d+)+$/i;

  /**
   * Longest exact-id PRICE_TABLE row ("anthropic/claude-...") that `modelId`
   * equals or extends with a dated suffix (e.g. "claude-haiku-4-5-20251001"
   * -> "anthropic/claude-haiku-4-5"), or null when only a family row applies.
   * @param {string} modelId lower-cased, without the "anthropic/" prefix
   * @returns {string|null}
   */
  function exactAnthropicKey(modelId) {
    let best = null;
    for (const key of Object.keys(PRICE_TABLE)) {
      if (!key.startsWith("anthropic/claude-")) continue;
      const suffix = key.slice("anthropic/".length);
      if ((modelId === suffix || modelId.startsWith(`${suffix}-`)) && (!best || suffix.length > best.length)) {
        best = suffix;
      }
    }
    return best ? `anthropic/${best}` : null;
  }

  /**
   * Resolve a model id/alias/vendor-qualified string (plus optional
   * costModelClass) to a PRICE_TABLE key. Never throws, never returns a
   * missing key.
   *   - legacy `claude-<family>[-N...]` ids, bare family aliases
   *     ("sonnet"), and `anthropic/claude-<family>...` / `anthropic/<family>`
   *     forms all resolve to `anthropic/<family>`.
   *   - an exact `provider/model` PRICE_TABLE hit resolves to itself.
   *   - a `provider/model` with a family-prefix match (e.g.
   *     "openai/gpt-5.4-mini-2026") resolves to the longest matching
   *     PRICE_TABLE key under that provider.
   *   - anything else resolves to DEFAULT_PRICE_KEY.
   * `costModelClass` does not change which key is returned — it only tells
   * callers (see costModelClass() call sites) whether to display a
   * relative-cost comparison at all versus "quota"/"local".
   * @param {string|null|undefined} modelId
   * @param {string|null|undefined} [costModelClassHint]
   * @returns {string}
   */
  function resolvePriceKey(modelId, costModelClassHint) {
    const id = String(modelId || "").trim().toLowerCase();
    if (!id) return DEFAULT_PRICE_KEY;

    // Legacy bare Claude ids: "claude-sonnet-4-6", or a bare alias like "sonnet".
    if (LEGACY_CLAUDE_MODEL_ID_RE.test(id)) {
      const exact = exactAnthropicKey(id);
      if (exact) return exact;
      const m = /^claude-(opus|sonnet|haiku|fable)/i.exec(id);
      return `anthropic/${m[1].toLowerCase()}`;
    }
    const bareFamily = /^(opus|sonnet|haiku|fable)$/i.exec(id);
    if (bareFamily) return `anthropic/${bareFamily[1].toLowerCase()}`;

    if (id.indexOf("/") >= 0) {
      const [provider, ...rest] = id.split("/");
      const modelPart = rest.join("/");

      if (provider === "anthropic") {
        const exact = exactAnthropicKey(modelPart);
        if (exact) return exact;
        const famMatch = /(opus|sonnet|haiku|fable)/i.exec(modelPart);
        if (famMatch) return `anthropic/${famMatch[1].toLowerCase()}`;
      }

      const fullKey = `${provider}/${modelPart}`;
      if (PRICE_TABLE[fullKey]) return fullKey;

      // Longest-matching family-prefix key under this provider, e.g.
      // "openai/gpt-5.4-mini-2026" -> "openai/gpt-5.4-mini" over "openai/gpt-5".
      let best = null;
      for (const key of Object.keys(PRICE_TABLE)) {
        if (!key.startsWith(`${provider}/`)) continue;
        const suffix = key.slice(provider.length + 1);
        if (modelPart.indexOf(suffix) === 0 && (!best || suffix.length > best.length)) {
          best = suffix;
        }
      }
      if (best) return `${provider}/${best}`;
    }

    if (costModelClassHint === "local") return DEFAULT_PRICE_KEY;
    return DEFAULT_PRICE_KEY;
  }

  /**
   * Blended $/million-token price for a model id/family string, or null when
   * the model's cost class means no marginal per-token dollar figure applies
   * (subscription/local) — callers render "quota"/"local" for those rather
   * than a fabricated price. Metered models (Anthropic families, the seeded
   * provider/model rows, and the unknown-fallback) always resolve to a
   * non-zero number via resolvePriceKey + PRICE_TABLE.
   * @param {string|null|undefined} model
   * @returns {number|null}
   */
  function modelPricePerMtok(model, explicitCostModelClass) {
    if (!model) return null;
    const cls = costModelClass(model, explicitCostModelClass);
    if (cls === "subscription" || cls === "local") return null;
    const key = resolvePriceKey(model, cls);
    const row = PRICE_TABLE[key] || PRICE_TABLE[DEFAULT_PRICE_KEY];
    return row.perMtok;
  }

  /**
   * Rough estimated $ cost for a total token count at a given model's blended
   * price. Returns null when the model is unknown or there are no tokens —
   * callers render "—" and exclude nulls from sums/rates rather than treating
   * them as $0.
   * @param {number|undefined} tokens
   * @param {string|null|undefined} model
   * @returns {number|null}
   */
  function estCostUSD(tokens, model, explicitCostModelClass) {
    const price = modelPricePerMtok(model, explicitCostModelClass);
    if (price == null || !(tokens > 0)) return null;
    return (tokens / 1e6) * price;
  }

  /**
   * Same as estCostUSD, but adds a cache-read component priced at ~0.1x the
   * model's input rate (cache reads are cheaper than a fresh billable token).
   * Returns null under the same conditions as estCostUSD when there are no
   * billable tokens to price from; a cache-read amount with no billable
   * tokens still returns null since the model's price can't be resolved
   * without at least one priced bucket present.
   * @param {number|undefined} tokens billable tokens (input + output + cache-creation)
   * @param {number|undefined} cacheReadTokens cache-read tokens, priced separately at 0.1x
   * @param {string|null|undefined} model
   * @returns {number|null}
   */
  function estCostUSDWithCache(tokens, cacheReadTokens, model, explicitCostModelClass) {
    const price = modelPricePerMtok(model, explicitCostModelClass);
    if (price == null) return null;
    const billable = tokens > 0 ? tokens : 0;
    const cacheRead = cacheReadTokens > 0 ? cacheReadTokens : 0;
    if (billable <= 0 && cacheRead <= 0) return null;
    return (billable / 1e6) * price + (cacheRead / 1e6) * price * 0.1;
  }

  /**
   * Format a dimensionless price ratio for the "×cheaper/×pricier" cost lens,
   * e.g. 5 -> "5", 2.5 -> "2.5". One decimal place, trimmed when it's a whole
   * number.
   * @param {number} r
   * @returns {string}
   */
  function fmtRatio(r) {
    const n = Math.round(r * 10) / 10;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  /**
   * Build an honest "where delegated work ran" ledger from raw agent-metrics
   * rows, split by cost currency (metered $/token, subscription quota,
   * local hardware) rather than collapsing everything into one fabricated
   * percent. Pure function — no DOM.
   *
   * @param {Array<{id?:string, vendor?:string, model?:string, costModelClass?:string, tokens?:number, cacheReadTokens?:number}>|undefined} rows delegated (non-orchestrator) agent metric rows
   * @param {Record<string, {perMtok:number, weight:number}>} pricing PRICE_TABLE
   * @param {number|null} orchestratorRate resolveOrchestratorPrice(lastMetrics) result
   * @returns {{
   *   metered: {usd:number, tokens:number, unknownModels:string[]},
   *   subscription: {tokens:number},
   *   local: {tokens:number},
   *   unknown: {tokens:number, rows:Array<Object>},
   *   counterfactualUsd: number|null,
   *   billedUsd: number,
   *   avoidedUsd: number|null,
   *   billableTokens: number
   * }}
   */
  function buildDelegationLedger(rows, pricing, orchestratorRate) {
    const table = pricing || PRICE_TABLE;
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];

    const metered = { usd: 0, tokens: 0, unknownModels: [] };
    const subscription = { tokens: 0 };
    const local = { tokens: 0 };
    // costModelClass()'s "unknown" outcome (no explicit costModelClass AND
    // no model string to infer a family from) is genuinely unclassifiable —
    // it must never be silently priced at DEFAULT_PRICE_KEY's rate as if it
    // were a metered vendor we just don't have a rate for. Kept out of
    // metered.usd/tokens and out of billableTokens (so it never leaks into
    // the counterfactual either).
    const unknown = { tokens: 0, rows: [] };
    let billableTokens = 0; // excludes cacheReadTokens (spec 3) and unknown-class rows

    for (const a of list) {
      const billable = a.tokens ?? 0;
      const cacheRead = a.cacheReadTokens ?? 0;
      const totalTokens = billable + cacheRead;
      const cls = costModelClass(a.model, a.costModelClass);

      if (cls === "subscription") {
        subscription.tokens += totalTokens;
        billableTokens += billable;
      } else if (cls === "local") {
        local.tokens += totalTokens;
        billableTokens += billable;
      } else if (cls === "unknown") {
        unknown.tokens += totalTokens;
        unknown.rows.push(a);
        // Deliberately NOT added to billableTokens: an unclassifiable row
        // must never inflate the counterfactual either.
      } else {
        // metered (explicit "metered", or a model string costModelClass()
        // could classify by family). Priced from the PASSED-IN `table`, not
        // the module's PRICE_TABLE global, so a caller (or a test) can
        // simulate a vendor/model with no published rate.
        metered.tokens += totalTokens;
        const key = resolvePriceKey(a.model, cls);
        const priceRow = table[key] || table[DEFAULT_PRICE_KEY];
        const price = priceRow ? priceRow.perMtok : null;
        if (price == null || (billable <= 0 && cacheRead <= 0)) {
          if (price == null) {
            const label = a.model || a.vendor || "unknown model";
            if (metered.unknownModels.indexOf(label) === -1) metered.unknownModels.push(label);
          }
        } else {
          const billableAmt = billable > 0 ? billable : 0;
          const cacheAmt = cacheRead > 0 ? cacheRead : 0;
          metered.usd += (billableAmt / 1e6) * price + (cacheAmt / 1e6) * price * 0.1;
        }
        billableTokens += billable;
      }
    }

    const billedUsd = metered.usd;
    let counterfactualUsd = null;
    let avoidedUsd = null;
    if (orchestratorRate != null) {
      counterfactualUsd = (billableTokens / 1e6) * orchestratorRate;
      avoidedUsd = Math.max(0, counterfactualUsd - billedUsd);
    }

    const savings = buildSavingsEligibility(list, table, orchestratorRate);

    return {
      metered,
      subscription,
      local,
      unknown,
      counterfactualUsd,
      billedUsd,
      avoidedUsd,
      billableTokens,
      savings,
    };
  }

  /**
   * The three savings lines (counterfactual/billed/avoided) are only honest
   * when every delegated agent shares one vendor with a real, non-fallback
   * PRICE_TABLE entry, reported real vendor-usage token counts, AND the
   * orchestrator's own price resolved. Any other mix (mixed vendors, a
   * foreign-harness worker whose usage wasn't vendor-reported, an unpriced
   * vendor, or an unpriced orchestrator model) makes the ratio fabricated,
   * so buildDelegationLedger's caller must hide those three lines rather
   * than show a misleading number — see renderDelegationStats.
   * @param {Array<{id?:string, vendor?:string, model?:string, usageReported?:boolean}>} list
   * @param {Record<string, {perMtok:number, weight:number}>} table
   * @param {number|null} orchestratorRate
   * @returns {{eligible:boolean, reason:string|null, agents:string[]}}
   */
  function buildSavingsEligibility(list, table, orchestratorRate) {
    const agentName = (a) => a.id || a.model || a.vendor || "agent";
    const agents = list.map(agentName);

    // Prefer the row's own explicit vendor; a legacy row that only carries a
    // bare model string ("sonnet", "opus" — no `vendor` field, matching the
    // pre-multi-vendor telemetry shape) resolves its implied vendor the same
    // way pricing does, via resolvePriceKey's provider prefix, so those rows
    // are never wrongly flagged as an unpriced "unknown" vendor.
    const effectiveVendor = (a) => {
      if (a.vendor) return a.vendor;
      const cls = costModelClass(a.model, a.costModelClass);
      const key = resolvePriceKey(a.model, cls);
      const slash = key.indexOf("/");
      return slash >= 0 ? key.slice(0, slash) : key;
    };

    const vendors = new Set(list.map(effectiveVendor));
    if (vendors.size > 1) {
      return { eligible: false, reason: "mixed vendors", agents };
    }

    const unreported = list.filter((a) => a.usageReported === false).map(agentName);
    if (unreported.length > 0) {
      return { eligible: false, reason: `usage not reported by ${unreported.join(", ")}`, agents: unreported };
    }

    if (list.length > 0) {
      const vendor = effectiveVendor(list[0]);
      const allPriced = list.every((a) => {
        const cls = costModelClass(a.model, a.costModelClass);
        if (cls === "subscription" || cls === "local") return true; // no per-token price expected
        const key = resolvePriceKey(a.model, cls);
        return key !== DEFAULT_PRICE_KEY && Boolean(table[key]);
      });
      if (!allPriced) {
        return { eligible: false, reason: `no price table for ${vendor}`, agents };
      }
    }

    if (orchestratorRate == null) {
      return { eligible: false, reason: "orchestrator model unpriced", agents };
    }

    return { eligible: true, reason: null, agents };
  }

  /**
   * Billing class used to price the orchestrator row. On the Claude Code harness the
   * orchestrator is the Claude baseline, so a class stamped onto its row by activity
   * (a misattributed foreign/MCP call) is ignored; other harnesses keep the row's class.
   * @param {{costModelClass?:string}} orch
   * @returns {string|undefined}
   */
  function orchBillingClass(orch) {
    const harness = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    return harness === "claude-code" ? undefined : orch.costModelClass;
  }

  /**
   * Resolve the orchestrator's blended $/Mtok price from a metrics array.
   * Returns `null` — never a fabricated fallback price — when no
   * orchestrator entry is found or its model is unpriced; the metrics panel
   * must never invent a model/price to keep a ratio computable. Shared by
   * the per-agent "vs. orch." column and the delegation-stats savings
   * headline; every caller MUST branch on `null` and render an honest
   * unknown state (e.g. "—" or an explanatory line) instead of computing a
   * ratio against it. See docs/KNOWN-BUG-orchestrator-price-fallback.md.
   *
   * Token-weighted across `orch.modelBreakdown` (model id -> cumulative
   * billable coordination tokens under that model) and `orch.cacheReadModelBreakdown`
   * (same shape, for cache-read tokens, weighted at 0.1x since cache reads
   * price at ~0.1x the model's input rate) when present, rather than the
   * single scalar `orch.model` (most-recent model only) — otherwise
   * switching the orchestrator's session model retroactively reprices every
   * historical delegated-agent counterfactual at whatever model is current
   * NOW, which is wrong: past coordination happened under past models. Falls
   * back to `modelPricePerMtok(orch.model)` when both breakdowns are absent
   * or empty (legacy records, or a metrics entry that predates the fields).
   * @param {Array<{id?:string, model?:string, modelBreakdown?:Record<string, number>, cacheReadModelBreakdown?:Record<string, number>}>|undefined} metrics
   * @returns {number|null}
   */
  function resolveOrchestratorPrice(metrics) {
    const orch = Array.isArray(metrics) ? metrics.find((a) => a && a.id === "orchestrator") : null;
    if (!orch) return null;

    const breakdown = orch.modelBreakdown;
    const cacheBreakdown = orch.cacheReadModelBreakdown;
    let pricedTokens = 0;
    let weightedSum = 0;
    if (breakdown && typeof breakdown === "object") {
      for (const [model, tokens] of Object.entries(breakdown)) {
        if (!(tokens > 0)) continue;
        const price = modelPricePerMtok(model, orchBillingClass(orch));
        if (price == null) continue;
        pricedTokens += tokens;
        weightedSum += tokens * price;
      }
    }
    if (cacheBreakdown && typeof cacheBreakdown === "object") {
      for (const [model, tokens] of Object.entries(cacheBreakdown)) {
        if (!(tokens > 0)) continue;
        const price = modelPricePerMtok(model, orchBillingClass(orch));
        if (price == null) continue;
        // Cache reads bill at ~0.1x the model's input rate.
        pricedTokens += tokens;
        weightedSum += tokens * price * 0.1;
      }
    }
    if (pricedTokens > 0) return weightedSum / pricedTokens;
    // Neither breakdown had anything priceable (e.g. all-unpriced models, or
    // both empty) — fall through to the scalar fallback below rather than
    // returning null outright, since orch.model may still be a priced,
    // more-recent signal.

    const price = modelPricePerMtok(orch.model, orchBillingClass(orch));
    return price != null ? price : null;
  }

  /**
   * Resolve the orchestrator's raw model $/Mtok rate — NOT its blended
   * effective rate — from a metrics array. Returns `null` when no
   * orchestrator entry is found or its model is unpriced.
   *
   * This is deliberately a SEPARATE helper from resolveOrchestratorPrice,
   * not a shared implementation, because the two callers want different
   * quantities: the delegation-savings counterfactual (~14035-14049) wants
   * "what would these tokens have cost the orchestrator's actual access
   * pattern", which legitimately includes the 0.1x cache-read discount the
   * orchestrator earns by re-reading its own huge context every turn. The
   * "vs. orch." badge instead promises a MODEL-rate comparison ("how much
   * cheaper this agent's model is per token than the orchestrator's") — the
   * cache discount is a property of the orchestrator's access pattern, not
   * of its model, so blending it in there previously made Sonnet/Haiku
   * workers (near-0% cache hit, cold-start each task) show as "pricier"
   * than an Opus orchestrator that is ~97% cache reads. Folding the cache
   * term out of resolveOrchestratorPrice would fix the badge but silently
   * change the counterfactual's math too, which is explicitly out of scope.
   *
   * Token-weighted across `orch.modelBreakdown` (model id -> cumulative
   * billable coordination tokens under that model), WITHOUT the
   * cache-read breakdown or its 0.1x term, so a model switch mid-session is
   * still weighted by how much coordination actually happened under each
   * model rather than only the most recent one. Falls back to
   * `modelPricePerMtok(orch.model)` when the breakdown is absent, empty, or
   * entirely unpriced.
   * @param {Array<{id?:string, model?:string, modelBreakdown?:Record<string, number>}>|undefined} metrics
   * @returns {number|null}
   */
  function resolveOrchestratorModelRate(metrics) {
    const orch = Array.isArray(metrics) ? metrics.find((a) => a && a.id === "orchestrator") : null;
    if (!orch) return null;

    const breakdown = orch.modelBreakdown;
    let pricedTokens = 0;
    let weightedSum = 0;
    if (breakdown && typeof breakdown === "object") {
      for (const [model, tokens] of Object.entries(breakdown)) {
        if (!(tokens > 0)) continue;
        const price = modelPricePerMtok(model, orchBillingClass(orch));
        if (price == null) continue;
        pricedTokens += tokens;
        weightedSum += tokens * price;
      }
    }
    if (pricedTokens > 0) return weightedSum / pricedTokens;

    const price = modelPricePerMtok(orch.model, orchBillingClass(orch));
    return price != null ? price : null;
  }

  /**
   * Compute the "vs. orch." label text for one agent — shared by the
   * metrics-table row badge and the Settings "vs. orch." chip so the two
   * surfaces can never disagree. A numeric ratio is only meaningful
   * metered-vs-metered (both sides have a genuine $/token rate); for a
   * subscription (flat-rate quota, no marginal per-token cost) or local
   * (zero marginal cost) agent, computing a ratio against the metered
   * orchestrator rate would fabricate a comparison that doesn't exist —
   * exactly the class of bug the raw-rate fix (see resolveOrchestratorModelRate's
   * doc) corrected. "unknown" stays "—", unchanged, since we genuinely don't
   * know what the model is and a qualitative label would be a fabricated
   * claim too.
   * @param {string|null|undefined} agentModel
   * @param {number|null} agentRate result of modelPricePerMtok(agentModel)
   * @param {number|null} orchestratorPrice raw orchestrator $/Mtok rate
   * @returns {string}
   */
  function vsOrchLabel(agentModel, agentRate, orchestratorPrice, explicitCostModelClass, foreign) {
    const cls = costModelClass(agentModel, explicitCostModelClass);
    // Different vendor than the orchestrator: no multiplier and no money
    // amount (tokenizers, billing and quality differ) — just the billing type.
    if (foreign) return billingTypeLabel(cls);
    if (cls === "subscription") return "Sub";
    if (cls === "local") return "Local";
    if (agentRate != null && orchestratorPrice != null) {
      // Raw model-rate comparison — NOT a token-volume-weighted blend (see
      // resolveOrchestratorModelRate's doc). A priced model has a well-defined
      // rate ratio even with zero recorded tokens.
      const ratio = orchestratorPrice / agentRate;
      if (ratio >= 1.05) return `${fmtRatio(ratio)}× cheaper`;
      if (ratio <= 0.95) return `${fmtRatio(1 / ratio)}× pricier`;
      return "same cost";
    }
    return "—";
  }

  /**
   * Plain billing-type badge for a foreign-vendor agent.
   * @param {string} cls costModelClass
   * @returns {string}
   */
  function billingTypeLabel(cls) {
    if (cls === "subscription") return "Sub";
    if (cls === "local") return "Local";
    if (cls === "metered") return "API";
    return "—";
  }

  /** Tooltip for the "vs. orch." badge, given whether the agent is foreign. */
  function vsOrchTitle(foreign, cls) {
    const why = cls === "subscription" ? "Subscription — flat-rate sign-in, no per-token charge."
      : cls === "local" ? "Free / local endpoint — no per-token charge."
      : cls === "metered" ? "Pay per use (API key) — billed per token."
      : "Billing type unknown.";
    if (!foreign) {
      return "How much cheaper this agent's model is per token than the orchestrator's (metered models only). Subscription and local models show their billing type instead of a ratio. " + why;
    }
    return `${why} Different vendors count tokens differently, so costs aren't directly comparable to Claude.`;
  }

  /**
   * Billing type words for the model tooltip.
   * @param {string} cls costModelClass
   * @returns {string}
   */
  function billingTypeWords(cls) {
    if (cls === "subscription") return "Subscription";
    if (cls === "local") return "Local";
    if (cls === "metered") return "API (pay per use)";
    return "";
  }

  /**
   * The muted same-vendor price estimate for the model tooltip, or null when
   * no valid metered-vs-metered comparison exists. Reuses vsOrchLabel's ratio.
   * @returns {string|null}
   */
  function vsOrchEstimateText(agentModel, agentRate, orchestratorPrice, cls, foreign) {
    if (foreign || cls === "subscription" || cls === "local") return null;
    const t = vsOrchLabel(agentModel, agentRate, orchestratorPrice, cls, false);
    const tail = " per token than the orchestrator's model at published list prices. Estimate only; prices change.";
    if (/× cheaper$/.test(t)) return "About " + t + tail;
    if (/× pricier$/.test(t)) return "About " + t + tail;
    if (t === "same cost") return "About the same cost per token as the orchestrator's model at published list prices. Estimate only; prices change.";
    return null;
  }

  /**
   * Backend-first identity for an agent: the routed backend's vendor and
   * billing class (from the Settings payload's route-derived fields, keyed by
   * agent id) win over the metrics row's run model/vendor, because a wrapper
   * subagent (Grok/Kimi/Mistral Reviewer) runs on Claude haiku while its work
   * is billed by the backend vendor. Google follows the actual Gemini bridge
   * backend: agy (Antigravity sign-in) = subscription, gemini (paid key) =
   * metered. Falls back to the row's own fields when there is no backend.
   * @param {{id?:string, vendor?:string, model?:string, costModelClass?:string}} agent
   * @returns {{vendor:string, costModelClass:string|undefined}}
   */
  /** True for the Codex orchestrator row when no token usage is reported (Codex does not report orchestrator tokens). */
  function codexOrchTokensNa(orch) {
    return !!orch && orch.id === "orchestrator"
      && ((lastSettings && lastSettings.harness && lastSettings.harness.effective) || "") === "codex"
      && !(orch.tokens > 0);
  }

  function backendIdentity(agent) {
    const id = agent && agent.id;
    const sa = id && lastSettings && Array.isArray(lastSettings.agents)
      ? lastSettings.agents.find((x) => x && x.id === id)
      : null;
    // Configuration (Settings payload) is the source of truth; the metrics row's own
    // vendor/costModelClass are activity-stamped and only used when the agent has no
    // settings entry yet, so a stale stamp can never relabel a configured agent.
    const vendor = sa
      ? resolveAgentVendor(sa.vendor, sa.vendor ? "" : (sa.resolvedModel || (agent && agent.model)))
      : resolveAgentVendor(agent && agent.vendor, agent && agent.model);
    let cls = sa ? (sa.costModelClass || undefined) : ((agent && agent.costModelClass) || undefined);
    if (vendor === "google" && sa && sa.vendor) {
      const g = geminiBackendState();
      cls = g.value === "gemini" ? "metered" : "subscription";
    }
    return { vendor, costModelClass: cls };
  }

  /**
   * Codex harness default for an agent (from the Settings payload, computed
   * host-side by src/core/harnessModelDefaults.ts): { vendor, model, effort?,
   * label } when the agent has no explicit choice and will run on a Codex
   * model, else null. Display only; never written to routing.json.
   * @param {{id?:string}} agent
   * @returns {{vendor:string, model:string, effort?:string, label:string}|null}
   */
  function harnessDefaultFor(agent) {
    const id = agent && agent.id;
    if (!id || !lastSettings || !Array.isArray(lastSettings.agents)) return null;
    const sa = lastSettings.agents.find((x) => x && x.id === id);
    const hd = sa && sa.harnessDefault;
    return hd && typeof hd === "object" && hd.model ? hd : null;
  }

  /**
   * The routed backend's model id for an agent (e.g. "grok-4.7",
   * "gpt-6.1-sol"), from the last routing payload. Null when routing has not
   * loaded or the agent has no routed backend model.
   * @param {{id?:string}} agent
   * @returns {string|null}
   */
  function backendModelFor(agent) {
    const id = agent && agent.id;
    const hd = harnessDefaultFor(agent);
    if (hd) return hd.model;
    const ra = id && lastRoutingPayload && Array.isArray(lastRoutingPayload.agents)
      ? lastRoutingPayload.agents.find((x) => x && x.id === id)
      : null;
    const m = ra && ra.backend && ra.backend.model;
    const model = typeof m === "string" && m.trim() ? m.trim() : null;
    // Antigravity (agy) always runs Gemini 3.5 Flash, whatever the routing
    // model says; the routing model only applies on the paid gemini backend.
    const vendor = ra && ra.backend && typeof ra.backend.vendor === "string" ? ra.backend.vendor.toLowerCase() : "";
    const gState = model && (vendor === "google" || /^gemini/i.test(model)) ? geminiBackendState() : null;
    if (gState && gState.known && gState.value === "agy") {
      return "gemini-3.5-flash (Antigravity)";
    }
    return model;
  }

  /**
   * Model text for an agent's tooltip/label, shared by every display spot.
   * Codex harness default -> its label. A bridge wrapper (hand-written
   * backend, e.g. Mistral/Grok Reviewer: frontmatter says haiku but the work
   * runs on the backend model) -> the backend model; on Codex the wrapper does
   * not run, so just the backend model, while on Claude Code the Claude relay
   * is noted ("mistral-large-latest (via Haiku relay)"). Otherwise null, and
   * callers fall back to the roster model.
   * @param {{id?:string, model?:string}} agent
   * @returns {string|null}
   */
  const RELAY_SERVER_LABELS = { codex: "Codex", "codex-write": "Codex", "claude-cli": "Claude CLI", gemini: "Gemini", "openai-compatible": "OpenAI-compatible" };
  function bridgeAwareModelText(agent) {
    const hd = harnessDefaultFor(agent);
    if (hd) return hd.label;
    const id = agent && agent.id;
    const sa = id && lastSettings && Array.isArray(lastSettings.agents)
      ? lastSettings.agents.find((x) => x && x.id === id)
      : null;
    if (!sa) return null;
    // Managed relay (frontmatter `tycoon_relay`): the file's own model is just the
    // Claude wrapper; the work runs on the provider model, reached via the bridge.
    if (sa.relayServer && typeof sa.resolvedModel === "string" && sa.resolvedModel.trim()) {
      const relayVendor = String(sa.vendor || "").toLowerCase();
      if (relayVendor && relayVendor !== "anthropic") {
        const via = RELAY_SERVER_LABELS[String(sa.relayServer).toLowerCase()] || String(sa.relayServer);
        const onCodexHarness = !!(lastSettings && lastSettings.harness && lastSettings.harness.effective === "codex");
        return onCodexHarness ? sa.resolvedModel.trim() : `${sa.resolvedModel.trim()} (via ${via})`;
      }
    }
    if (!sa.handWrittenBackend || typeof sa.resolvedModel !== "string" || !sa.resolvedModel.trim()) return null;
    const vendor = String(sa.vendor || "").toLowerCase();
    if (!vendor || vendor === "anthropic") return null;
    const bare = sa.resolvedModel.trim().replace(/^[^/]+\//, "");
    const onCodex = !!(lastSettings && lastSettings.harness && lastSettings.harness.effective === "codex");
    if (onCodex) return bare;
    const relay = agent && agent.model ? prettyModel(agent.model, agent.observedModel).split(" ")[0] : "";
    return relay ? `${bare} (via ${relay} relay)` : bare;
  }

  /**
   * Best-effort vendor id for an agent: explicit `vendor` field first, else
   * inferred from the model id. Returns "" when unknown.
   * @param {string|null|undefined} vendor
   * @param {string|null|undefined} model
   * @returns {string}
   */
  function resolveAgentVendor(vendor, model) {
    const v = typeof vendor === "string" ? vendor.trim().toLowerCase() : "";
    if (v) return v;
    const s = String(model || "").toLowerCase();
    if (!s) return "";
    if (/opus|sonnet|haiku|fable|anthropic|claude/.test(s)) return "anthropic";
    if (/gpt|codex|openai/.test(s)) return "openai";
    if (/gemini|google/.test(s)) return "google";
    if (/kimi|moonshot/.test(s)) return "moonshot";
    if (/grok|xai/.test(s)) return "xai";
    if (/mistral/.test(s)) return "mistral";
    if (/qwen|alibaba/.test(s)) return "alibaba";
    if (/ollama|lmstudio|local:/.test(s)) return "local";
    const slash = s.indexOf("/");
    return slash > 0 ? s.slice(0, slash) : "";
  }

  /**
   * True when the agent's vendor is known and differs from the orchestrator's
   * (an orchestrator with no recognizable vendor is a Claude session).
   * @returns {boolean}
   */
  function isForeignToOrchestrator(agent, orchestrator) {
    // Codex harness-default agents run on OpenAI models whatever the
    // orchestrator's own vendor looks like.
    if (harnessDefaultFor(agent)) return true;
    const av = backendIdentity(agent).vendor;
    if (!av) return false;
    return av !== orchestratorVendorId(orchestrator);
  }

  /**
   * The orchestrator's vendor is the harness's own vendor (Claude Code ->
   * anthropic), never inferred from the orchestrator row's
   * vendor field: that field can carry a vendor stamped by a misattributed
   * foreign/MCP call, which would make every Claude agent look foreign.
   * Other harnesses fall back to the row's model; unknown means Claude.
   * @param {{vendor?:string, model?:string}|null|undefined} orchestrator
   * @returns {string}
   */
  function orchestratorVendorId(orchestrator) {
    const harness = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    if (harness === "claude-code") return "anthropic";
    return resolveAgentVendor(orchestrator && orchestrator.vendor, orchestrator && orchestrator.model) || "anthropic";
  }

  /**
   * Conjugate a verb into its third-person singular form.
   * @param {string} verb
   * @returns {string}
   */
  function thirdPersonVerb(verb) {
    const lower = verb.toLowerCase();
    const irregular = { are: "is", have: "has", do: "does", go: "goes" };
    let conj;
    if (irregular[lower]) conj = irregular[lower];
    else if (/(s|sh|ch|x|z|o)$/.test(lower)) conj = lower + "es";
    else if (/[^aeiou]y$/.test(lower)) conj = lower.slice(0, -1) + "ies";
    else conj = lower + "s";
    return verb[0] === verb[0].toUpperCase() ? conj[0].toUpperCase() + conj.slice(1) : conj;
  }

  /**
   * Rewrite a second-person agent description into a third-person role blurb
   * for hover tooltips (e.g. "You are the Orchestrator — you coordinate work"
   * → "Coordinates work"). The agent name is shown separately, so a leading
   * self-introduction is dropped.
   * @param {string|undefined} desc
   * @returns {string}
   */
  function describeRole(desc) {
    if (!desc) return "";
    let s = String(desc).trim();
    // Drop a leading self-introduction "You are the/a/an <Name> — " so the
    // descriptive clause leads (the name is shown separately).
    s = s.replace(/^you\s+are\s+(?:the|a|an)\s+[^—:-]+?\s*[—–-]\s*/i, "");
    // Otherwise drop just the "You are " lead-in.
    s = s.replace(/^you\s+are\s+/i, "");
    // Convert sentence-initial "You <verb>" (start, or after . ! ?) to third person.
    s = s.replace(/(^|[.!?]\s+)you\s+([a-z]+)/gi, (_, pre, verb) => pre + thirdPersonVerb(verb));
    // Pronouns.
    s = s.replace(/\byour\b/gi, "its");
    s = s.replace(/\byou\b/gi, "it");
    // Capitalize first character.
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /**
   * Concise role LABEL for the character hover tooltip (e.g. "orchestrator"
   * → "Orchestrator", "primary-agent" → "Primary agent") — deliberately NOT
   * describeRole()'s verbose sentence-fragment blurb. Title-cases the agent's
   * identity: prefers agent.id (stable slugs like "coding-specialist"), falls
   * back to agent.name, hyphens/underscores become spaces, only the first
   * character is capitalized (matches the user's "Primary agent" example,
   * not "Primary Agent").
   * @param {{id?:string, name?:string}} agent
   * @returns {string}
   */
  function agentRoleLabel(agent) {
    const raw = (agent && (agent.id || agent.name)) || "";
    const s = String(raw).replace(/[-_]+/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Agent";
  }

  /**
   * Extract "Opus"/"Sonnet"/"Haiku"/"Fable" from a model string via
   * case-insensitive substring match. Returns null when no known family
   * substring is present.
   * @param {string|null|undefined} model
   * @returns {string|null}
   */
  function modelFamily(model) {
    if (!model) return null;
    const s = String(model).toLowerCase();
    if (s.includes("opus")) return "Opus";
    if (s.includes("sonnet")) return "Sonnet";
    if (s.includes("haiku")) return "Haiku";
    if (s.includes("fable")) return "Fable";
    return null;
  }

  /**
   * Short display name for a model id, used by the Metrics MODEL pill: the
   * family only, never the company or a billing label. Claude: Opus, Sonnet,
   * Haiku, Fable, Mythos. OpenAI/Codex tiers: Astra, Sol, Terra, Luna.
   * Google: "Argon" / "Carbon" (Gemini 4 tiers), else "Gemini Pro" / "Gemini Flash". Moonshot: "Kimi K2". Anything else
   * keeps a truncated bare model id; empty or unknown input gives "—".
   * Self-contained on purpose (the test extracts and runs it in isolation).
   * @param {string|null|undefined} modelId
   * @returns {string}
   */
  function modelShortName(modelId) {
    let s = String(modelId == null ? "" : modelId).trim();
    if (!s) return "—";
    s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const lower = s.toLowerCase();
    const claude = [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"], ["mythos", "Mythos"]];
    // Claude family names only for Claude ids: claude-*, anthropic/*, or a bare alias.
    if (/^(claude[-_./]|anthropic\/)/.test(lower) || /^(opus|sonnet|haiku|fable|mythos)(\b|[-_.\d]|$)/.test(lower)) {
      for (const [key, name] of claude) if (lower.includes(key)) return name;
    }
    const tier = [["astra", "Astra"], ["terra", "Terra"], ["luna", "Luna"], ["sol", "Sol"]];
    for (const [key, name] of tier) {
      if (new RegExp("(^|[^a-z])" + key + "([^a-z]|$)").test(lower)) return name;
    }
    if (lower.includes("gemini")) {
      if (/(^|[^a-z])argon([^a-z]|$)/.test(lower)) return "Argon";
      if (/(^|[^a-z])carbon([^a-z]|$)/.test(lower)) return "Carbon";
      if (lower.includes("flash")) return "Gemini Flash";
      if (lower.includes("pro")) return "Gemini Pro";
      return "Gemini";
    }
    if (lower.includes("kimi")) {
      const k = /k(\d+)/.exec(lower);
      return k ? "Kimi K" + k[1] : "Kimi";
    }
    const bare = s.replace(/^.*\//, "").trim();
    if (!bare) return "—";
    return bare.length > 12 ? bare.slice(0, 11) + "…" : bare;
  }

  /**
   * Classifies a model id's BILLING MODEL — a distinct fact from its price.
   * Per docs/provider-contract.md (Phase 1, frozen, section 4 costModelClass),
   * exactly four values:
   *   - "metered"      per-token billing with a marginal cost on every call
   *                     (the Anthropic API this orchestrator itself runs on).
   *   - "subscription" flat-rate plan with quota windows, NO marginal
   *                     per-token cost within the window (e.g. Codex running
   *                     under a ChatGPT Plus/Pro account).
   *   - "local"        runs on the user's own hardware, zero marginal cost,
   *                     constrained by VRAM/latency rather than credits or
   *                     quota windows.
   *   - "unknown"      genuinely unrecognized — we do not know what this is.
   * This is NOT a price lookup: subscription/local have no marginal
   * per-token dollar figure to fabricate (that would be as wrong as
   * inventing a nonzero one) — the class itself is the answer callers get.
   * @param {string|null|undefined} model
   * @returns {"metered"|"subscription"|"local"|"unknown"}
   */
  /**
   * Human-readable label for a costModelClass value. Display-only: never
   * feed this back into a stored/compared value — those stay the literal
   * "metered"/"subscription"/"local"/"unknown".
   * @param {string} cls
   * @returns {string}
   */
  function costClassLabel(cls) {
    if (cls === "metered") return "metered (API)";
    if (cls === "subscription") return "subscription";
    if (cls === "local") return "local";
    return cls;
  }

  function costModelClass(model, explicit) {
    if (explicit === "metered" || explicit === "subscription" || explicit === "local") return explicit;
    if (!model) return "unknown";
    const s = String(model).toLowerCase();
    // Anthropic families -> metered (matches modelFamily's substrings above;
    // must stay in lockstep with it and with MODEL_PRICE_PER_MTOK's keys).
    if (
      s.includes("opus") ||
      s.includes("sonnet") ||
      s.includes("haiku") ||
      s.includes("fable")
    ) {
      return "metered";
    }
    // Codex / OpenAI GPT models observed live in Phase 1 (probe doc section
    // 7): gpt-5.5, gpt-5.4, gpt-5.4-mini, codex-auto-review. Matched
    // generously by prefix family (gpt-*, codex-*) rather than pinning exact
    // slugs, since new dated/variant slugs ship often and none of gpt-*/
    // codex-* collides with an Anthropic family substring above.
    if (s.includes("gpt") || s.includes("codex")) {
      return "subscription";
    }
    // xAI Grok, via OpenCode's built-in xai provider (see PRICE_TABLE above)
    // — API-key metered, like the Anthropic families, not a CLI subscription.
    if (s.includes("xai") || s.includes("grok") || s.includes("mistral") || s.includes("kimi") || s.includes("moonshot")) {
      return "metered";
    }
    // FORWARD-LOOKING, NOT YET VERIFIED: no local provider (Ollama/LM
    // Studio) is live yet per docs/provider-contract.md section 4 ("this
    // value is definitional rather than inferred from a probe"). This
    // prefix convention is a placeholder signal for when phase work wires a
    // real local provider through — re-verify against that provider's
    // actual model-id shape before relying on this in production, per the
    // contract's "Design judgments" section.
    if (
      s.indexOf("ollama") === 0 ||
      s.indexOf("lmstudio") === 0 ||
      s.indexOf("local:") === 0
    ) {
      return "local";
    }
    return "unknown";
  }

  /**
   * Roll a cumulative agentMetrics array up into per-vendor and
   * per-costModelClass totals, a fallback-dispatch count, and a list of
   * "local, time-based" rows for local-model items that carry no token
   * count (local runtimes often don't report tokens at all, so a 0-token
   * local agent must show its active time rather than a fabricated/zero
   * token-equivalent).
   *
   * Cost/vendor/model attribution always uses the ITEM'S OWN
   * vendor/model/costModelClass — i.e. whichever provider actually ran —
   * never `fallbackOf` (the originally assigned agent id). A
   * fallback-tagged item's tokens and cost land under the vendor/class
   * that executed it.
   *
   * Pure: never mutates `agentMetrics` or any of its entries.
   * @param {Array<{id?:string, vendor?:string, model?:string, costModelClass?:string, tokens?:number, cacheReadTokens?:number, activeMs?:number, fallbackOf?:string, fallbackDepth?:number, fallbackCount?:number, name?:string}>|undefined} agentMetrics
   * @returns {{
   *   byVendor: Array<{vendor:string, tokens:number, agents:number}>,
   *   byCostClass: Array<{costModelClass:string, tokens:number}>,
   *   fallbackCount: number,
   *   localTimeRows: Array<{agent:string, vendor:string, model:string, activeMs:number}>
   * }}
   */
  /**
   * Append one labeled rollup row (rendered as `<tr><td colspan=N>` with a
   * bold label span + plain value text) to `tbodyEl`. Shared by
   * renderMetricsTable's footer and the Routing view's Totals block
   * (p13-t3) so the two never compute or render a rollup row differently.
   * Output is identical to the previous renderMetricsTable-local closure —
   * only the tbody/colspan became explicit parameters.
   * @param {HTMLElement} tbodyEl
   * @param {number} colSpan
   * @param {string} labelText
   * @param {string} valueText
   * @param {string} [title]
   */
  function appendFooterRow(tbodyEl, colSpan, labelText, valueText, title) {
    const tr = document.createElement("tr");
    tr.className = "metrics-footer-row";
    tr.style.borderTop = "1px solid var(--border)";
    const td = document.createElement("td");
    td.colSpan = colSpan;
    td.style.whiteSpace = "normal";
    td.style.fontSize = "11px";
    td.style.color = "var(--muted)";
    if (title) td.title = title;
    const strong = document.createElement("span");
    strong.style.color = "var(--fg, inherit)";
    strong.textContent = labelText;
    td.appendChild(strong);
    td.appendChild(document.createTextNode(valueText));
    tr.appendChild(td);
    tbodyEl.appendChild(tr);
  }

  /**
   * Infer a vendor id from a model string when the record itself carries no
   * `vendor` field. Reuses the same alias/family recognition as
   * `resolvePriceKey`'s legacy-id branch (opus/sonnet/haiku/fable bare or
   * "claude-*") and the "vendor/model" prefix convention used throughout
   * this file (e.g. resolvePriceKey, isWellFormedClaudeModelId). Returns
   * "unknown" when nothing matches — never fabricates a vendor.
   * @param {string|null|undefined} model
   * @returns {string}
   */
  function inferVendorFromModel(model) {
    const s = String(model || "").trim().toLowerCase();
    if (!s) return "unknown";
    if (/^(opus|sonnet|haiku|fable)$/i.test(s)) return "anthropic";
    if (/^claude-(opus|sonnet|haiku|fable)/i.test(s)) return "anthropic";
    if (/(opus|sonnet|haiku|fable)/i.test(s) && s.indexOf("/") === -1) return "anthropic";
    if (s.indexOf("/") >= 0) {
      const provider = s.split("/")[0];
      if (provider) return provider;
    }
    return "unknown";
  }

  function buildMetricsRollup(agentMetrics) {
    const items = Array.isArray(agentMetrics) ? agentMetrics : [];

    const vendorMap = new Map(); // vendor -> { tokens, agents }
    const classMap = new Map(); // costModelClass -> { tokens }
    let fallbackCount = 0;
    const localTimeRows = [];
    let totalTokens = 0; // billed tokens only (input+output+cache-write) — cache reads NEVER add in here (spec p63-t3)
    let totalCacheReadTokens = 0;
    let totalAgents = 0; // every agent record seen, including ones with no tokens field
    let reportedAgents = 0; // agents whose record actually has a `tokens` field

    for (const item of items) {
      if (!item) continue;

      totalAgents += 1;
      fallbackCount += item.fallbackCount > 0 ? item.fallbackCount : 0;

      // A harness that doesn't report token usage yet (e.g. Codex today) sends
      // an agent record with NO `tokens` field at all. That agent is real and
      // counts toward totalAgents above, but has nothing to contribute to the
      // token totals/breakdowns below — including it as 0 would silently
      // understate "N agents" as if they were all metered.
      if (typeof item.tokens !== "number") continue;
      reportedAgents += 1;

      const vendor = item.vendor || inferVendorFromModel(item.model);
      const model = item.model || "";
      const cls = costModelClass(model, item.costModelClass);
      const tokens = item.tokens ?? 0;
      const cacheRead = item.cacheReadTokens ?? 0;

      let vEntry = vendorMap.get(vendor);
      if (!vEntry) {
        vEntry = { tokens: 0, agents: 0 };
        vendorMap.set(vendor, vEntry);
      }
      vEntry.tokens += tokens;
      vEntry.agents += 1;

      totalTokens += tokens;
      totalCacheReadTokens += cacheRead;

      let cEntry = classMap.get(cls);
      if (!cEntry) {
        cEntry = { tokens: 0 };
        classMap.set(cls, cEntry);
      }
      cEntry.tokens += tokens;

      if (cls === "local" && !(tokens > 0)) {
        localTimeRows.push({
          agent: item.name || item.id || "agent",
          vendor,
          model,
          activeMs: item.activeMs ?? 0,
        });
      }
    }

    const byVendor = Array.from(vendorMap.entries()).map(([vendor, v]) => ({
      vendor,
      tokens: v.tokens,
      agents: v.agents,
    }));

    const byCostClass = Array.from(classMap.entries()).map(([costModelClass, c]) => ({
      costModelClass,
      tokens: c.tokens,
    }));

    return {
      byVendor,
      byCostClass,
      fallbackCount,
      localTimeRows,
      totalTokens,
      totalCacheReadTokens,
      totalAgents,
      reportedAgents,
    };
  }

  /**
   * True when `id` has the shape of a genuine resolved Claude model id (e.g.
   * "claude-opus-5", "claude-sonnet-4-6") rather than arbitrary/garbled hook
   * data. Hook-observed model ids are untrusted input (they come from
   * `hookRecord.ts`'s `model` field, resolved by a hook script we don't
   * control the payload of) — only a string matching this shape may have its
   * digits parsed into a displayed version number.
   * @param {string} id
   * @returns {boolean}
   */
  function isWellFormedClaudeModelId(id) {
    return /^claude-(opus|sonnet|haiku|fable)(-\d+)+$/i.test(String(id || "").trim());
  }

  /**
   * Render an agent's model for display, e.g. "Opus 5", or just "Opus" when
   * no verified version is available. Never hardcodes a version number —
   * this project has a standing doctrine against pinning model versions
   * (they age the instant a newer model ships), so a version is shown ONLY
   * when it can be derived from a real, well-formed resolved model id.
   *
   * Two different sources answer two different questions, and this function
   * deliberately does not conflate them:
   *   - `rosterModel` (agentMetrics[].model, stamped from
   *     `.claude/agents/<id>.md` by panel.ts's `_stampRosterModels`) is
   *     AUTHORITATIVE for which family/tier the agent is CONFIGURED to run
   *     — it drives cost attribution ("Nx cheaper") and always wins for the
   *     family shown.
   *   - `observedModel` (agentMetrics[].observedModel, the hook's real
   *     resolved model id at spawn time) answers what ACTUALLY ran. It is
   *     untrusted input, so it is used ONLY to parse a version number, and
   *     only when it is well-formed (isWellFormedClaudeModelId) AND its
   *     family agrees with `rosterModel`.
   *
   * If there's no observed id, or it's malformed, or its family contradicts
   * the roster, the version is simply omitted — a missing version is
   * honest, a wrong one is not, and a family mismatch is never surfaced as
   * a contradiction (the roster family is authoritative for configuration).
   *
   * EXCEPTION — `isOrchestratorRow`: the orchestrator has no model selector
   * anywhere in settings, so unlike a subagent its roster/frontmatter value
   * is advisory, not configured. When this flag is set, a well-formed
   * `observedModel` wins OUTRIGHT — including its family — because the
   * observed id is the only trustworthy signal for what actually ran.
   * `isWellFormedClaudeModelId` still gates it: a malformed observed value
   * always falls back to `rosterModel`, orchestrator or not. Subagent
   * callers never pass this flag, so their behavior is unchanged.
   * @param {string|null|undefined} rosterModel
   * @param {string|null|undefined} [observedModel]
   * @param {boolean} [isOrchestratorRow]
   * @returns {string}
   */
  function prettyModel(rosterModel, observedModel, isOrchestratorRow) {
    if (isOrchestratorRow && observedModel && isWellFormedClaudeModelId(observedModel)) {
      const family = modelFamily(observedModel);
      if (family) {
        const nums = (String(observedModel).match(/\d+/g) || []).filter((n) => n.length < 8);
        return nums.length ? `${family} ${nums.join(".")}` : family;
      }
    }
    if (!rosterModel) return "";
    const family = modelFamily(rosterModel);
    if (!family) return String(rosterModel); // roster value is trusted config, not hook data — show raw
    if (observedModel && isWellFormedClaudeModelId(observedModel) && modelFamily(observedModel) === family) {
      const nums = (String(observedModel).match(/\d+/g) || []).filter((n) => n.length < 8);
      if (nums.length) return `${family} ${nums.join(".")}`;
    }
    return family;
  }

  /**
   * Display name for a non-Anthropic `vendor` field (e.g. `openai` -> "OpenAI").
   * Callers only invoke this when vendor is present and not "anthropic" — a
   * claude-native record never shows a vendor chip since it's the default.
   * @param {string} vendor
   * @returns {string}
   */
  function vendorLabelFor(vendor) {
    const v = String(vendor || "");
    if (v.toLowerCase() === "openai") return "OpenAI";
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  }

  /**
   * Abbreviated model id for narrow columns: Claude models collapse to their
   * family name (Sonnet/Haiku/Opus/Fable) via modelFamily; foreign models
   * (e.g. "ollama-choy-cloud/qwen3.8:27b", "openai/gpt-5.4-mini") drop the
   * vendor prefix before the last "/" and strip any parenthetical, leaving
   * just the model id (e.g. "qwen3.8:27b", "gpt-5.4-mini"). Callers pair this
   * with vendorLabelFor/costModelClass for the vendor/billing context, shown
   * as a muted suffix or title tooltip rather than inline text.
   * @param {string} model
   * @returns {string}
   */
  function shortModelLabel(model) {
    if (!model) return "";
    if (/\(Antigravity\)\s*$/.test(String(model))) return String(model);
    const family = modelFamily(model);
    if (family) return family;
    let s = String(model);
    const slash = s.lastIndexOf("/");
    if (slash !== -1) s = s.slice(slash + 1);
    s = s.replace(/\s*\([^)]*\)\s*/g, "").trim();
    return s || String(model);
  }

  /** Last CUMULATIVE metrics array received (state.agentMetrics), re-rendered on a timer so live time ticks. Always cumulative — see metricsScope's doc comment. */
  let lastMetrics = [];

  // Report disclosure open state (fix for the row vanishing ~1s after open
  // while any agent is active): renderMetricsTable rebuilds #metrics-tbody
  // from scratch on every tick (tbodyEl.innerHTML = ""), which used to wipe
  // out the report-disclosure <tr> along with the button that tracked its
  // own aria-expanded state — open state lived ONLY in the DOM. This Set
  // holds the stable `agent.id` of every agent whose report row is
  // currently open, survives the rebuild, and is consulted by
  // buildMetricsRow to re-open the disclosure row immediately after
  // re-appending that agent's row. Keyed by agent.id (same identity used
  // elsewhere in this file, e.g. the orchestrator pin/parentId checks).
  const openReportAgentIds = new Set();

  // Orchestrator "model not detected" warning (see renderSettings's
  // isOrchestrator branch): lastMetrics starts as [] and a "state" push with
  // no orchestrator entry looks identical to never having received one, so
  // there's no way to tell "haven't looked yet" from "looked and found
  // nothing" from lastMetrics alone. agentActivityObserved is set the first
  // time a "state" message arrives carrying GENUINE this-session activity —
  // msg.sessionMetrics.available with a non-empty agentMetrics array (see
  // the msg.type === "state" handler) — and is the only source of that
  // distinction. Deliberately NOT keyed off msg.state.agentMetrics (or its
  // mere presence at panel open): that array is cumulative across every
  // past session, so a returning user with prior history would arm the
  // grace timer on every panel open even when nothing ran this time — the
  // exact false-positive ("you opened the panel and waited") this flag
  // exists to rule out. The name reflects that: this is "has agent work
  // actually run in this session", not "have we received a metrics blob".
  let agentActivityObserved = false;
  // Short grace period after agent activity is first observed before the
  // undetected-model warning may show, so the panel doesn't flash a warning
  // while a just-started task hasn't yet had a moment to report the
  // orchestrator's model. Single-armed: the agentActivityObserved guard
  // above ensures this setTimeout only ever runs once, so no
  // clearTimeout/re-arm dance is needed here.
  let orchestratorModelGraceTimer = null;
  let orchestratorModelGraceElapsed = false;

  // Team Lead Mode Phase 3 previously nested workers under their lead
  // (expand/collapse rollup row). Retired in favor of a flat per-agent list
  // (see renderMetrics) because noisy parentId/tier data could hide a whole
  // team's rows; the per-lead expand/collapse state and rollup aggregation
  // that used to live here (isTeamExpanded/setTeamExpanded/aggregateTeam)
  // were removed along with it.

  /** Mirror of IN_FLIGHT_CEILING_MS in src/core/state.ts: max time one in-flight MCP call keeps a run accruing. */
  const IN_FLIGHT_CEILING_MS = 30 * 60 * 1000;

  /**
   * Instant after which a run's live clock stops (null = never stops). Mirrors
   * the host's creditedElapsed (src/core/state.ts): no per-run cap; frozen
   * idleFreezeMs after the last activity, except while an MCP call is in
   * flight, which extends the clock to its start + IN_FLIGHT_CEILING_MS.
   */
  function liveClockLimit(agent) {
    if (agent.lastActivityAt == null) return null;
    let until = agent.lastActivityAt + idleFreezeMs;
    const calls = Array.isArray(agent.inFlightCalls) ? agent.inFlightCalls : [];
    for (const c of calls) until = Math.max(until, c.at + IN_FLIGHT_CEILING_MS);
    return until;
  }

  /** Live (in-progress-inclusive) active ms for one agent metric entry. */
  function liveMsFor(agent) {
    const status = ((agent && agent.status) || "idle").toLowerCase();
    const isActive = status === "active";
    const limit = agent && agent.workStartAt ? liveClockLimit(agent) : null;
    const seg = agent && agent.workStartAt
      ? Math.max(0, Math.min(Date.now(), limit ?? Date.now()) - agent.workStartAt)
      : 0;
    return ((agent && agent.activeMs) || 0) + (isActive ? seg : 0);
  }

  /**
   * Why an in-progress run's live time has stopped advancing, or "" when it
   * is still ticking (or the agent is not active). Mirrors liveMsFor, which
   * in turn mirrors the host's creditedElapsed (src/core/state.ts), so the
   * live figure never jumps backwards when the run's total is stored.
   * One value covers concurrent runs: workStartAt is the EARLIEST start.
   * "tool" = an MCP call has been running past its 30 min ceiling.
   * @returns {""|"idle"|"tool"}
   */
  function liveTimePauseReason(agent) {
    if (!agent || (agent.status || "idle").toLowerCase() !== "active" || !agent.workStartAt) return "";
    const limit = liveClockLimit(agent);
    if (limit === null || Date.now() <= limit) return "";
    return Array.isArray(agent.inFlightCalls) && agent.inFlightCalls.length > 0 ? "tool" : "idle";
  }

  /**
   * True when this row's work reaches the Claude Code harness through the
   * Codex MCP server or the Gemini bridge. Those bridges return no usage, so
   * the row's TOKENS only cover the Claude relay. openai-compatible,
   * claude-cli and dispatcher (mcp__tycoon__delegate) paths report tokens
   * and are not matched. Fallback rows are excluded (their tokens come from
   * the fallback run).
   */
  function isUnreportedBridgeRow(agent) {
    if (!agent || !agent.id || agent.id === "orchestrator") return false;
    // A hand-written agent that shells out to another LLM's CLI (codex exec, gemini -p, ...):
    // that CLI's tokens are never captured, so TOKENS only cover this agent's own model.
    if (agent.foreignCliCalls > 0) return true;
    const harness = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    if (harness !== "claude-code") return false;
    if (typeof agent.fallbackOf === "string" && agent.fallbackOf.trim() !== "") return false;
    const ra = lastRoutingPayload && Array.isArray(lastRoutingPayload.agents)
      ? lastRoutingPayload.agents.find((x) => x && x.id === agent.id)
      : null;
    const b = ra && ra.backend;
    if (!b || b.transport !== "mcp") return false;
    const server = String(b.mcpServer || "").toLowerCase();
    const vendor = String(b.vendor || "").toLowerCase();
    return /^(codex|gemini|agy|antigravity)/.test(server) || ((vendor === "openai" || vendor === "google") && !!server);
  }

  /** The foreign-LLM CLI call currently in flight for this agent, or null. */
  function foreignCliInFlight(agent) {
    const calls = agent && Array.isArray(agent.inFlightCalls) ? agent.inFlightCalls : [];
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i] && calls[i].foreign && calls[i].foreign.vendor) return calls[i].foreign;
    }
    return null;
  }

  /** "via Codex CLI · gpt-6.1-terra" for a foreign-LLM CLI call (model omitted when unknown). */
  function foreignCliLabel(f) {
    const names = { codex: "Codex CLI", gemini: "Gemini CLI", opencode: "OpenCode CLI", ollama: "Ollama" };
    const cli = names[f.cli] || String(f.cli || "CLI");
    return "via " + cli + (f.model ? " · " + f.model : "");
  }

  /**
   * The model an agent is CONFIGURED to run on, from the Settings/routing payloads
   * (never from activity-stamped metrics fields): Codex harness default, else the
   * routed backend model for a non-Claude agent, else the agent file's model.
   * Falls back to the metrics row's roster-stamped model before settings load.
   * @param {{id?:string, model?:string}} agent
   * @returns {string}
   */
  function configuredModelId(agent) {
    const hd = harnessDefaultFor(agent);
    if (hd) return hd.model;
    const id = agent && agent.id;
    const sa = id && lastSettings && Array.isArray(lastSettings.agents)
      ? lastSettings.agents.find((x) => x && x.id === id)
      : null;
    const bm = backendModelFor(agent);
    const resolved = sa && typeof sa.resolvedModel === "string" ? sa.resolvedModel.trim() : "";
    if (sa && sa.vendor && String(sa.vendor).toLowerCase() !== "anthropic") {
      return (bm || resolved || (agent && agent.model) || "").replace(/^[^/]+\//, "");
    }
    return resolved || (agent && agent.model) || bm || "";
  }

  /**
   * Render one metrics row. `opts` is kept (rather than dropping the param)
   * so callers stay uniform; the lead/worker nesting opts it used to accept
   * (chevron/indent/teamTag/leadId, Team Lead Mode Phase 3) were retired
   * when the table moved to a flat per-agent list (see renderMetrics).
   */
  function buildMetricsRow(agent, maxAgentTasks, opts) {
    opts = opts || {};
    const status = (agent.status || "idle").toLowerCase();
    const isActive = status === "active";
    const showActive = isMetricsAgentActive(agent);
    const row = document.createElement("tr");

    const displayName = agent.name || agent.id;

    // Cross-vendor accent (p24-t2): color + " (fb)" suffix decided by the
    // single pure source of truth in 005-agent-accent.js. harnessEffective
    // is read live off `lastSettings` (declared just below in this same
    // file/scope) so the whole metrics table re-accents the next time it's
    // rebuilt after a harness switch (renderMetrics/renderMetricsTable
    // already rebuild #metrics-tbody from scratch on every settings/metrics
    // update — no separate recompute pass needed here).
    const rowHarness = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    // A foreign-LLM CLI call in flight (Bash running codex exec etc.) lights the row like an MCP
    // bridge call does; fallback still wins inside agentAccent.
    const foreignInFlight = foreignCliInFlight(agent);
    // The orchestrator is the baseline: on the Claude Code harness it never takes the foreign
    // accent (a stamped row vendor or a misattributed call must not recolor it). Other agents
    // take the routed backend vendor from Settings before the metrics row's own (possibly
    // activity-stamped) vendor.
    const accentSettingsAgent = agent.id && lastSettings && Array.isArray(lastSettings.agents)
      ? lastSettings.agents.find((x) => x && x.id === agent.id)
      : null;
    const routedVendor = accentSettingsAgent && typeof accentSettingsAgent.vendor === "string" ? accentSettingsAgent.vendor : "";
    const orchestratorBaseline = agent.id === "orchestrator" && rowHarness === "claude-code";
    const rowAccentKind = agentAccent({
      // With a Settings entry its (possibly empty = harness-native) vendor/class are the only
      // source; the row's own stamped values are used only before settings carry the agent.
      vendor: orchestratorBaseline ? "" : (foreignInFlight ? foreignInFlight.vendor : (accentSettingsAgent ? routedVendor : agent.vendor)),
      costModelClass: accentSettingsAgent ? accentSettingsAgent.costModelClass : agent.costModelClass,
      fallbackOf: agent.fallbackOf,
      harness: rowHarness,
    });
    const displayNameWithSuffix = displayName + (rowAccentKind === "fallback" ? (agent.fallbackIsDefault ? " (dfb)" : " (fb)") : "");

    const nameTd = document.createElement("td");
    nameTd.className = `col-name${showActive ? " name--active" : ""}`;

    const nameText = document.createElement("span");
    nameText.textContent = displayNameWithSuffix;
    // Light-blue foreign-vendor accent applies only while the agent is
    // active (p70-t1); idle/done rows use the default text color. The
    // amber fallback accent marks the (fb)/(dfb) row regardless of status,
    // but only while the agent's most recent run was a fallback.
    if (showActive && rowAccentKind === "foreign") nameText.className = "agent-accent-foreign";
    else if (rowAccentKind === "fallback") nameText.className = "agent-accent-fallback";
    // Cumulative fallback history lives in the tooltip; the (fb)/(dfb)
    // suffix above reflects only the most recent run.
    if (typeof agent.fallbackCount === "number" && agent.fallbackCount > 0) {
      nameText.title = `Fell back ${agent.fallbackCount} time${agent.fallbackCount === 1 ? "" : "s"}` +
        (agent.lastFallbackModel ? `; last: ${agent.lastFallbackModel}` : "") +
        (agent.lastFallbackVia ? ` via ${agent.lastFallbackVia}` : "");
    }
    nameTd.appendChild(nameText);

    // Per-spawn instance count (liveSpawns, src/core/state.ts AgentMetric):
    // two or more concurrent Task spawns routed to the same agent id show a
    // small "xN" badge instead of collapsing into one indistinguishable
    // active card. Absent entirely when liveSpawns is undefined/<=1 (legacy
    // hook records / single live instance) — no new DOM for today's common case.
    if (Array.isArray(agent.liveSpawns) && agent.liveSpawns.length > 1) {
      const countBadge = document.createElement("span");
      countBadge.className = "agent-instance-count";
      countBadge.textContent = `×${agent.liveSpawns.length}`;
      countBadge.title = `${agent.liveSpawns.length} concurrent spawns currently routed to this agent.`;
      nameTd.appendChild(countBadge);
    }

    // Which foreign model the agent is calling through its CLI right now.
    const foreignShown = foreignInFlight || (showActive && agent.lastForeignCli && agent.lastForeignCli.vendor ? agent.lastForeignCli : null);

    // Live spawn description (currentDescription, WorkerSpawned.currentDescription):
    // this spawn's own task brief, shown as a muted secondary line only while
    // the agent is active — a stale brief under an idle/done row would read
    // as "still doing this", which it no longer is.
    if (showActive && typeof agent.currentDescription === "string" && agent.currentDescription.length > 0) {
      const descLine = document.createElement("div");
      descLine.className = "agent-spawn-desc";
      descLine.textContent = agent.currentDescription;
      descLine.title = agent.currentDescription;
      nameTd.appendChild(descLine);
    }

    // Worker report disclosure (0.0.562): agent.lastReport is the captured
    // final assistant-message text from this agent's transcript (see
    // AgentMetric.lastReport, src/core/state.ts ~123) — up to ~2000 chars of
    // prose, far too long for any table cell or tooltip. Rendered here as a
    // small click-to-expand indicator next to the agent name, revealing a
    // full-width disclosure row directly beneath this one (see
    // buildReportDisclosureRow below). An agent with no report gets NO new
    // DOM at all — no caret, no placeholder — so "never captured" stays
    // indistinguishable from "today's UI" for every pre-existing agent.
    if (typeof agent.lastReport === "string" && agent.lastReport.length > 0) {
      const reportToggle = document.createElement("button");
      reportToggle.type = "button";
      reportToggle.className = "report-toggle";
      // Reflect state carried across rebuilds in openReportAgentIds (see its
      // doc comment) rather than always starting closed — renderMetricsTable
      // re-appends the matching disclosure row right after this row when the
      // agent's id is in that Set.
      const isOpen = !!(agent.id && openReportAgentIds.has(agent.id));
      reportToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      reportToggle.title = "Show this agent's last report";
      reportToggle.textContent = "📄";
      reportToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleReportRow(row, agent);
      });
      nameTd.appendChild(reportToggle);
    }

    // Per-column tooltip: agent name + model + third-person role description.
    const role = describeRole(agent.description);
    const isOrchestratorRow = agent.id === "orchestrator";
    // For the orchestrator, `agent.model` is hook-OBSERVED (untrusted) and
    // `agent.rosterModel` carries the roster/frontmatter (trusted, "what's
    // configured") value — see panel.ts's _stampRosterModels. prettyModel's
    // first argument must always be the trusted one, so the two are swapped
    // here relative to every subagent row, where `agent.model` IS the
    // trusted roster-stamped value and there is no `rosterModel` field.
    const displayRosterModel = isOrchestratorRow ? agent.rosterModel : agent.model;
    let nameTitle = displayName;
    // Codex harness: an agent with no explicit choice runs on the harness
    // default, so show that instead of the agent file's Claude tier.
    const bridgeText = isOrchestratorRow ? null : bridgeAwareModelText(agent);
    const nameModelText = bridgeText
      ? bridgeText
      : (agent.model ? prettyModel(displayRosterModel, agent.observedModel, isOrchestratorRow) : "");
    if (nameModelText && role) {
      nameTitle = `${displayName} — ${nameModelText}\n${role}`;
    } else if (nameModelText) {
      nameTitle = `${displayName} — ${nameModelText}`;
    } else if (role) {
      nameTitle = `${displayName}\n${role}`;
    }
    nameTd.title = nameTitle;
    row.appendChild(nameTd);

    // Status bar: green while active, gray while idle. Width encodes this
    // agent's TASKS COMPLETED, normalized to the agent with the most
    // completed tasks — a dimensionless share of work done, not tokens or
    // cost (cost is carried entirely by the "Nx cheaper" badge below; both a
    // cost-scaled and a token-scaled bar made the orchestrator — priciest
    // per token and heaviest on tokens via coordination context — dwarf
    // every worker's bar even though workers complete most of the actual
    // tasks). Label is a ratio vs. the orchestrator's own model price ("Nx
    // cheaper"/"Nx pricier"/"same cost"), never an absolute $ figure —
    // subscription billing makes $/token meaningless to the user. Active
    // agents always show a visible green sliver so "working" is never
    // invisible.
    const rawPct = maxAgentTasks > 0
      ? Math.round(Math.min((agent.taskCount ?? 0) / maxAgentTasks, 1) * 100)
      : 0;
    const fillPct = showActive ? Math.max(rawPct, 15) : rawPct;
    const statusTd = document.createElement("td");
    statusTd.className = "col-status";
    statusTd.title = "Bar = tasks completed by this agent, relative to the agent with the most. Pill = the model this agent runs on; hover it for the full model id, billing type and details.";
    const track = document.createElement("div");
    track.className = "status-bar-track";
    const fill = document.createElement("div");
    let fillClass = `status-bar-fill ${showActive ? "status-bar-fill--active" : "status-bar-fill--idle"}`;
    // Active foreign/fallback agents get the accent bar fill (p24-t2);
    // native and idle rows keep today's green/gray fill unchanged.
    if (showActive && rowAccentKind === "foreign") fillClass += " agent-accent-foreign";
    else if (showActive && rowAccentKind === "fallback") fillClass += " agent-accent-fallback";
    fill.className = fillClass;
    fill.style.width = `${fillPct}%`;
    const label = document.createElement("span");
    label.className = "status-bar-label";
    // MODEL pill: the model family from the agent's own configuration. Only a foreign call in
    // flight (or the active run's last foreign call) swaps in the model that call reported.
    const tipLines = [];
    let pillModelId;
    let pillClass;
    let estimateLine = null;
    if (agent.id === "orchestrator") {
      const obs = agent.observedModel;
      pillModelId = (obs && isWellFormedClaudeModelId(obs)) ? obs : (agent.rosterModel || agent.model || obs || "");
      pillClass = agent.costModelClass || "";
    } else {
      const bi = backendIdentity(agent);
      const foreignRow = isForeignToOrchestrator(agent, opts.orchestrator);
      const configuredModel = configuredModelId(agent);
      const rowClass = foreignRow ? bi.costModelClass : (accentSettingsAgent ? accentSettingsAgent.costModelClass : agent.costModelClass);
      if (foreignShown && foreignShown.model) {
        pillModelId = foreignShown.model;
        pillClass = costModelClass(foreignShown.model);
      } else {
        pillModelId = configuredModel;
        pillClass = costModelClass(configuredModel, rowClass);
        const agentRate = modelPricePerMtok(configuredModel, rowClass);
        estimateLine = vsOrchEstimateText(configuredModel, agentRate, opts.orchestratorPrice, pillClass, foreignRow);
      }
    }
    label.textContent = modelShortName(pillModelId);
    tipLines.push(pillModelId ? String(pillModelId) : "Model unknown");
    const billing = billingTypeWords(pillClass);
    if (billing) tipLines.push(billing);
    if (foreignShown) {
      tipLines.push(foreignCliLabel(foreignShown));
    } else if (agent.lastForeignCli && agent.lastForeignCli.model) {
      tipLines.push("Uses " + modelShortName(agent.lastForeignCli.model) + " " + foreignCliLabel({ cli: agent.lastForeignCli.cli }) + " (" + agent.lastForeignCli.model + ")");
    } else if (accentSettingsAgent && accentSettingsAgent.relayServer) {
      const relayName = RELAY_SERVER_LABELS[String(accentSettingsAgent.relayServer).toLowerCase()] || String(accentSettingsAgent.relayServer);
      tipLines.push("via " + relayName);
    }
    if (estimateLine) tipLines.push(estimateLine);
    track.title = tipLines.join("\n");
    track.appendChild(fill);
    track.appendChild(label);
    statusTd.appendChild(track);
    row.appendChild(statusTd);

    const tasksTd = document.createElement("td");
    tasksTd.className = "col-tasks";
    if (agent.id === "orchestrator") {
      // The orchestrator's cell shows tasks it actually completed itself, so
      // it's comparable to every other row; the asterisk + distinct color are
      // purely a hover cue that reveals its delegation count in the tooltip.
      tasksTd.textContent = String(agent.taskCount ?? 0) + "*";
      tasksTd.style.color = "var(--vscode-textLink-foreground, #4aa3ff)";
      tasksTd.title = "Tasks the orchestrator completed itself (shown). It coordinates rather than doing the work — it dispatched " + String(agent.delegations ?? 0) + " task(s) to other agents. Not every dispatched task posts a completion; some were abandoned or never finished, so this won't match the workers' completed totals.";
    } else {
      tasksTd.textContent = String(agent.taskCount ?? 0);
      tasksTd.title = "Tasks completed by this agent — work it actually finished, not tasks merely routed to it.";
    }
    row.appendChild(tasksTd);

    const mcpTd = document.createElement("td");
    mcpTd.className = "col-mcp";
    mcpTd.title = "MCP — number of MCP tool calls this agent has made.";
    if (agent.foreignCliCalls > 0) {
      mcpTd.title += " Includes " + agent.foreignCliCalls + " call" + (agent.foreignCliCalls === 1 ? "" : "s") + " to other LLMs via their CLI.";
    }
    mcpTd.textContent = String(agent.mcpCount ?? 0);
    row.appendChild(mcpTd);

    // Show live elapsed time while active, frozen by the idle rule (see liveClockLimit).
    const liveMs = liveMsFor(agent);
    const timeTd = document.createElement("td");
    timeTd.className = "col-time";
    timeTd.title = "Active time this agent has spent working.";
    const pauseReason = liveTimePauseReason(agent);
    if (pauseReason === "idle") {
      timeTd.title += " Paused — no activity for " + Math.round(idleFreezeMs / 60000) + " min.";
    } else if (pauseReason === "tool") {
      timeTd.title += " Paused — tool call running over " + Math.round(IN_FLIGHT_CEILING_MS / 60000) + " min.";
    }
    timeTd.textContent = fmtMs(liveMs);
    row.appendChild(timeTd);

    const tokensTd = document.createElement("td");
    tokensTd.className = "col-tokens";
    const codexOrchestratorNoUsage = agent.id === "orchestrator"
      && ((lastSettings && lastSettings.harness && lastSettings.harness.effective) || "") === "codex"
      && !(agent.tokens > 0);
    if (typeof agent.tokens !== "number" || codexOrchestratorNoUsage) {
      // Harness doesn't report token usage yet (e.g. Codex today) — no
      // record at all, not a real zero. Never counted into the Total line
      // (see buildMetricsRollup).
      tokensTd.textContent = "n/a";
      tokensTd.title = "This harness does not report token usage yet";
    } else {
      const mainTokens = agent.tokens ?? 0;
      const cacheRead = agent.cacheReadTokens ?? 0;
      tokensTd.title = "Billed context tokens (input, output, cache writes) this agent has consumed. Cache reads are shown separately and cost about a tenth of input.";
      const mainSpan = document.createElement("span");
      mainSpan.textContent = fmtTokens(mainTokens);
      tokensTd.appendChild(mainSpan);
      if (cacheRead > 0) {
        const cacheSpan = document.createElement("span");
        cacheSpan.className = "col-tokens-cached";
        cacheSpan.textContent = ` + ${fmtTokens(cacheRead)} cached`;
        tokensTd.appendChild(cacheSpan);
      }
    }
    if (isActive) {
      const runHint = document.createElement("span");
      runHint.className = "col-tokens-running";
      runHint.textContent = " running…";
      runHint.title = "Tokens are added when this run finishes";
      tokensTd.appendChild(runHint);
    }
    if (isUnreportedBridgeRow(agent)) {
      const mark = document.createElement("span");
      mark.className = "col-tokens-bridge-note";
      mark.textContent = " †";
      mark.title = agent.foreignCliCalls > 0 && !(lastRoutingPayload && Array.isArray(lastRoutingPayload.agents) && lastRoutingPayload.agents.some((x) => x && x.id === agent.id && x.backend && x.backend.transport === "mcp"))
        ? "Tokens used by the other LLM's CLI are not reported — this shows only this agent's own model"
        : "Provider tokens not reported by Codex/Gemini — this shows only the Claude relay's tokens";
      mark.setAttribute("aria-label", mark.title);
      tokensTd.appendChild(mark);
    }
    row.appendChild(tokensTd);

    return row;
  }

  /**
   * Build a fresh report-disclosure `<tr>` for `agent`. Shared by
   * toggleReportRow (user click) and buildMetricsRow/renderMetricsTable
   * (restoring an already-open row after a rebuild) so the markup/classes
   * stay byte-identical between both paths. SAFETY: report text is
   * model-generated and flows in via `textContent` only — never
   * innerHTML/insertAdjacentHTML — so any markup-looking substring (e.g.
   * "<img onerror=...>") renders as inert literal text, never a DOM
   * element. Line breaks are preserved with CSS `white-space: pre-wrap`
   * (see .report-disclosure-text in style.css) rather than by converting
   * newlines to `<br>` HTML.
   * @param {{lastReport?: string}} agent
   * @returns {HTMLTableRowElement}
   */
  function buildReportDisclosureRow(agent) {
    const disclosureRow = document.createElement("tr");
    disclosureRow.className = "report-disclosure-row";
    const cell = document.createElement("td");
    cell.className = "report-disclosure-cell";
    cell.colSpan = 6;
    const pre = document.createElement("div");
    pre.className = "report-disclosure-text";
    // textContent only — this is the one place a worker's free-form report
    // text reaches the DOM; never assign via innerHTML/outerHTML here.
    pre.textContent = agent.lastReport || "";
    cell.appendChild(pre);
    disclosureRow.appendChild(cell);
    return disclosureRow;
  }

  /**
   * Toggle a disclosure `<tr>` directly beneath `row`, showing `agent`'s
   * captured `lastReport` text. Built fresh each open (removed on close, not
   * hidden) so a re-render never leaves a stale disclosure attached to a
   * detached row. Open/closed state for this agent is also recorded in
   * `openReportAgentIds` (keyed by agent.id) so renderMetricsTable's
   * periodic full rebuild (tbodyEl.innerHTML = "") can restore the row
   * instead of silently dropping it — see that Set's doc comment.
   * @param {HTMLTableRowElement} row
   * @param {{id?: string, lastReport?: string}} agent
   */
  function toggleReportRow(row, agent) {
    const next = row.nextElementSibling;
    if (next && next.classList && next.classList.contains("report-disclosure-row")) {
      next.remove();
      const btn = row.querySelector(".report-toggle");
      if (btn) btn.setAttribute("aria-expanded", "false");
      if (agent && agent.id) openReportAgentIds.delete(agent.id);
      return;
    }

    const btn = row.querySelector(".report-toggle");
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (agent && agent.id) openReportAgentIds.add(agent.id);

    row.after(buildReportDisclosureRow(agent));
  }

  /**
   * Record the CUMULATIVE agentMetrics array and paint the Metrics table for
   * whichever scope is currently selected. `lastMetrics` always holds the
   * cumulative array — see metricsScope's doc comment for why the Delegation
   * tab/Settings/roster chips must never see the "This session" scope.
   * @param {Array<Object>|undefined} metrics cumulative agentMetrics (state.agentMetrics)
   */
  function renderMetrics(metrics) {
    lastMetrics = metrics || [];
    renderMetricsTable(currentScopeMetrics());
  }

  /**
   * Paint the Metrics table's DOM from an already-scope-resolved agentMetrics
   * array (either the cumulative array or lastSessionMetrics.agentMetrics —
   * see currentScopeMetrics()). Never touches `lastMetrics`.
   * @param {Array<{id:string,name:string,status:string,taskCount:number,mcpCount:number,activeMs:number,tokens:number,model?:string,description?:string,tier?:string,parentId?:string}>|undefined} metrics
   */
  let metricsBackendRequested = false;
  function renderMetricsTable(metrics) {
    const emptyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-empty"));
    const tableEl = /** @type {HTMLElement} */ (document.getElementById("metrics-table"));
    const tbodyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tbody"));

    if (!emptyEl || !tableEl || !tbodyEl) return;

    if (!metrics || metrics.length === 0) {
      emptyEl.style.display = "";
      tableEl.hidden = true;
      return;
    }

    // The vs. orch. badge needs each agent's routed backend (settings payload)
    // and the Gemini backend state (routing payload). The VS Code host only
    // sends them on request, so ask once on the first metrics render instead
    // of waiting for the user to open Settings/Agents.
    if (!metricsBackendRequested) {
      metricsBackendRequested = true;
      if (!lastSettings) vscode.postMessage({ type: "getSettings" });
      if (!lastRoutingPayload) vscode.postMessage({ type: ROUTING_MSG.GET });
    }

    emptyEl.style.display = "none";
    tableEl.hidden = false;

    // Highest completed-task count across agents. Used to scale the status
    // bar as a tasks-completed share, not tokens or cost — cost is carried
    // by the "Nx cheaper" badge instead (see buildMetricsRow).
    const maxAgentTasks = Math.max(1, ...metrics.map(a => (a && typeof a.taskCount === "number") ? a.taskCount : 0));
    // Raw model-rate helper, NOT resolveOrchestratorPrice's blended rate —
    // the badge promises a model-rate comparison; see
    // resolveOrchestratorModelRate's doc for why the two must stay separate.
    const orchestratorPrice = resolveOrchestratorModelRate(metrics);

    // Flat list: every agent (lead or worker) gets its own equal top-level
    // row, in the existing sort order, no nesting/indentation/grouping. The
    // hook's parentId/tier data is noisy enough (leads sometimes recorded as
    // children of OTHER leads) that a lead→worker nesting pass could hide a
    // whole team's rows; a flat list can't hide anyone. See
    // docs/plan/team-lead-mode.md Phase 3 for the retired nesting approach.
    //
    // Pin the orchestrator to row 0 BY IDENTITY, same predicate/pattern as the
    // scene's throne pin (see sceneAgentList/orchIdx near "Pin the orchestrator
    // to index 0 BY IDENTITY for the SCENE only" ~line 17374): metrics is
    // append-only, first-seen-by-hook order, so on a reused/misinstalled
    // project a spawned lead can be recorded first instead of the orchestrator,
    // permanently occupying the top row. Render from a stable-partitioned COPY
    // — metrics/state.agentMetrics is never mutated — with every other agent
    // keeping its existing relative order. No-op (identical output to today)
    // when the orchestrator is already first or absent.
    let orderedMetrics = metrics;
    const orchIdx = metrics.findIndex((a) => a && a.id === "orchestrator");
    if (orchIdx > 0) {
      orderedMetrics = [metrics[orchIdx], ...metrics.slice(0, orchIdx), ...metrics.slice(orchIdx + 1)];
    }
    tbodyEl.innerHTML = "";
    for (const agent of orderedMetrics) {
      const agentRow = buildMetricsRow(agent, maxAgentTasks, { orchestratorPrice, orchestrator: metrics.find((a) => a && a.id === "orchestrator") });
      tbodyEl.appendChild(agentRow);
      // Restore an already-open report disclosure row that this full rebuild
      // just discarded (see openReportAgentIds's doc comment and the fix
      // note above toggleReportRow). Only agents that currently HAVE a
      // report can be open (toggleReportRow is the only place that adds to
      // the Set, and it's only reachable via the button rendered when
      // agent.lastReport is present), so lastReport is always available here.
      if (agent && agent.id && openReportAgentIds.has(agent.id)) {
        agentRow.after(buildReportDisclosureRow(agent));
      }
    }
    // Prune ids for agents no longer present in this metrics list so the Set
    // can't grow unbounded across a long session as agents come and go.
    if (openReportAgentIds.size > 0) {
      const presentIds = new Set(orderedMetrics.map((a) => a && a.id).filter(Boolean));
      for (const id of openReportAgentIds) {
        if (!presentIds.has(id)) openReportAgentIds.delete(id);
      }
    }

    // Footer rollup: per-vendor / per-cost-class totals, a fallback count,
    // and "local · time-based" rows for local-model items with no token
    // count (p15-t3). Appended after the per-agent rows, inside the same
    // #metrics-tbody, so the existing row/cell CSS (#metrics-table tbody
    // tr/td) applies with no new stylesheet needed. #metrics-table has 6
    // columns (Agent / Tokens-per-min badge / Tasks / MCP / Time / Tokens),
    // so every footer row spans all 6 via a single labeled cell.
    const rollup = buildMetricsRollup(metrics);
    const FOOTER_COLSPAN = 6;

    // Single compact summary row: "Total — <tokens> tokens · <N> agents ·
    // <F> fallbacks" (fallbacks omitted when zero). The per-vendor /
    // per-billing-class breakdown that used to render as up to 7 separate
    // rows now lives behind a collapsed disclosure (see
    // buildMetricsFooterBreakdownRows), toggled by
    // #metrics-footer-disclosure-btn and persisted in localStorage.
    const excludedAgents = rollup.totalAgents - rollup.reportedAgents;
    let summaryText = excludedAgents > 0
      ? `${fmtTokens(rollup.totalTokens)} tokens (${rollup.reportedAgents} agent${rollup.reportedAgents === 1 ? "" : "s"} reported)`
      : `${fmtTokens(rollup.totalTokens)} tokens · ${rollup.totalAgents} agent${rollup.totalAgents === 1 ? "" : "s"}`;
    if (rollup.totalCacheReadTokens > 0) {
      summaryText += ` (+ ${fmtTokens(rollup.totalCacheReadTokens)} cached)`;
    }
    if (rollup.fallbackCount > 0) {
      summaryText += ` · ${rollup.fallbackCount} fallback${rollup.fallbackCount === 1 ? "" : "s"}`;
    }
    appendFooterRow(
      tbodyEl,
      FOOTER_COLSPAN,
      "Total — ",
      summaryText,
      "Sum of tokens across every agent."
    );

    // The "By vendor and billing" disclosure (per-vendor / per-billing-class
    // breakdown) was removed per p73-t1: the two breakdowns double-counted
    // the same tokens and the billing-class split relied on costModelClass,
    // which most agents never set. buildMetricsRollup above still computes
    // rollup.byVendor / byCostClass / localTimeRows so tests and any future
    // use of this data keep working — only the rendering of this section
    // was removed.

    // Append the pricing disclaimer once, after the table. renderMetrics()
    // only rebuilds #metrics-tbody (not the whole #metrics-body container),
    // so guard by stable id to avoid stacking a duplicate caption on every
    // re-render.
    const metricsBodyEl = document.getElementById("metrics-body");
    if (metricsBodyEl) {
      const existingCaption = document.getElementById("metrics-stats-caption");
      if (existingCaption) existingCaption.remove();
      const pricingCaption = document.createElement("div");
      pricingCaption.id = "metrics-stats-caption";
      pricingCaption.className = "delegation-stats-caption";
      pricingCaption.textContent =
        "Relative cost badges compare published list rates and are informational only.";
      metricsBodyEl.appendChild(pricingCaption);
    }
  }

  /** Display label for a delegation mode id (the "flat" enum value renders as "Direct"). */
  const DELEGATION_MODE_LABEL = { flat: "Direct", team_leads: "Team Leads" };

  /**
   * Render the Delegation tab's content (promoted out of #metrics-body into
   * its own full-width peer tab panel; formerly "Delegation stats" — Team
   * Lead Mode Phase 4: measurement). Top to bottom: a hero savings stat, a
   * model-tier work-split breakdown, a per-agent delegation table, and the
   * original per-delegation-mode rows (kept, unchanged); the orchestrator's
   * direct tool use is now reported in TASKS, not a separate tool-call
   * meter. Also sets delegationStatsHasData, which gates whether the
   * Delegation tab button is offered at all — see updateMetricsTabsUI().
   * @param {Array<{mode:string,completedTasks:number,totalTokens:number,activeMs:number,leadTokens:number,teamTokens:number,leadOverheadPct:number|null,wallClockMs?:number}>|undefined} modeStats
   * @param {{orchestratorDirectCalls:number,workerToolCalls:number}|undefined} toolCompliance ALL-TIME (see panel.ts's _computeToolCompliance) counts of PreToolUse Read/Grep/Glob/Edit/Write/Bash calls, split orchestrator vs. every other workerId.
   */
  function renderDelegationStats(modeStats, toolCompliance) {
    const el = delegationStatsBodyEl;
    if (!el) return;

    const rows = Array.isArray(modeStats) ? modeStats.filter((m) => m && (m.completedTasks > 0 || m.totalTokens > 0)) : [];
    const delegatedAgents = lastMetrics.filter((a) => a && a.id !== "orchestrator");
    const hasAgentActivity = delegatedAgents.some((a) => (a.taskCount ?? 0) > 0 || (a.tokens ?? 0) > 0);
    delegationStatsHasData = rows.length > 0 || hasAgentActivity;

    el.innerHTML = "";
    if (!delegationStatsHasData) {
      // Nothing to show yet — bounce off this tab if it was active (mirrors
      // renderProjectPlanSection()'s fallback), and let updateMetricsTabsUI()
      // hide the button so the bar never offers an empty panel.
      if (activeMetricsTab === "delegation") setActiveMetricsTab("metrics");
      else updateMetricsTabsUI();
      return;
    }

    const heading = document.createElement("div");
    heading.className = "delegation-stats-heading";
    heading.textContent = "Delegation stats";
    el.appendChild(heading);

    // Scope caption (0.0.528): this whole tab is always ALL TIME (since the
    // last metrics reset) — it has no "This session"/"All time" toggle, only
    // the Metrics tab does. State that explicitly, once, up top, so the two
    // tabs can never be read as contradicting each other (e.g. a token total
    // here looking "wrong" next to a smaller "This session" figure on the
    // Metrics tab).
    const scopeCaption = document.createElement("div");
    scopeCaption.className = "delegation-stats-caption";
    scopeCaption.textContent =
      "All figures below are all time — totals since the last metrics reset, not scoped to the current session. Switch the Metrics tab to \"This session\" for current-session-only numbers.";
    el.appendChild(scopeCaption);

    // ── 1. Ledger ── delegated work spans different currencies (metered
    // $/token, subscription quota, local hardware); a single "% avoided"
    // headline collapsed those into one fabricated number. Replaced
    // 2026-09-07 with an honest per-currency ledger + counterfactual.
    const orchestratorPrice = resolveOrchestratorPrice(lastMetrics);
    const ledger = buildDelegationLedger(delegatedAgents, PRICE_TABLE, orchestratorPrice);

    const hero = document.createElement("div");
    hero.className = "delegation-hero";

    const ledgerHeading = document.createElement("div");
    ledgerHeading.className = "delegation-stats-heading";
    ledgerHeading.textContent = "Where delegated work ran";
    hero.appendChild(ledgerHeading);

    const meteredRow = document.createElement("div");
    meteredRow.className = "delegation-stats-row";
    if (ledger.metered.tokens > 0) {
      meteredRow.textContent = `Metered (API): ${fmtTokens(ledger.metered.tokens)} tokens`;
    } else {
      meteredRow.textContent = "Metered (API): no tokens yet";
    }
    hero.appendChild(meteredRow);
    if (ledger.metered.unknownModels.length > 0) {
      const unknownNote = document.createElement("div");
      unknownNote.className = "delegation-stats-caption";
      unknownNote.textContent = `${ledger.metered.unknownModels.length} model${ledger.metered.unknownModels.length === 1 ? "" : "s"} without a published rate excluded from the relative-cost comparison (${ledger.metered.unknownModels.join(", ")}).`;
      hero.appendChild(unknownNote);
    }

    const subRow = document.createElement("div");
    subRow.className = "delegation-stats-row";
    subRow.textContent = `Subscription: ${fmtTokens(ledger.subscription.tokens)} tokens — quota, not billed per token`;
    hero.appendChild(subRow);

    const localRow = document.createElement("div");
    localRow.className = "delegation-stats-row";
    localRow.textContent = `Local: ${fmtTokens(ledger.local.tokens)} tokens — runs on your hardware`;
    hero.appendChild(localRow);

    if (ledger.unknown.tokens > 0) {
      const unknownTasks = ledger.unknown.rows.reduce((sum, a) => sum + (a.taskCount ?? 0), 0);
      const unknownRow = document.createElement("div");
      unknownRow.className = "delegation-stats-row";
      unknownRow.textContent = `Unclassified: ${fmtTokens(ledger.unknown.tokens)} tokens (${unknownTasks} task${unknownTasks === 1 ? "" : "s"})`;
      hero.appendChild(unknownRow);
    }

    // ── Counterfactual ── what it would have cost to run the same billable
    // (non-cache-read) delegated tokens on the orchestrator's own model.
    // Cross-vendor ratios are meaningless (different tokenizers/billing), so
    // the headline ratio covers same-vendor (Claude) delegated agents only.
    const orchForCmp = lastMetrics.find((x) => x && x.id === "orchestrator");
    const foreignAgents = delegatedAgents.filter((x) => isForeignToOrchestrator(x, orchForCmp));
    const sameVendorAgents = delegatedAgents.filter((x) => !isForeignToOrchestrator(x, orchForCmp));
    const cmp = buildDelegationLedger(sameVendorAgents, PRICE_TABLE, orchestratorPrice);
    const savings = cmp.savings || { eligible: false, reason: "unavailable", agents: [] };
    const counterSection = document.createElement("div");
    if (sameVendorAgents.length === 0) {
      // No same-vendor delegated work: no ratio at all.
      counterSection.className = "delegation-stats-detail";
    } else if (cmp.counterfactualUsd == null) {
      // No published rate resolved yet for the orchestrator's model, so no
      // relative comparison can be shown — just report the token volume.
      counterSection.className = "delegation-stats-detail";
      counterSection.textContent = `Relative cost vs. running on the orchestrator's model: rate not detected yet. ${fmtTokens(cmp.billableTokens)} billable tokens delegated so far.`;
      hero.appendChild(counterSection);
    } else if (!savings.eligible) {
      // The ratio below assumes one shared, priced vendor with real
      // vendor-reported usage and a resolved orchestrator price — any other
      // mix (a foreign-harness worker, mixed vendors, an unpriced model)
      // makes the ratio fabricated, so show why instead of a number.
      counterSection.className = "delegation-stats-detail delegation-savings-hidden";
      counterSection.textContent = `Relative cost not shown: ${savings.reason}`;
      if (savings.agents.length > 0) counterSection.title = savings.agents.join(", ");
      hero.appendChild(counterSection);
    } else {
      counterSection.className = "delegation-stats-detail";
      const ratio = cmp.billedUsd > 0 ? cmp.counterfactualUsd / cmp.billedUsd : null;
      // Only claim what the numbers support: "cheaper" at >= 1.05, "roughly the
      // same" only inside 0.95-1.05. Below that (orchestrator blended rate is
      // lower, e.g. mostly discounted cache reads) or with no ratio, say nothing.
      let ratioText = null;
      if (ratio != null && ratio >= 1.05) {
        ratioText = `Delegated work ran at ${fmtRatio(ratio)}× cheaper than running the same billable tokens on the orchestrator's model (estimate, published list rates).`;
      } else if (ratio != null && ratio > 0.95) {
        ratioText = "Delegated work ran at roughly the same rate as the orchestrator's model (estimate, published list rates).";
      }
      if (ratioText) {
        counterSection.textContent = ratioText;
        hero.appendChild(counterSection);
      }

      if (ratioText) {
        const caveat = document.createElement("div");
        caveat.className = "delegation-stats-caption";
        caveat.textContent = "Subscription and local work is excluded from this comparison because it is not billed per token; spawn overhead is included in the estimate.";
        hero.appendChild(caveat);
      }
    }

    if (foreignAgents.length > 0) {
      const foreignTasks = foreignAgents.reduce((sum, a) => sum + (a.taskCount ?? 0), 0);
      const foreignNote = document.createElement("div");
      foreignNote.className = "delegation-stats-caption delegation-foreign-note";
      foreignNote.textContent = `Plus ${foreignTasks} task${foreignTasks === 1 ? "" : "s"} on other vendors (not compared).`;
      hero.appendChild(foreignNote);
    }

    const unitNote = document.createElement("div");
    unitNote.className = "delegation-stats-caption";
    unitNote.textContent = "Token counts are per vendor tokenizer and are not directly comparable across models.";
    hero.appendChild(unitNote);

    el.appendChild(hero);

    // ── Dispatched vs. completed reconciliation ── the orchestrator's
    // delegations counter counts tasks DISPATCHED (spawned); a worker's
    // taskCount only counts tasks that posted a completion. The difference is
    // dispatched tasks that were abandoned or never finished, so the two
    // totals intentionally don't match — surface it here rather than leave it
    // looking like a miscount.
    const orchestratorMetric = lastMetrics.find((a) => a && a.id === "orchestrator");
    const dispatched = orchestratorMetric ? (orchestratorMetric.delegations ?? 0) : 0;
    const completedByWorkers = delegatedAgents.reduce((sum, a) => sum + (a.taskCount ?? 0), 0);
    const unfinished = Math.max(0, dispatched - completedByWorkers);
    if (dispatched > 0) {
      const reconSection = document.createElement("div");
      reconSection.className = "delegation-section";
      const reconHeading = document.createElement("div");
      reconHeading.className = "delegation-stats-heading";
      reconHeading.textContent = "Dispatched vs. completed";
      reconSection.appendChild(reconHeading);
      const reconLine = document.createElement("div");
      reconLine.className = "delegation-stats-row";
      reconLine.textContent = `${dispatched} dispatched → ${completedByWorkers} completed by workers → ${unfinished} unfinished`;
      reconSection.appendChild(reconLine);
      const reconSub = document.createElement("div");
      reconSub.className = "delegation-stats-detail";
      reconSub.textContent = "Unfinished = dispatched tasks that never posted a completion (abandoned or never finished) — not live work.";
      reconSection.appendChild(reconSub);
      el.appendChild(reconSection);
    }

    // ── 2a. Delegated work by tier ── aggregate DELEGATED agents only
    // (never the orchestrator) by prettified model family, so the bars stay
    // in scope with the hero's "delegated work" savings figure above instead
    // of being dwarfed by the orchestrator's token-heavy Opus coordination.
    const tierMap = new Map(); // family -> {tasks, tokens} (same-vendor only)
    const otherMap = new Map(); // backend model -> {tasks, tokens} (foreign vendors)
    const tierOrch = lastMetrics.find((x) => x && x.id === "orchestrator");
    for (const a of delegatedAgents) {
      if (!a) continue;
      const tasks = a.taskCount ?? 0;
      const tokens = (a.tokens ?? 0) + (a.cacheReadTokens ?? 0);
      if (tasks === 0 && tokens === 0) continue;
      const foreign = isForeignToOrchestrator(a, tierOrch);
      const target = foreign ? otherMap : tierMap;
      const family = foreign
        ? ((harnessDefaultFor(a) || {}).label || shortModelLabel(backendModelFor(a) || a.model || "") || "Unknown")
        : (a.model ? prettyModel(a.model, a.observedModel).split(" ")[0] : "Unknown");
      const entry = target.get(family) || { tasks: 0, tokens: 0 };
      entry.tasks += tasks;
      entry.tokens += tokens;
      target.set(family, entry);
    }
    const renderTierGroup = (map, headingText, showPct) => {
      if (map.size === 0) return;
      const tierSection = document.createElement("div");
      tierSection.className = "delegation-section";
      const tierHeading = document.createElement("div");
      tierHeading.className = "delegation-stats-heading";
      tierHeading.textContent = headingText;
      tierSection.appendChild(tierHeading);

      const totalTierTokens = Math.max(1, [...map.values()].reduce((sum, v) => sum + v.tokens, 0));
      const tierEntries = [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
      for (const [family, v] of tierEntries) {
        const tierRow = document.createElement("div");
        tierRow.className = "delegation-tier-row";

        const nameEl = document.createElement("span");
        nameEl.className = "delegation-tier-name";
        nameEl.textContent = family;
        nameEl.title = family;
        tierRow.appendChild(nameEl);

        const pct = Math.round((v.tokens / totalTierTokens) * 100);
        const track = document.createElement("div");
        track.className = "delegation-tier-bar-track";
        const fill = document.createElement("div");
        fill.className = "delegation-tier-bar-fill";
        fill.style.width = showPct ? `${v.tokens > 0 ? Math.max(pct, 2) : 0}%` : "0%";
        track.appendChild(fill);
        tierRow.appendChild(track);

        const meta = document.createElement("span");
        meta.className = "delegation-tier-meta";
        meta.textContent = `${v.tasks} task${v.tasks === 1 ? "" : "s"} · ${fmtTokens(v.tokens)} tokens${showPct ? ` · ${pct}%` : ""}`;
        tierRow.appendChild(meta);

        tierSection.appendChild(tierRow);
      }
      el.appendChild(tierSection);
    };
    renderTierGroup(tierMap, "Delegated work by tier", true);
    // Other vendors: tokenizers differ, so no bar or % share across them.
    renderTierGroup(otherMap, "Other vendors (not compared)", false);

    // ── 2b. Coordination (not delegated work) ── the orchestrator's own
    // Opus usage, called out separately rather than folded into the tier
    // bars above. It's typically the single biggest token bucket (it
    // re-processes the whole conversation every turn) but it isn't
    // delegated WORK, so it gets a labeled line instead of a competing bar.
    const orch = lastMetrics.find((a) => a && a.id === "orchestrator");
    if (orch && ((orch.tokens ?? 0) > 0 || (orch.taskCount ?? 0) > 0)) {
      const coordSection = document.createElement("div");
      coordSection.className = "delegation-section";
      const coordHeading = document.createElement("div");
      coordHeading.className = "delegation-stats-heading";
      coordHeading.textContent = "Coordination (not delegated work)";
      coordSection.appendChild(coordHeading);

      const coordLine = document.createElement("div");
      coordLine.className = "delegation-stats-row";
      const orchTasks = orch.taskCount ?? 0;
      // orch.model is hook-OBSERVED (untrusted) for the orchestrator; the
      // trusted roster/frontmatter value lives on orch.rosterModel — see
      // panel.ts's _stampRosterModels and buildMetricsRow's identical swap.
      const coordModel = prettyModel(orch.rosterModel, orch.observedModel, true);
      coordLine.textContent = `${coordModel ? `Orchestrator (${coordModel})` : "Orchestrator"} · ${orchTasks} task${orchTasks === 1 ? "" : "s"} · ${codexOrchTokensNa(orch) ? "n/a" : fmtTokens((orch.tokens ?? 0) + (orch.cacheReadTokens ?? 0))} tokens`;
      coordSection.appendChild(coordLine);

      const coordSub = document.createElement("div");
      coordSub.className = "delegation-stats-detail";
      coordSub.textContent =
        "The orchestrator should run on Opus or higher. Delegation lowers the cost of the WORK, not the coordinator — so this is the biggest single token bucket, and it is expected.";
      coordSection.appendChild(coordSub);

      // This used to be a separate "Orchestrator direct tool use" section
      // reporting Grep/Read/Edit call COUNTS from a hook-attributed
      // delegationHealth payload. Removed: tasks and tool calls are
      // different units (one task legitimately makes dozens of calls), and
      // the call-count attribution itself is unreliable (a shared LIFO
      // active-agent stack without a lock misattributes concurrent sibling
      // subagents' calls to "orchestrator"). orchTasks above is read from
      // the SAME lastMetrics entry the Metrics tab's orchestrator row uses
      // (see renderMetrics ~L13148, tasksTd ~L13116), so the two numbers
      // cannot drift apart — this caption just adds the coordination-cost
      // framing that used to live on the separate section.
      const coordCaption = document.createElement("div");
      coordCaption.className = "delegation-stats-caption";
      coordCaption.textContent = "Zero tasks ≠ zero tokens: coordinating each delegation costs orchestrator tokens — still far cheaper than doing the work on this model.";
      coordSection.appendChild(coordCaption);

      el.appendChild(coordSection);
    }

    // ── 3. Per-agent delegation table ── every non-orchestrator agent with
    // any recorded tasks or tokens, sorted by tokens (falling back to
    // tasks) descending. Cost share (%) uses the same estCostUSD/
    // modelPricePerMtok cost lens as the Metrics table's "vs. orch." column.
    const tableAgents = delegatedAgents
      .filter((a) => (a.taskCount ?? 0) > 0 || (a.tokens ?? 0) > 0)
      .slice()
      .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || (b.taskCount ?? 0) - (a.taskCount ?? 0));
    if (tableAgents.length > 0) {
      const agentSection = document.createElement("div");
      agentSection.className = "delegation-section";
      const agentHeading = document.createElement("div");
      agentHeading.className = "delegation-stats-heading";
      agentHeading.textContent = "By agent";
      agentSection.appendChild(agentHeading);

      // Share is a same-vendor comparison only: foreign-vendor agents show "—"
      // and are left out of the denominator (no cross-vendor cost comparison).
      const tableOrch = lastMetrics.find((x) => x && x.id === "orchestrator");
      const isForeignRow = (a) => isForeignToOrchestrator(a, tableOrch);
      const totalCost = tableAgents.reduce((sum, a) => sum + (isForeignRow(a) ? 0 : (estCostUSDWithCache(a.tokens, a.cacheReadTokens, a.model, a.costModelClass) ?? 0)), 0);

      const table = document.createElement("table");
      table.className = "delegation-agent-table";
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      const headCols = [
        { label: "Agent", cls: "col-name" },
        { label: "Model", cls: "col-model" },
        { label: "Tasks", cls: "col-tasks" },
        { label: "Tokens", cls: "col-tokens" },
        { label: "Share", cls: "col-share" },
      ];
      for (const { label, cls } of headCols) {
        const th = document.createElement("th");
        th.textContent = label;
        th.className = cls;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const a of tableAgents) {
        const tr = document.createElement("tr");

        const nameTd = document.createElement("td");
        nameTd.className = "col-name";
        nameTd.textContent = a.name || a.id;
        nameTd.title = a.name || a.id;
        tr.appendChild(nameTd);

        // Model cell: abbreviated id (shortModelLabel) keeps the column
        // narrow — vendor and billing class (subscription/local) move to a
        // small muted suffix plus a full-text title tooltip, rather than
        // inline text like "Sonnet 5 (OpenAI, quota)" that used to blow the
        // column out. Guarded — records without vendor/costModelClass
        // (older sessions, the orchestrator row) render with no suffix.
        const modelTd = document.createElement("td");
        modelTd.className = "col-model";
        // Bridged agents (Grok/Codex/Mistral Reviewer...) run a Claude relay
        // wrapper; show the routed backend's model and vendor/billing instead.
        const bi = backendIdentity(a);
        const bridged = isForeignRow(a);
        const rowHd = harnessDefaultFor(a);
        const backendModel = bridged ? backendModelFor(a) : null;
        const shownModel = backendModel || a.model;
        const fullModelLabel = backendModel ? (rowHd ? `${rowHd.label} (${backendModel}, harness default)` : (bridgeAwareModelText(a) || backendModel)) : (a.model ? prettyModel(a.model, a.observedModel, a.id === "orchestrator") : "—");
        modelTd.textContent = rowHd ? rowHd.label : shownModel ? shortModelLabel(shownModel) : "—";
        const effVendor = bridged ? bi.vendor : a.vendor;
        const effClass = bridged ? bi.costModelClass : a.costModelClass;
        const modelVendor = effVendor && effVendor !== "anthropic" ? vendorLabelFor(effVendor) : null;
        const modelCostTag = effClass === "subscription" ? "quota" : effClass === "local" ? "local" : null;
        const modelExtras = [modelVendor, modelCostTag].filter(Boolean);
        if (modelExtras.length) {
          const suffix = document.createElement("span");
          suffix.className = "delegation-model-suffix";
          suffix.textContent = ` (${modelExtras.join(", ")})`;
          modelTd.appendChild(suffix);
        }
        modelTd.title = modelExtras.length ? `${fullModelLabel} (${modelExtras.join(", ")})` : fullModelLabel;
        tr.appendChild(modelTd);

        const tasksTd = document.createElement("td");
        tasksTd.className = "col-tasks";
        tasksTd.textContent = String(a.taskCount ?? 0);
        tr.appendChild(tasksTd);

        const tokensTd = document.createElement("td");
        tokensTd.className = "col-tokens";
        tokensTd.textContent = fmtTokens((a.tokens ?? 0) + (a.cacheReadTokens ?? 0));
        tr.appendChild(tokensTd);

        const shareTd = document.createElement("td");
        shareTd.className = "col-share";
        const cost = estCostUSDWithCache(a.tokens, a.cacheReadTokens, a.model, a.costModelClass);
        shareTd.textContent = !isForeignRow(a) && cost != null && totalCost > 0 ? `${Math.round((cost / totalCost) * 100)}%` : "—";
        tr.appendChild(shareTd);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      agentSection.appendChild(table);
      el.appendChild(agentSection);
    }

    // ── 4. Per-delegation-mode rows (kept, unchanged from the original
    // "Delegation stats" block) ──
    if (rows.length > 0) {
      const modeSection = document.createElement("div");
      modeSection.className = "delegation-section";
      const modeHeading = document.createElement("div");
      modeHeading.className = "delegation-stats-heading";
      modeHeading.textContent = "By delegation mode";
      modeSection.appendChild(modeHeading);

      const modeCaption = document.createElement("div");
      modeCaption.className = "delegation-stats-caption";
      modeCaption.textContent =
        "Tasks completed by every agent running in that mode, including the orchestrator.";
      modeSection.appendChild(modeCaption);

      for (const m of rows) {
        const label = DELEGATION_MODE_LABEL[m.mode] || m.mode;
        const tokensPerTask = m.completedTasks > 0 ? Math.round(m.totalTokens / m.completedTasks) : 0;

        const row = document.createElement("div");
        row.className = "delegation-stats-row";

        const nameEl = document.createElement("span");
        nameEl.className = "delegation-stats-mode";
        nameEl.textContent = label;
        row.appendChild(nameEl);

        const detail = document.createElement("span");
        detail.className = "delegation-stats-detail";
        let text = `${m.completedTasks} task${m.completedTasks === 1 ? "" : "s"} · ${fmtTokens(m.totalTokens)} tokens · ${fmtTokens(tokensPerTask)}/task`;
        if (m.mode === "team_leads" && m.leadOverheadPct !== null) {
          text += ` · lead overhead ${m.leadOverheadPct.toFixed(1)}% of team tokens`;
        }
        // activeMs is the mode's total active time summed across its
        // agents; unlike wallClockMs it persists after agents stop
        // (workStartAt nulls on stop), so throughput keeps showing
        // post-run instead of "—".
        const modeTokPerSec = (typeof m.activeMs === "number" && m.activeMs > 0)
          ? m.totalTokens / (m.activeMs / 1000)
          : 0;
        text += ` · Throughput: ${modeTokPerSec > 0 ? fmtTokensPerSec(modeTokPerSec) : "—"}`;
        detail.textContent = text;
        row.appendChild(detail);

        modeSection.appendChild(row);
      }
      el.appendChild(modeSection);
    }

    // ── 5. Delegation compliance ── the orchestrator's share of direct
    // PreToolUse tool calls (Read/Grep/Glob/Edit/Write/Bash) vs. every other
    // workerId, ALL-TIME (see panel.ts's _computeToolCompliance — a
    // dedicated raw-record tally, distinct from the per-agent
    // directSearches/directReads/directEdits counters used elsewhere on this
    // tab, because those never count Bash at all). Below 20 combined calls
    // the ratio is noise, so nothing renders rather than a misleading
    // percentage off a handful of calls.
    if (toolCompliance && typeof toolCompliance === "object") {
      const direct = toolCompliance.orchestratorDirectCalls ?? 0;
      const worker = toolCompliance.workerToolCalls ?? 0;
      const total = direct + worker;
      if (total >= 20) {
        const pct = Math.round((direct / total) * 100);
        const complianceSection = document.createElement("div");
        complianceSection.className = "delegation-section";
        const complianceHeading = document.createElement("div");
        complianceHeading.className = "delegation-stats-heading";
        complianceHeading.textContent = "Delegation compliance";
        complianceSection.appendChild(complianceHeading);

        const complianceLine = document.createElement("div");
        complianceLine.className = "delegation-stats-row delegation-compliance-line";
        if (pct > 50) complianceLine.classList.add("hook-bad");
        else if (pct >= 25) complianceLine.classList.add("hook-warn");
        complianceLine.textContent = `Orchestrator ran ${pct}% of tool calls directly (${direct} of ${total}).`;
        complianceSection.appendChild(complianceLine);

        if (pct >= 25) {
          const complianceSub = document.createElement("div");
          complianceSub.className = "delegation-stats-caption";
          complianceSub.textContent =
            "High direct-tool share usually means searches and edits are not being delegated. Doctrine and keyword routing may need a look.";
          complianceSection.appendChild(complianceSub);
        }

        el.appendChild(complianceSection);
      }
    }

    const pricingCaption = document.createElement("div");
    pricingCaption.className = "delegation-stats-caption";
    pricingCaption.textContent =
      "Relative cost badges compare published list rates and are informational only.";
    el.appendChild(pricingCaption);

    updateMetricsTabsUI();
  }

  // Re-render once a second so any active agent's live time keeps advancing
  // between state pushes.
  // Skipped while the panel is hidden; a visibilitychange repaint catches up.
  setInterval(() => {
    if (!document.hidden && lastMetrics.length && lastMetrics.some((a) => (a.status || "").toLowerCase() === "active")) {
      renderMetrics(lastMetrics);
    }
    // Advisory-only stall check: re-render the plan section when the
    // isPlanStalled() verdict actually flips, so the note can appear/disappear
    // without waiting for a new PLAN_STATE/state push.
    if (projectPlanEnabled) {
      const stalled = isPlanStalled();
      if (stalled !== lastPlanStallState) {
        lastPlanStallState = stalled;
        renderProjectPlanSection();
      }
    }
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && lastMetrics.length) renderMetrics(lastMetrics);
  });

  // ── Settings (Phase 2) ──────────────────────────────────────────

  /**
   * Most recent settings payload from the host.
   * @type {{hook:{installed:boolean,lastActivityAt:number|null}, agents:Array<{id:string,name:string,model:("opus"|"sonnet"|"haiku"|null),isOrchestrator:boolean,keywords:string}>}|null}
   */
  let lastSettings = null;

  /**
   * Id of the agent whose model radio the user JUST clicked, if any. Set the
   * instant a model radio's change handler fires and consumed (read once,
   * then cleared) the next time the agent rows re-render. Purpose: suppress
   * that one agent's "Could run on X" recommendation badge for exactly the
   * render immediately following the user's own explicit pick, so the
   * suggestion never appears in the same instant as — and right next to —
   * the choice the user just made. Deliberately not a timer/TTL: it is
   * cleared on the very next render regardless of how much time passed,
   * and it is not persisted across panel reloads.
   * @type {string|null}
   */
  let justSetAgentModelId = null;

  /**
   * Most recent Path Health probe results, pushed alongside "installState"
   * (see src/host/vscode/pathHealth.ts's probePathHealth /
   * detectVerseExtensionState, wired through panel.ts's
   * _handleCheckInstall). Kept separate from lastSettings because it arrives
   * on a different message ("installState", not "settings") — renderSettings()
   * reads both. Re-probed by SET_PATH_OVERRIDE/CLEAR_PATH_OVERRIDE/
   * REFRESH_PATH_HEALTH, each of which makes the host re-push "installState".
   * @type {Array<{key:string,label:string,description:string,resolvedPath:(string|null),source:("override"|"env"|"auto-detected"|"not-found"),exists:boolean,candidates:Array<{origin:string,location:string}>}>}
   */
  let lastPathHealth = [];
  /** Where `.claude/tycoon/uefn-paths.json` lives — shown so the user can find/edit it by hand too. @type {string|null} */
  let lastPathOverridesFilePath = null;
  let lastPathOverridesFileExists = false;
  /**
   * Three-state Verse extension report (enabled / installed-but-disabled /
   * not-installed) — see pathHealth.ts's detectVerseExtensionState doc
   * comment for why the three states carry different guidance.
   * @type {{state:("enabled"|"disabled"|"not-installed"),enabledVersion:(string|null),versionsFound:Array<{version:string,ideDir:string,extensionDir:string}>,multipleVersions:boolean,message:string}|null}
   */
  let lastVerseExtensionState = null;
  /**
   * Machine-level "is UEFN installed on this machine" signal from
   * installState's `uefnInstalled` field (see panel.ts's detectUefnProject) —
   * distinct from `uefnDetected` (this PROJECT has UEFN files). Gates the
   * compact "UEFN health" summary line in Settings (see
   * buildUefnHealthSummaryRow): when false, nothing UEFN-related renders in
   * Settings at all, so a non-UEFN project never sees UEFN content.
   * @type {boolean}
   */
  let lastUefnInstalled = false;
  /**
   * Serialized snapshot of the last-applied pathHealth/pathOverridesFilePath/
   * pathOverridesFileExists/verseExtensionState/uefnInstalled, used to gate
   * the "installState" handler's renderSettings()/renderUefnModalBody() calls
   * to genuine changes only — see that handler below. A full rebuild on
   * every installState push would wipe unsaved text in any other open
   * Settings input (e.g. a keyword-routing box mid-edit); a NOP-only push
   * (nothing about paths/UEFN changed) must not trigger one.
   * @type {string|null}
   */
  let lastPathHealthSnapshot = null;

  /** Cost weight by model (relative price); used for savings estimates. */
  const COST_WEIGHT = { opus: 12, sonnet: 3, haiku: 0.8 };

  /** Relative capability/cost rank of each model (lower = cheaper/lighter). */
  const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };

  /**
   * Highest model an agent should normally need. When an agent is set above
   * its floor we proactively suggest stepping down to the cheaper model.
   * NOT exhaustive — only agents with a genuinely cheap, read-only default
   * appear here. An entry's floor must never rank below that agent's
   * roster default in packCatalog.ts: testing-specialist was removed from
   * this table because its "haiku" floor contradicted the roster's
   * "sonnet" default, producing a user-visible bug where choosing Sonnet
   * immediately surfaced an "Apply Haiku" suggestion that reverted the
   * pick. Keep this table and packCatalog.ts's roster models in agreement.
   */
  const SUGGESTED_MAX = {
    "search-retrieval": "haiku",
  };

  /**
   * Format a timestamp as a short relative time ("3m ago", "—" if null).
   * @param {number|null|undefined} ts
   * @returns {string}
   */
