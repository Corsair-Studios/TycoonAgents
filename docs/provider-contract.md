# Foreign-Model Provider Contract (FROZEN — Phase 1, task p1-t3)

**Status: frozen reference.** Phases 2-6 of the foreign-model bridge MUST cite this
document rather than re-deriving the interface. If a later phase needs a field this
contract does not define, that is a contract-amendment task against this file, not a
local workaround in phase code.

Grounded entirely in `docs/codex-mcp-probe-findings.md` (referenced below as "the
probe doc", by section number). Only one provider — Codex, over its `mcp-server` stdio
transport — has been empirically probed. The local-provider (Ollama / LM Studio HTTP
server) column below is reasoned, not measured; every local-provider line is a design
judgment made now so the seam is ready when phase work implements a local provider,
not a verified fact.

---

## THE load-bearing finding: session continuity is process-lifetime-bound

Codex thread/session state lives only inside one running `codex mcp-server` child
process. A `codex-reply` sent to a *new* server process, quoting a `threadId` from an
*earlier, now-exited* process, fails in ~1ms with `"Session not found for thread_id:
..."` (probe doc Section 2, Attempt A). Continuity is proven to work only within a
single live process/connection (Section 2, Attempt B). Whether it survives a *client*
disconnect/reconnect to a still-running server process is unverified (Open Question 1)
— treat that as unknown, not as "probably fine."

This is the single most architecturally consequential finding in the probe doc.
**Phase 5's bounded cross-model consensus protocol has exactly two viable designs
because of it:**

1. Hold one `codex mcp-server` process open for the full duration of the exchange
   (all rounds, both directions), and use `codex-reply`/`threadId` for continuation.
2. Treat Codex as stateless across calls: never rely on `threadId` continuity at all,
   and instead carry the full conversation history client-side, re-sending it as
   context in every `invoke`/fresh-thread call.

Any design that starts a new server process per round while assuming `threadId`
survives is broken by this finding and must not be built.

---

## Scope note: what this contract does NOT cover

- The Codex **app-server v2** JSON-RPC surface (`getAccountRateLimits`,
  `AccountRateLimitsUpdatedNotification`) is a separate transport from the
  `codex`/`codex-reply` MCP tools this contract targets. The probe doc (Section 7)
  found that surface *might* expose proactive usage-percent data the plain MCP tools
  do not, but it was never probed. Out of scope here; a future contract amendment
  would be needed if a phase decides to add it.
- Streaming/partial output. The probe only observed complete `tools/call` responses
  (plus interleaved `codex/event` notifications used for internal retry bookkeeping,
  not exposed to callers). No streaming contract is defined.
- Tool-use / function-calling passthrough for either provider.
- Cost/token accounting fields — `costModelClass` (below) classifies the *billing
  model*, not a live token-usage counter. The probe doc found no per-call usage field
  forwarded to `tools/call` responses (Section 7).
- Multi-provider routing/selection policy (which provider to use when, credit-pressure
  offload UX, adversarial-review/consensus orchestration logic). This doc defines the
  provider seam only; those are phase 4-6 concerns that consume this seam.
- Non-Windows behavior. Every Codex finding below was reproduced on Windows only
  (probe doc Section 6, Open Question 7 flags this explicitly for the binary-absent
  case, and it applies generally — nothing here was verified on macOS/Linux).

---

## 1. `invoke(prompt, options) -> {sessionId, content}`

Starts a new conversation/session and returns its first response.

**Codex populates this as:** the `codex` tool call. `prompt` maps directly to the
required `prompt` argument. `options` maps to the optional arguments observed in the
probe: `model`, `config`, `sandbox` (enum `read-only|workspace-write|danger-full-access`),
`approval-policy` (enum `untrusted|on-failure|on-request|never`), `cwd`,
`base-instructions`, `developer-instructions`, `profile`, `compact-prompt`. The return
shape is `structuredContent: {threadId, content}` (probe doc Section 1) — `sessionId`
in this contract maps to Codex's `threadId`, and `content` maps directly. Latency for a
real model call was 20-50s in the probe (Section 1: 21,619ms and 25,642ms; Section 3B:
49,303ms) — callers must budget for tens of seconds, not a fast RPC.

**A local provider would populate this as:** an HTTP POST to the local server's
completion/chat endpoint (e.g. Ollama's `/api/chat`, LM Studio's OpenAI-compatible
`/v1/chat/completions`) with `prompt` as the message content. `sessionId` would be
either N/A (if the local server is stateless per-request, which is the common case for
both Ollama and LM Studio's plain completion endpoints — no server-side thread concept)
or a client-generated identifier the local provider adapter invents to key its own
client-side history buffer. This is a design judgment: the local provider almost
certainly has to *simulate* sessions by replaying conversation history in each request
body, rather than the server holding state, since neither Ollama nor LM Studio's
standard APIs expose a durable thread/session object comparable to Codex's `threadId`.

## 2. `continue(sessionId, prompt) -> {sessionId, content}`

Continues an existing conversation, given its session identifier.

**Codex populates this as:** the `codex-reply` tool call, requiring `prompt` +
`threadId`. Returns the same `{threadId, content}` shape (probe doc Section 2, Attempt
B — `PURPLE-NARWHAL-42` correctly recalled from the prior turn with no reminder in the
follow-up prompt, proving genuine server-side state, not client-side replay). **Hard
constraint carried from the finding above: this only works if the same
`codex mcp-server` process that issued `sessionId` is still running.** If it is not,
the call fails fast (~1ms) with an `isError:true` result whose text is `"Session not
found for thread_id: {id}"` — this is a distinct, recognizable failure text a caller
can special-case (e.g. to retry via a fresh `invoke` with replayed history) rather than
treating as a generic error. Reply-call latency when the session is live was much
lower than a fresh `invoke` (2,113ms in Section 2B vs. 21,619ms for the initiating call
in the same chain) — continuation calls are cheaper/faster than session-opening calls.

**A local provider would populate this as:** the adapter appends `prompt` to its
client-side-held history for `sessionId` and re-POSTs the full accumulated
message array to the same chat endpoint used by `invoke`. There is no server-side
session to "not find" — a local provider's `continue` cannot fail with a Codex-style
"session not found," because the state never left the client. This is functionally
closer to design option 2 in the continuity section above (carry history client-side)
than to Codex's genuine server-side continuity, and that asymmetry is real and should
not be hidden behind a uniform interface that implies both providers hold state the
same way.

## 3. `capabilities()`

Reports which optional parameters/behaviors this provider honors, so callers (and the
phase 4-6 orchestration logic) can degrade gracefully across providers rather than
hardcoding Codex-shaped options.

**Codex populates this as:** a static/near-static capability set reflecting the fields
enumerated in Section 1 above — `model` (confirmed to take precedence over the user's
`~/.codex/config.toml` pin; probe doc Section 3B, though note the caveat that the
self-reported identifier collapsed the `-mini` variant suffix, so *exact* variant
honoring is unconfirmed per Open Question 3), `sandbox`, `approval-policy`, `cwd`,
`base-instructions`, `developer-instructions`, `profile`, `compact-prompt`, `config`.
Also: session continuity capability = true, but scoped ("process-lifetime-bound," per
the finding above) rather than unconditionally true — `capabilities()` should surface
that scoping, not just a boolean, so callers relying on continuity can check it.

**A local provider would populate this as:** `model` = yes (most local servers support
selecting a loaded model per-request); `sandbox`, `approval-policy`, `cwd`,
`base-instructions`/`developer-instructions`/`profile`/`compact-prompt` = **N/A, not a
smaller version of the same thing**. These four-plus fields are Codex-*agent* concepts
— they exist because Codex can execute shell commands and edit files inside a sandbox
that needs a working directory and an approval policy for those actions. A plain local
completion server (Ollama, LM Studio) has no agentic execution loop, no filesystem
sandbox, and no approval gate to configure — there is nothing for these options to
mean. Reporting them as "false" would wrongly imply they're a withheld feature the
local provider might someday support; N/A is the honest signal that the concept itself
doesn't apply to a text-completion server. Session-continuity capability = false in the
Codex sense (no server-side thread) but the adapter can still offer client-side-history
continuity, which `capabilities()` should represent as a distinct capability, not
conflated with Codex's server-side kind.

## 4. `costModelClass`

Exactly three values, each with a one-line definition:

- **`metered`** — per-token billing with a marginal cost on every call (e.g. the
  Anthropic API this orchestrator itself runs on).
- **`subscription`** — flat-rate plan with quota windows and no marginal per-token
  cost within the window (e.g. Codex running under a ChatGPT Plus/Pro account).
- **`local`** — runs on the user's own hardware, zero marginal cost, constrained by
  VRAM/latency rather than by credits or quota windows.

**Codex populates this as:** `subscription`. Grounded directly in probe doc Section 7:
quota exhaustion produces `UsageLimitReachedError` messages tied to plan tiers ("Plus
plan... visit .../usage to purchase more credits," "Your workspace is out of
credits," "You hit your spend cap...") and `resets_at`/time-window language ("try
again at {time}") — this is quota-window-with-reset behavior, not per-token metering.
No per-call token-cost figure was ever observed in a `tools/call` response.

**A local provider would populate this as:** `local`. N/A for any quota/reset
machinery — an Ollama or LM Studio server has no account, no plan tier, no spend cap;
its limiting factor is the host machine's VRAM/RAM and generation speed, not a
credit ledger. This value is definitional rather than inferred from a probe (no local
provider has been probed yet), but it follows directly from the three-way definition
above and the project's stated near-term goal of running local models.

## 5. Failure taxonomy

Six categories, mapped 1:1 onto the failure modes actually reproduced or sourced in
the probe doc (Sections 4-7). Each entry: how Codex signals it, how reliable that
detection is, and how a local HTTP provider would signal the same category.

**auth-missing** — Codex: two sub-shapes, both `isError:true` with plain text in
`content[0].text` (the universal shape; see note below), but distinguishable from each
other. (a) No auth file at all → real network round trip, ends in
`"unexpected status 401 Unauthorized: ..."` with a `cf-ray` header, ~14s latency, ~10
retries across WebSocket+HTTPS fallback (Section 5, Case A — reproduced live). (b)
Auth file present but malformed/wrong-shape → local-only failure, no network call,
`"Token data is not available."`, `http_status_code: null` (Section 5, Case B —
reproduced live). Detection reliability: high for both — the message text is
consistent and reproducible, and `http_status_code` presence/absence cleanly separates
the two sub-cases if the caller can see that field; latency alone is also a usable
(if cruder) signal (~14s vs. near-instant). **Local provider:** HTTP 401/403 from the
local server's API (if it implements auth at all — many local dev setups run with no
auth), or connection-level failure if the local server requires a config file/API key
the adapter never supplied. Most local Ollama/LM Studio setups run unauthenticated, so
this category may simply not apply locally in the common case — noted as a real
asymmetry, not glossed over.

**binary-absent** — Codex: two distinct OS-level shapes depending on invocation style,
NOT a single reliable check (Section 6). With `shell:false`, a truly nonexistent path
fails at the Node layer via `err.code === 'ENOENT'` before any process starts. But the
real `codex` invocation requires `shell:true` on Windows (established in p1-t1,
because `codex` resolves through a `.cmd` shim) — under `shell:true`, a missing command
does NOT produce ENOENT; it exits with code 1 and a `cmd.exe`-specific stderr
(`"'X' is not recognized as an internal or external command..."`). Detection
reliability: **ENOENT alone is insufficient** — a correct detector must also treat a
nonzero exit with empty stdout and a "not recognized"/"command not found"-shaped
stderr as the same condition. The exact stderr text is confirmed Windows/cmd.exe-only
(Open Question 7); the POSIX equivalent (`command not found`) is expected by analogy
but was never reproduced. **Local provider:** connection-refused (ECONNREFUSED) or
request timeout against the local server's HTTP endpoint — there is no "binary" to
invoke at all for an HTTP-server-based local provider, so this category becomes
"server unreachable" rather than "executable missing." This is a genuine category
reinterpretation, not a 1:1 mechanical mapping, and is called out as such.

**quota-exhausted** — Codex: same universal `isError:true` + plain-text shape as every
other error (Section 7, sourced from `codex-rs/protocol/src/error.rs` and
`codex_tool_runner.rs`, not live-reproduced by design to avoid spending the user's real
quota window). Detection is **text pattern-matching only** — no structured
`rate_limit_reached_type`/`resets_at` field is forwarded to the `tools/call` response;
only the human-readable `Display` string is. Match on substrings: `"usage limit"`,
`"spend cap"`, `"out of credits"`. Reliability: moderate — the message wording is
plan-tier-dependent (four distinct templates cited in Section 7) and could change
without notice since it's prose, not a code; whether a genuine 429 additionally carries
an HTTP-status wrapper analogous to the 401 auth case is explicitly unverified (Open
Question 5) and must not be assumed. **Local provider:** N/A in the Codex sense — a
local model has no subscription quota to exhaust. The closest local analogue is a
resource-exhaustion failure (out-of-VRAM, OOM-killed process, or the local server's own
concurrency/queue-length limit if it enforces one), which is a different underlying
cause reported through a structurally similar "the request failed for a resource
reason" shape, not a true equivalent — kept as a separate note rather than folded into
quota-exhausted's Codex detection rule.

**malformed-request** — Codex: same universal shape, but this is the **one category
with a documented fast/local latency signature**: 9ms, no `codex/event` notification,
no threadId issued, confirmed zero quota spent (Section 4 — invalid `sandbox` enum
value `"banana"`, message `"Failed to parse configuration for Codex tool: unknown
variant 'banana', expected one of 'read-only', 'workspace-write',
'danger-full-access'"`). Detection reliability: high for *this* case, but validation
order is unconfirmed generally — Section 4's request had `prompt` omitted AND `sandbox`
invalid simultaneously, and validation stopped at the first bad field (`sandbox`); it
is unknown whether an otherwise-valid request missing only `prompt` produces a
differently-shaped message (Open Question 4). **Local provider:** HTTP 400 from the
local server for a malformed request body (e.g. invalid JSON, unknown parameter, model
name not loaded) — this maps more cleanly than most categories since both are
essentially "the request was well-formed transport-wise but semantically invalid,"
though the exact validation rules and error text are entirely local-server-implementation-specific
and unverified here.

**network-error** — Codex: not independently reproduced as its own case in the probe
doc, but implicit in Section 5 Case A's retry mechanics (`stream_error` over
WebSocket, 5 retries, then HTTPS fallback, 5 more retries, before surfacing the final
401). A pure network-unreachable condition (no DNS, connection refused to
`api.openai.com`) would plausibly hit the same `stream_error` retry path and eventually
surface as `isError:true` with a network-shaped message — but this specific scenario
(network down, valid auth) was never isolated and tested; carrying that gap forward
rather than asserting it. **Local provider:** this is the most likely everyday failure
for a local provider — connection refused or timeout to `http://localhost:<port>`,
because the local server process isn't running. Detection is a standard HTTP client
connection error, reliable and immediate (no retry-storm needed since it's loopback).

**unknown** — Codex: catch-all for any `isError:true` response whose text does not
match a known pattern from the five categories above. Given every Codex error shape
observed across Sections 4-7 shares one structural signature (`isError:true` inside a
normal JSON-RPC `result`, plain text in `content[0].text`, never a JSON-RPC `error`
object), a caller can always detect "isError:true, category unrecognized" reliably even
when it cannot classify *which* specific failure occurred — that structural detection
itself is high-confidence and doc-wide, even though sub-classification depends on
text-matching that could break if Codex changes its message wording. **Local provider:**
catch-all for any non-2xx/unexpected-shape HTTP response that doesn't match the
categories above (e.g. HTTP 500 from the local server, unexpected response JSON
shape).

---

## Design judgments made in writing this contract (not settled by the probe doc)

- Naming `sessionId` as the contract's generic term for Codex's `threadId` is this
  doc's choice, made to keep the interface provider-neutral; no other name was
  evaluated.
- Treating `continue`'s "session not found" as a distinct, callable-recognizable
  sub-case (rather than folding it into the generic `unknown`/`malformed-request`
  buckets) is a judgment call made because the finding is architecturally important
  enough (see the top-of-doc callout) to deserve first-class detection, even though the
  probe doc itself just calls it "a finding."
- Every local-provider line is inference from Ollama/LM Studio's known general API
  shape (OpenAI-compatible chat endpoints, no agent sandbox concept), not from a probe
  of either — phase 2+ work implementing a local provider should re-verify these
  against the actual chosen local server's real API before relying on them, and amend
  this doc if reality differs.
- Uncertainty inherited from the probe doc (429 HTTP-status shape for quota
  exhaustion, cross-connection session survival, `-mini` variant precision, POSIX
  binary-absent stderr text, exact validation ordering) is carried forward here
  unresolved on purpose, per instruction — this contract does not paper over open
  questions with a plausible-sounding default.
