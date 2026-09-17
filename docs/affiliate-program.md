# Affiliate / Referral Program (Operator Guide)

This is the operator-facing runbook for the Theme Service referral program:
who it's for, the default terms, how to onboard a partner, how partners
share their link, and how monthly payout works. It complements the API
contract and the user-facing terms:

- [`docs/theme-service-api.md`](theme-service-api.md) — the `Referral`
  section and `POST /api/account/referral` define the schema and server
  behavior this doc operates against.
- [`docs/theme-credits-terms-draft.md`](theme-credits-terms-draft.md) —
  section 9, "Affiliate / referral codes," is the user-facing terms
  language partners' referred users agree to.

## Purpose

The referral program lets approved partners (creators, communities, other
tool authors) share a code that earns them a commission when someone they
refer makes their first Theme Service purchase. It is opt-in per partner —
each partner signs a separate written agreement — and defaults are
deliberately conservative so exceptions can be granted per partner without
changing the schema.

## Default terms

Unless a partner's written agreement says otherwise, every referrer row
uses these defaults:

- **Commission rate:** 20% of net revenue (after the Stripe fee) on the
  referred account's **first purchase only**. No commission on any
  purchase after the first.
- **New accounts only.** A referral code only applies to an account with no
  prior sign-in or ledger activity. Existing users can never be attached to
  a referral after the fact.
- **First sign-in, immutable.** The code is applied automatically at the
  account's first sign-in and is then permanent for that account — it
  cannot be changed, removed, or reassigned later.
- **30-day referral window.** The referred account's first purchase must
  complete within 30 days (`referrers.window_days`, default 30) of the
  code being applied, or no commission accrues.
- **30-day commission hold.** Each commission starts `pending` and only
  becomes `payable` 30 days after accrual (`referral_commissions.hold_until`).
  A refund or a Stripe dispute inside that window voids the commission
  instead of paying it.
- **Monthly manual payout, USD 25 minimum.** Payout is computed from the
  `referral_statement` view and paid out by hand once a month; a partner
  under the $25 threshold rolls forward to the next month.
- **Optional welcome bonus credits, default 0.** A partner's agreement can
  grant the referred user a one-time bonus of extra credits on their first
  purchase (`referrers.bonus_credits`). This is off by default and never
  changes the price the referred user pays.

### Flat bounty alternative

Some partners prefer certainty over a percentage that depends on what the
referred user spends. For those partners, negotiate a flat bounty per
qualifying referral instead of the percentage rate — record it in the
written agreement and set `rate_bps` and any other fields to represent the
agreed structure as closely as the schema allows, noting the deviation in
the agreement itself. The schema is percentage-shaped by default; a flat
bounty is a manual accounting adjustment layered on top, not a separate
code path.

## Onboarding a partner

Onboarding is a single row in the `referrers` table, added via the Supabase
SQL editor (no admin UI). Required fields, per the schema in
[`docs/theme-service-api.md`](theme-service-api.md#referrers-table):

- `code` — the partner's referral code (primary key). Charset
  `[A-Za-z0-9-]`, max 32 chars, matching what `POST /api/account/referral`
  accepts.
- `display_name` — the partner's name for internal reference.
- `contact_email_hash` — `sha256` of the partner's own account email. This
  is what the server checks to refuse self-referral, so it must be the
  email of the account the partner themselves signs in with, not a
  business inbox they don't use for the product.
- `rate_bps` — commission rate in basis points (defaults to `2000` = 20%
  if the agreement uses the standard rate).
- `window_days` — referral window in days (defaults to `30`).
- `bonus_credits` — welcome bonus credit amount (defaults to `0`).
- `active` — `true` to enable the code immediately.

Steps:

1. Confirm the written partner agreement is signed (see checklist below)
   before creating the row — the code goes live the moment `active = true`.
2. Compute `contact_email_hash` as `sha256` of the partner's sign-in email
   (names only — never paste the email itself into a shared doc or ticket).
3. Insert the row into `referrers` via the Supabase SQL editor with the
   agreed `rate_bps`, `window_days`, and `bonus_credits`.
4. Send the partner their code and the link formats below.

## Link formats partners share

A partner can direct new users to apply their code in any of three ways:

- **Standalone sign-in URL** with a `?ref=CODE` query parameter.
- **VS Code deep link:**
  `vscode://tycoonagents.tycoonagents/sign-in?ref=CODE`
- **Manual entry** — the user types the code themselves at first sign-in.

All three ultimately call `POST /api/account/referral` with the code on the
user's first sign-in; the server applies the same first-touch, new-account
rules regardless of which path delivered the code (see
[`docs/theme-service-api.md`](theme-service-api.md#post-apiaccountreferral)).

## Monthly payout procedure

1. Query the `referral_statement` view for the month being paid, filtered
   to `commission_cents` per `referrer_code`. This view is the sole source
   of truth for what's owed — never compute payout from `referral_commissions`
   directly or from any ad hoc query.
2. For each referrer whose `commission_cents` for the month is at least
   USD 25 (2500 cents), pay that amount by the agreed payout method in
   their written agreement.
3. Record the payout (amount, referrer, month, method, date) in whatever
   ledger or bookkeeping system tracks operator payables — this is a
   manual operator action, not an automated transfer.
4. If a partner requests their code be turned off, set `active = false` on
   their `referrers` row. Existing accrued commissions are unaffected;
   only new referrals stop.

## Partner agreement checklist

Before setting a partner's code `active = true`, confirm the written
agreement covers:

- [ ] Commission rate (percentage, or the flat bounty amount if used)
- [ ] Referral window (days)
- [ ] Any exclusions (regions, account types, product lines)
- [ ] Refund clawback — commission is voided on refund or dispute per the
      30-day hold
- [ ] Payout method (how funds actually reach the partner)
- [ ] Tax form on file, if required for the payout method and amount
- [ ] Termination terms (either party can end the arrangement, and how)
- [ ] No self-referral — the partner's own account is excluded by design
      (`self_referral`), and the agreement should note this is enforced
      automatically
- [ ] No paid-search bidding on the product name or brand terms
- [ ] Disclosure requirements — influencer partners must disclose the
      relationship per applicable advertising-disclosure rules when sharing
      their code or link

## FAQ

**Can an existing user be referred after the fact?**
No. A referral code only ever applies to an account with no prior sign-in
or ledger activity. There is no way to retroactively attach a code to an
account that already exists.

**Does a referral code change pricing?**
No. Codes never change what the referred user pays. The only thing a code
can add is an optional one-time welcome bonus of extra credits on the
referred user's first purchase, and only if the partner's agreement
includes one.

**Can the operator change the defaults for a specific partner?**
Yes. The defaults above (20% rate, 30-day window, no bonus) are the
starting point for a new `referrers` row; any of `rate_bps`, `window_days`,
or `bonus_credits` can be set differently per partner to match their
written agreement.
