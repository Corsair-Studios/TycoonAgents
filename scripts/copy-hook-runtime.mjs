#!/usr/bin/env node
// Copies the compiled agentBackend/modelAliases modules from out/src/core
// into hooks/ so they ship inside the packaged VSIX next to
// tycoon-claude-hook.cjs (which requires them for generic backend-aware
// routing). Run after `tsc -p .` (both in vscode:prepublish and in normal
// dev builds) so the hook installer in panel.ts always has a same-directory
// copy available, and only falls back to out/src/core for a dev checkout
// that hasn't built yet.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "out", "src", "core");
const destDir = join(root, "hooks");

const files = ["agentBackend.js", "modelAliases.js", "delegationEnforcement.js", "fallbackChain.js", "localEnvStore.js"];

mkdirSync(destDir, { recursive: true });

for (const file of files) {
  const src = join(srcDir, file);
  if (!existsSync(src)) {
    console.error(`[copy-hook-runtime] missing compiled file: ${src} (run tsc -p . first)`);
    process.exitCode = 1;
    continue;
  }
  copyFileSync(src, join(destDir, file));
  console.log(`[copy-hook-runtime] copied ${file} -> hooks/${file}`);
}
