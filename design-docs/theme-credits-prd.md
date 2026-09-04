# Corsair Theme Service — Credits

## Problem / Opportunity

Today's theme generation (`src/extension/themeService.ts`, `standalone/src/themeMessages.mjs`) is bring-your-own-key: the user pastes an OpenAI (or Google Gemini) API key into the Theme Generator dialog (`media/main.js:3090-3219`, "OpenAI API key" / "Google Gemini API key" field, stored via a `SAVE_API_KEY`-style message and `updateThemeApiKeyUi`), and every image call (`createReviewItems` boards, `retryThemeImage`, `resliceThemeImageFromRaw`) bills that key directly. This works but has real costs to the product: users must obtain and manage their own key, get billed by OpenAI/Google directly with no markup or support surface for Corsair, and the extension has no monetization path of its own. The product decision (2026-09-03) is to move theme generation to a Corsair-hosted, authenticated API — the "Corsair Theme Service" — so users buy credit packs through Corsair's own Stripe account and spend credits per board/theme, while uploading or hand-making themes stays free and fully offline (no service dependency at all).

## Target Users

- **VS Code extension user** — generates themes from the Theme Generator webview panel (`media/main.js`), currently via BYO key.
- **Standalone user** — same theme flow outside VS Code, via `standalone/src/themeMessages.mjs` and its own webview equivalent.
- **OpenCode user** — per the in-flight OpenCode provider work, TycoonAgents' panel becomes provider-independent for *activity monitoring*; the Corsair Theme Service must likewise be host/provider-independent — it authenticates the user's Corsair account, not their coding-agent harness, so the same service and client SDK serve all three surfaces identically.

## Goals & Success Metrics

- A user can generate a full theme (all boards) without ever holding a model API key, by spending credits from a Corsair account balance.
- Per-board and per-theme credit cost is shown as an estimate before generation starts, and a failed board automatically refunds its credit.
- Uploading/hand-making a theme (no image generation) remains entirely free and works fully offline — zero calls to the Corsair Theme Service.
- No model provider key (OpenAI, Google, or otherwise) is ever bundled in, or reachable from, the shipped VSIX or standalone app — only the service URL and the user's account token are client-side secrets.
- No telemetry exists in the codebase today; this PRD proposes only the minimal counters needed to run the service (§ Requirements — Telemetry), not product analytics.

## Core Features

- Corsair account + token issuance — planned, new.
- Credit ledger (balance, spend, refund) — planned, new.
- Stripe Checkout credit-pack purchase + webhook top-up + Stripe Tax — planned, new.
- Per-board credit pricing with a pre-generation estimate — planned, extends existing `createReviewItems` board enumeration.
- Automatic refund on a failed board — planned, hooks into the existing per-board retry/error path (`retryThemeImage`, `onProgress` failure branches in `themeService.ts`).
- Client integration: sign-in, balance display, "Buy credits" flow, generation routed through the service — planned, replaces the BYO-key UI in `media/main.js` and its standalone equivalent.
- BYO-key advanced fallback — **PENDING USER DECISION** (kept hidden, see Open Questions).
- Existing feedback pipeline pattern (`src/host/vscode/feedbackSubmit.ts` → `https://feedback.corsairstudios.com/submit`) — shipped; reused here only as the architectural precedent for "one maintainer-controlled hostname baked into every release, repointable server-side."

## User Flows

1. **First-time theme generation**: user opens the Theme Generator, is prompted to sign in to their Corsair account (magic-link or license key — see Requirements); once signed in, the dialog shows their credit balance instead of an API-key field; if balance is zero or insufficient for the plan's board count, a "Buy credits" button is shown alongside the estimate.
2. **Buy credits**: user clicks "Buy credits" → client opens the system browser to a Stripe Checkout session created by the service → user completes payment (Stripe handles card + Stripe Tax) → Stripe webhook credits the ledger server-side → client polls (or receives a push) for the updated balance and re-enables generation once funds land.
3. **Generate a theme**: client requests a per-board cost estimate from the service using the current plan's board list (same enumeration `createReviewItems` already produces — see Grounding below) → shows total estimated credits → user confirms → each board's generation request goes through the service (prompt + reference images in, sprite sheet out) → the service debits credits per successful board and refunds automatically on a failed/errored board, mirroring today's per-board retry granularity in `retryThemeImage`.
4. **Upload/hand-made theme**: entirely unchanged — no network call, no account required, no credits spent. This path must keep working with no Corsair account at all.
5. **Offline / service-down**: generation calls fail with a clear "Theme Service unavailable" error distinct from "insufficient credits" or "not signed in"; no credits are debited; upload/hand-made themes remain available.
6. **Existing local-key user migrates**: on first launch after this ships, a user with a saved OpenAI/Gemini key sees a one-time notice that generation now goes through the Corsair Theme Service; their local key is preserved untouched only if BYO-key advanced fallback ships (Open Questions) — otherwise it is left in storage, unused, until the user clears it manually (never auto-deleted, since SecretStorage/local key deletion is a destructive action this PRD does not want to make silently).

