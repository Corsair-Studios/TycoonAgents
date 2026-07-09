---
name: playwright
description: Browser automation, UI QA, screenshots, and accessibility checks.
---

# Playwright

Playwright drives a real browser (Chromium, Firefox, or WebKit) to run
end-to-end tests and ad-hoc UI checks — clicking, filling forms, asserting
on rendered state, and capturing screenshots or traces. Use it whenever a
change needs to be verified in an actual rendered page rather than by
reading source.

## Setup

```
npm init playwright@latest      # scaffolds tests/, playwright.config.ts, CI config
npx playwright install          # downloads browser binaries (needed once, and after upgrades)
```

`playwright.config.ts` is where `baseURL`, timeouts, browsers/projects to
run against, and reporters live. Point `baseURL` at the app under test so
tests can call `page.goto('/some-path')` instead of full URLs.

Test files default to `*.spec.ts` under `tests/` (configurable via `testDir`).

## Core API

```ts
import { test, expect } from '@playwright/test';

test('user can submit the form', async ({ page }) => {
  await page.goto('/signup');

  await page.getByRole('textbox', { name: 'Email' }).fill('a@example.com');
  await page.getByRole('button', { name: 'Submit' }).click();

  await expect(page.getByText('Thanks for signing up')).toBeVisible();
  await page.screenshot({ path: 'signup-confirmation.png' });
});
```

- `page.goto(url)` navigates.
- Locators — `getByRole`, `getByText`, `getByLabel`, `getByTestId` — describe
  *what the element is*, not where it sits in the DOM, so tests survive
  markup changes.
- Actions — `.click()`, `.fill()`, `.check()`, `.selectOption()` — auto-wait
  for the element to be visible/enabled before acting.
- `expect(locator).toBeVisible()` / `.toHaveText()` / `.toBeEnabled()` etc.
  are web-first assertions: they retry until the condition holds or the
  timeout expires, instead of checking once.

## Common tasks

```
npx playwright test                     # run the whole suite, headless
npx playwright test tests/signup.spec.ts
npx playwright test --headed            # watch the browser while it runs
npx playwright test --debug             # step through with the Playwright inspector
npx playwright show-report              # open the last run's HTML report
```

- **Traces**: set `trace: 'on-first-retry'` (or `'on'`) in the config, then
  `npx playwright show-trace trace.zip` to replay a failing run action by
  action — DOM snapshots, network, console.
- **Console errors**: `page.on('console', msg => { if (msg.type() === 'error') ... })`
  and `page.on('pageerror', err => ...)` catch runtime errors a visual check
  would miss.
- **Basic accessibility checks**: assert on `getByRole` locators succeeding
  at all (a missing accessible role/name is itself a signal), check focus
  order with `page.keyboard.press('Tab')`, and verify visible text has
  sufficient contrast/labels where the app claims to support it.

## Gotchas

- Prefer role/text locators (`getByRole`, `getByText`, `getByLabel`) over
  CSS or XPath selectors tied to class names or DOM structure — those break
  on the next unrelated style change.
- Don't add manual `page.waitForTimeout(ms)` sleeps to work around timing —
  Playwright's actions and web-first assertions already auto-wait. A sleep
  that "fixes" flakiness usually means the assertion is wrong or targeting
  the wrong element, not that more time is needed.
- Keep tests isolated: don't depend on state left over from a previous test.
  Use fresh contexts/pages per test (the default with `@playwright/test`) and
  reset app state (fixtures, API calls, `page.context().clearCookies()`)
  rather than relying on run order.
- A `click()` that silently no-ops usually means the locator matched zero or
  multiple elements — check with `.count()` before assuming the app is
  broken.

## In this project

For verifying TycoonAgents' own webview UI (panel layout, canvas rendering,
CSS changes from ux-ui-designer work), point Playwright at the rendered
webview HTML/CSS rather than re-deriving behavior from source — a
screenshot or a `toBeVisible()` check on the actual DOM catches regressions
that reading `media/main.js` won't.
