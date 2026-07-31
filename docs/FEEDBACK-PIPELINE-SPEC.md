# Feedback Pipeline Spec (v1)

Status: design spec, not yet implemented. Target: async user-feedback intake
for the TycoonAgents VS Code extension without building or maintaining a
custom board site.

## 1. Overview & Goals

**Goal:** let a user hit "Submit feedback" in the extension panel and have it
land as a triageable ticket, with zero always-on infrastructure to run and
zero custom UI for the maintainer to build.

**Chosen shape:** extension → sanitized JSON POST → a tiny Cloudflare Worker →
one GitHub Issue per ticket in a **private** repo. The maintainer (and Claude
Code, on demand) triage with the `gh` CLI: cluster duplicates, close dupes
with a cross-link to a canonical issue, and consolidate accepted work into
`task`-labeled issues. Users never see the private repo and never need a
GitHub account.

**Non-goals:**
- No custom Trello-like board site. GitHub Issues *is* the board.
- No runtime AI calls anywhere in this pipeline. Submission is a plain HTTPS
  POST from the extension; the sanitize step is deterministic (regex/string
  ops), not model-based. Triage may *optionally* involve a human running
  Claude Code interactively later, but the shipped extension makes no AI
  calls to submit feedback.
- No scheduled/cron triage at current scale (~2 external users). The design
  must not preclude adding headless scheduled triage later (see §10 Phase 4).
- No public listing/read endpoint. The Worker only ever accepts writes.