## Non-Functional Requirements

### Account & token issuance
Recommend **magic-link email** over a static license key: a license key baked into a purchase receipt is copy-paste shareable across machines with no revocation story, while a magic-link ties sign-in to an email the user controls and lets the service issue short-lived, per-device tokens it can revoke individually. Trade-off: magic-link requires the service to send email (added infra: transactional email provider) and a user without reliable email access is blocked; a license key needs no email infra and works fully offline for the "enter your key" step, at the cost of weaker abuse/sharing control. Recommendation: magic-link for account creation and sign-in; the resulting long-lived device token is what the client actually stores and sends (never the magic-link itself).

### Credit ledger
Server-authoritative balance and transaction log (grant, spend, refund) keyed by account id; every debit/refund is one row, never a mutated running total only, so a support dispute is auditable from the log.

### Stripe Checkout + webhooks + Tax
Client never talks to Stripe directly — it asks the service for a Checkout Session URL, opens it in the system browser, and the service's own webhook endpoint (Stripe → service, server-to-server) is the only writer to the ledger's "grant" side. Stripe Tax is enabled on the Checkout Session so tax collection/remittance is Stripe-handled, not custom logic in the service.

### Per-board pricing + estimate + refund
Price per board (not per theme), since board count varies with the plan's roster size (agent boards, rivals-group boards, `objects_01`/`objects_02`, `environment`, `expressions`, `achievements` — see Grounding). The client requests/derives an estimate from the current plan's board list before confirming generation, matching the same board enumeration `createReviewItems` already produces so the estimate and the actual per-board billing can never drift from what will actually be generated. A board that errors (safety block, provider failure, network failure) refunds its credit automatically, server-side, on the same request that reports the failure — never a manual/support-ticket refund for the ordinary failure case.

Board count per theme is deterministic from the plan: one board per roster agent, plus the rival-group boards, plus five fixed boards (objects_01, objects_02, environment, expressions, achievements), as enumerated by createReviewItems in src/extension/themeService.ts. The pre-generation estimate multiplies this count by the per-board credit price; re-slicing from raw makes no provider call and is never billed.

### Rate limits / abuse controls
Per-account request-rate limiting on both generation and Checkout-session creation; the magic-link/token issuance endpoint itself is rate-limited per email/IP to prevent enumeration or spam.

### Privacy / terms text changes
The client's existing disclosure pattern (`media/main.js:16288-16330`, "what's never sent" / "local file paths and API keys are redacted") must be updated: prompts and now-generated images transit Corsair's server, not the user's own OpenAI/Gemini account, and the "your API keys ... are removed" language needs a companion line stating that theme prompts/images ARE sent to the Corsair Theme Service when generating (not when uploading/hand-making). Terms text needs a credits/refunds/no-guarantee-of-image-quality clause. **Human-in-the-loop**: final legal wording is not drafted by this PRD.

### Offline behaviour / error states
Distinct, user-legible states: not signed in; signed in, insufficient credits (with buy-credits CTA); signed in, sufficient credits, service unreachable; board failed + auto-refunded; Checkout session expired/cancelled. Never collapse these into one generic "generation failed."

### Balance display / buy flow
Balance shown wherever the API-key field used to live in the dialog; "Buy credits" opens the browser to Checkout and the client polls balance on an interval (and once more when the webview regains focus) until the purchase lands or the user cancels.

### Migration
Existing local BYO keys are never auto-deleted or auto-uploaded; users keep them in local storage until they clear them, and (if BYO-key fallback ships) can still opt into using them explicitly.

