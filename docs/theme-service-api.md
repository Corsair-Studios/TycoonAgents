# Corsair Theme Service — Client API Contract (v3.6)

Operator setup: see theme-service-setup-guide.md

This document is the client-side contract that the private `corsair-theme-service`
repo must implement. It supersedes v1: the auth model now mirrors Speciary's
Supabase-Auth-direct approach (the Speciary reference implementation) instead of a bespoke
magic-link/device-token service, and pricing/ledger/webhook semantics mirror
Speciary's Stripe store. Service-internal architecture stays out of scope
(see `design-docs/theme-credits-prd.md`).

**v3 changelog:** adds content-moderation screening ahead of ledger debit
on `/api/generate` and `/api/plan`, a per-user provider safety identifier,
a strikes/account-lock mechanism for provider content-policy refusals, and
documents server-side rate-limit queuing/backoff and capacity scaling.

**v3.1 changelog:** final pricing — per-board-type attempt costs, three
credit packs (`starter45`, `theme100`, `bundle205`) replacing the earlier
four illustrative packs, and an optional `typicalTheme.typical` field.

**v3.2 changelog:** `theme100` and `bundle205` pack credits/bonusCredits
increased (100 total/10 bonus, and 205 total/25 bonus respectively);
clients may compute and display each pack's bonus percentage and tag the
best one "Best value".

**v3.3 changelog:** documents required backend input-handling rules
(parameterized DB access, pack-id/board-type/idempotency-key validation,
prompt/text length limits via `PROMPT_MAX_CHARS`/`IMAGE_MAX_BYTES`, no text
in logs/URLs/headers, `nosniff` JSON responses) and adds the `bad_request`
(400) error kind.

**v3.4 changelog (2026-09-16):**
- `POST /api/generate` moves from a free-text `prompt` field to a structured
  request (`theme` + board-specific `slot` fields); the service now owns
  prompt assembly from versioned templates. A body containing a `prompt`
  field is rejected `400 bad_request` (`code: "legacy_prompt"`).
- `PROMPT_MAX_CHARS` now caps the server-assembled prompt, not client input;
  per-field character caps replace it for request validation.
- Response adds `promptTemplateVersion` and `assembledPromptSha256`.
- Client sends `X-Tycoon-Client: <extension version>` (informational only,
  never trusted for authorization).
- Adds Eligibility (18+), Likeness (Content screening), Platform governance,
  and Data-handling detail sections below.
- Adds a Migration subsection describing the template/guide handoff into
  `corsair-theme-service` and the v3.3 client deprecation path.

**v3.5 changelog (2026-09-17):**
- Adds `POST /api/account/referral`, called once by the client immediately
  after a device's first sign-in, applying an optional referral code.
- `accounts` gains `referral_code` (nullable, set once, immutable) and
  `referral_applied_at`. `GET /api/account` adds `referralApplied: boolean`.
- Adds the `referrers` table and referral-commission accrual
  (`referral_commissions`) written by the Stripe webhook, plus a
  `referral_statement` operator view. Adds `charge.refunded` and
  `charge.dispute.created` to the webhook subscription list.
- Adds a Referral section summarizing default partner terms.
- Adds a Migration subsection: the service repo must re-copy the contract
  file before implementing v3.5.

**v3.6 changelog (2026-09-18):**
- Adds `GET /api/auth-config` — public, unauthenticated, returns
  `{ supabaseUrl, supabasePublishableKey, promptTemplateVersion,
  contractVersion: "3.6" }` with `Cache-Control: public, max-age=3600`.
  Clients fetch it once per endpoint per session, cache the result
  in-memory, and refetch only after a Supabase `401`.
- `supabasePublishableKey` accepts both the new-format `sb_publishable_`
  key and the legacy Supabase anon key; either is sent to Supabase Auth
  as the `apikey` header exactly as documented under Auth above.
- Adds a Migration subsection: client-baked `SUPABASE_URL`/
  `SUPABASE_ANON_KEY` constants are removed; see Client constants below.

## Conventions

- All requests/responses are JSON (`Content-Type: application/json`) unless noted.
- Client-side secrets: `THEME_SERVICE_ENDPOINT` only. `SUPABASE_URL` and
  the Supabase publishable/anon key are no longer baked-in client
  constants — the client fetches them from `GET /api/auth-config` (see
  below) and holds them in memory for the session.
  `THEME_SERVICE_ENDPOINT` is stored per-host: VS Code `SecretStorage`,
  standalone app-data `secrets/` (owner-only permissions) — same pattern as
  `FEEDBACK_ENDPOINT` in `src/host/vscode/feedbackSubmit.ts:36`.
- Never client-side: `SUPABASE_SERVICE_ROLE_KEY`, any `STRIPE_*` key, or any
  model provider key (`OPENAI_API_KEY`, `GEMINI_API_KEY`).
- Every service request (except the public `/api/auth-config`,
  `/api/pricing`, and `/api/health`) carries
  `Authorization: Bearer <access_token>`, a Supabase-issued JWT.

