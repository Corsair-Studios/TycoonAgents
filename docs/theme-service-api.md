# Corsair Theme Service — Client API Contract

This document is the client-side contract that the private `corsair-theme-service`
repo must implement. It describes only what the TycoonAgents client (VS Code
extension, standalone app, and future OpenCode-host surface) sends and expects
back — service-internal architecture is out of scope (see
`design-docs/theme-credits-prd.md`).

## Conventions

- Base URL: a single maintainer-controlled hostname baked into every shipped
  release (`THEME_SERVICE_ENDPOINT`), the same pattern as `FEEDBACK_ENDPOINT`
  in `src/host/vscode/feedbackSubmit.ts:36` — repointable server-side without
  a client update, never a `workers.dev`-style throwaway subdomain.
- All requests/responses are JSON (`Content-Type: application/json`) unless noted.
- Auth: `Authorization: Bearer <device token>` on every endpoint except
  `/auth/magic-link`, `/auth/verify`, `/auth/google/start`, and
  `/auth/google/complete`.
- Versioning: every request carries `X-Theme-Service-Version: <client semver>`;
  the service may reject an incompatible version with `426 Upgrade Required`.
- No model provider key (OpenAI, Google, or otherwise) is ever held or
  reachable client-side — only `THEME_SERVICE_ENDPOINT` and the device token
  are client-side secrets (VS Code `SecretStorage`; standalone app-data
  `secrets/` with owner-only file permissions).

## Auth

### `POST /auth/magic-link`
Request:
```json
{ "email": "user@example.com" }
```
Response: `202 Accepted`, empty body. Rate limited per email and per IP
(prevents enumeration/spam, per PRD § Rate limits / abuse controls).

### `POST /auth/verify`
Request:
```json
{ "email": "user@example.com", "code": "123456" }
```
Response `200`:
```json
{
  "deviceToken": "opaque-string",
  "account": { "id": "acct_123", "email": "user@example.com", "provider": "email" }
}
```

### `POST /auth/google/start`
Request: `{}`
Response `200`:
```json
{ "sessionId": "sess_abc", "browserUrl": "https://theme-service.example/oauth/google?session=sess_abc" }
```
The service performs the Google OAuth code exchange server-side; the client
never holds a Google client secret. The browser callback lands on the
service, which also displays a short one-time code the user can paste back
into the client when the host cannot receive a callback:
- VS Code: deep link `vscode://<publisher>.<extension>/theme-service-auth?session=<sessionId>`.
- Standalone: loopback `http://127.0.0.1:<port>/callback`.

### `POST /auth/google/complete`
Request (either shape, depending on which callback path fired):
```json
{ "sessionId": "sess_abc" }
```
or
```json
{ "code": "SHORT-CODE" }
```
Response: same shape as `/auth/verify`, with `"provider": "google"`.

### `POST /auth/sign-out`
Request: `{}` (device token from the `Authorization` header is the one revoked)
Response: `204 No Content`.

## Account

### `GET /me`
Response `200`:
```json
{
  "account": { "id": "acct_123", "email": "user@example.com", "provider": "email" },
  "balance": { "credits": 42 }
}
```

### `GET /me/balance`
Response `200`:
```json
{ "credits": 42 }
```

## Pricing

### `GET /pricing`
Response `200`:
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
    { "sku": "pack_s",  "credits": 20,  "priceCents": 500,  "currency": "usd" },
    { "sku": "pack_m",  "credits": 50,  "priceCents": 1000, "currency": "usd" },
    { "sku": "pack_l",  "credits": 120, "priceCents": 2000, "currency": "usd" },
    { "sku": "pack_xl", "credits": 260, "priceCents": 4000, "currency": "usd" },
    { "sku": "pack_xxl","credits": 600, "priceCents": 8000, "currency": "usd" }
  ]
}
```
Board type keys and the five-pack count/placeholder values are illustrative
(per PRD § Credit-pack pricing, exact sizes/prices are TBD); `typicalTheme.min`
is the deterministic no-retry board count, `.max` comes from observed retry
data once available (M0/M1).

## Checkout

### `POST /checkout/session`
Request:
```json
{ "sku": "pack_m" }
```
Response `200`:
```json
{ "url": "https://checkout.stripe.com/c/pay/...", "sessionId": "cs_test_..." }
```
The client opens `url` in the system browser and never talks to Stripe
directly. The Stripe webhook (server-to-server, `checkout.session.completed`)
is the **only** writer of ledger "grant" rows; the webhook handler must be
idempotent against Stripe's at-least-once delivery. Stripe Tax is enabled on
the Checkout Session.

## Generation

### `POST /generate`
Request:
```json
{
  "idempotencyKey": "uuid-v4",
  "boardType": "objects_01",
  "prompt": "string",
  "referenceImages": ["data:image/png;base64,..."],
  "size": "1024x1024"
}
```
`referenceImages` is optional. `idempotencyKey` is client-generated per
attempt (a retry of the *same* attempt — e.g. an HTTP retry after a dropped
connection — reuses the same key; a new user-initiated retry on the board
gets a new key). The key guarantees a retried HTTP request never double-debits
the ledger. Re-slicing an existing generation from its raw atlas is entirely
client-side and never calls this endpoint (no model call, never billed).

Response `200` (image returned):
```json
{
  "image": "data:image/png;base64,...",
  "attemptCost": 1,
  "balance": 41,
  "refunded": false
}
```
`image` may be a base64 data URI or an `https://` URL to a service-hosted
asset — client must handle either.

Response `502` (provider failure — no image returned):
```json
{ "error": "provider_failed", "refunded": true, "balance": 42 }
```
The debit and refund happen atomically server-side on this same request; the
client never issues a separate refund call.

## Error Codes

| HTTP | `error` | Meaning | Client UI state |
| --- | --- | --- | --- |
| 401 | `not_signed_in` | missing/invalid/expired device token | prompt sign-in |
| 402 | `insufficient_credits` | balance too low for this attempt | show balance + "Buy credits" |
| 429 | `rate_limited` | per-account/IP/email rate limit hit | "try again shortly" |
| 502 | `provider_failed` | image model call failed; auto-refunded | board failed, refunded, retry available |
| 503 | `unavailable` | service itself is down/unreachable at the app layer | "Theme Service unavailable" |
| — | `unreachable` | network-level failure (no response), detected client-side, not a service status code | "Theme Service unavailable" (same UI state as 503) |

Each code maps to a **distinct** UI state (PRD § Offline behaviour / error
states) — never collapse these into one generic "generation failed" message.

## Idempotency & Ledger Semantics

- The ledger is append-only: every grant, spend, and refund is its own row
  keyed by account id, never a mutated running total only — auditable for
  support disputes.
- Exactly one debit per generation *attempt*, including HTTP-level retries of
  that same attempt (guaranteed by `idempotencyKey`); a new user-initiated
  retry on a board is a new attempt with a new key and a new debit.
- A refund fires only on outright call failure (provider error, no image
  returned) — never on a successfully returned image the user simply dislikes.
- Re-slicing from a raw atlas never touches the ledger; it is client-side and
  makes no request to `/generate`.

## Telemetry

Minimal, server-side only: request count and pass/fail per board, for
capacity planning and refund auditing. No prompt or image content telemetry
beyond what generation itself requires.
