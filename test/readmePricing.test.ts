/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source of truth: themeServiceClient.ts (src/core/themeServiceClient.ts) only
// parses pack/pricing data from the server at runtime (see the CreditPack and
// typicalTheme types around line 102-111) — it holds no default pack or price
// constants of its own. The single source-of-truth constants for these numbers
// are the `GET /api/pricing` response documented in docs/theme-service-api.md
// (v3.3, ~lines 130-148). This test parses that fenced JSON block directly
// (no hardcoded numbers of its own) and pins README.md's "Buy credits" and
// attempt-cost prose against it so the two can't silently drift apart.

const repoRoot = path.resolve(__dirname, "..", "..");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const apiDoc = readFileSync(
  path.join(repoRoot, "docs", "theme-service-api.md"),
  "utf8",
);

interface Pack {
  id: string;
  label: string;
  credits: number;
  bonusCredits: number;
  priceCents: number;
  currency: string;
}

interface PricingResponse {
  attemptCostByBoardType: Record<string, number>;
  planCost: number;
  typicalTheme: { min: number; max: number; typical: number };
  packs: Pack[];
}

function extractPricingJson(doc: string): PricingResponse {
  const sectionMatch = doc.match(
    /### `GET \/api\/pricing`\s*\r?\n```json\r?\n([\s\S]*?)\r?\n```/,
  );
  assert.ok(
    sectionMatch,
    "docs/theme-service-api.md must contain a fenced json block under '### `GET /api/pricing`'",
  );
  return JSON.parse(sectionMatch[1]) as PricingResponse;
}

function extractBuyCreditsParagraph(text: string): string {
  const match = text.match(/\*\*Buy credits\*\*[\s\S]*?(?=\r?\n\r?\n)/);
  assert.ok(match, "README.md must contain a 'Buy credits' paragraph");
  return match[0];
}

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const pricing = extractPricingJson(apiDoc);

test("README pack prices/credits match docs/theme-service-api.md GET /api/pricing", () => {
  const paragraph = extractBuyCreditsParagraph(readme);

  for (const pack of pricing.packs) {
    // e.g. "Starter (45 credits, $4.99)" or
    // "Theme (100 credits including 10 bonus, $9.99)"
    const bonusFragment =
      pack.bonusCredits > 0 ? ` including ${pack.bonusCredits} bonus` : "";
    const expected = `${pack.label} (${pack.credits} credits${bonusFragment}, $${formatDollars(pack.priceCents)})`;
    assert.ok(
      paragraph.includes(expected),
      `README "Buy credits" paragraph must contain "${expected}"`,
    );
  }
});

test("README attempt costs match docs/theme-service-api.md GET /api/pricing attemptCostByBoardType", () => {
  const twoCreditCost = pricing.attemptCostByBoardType.objects_01;
  const threeCreditCost = pricing.attemptCostByBoardType.roster_agent;
  assert.equal(twoCreditCost, 2);
  assert.equal(threeCreditCost, 3);
  assert.match(
    readme,
    new RegExp(
      `Attempts cost ${twoCreditCost} credits for object, expression, and achievement boards and ${threeCreditCost} credits for character, rival, and environment boards`,
    ),
  );
});

test("README typical/careful/heavy credit estimates match docs/theme-service-api.md GET /api/pricing typicalTheme", () => {
  const { min, typical, max } = pricing.typicalTheme;
  assert.match(
    readme,
    new RegExp(`typical 23-board theme runs about ${typical} credits`),
  );
  assert.match(readme, new RegExp(`careful run about ${min}`));
  assert.match(readme, new RegExp(`heavy retries up to about ${max}`));
});