## Auth config (public — no auth)

### `GET /api/auth-config`

No `Authorization` header required. Response `200`,
`Cache-Control: public, max-age=3600`:
```json
{
  "supabaseUrl": "https://xxxx.supabase.co",
  "supabasePublishableKey": "sb_publishable_... (or legacy anon key)",
  "promptTemplateVersion": "2026-09-24.1",
  "contractVersion": "3.6"
}
```
`promptTemplateVersion` above reflects whatever the service's synced templates
currently report — it changes whenever the templates change, so treat the
value shown here as an example, not a pin.

`supabasePublishableKey` is public by design — it is either Supabase's
new-format `sb_publishable_` key or the legacy anon key; both are valid and
both are sent to Supabase Auth as the `apikey` header (see Auth below).
Nothing in this response is a secret.

Clients call this once per endpoint per session, cache
`{ supabaseUrl, supabasePublishableKey, promptTemplateVersion }` in memory
for the lifetime of that cached client instance, and refetch only when a
Supabase Auth call returns `401` (the cached values are treated as stale
and re-fetched before retrying).

## Auth — Supabase GoTrue REST, direct from the client

The client talks to Supabase Auth (GoTrue) directly, the same way Speciary's
viewer does via `@supabase/supabase-js` in
`packages/viewer/src/authClient.ts:20` (client built once at module load from
`SUPABASE_URL`/`SUPABASE_ANON_KEY`, `authEnabled()` gates every caller). The
theme-service client hits the same REST endpoints Supabase's SDK wraps, since
the extension/standalone hosts are not a browser SPA:

### Email magic-link / OTP

`POST {SUPABASE_URL}/auth/v1/otp`
Headers: `apikey: <supabasePublishableKey>` (from `GET /api/auth-config`;
the `apikey` header name is the same for both the new-format
`sb_publishable_` key and the legacy anon key)
```json
{ "email": "user@example.com", "create_user": true }
```
Response `200`, empty-ish body — Supabase emails a 6-digit code / magic link.

`POST {SUPABASE_URL}/auth/v1/verify`
```json
{ "type": "email", "email": "user@example.com", "token": "123456" }
```
(`"type": "magiclink"` when verifying a clicked link's token instead of a
typed code.) Response `200`:
```json
{ "access_token": "...", "refresh_token": "...", "expires_in": 3600, "user": { "id": "...", "email": "..." } }
```

### Google OAuth (PKCE)

`GET {SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=<redirect>&code_challenge=<challenge>&code_challenge_method=S256`
Opens in the system browser. `redirect_to` is:
- VS Code (and forks): deep link `<scheme>://<publisher>.<extension>/theme-service-auth`,
  where `<scheme>` is the running host's own `vscode.env.uriScheme` (p72-t1,
  `src/host/vscode/themeServiceHost.ts` `handleGoogleStart`) — never
  hardcoded to `vscode://` — so the OS reopens whichever editor started
  sign-in. Allow-list one entry per scheme in the Supabase dashboard:
  `vscode`, `vscode-insiders`, `vscodium`, `cursor`, `windsurf`,
  `antigravity`. Any other fork needs its own scheme added before sign-in
  completes on it; the extension's diagnostic report (Environment section)
  shows the exact scheme that fork reports.
- Standalone: loopback `http://127.0.0.1:*/callback` (no scheme entry
  needed — see setup guide section 2.5).

Both target shapes must be allow-listed in the Supabase dashboard
(**human step**; see `docs/theme-service-setup-guide.md` section 2.5).

If a callback lands in an editor/window with no sign-in pending (the
browser reopened a different window than the one that started sign-in),
the extension shows the auth code in an information message with a
**Copy code** action instead of a bare error — paste it into the Theme
Builder of the window where sign-in was started to finish it via the
existing paste-code field.

On callback, exchange the returned `auth_code` + the PKCE `code_verifier` the
client generated:
`POST {SUPABASE_URL}/auth/v1/token?grant_type=pkce`
```json
{ "auth_code": "...", "code_verifier": "..." }
```
Response: same session shape as `/auth/v1/verify`.

### Refresh

`POST {SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`
```json
{ "refresh_token": "..." }
```
Response: same session shape. The client refreshes proactively before
`expiresAt`, same lifecycle Speciary's `authClient.ts` leaves to
`supabase-js`'s internal auto-refresh — here the theme-service client owns it
explicitly since there is no SDK session manager.

### Sign-out

`POST {SUPABASE_URL}/auth/v1/logout`
Headers: `Authorization: Bearer <access_token>`
Response `204`. The client also clears its local token store.

### Token storage & verification

The client stores `{ accessToken, refreshToken, expiresAt }` in the per-host
token store (VS Code `SecretStorage` / standalone `secrets/`) and sends
`Authorization: Bearer <access_token>` to the Theme Service on every request.
The service verifies it via JWKS **exactly like Speciary**: `verifyBearer`
in `packages/service/src/auth.ts:123`, built once at startup by the resolver
at `auth.ts:101-103` (`createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', SUPABASE_URL))`,
issuer `new URL('/auth/v1', SUPABASE_URL)`, mode `'jwks'` per `auth.ts:66,103`).
No Theme Service session store, device token, or JWT secret of its own.

