# Corsair Theme Service — Terms & Privacy (Draft)

> **DRAFT — not legal advice — requires human review before publication.**
> Operator: **Corsair Studios LLC**.

## 1. What the Theme Service is

The Corsair Theme Service is a hosted feature that generates theme artwork
(sprite sheets, boards) from an AI image model on Corsair's behalf, so you
never need your own OpenAI or Google API key. Uploading your own images or
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
- Credit expiry: **TBD — reviewer to confirm whether credits expire and,
  if so, after how long.**

## 4. Refunds

- **Credit refunds** happen automatically, only when the generation call
  itself fails outright (the service or the image model returns an error
  or no image). This is automatic and does not require contacting support.
- Credits are **never refunded** because you dislike an image that was
  successfully returned — that attempt used a real model call.
- **Purchase refunds** (returning money for unused credits) are handled
  through Stripe at Corsair's discretion. Policy and conditions:
  **TBD — reviewer to define a refund window/policy, if any.**

## 5. No guarantee of output quality

Generated images come from a third-party AI image model. Output quality
depends heavily on the prompts and reference images you provide, and on
the underlying model's behavior, which is outside Corsair's control. Trial
and error, including retries, should be expected — especially for a first
theme. Corsair does not guarantee that any attempt will produce a
satisfactory or "correct" result.

## 6. Data handling

- When you **generate** a theme (not upload or hand-make one), your
  prompt text, any reference images you provide, the generated image, and
  identifiers tied to your account transit the Corsair Theme Service and,
  briefly, its underlying AI model provider, solely to produce that
  generation.
- This data may be temporarily stored by the Theme Service and its model
  provider for the purpose of completing and auditing that request.
  Retention period: **TBD — reviewer to confirm how long prompts/images
  are retained and whether they are used for any purpose beyond serving
  the request.**
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

## 8. Changes and contact

Corsair may update these terms as the Theme Service evolves; material
changes will be noted in-product. Questions about these terms, your
account, or a purchase can be directed to Corsair Studios LLC through the
app's existing feedback channel.

---

**TBD items requiring reviewer decision before publication:**
1. Whether purchased credits expire, and if so, after what period (§3).
2. Purchase-refund policy and conditions for unused credit balances (§4).
3. Retention period for prompts/generated images/account identifiers held
   by the Theme Service and its model provider, and any use beyond
   serving the immediate request (§6).
