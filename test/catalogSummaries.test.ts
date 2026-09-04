import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { catalogSummary } from "../src/shared/catalogSummary";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function loadCatalog(relPath: string): any[] {
  const full = path.join(REPO_ROOT, relPath);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const CATALOGS: Array<{ path: string; label: string }> = [
  { path: "media/skills/catalog.json", label: "skills" },
  { path: "media/packs/catalog.json", label: "packs" },
  { path: "media/mcp/catalog.json", label: "mcp" },
];

for (const { path: catalogPath, label } of CATALOGS) {
  test(`every ${label} catalog entry has a non-empty summary <= 120 chars`, () => {
    const entries = loadCatalog(catalogPath);
    assert.ok(entries.length > 0, `${catalogPath} should have entries`);
    for (const entry of entries) {
      const summary = catalogSummary(entry);
      assert.ok(
        summary.length > 0,
        `${label}/${entry.id}: summary must be non-empty`,
      );
      assert.ok(
        summary.length <= 120,
        `${label}/${entry.id}: summary must be <= 120 chars, got ${summary.length}: "${summary}"`,
      );
    }
  });

  test(`every ${label} catalog entry has an authored summary field`, () => {
    const entries = loadCatalog(catalogPath);
    for (const entry of entries) {
      assert.equal(
        typeof entry.summary,
        "string",
        `${label}/${entry.id}: expected an authored "summary" string field`,
      );
      assert.ok(
        entry.summary.length > 0 && entry.summary.length <= 120,
        `${label}/${entry.id}: authored summary must be non-empty and <= 120 chars`,
      );
    }
  });
}