## Account

### `GET /api/account`
Response `200`:
```json
{ "email": "user@example.com", "displayName": "optional", "role": "user", "credits": 42, "locked": false, "strikes": 0, "referralApplied": false }
```
401 if the bearer token is missing/invalid/expired (mirrors
`server.ts`'s `GET /api/account` gate — verify-then-401 before any DB call).
`locked` mirrors `accounts.locked` (see Strikes and account lock below);
`strikes` is the trailing-24h `account_strikes` row count for this user.
`referralApplied` mirrors whether `accounts.referral_applied_at` is set —
never the referral code itself, and never the referring partner's identity
(see Referral below).

### `POST /api/account/referral`

Called by the client exactly once, immediately after the **first** sign-in
on a device (no prior local session found).

```json
{ "referralCode": "PARTNER-CODE" }
```

`referralCode` is a string, max 32 chars, charset `[A-Za-z0-9-]` — a value
outside that returns `400 { "error": "bad_request" }` before any DB read.

Server rule: the code is applied only when the authenticated account has
**no prior sign-in recorded and no ledger rows** (a true first-touch
account). Otherwise, or when the code doesn't validate, the endpoint still
responds `200` — never an error for a bad or inapplicable code:

```json
{ "applied": false, "reason": "existing_account" | "unknown_code" | "self_referral" | "inactive_code" }
```

- `existing_account`: the account already has a prior sign-in or ledger rows.
- `unknown_code`: no matching row in `referrers`.
- `self_referral`: `referrers.contact_email_hash` equals `sha256` of the
  signing-in account's email.
- `inactive_code`: the matching `referrers` row has `active = false`.

On success:
```json
{ "applied": true }
```
which sets `accounts.referral_code` (once, immutable) and
`accounts.referral_applied_at = now()`. A second call against an account
that already has `referral_applied_at` set returns
`{ "applied": false, "reason": "existing_account" }`.

## Pricing (public — no auth)

### `GET /api/pricing`
```json
{
  "attemptCostByBoardType": {
    "roster_agent": 3,
    "rival_group": 3,
    "objects_01": 2,
    "objects_02": 2,
    "environment": 3,
    "expressions": 2,
    "achievements": 2
  },
  "planCost": 1,
  "typicalTheme": { "min": 55, "max": 170, "typical": 95 },
  "packs": [
    { "id": "starter45", "label": "Starter", "credits": 45,  "bonusCredits": 0,  "priceCents": 499,  "currency": "usd" },
    { "id": "theme100",   "label": "Theme",   "credits": 100, "bonusCredits": 10, "priceCents": 999,  "currency": "usd" },
    { "id": "bundle205", "label": "Bundle",  "credits": 205, "bonusCredits": 25, "priceCents": 1999, "currency": "usd" }
  ]
}
```
Pack ids mirror Speciary's `StoreItem`/`STORE_ITEM_PRICE_CENTS` map
(`packages/service/src/stripe-store.ts:42`) and its `STRIPE_PRICE_*` env
names, renamed to the theme service's own three packs. `credits` is the
total granted including any bonus; `label` and `bonusCredits` are optional
for clients (a client that ignores them still gets a working `credits`
total). `planCost` is the credit cost of one `POST /api/plan` attempt
(either `kind`) — assumed `1` unless the operator sets it to `0`; see Plan
/ description generation below.

**Pricing rule:** the dollar price of a credit is fixed at the moment of
purchase — a purchased credit's value never changes. The credit cost of an
attempt (`attemptCostByBoardType`, `planCost`) is a server-side setting,
always shown to the user before every attempt, and may change over time;
this is how provider cost changes get absorbed without touching pack
prices. Bonus credits are ordinary credits once granted — no separate
accounting or expiry. Clients may display the bonus as a percentage of the
base amount (`bonusCredits / (credits - bonusCredits)`, rounded to a whole
number) and tag the pack with the highest percentage "Best value".

## Checkout

### `POST /api/store/checkout`
```json
{ "pack": "theme100", "successUrl": "https://...", "cancelUrl": "https://..." }
```
`successUrl`/`cancelUrl` optional — when omitted, the service derives both
from the request's trusted `Origin`, same fallback `server.ts` uses for
`/api/store/checkout` (see the origin-derivation block around Speciary's
`trustedRequestOrigin` call). Response `200`:
```json
{ "url": "https://checkout.stripe.com/c/pay/..." }
```
Checkout is `mode: "payment"`, `client_reference_id` = the authenticated
user id, Stripe Tax enabled on the session — same as Speciary's
`createCheckoutSession` (`stripe-store.ts:148`). The client only opens `url`
in the system browser; it never talks to Stripe directly, and never receives
a Stripe key.

A locked account (see Strikes and account lock below) gets `403
{ "error": "account_locked" }` here too, before a Checkout Session is
created.

## Generation

### `POST /api/generate`

The request is structured — the client sends theme/board data, never
free-text prompt text; the service assembles the actual model prompt
server-side from versioned templates it owns (see Migration below).

```json
{
  "idempotencyKey": "uuid-v4",
  "boardType": "objects_01",
  "promptTemplateVersion": "string — the template version the client was built against",
  "theme": {
    "description": "string, max 2000 chars",
    "creativeDirection": "string, max 1000 chars",
    "palette": ["#000000", "..."]
  },
  "slot": { "...": "board-specific fields — see below" },
  "userReferenceImages": ["data:image/png;base64,..."],
  "options": { "seed": 12345, "retryOf": "uuid-v4", "backgroundMode": "magenta" },
  "themeName": "string",
  "size": "1024x1024"
}
```

`theme.palette` is optional. `userReferenceImages` is optional, screened the
same as before (see Content screening), and capped by `IMAGE_MAX_BYTES` per
image. `options` is optional; `options.retryOf` names the `idempotencyKey`
of the attempt being retried, for server-side telemetry only.
`options.backgroundMode` is `"magenta" | "transparent"` (default
`"magenta"`); it selects which chroma-key convention the assembled prompt
instructs the model to pad unused pixels with — solid `#FF00FF` magenta or
fully transparent (alpha 0) — so client and server agree on how to key out
the board's background. `options.retryNotes` is an optional string, max 600
chars, screened as user text (see Content screening) — free-text revision
notes from a "augment"/"custom" retry, appended to the assembled prompt.
`themeName` is a required string carried alongside
`theme` for client-side labeling; it is not folded into `theme.description`
by the client — the service reads it from `theme.description` server-side
but the field is still sent so it round-trips for retries and telemetry.

A row-shaped field (used by several slots below) is a `RowSpec`:
`{ "display_name": "string, max 80", "visual_description": "string, max 300 (optional)", "motion_hint": "string, max 120 (optional)", "is_ranged_rack": "boolean (optional)" }`.

`slot` shape is board-type-specific:
- `roster_agent`: `{ "name": "string, max 80", "description": "string, max 600", "bodyPlan": "biped" | "quadruped" }`.
  The service attaches its own pose-guide reference image for the given
  `bodyPlan` (see Migration below) — the client never sends pose guides.
- `rival_group`: an array of `RowSpec` (array length as the client-side builder requires).
- `objects_01`: `{ "items": [RowSpec, ...] }` (array length as the builder requires).
- `objects_02`: `{ "animated": [RowSpec, RowSpec], "static": [RowSpec, RowSpec, RowSpec], "poofDescription": "string, max 300 (optional)", "crateDescription": "string, max 300 (optional)" }`.
- `expressions`: `{ "expressions": ["string, max 80", ...], "descriptions": ["string, max 300 (optional)", ...] }`.
- `achievements`: `{ "achievements": ["string, max 80", ...], "descriptions": ["string, max 300 (optional)", ...] }`.
- `environment`: no `slot` field (omit or send `{}`).
- `background_decor`: `{ "seats": [RowSpec, RowSpec, RowSpec, RowSpec], "statics": [RowSpec, RowSpec, RowSpec, RowSpec], "animated": RowSpec, "projectileDescription": "string, max 300 (optional)" }`.
- `emotes`: no `slot` field (omit or send `{}`).

`background_decor` and `emotes` are additional board types the extension
requests beyond the set in the `GET /api/pricing` example above; if
per-attempt costs are configured for them they appear in that server's
`attemptCostByBoardType` setting alongside the others — otherwise treat
their cost as TBD server setting until configured.

A request body containing a top-level `prompt` field (the removed v3.3
free-text shape) is rejected `400 { "error": "bad_request", "code":
"legacy_prompt" }` — see Migration below.

`idempotencyKey` is client-generated per attempt — an HTTP-level retry of
the same attempt reuses it; a new user-initiated retry gets a new key and
sets `options.retryOf` to the prior key.

The client sends `X-Tycoon-Client: <extension version>` on every request to
this endpoint; the service logs it for diagnostics but never trusts it for
authorization or entitlement decisions.

Response `200`:
```json
{
  "image": "data:image/png;base64,...",
  "attemptCost": 1,
  "credits": 41,
  "refunded": false,
  "promptTemplateVersion": "string — the template version actually used server-side",
  "assembledPromptSha256": "hex sha256 of the server-assembled prompt"
}
```
`assembledPromptSha256` is informational: the client computes the same hash
over its own local preview of the expected prompt and shows a mismatch
notice to the user if the two differ (a signal the client's template is
stale), without blocking the response.

Response `502` (provider failure, auto-refunded atomically server-side):
```json
{ "error": "provider_failed", "refunded": true, "credits": 42 }
```

Response `422` (content screening blocked the prompt/reference image before
any ledger debit — see Content screening below):
```json
{ "error": "content_blocked" }
```

Response `403` (account locked — see Strikes and account lock below):
```json
{ "error": "account_locked" }
```

## Plan / description generation

### `POST /api/plan`

Theme planning (the initial full plan) and description-only regeneration
(re-deriving `*_descriptions` under a possibly-updated creative direction)
both route through this one endpoint — same shape, distinguished only by
`kind`. The client builds the complete prompt text client-side (see
`src/extension/translator.ts`'s `buildThemePlanningPrompt` /
`buildThemeDescriptionsPrompt`) and sends it as `input.prompt`; the service
never reconstructs the prompt itself.

```json
{
  "idempotencyKey": "uuid-v4",
  "kind": "plan",
  "input": { "prompt": "string — the fully-built planning or description-regeneration prompt" }
}
```

`kind` is `"plan"` for a full new theme plan, or `"descriptions"` for a
descriptions-only re-derive. `idempotencyKey` follows the same client-
generated-per-attempt rule as `/api/generate`'s.

Response `200`:
```json
{ "output": { "...": "the parsed JSON object the prompt asked for" }, "attemptCost": 1, "credits": 41, "refunded": false }
```

`output` is the model's response already parsed into a JSON object (no
markdown fences, no envelope) — for `kind: "plan"` this is the full
`display_name`/`creative_direction`/`characters`/... shape
`buildThemePlanningPrompt` requests; for `kind: "descriptions"` it is just
the `*_descriptions` fields `buildThemeDescriptionsPrompt` requests. The
client never sees which underlying provider/model produced it.