### Telemetry
Minimal: request count and pass/fail per board, for capacity planning and refund auditing — no prompt/content telemetry beyond what generation itself already requires.

## Security

- No model provider key of any kind ships in, or is reachable from, the VSIX or the standalone app — the public client only ever holds the service base URL (a maintainer-controlled hostname, same constraint as `FEEDBACK_ENDPOINT` in `feedbackSubmit.ts:29`) and the user's own account/device token.
- Token storage is per-host: VS Code extension uses `vscode.SecretStorage` (never `globalState`/settings JSON); the standalone app stores it in its own app-data directory with restrictive file permissions (owner-only read/write), never in a plaintext config file alongside other settings.
- The Corsair Theme Service itself — the component that actually holds the OpenAI/Gemini model keys — lives in a **separate private repo** (`corsair-theme-service`), never in this public TycoonAgents repo, so the model keys are never present in any artifact a public-repo clone or VSIX unpack could expose.

## Tech Stack

- Client: existing TypeScript extension (`src/extension/themeService.ts`, `media/main.js`) and standalone (`standalone/src/themeMessages.mjs`) surfaces, modified to call the new service instead of OpenAI/Gemini directly.
- Service (new, separate private repo `corsair-theme-service`): HTTP API with auth, ledger, Stripe integration; holds the actual OpenAI/Gemini model keys server-side; language/framework choice is that repo's own decision, out of scope here.
- Payments: Stripe Checkout + webhooks + Stripe Tax, under Corsair's existing Stripe account.
- Reused pattern: one maintainer-controlled hostname baked into shipped releases, repointable server-side without a client update — same shape as `FEEDBACK_ENDPOINT`/`FALLBACK_FORM_URL` in `src/host/vscode/feedbackSubmit.ts`.

## Milestones & Scope

In scope: M0 service skeleton, M1 payments, M2 client integration, M3 standalone/OpenCode-host parity, M4 docs/legal/release. Deferred: BYO-key fallback build-out (pending the Open Question decision below), any third-party model beyond OpenAI/Gemini, multi-currency pricing beyond what Stripe Tax handles automatically. See Milestone Plan below.

## Risks & Open Questions

- **PENDING USER DECISION — keep or remove BYO-key as a hidden advanced fallback.** Case for keep: some users already have a paid OpenAI/Gemini account and would rather use it directly than buy Corsair credits, and it's a safety valve if the service is ever down or discontinued; keeping it hidden (not in the main dialog) avoids confusing new users with two payment paths. Case for remove: two code paths through generation (service-billed vs. direct-billed) double the surface area of every theme-generation bug fix indefinitely, and the "hidden" field is exactly the kind of thing users find, get confused by, and file support tickets about. Recommendation left to the user; this PRD treats it as unresolved and M2 does not remove the existing key-entry code path until decided.
- **Unit naming: "credits" vs "tokens".** Recommend **"credits"** — the metrics/cost panel already uses "tokens" for LLM token counts (`media/main.js` cost-estimate code), and reusing that word for a purchasable balance would read as the same thing on the same screen.
- **Pricing tiers** — not set here; needs a per-board cost floor from the service's actual OpenAI/Gemini spend plus margin, decided when M0/M1 are built and real image-call costs are known.
- **Refunds policy (cash refunds on unused credit balances)** — unresolved; distinct from the automatic per-board-failure refund (in scope, § Requirements) which is not a policy question but a correctness requirement.
- **EU VAT / Stripe Tax jurisdiction coverage** — Stripe Tax handles calculation and remittance, but enabling it in the correct jurisdictions is a Stripe-dashboard configuration step, not a code change (see Milestone Plan human-in-the-loop tasks).
- **Margin risk on retries** — a retried/re-sliced board (`retryThemeImage`) either needs its own credit charge or a defined "free retry within N minutes" policy; unresolved here, must be decided before M1's pricing model is finalized.
- **Image-model price changes** — OpenAI/Gemini could reprice; the service should read its own cost config independent of a client release, so a price change never needs a VSIX update.
- **Service downtime** — no generation is possible while the service is down unless BYO-key fallback ships; this is an accepted risk of the hosted model, mitigated only by the fallback decision above.

# Milestone Plan

## Overview

