/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Dispatcher adapters for the fixed OpenAI-compatible vendors (mistral, xai,
// moonshot): vendor routing, model prefixing, per-vendor key/base-URL env
// names. Offline: a local http server stands in for the vendor endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/* eslint-disable @typescript-eslint/no-var-requires */
const adapters = require("../../hooks/dispatcherAdapters.cjs") as {
  adapterKeyForVendor: (vendor: string, opts?: Record<string, unknown>) => string;
  resolveAdapter: (vendor: string, opts?: Record<string, unknown>) => { key: string; fn: (task: string, info: Record<string, unknown>) => Promise<{ text?: string; error?: string }> };
  withVendorPrefix: (vendor: string, model: string) => string;
};
/* eslint-enable @typescript-eslint/no-var-requires */

test("mistral, xai and moonshot route to the openai-compatible adapter; unknown vendors stay unsupported", () => {
  for (const v of ["mistral", "xai", "moonshot", "MISTRAL"]) assert.equal(adapters.adapterKeyForVendor(v), "openai-compatible", v);
  assert.equal(adapters.adapterKeyForVendor("nonesuch"), "unsupported");
  assert.equal(adapters.resolveAdapter("nonesuch").key, "unsupported");
});

test("withVendorPrefix adds the vendor prefix once", () => {
  assert.equal(adapters.withVendorPrefix("mistral", "mistral-large-latest"), "mistral/mistral-large-latest");
  assert.equal(adapters.withVendorPrefix("mistral", "mistral/mistral-large-latest"), "mistral/mistral-large-latest");
  assert.equal(adapters.withVendorPrefix("xai", "grok-4"), "xai/grok-4");
  assert.equal(adapters.withVendorPrefix("moonshot", "kimi-k2"), "moonshot/kimi-k2");
  assert.equal(adapters.withVendorPrefix("other", "x"), "x");
});

async function withServer<T>(fn: (baseUrl: string, seen: Array<{ auth?: string; body: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const seen: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "reviewed" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const CASES: Array<[string, string, string, string, string]> = [
  ["mistral", "mistral-large-latest", "MISTRAL_BASE_URL", "MISTRAL_API_KEY", "mistral-large-latest"],
  ["xai", "xai/grok-4", "XAI_BASE_URL", "XAI_API_KEY", "grok-4"],
  ["moonshot", "kimi-k2", "MOONSHOT_BASE_URL", "MOONSHOT_API_KEY", "kimi-k2"],
];

for (const [vendor, model, urlEnv, keyEnv, upstream] of CASES) {
  test(`${vendor} adapter uses ${keyEnv}/${urlEnv} and sends the unprefixed upstream model`, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fixed-vendor-"));
    try {
      await withServer(async (baseUrl, seen) => {
        await withEnv({ TYCOON_STANDALONE_DATA_DIR: dataDir, [urlEnv]: baseUrl, [keyEnv]: "secret-test-key", OPENAI_COMPAT_API_KEY: "generic-key", OPENAI_COMPAT_BASE_URL: undefined }, async () => {
          const { fn } = adapters.resolveAdapter(vendor);
          const res = await fn("review this", { vendor, model, workerId: "x-reviewer" });
          assert.equal(res.text, "reviewed");
          assert.equal(seen.length, 1);
          assert.equal(seen[0].auth, "Bearer secret-test-key");
          assert.equal(seen[0].body.model, upstream);
        });
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test(`${vendor} adapter without ${keyEnv} errors by name and never uses the generic key`, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fixed-vendor-"));
    try {
      await withEnv({ TYCOON_STANDALONE_DATA_DIR: dataDir, [keyEnv]: undefined, OPENAI_COMPAT_API_KEY: "generic-key" }, async () => {
        const { fn } = adapters.resolveAdapter(vendor);
        const res = await fn("t", { vendor, model });
        assert.match(res.error as string, new RegExp(keyEnv));
        assert.doesNotMatch(res.error as string, /generic-key/);
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test("google adapter without GEMINI_API_KEY gives the plain-words message and substitutes nothing", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fixed-vendor-"));
  try {
    await withEnv({ TYCOON_STANDALONE_DATA_DIR: dataDir, GEMINI_API_KEY: undefined }, async () => {
      const { fn } = adapters.resolveAdapter("google");
      const res = await fn("t", { vendor: "google" });
      assert.equal(res.error, "Gemini on the Codex harness needs GEMINI_API_KEY (set it on the Agents screen). Antigravity sign-in isn't supported on the Codex harness yet. No other model was used.");
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// --- parity with hooks/openai-compatible-mcp.cjs VENDOR_DEFAULTS ---

test("FIXED_VENDOR_ENDPOINTS matches VENDOR_DEFAULTS in openai-compatible-mcp.cjs", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixed = (require("../../hooks/dispatcherAdapters.cjs") as { FIXED_VENDOR_ENDPOINTS: Record<string, { prefix: string; baseUrlEnv: string; defaultBaseUrl: string; apiKeyEnv: string }> }).FIXED_VENDOR_ENDPOINTS;
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "hooks", "openai-compatible-mcp.cjs"), "utf8");
  const block = src.slice(src.indexOf("const VENDOR_DEFAULTS = ["), src.indexOf("];", src.indexOf("const VENDOR_DEFAULTS = [")));
  const entries = [...block.matchAll(/\{\s*prefix:\s*"([^"]+)",\s*baseUrlEnv:\s*"([^"]+)",\s*defaultBaseUrl:\s*"([^"]+)",\s*apiKeyEnv:\s*"([^"]+)"\s*\}/g)].map((m) => ({ prefix: m[1], baseUrlEnv: m[2], defaultBaseUrl: m[3], apiKeyEnv: m[4] }));
  assert.equal(entries.length, 3);
  const mine = Object.values(fixed).sort((a, b) => a.prefix.localeCompare(b.prefix));
  assert.deepEqual(mine, entries.sort((a, b) => a.prefix.localeCompare(b.prefix)));
});

// --- attachReferencedFiles for text-only adapters ---

const attach = (require("../../hooks/dispatcherAdapters.cjs") as { attachReferencedFiles: (task: string, projectDir: string) => string }).attachReferencedFiles;

function makeAttachProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-attach-")));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "cart.js"), "export const total = 1;\n");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(70 * 1024));
  fs.writeFileSync(path.join(dir, "server.pem"), "pem");
  return dir;
}

test("attach: an in-project file is appended as a fenced block with its relative path", () => {
  const dir = makeAttachProject();
  try {
    const out = attach("review src/cart.js please", dir);
    assert.match(out, /^review src\/cart\.js please/);
    assert.match(out, /File: src\/cart\.js\n```\nexport const total = 1;/);
    assert.doesNotMatch(out, /Not attached/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: nothing referenced or resolvable leaves the task unchanged", () => {
  const dir = makeAttachProject();
  try {
    assert.equal(attach("say hello, e.g. briefly", dir), "say hello, e.g. briefly");
    assert.equal(attach("review src/cart.js", ""), "review src/cart.js");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: refuses ../ escape, .env, key files, oversize and reports each in the skipped note", () => {
  const dir = makeAttachProject();
  const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.txt`);
  fs.writeFileSync(outside, "outside secret");
  try {
    const out = attach(`check ../${path.basename(outside)} .env server.pem big.txt src/missing.js`, dir);
    assert.doesNotMatch(out, /outside secret|SECRET=1/);
    assert.match(out, /Not attached: /);
    assert.ok(out.includes(`../${path.basename(outside)} (outside project)`));
    assert.match(out, /\.env \(secret\)/);
    assert.match(out, /server\.pem \(secret\)/);
    assert.match(out, /big\.txt \(too large\)/);
    assert.match(out, /src\/missing\.js \(not found\)/);
    assert.doesNotMatch(out, /Attached project files/);
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: a symlink pointing outside the project is refused", (t) => {
  const dir = makeAttachProject();
  const outside = path.join(path.dirname(dir), `outside-link-${path.basename(dir)}.txt`);
  fs.writeFileSync(outside, "linked outside");
  try {
    try {
      fs.symlinkSync(outside, path.join(dir, "link.txt"));
    } catch {
      t.skip("symlinks not permitted on this machine");
      return;
    }
    const out = attach("read link.txt", dir);
    assert.doesNotMatch(out, /linked outside/);
    assert.match(out, /link\.txt \(outside project\)/);
  } finally {
    fs.rmSync(outside, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: caps at 10 files and 256 KB total", () => {
  const dir = makeAttachProject();
  try {
    const names: string[] = [];
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "a");
      names.push(`f${i}.txt`);
    }
    const out = attach(`look at ${names.join(" ")}`, dir);
    assert.equal((out.match(/^File: /gm) || []).length, 10);
    assert.match(out, /f10\.txt \(attachment limit\)/);
    assert.match(out, /f11\.txt \(attachment limit\)/);

    const names2: string[] = [];
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(dir, `m${i}.txt`), "b".repeat(60 * 1024));
      names2.push(`m${i}.txt`);
    }
    const out2 = attach(`look at ${names2.join(" ")}`, dir);
    assert.equal((out2.match(/^File: /gm) || []).length, 4);
    assert.match(out2, /m4\.txt \(attachment limit\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed-vendor adapter sends the attached file content in the request", async () => {
  const dir = makeAttachProject();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fixed-vendor-"));
  try {
    await withServer(async (baseUrl, seen) => {
      await withEnv({ TYCOON_STANDALONE_DATA_DIR: dataDir, MISTRAL_BASE_URL: baseUrl, MISTRAL_API_KEY: "k" }, async () => {
        const { fn } = adapters.resolveAdapter("mistral");
        await fn("review src/cart.js", { vendor: "mistral", model: "mistral-large-latest", projectDir: dir });
        const msgs = seen[0].body.messages as Array<{ content: string }>;
        assert.match(msgs[0].content, /export const total = 1;/);
      });
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- security review round ---

test("attach: broadened secret names are refused (.npmrc, token.json, prod.env, server.pem.txt, my-secrets.json)", () => {
  const dir = makeAttachProject();
  try {
    const names = [".npmrc", "token.json", "prod.env", "server.pem.txt", "my-secrets.json", "settings.local.json", "terraform.tfstate"];
    for (const n of names) fs.writeFileSync(path.join(dir, n), "LEAKED-VALUE");
    const out = attach(`review ${names.join(" ")}`, dir);
    assert.doesNotMatch(out, /LEAKED-VALUE/);
    for (const n of names) assert.ok(out.includes(`${n} (secret)`), n);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attach: files under .ssh/.aws/.docker and gitignored files are refused", () => {
  const dir = makeAttachProject();
  try {
    fs.mkdirSync(path.join(dir, ".aws"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".aws", "config.txt"), "LEAKED-VALUE");
    fs.mkdirSync(path.join(dir, "local"), { recursive: true });
    fs.writeFileSync(path.join(dir, "local", "notes.txt"), "LEAKED-VALUE");
    fs.writeFileSync(path.join(dir, "scratch.log"), "LEAKED-VALUE");
    fs.writeFileSync(path.join(dir, ".gitignore"), "# c\nlocal/\n*.log\n");
    const out = attach("see .aws/config.txt local/notes.txt scratch.log src/cart.js", dir);
    assert.doesNotMatch(out, /LEAKED-VALUE/);
    assert.match(out, /File: src\/cart\.js/);
    assert.ok(out.includes(".aws/config.txt (secret)"));
    assert.ok(out.includes("local/notes.txt (secret)"));
    assert.ok(out.includes("scratch.log (secret)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fixed vendor: a non-https remote or credentialed base URL is refused before the key is used", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fixed-vendor-"));
  try {
    for (const bad of ["http://remote.example.com/v1", "https://user:pw@api.example.com/v1"]) {
      await withEnv({ TYCOON_STANDALONE_DATA_DIR: dataDir, XAI_BASE_URL: bad, XAI_API_KEY: "secret-test-key" }, async () => {
        const { fn } = adapters.resolveAdapter("xai");
        const res = await fn("t", { vendor: "xai", model: "grok-4" });
        assert.match(res.error as string, /^XAI_BASE_URL: /);
        assert.doesNotMatch(res.error as string, /secret-test-key/);
      });
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fixed vendor: a key echoed in an HTTP error body is scrubbed from the error", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tycoon-fixed-vendor-"));
  const server = http.createServer((_req, res) => {
    res.statusCode = 401;
    res.end("invalid key secret-test-key");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await withEnv({ TYCOON_STANDALONE_DATA_DIR: dataDir, MISTRAL_BASE_URL: `http://127.0.0.1:${port}/v1`, MISTRAL_API_KEY: "secret-test-key" }, async () => {
      const { fn } = adapters.resolveAdapter("mistral");
      const res = await fn("t", { vendor: "mistral", model: "mistral-large-latest" });
      assert.match(res.error as string, /HTTP 401/);
      assert.doesNotMatch(res.error as string, /secret-test-key/);
      assert.match(res.error as string, /\[redacted\]/);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