Response `502` (provider failure, auto-refunded atomically server-side):
```json
{ "error": "provider_failed", "refunded": true, "credits": 42 }
```

Same auth (`Authorization: Bearer <access_token>`) and error codes as
`/api/generate` (see the Error shape table below). Cost is `planCost` from
`GET /api/pricing` (assumed `1` credit; the service may set it to `0`). Also
returns `422 { "error": "content_blocked" }` (content screening) and
`403 { "error": "account_locked" }` (locked account), same conditions as
`/api/generate` above.

## Content screening

Before any ledger debit, `/api/generate` and `/api/plan` run the
user-supplied text — the concatenated `theme.description`,
`theme.creativeDirection`, and `slot` fields for `/api/generate`, and the
`input.prompt` for `/api/plan` — plus any `userReferenceImages` entry the
provider's moderation endpoint supports, through that provider's
moderation/safety endpoint. Screening runs on user input, never on the
server-assembled prompt (which the service itself owns and controls). On a
moderation hit the service returns `422 { "error": "content_blocked" }`
immediately: no `credit_ledger` row is written (no debit, so no refund
either) and the underlying provider generation/plan call is never made.
`idempotencyKey` semantics are unchanged — a retried key that was
previously blocked is re-screened, not special-cased.

**Likeness rule:** user descriptions and `userReferenceImages` must not
depict identifiable real people. A detected face in an uploaded reference
image is a block reason — `422 { "error": "content_blocked", "category":
"likeness" }` — under the same screening pass, before any ledger debit.