Five milestones move theme generation from client-held BYO keys to a Corsair-hosted, credit-metered service: a new private service repo with auth and a ledger (M0), Stripe payments (M1), client integration across the VS Code extension (M2), standalone and OpenCode-host parity (M3), and docs/legal/release (M4). No fixed calendar timeframe; M0–M1 (service-only) can proceed in parallel with early client-side prep for M2, but M2's actual cutover hard-blocks on M0+M1 being live.

## Milestone 1: M0 — Service Skeleton, Auth, Ledger

**Goal**
A private, deployed `corsair-theme-service` exists with account issuance and a working credit ledger, with no payment flow yet (credits grantable only via an internal/admin path for testing).

**Deliverables**
- New private repo `corsair-theme-service`: HTTP API, magic-link account issuance (or license-key, per the recommendation above), device-token auth.
- Credit ledger: grant/spend/refund as an append-only transaction log plus a derived balance.
- An internal/admin-only credit-grant endpoint for pre-Stripe testing.
- A generation proxy endpoint stub (accepts a board request, debits a credit, calls OpenAI/Gemini server-side, returns the image) covering at least one board type end-to-end.

**Acceptance Criteria**
- A test account can sign in via magic-link, receive a device token, and see a balance of 0.
- An admin-granted credit shows up in balance and in the transaction log.
- A stub generation call against one board type debits exactly one credit and returns an image, or fails and refunds with no net balance change.

**Risks**
Service architecture/hosting choices happen in the private repo and are not this PRD's decision — flagged as a dependency, not detailed here.

## Milestone 2: M1 — Stripe Checkout, Webhooks, Tax

**Goal**
Users can actually buy credits with real money.

