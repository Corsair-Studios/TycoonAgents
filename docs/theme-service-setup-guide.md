# Corsair Theme Service — Operator Setup Guide

This is an operator walkthrough for standing up the accounts and
infrastructure the private `corsair-theme-service` backend runs on. It
implements the client contract in `docs/theme-service-api.md` (v3.3;
v3.4 pending — see plan phase p59). The extension talks to it at
`THEME_SERVICE_ENDPOINT = https://theme.corsairstudios.com`
(`src/core/themeServiceClient.ts:25`).

This guide assumes you've done the equivalent setup once already for
Speciary (the Speciary repository's render.yaml) — it calls out where the theme service
differs instead of re-explaining shared concepts from scratch.

**No secret values, keys, or client secrets appear anywhere in this
document — only env var names and dashboard steps. Never paste an actual
key/secret into this file or any committed doc.**

## 1. Overview

What gets created, and why this order avoids rework:

1. **Supabase project** — auth (email OTP + Google OAuth) and the
   Postgres database (accounts, credit ledger, strikes). Created first
   because Google's OAuth client needs Supabase's callback URL, and
   Stripe's webhook target needs the service to already have a place to
   write grants.
2. **Google Cloud OAuth client** — needed so Supabase's Google provider
   has a client id/secret to hold. Created between reading the Supabase
   project ref and enabling the provider, since Supabase refuses to save
   the Google provider without a client id, and the OAuth client's
   redirect URI is Supabase's own callback, not the extension's.
3. **Stripe products/prices/webhook** — created third; independent of
   Supabase/Google, but the backend needs `STRIPE_PRICE_*` env vars set
   before it can serve `/api/pricing` and `/api/store/checkout`
   correctly, so do this before deploying Render.
4. **Render web service** — deployed fourth, once Supabase, Google, and
   Stripe all exist, since Render's env vars pull from all three.
5. **DNS** for `theme.corsairstudios.com` — added fifth, once Render's
   service exists and has a hostname to point at.
6. **Client allow-lists** — last: with the real Supabase project ref and
   production domain live, add the vscode:// deep link and loopback
   origins to Supabase's redirect allow-list, and set
   `SERVICE_ALLOWED_ORIGINS` on Render to the real client origins.

The backend repo (`corsair-theme-service`) is separate and private, and
implements `docs/theme-service-api.md` v3.3. This guide only covers
provisioning accounts and infrastructure for that repo to deploy into —
it does not cover writing the backend code itself.

## 2. Supabase

1. Go to https://supabase.com/dashboard and create a new project.
   Choose a region close to where you'll deploy Render (see step 5,
   Render region) to minimize auth/API latency — pick the Render region
   first if you already know it, otherwise pick Supabase's US region
   nearest your primary user base and match Render to it later.