## Safety identifier

Every provider call (moderation and generation/plan alike) carries a
per-user identifier so the provider can apply its own per-user abuse
enforcement, sent in that provider's `user`/safety-identifier request
field. The identifier is `sha256(<supabase user id>)` as a hex string —
never the user's email, and never the raw Supabase user id. This is the
only per-user signal sent to the provider; the service does not otherwise
attribute a generation call to an individual outside its own ledger/DB.

**TO VERIFY:** confirm the OpenAI request parameter name (`safety_identifier`
vs. the older `user` field) against the live OpenAI API reference when the
backend is implemented — the API has changed this field name before and the
correct one must be used at build time, not assumed from this doc.

## Eligibility

Use of the Theme Service requires the user to be 18 or older. Signing in
constitutes the user's attestation of this (there is no separate age-gate
prompt). This mirrors the Gemini API terms, which require users to be 18+
and prohibit directing the service at minors; OpenAI's terms carry an
equivalent restriction.

## Platform governance

The Theme Service and the extension/standalone app it ships in have their
own terms, independent of any AI provider's terms or enforcement. Corsair
maintains its own abuse-report channel (the app's existing Submit Feedback
flow) and its own enforcement path (the strikes/account-lock mechanism
above). A provider declining or allowing a given generation does not bind
Corsair's own moderation decisions, and vice versa.

## Strikes and account lock

A **provider content-policy refusal** — the provider itself declining to
generate on policy grounds, distinct from a generic `provider_failed`
outage/error — refunds the attempt exactly as a `provider_failed` refund
does today (see Ledger semantics below), **and** additionally writes one
row to a small ledger-adjacent `account_strikes` table:

```sql
account_strikes (
  user_id    uuid not null,
  attempt_id text not null,   -- the idempotencyKey of the refused attempt
  created_at timestamptz not null default now()
)
```

