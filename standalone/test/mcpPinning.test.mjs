import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpdates, parseNpmView, pinnedPackages, formatReport } from '../../scripts/check-mcp-updates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'media', 'mcp', 'catalog.json'), 'utf8'));

function firstPositional(args) { return args.find((a) => !a.startsWith('-')); }

test('catalog: no @latest and every npx/uvx package is version-pinned', () => {
  for (const e of catalog) {
    const cfgs = [e.config, ...Object.values(e.platforms ?? {})].filter(Boolean);
    for (const c of cfgs) {
      const args = c.args ?? [];
      assert.ok(!args.some((a) => /@latest/i.test(a)), `${e.id} uses @latest`);
      if (c.command === 'npx') {
        const spec = firstPositional(args);
        assert.match(spec, /^@?[^@]+@\d+\.\d+\.\d+/, `${e.id} npx package not pinned: ${spec}`);
        assert.equal(e.pinned?.manager, 'npm', `${e.id} missing pinned record`);
        assert.equal(spec, `${e.pinned.name}@${e.pinned.version}`, `${e.id} pinned record disagrees with args`);
      }
      if (c.command === 'uvx') {
        const i = args.indexOf('--from');
        const spec = i >= 0 ? args[i + 1] : firstPositional(args);
        assert.match(spec, /@v?\d|==\d/, `${e.id} uvx package not pinned: ${spec}`);
      }
    }
  }
});

test('check-mcp-updates: parses fake npm view output through the seam', () => {
  const pins = pinnedPackages(catalog);
  const fake = (name) => (name === '@playwright/mcp' ? '9.9.9\n' : `${pins.find((p) => p.name === name).pinned}\n`);
  const rows = checkUpdates(catalog, fake);
  assert.ok(rows.length >= 3);
  const pw = rows.find((r) => r.name === '@playwright/mcp');
  assert.equal(pw.latest, '9.9.9');
  assert.equal(pw.outdated, true);
  assert.equal(rows.filter((r) => r.outdated).length, 1);
  assert.match(formatReport(rows), /OUTDATED/);
});

test('check-mcp-updates: bad output and lookup failure yield unknown; bad names rejected', () => {
  assert.equal(parseNpmView('not a version'), null);
  assert.equal(parseNpmView('"1.2.3"'), '1.2.3');
  const rows = checkUpdates(catalog, () => { throw new Error('offline'); });
  assert.ok(rows.every((r) => r.latest === null && !r.outdated));
  assert.throws(() => pinnedPackages([{ id: 'x', pinned: { manager: 'npm', name: 'a; rm -rf /', version: '1.0.0' } }]));
});