2. Once the project is provisioned, open **Authentication → Providers**.
3. Enable **Email** provider, and turn on **OTP** (one-time-code) sign-in
   under its settings — this is the `/auth/v1/otp` + `/auth/v1/verify`
   flow the client contract uses (`docs/theme-service-api.md`, "Email
   magic-link / OTP"). You do not need magic-link click-through, only the
   6-digit code path, though leaving both on is fine.
4. Leave the **Google** provider disabled for now — Supabase refuses to
   save the provider without a client id. The project ref you need for
   section 3 is the subdomain of the project URL shown under **Project
   Settings → API** (step 6 below); the Google provider panel shows the
   exact callback URL to use even before you enable it. Open section 3
   (Google Cloud) now, create the OAuth client with that callback, then
   return here and enable Google with the client id and secret filled in
   together in one save.
5. Open **Authentication → URL Configuration** and add these to the
   **Redirect URLs** allow-list:
   - `vscode://tycoonagents.tycoonagents/theme-service-auth` — the exact
     deep link value, derived from `package.json`'s `publisher` +
     `name` (`tycoonagents.tycoonagents`), matching the VS Code deep-link
     pattern in `docs/theme-service-api.md` under "Google OAuth (PKCE)".
   - One or more loopback entries for the standalone host, shaped like
     `http://127.0.0.1:<port>/callback`.

   **Decision needed:** Supabase's redirect-URL allow-list supports
   exact-match entries and a limited wildcard syntax (e.g. a trailing
   `*` on the path, not on the port). If Supabase does not accept a
   wildcard port for `127.0.0.1:*`, the standalone host must bind to a
   **fixed, pre-registered port** (or a short fixed list of ports) so
   each one can be listed explicitly — e.g. `http://127.0.0.1:43117/callback`.
   This is flagged again in section 9 as an open decision; verify
   Supabase's current wildcard behavior in the dashboard before deciding,
   since Supabase's rules have changed release to release.
6. Under **Project Settings → API**, copy down (names only — do not
   paste the actual values into any file):
   - `SUPABASE_URL`
   - the anon/public key, used client-side as `SUPABASE_ANON_KEY`
     (public by design — ships baked into the client, same as
     `THEME_SERVICE_ENDPOINT`; see `src/core/themeServiceClient.ts:24-28`).
   - `SUPABASE_SERVICE_ROLE_KEY` — **server-only**, goes into Render as a
     `sync: false` secret in step 5, never into the client.
7. Open the **SQL Editor** and run the schema SQL from the contract, the
   same way Speciary's `db/migrations/001_accounts.sql` was applied:
   - the `credit_ledger` table with its **unique partial index on `ref`
     where `ref is not null`** (the idempotency backstop described under
     "Ledger semantics" in `docs/theme-service-api.md`).
   - the `accounts` table (holds `locked` and any per-user fields the
     `/api/account` response reads).
   - the `account_strikes` table exactly as specified under "Strikes and
     account lock":
     ```sql
     account_strikes (
       user_id    uuid not null,
       attempt_id text not null,
       created_at timestamptz not null default now()
     )
     ```
   Pull the exact DDL from the `corsair-theme-service` repo's migrations
   directory (or from Speciary's `001_accounts.sql` as a structural
   reference for `credit_ledger`) rather than hand-typing it here.

## 3. Google Cloud

1. Go to https://console.cloud.google.com/ and select (or create) the
   project you want to host this OAuth client under.
2. Open **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
3. Application type: **Web application**.
4. Under **Authorized redirect URIs**, add Supabase's own callback —
   **not** the extension's `vscode://` deep link:
   `https://<project-ref>.supabase.co/auth/v1/callback`
   (substitute your actual Supabase project ref from step 2.1). Supabase
   is the OAuth relying party here; it forwards the result to the
   extension/standalone client via the `redirect_to` param set at
   `/auth/v1/authorize` time.
5. Save, then copy the generated **Client ID** and **Client secret**
   (values only — do not write them into this repo) into Supabase's
   Google provider fields from step 2.4.
6. Configure the **OAuth consent screen**:
   - User type: **External**.
   - App name: `TycoonAgents Theme Service`.
   - Scopes: `email` and `profile` only — no additional sensitive or
     restricted scopes.
   - **Publish the app to production** (not "Testing"). Testing mode
     caps sign-ins at 100 test users, which will block real customers.
   - App logo / branding verification is only required if you add a
     logo to the consent screen; skip it if you leave the screen
     text-only, which avoids Google's verification review entirely.

## 4. Stripe

1. In the Stripe Dashboard, create three **Products**, each with exactly
   one one-time **Price** in USD:
   - **Starter** — 45 credits — $4.99 (499 cents)
   - **Theme** — 100 credits (10 bonus) — $9.99 (999 cents)
   - **Bundle** — 205 credits (25 bonus) — $19.99 (1999 cents)
2. On each Product, set **metadata** so the webhook handler can
   cross-check the grant against what Stripe billed, independent of
   trusting the price id alone:
   - `credits` — total credits granted (45 / 100 / 205)
   - `bonusCredits` — bonus portion (0 / 10 / 25)
   - `packId` — `starter45` / `theme100` / `bundle205`, matching the
     pack ids `GET /api/pricing` returns.
3. Copy each Price's id (starts with `price_...`) into these env var
   **names** for Render (step 5) — values go only into Render's
   dashboard, never into any file here:
   - `STRIPE_PRICE_STARTER45`
   - `STRIPE_PRICE_THEME100`
   - `STRIPE_PRICE_BUNDLE205`
4. Enable **Stripe Tax** (Dashboard → Tax settings) and set the tax
   category for these products to a digital-goods/SaaS category, so
   Checkout Sessions compute tax automatically as the contract requires
   (`docs/theme-service-api.md`, "Checkout": "Stripe Tax enabled on the
   session").
5. You do **not** need the Stripe Customer Portal — these are one-time
   purchases, not subscriptions.
6. Create the webhook endpoint:
   - URL: `https://theme.corsairstudios.com/api/stripe-webhook`
   - Events: **`checkout.session.completed`** only.
   - Copy the endpoint's **signing secret** into the env var name
     `STRIPE_WEBHOOK_SECRET` for Render (value goes only into Render's
     dashboard).
7. Do all of the above first in **Test mode** with test-mode price ids,
   verify end to end (see section 8's smoke test), then repeat products,
   prices, tax setting, and the webhook endpoint in **Live mode** with a
   separate live price id set before accepting real payments.
8. For local testing before Render is deployed, use the Stripe CLI:
   `stripe listen --forward-to localhost:<PORT>/api/stripe-webhook`
   substituting whatever local port the backend dev server binds to.
9. Refunds: no automated refund flow. Refunds are issued manually from
   the Stripe dashboard, "up to Stripe['s standard dispute/refund
   process]" per the terms draft — there is no in-app refund button.

## 5. Render.com

Render is used the same way it is for Speciary.

1. In the Render dashboard, create a new **Web Service** from the
   private `corsair-theme-service` repo.
2. Environment: **Node**.
3. Plan: staged by rollout phase, not fixed up front. Render bills a
   **workspace plan** (Hobby $0, Pro $25/mo, Scale $499/mo) separately
   from the **instance type** each service runs on. Use the Hobby
   workspace: its 2 custom domains, 500 build minutes, and 5 GB bandwidth
   cover a solo operator; Pro is only for team seats, audit logs, or
   bandwidth past 25 GB.
   - **Stage 1 (setup and Stripe test mode):** Free instance, $0 (limitations
     apply). It spins down after ~15 minutes idle and cold-starts in 30-60 s. Stripe
     retries webhooks for up to 3 days, so purchases still land, just
     late. The extension's request timeout must exceed the cold-start
     window — no timeout was found configured in
     `src/core/themeServiceClient.ts`; this must be verified (and set if
     absent) before relying on the Free instance even for testing.
   - **Stage 2 (live payments on):** switch the one service to the
     **"Less than 1 CPU" instance** (0.5 CPU / 512 MB RAM, ~$7/mo) so
     paying users never hit a cold start. The service is I/O-bound — it
     mostly waits on OpenAI/Gemini API calls — so 0.5 CPU / 512 MB
     suffices at launch; the 1 CPU $25/mo tier is only needed if the
     backend ever processes images itself or concurrency reaches dozens
     of simultaneous requests.
   - **Stage 3:** move to the **Pro workspace** only when a collaborator
     needs dashboard access or bandwidth exceeds 25 GB (several hundred
     themes a month).
4. **Health check path:** `/api/health` (matches the contract's public,
   unauthenticated health endpoint).
5. **Build command** / **start command**: use whatever the
   `corsair-theme-service` repo's own README/`render.yaml` specifies —
   confirm in that repo rather than assuming Speciary's `pnpm build` /
   `node packages/service/dist/index.js` shape applies verbatim.
6. Add every env var **name** the contract lists
   (`docs/theme-service-api.md`, "Service env vars"). Mark the secret
   ones `sync: false` (Render-dashboard-managed, never committed) —
   same split Speciary's `render.yaml` uses:

   **Secrets (`sync: false`, set only in the Render dashboard):**
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_STARTER45`
   - `STRIPE_PRICE_THEME100`
   - `STRIPE_PRICE_BUNDLE205`
   - `OPENAI_API_KEY`
   - `GEMINI_API_KEY`
   - `SUPABASE_URL` (not secret in the strict sense — it's a public
     project URL — but Speciary's `render.yaml` treats it as
     `sync: false` too; follow that precedent so it's never accidentally
     committed alongside a service-role key in the same env block)

   **Plain values (safe to commit in a blueprint):**
   - `PORT` — the port the Node process listens on.
   - `SERVICE_ALLOWED_ORIGINS` — see below.
   - `STRIKE_LOCK_THRESHOLD` — default `3` per the contract; set
     explicitly if you want a different threshold.
   - `RATE_LIMIT_ATTEMPTS_PER_MIN`
   - `RATE_LIMIT_ATTEMPTS_PER_DAY`
   - `PROMPT_MAX_CHARS` — default `4000` per the contract.
   - `IMAGE_MAX_BYTES` — default `8` MiB per the contract.

   **`SERVICE_ALLOWED_ORIGINS`:** the contract doesn't give this value
   directly (it's not a browser-hosted client), so set it per host:
   - The VS Code webview has no conventional browser `Origin` header the
     same way a hosted web app does — confirm with the
     `corsair-theme-service` repo how it derives/validates the origin
     for extension-originated requests (e.g. a custom scheme or a fixed
     marker value), rather than assuming a URL-shaped origin works.
   - The standalone host's origin is `http://127.0.0.1:<port>` for
     whatever port(s) it binds (see the fixed-port decision in section
     2.5 / section 9 — the same port list feeds both the Supabase
     redirect allow-list and this origin allow-list).
7. Recommend maintaining a `render.yaml` blueprint in the
   `corsair-theme-service` repo mirroring Speciary's shape (`type: web`,
   `env: node`, `healthCheckPath: /api/health`, the secrets block with
   `sync: false`, plain values inline) so the whole service is
   reproducible from source rather than hand-clicked in the dashboard.

## 6. DNS

1. At your domain registrar (GoDaddy), add a **CNAME** record:
   `theme.corsairstudios.com` → the Render service's `onrender.com`
   hostname (shown on the Render service's dashboard page).
2. In Render, open the service's **Settings → Custom Domains** and add
   `theme.corsairstudios.com`.
3. Wait for Render to verify the CNAME and issue the TLS certificate —
   this can take from a few minutes up to an hour depending on DNS
   propagation. Do not point the extension at the production endpoint
   (it already is, per `themeServiceClient.ts:25`) until this
   certificate is live, or requests will fail TLS validation.

## 7. OpenAI and Google AI keys

1. **OpenAI:** create a project-scoped API key (not an org-wide key) in
   the OpenAI dashboard, scoped to the project used for image
   generation. Set a **monthly budget cap** on that project so a bug or
   abuse burst can't run an open-ended bill. Confirm the account's usage
   tier meets whatever rate/throughput the contract's capacity-scaling
   note assumes (`docs/theme-service-api.md`, "Rate limits and
   scaling") — request a tier increase if the default tier's limits are
   too low for expected load.
2. **Gemini:** create a key from Google AI Studio (or provision through
   Vertex AI if you prefer GCP-billed usage) for the `GEMINI_API_KEY`
   env var.
3. Both keys are **server-only** — they go into Render as `sync: false`
   secrets (section 5) and are never sent to or stored by the client.
   Per the contract, capacity is scaled by requesting higher provider
   limits or shifting board types between the two providers — never by
   pooling or rotating multiple keys for the same provider account.

## 8. Smoke test checklist

Run these in order against the deployed Render service, using Stripe
**test mode** first:

1. `GET https://theme.corsairstudios.com/api/health` — expect `200`.
2. Sign in from the extension via email OTP, then again via Google —
   both should reach `GET /api/account` with a valid session afterward.
3. `GET /api/account` — expect `credits: 0`, `locked: false` for a new
   account.
4. Buy the **Starter** pack in Stripe test mode using card
   `4242 4242 4242 4242` (Stripe's published test card — any future
   expiry, any CVC) and confirm the Stripe webhook fires
   `checkout.session.completed` and grants **45 credits** — re-check
   `GET /api/account` for `credits: 45`.
5. Generate one **Objects** board (`objects_01` or `objects_02`,
   attempt cost 2 per `GET /api/pricing`) and confirm a matching
   `spend-theme-attempt` row appears in `credit_ledger` and the balance
   drops by the attempt cost.
6. Force a provider error (e.g. a temporarily invalid provider key, or
   whatever fault-injection the backend repo supports) and confirm the
   attempt auto-refunds — `502 { "error": "provider_failed", "refunded": true }`
   and the ledger shows a matching `refund-theme-attempt` row, net
   balance unchanged.
7. Submit an obviously policy-violating prompt and confirm
   `422 { "error": "content_blocked" }` with **no** `credit_ledger` row
   written at all (no debit, so no refund either — per "Content
   screening" in the contract).
8. Once all of the above pass in test mode, switch Stripe to **live
   mode**: repeat product/price/webhook creation (section 4.7), update
   `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_*` in
   Render to the live values, and re-run steps 1–4 once more against
   live mode with a real low-value purchase before announcing
   availability.

## 9. Decisions still open for the operator

These are not resolved by this guide — decide and record them before or
during rollout:

1. **Image retention window** — how long generated images/reference
   images are retained server-side, if at all. Terms are still TBD; the
   contract does not specify a retention policy.
2. **Supabase redirect-URL wildcard vs. fixed ports** — confirm whether
   Supabase's current allow-list rules accept a wildcard port for the
   standalone host's `http://127.0.0.1:*/callback` loopback pattern. If
   not, the standalone host must bind to a small, fixed, pre-registered
   port list, and both the Supabase allow-list and Render's
   `SERVICE_ALLOWED_ORIGINS` must be updated together whenever that list
   changes.
3. **Render region** — pick a specific region for the Supabase project
   and the Render service together, minimizing auth/API latency; not
   fixed by the contract.
4. **Google OAuth consent screen verification** — whether to add a logo
   (triggering Google's verification review) or keep the consent screen
   text-only (no review required). Text-only is the faster path; a logo
   is a polish decision, not a functional requirement.
5. **When to move Free -> "Less than 1 CPU"** — the trigger for switching
   the Render instance from Free to the "Less than 1 CPU" tier (~$7/mo):
   the first live (non-test) Stripe payment, a fixed date, or first user
   complaint about a slow first request. Not fixed by this guide.