When a user's `account_strikes` rows in the trailing 24 hours reach
`STRIKE_LOCK_THRESHOLD` (env var, default `3`), the service sets
`accounts.locked = true` for that user. While locked, `/api/generate`,
`/api/plan`, and `/api/store/checkout` all return `403
{ "error": "account_locked" }` before doing any other work (auth still
checked first, so an expired token still yields `401`). `GET /api/account`
reports `locked` and the trailing-24h `strikes` count (see Account above)
so the client can surface why the user is blocked. Unlocking is a manual
operator action against the `accounts` table — there is no unlock
endpoint.

## Referral

A referral program lets partners share a code that new users enter at first
sign-in (see `POST /api/account/referral` above). Default terms, summarized
for reference — actual per-partner terms are a separate written agreement
(see Human steps below):

- **20% of net** (post-Stripe-fee) revenue on the referred account's
  **first purchase only** — no commission on subsequent purchases.
- **New accounts only** — an account with any prior sign-in or ledger
  activity cannot be referred (`existing_account`).
- **30-day window**: the code must be applied and the first purchase
  completed within `referrers.window_days` (default 30) of
  `accounts.referral_applied_at`.
- **30-day refund hold**: commission rows start `pending` and become
  `payable` only after `referral_commissions.hold_until` (30 days after
  accrual), so a chargeback/refund inside that window voids the commission
  instead of paying it out.
- **Monthly payout, USD 25 minimum**, computed from the
  `referral_statement` view (see below) — payout itself is a manual
  operator action, not an automated transfer.
- **Optional welcome bonus**: if `referrers.bonus_credits > 0`, the
  referred user's first purchase also grants that many bonus credits
  (see Stripe webhook below).

### `referrers` table

```sql
referrers (
  code                text primary key,
  display_name        text not null,
  contact_email_hash  text not null,  -- sha256 of the partner's account email
  rate_bps            int  not null default 2000,  -- 20.00%
  window_days         int  not null default 30,
  bonus_credits       int  not null default 0,
  active              bool not null default true,
  created_at          timestamptz not null default now()
)
```

Self-referral is refused (`self_referral`) when `contact_email_hash` equals
`sha256` of the new account's email.

### `referral_commissions` table

```sql
referral_commissions (
  id             uuid primary key default gen_random_uuid(),
  ledger_ref     text not null,        -- fk to the credit_ledger grant row's `ref`
  referrer_code  text not null references referrers(code),
  account_id     uuid not null,
  gross_cents    int  not null,
  net_cents      int  not null,        -- gross minus the Stripe fee reported by the checkout session
  amount_cents   int  not null,        -- round(net_cents * rate_bps / 10000)
  status         text not null default 'pending',  -- pending | payable | void
  hold_until     timestamptz not null, -- created_at + 30 days
  created_at     timestamptz not null default now()
)
```

Written by the Stripe webhook on `checkout.session.completed` only when all
three hold: `accounts.referral_code` is set, this grant is the account's
**first** grant, and `now() <= referral_applied_at + window_days`.

A `charge.refunded` or `charge.dispute.created` event sets `status = 'void'`
on the `referral_commissions` row whose `ledger_ref` matches the refunded/
disputed charge's grant. Both events are added to the webhook subscription
list (see Stripe webhook below).

**Welcome bonus:** when `referrers.bonus_credits > 0`, the same webhook call
that processes the referred account's first purchase writes a second grant
row with `ref = "bonus:<eventId>"` for that credit amount — once, on that
first purchase only.

### `referral_statement` view (operator source of truth)

```sql
create view referral_statement as
select
  referrer_code,
  date_trunc('month', created_at) as month,
  count(*)                                          as purchases,
  sum(gross_cents)                                   as gross_cents,
  sum(net_cents)                                     as net_cents,
  sum(amount_cents) filter (where status <> 'void')  as commission_cents,
  sum(amount_cents) filter (where status = 'void')   as voided_cents
from referral_commissions
group by referrer_code, date_trunc('month', created_at);
```

Payout is **manual, monthly, USD 25 minimum** per referrer per month; this
view is the source of truth for what's owed — no other table or ad hoc
query should be used to compute a payout.

## Data handling

Gemini's paid API tier does not use request prompts/images for model
training and retains request data only briefly for abuse-detection
purposes. OpenAI's default retention/training policy for this integration
is **TO VERIFY** by the operator against OpenAI's current API data-usage
policy before launch — do not assume parity with Gemini's terms. The
service logs `X-Tycoon-Client` and a hash of the assembled prompt
(`assembledPromptSha256`, see Generation above) for diagnostics; it never
logs prompt/text content itself (see Backend input handling above).

## Rate limits and scaling

The service queues attempts server-side and, on a provider `429`, retries
with exponential backoff for a bounded number of tries (e.g. 3) before
giving up and surfacing `429 { "error": "rate_limited" }` to the client —
the client never sees a provider `429` directly. Independent of that,
per-account limits (`RATE_LIMIT_ATTEMPTS_PER_MIN`,
`RATE_LIMIT_ATTEMPTS_PER_DAY` env vars) are enforced ahead of the provider
call and are set below the provider's account-wide limit, so one heavy
user cannot exhaust capacity for everyone else on the same provider
account. Capacity grows by requesting provider usage-tier/limit increases
and by shifting board types between the two configured providers
(`OPENAI_API_KEY` / `GEMINI_API_KEY`) — **never** by rotating or pooling
multiple API keys/accounts for the same provider; that is explicitly out
of scope, always.