**Deliverables**
- Stripe Checkout Session creation endpoint on the service, parameterized by credit-pack SKU.
- Stripe webhook handler that credits the ledger on `checkout.session.completed` (idempotent — replay-safe on Stripe's at-least-once delivery).
- Stripe Tax enabled on Checkout Sessions.
- At least two credit-pack SKUs defined (exact pricing per the Open Questions item above — placeholder values acceptable at this milestone).

**Acceptance Criteria**
- A real (or Stripe test-mode) Checkout purchase results in a correct credit grant within one webhook round-trip, with a matching ledger entry.
- Replaying the same webhook event id does not double-credit the account.
- Stripe Tax line appears on the Checkout Session for at least one configured jurisdiction.

**Human-in-the-loop**
Stripe account/product/SKU configuration in the Corsair Stripe dashboard is a manual setup task, not a code change — must be done by a human with dashboard access before this milestone can be verified end-to-end.

**Risks**
Webhook idempotency bugs double-grant credits silently — mitigated by the replay test in Acceptance Criteria.

## Milestone 3: M2 — VS Code Client Integration

**Goal**
The Theme Generator dialog in the VS Code extension generates themes through the Corsair Theme Service instead of a locally-held API key, by default.

**Deliverables**
- Sign-in UI replacing the "OpenAI API key" / "Google Gemini API key" fields in `media/main.js` (`themeApiKeyInput`, `themeApiKeyLabel`, `updateThemeApiKeyUi` and related code around `media/main.js:3090-3219`) with an account sign-in + balance display.
- Token storage via `vscode.SecretStorage`, replacing whatever storage currently backs the saved API key.
- Client-side estimate call before generation, built from the same board list `createReviewItems` (`src/extension/themeService.ts:3149`) already enumerates.
- `themeService.ts`'s generation call sites (the ones currently building `ThemeImageGenerationOptions` and calling the OpenAI/Gemini SDK directly) rerouted to call the Corsair Theme Service instead.
- "Buy credits" button opening system browser to a Checkout URL from the service, with balance polling on an interval and on webview focus.
- Distinct error-state UI for not-signed-in / insufficient-credits / service-unreachable / board-failed-refunded, per Non-Functional Requirements.
- BYO-key code path either removed or hidden behind an advanced-settings toggle — gated on the Open Questions decision; if undecided at implementation time, default to **hidden, not removed**, since removal is harder to reverse than un-hiding.

**Acceptance Criteria**
- A full theme generation run (all boards for a real plan) completes using only a signed-in Corsair account, with zero calls to `api.openai.com`/Google's endpoint from the client.
- The estimate shown before generation matches the number of boards actually billed, verified against a fixed test plan.
- A forced board failure (e.g. simulated network error to the service) results in a refund visible in the balance display without a page reload.
- No OpenAI/Gemini key string appears anywhere in the built VSIX (`dist/*.vsix`) — grep check as part of the release checklist.

**Sequencing Notes**
Hard-blocked on M0 and M1 being deployed and reachable.

**Risks**
The existing per-board retry/re-slice granularity (`retryThemeImage`, `resliceThemeImageFromRaw`) must map cleanly onto "one credit per board" — a re-slice-from-raw-atlas (no new API call, per `resliceThemeImageFromRaw`'s doc comment) must NOT be billed, since it makes no provider call; this distinction must be preserved in the client's billing calls, not just its UI copy.

## Milestone 4: M3 — Standalone + OpenCode-Host Parity

**Goal**
The standalone app and any OpenCode-hosted use of TycoonAgents get the identical credits experience — the service is host-independent by design, so this milestone is integration, not new service work.

**Deliverables**
- `standalone/src/themeMessages.mjs` and its webview equivalent updated to mirror M2's sign-in/balance/estimate/buy-credits/error-state UI.
- Token storage in the standalone's own app-data directory with restrictive file permissions, per Non-Functional Requirements.
- Confirmation that no host-specific assumption in the service client code (e.g. `vscode.SecretStorage` calls) leaked into the shared/standalone path — the service-calling logic itself should be shared, only the token-storage adapter differs per host.

**Acceptance Criteria**
- A full theme generation run completes in the standalone app using the same signed-in Corsair account balance as M2's VS Code test (same account, cross-surface balance consistency).
- Token storage location uses restrictive file permissions — verified by a test or manual check on the target OS.

**Sequencing Notes**
Depends on M2's client-side service-calling logic existing to be reused/mirrored; can start once M2's core flow (not its final UI polish) is functional.

**Risks**
Divergence between the VS Code and standalone service-client implementations if the shared logic isn't actually factored into one module — mitigate by extracting the service-calling code once, in parallel with M2, per this repo's own "generated/shared from one source" convention (`docs/DISTRIBUTION.md` §2).

## Milestone 5: M4 — Docs, Legal Text, Release

**Goal**
Users and support understand the new credits model before it ships broadly; legal/privacy text is accurate.

**Deliverables**
- Updated in-client disclosure text (`media/main.js:16288-16330` area) reflecting that theme prompts/images now transit the Corsair Theme Service.
- New Terms/Privacy language covering credits, refund policy (per the Open Question resolution), and no-guarantee-of-output-quality.
- README/handbook section explaining sign-in, credits, and buy-credits flow for end users.
- Migration notice copy for existing BYO-key users (one-time notice, per User Flows §6).

**Acceptance Criteria**
- Disclosure text in the dialog accurately lists theme prompts/images as data sent to Corsair's service during generation.
- Terms text is reviewed and approved by a human before release (human-in-the-loop, not a code check).
- README documents the credits flow end-to-end for a new user with no prior account.

**Human-in-the-loop**
Final legal/Terms/Privacy wording must be drafted or approved by a human (not this PRD, not an agent) before release.

**Sequencing Notes**
Runs last, after M2 and M3 are functionally complete, so docs describe shipped behavior.

**Risks**
Shipping before legal text is finalized — mitigated by treating the legal-text task as a release gate, not a nice-to-have.

## Sequencing Notes

M0 and M1 (service-only) can proceed together, with M1 depending on M0's account/ledger existing. M2 hard-blocks on both M0 and M1 being deployed. M3 can start once M2's core service-calling logic (not final UI) exists, reusing rather than reimplementing it. M4 runs last, after M2 and M3 are functionally complete and merged.

## Out of Scope

- Building out the BYO-key advanced fallback beyond what already exists today — pending the Open Questions decision; this plan neither removes nor extends it.
- Any model provider beyond OpenAI/Gemini.
- Multi-currency/localized pricing beyond Stripe Tax's own handling.
- Changes to the unrelated `feedbackSubmit.ts` feedback pipeline — referenced only as an architectural precedent, not touched by this plan.
- Any change to Trashbyrd's Power Tools (UEFN bridge, scalar MCP) — ships and is owned separately, per `docs/DISTRIBUTION.md` §2 and §7.
