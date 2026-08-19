# Codex MCP Server — Empirical Probe Findings

Probe method: a throwaway Node script spawned `codex mcp-server` over stdio (Windows, `spawn(..., {shell:true})` was required — a bare `spawn('codex', ...)` fails with `ENOENT` because `codex` resolves to a `.cmd` shim on PATH). Requests were newline-delimited JSON-RPC written to stdin; responses (and interleaved `codex/event` notifications) were read from stdout. `serverInfo` on every run: `{"name":"codex-mcp-server","title":"Codex","version":"0.124.0","user_agent":"codex_cli_rs/0.124.0 (Windows 10.0.26200; x86_64) ..."}`.

**Correction to an established fact:** thread/session state is scoped to the live server *connection* (the single `codex mcp-server` child process for the duration it stays running), not persisted durably across process restarts. A `codex-reply` sent to a brand-new `codex mcp-server` process, quoting a `threadId` returned by an earlier, now-exited process, fails with `"Session not found for thread_id: ..."`. See Section 2 for both the failing cross-process attempt and the successful same-connection attempt.

---

## Section 1: `codex` tool call (read-only sandbox, trivial prompt)

Request sent (`tools/call`, id=2; preceded by standard `initialize`/`notifications/initialized` handshake):

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex","arguments":{"prompt":"Reply with exactly this phrase and nothing else: PURPLE-NARWHAL-42","sandbox":"read-only","approval-policy":"never"}}}
```

Response received:

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"PURPLE-NARWHAL-42"}],"structuredContent":{"threadId":"01a0175b-a7e1-7241-80f6-7af0e8aeba0f","content":"PURPLE-NARWHAL-42"}}}
```

Latency: **21,619 ms** (send at connection-relative t=277,373ms after process start; response at t=298,992ms; wall clock: sent 2026-08-19T00:11:17.373Z, received 00:11:38.992Z, per Unix-ms timestamps in the raw capture).

Note: this exact call was run twice (once standalone, once as the first half of the chained Section-2 probe, to obtain a `threadId` still live in the same process). Both runs returned identical `content` text and succeeded; the threadId shown above is from the run that fed directly into Section 2. A fully standalone first run (separate process) returned threadId `01a0175a-65e0-7060-9ccd-59464c984513` with latency 25,642 ms — consistent behavior, different session, as expected.

---

## Section 2: `codex-reply` continuation — proving/disproving threadId continuity

**Attempt A (cross-process, FAILED):** Section 1's standalone run returned `threadId=01a0175a-65e0-7060-9ccd-59464c984513`. A fresh `codex mcp-server` process was started and sent:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex-reply","arguments":{"prompt":"What exact phrase did I just ask you to reply with in my previous message? Quote it exactly and nothing else.","threadId":"01a0175a-65e0-7060-9ccd-59464c984513"}}}
```

Response:

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Session not found for thread_id: 01a0175a-65e0-7060-9ccd-59464c984513"}],"structuredContent":{"threadId":"01a0175a-65e0-7060-9ccd-59464c984513","content":"Session not found for thread_id: 01a0175a-65e0-7060-9ccd-59464c984513"},"isError":true}}
```

Latency: 1 ms (rejected locally, no model round trip). This is a **finding, not a bug in the probe**: threads do not survive a server-process restart.

**Attempt B (same connection, SUCCEEDED):** A single `codex mcp-server` process was kept alive across both calls. It received the same Section-1 `codex` call (id=2, threadId `01a0175b-a7e1-7241-80f6-7af0e8aeba0f` returned), then — without restarting the process — a `codex-reply` follow-up (id=3) referencing that threadId:

Request:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"codex-reply","arguments":{"prompt":"What exact phrase did I just ask you to reply with in my previous message? Quote it exactly and nothing else.","threadId":"01a0175b-a7e1-7241-80f6-7af0e8aeba0f"}}}
```

Response:

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"PURPLE-NARWHAL-42"}],"structuredContent":{"threadId":"01a0175b-a7e1-7241-80f6-7af0e8aeba0f","content":"PURPLE-NARWHAL-42"}}}
```