## Backend input handling (required)

All database access goes through the Supabase client or parameterized
queries; the service never builds SQL by string concatenation, and every
ledger write (spend, refund, grant) uses the client with typed parameters —
no raw string-built statements anywhere near `credit_ledger`.

`pack` on `POST /api/store/checkout` is validated against the fixed pack id
list returned by `GET /api/pricing` before any Stripe call is made. An
unknown id returns `400 { "error": "bad_request" }` — no Stripe API call, no
ledger row.

`theme`, `slot`, and every other user-supplied text field on
`POST /api/generate`, and `input.prompt` on `POST /api/plan`, are accepted
only from the JSON body (never query string or headers), must be strings,
and are length-limited per field (`theme.description` 2000 chars,
`theme.creativeDirection` 1000 chars, `roster_agent.name` 80,
`roster_agent.description` 600; other `slot` fields per their board type).
`PROMPT_MAX_CHARS` (env var, default `4000`) no longer bounds client input —
it now caps the length of the prompt the service itself assembles from
templates, as a sanity check against a malformed or runaway template.
Reference image data is limited by `IMAGE_MAX_BYTES` env var, default `8`
MiB. A field over its limit or of the wrong type returns
`400 { "error": "bad_request" }` before any provider call or debit. A body
containing a `prompt` field returns `400 { "error": "bad_request", "code":
"legacy_prompt" }` (see Migration below). This text is never interpolated
into URLs, headers, shell commands, or file paths, and is never written to
logs verbatim — log a hash or length only, never the prompt/text content
itself.

`Idempotency-Key` and `boardType` are validated against a fixed charset (for
the key) and the known board-type list respectively before use; a value
outside either returns `400 { "error": "bad_request" }`.

Every response is served as `application/json` with
`X-Content-Type-Options: nosniff`; user-supplied text is never reflected
back into HTML.

## Migration (v3.3 → v3.4)

The prompt-assembly templates (`src/core/themePromptTemplates.ts`, produced
by task p59-t2) and the pose-guide reference images
(`media/pose-guides/*.png`) are copied into the backend repo
`Corsair-Studios/corsair-theme-service`, which owns prompt assembly from
that point on. `promptTemplateVersion` bumps on every template change so
the client can detect drift via `assembledPromptSha256` (see Generation
above).

A v3.3 client — one still sending the free-text `prompt` field — gets
`400 { "error": "bad_request", "code": "legacy_prompt" }` from
`/api/generate` and must upgrade to the structured v3.4 request shape; the
service does not fall back to free-text prompt handling.

## Migration (v3.4 → v3.5)

The `corsair-theme-service` repo must re-copy this contract
(`contract/theme-service-api.md`) before implementing the referral
endpoint, tables, and webhook changes above — the referral shapes are new
in v3.5 and are not present in any contract copy taken before this
changelog entry.

## Migration (v3.5 → v3.6)

Client-baked `SUPABASE_URL`/`SUPABASE_ANON_KEY` constants are removed.
Clients must call `GET /api/auth-config` before any Supabase Auth request
and use its `supabaseUrl`/`supabasePublishableKey` values instead; there is
no fallback to baked-in constants. `corsair-theme-service` must implement
`GET /api/auth-config` before any v3.6 client is deployed.

## Ledger semantics (mirrors Speciary's `credit_ledger`)

Append-only rows, keyed by `(user_id, created_at)`
(`db/migrations/001_accounts.sql:28-45` in Speciary), with a **unique
partial index on `ref` where `ref is not null`**
(`001_accounts.sql:56-57`) as the idempotency backstop — the same "insert,
let the unique constraint reject a duplicate" guarantee Speciary's webhook
handler relies on, not a check-then-insert race.

- Spend (`/api/generate`): `delta = -attemptCost`, `reason =
  "spend-theme-attempt"`, `ref = "attempt:<idempotencyKey>"`. Replaying the
  same idempotency key hits the unique `ref` index and is a no-op — never a
  double debit.
- Spend (`/api/plan`): same shape, `ref = "plan:<idempotencyKey>"`.
- Refund: `delta = +attemptCost` (or `+planCost` for a `/api/plan` spend),
  `reason = "refund-theme-attempt"`, `ref = "refund:<idempotencyKey>"`.
  Fires only on outright provider failure, never on a successfully returned
  image/plan.
- Grant (from Stripe webhook only): `ref = "stripe:<eventId>:<pack>"`.

## Stripe webhook

### `POST /api/stripe-webhook`
Server-to-server only, never called by the client. Reads the **raw** request
body (signature verification needs the exact signed bytes, not re-serialized
JSON) and verifies `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET` before
touching it — mirrors `server.ts`'s `/api/stripe-webhook` route (raw body via
`readRawBody`, `stripeStore.handleWebhookEvent`, signature failure → `400`
without echoing Stripe's error detail) and `stripe-store.ts:165-176`
(`constructEvent`, then `checkout.session.completed` grants credits). The
webhook is the **only** writer of ledger "grant" rows and must be idempotent
against Stripe's at-least-once delivery via the `ref` unique index above.