**Explicitly rejected alternatives:** custom hosted board app (too much to
build/maintain for current scale); public GitHub repo for tickets (users
would need accounts and would see each other's reports); always-on server
(Worker is pay-per-request and needs no ops).

## 2. Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  VS Code Extension       │        │  Fallback Web Form         │
│  "Submit Feedback" UI     │        │  (Cloudflare Pages, static) │
│  (webview + host handler) │        │  used only if the panel     │
└─────────────┬─────────────┘        │  won't open                │
              │                       └─────────────┬───────────┘
              │  sanitize() → JSON POST               │  manual paste →
              │  (extension host, fetch + timeout)     │  JSON POST
              ▼                                        ▼
        ┌─────────────────────────────────────────────────┐
        │        Cloudflare Worker  (single POST route)     │
        │  - validate payload (schema, size cap, honeypot)   │
        │  - rate limit per IP                                │
        │  - GitHub REST call using fine-grained PAT           │
        └───────────────────────┬───────────────────────────┘
                                  │  creates issue
                                  ▼
                    ┌───────────────────────────────┐
                    │  Private GitHub repo             │
                    │  one Issue per ticket, labeled    │
                    │  "ticket", "v<ext-version>",       │
                    │  <platform>, <category>            │
                    └───────────────┬───────────────────┘
                                     │  gh CLI, on demand
                                     ▼
                    ┌───────────────────────────────┐
                    │  Maintainer + Claude Code triage  │
                    │  cluster dupes → close w/ link     │
                    │  consolidate → "task"-labeled issue │
                    └───────────────────────────────┘
```

Both intake paths (extension, fallback form) POST the **same payload shape**
to the **same Worker route**, so the Worker and the GitHub-issue mapping are
written once and shared by both.

## 3. Payload Schema v1

JSON body, UTF-8, sent as `Content-Type: application/json`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | number | yes | `1` for this spec. Worker rejects unknown values. |
| `ticketId` | string (UUID v4) | yes | Generated client-side (`crypto.randomUUID()`), so the client can show a stable ID even if the network call is retried. Not trusted as the GitHub issue number — it's a correlation token only. |
| `createdAt` | string (ISO 8601) | yes | Client clock; informational only, not used for ordering/security. |
| `extensionVersion` | string | yes | From the running extension's `package.json` (same source `_currentExtensionVersion()` already uses). |
| `platform` | string | yes | e.g. `win32`, `darwin`, `linux` — same value `buildDiagnosticReport()` puts in its Environment section. |
| `hostAppName` | string | yes | e.g. `Visual Studio Code`, `Antigravity IDE` — same field diagnosticReport already captures. |
| `category` | enum | yes | One of `bug`, `idea`, `question`, `other`. |
| `userDescription` | string | yes | User-typed. Max ~4000 chars (Worker enforces; UI soft-warns near the limit). Never generated or altered by the extension. |
| `diagnosticMarkdown` | string | no | The full sanitized output of `buildDiagnosticReport()`. Omitted if the user unticks "include diagnostics." |
| `contact` | string | no | Free-text, user-supplied only (e.g. an email or Discord handle they choose to type). Max 500 chars (enforced by both the extension's zod schema, §5, and the Worker). Never auto-filled from any host identity. |
| `website` | string | no | **Honeypot.** Never rendered or filled by real UIs (extension or fallback form) — real submissions always send it absent or empty. A non-empty value ⇒ the Worker silently drops the submission and returns a fake success response (§4). |

**Sanitization contract:** every string field that can contain user
filesystem paths or free text (`userDescription`, `diagnosticMarkdown`,
`contact`) is passed through the existing `sanitize()` function
(`src/host/vscode/diagnosticReport.ts:100`) before the payload is
constructed, using the same `roots` (`projectRoot`, `extensionDir`, home)
already threaded through `buildDiagnosticReport()`. `diagnosticMarkdown` is
literally `buildDiagnosticReport()`'s return value, which already runs its
sections through sanitize internally — no double-processing needed there,
but `userDescription` and `contact` are raw user input and MUST be sanitized
explicitly before being placed in the payload. `sanitize()` is pure and never
throws (per its existing doc comment), so this is a safe, synchronous,
zero-dependency step. **No unsanitized field ever reaches `fetch()`.**

## 4. Cloudflare Worker Spec

Single route: `POST /submit` (final path decided by maintainer, see §11).

### Validation (in order, fail fast)

1. `Content-Type` must be `application/json` — else 415.
2. Body size cap: reject anything over 64 KB before parsing (`Content-Length`
   check, then a hard read-cap as defense in depth) — else 413.
3. Parse JSON — else 400.
4. `schemaVersion` must equal a value the Worker recognizes (`1`) — else 400
   with an "unsupported schema version" message. This is what lets the
   Worker evolve without breaking older installed extension versions: old
   clients keep sending v1 and keep working until the maintainer chooses to
   drop it.
5. Required fields present and correctly typed (`ticketId` UUID shape,
   `category` in the enum, `userDescription` non-empty and ≤4000 chars,
   `contact` ≤500 chars if present) — else 400 listing which field failed
   (safe to reveal — it's the shape of the caller's own request, not server
   internals).
6. Honeypot field `website` (present in the form/payload but never
   rendered/filled by real UI) — if non-empty, return **200/201 with a fake
   success body** but silently drop the submission. Bots that fill every
   field get a convincing success response and never learn they were
   filtered; real users never see this field.

### Content sanitization

The extension path already runs `userDescription` and `contact` through
`sanitize()` client-side before they ever leave the machine (§3), and
`diagnosticMarkdown` is sanitized internally by `buildDiagnosticReport()`.
But the fallback form (§6) is plain static HTML/JS with no access to the
extension's `sanitize()`, so fallback submissions arrive at the Worker
un-sanitized. To keep the guarantee true for *every* submission regardless
of which surface it came from, the Worker applies its own redaction pass —
a small server-side port of `sanitize()`'s rules — to `userDescription`,
`contact`, and `diagnosticMarkdown` on **every** request, immediately after
validation and before the GitHub issue is created:

- Windows absolute paths (e.g. `C:\Users\<name>\...`) → `<path>`
- Unix/macOS absolute paths (e.g. `/Users/<name>/...`, `/home/<name>/...`) → `<path>`
- `sk-`-prefixed API keys → `[REDACTED]`
- `gh*_`-prefixed tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) → `[REDACTED]`
- 32+ character hex strings (likely hashes/secrets) → `[REDACTED]`

This is defense-in-depth on the extension path (the field was already
sanitized once client-side; the Worker pass is a no-op on already-clean
text) and the **primary** sanitization boundary on the fallback-form path,
where nothing has scrubbed the text yet. See §7 for the resulting privacy
guarantee and a maintenance note on keeping these rules in sync with
`sanitize()`.

### Rate limiting

Use a **Workers KV counter keyed by client IP** (`CF-Connecting-IP` header),
fixed window (e.g. 10 submissions / hour / IP), incremented on each
non-honeypot request, TTL'd to auto-expire. Justification: at current scale
(~2 users) the native Cloudflare Rate Limiting binding is a paid/plan-gated
feature with coarser granularity than needed here, while a KV counter is
free-tier-friendly, simple to reason about, and sufficient to stop abuse
without needing an enterprise rate-limiting product. If usage grows enough
that KV's eventual consistency (60s propagation) becomes a real gap, swap in
the Rate Limiting binding — the validation pipeline doesn't change either
way.

### CORS

The Worker returns `Access-Control-Allow-Origin` for exactly **one**
explicitly configured allowed origin — the fallback form's own deployed
origin (§6) — never `*` and never a reflected/wildcard match. This is a
browser-only guardrail: it stops a third-party web page from silently
scripting a *visitor's browser* into POSTing to `/submit` on the page's
behalf (a distributed flood that would come from many different visitor
IPs, each individually under the per-IP rate limit — see §9). It does
**not** constrain non-browser callers (`curl`, a script, the extension
host itself, which sends no `Origin` header and is unaffected by CORS)
— those are still governed by the honeypot, schema validation, and
per-IP rate limit above, which remain the primary abuse controls. The
allowed-origin value must be updated whenever the fallback form's
deployed URL changes.

### GitHub issue creation

- Secret: a **fine-grained GitHub PAT** scoped to **only** the private
  feedback repo, with **`issues:write`** permission and nothing else (no
  `contents`, no `admin`, no org-wide scope). Stored as a Worker secret
  (`wrangler secret put GITHUB_PAT`), never logged, never echoed in any
  response.
- Call: `POST https://api.github.com/repos/<owner>/<feedback-repo>/issues`.
- **Title:** `[<category>] <first 60 chars of userDescription>` (ellipsized
  with `…` if truncated).
- **Body:**
  ```
  <userDescription, verbatim (already sanitized)>

  <details>
  <summary>Diagnostics</summary>

  <diagnosticMarkdown, if present>

  </details>

  | Field | Value |
  |---|---|
  | Ticket ID | <ticketId> |
  | Extension version | <extensionVersion> |
  | Platform | <platform> |
  | Host | <hostAppName> |
  | Contact | <contact, or "none provided"> |
  | Submitted | <createdAt> |
  ```
- **Labels:** `ticket`, `v<extensionVersion>` (e.g. `v0.0.509`), `<platform>`,
  `<category>`. For each label, the Worker calls the GitHub create-label API
  and treats a `422 already_exists` response as success, then passes the
  full label set on the issue-creation call. This procedure is correct
  regardless of whether the issues API happens to auto-create missing
  labels on its own — the Worker never depends on that behavior, so no
  assumption about it is needed.

### Response contract

- Success: `201` with `{ "ticketId": "<echoed>", "status": "received" }`.
  Never returns the GitHub issue number or URL (repo is private and its
  existence/name should not be discoverable from the response).
- Any internal failure (GitHub API error, KV error, etc.): `502` with a
  generic `{ "error": "submission failed, please retry" }` — **never** leak
  the PAT, the repo owner/name, or raw upstream error bodies.
- **No `GET`, no list, no read route of any kind.** The board is never
  public; this Worker is write-only by design.

## 5. Extension Changes

### UI

New "Submit Feedback" entry in the Settings area of the panel:
- Category dropdown: Bug / Idea / Question / Other.
- Textarea for `userDescription` (client-side soft cap ~4000 chars with a
  live counter).
- Checkbox "Include diagnostic report" (default checked), reusing
  `buildDiagnosticReport()` — same function the existing
  `generateDiagnostic` flow already calls
  (`src/host/vscode/panel.ts:7679-7690`, triggered from
  `media/main.js:14863`).
- Optional contact free-text field.
- **Plain-language disclosure block (mandatory, always on the form):** the
  verbatim copy from §7 "Plain-language disclosure (what gets sent)" must
  render on the feedback form itself — either always visible near the
  submit controls, or one tap/click away (e.g. an expandable "What gets
  sent?" note directly on the form) — but never buried behind the JSON
  preview. The raw-JSON preview (below) is for users who want the literal
  payload; this block is for everyone else, and it must appear *before* a
  user could reach that preview. §7 is the single source of truth for this
  copy — it must not be re-worded independently here.
- **Preview step (mandatory, not skippable):** before sending, render the
  exact JSON payload that will be POSTed (pretty-printed) in the same
  open-in-editor pattern the existing diagnostic report flow uses, so the
  user visually confirms exactly what leaves their machine. Only after this
  preview does a "Send" action appear.
- Since `window.confirm`/`alert`/`prompt` are no-ops inside webviews, any
  confirmation step must be either in-webview UI (the preview pane itself
  acts as the confirmation) or host-side via `vscode.window.showWarningMessage`
  — never a webview-native dialog.

### Messaging

Add a new webview→host message following the existing `MSG.*` +
zod-schema pattern in `src/host/vscode/messages.ts` (see e.g.
`GENERATE_DIAGNOSTIC: z.object({}).passthrough()` at line 516):

```ts
// MSG additions
SUBMIT_FEEDBACK: "submitFeedback",

// MSG_SCHEMAS additions
SUBMIT_FEEDBACK: z.object({
  category: z.enum(["bug", "idea", "question", "other"]),
  userDescription: z.string().min(1).max(4000),
  includeDiagnostics: z.boolean(),
  contact: z.string().max(500).optional(),
}).passthrough(),
```

### Host handler

On receiving `SUBMIT_FEEDBACK`:
1. Build `diagnosticMarkdown` via the existing `buildDiagnosticReport()` call
   path if `includeDiagnostics` is true (same inputs `panel.ts` already
   assembles for `generateDiagnostic`).
2. Sanitize `userDescription` and `contact` via `sanitize()`
   (`src/host/vscode/diagnosticReport.ts:100`) using the same `roots` object
   already built for diagnostics.
3. Assemble the v1 payload (§3), generate `ticketId` via
   `crypto.randomUUID()`, `createdAt` via `new Date().toISOString()`.
4. Send the preview payload back to the webview for the mandatory
   confirmation step (§5 UI) before any network call is made.
5. On user confirmation, POST with the global `fetch()` (same primitive
   already used for the engine probe at `src/host/vscode/panel.ts:7833`; no
   new npm dependency — project rule is no new dependencies) wrapped in an
   `AbortController` with a **10-second timeout**.
6. Success: `vscode.window.showInformationMessage` toast showing the
   `ticketId` echoed from the response.
7. Failure (network error, timeout, non-2xx): fall back to copying the full
   JSON payload to the clipboard and showing a message pointing the user at
   the fallback web form URL (§6), so no submission is silently lost.

## 6. Fallback Web Form

A static page (Cloudflare Pages) for users whose panel won't open at all.

- Same category dropdown, description textarea, contact field as the
  extension UI.
- No automatic diagnostic collection (the form has no access to the
  extension host) — instead a textarea labeled "Paste diagnostic report
  here (optional)" where the user pastes output they generated separately
  via the existing `generateDiagnostic` command (which already writes a
  sanitized markdown file and copies it to clipboard —
  `src/host/vscode/panel.ts:7679-7690`).
- Same honeypot field (`website`, always absent/empty from real users), same
  client-generated `ticketId`/`createdAt`.
- **Same plain-language disclosure block as the extension UI (§7), rendered
  verbatim on the form itself before submission** — this is the same
  requirement as §5 "UI", not a separate copy to maintain. On this surface
  the block must also carry the existing note (below) that form text
  travels over TLS exactly as typed and is only scrubbed server-side, after
  it leaves the machine — that distinction matters here specifically
  because, unlike the extension path, nothing sanitizes this surface's text
  before it is sent.
- POSTs to the **same** Worker route with the **same** payload shape — the
  Worker does not need to know which surface a submission came from.
- Same rate limit and size cap apply automatically since they're enforced
  Worker-side, not client-side.
- This form's deployed origin is the one the Worker's CORS allowlist (§4
  "CORS") must be configured with. If the form is redeployed to a new
  domain, that domain must be added to the allowlist or the browser will
  block the form's own submissions.
- The form has no access to the extension's `sanitize()`, so
  `userDescription`, `contact`, and any pasted `diagnosticMarkdown` travel to
  the Worker over TLS exactly as typed/pasted. They are scrubbed server-side
  (§4 "Content sanitization") before the GitHub issue — and therefore before
  any persistent storage — is created. This is the primary sanitization
  boundary for this path (see §7).
- No build tooling required beyond plain HTML/CSS/JS; no new dependency for
  the main extension package.

## 7. Privacy & Consent

- **Preview-before-send is mandatory** in both the extension UI and the
  fallback form — the user always sees the literal payload before anything
  is transmitted. No background/automatic submission exists anywhere in
  this design.
- **Sanitization is two-layer, and both layers matter for different
  reasons.** (1) The extension path runs client-side `sanitize()` on every
  field that could contain local paths or secrets before anything leaves the
  machine (§3) — this keeps the mandatory preview (above) byte-accurate to
  what is actually sent, and means the extension never transmits raw paths
  even before the request reaches the Worker. (2) The Worker additionally
  runs the same redaction rules (§4 "Content sanitization") on
  `userDescription`, `contact`, and `diagnosticMarkdown` on **every**
  submission, extension or fallback form, before the GitHub issue is
  created. The guarantee this design makes is: **nothing unsanitized is ever
  *stored* in the repo.** The extension path additionally sanitizes
  client-side before anything leaves the machine, which is a stronger,
  additive guarantee for that path specifically — but the fallback form
  (§6), which has no access to `sanitize()`, relies entirely on layer (2),
  and that is by design, not a gap. **Maintenance note:** the Worker's
  redaction rules are a deliberate small port of `sanitize()`'s rules
  (`src/host/vscode/diagnosticReport.ts:100`) and must be updated
  whenever those rules materially change, or the two layers will drift.
- `userDescription` and `contact` are **user-typed text sent verbatim**
  (after client-side path/secret sanitization on the extension path, and
  always subject to the Worker's redaction pass regardless of path) — the UI
  copy next to the textarea must say this explicitly, e.g. "Your description
  is sent as written; diagnostics are sanitized to strip local file paths."
  so users don't accidentally paste secrets expecting extra scrubbing beyond
  path/token redaction.
- **Retention:** submissions live as issues in the private feedback repo
  indefinitely, visible only to the maintainer and repo collaborators.
  Deletion on request is a manual `gh issue delete` / repo-admin action, not
  automated in v1.

### Plain-language disclosure (what gets sent)

The raw-JSON preview (§5, §6) is honest but not *understandable* to a
non-technical user — most people cannot read a JSON payload and know what it
means for their privacy. Both intake surfaces (extension form and fallback
form) MUST also show the following copy, **verbatim**, before the user ever
reaches the JSON preview. This is the single source of truth for that copy;
§5 and §6 reference it rather than restating it.

Every field named below is drawn directly from what `buildDiagnosticReport()`
(`src/host/vscode/diagnosticReport.ts:294`) actually collects — nothing here
describes a field the function doesn't capture, and nothing the function
captures is left off this list.

> **Here's exactly what this form sends when you press Send:**
>
> - Your description and (if you add one) your contact info, exactly as you
>   typed them — local file paths and recognizable API keys or tokens are
>   automatically removed before anything is sent.
> - If "Include diagnostic report" is checked, it also sends:
>   - Your extension version, operating system, IDE name and variant, and
>     when the report was generated
>   - Whether the background hook is installed, whether it's working, and
>     when it last ran
>   - Your delegation settings
>   - A list of your agent names and whether each one has routing configured
>   - Whether your project's instructions file (CLAUDE.md) has any leftover
>     sections from an older format
>   - A size check of your instructions and agent files (so we can tell if
>     they're getting too long)
>   - The connection status of any configured engines (like UEFN). For MCP
>     servers, only which ones are configured — not their connection status
> - **What's never sent:** your source code, file contents, project names
>   (only redacted paths), API keys (they're removed), or anything running
>   in the background. Nothing leaves your machine until you press Send —
>   and you'll see the exact data being sent right before that happens.

**Maintenance note:** if `buildDiagnosticReport()`'s sections change (new
section added/removed, or a section starts/stops collecting a category of
data), this copy must be updated in the same change — it is documentation of
that function's actual output, not an independent description of it.

## 8. Triage Workflow

Maintainer (or Claude Code on the maintainer's behalf) runs, on demand, from
a machine with `gh` authenticated against the private feedback repo:

```bash
# List open tickets
gh issue list --repo <owner>/<feedback-repo> --label ticket --state open \
  --json number,title,labels,createdAt,body

# Inspect one ticket
gh issue view <number> --repo <owner>/<feedback-repo>

# Close a duplicate, cross-linking the canonical issue
gh issue close <dupe-number> --repo <owner>/<feedback-repo> \
  --comment "Duplicate of #<canonical-number>."

# Create a consolidated task issue tracking several source tickets
gh issue create --repo <owner>/<feedback-repo> \
  --title "task: <short description of the consolidated work>" \
  --label task \
  --body "$(cat <<'EOF'
Consolidates:
- [ ] #<n1>
- [ ] #<n2>
- [ ] #<n3>

<summary of the work>
EOF
)"

# Once shipped, close the task issue (source tickets can stay closed-as-dupe
# or be closed individually referencing the task issue).
gh issue close <task-number> --repo <owner>/<feedback-repo>
```

This is a manual, on-demand workflow at current scale — no cron, no bot.

**Future option (not built now):** the same `gh` commands above could run
headlessly on a schedule (e.g. a cron-triggered Claude Code session) to
auto-cluster and pre-summarize tickets for the maintainer. Nothing in this
design precludes that — the Worker/repo/label scheme is the same either way;
only a scheduler would be added on top (see §10 Phase 4).

## 9. Security & Abuse

| Risk | Mitigation |
|---|---|
| Spam / bot submissions | Honeypot field (silently dropped, fake success) + per-IP rate limit (§4). |
| Payload flooding | Hard 64 KB body cap, checked before JSON parse. |
| Distributed / cross-origin abuse | A third-party page could script visitors' browsers into flooding the Worker from many distinct IPs, each staying under the per-IP rate limit. Mitigation: the Worker sends CORS headers (`Access-Control-Allow-Origin`) only for the explicitly configured allowed origin — the fallback form's own origin, never a wildcard (§4 "CORS") — so a browser refuses to complete the cross-origin POST for any other page's script. This does not stop non-browser callers, who remain governed by the honeypot, validation, and per-IP rate limit above. |
| Token theft | PAT is fine-grained, scoped to `issues:write` on **one** private repo only — no `contents`, no other repos, no org scope. |
| Worker compromise | Blast radius is limited to the feedback repo: an attacker with the leaked PAT could create/read/close issues in that one private repo — they get no access to source code, other repos, CI, or secrets outside this Worker's own binding. |
| Repo compromise | Same blast radius — it's an isolated, purpose-built repo containing only user-submitted tickets (server-side sanitized of local paths and known secret patterns by the Worker before storage, and additionally client-side sanitized before leaving the machine on the extension path — §7), not source code. |
| Response leakage | Worker error responses are generic; never include the PAT, repo owner/name, or raw upstream (GitHub) error text. |
| Enumeration | No GET/list route exists — there is nothing to enumerate. |

## 10. Rollout Phases

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **1 — Repo + Worker** | Create the private feedback repo. Write and deploy the Cloudflare Worker (`POST /submit` only) with validation, honeypot, content sanitization, KV rate limit, and GitHub issue creation per §4. | A manual `curl` POST with a valid v1 payload creates exactly one correctly-labeled issue in the private repo and returns `201` with a `ticketId` echo. An invalid payload (bad schemaVersion, oversized body, missing required field) returns the documented error code and no issue is created. A honeypot-filled POST returns 201-shaped success but creates no issue. A second burst of requests past the per-IP limit is rejected. A POST whose `userDescription` contains a fake absolute path (e.g. `C:\Users\test\secret.txt`) and a fake `sk-`-prefixed key results in an issue where both are redacted (`<path>` and `[REDACTED]` respectively), confirming the Worker's server-side sanitization runs regardless of which surface sent the request. |
| **2 — Extension submit path** | Add the Settings UI, `SUBMIT_FEEDBACK` message + zod schema, host handler with sanitize + preview + POST + timeout + toast/fallback, per §5. | From the running extension: filling the form, previewing, and sending produces a real issue in the feedback repo; the preview payload shown to the user matches byte-for-byte what left the machine (verifiable via a temporary Worker echo/log during testing); disconnecting network and submitting falls back to clipboard copy + fallback-form pointer without throwing. **Additionally:** the plain-language disclosure block renders on the form itself (always visible or one tap away, never buried behind the JSON preview) and its text matches §7 "Plain-language disclosure (what gets sent)" verbatim; the user handbook documents the same data list (what's sent, what's not) in the feedback section. |
| **3 — Fallback form** | Build and deploy the static Cloudflare Pages form per §6, pointed at the same Worker route. | Submitting the fallback form with a pasted diagnostic report creates a correctly-labeled issue identical in shape to a Phase 2 submission; honeypot and rate limit both verified to apply here too. |
| **4 — Optional scheduled triage** | Not built until requested. Would add a headless scheduler invoking the same `gh` commands from §8 to pre-cluster/summarize tickets. | (Deferred — define acceptance criteria when this phase is greenlit.) |

## 11. Open Decisions for the Maintainer

| Decision | Suggestion | Notes |
|---|---|---|
| Private repo name | `tycoonagents-feedback` under the same GitHub owner as the main repo | Must stay private; never referenced from any shipped/tracked file per the project's "no absolute paths / no leaked internals" rule — the Worker holds the owner/repo as a secret-adjacent config value, not hardcoded in the extension. |
| Worker route/domain | e.g. `feedback.<maintainer-domain>/submit` or the default `*.workers.dev` subdomain | A custom domain avoids exposing the raw `workers.dev` name in extension code, but either works; `workers.dev` is fine for v1 and cheaper to stand up. |
| Category list final | `bug`, `idea`, `question`, `other` as specified | Confirm before Phase 2 ships — the enum is baked into both the extension zod schema and the Worker validator; changing it later is a schema-version bump, not a quick edit. |
| Contact field in v1 | Recommend: ship it, optional, off by default focus (empty unless user types something) | Low cost, high value for following up on bug reports; confirm before Phase 2 UI is built. |

## 12. Deferred / Out of Scope

- **Standalone (non-VS Code) host parity.** No standalone diagnostics
  pipeline exists today; when/if one is built, it should reuse this same
  Worker route and payload schema rather than inventing a second pipeline.
- Scheduled headless triage (§10 Phase 4).
- Any web-based read/browse UI for tickets — deliberately not built; `gh`
  and the GitHub web UI (for the maintainer's own private-repo access) cover
  this.
