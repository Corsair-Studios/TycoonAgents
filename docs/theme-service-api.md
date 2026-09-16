# Corsair Theme Service — Client API Contract (v3)

Operator setup: see theme-service-setup-guide.md

This document is the client-side contract that the private `corsair-theme-service`
repo must implement. It supersedes v1: the auth model now mirrors Speciary's
Supabase-Auth-direct approach (`D:\ACode\Speciary`) instead of a bespoke
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

## Conventions

- All requests/responses are JSON (`Content-Type: application/json`) unless noted.
- Client-side secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public by design —
  Supabase's anon key is meant to ship client-side), and
  `THEME_SERVICE_ENDPOINT`. Stored per-host: VS Code `SecretStorage`,
  standalone app-data `secrets/` (owner-only permissions) — same pattern as
  `FEEDBACK_ENDPOINT` in `src/host/vscode/feedbackSubmit.ts:36`.
- Never client-side: `SUPABASE_SERVICE_ROLE_KEY`, any `STRIPE_*` key, or any
  model provider key (`OPENAI_API_KEY`, `GEMINI_API_KEY`).
- Every service request (except the public `/api/pricing` and `/api/health`)
  carries `Authorization: Bearer <access_token>`, a Supabase-issued JWT.

## Auth — Supabase GoTrue REST, direct from the client

The client talks to Supabase Auth (GoTrue) directly, the same way Speciary's
viewer does via `@supabase/supabase-js` in
`packages/viewer/src/authClient.ts:20` (client built once at module load from
`SUPABASE_URL`/`SUPABASE_ANON_KEY`, `authEnabled()` gates every caller). The
theme-service client hits the same REST endpoints Supabase's SDK wraps, since
the extension/standalone hosts are not a browser SPA:

### Email magic-link / OTP

`POST {SUPABASE_URL}/auth/v1/otp`
Headers: `apikey: <SUPABASE_ANON_KEY>`
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

`GET {SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=<redirect>&code_challenge=<challenge>&code_challenge_method=s256`
Opens in the system browser. `redirect_to` is:
- VS Code: deep link `vscode://<publisher>.<extension>/theme-service-auth`.
- Standalone: loopback `http://127.0.0.1:<port>/callback`.

Both targets must be allow-listed in the Supabase dashboard (**human step**).

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
{ "email": "user@example.com", "displayName": "optional", "role": "user", "credits": 42, "locked": false, "strikes": 0 }
```
401 if the bearer token is missing/invalid/expired (mirrors
`server.ts`'s `GET /api/account` gate — verify-then-401 before any DB call).
`locked` mirrors `accounts.locked` (see Strikes and account lock below);
`strikes` is the trailing-24h `account_strikes` row count for this user.

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
```json
{
  "idempotencyKey": "uuid-v4",
  "boardType": "objects_01",
  "prompt": "string",
  "referenceImages": ["data:image/png;base64,..."],
  "size": "1024x1024"
}
```
`referenceImages` optional. `idempotencyKey` is client-generated per attempt
— an HTTP-level retry of the same attempt reuses it; a new user-initiated
retry gets a new key.

Response `200`:
```json
{ "image": "data:image/png;base64,...", "attemptCost": 1, "credits": 41, "refunded": false }
```

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

Before any ledger debit, `/api/generate` and `/api/plan` run the assembled
prompt text — and, for `/api/generate`, any `referenceImages` entry the
provider's moderation endpoint supports — through that provider's
moderation/safety endpoint. On a moderation hit the service returns
`422 { "error": "content_blocked" }` immediately: no `credit_ledger` row is
written (no debit, so no refund either) and the underlying provider
generation/plan call is never made. `idempotencyKey` semantics are
unchanged — a retried key that was previously blocked is re-screened, not
special-cased.

## Safety identifier

Every provider call (moderation and generation/plan alike) carries a
per-user identifier so the provider can apply its own per-user abuse
enforcement, sent in that provider's `user`/safety-identifier request
field. The identifier is `sha256(<supabase user id>)` as a hex string —
never the user's email, and never the raw Supabase user id. This is the
only per-user signal sent to the provider; the service does not otherwise
attribute a generation call to an individual outside its own ledger/DB.

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

`prompt` and every other text field on `POST /api/generate` and
`POST /api/plan` are accepted only from the JSON body (never query string or
headers), must be strings, and are length-limited (`PROMPT_MAX_CHARS` env
var, default `4000`); reference image data is limited by `IMAGE_MAX_BYTES`
env var, default `8` MiB. A field over its limit or of the wrong type
returns `400 { "error": "bad_request" }` before any provider call or debit.
This text is never interpolated into URLs, headers, shell commands, or file
paths, and is never written to logs verbatim — log a hash or length only,
never the prompt/text content itself.

`Idempotency-Key` and `boardType` are validated against a fixed charset (for
the key) and the known board-type list respectively before use; a value
outside either returns `400 { "error": "bad_request" }`.

Every response is served as `application/json` with
`X-Content-Type-Options: nosniff`; user-supplied text is never reflected
back into HTML.

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

`SUPABASE_URL`, `SUPABASE_ANON_KEY` (public by design; baked into the
shipped client like `FEEDBACK_ENDPOINT`), `THEME_SERVICE_ENDPOINT`. Never
client-side: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
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