**Continuity demonstrated:** the reply correctly quotes `PURPLE-NARWHAL-42` — the exact phrase from the *prior turn's prompt* in Section 1 — with no reminder given in the follow-up prompt itself. The `threadId` in the response also matches the one supplied. This proves server-side conversation state genuinely persists across `tools/call` invocations, but only within the lifetime of one `codex mcp-server` process/connection.

Latency: **2,113 ms** for the reply call (send t=298,992ms after process start; response t=301,105ms). The first (`codex`) call in this same chained run took **21,619 ms**.

---

## Section 3: `codex` call with explicit `model` override

**Sub-attempt A — invalid slug `gpt-5.1` (probing valid ids):**

Request:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex","arguments":{"prompt":"State only your exact model identifier string as you know it internally, nothing else.","model":"gpt-5.1","sandbox":"read-only","approval-policy":"never"}}}
```

Response:

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.1' model is not supported when using Codex with a ChatGPT account.\"}}"}],"structuredContent":{"threadId":"01a0175c-4453-7862-be0f-39aaf2f40bc5","content":"{...same...}"},"isError":true}}
```

Latency: 17,360 ms. Server-side stderr during this run dumped the live models cache from the backend (see raw file `result_call3_model_gpt51_rejected.json`), revealing the actual valid slugs for this account: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `codex-auto-review`. (Unrelated but notable: stderr also logged a repeating cache-load error, `unknown variant 'max', expected one of 'none','minimal','low','medium','high','xhigh'`, tied to reasoning-effort deserialization — see Open Questions.)

**Sub-attempt B — valid slug `gpt-5.4-mini` (the actual precedence test):** global `~/.codex/config.toml` pins `model = "gpt-5.5"`.

Request:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex","arguments":{"prompt":"State only your exact model identifier string as you know it internally, nothing else.","model":"gpt-5.4-mini","sandbox":"read-only","approval-policy":"never"}}}
```

Response:

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"gpt-5.4"}],"structuredContent":{"threadId":"01a0175c-eaf3-7a00-8e43-7f22b1123885","content":"gpt-5.4"}}}
```

Latency: 49,303 ms.

**Precedence verdict: CONFIRMED — the per-call `model` override took precedence over the config.toml pin.** The self-reported identifier (`gpt-5.4`) differs from the config.toml-pinned model (`gpt-5.5`), and the call succeeded rather than silently running on the pinned model. One caveat, stated explicitly: the model self-reported `gpt-5.4`, not the exact requested slug `gpt-5.4-mini` — the self-identification is a base-family name, not necessarily the precise variant suffix. This is strong evidence of precedence (a different model family answered than the config default), but not proof the `-mini` variant specifically was used rather than the base `gpt-5.4`; the tool provides no separate machine-readable "model actually used" field in `structuredContent` to close that last gap.

---

## Section 4: Malformed request — invalid `sandbox` enum

Request (`prompt` omitted deliberately; `sandbox` set to an invalid value):

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codex","arguments":{"sandbox":"banana"}}}
```

Literal response (error object verbatim):

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Failed to parse configuration for Codex tool: unknown variant `banana`, expected one of `read-only`, `workspace-write`, `danger-full-access`"}],"isError":true}}
```

Latency: **9 ms**. The error is returned as a normal JSON-RPC `result` (not a JSON-RPC `error` object, and not an HTTP-style failure) with `isError:true` inside `result`, and `content[0].text` carrying a plain-string message — not a structured `{code, message, data}` shape. The missing `prompt` was never separately flagged; validation stopped at the first bad field it hit (`sandbox`), so it's unconfirmed whether omitting only `prompt` (with a valid `sandbox`) produces a different message — see Open Questions. The rejection happened before any turn/session was created (no `codex/event` notification observed, no threadId issued), confirming **no subscription quota was spent** on this call.

---

## Section 5: Missing/invalid auth (p1-t2) — REPRODUCED LIVE

