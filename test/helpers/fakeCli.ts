/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Shared fixture helper for tests that stand in a fake CLI binary
// (codex/claude) on disk. This project's test-execution policy forbids
// compiling or renaming any file to a native executable, so every fixture
// here is a plain text shim: a .cmd batch file on win32 (child_process's
// shell:true / needsShell()-style rungs require that extension), and a
// chmod'd #!/bin/sh (or #!/usr/bin/env node) script on posix, which the
// kernel execs directly via its shebang — no shell search or PATH lookup
// needed for the file itself to run.
//
// Getting this platform split wrong is exactly what broke CI on
// ubuntu-latest while windows-latest passed: a .cmd file's content
// (`@echo off\r\necho ...`) is not valid /bin/sh, so probing it via
// execFileSync/spawnSync with shell:true on posix fails to run at all
// (discovery/adapter code then reports "not found", not the fixture's own
// output) even though the exact same test passes on win32.

import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const IS_WIN = process.platform === "win32";

export interface FakeCliSpec {
  /** Directory to write the stub into. */
  dir: string;
  /** File name. On win32 include the extension you want (.cmd/.bat); on posix the name is not otherwise significant (no shell PATH lookup is required for an absolute-path candidate) but should still match whatever the code under test expects to find by name (e.g. "codex"). */
  name: string;
  /** Full win32 .cmd file content, e.g. "@echo off\r\necho codex-cli 1.0.0\r\n". */
  win: string;
  /** Posix shell body (no shebang, no trailing newline needed) — this helper prepends "#!/bin/sh\n" and chmods the file 0o755. */
  posix: string;
}

/** Writes an executable CLI stub appropriate for the current platform: a .cmd batch shim on win32, a chmod'd shebang shell script on posix. Never a compiled or renamed executable. Returns the stub's absolute path. */
export function writeFakeCli(spec: FakeCliSpec): string {
  const dest = join(spec.dir, spec.name);
  if (IS_WIN) {
    writeFileSync(dest, spec.win);
  } else {
    writeFileSync(dest, `#!/bin/sh\n${spec.posix}\n`, "utf8");
    chmodSync(dest, 0o755);
  }
  return dest;
}

/** Convenience for the common case: a stub whose only job is to print one line to stdout (mimicking `codex --version` / a same-named impostor binary) and exit 0. */
export function writeVersionStub(dir: string, name: string, versionOutput: string): string {
  return writeFakeCli({
    dir,
    name,
    win: `@echo off\r\necho ${versionOutput}\r\n`,
    posix: `echo "${versionOutput}"`,
  });
}
