# Corsair Theme Service — Client API Contract (v2)

This document is the client-side contract that the private `corsair-theme-service`
repo must implement. It supersedes v1: the auth model now mirrors Speciary's
Supabase-Auth-direct approach (`D:\ACode\Speciary`) instead of a bespoke
magic-link/device-token service, and pricing/ledger/webhook semantics mirror
Speciary's Stripe store. Service-internal architecture stays out of scope
(see `design-docs/theme-credits-prd.md`).

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
{ "email": "user@example.com", "displayName": "optional", "role": "user", "credits": 42 }
```
401 if the bearer token is missing/invalid/expired (mirrors
`server.ts`'s `GET /api/account` gate — verify-then-401 before any DB call).

## Pricing (public — no auth)

### `GET /api/pricing`
```json
{
  "attemptCostByBoardType": {
    "roster_agent": 1,
    "rival_group": 1,
    "objects_01": 1,
    "objects_02": 1,
    "environment": 1,
    "expressions": 1,
    "achievements": 1
  },
  "typicalTheme": { "min": 12, "max": 30 },
  "packs": [
    { "id": "mini30",     "credits": 30,   "priceCents": 299,  "currency": "usd" },
    { "id": "standard250","credits": 250,  "priceCents": 1999, "currency": "usd" },
    { "id": "bulk750",    "credits": 750,  "priceCents": 4999, "currency": "usd" },
    { "id": "whale2000",  "credits": 2000, "priceCents": 9999, "currency": "usd" }
  ]
}
```
Pack ids mirror Speciary's `StoreItem`/`STORE_ITEM_PRICE_CENTS` map
(`packages/service/src/stripe-store.ts:42`) and its four `STRIPE_PRICE_*` env
names, renamed to the theme service's own four packs. Actual credit counts
and prices are set by the service (Stripe Price objects, dashboard-managed);
the values above are illustrative.

## Checkout

### `POST /api/store/checkout`
```json
{ "pack": "standard250", "successUrl": "https://...", "cancelUrl": "https://..." }
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

## Ledger semantics (mirrors Speciary's `credit_ledger`)

Append-only rows, keyed by `(user_id, created_at)`
(`db/migrations/001_accounts.sql:28-45` in Speciary), with a **unique
partial index on `ref` where `ref is not null`**
(`001_accounts.sql:56-57`) as the idempotency backstop — the same "insert,
let the unique constraint reject a duplicate" guarantee Speciary's webhook
handler relies on, not a check-then-insert race.

- Spend: `delta = -attemptCost`, `reason = "spend-theme-attempt"`,
  `ref = "attempt:<idempotencyKey>"`. Replaying the same idempotency key
  hits the unique `ref` index and is a no-op — never a double debit.
- Refund: `delta = +attemptCost`, `reason = "refund-theme-attempt"`,
  `ref = "refund:<idempotencyKey>"`. Fires only on outright provider
  failure, never on a successfully returned image.
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
| 401 | `not_signed_in` | missing/invalid/expired access token | prompt sign-in |
| 402 | `insufficient_credits` | balance too low for this attempt | show balance + "Buy credits" |
| 429 | `rate_limited` | per-account/IP rate limit hit | "try again shortly" |
| 502 | `provider_failed` | image model call failed; auto-refunded | board failed, refunded, retry available |
| 503 | `unavailable` | service itself is down/unreachable | "Theme Service unavailable" |
| — | `unreachable` | network-level failure (no response), detected client-side | same UI state as 503 |

## Client constants

`SUPABASE_URL`, `SUPABASE_ANON_KEY` (public by design; baked into the
shipped client like `FEEDBACK_ENDPOINT`), `THEME_SERVICE_ENDPOINT`. Never
client-side: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, any `STRIPE_PRICE_*`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`.

## Service env vars (names only — mirrors Speciary's `render.yaml` pattern)

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MINI30`, `STRIPE_PRICE_STANDARD250`,
`STRIPE_PRICE_BULK750`, `STRIPE_PRICE_WHALE2000`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `SERVICE_ALLOWED_ORIGINS`, `PORT`.

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
  (`stripe-store.ts:165-176`). Rename `StoreItem` values to the four theme
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
2. Create the four Stripe Price objects (`mini30`, `standard250`, `bulk750`,
   `whale2000`) and set their ids into `STRIPE_PRICE_*` env vars in the
   Render (or equivalent) dashboard.
3. Enable Stripe Tax on the Checkout Session configuration.