The webhook subscription list adds `charge.refunded` and
`charge.dispute.created` (v3.5) — both events void the matching
`referral_commissions` row (see Referral above) but write no ledger rows of
their own.

## Error shape

Every non-2xx response is:
```json
{ "error": "string" }
```
(same shape Speciary's `accountClient.ts` expects from every service route).

| HTTP | `error` | Meaning | Client UI state |
| --- | --- | --- | --- |
| 400 | `bad_request` | invalid/oversized input (pack id, prompt/text field, idempotency key, board type) | show validation error, let user fix input |
| 401 | `not_signed_in` | missing/invalid/expired access token | prompt sign-in |
| 402 | `insufficient_credits` | balance too low for this attempt | show balance + "Buy credits" |
| 403 | `account_locked` | account locked after repeated content-policy strikes | show locked state, no retry, contact support |
| 422 | `content_blocked` | moderation screening blocked the prompt/image before any debit | show blocked state, no refund needed (never debited), let user edit prompt |
| 429 | `rate_limited` | per-account/IP rate limit hit, or provider 429 exhausted retries | "try again shortly" |
| 502 | `provider_failed` | image model call failed; auto-refunded | board failed, refunded, retry available |
| 503 | `unavailable` | service itself is down/unreachable | "Theme Service unavailable" |
| — | `unreachable` | network-level failure (no response), detected client-side | same UI state as 503 |

## Client constants

`THEME_SERVICE_ENDPOINT` (baked into the shipped client like
`FEEDBACK_ENDPOINT`). `supabaseUrl` and `supabasePublishableKey` are no
longer client constants — they are fetched at runtime from
`GET /api/auth-config` and cached in memory for the session (see Auth
config above). Never client-side: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, any `STRIPE_PRICE_*`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`.

Client-side error-kind enum (mirrors the `error` column of the Error
shape table above — keep in sync): `bad_request`, `not_signed_in`,
`insufficient_credits`, `account_locked`, `content_blocked`, `rate_limited`,
`provider_failed`, `unavailable`, `unreachable`.

## Service env vars (names only — mirrors Speciary's `render.yaml` pattern)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER45`, `STRIPE_PRICE_THEME100`,
`STRIPE_PRICE_BUNDLE205`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `SERVICE_ALLOWED_ORIGINS`, `PORT`,
`STRIKE_LOCK_THRESHOLD` (default `3`), `RATE_LIMIT_ATTEMPTS_PER_MIN`,
`RATE_LIMIT_ATTEMPTS_PER_DAY`, `PROMPT_MAX_CHARS` (default `4000`),
`IMAGE_MAX_BYTES` (default `8` MiB).

(Speciary's `render.yaml` sets these as `sync: false` — Render-dashboard
managed secrets, never committed — plus a plaintext `SERVICE_ALLOWED_ORIGINS`
value; the theme service should follow the same split.)

## Reuse from Speciary (copy near-verbatim)

- **Auth verification**: `packages/service/src/auth.ts` in full — the
  `verifyBearer` function (`auth.ts:123`) and the JWKS-mode verifier builder
  (`auth.ts:79-103`). No device-token or session-store code needed; this
  file already does exactly what the Theme Service needs.
- **Stripe store**: `packages/service/src/stripe-store.ts` — the
  `StripeLike`-interface pattern, `STORE_ITEM_PRICE_CENTS`/env-price-map
  loader (`stripe-store.ts:42,62-70`), `createCheckoutSession`
  (`stripe-store.ts:148`), and `handleWebhookEvent`
  (`stripe-store.ts:165-176`). Rename `StoreItem` values to the three theme
  packs; drop the subscription-mode branches (theme service is one-time
  packs only, no `STRIPE_PRICE_SUB_MONTHLY`).
- **DB / repo pattern**: `db/migrations/001_accounts.sql`'s `credit_ledger`
  table and its unique partial `ref` index (lines 28-57) — copy the table
  shape and the repo-layer "insert, let the unique constraint reject a
  duplicate" idempotency pattern wholesale.
- **Deploy blueprint**: `render.yaml` — same service shape (Node web
  service, `healthCheckPath: /api/health`, `sync: false` secrets block),
  adapted to the Theme Service's own env var names above.

## Human steps (cannot be automated)

1. Allow-list both auth redirect targets (`vscode://<publisher>.<extension>/theme-service-auth`
   and the standalone loopback origin) in the Supabase dashboard's Auth →
   URL Configuration.
2. Create the three Stripe Price objects (`starter45`, `theme100`,
   `bundle205`) and set their ids into `STRIPE_PRICE_*` env vars in the
   Render (or equivalent) dashboard.
3. Enable Stripe Tax on the Checkout Session configuration.
