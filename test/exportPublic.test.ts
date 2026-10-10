import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/*
 * Coverage for scripts/export-public.mjs. Each test builds a throwaway fake
 * "repo" and target under the OS temp dir and injects the tracked-file list,
 * so no real git repo and no network are involved. Fake secrets are built by
 * concatenation so this file itself never contains a scannable key literal.
 */

const SCRIPT_URL = pathToFileURL(path.join(process.cwd(), "scripts", "export-public.mjs")).href;

// The test compiles to CommonJS; go through new Function so the ESM import survives.
const importEsm = new Function("u", "return import(u)") as (u: string) => Promise<any>;

interface Sandbox {
  repo: string;
  target: string;
  cleanup(): void;
}

function makeSandbox(files: Record<string, string>, extra: Record<string, string> = {}): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "export-public-"));
  const repo = path.join(base, "repo");
  const target = path.join(base, "out");
  for (const [rel, content] of Object.entries({ ...files, ...extra })) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { repo, target, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const FAKE_KEY = "sk-" + "ant-" + "abcdefgh12345678";
const FAKE_PATH = "C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "someone";

test("exclusion: patterns drop matching files and keep the rest", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const files = {
    "README.md": "hello\n",
    "HANDOFF.md": "internal\n",
    "docs/keep.md": "ok\n",
    "docs/a-probe-findings-x.md": "internal\n",
    ".claude/tycoon/plan.json": "{}\n",
    "src/nested/HANDOFF.md": "keep (anchored rule only matches root)\n",
  };
  const sb = makeSandbox(files, {
    "public-export.exclude": "/HANDOFF.md\n/docs/*probe-findings*.md\n/.claude/tycoon/\n",
  });
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: Object.keys(files) });
    assert.equal(res.excluded, 3);
    assert.equal(res.copied, 3);
    assert.equal(res.findings.length, 0);
    assert.ok(fs.existsSync(path.join(sb.target, "README.md")));
    assert.ok(fs.existsSync(path.join(sb.target, "src/nested/HANDOFF.md")));
    assert.ok(!fs.existsSync(path.join(sb.target, "HANDOFF.md")));
    assert.ok(!fs.existsSync(path.join(sb.target, ".claude/tycoon/plan.json")));
  } finally {
    sb.cleanup();
  }
});

test("scrub fails on a planted personal path and a planted fake key, with file:line and redaction", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const files = {
    "a.md": `line one\npath is ${FAKE_PATH}\n`,
    "b.txt": `ok\nok\nkey=${FAKE_KEY}\n`,
  };
  const sb = makeSandbox(files);
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: Object.keys(files) });
    const byFile = (f: string) => res.findings.filter((x: any) => x.file === f);
    assert.equal(byFile("a.md").length, 1);
    assert.equal(byFile("a.md")[0].line, 2);
    assert.equal(byFile("a.md")[0].rule, "personal-path-windows");
    assert.equal(byFile("b.txt").length, 1);
    assert.equal(byFile("b.txt")[0].line, 3);
    assert.equal(byFile("b.txt")[0].rule, "key-sk-ant");
    assert.ok(!JSON.stringify(res.findings).includes("abcdefgh12345678"), "key value must be redacted");
  } finally {
    sb.cleanup();
  }
});

test("scrub flags email addresses and the private repo name", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const findings = mod.scrubText("x.md", "mail me@real-person.io\nsee corsair-theme-service\n", []);
  assert.deepEqual(findings.map((f: any) => f.rule), ["email", "private-repo-name"]);
});

test("allowlist suppresses only the matching path and text", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const files = {
    "test/fixture.test.ts": `const p = "${FAKE_PATH}";\n`,
    "docs/other.md": `${FAKE_PATH}\n`,
  };
  const sb = makeSandbox(files, {
    "public-export.allow": "# fixtures\ntest/*.test.ts:someone\n",
  });
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: Object.keys(files) });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].file, "docs/other.md");
  } finally {
    sb.cleanup();
  }
});

test("refuses a target inside the repo and a non-empty target without --force", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const sb = makeSandbox({ "a.md": "x\n" });
  try {
    assert.throws(
      () => mod.exportPublic({ repoRoot: sb.repo, target: path.join(sb.repo, "export"), files: ["a.md"] }),
      (err: any) => err.code === "TARGET_INVALID" && /inside this repository/.test(err.message),
    );
    assert.ok(!fs.existsSync(path.join(sb.repo, "export")), "nothing may be written into the repo");

    fs.mkdirSync(sb.target, { recursive: true });
    fs.writeFileSync(path.join(sb.target, "stale.txt"), "x");
    assert.throws(
      () => mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md"] }),
      (err: any) => err.code === "TARGET_INVALID" && /not empty/.test(err.message),
    );
    assert.throws(
      () => mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md"], force: true }),
      (err: any) => err.code === "TARGET_INVALID" && /marker/.test(err.message),
    );
    assert.ok(fs.existsSync(path.join(sb.target, "stale.txt")), "unmarked target must be left untouched");
  } finally {
    sb.cleanup();
  }
});

