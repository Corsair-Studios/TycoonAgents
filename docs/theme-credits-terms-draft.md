# Corsair Theme Service — Terms & Privacy (Draft)

> **DRAFT — not legal advice — requires human review before publication.**
> Operator: **Corsair Studios LLC**.

## 1. What the Theme Service is

The Corsair Theme Service is a hosted feature that generates theme artwork
(sprite sheets, boards) from an AI image model on Corsair's behalf, so you
never need your own API key. Uploading your own images or
hand-making a theme never uses this service, needs no account, and stays
fully offline.

## 2. Accounts and sign-in

Sign-in uses either an emailed magic link/one-time code or "Continue with
Google," both handled by Supabase Auth. We store your email address, your
Supabase account id, and a session token on your device (VS Code
`SecretStorage` or the standalone app's local `secrets/` folder). We do not
store a password.

## 3. Credits

- Credits are purchased in packs through Stripe Checkout. Stripe handles
  your card and any tax; Corsair never sees or stores your card details.
- Credits are **non-transferable** between accounts.
- Each generation *attempt* spends credits — the first try on a board and
  every retry are each a separate, equally-billed attempt, because each is
  a real call to the image model. Re-deriving a theme's plan or
  descriptions is billed the same way.
- Before an attempt runs, the app shows you its credit cost.
- **Re-slicing** an already-generated image from its raw data is free —
  it makes no model call.
- Credits have **no cash value** and cannot be redeemed for money.
- Credits **do not expire**.
- The dollar price of a credit is fixed when you buy a pack. The credit
  cost of an attempt is set by the service, is shown to you before every
  attempt, and may change over time as our costs change.
- Bonus credits included with a pack are ordinary credits and follow the
  same rules.

## 4. Refunds

- **Credit refunds** happen automatically, only when the generation call
  itself fails outright (the service or the image model returns an error
  or no image). This is automatic and does not require contacting support.
- Credits are **never refunded** because you dislike an image that was
  successfully returned — that attempt used a real model call.
- **Purchase refunds** (returning money for unused credits) are at
  Corsair's discretion and are processed through Stripe, our payment
  provider. Request one through the app's feedback channel. Stripe's own
  terms apply to the payment itself: https://stripe.com/legal/ssa

## 5. No guarantee of output quality

Generated images come from a third-party AI image model. Output quality
depends heavily on the prompts and reference images you provide, and on
the underlying model's behavior, which is outside Corsair's control. Trial
and error, including retries, should be expected — especially for a first
theme. Corsair does not guarantee that any attempt will produce a
satisfactory or "correct" result. Image quality can also vary over time
with the availability and updates of the underlying model.

## 6. Data handling

- When you **generate** a theme (not upload or hand-make one), your
  prompt text, any reference images you provide, the generated image, and
  identifiers tied to your account transit the Corsair Theme Service and,
  briefly, its underlying AI model provider, solely to produce that
  generation.
- The Theme Service keeps a ledger entry for each attempt (account id,
  board type, credit cost, timestamps, success or refund) so purchases and
  refunds can be reconciled. Prompts and generated images are held by the
  Theme Service only long enough to complete the request and return the
  result to you; the service does not keep a copy of your images beyond
  **[TBD: N days / no retention — Corsair to set when the backend
  ships]**. Generation itself is performed by Corsair's AI model providers
  (currently OpenAI and Google) under Corsair's own accounts. Their API
  terms govern that processing: neither uses API inputs or outputs to
  train their models, and each may retain request data briefly for abuse
  and safety monitoring (OpenAI states up to 30 days; see
  https://openai.com/policies/api-data-usage-policies and
  https://ai.google.dev/gemini-api/terms). Corsair does not use your
  prompts or images for any purpose other than serving your request and,
  in aggregate, keeping the service running.
- Uploading your own images or hand-making a theme sends nothing to
  Corsair and involves no account.
- Corsair never asks for, receives, or stores any AI-provider API key of
  yours (OpenAI, Google, or otherwise) — Corsair holds its own provider
  keys server-side only.

## 7. Acceptable use

You may not use the Theme Service to generate unlawful content, content
that infringes another party's rights, or abusive/harassing content.
Corsair may apply rate limits to generation and purchase requests to
prevent abuse, and may suspend accounts that violate this section.

Prompts and reference images are automatically screened before generation;
a prompt blocked at screening spends no credits. If the AI model itself
refuses a generation on content-policy grounds, that attempt is refunded
but still counts as a strike against your account. Repeated strikes within
a short window lock the account automatically. A locked account loses
access to the Theme Service, and any remaining credits are not refunded.
To request an unlock, use the app's feedback channel; unlocks are granted
at Corsair's discretion.

## 8. Changes and contact

Corsair may update these terms as the Theme Service evolves; material
changes will be noted in-product. Questions about these terms, your
account, or a purchase can be directed to Corsair Studios LLC through the
app's existing feedback channel.

---