Isolation method: real `~/.codex/auth.json` was never touched. `CODEX_HOME` was set to a throwaway empty scratchpad directory and `codex mcp-server` was spawned as a subprocess with that env var, per-call. CODEX_HOME was confirmed honored (not silently falling back to the real home) two ways: the `session_configured` event's `rollout_path` field pointed inside the fake directory, and the failure that followed involved a genuine outbound network call (visible 401 with real `cf-ray` header from `api.openai.com`) rather than a locally-cached success — a leak to the real home would have produced a normal successful reply instead.

**Case A — CODEX_HOME with no auth.json at all:** the handshake and `session_configured` event succeed normally (server starts fine with no credentials present — auth is not checked at startup). The failure surfaces only when a `codex` tool call actually tries to reach the model. The turn goes through `stream_error` retries (5 attempts over WebSocket, then falls back to HTTPS transport, 5 more retries) before giving up:

```
"stream_error", "additional_details": "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a2d542db8e71754b-SEA"
```

Final `tools/call` response (id=2):

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a2d5433ecdd5f6d8-SEA, request id: req_727da86ac1de4b44ac23f23ac2414800"}],"structuredContent":{"threadId":"01a0178e-ed1d-7831-a47a-8db84ffb2e23","content":"unexpected status 401 Unauthorized: ..."},"isError":true}}
```

Shape matches the established `isError:true` pattern (plain-text message in `content[0].text`, no structured JSON-RPC `error` object). **This failure is NOT fast/local — it involves a real network round trip** (WebSocket connect attempt, then HTTPS fallback, ~10 retry attempts, total elapsed ~14s from turn start to final error) because there is no local pre-flight auth check; the client only finds out when the API rejects it.

**Case B — CODEX_HOME with a syntactically-valid-JSON-but-wrong-shape auth.json** (`{"invalid":"garbage"}`, no `OPENAI_API_KEY`/tokens field): this is a **distinctly different failure shape** — it is detected locally, before any network call, because the client cannot even construct credentials to attempt a request:

```
ERROR codex_models_manager::manager: failed to refresh available models: Token data is not available.
"stream_error", "codex_error_info":{"response_stream_disconnected":{"http_status_code":null}}, "additional_details":"Token data is not available."
```

Final `tools/call` response (id=2):

```json
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Token data is not available."}],"structuredContent":{"threadId":"01a0178f-aa9d-7c50-ac53-9c22f065677e","content":"Token data is not available."},"isError":true}}
```

**Distinguishing signal for the credit-pressure offload feature:** `http_status_code` is `null` (no real HTTP response — this is purely local: the auth file parsed as JSON but had none of the expected credential fields) versus Case A's `http_status_code: 401` (real server round trip). Both end in `isError:true` with a plain-text `content[0].text`, but the message text itself differs ("Token data is not available." vs. "unexpected status 401 Unauthorized: ..."), and only Case A carries a `cf-ray`/`request id` — a detector could use presence of an HTTP status/cf-ray to distinguish "no credentials at all" from "malformed/unusable credential file" without needing to inspect the auth file directly.

Confirmed unaffected: the real `~/.codex/auth.json` was never opened, moved, or written to during either case — only `CODEX_HOME` env var was changed per-subprocess. Post-probe sha256 verification below confirms byte-identity.

---

## Section 6: Missing binary (p1-t2) — REPRODUCED LIVE

No uninstall was performed; two deliberately-wrong invocations were made instead, both from Node's `child_process.spawn`, matching how a client-side discovery ladder would attempt and detect an absent provider.

**Case A — absolute nonexistent path, no shell** (`spawn('C:\\nonexistent\\path\\codex.exe', ['mcp-server'], {shell:false})`): fails at the OS/Node layer before any process is created, via the `'error'` event:

```json
{"spawnErrorMessage":"spawn C:\\nonexistent\\path\\codex.exe ENOENT","code":"ENOENT","errno":-4058,"syscall":"spawn C:\\nonexistent\\path\\codex.exe","path":"C:\\nonexistent\\path\\codex.exe"}
```

`err.code === 'ENOENT'` is the reliable, language-level signal here — no exit code is produced because no process ever started.

**Case B — bogus command name via shell** (`spawn('codex-does-not-exist', ['mcp-server'], {shell:true})` — this mirrors the actual `codex` invocation shape established in p1-t1, where `shell:true` is required on Windows because `codex` resolves through a `.cmd` shim): the shell itself starts successfully, then fails to resolve the command, exiting with code 1 and a stderr message from `cmd.exe`, not a Node-level spawn error:

```
exitCode: 1, stderr: "'codex-does-not-exist' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"
```

**Implication for the phase-2 discovery ladder:** a `shell:true` invocation style (needed for `codex` itself on Windows, per p1-t1) will NOT surface ENOENT — it surfaces as a normal process exit (code 1) with an OS-locale-dependent stderr string. Detecting "binary missing" reliably therefore cannot rely on `err.code === 'ENOENT'` alone if the real invocation uses `shell:true`; it must also treat a nonzero exit with empty stdout and a "not recognized"/"command not found"-shaped stderr as the same condition. This stderr text is Windows/cmd.exe-specific (`'is not recognized as an internal or external command'`); POSIX shells would say `command not found` instead — this was reproduced only on Windows and not verified on macOS/Linux.

---

## Section 7: Quota exhaustion (p1-t2) — RESEARCHED, sourced from Rust source + GitHub issues; NOT reproduced live (by design, per instructions, to avoid spending the user's real 5-hour window)

**Authoritative source: `codex-rs/protocol/src/error.rs` in openai/codex** (fetched via `gh api repos/openai/codex/contents/codex-rs/protocol/src/error.rs`, current `main` as of 2026-08-18). This defines `UsageLimitReachedError` with fields `plan_type: Option<PlanType>`, `resets_at: Option<DateTime<Utc>>`, `rate_limits: Option<Box<RateLimitSnapshot>>`, `promo_message: Option<String>`, `rate_limit_reached_type: Option<RateLimitReachedType>`, and a `Display` impl that formats plan-specific human-readable text, e.g.:

- Free/Go plan: `"You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at {time}."`
- Plus plan: `"You've hit your usage limit. Upgrade to Pro (...), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at {time}."`
- Workspace-scoped limits use distinct wording: `"Your workspace is out of credits. Add credits to continue."` / `"You hit your spend cap set in your workspace. Increase your spend cap to continue."`
- Unknown/no plan info: `"You've hit your usage limit. Try again at {time}."` or `"...Try again later."` if no `resets_at` is known.

Source: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs (confirmed present via `gh search code "struct UsageLimitReachedError" repo:openai/codex` and direct fetch, 2026-08-18).

**How this reaches the MCP transport specifically — REPRODUCED-BY-CODE-INSPECTION (source-level, not a live call):** `codex-rs/mcp-server/src/codex_tool_runner.rs`, the same file that handles the `codex` tool's event loop this probe used, contains:

```rust
EventMsg::Error(err_event) => {
    // Always respond in tools/call's expected shape, and include conversationId so the client can resume.
    let result = create_call_tool_result_with_thread_id(
        thread_id,
        err_event.message,
        Some(true),
    );
    ...
}
```

Source: https://github.com/openai/codex/blob/main/codex-rs/mcp-server/src/codex_tool_runner.rs (fetched via `gh api`, 2026-08-18). This confirms with source-level certainty: a quota/rate-limit failure — like every other `EventMsg::Error` — surfaces over this MCP transport as `isError:true` with the `UsageLimitReachedError`'s formatted string (one of the messages above) as plain text in `content[0].text`, in the exact same shape already established for validation errors (Section 4) and the auth failures above (Section 5). It is NOT a JSON-RPC `error` object, and no separate structured error-type field (`rate_limit_reached_type`, `resets_at`, etc.) is exposed alongside it in the MCP `CallToolResult` — only the human-readable Display string is forwarded. A client cannot distinguish "quota exhausted" from any other generic error by machine-readable type over this transport; it can only pattern-match the message text (e.g. contains "usage limit" / "spend cap" / "out of credits").

**Usage metadata that could let a client anticipate exhaustion before hitting it — RESEARCHED, PARTIALLY ANSWERED:** `codex-rs/protocol/src/protocol.rs` defines `RateLimitWindow { used_percent: f64, window_minutes: Option<i64>, resets_at: Option<i64> }` nested inside `RateLimitSnapshot`, itself carried on `TokenCountEvent { info, rate_limits }` (source: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs, fetched 2026-08-18). This proves the underlying Codex core DOES compute and carry live usage-percent/reset-time data internally, and the app-server v2 protocol (`GetAccountRateLimitsResponse`, `AccountRateLimitsUpdatedNotification` — same repo) exposes it there. **However**, `codex_tool_runner.rs` (the actual MCP `codex`/`codex-reply` tool handler used by this probe's transport) was inspected end to end for its event-loop match arms and no `TokenCountEvent` / `rate_limits` field is forwarded into the `tools/call` response's `content` or `structuredContent` — only `text` (from `TurnComplete.last_agent_message` on success, or `err_event.message` on error). **Conclusion: the plain MCP `tools/call` transport this project targets does not appear to expose the `used_percent`/`resets_at` usage metadata proactively; that metadata exists in the underlying protocol but is (as far as this source inspection could determine) only reachable via the separate app-server v2 JSON-RPC surface (`getAccountRateLimits`), not via the `codex`/`codex-reply` MCP tools.** This is a source-inspection finding, not a live-traffic capture — it was not proven by triggering a real `TokenCountEvent` and confirming it is absent from a live `tools/call` reply, so treat "not forwarded" as strong-but-not-100%-certain; see Open Questions.

**GitHub issues consulted (real-world corroboration, not authoritative for exact wire shape):** https://github.com/openai/codex/issues/32607 (report of `rate_limits` readings with `used_percent` already elevated after a reset — corroborates the field exists and is observable in some client surface, likely the TUI's own rate-limit display, not the bare MCP tool response), https://github.com/openai/codex/issues/9135 (429 near end of a 5-hour window), https://github.com/openai/codex/issues/16909 and #34865 (usage-limit-reached messaging inconsistencies). These are user reports, not verified wire captures, and are cited only as corroborating evidence that the `error.rs` messages above are what users actually see in practice.

**What was explicitly NOT determined:** whether a live 429/quota-exhausted response over the plain `tools/call` transport carries an HTTP status code analogous to Case A's 401 (i.e., is it `http_status_code: 429` inside a `stream_error`, similar to the 401 shape found for missing auth?) — this is a highly plausible inference from the code (`UsageLimitReachedError` is constructed from an HTTP error response per `codex-rs/codex-api/src/api_bridge.rs`'s `if err.error.error_type.as_deref() == Some("usage_limit_reached")` check, itself downstream of an HTTP response), but it was NOT reproduced live and no exact captured JSON for a genuine 429 was found in any issue thread. Do not treat the 429/`stream_error` inference as confirmed — it is a plausible-but-unverified extrapolation from adjacent, verified code paths (the same `stream_error`/retry pattern was reproduced live for the 401 case in Section 5, and `codex-rs/codex-api/src/api_bridge.rs` ties `usage_limit_reached` to an HTTP-error-derived type), not a captured quota-failure response.

---

## Open Questions

1. **Session persistence model is unclear beyond "same process."** Section 2 shows continuity works within one live `codex mcp-server` connection and fails after a full process restart. Untested: does the session survive if the *client* disconnects and reconnects to the *same still-running* server process (rather than the server itself exiting)? Untested: is there any on-disk session/rollout persistence at all (e.g. under `~/.codex/`) that a differently-configured client could resume, or is server-process-lifetime truly the hard boundary? This directly affects how any orchestrator should treat Codex MCP session state for p1-t3 (provider contract) — do not assume durability without re-verifying.
2. **Exact effect of `model_reasoning_effort = "xhigh"` in config.toml is unconfirmed and possibly broken.** Every run's stderr logged a recurring model-cache load failure (`unknown variant 'max', expected one of 'none','minimal','low','medium','high','xhigh'`) while trying to refresh the backend model list. This looks unrelated to the `xhigh` pin itself (the error says `max` was seen, not `xhigth`) — most likely some other field or a stale cached response uses `max` as a reasoning-level value that this CLI version's parser doesn't recognize. Whether this failure has any functional effect on responses (the calls all still succeeded) is unconfirmed; it's a candidate root cause worth checking before assuming reasoning-effort behaves as documented.
3. **Whether `gpt-5.4-mini` vs `gpt-5.4` actually differ in cost/speed for this account** is unconfirmed — the tool's self-report collapsed the variant suffix, and no separate metadata field exposed the literal requested slug vs. the resolved one. Relevant to any future cost-routing decision that assumes `-mini` variants are honored precisely.
4. **The precise validation order for `tools/call` argument errors is unconfirmed** — Section 4 only proves `sandbox: "banana"` fails first when `prompt` is also missing; a request with a valid `sandbox` but no `prompt` was not separately tested, so its exact error text/shape is unknown. Relevant to p1-t2 if quota-exhaustion or other error paths need to be distinguished from plain validation errors by shape alone.
5. **Quota-exhaustion behavior (p1-t2) was not probed LIVE** — by design, to conserve the shared 5-hour quota window. Section 7 answers this via source inspection (`error.rs`, `codex_tool_runner.rs`, `protocol.rs`) rather than a live capture; the message text and `isError:true` shape are sourced with high confidence, but the exact `stream_error`/HTTP-status wrapper a genuine 429 produces was never captured live and is inferred, not proven, by analogy to the 401 auth case in Section 5.
6. **Whether `RateLimitWindow.used_percent`/`resets_at` usage metadata is ever forwarded through the plain `codex`/`codex-reply` MCP tools** is answered by source inspection only (Section 7): the `codex_tool_runner.rs` event loop appears not to forward it, but this was not confirmed by triggering a real `TokenCountEvent` and inspecting a live `tools/call` reply for its absence. If the credit-pressure offload feature needs proactive usage-percent visibility, the app-server v2 JSON-RPC surface (`getAccountRateLimits`) looks like the right target based on source, not this MCP tool surface — but that alternate surface was not probed at all here (out of scope for p1-t2, which targets the `mcp-server` stdio transport specifically).
7. **The Windows-specific "not recognized as an internal or external command" stderr text for a missing binary via `shell:true`** (Section 6, Case B) was reproduced only on Windows/cmd.exe. The equivalent POSIX shell text (`command not found`) was not reproduced live on this machine and should not be assumed identical when the phase-2 discovery ladder runs cross-platform.
8. **Missing/invalid-auth failure latency (Section 5) involves a real network round trip (~14s, ~10 retries)** for the no-auth-file case, but a purely local, near-instant failure for the malformed-auth-file case. Any timeout the phase-2 discovery ladder sets for "is Codex authenticated" must accommodate the slower network-round-trip path, not just the fast local one — the two failure modes have very different latency budgets despite both ending in `isError:true`.

---

## Auth-integrity verification (p1-t2, ABSOLUTE CONSTRAINT compliance)

The real `C:\Users\majes\.codex\auth.json` was never moved, renamed, deleted, or written to during this probe. Isolation was achieved exclusively by setting `CODEX_HOME` to throwaway scratchpad directories (`.../scratchpad/fake-codex-home-empty` and `.../scratchpad/fake-codex-home-corrupt`) on each `codex mcp-server` subprocess invocation, per the mandated approach. CODEX_HOME-honoring was independently confirmed per probe (fake `rollout_path` in `session_configured`; genuine outbound network calls in the no-auth case, proving no silent fallback to real credentials).

**sha256 verification — REPRODUCED LIVE:**

- Baseline (recorded before any probing began): `c66cbcfe94c18711a92f76df3625a1e379ee37833b2d60babae2d0b7eb3f6572`
- Post-probe (recorded after Sections 5–7's live reproductions completed): `c66cbcfe94c18711a92f76df3625a1e379ee37833b2d60babae2d0b7eb3f6572`
- `auth.json.SAFETY-BAK`: `c66cbcfe94c18711a92f76df3625a1e379ee37833b2d60babae2d0b7eb3f6572`

**Result: all three hashes are byte-identical. The real auth.json was confirmed unmodified.** No restore was necessary.