test("scrub exempts placeholder paths and RFC 2606 reserved email domains only", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const bs = String.fromCharCode(92);
  const placeholder = "C:" + bs + "Users" + bs + "<user>";
  const text = [placeholder, "a@example.com", "b@host.test", "c@x.example", "d@y.invalid"].join("\n");
  assert.equal(mod.scrubText("x.md", text, []).length, 0);
  const real = mod.scrubText("x.md", "me@real-person.io\n" + FAKE_PATH + "\n", []);
  assert.deepEqual(real.map((f: any) => f.rule), ["email", "personal-path-windows"]);
});

test("export removes the export:public script from the copied package.json only", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const original = JSON.stringify({ name: "x", scripts: { test: "t", "export:public": "node scripts/export-public.mjs" } });
  const files = { "package.json": original };
  const sb = makeSandbox(files);
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: Object.keys(files) });
    assert.equal(res.findings.length, 0);
    const copied = JSON.parse(fs.readFileSync(path.join(sb.target, "package.json"), "utf8"));
    assert.deepEqual(copied.scripts, { test: "t" });
    assert.equal(fs.readFileSync(path.join(sb.repo, "package.json"), "utf8"), original);
  } finally {
    sb.cleanup();
  }
});

const BS = String.fromCharCode(92);
const NO_TOKENS = { tokens: [] as string[] };

test("path rules catch escaped and repeated separators", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const cases = [
    "C:" + BS + BS + "Users" + BS + BS + "fakename" + BS + BS + "x",
    "C:" + BS + BS + BS + BS + "Users" + BS + BS + BS + BS + "fakename",
    "C:/Users//fakename",
    "re = /" + BS + "/Users" + BS + "/fakename/",
  ];
  for (const text of cases) {
    assert.ok(mod.scrubText("x.ts", text, [], []).length >= 1, `missed: ${text}`);
  }
});

test("username token rule flags the injected name case-insensitively on word boundaries", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const hit = mod.scrubText("x.md", "built by FakeName today\n", [], ["fakename"]);
  assert.deepEqual(hit.map((f: any) => f.rule), ["personal-token"]);
  assert.equal(mod.scrubText("x.md", "fakenames and myfakename\n", [], ["fakename"]).length, 0);

  const sb = makeSandbox({ "a.md": "hello fakename\n" });
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md"], tokens: ["fakename"] });
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].rule, "personal-token");
  } finally {
    sb.cleanup();
  }
});

test("token file lines are honoured by the export", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const sb = makeSandbox({ "a.md": "secret-nickname\n" }, { ".public-export.tokens": "# c\nsecret-nickname\n" });
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md"] });
    assert.ok(res.findings.some((f: any) => f.rule === "personal-token"));
  } finally {
    sb.cleanup();
  }
});

test("placeholder exemption applies only when the username segment is the placeholder", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const ok = "C:" + BS + "Users" + BS + "<you>";
  const bad = "C:" + BS + "Users" + BS + "fakename" + BS + "<x>";
  assert.equal(mod.scrubText("x.md", ok, [], []).length, 0);
  assert.equal(mod.scrubText("x.md", ok + BS + "docs", [], []).length, 0);
  assert.equal(mod.scrubText("x.md", bad, [], []).length, 1);
});

test("unscannable containers fail the scrub unless allowlisted by path", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const files = { "doc.docx": "PK", "bundle.vsix": "PK", "ok.zip": "PK" };
  const sb = makeSandbox(files, { "public-export.allow": "ok.zip:*\n" });
  try {
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: Object.keys(files), ...NO_TOKENS });
    assert.deepEqual(
      res.findings.map((f: any) => [f.file, f.rule]).sort(),
      [["bundle.vsix", "unscannable-container"], ["doc.docx", "unscannable-container"]],
    );
  } finally {
    sb.cleanup();
  }
});

test("--force clears a marked target, keeps only fresh files, and always writes the marker", async () => {
  const mod = await importEsm(SCRIPT_URL);
  const sb = makeSandbox({ "a.md": "x\n", "b.md": "y\n" });
  try {
    mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md", "b.md"], ...NO_TOKENS });
    assert.ok(fs.existsSync(path.join(sb.target, ".tycoon-public-export")));
    fs.writeFileSync(path.join(sb.target, "stale.txt"), "old");
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md"], force: true, ...NO_TOKENS });
    assert.equal(res.copied, 1);
    assert.ok(!fs.existsSync(path.join(sb.target, "stale.txt")));
    assert.ok(!fs.existsSync(path.join(sb.target, "b.md")));
    assert.ok(fs.existsSync(path.join(sb.target, ".tycoon-public-export")));
  } finally {
    sb.cleanup();
  }
});

test("tracked symlinks are skipped and reported", async (t) => {
  const mod = await importEsm(SCRIPT_URL);
  const sb = makeSandbox({ "a.md": "x\n" });
  try {
    try {
      fs.symlinkSync(path.join(sb.repo, "a.md"), path.join(sb.repo, "link.md"));
    } catch {
      t.skip("symlink creation not permitted on this platform");
      return;
    }
    const res = mod.exportPublic({ repoRoot: sb.repo, target: sb.target, files: ["a.md", "link.md"], ...NO_TOKENS });
    assert.equal(res.copied, 1);
    assert.deepEqual(res.skippedSymlinks, ["link.md"]);
    assert.ok(!fs.existsSync(path.join(sb.target, "link.md")));
  } finally {
    sb.cleanup();
  }
});
