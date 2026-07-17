# Phase 5 (p5-t1): Shared-Core Duplication Analysis & Extraction Proposal

**Status:** PROPOSAL ONLY. No file under `src/`, `media/`, `hooks/`, or
`standalone/src/` was modified to produce this document. Every extraction
below requires explicit human approval, item by item, before any code is
touched.

## 1. Executive summary + overall recommendation

The reuse-in-place architecture built in Phases 1-4 already captured almost
all of the achievable value: `standalone/src/sharedLogic.mjs` `createRequire`s
the compiled `out/src/core/state.js` and
`out/src/providers/claude-code/mapHookRecord.js` directly, and `media/main.js`
+ `media/style.css` are served byte-identical, in place, from the repo's
`media/` directory. Because of that, the state-computation and rendering
layers have **zero** duplication today — there was nothing left to find
there.

What *is* left is smaller and more surgical than a "the standalone
reimplements half the extension" narrative would suggest. Two genuine
duplicates exist, both quite different in shape:

1. **The webview DOM scaffold** (`panel.ts`'s `_getHtmlForWebview` body vs.
   `server.mjs`'s `buildHostHtml()` body) — ~330 lines of HTML markup that is
   byte-for-byte identical except for quote style, hand-copied and hand-kept-
   in-sync. This is the *largest* duplicate by line count, and there's
   already a visible symptom of drift risk: `server.mjs` deliberately omits
   the `theme-builder.js` `<script>` tag panel.ts has, a fact the standalone
   author had to notice and document rather than something a diff would have
   caught automatically.
2. **The hook-settings merge logic**
   (`installHook.mjs#mergeHookIntoSettings` vs.
   `hookInstall.ts#mergeTycoonHooks`, plus the identical `TYCOON_HOOK_SLOTS`
   array) — ~50 lines of pure, stable, rarely-changing logic, already
   commented on both sides as an intentional, hand-synced duplicate.

Everything else investigated (the `acquireVsCodeApi` shim, the app-data
directory, project-root resolution, the `MSG.STATE` wire-string, JSONL
parsing) is either **not duplication at all** (a standalone-only
implementation of a capability VS Code provides for free, so there is no
extension-side counterpart to compare against) or **already the cheapest
correct answer** (a drift-guard test instead of an import, because the real
import would drag in `zod`).

**Recommendation:** do **one** extraction now — item #2 (hook-settings merge)
— because it is uniquely low-risk: `hookInstall.ts` is already 100%
vscode-free (only `fs`/`path`), so the "extension edit" it requires can be
**zero lines**, or at most a small in-place file relocation. Treat item #1
(DOM scaffold) as OPTIONAL: real and the biggest line-count win, but it is
the only proposal that requires editing `panel.ts` itself, the single file
the project has explicitly fenced off. Do not manufacture work beyond these
two — the honest conclusion for the remaining candidates is "leave them
alone."

## 2. Duplication inventory table

| Candidate | Files on each side | Verdict | Severity | Evidence |
|---|---|---|---|---|
| State computation / event reducer | `standalone/src/sharedLogic.mjs` vs `src/core/state.ts` | ALREADY SHARED | — | `sharedLogic.mjs:32-122` `createRequire`s `out/src/core/state.js` directly; no reimplementation |
| Hook record mapping | `standalone/src/sharedLogic.mjs` vs `src/providers/claude-code/mapHookRecord.ts` | ALREADY SHARED | — | `sharedLogic.mjs:64-73, 114-122` requires `out/src/providers/claude-code/mapHookRecord.js` |
| Rendering / canvas / metrics UI | `media/main.js`, `media/style.css` served by `server.mjs` vs by `panel.ts` | ALREADY SHARED | — | `server.mjs:665-668` serves `/media/*` straight from the repo `media/` dir; `panel.ts:5082-5087` uses `asWebviewUri` on the same files. Same bytes, two transport mechanisms. |
| **Webview DOM scaffold (body markup)** | `src/host/vscode/panel.ts:5106-5453` (`_getHtmlForWebview`) vs `standalone/src/server.mjs:298-644` (`buildHostHtml`) | **REAL DUP** | **HIGH** — ~330 lines, byte-identical apart from quote style; touched by every new modal/HUD/button feature | `diff` of the two body ranges: only 1 line differs (a `"..."` vs `'...'` quoting choice) across 347 lines. Known drift symptom: `server.mjs:168` documents that `theme-builder.js`'s `<script>` tag (present in `panel.ts:5454`) was intentionally left out of the standalone copy. |
| CSP / nonce / `asWebviewUri` head wiring | `panel.ts:5068-5104` vs `server.mjs:206-296` | NECESSARILY DIFFERENT | — | VS Code webviews require a `Content-Security-Policy` with a per-load `nonce` and extension-relative `asWebviewUri` rewriting; a plain HTTP server has none of these constraints and instead serves static files directly. No shared logic is possible here — they solve different problems. |
| **`acquireVsCodeApi` shim** | `standalone/src/server.mjs:213-295` only | **NOT DUPLICATION** (no extension-side counterpart) | — | In a real VS Code webview, `acquireVsCodeApi()` is injected by VS Code itself — the extension ships no implementation of it. The standalone's shim (postMessage→`/message`, SSE `/events`→`window.postMessage`, `getState`/`setState`→`localStorage`) *replaces* a host-provided browser API. There is nothing on the extension side to extract this from or reconcile it with. |
| **Hook-settings merge (`TYCOON_HOOK_SLOTS` + merge algorithm)** | `standalone/src/installHook.mjs:56-126` (`TYCOON_HOOK_SLOTS`, `mergeHookIntoSettings`) vs `src/host/vscode/hookInstall.ts:20-75` (`TYCOON_HOOK_SLOTS`, `mergeTycoonHooks`) | **REAL DUP** | MEDIUM — ~50 lines, but stable/rarely-changing, and both sides already carry "kept in sync BY HAND" comments pointing at each other | `installHook.mjs:8-15` explicitly documents "This intentionally MIRRORS src/host/vscode/hookInstall.ts's settings shape... WITHOUT importing that file." Both `TYCOON_HOOK_SLOTS` arrays (7 identical `{event, matcher}` entries) and both merge functions (identical find/push/idempotency logic) match line-for-line modulo TS types. |
| Legacy/foreign hook cleanup (`cleanupForeignHookArtifacts`, `findLegacyHookCommands`, `LEGACY_HOOK_BASENAMES`) | `hookInstall.ts:77-366` only | NOT DUPLICATED (fine as-is) | — | `installHook.mjs` has no equivalent logic at all — the standalone install path is deliberately minimal (register the hook, nothing else). Not a gap that needs filling for this task. |
| **`MSG.STATE` wire string** | `standalone/src/stateFeed.mjs:31-34` (`MSG_STATE = 'state'`) vs `src/host/vscode/messages.ts:27` (`MSG.STATE: "state"`) | REAL DUP, but **already the cheapest fix** | LOW | `stateFeed.mjs:14-17` explains why: `messages.ts` imports `zod` and `./projectPlan`, outside the standalone's verified vscode/dependency-free surface. `standalone/test/messageContract.test.mjs` parses the real `messages.ts` source as text and asserts the live `stateFeed.mjs` emission matches it — turning silent drift into a loud test failure. |
| App-data / durable state directory | `standalone/src/appData.mjs` vs `vscode.ExtensionContext.globalStorageUri` | **NOT DUPLICATION** (no extension-side counterpart) | — | `globalStorageUri` is provided by the VS Code API; the extension contains no directory-resolution logic to compare against. `appData.mjs` is a from-scratch, necessary equivalent (win32/darwin/XDG paths) for a capability only VS Code supplies. |
| Project-root resolution | `standalone/src/projectRoots.mjs#resolveProjectRoots` vs `src/host/vscode/progressScope.ts#resolveProjectRoot` | NECESSARILY DIFFERENT | — | `progressScope.ts:172-188`'s precedence is workspace-folder-first with an env-var tie-break (a VS Code-specific anti-cross-project-bleed fix, see project memory). `projectRoots.mjs:73-101`'s precedence is CLI-arg > env-var > cwd — there is no "open workspace folder" concept outside VS Code, so the algorithms are answering different questions, not the same question twice. |
| Activity.jsonl line-parsing (JSON-per-line, skip blank/invalid) | `panel.ts:4586-4609` (`_readActivityRecords`) vs `standalone/src/activityWatcher.mjs` | REAL DUP, trivial | LOW | Both split on `\n`, trim, try/catch `JSON.parse`, skip malformed lines — ~15 lines of boilerplate. Format is stable (append-only JSONL written by `hooks/tycoon-claude-hook.cjs`, the one true source both sides already agree on). Too small to justify a shared module. |

## 3. Ranked extraction proposals

### Proposal A — Hook-settings merge logic (RECOMMEND)

**What to extract:** `TYCOON_HOOK_SLOTS` and the `mergeTycoonHooks`/
`mergeHookIntoSettings` pure function.

**Key fact that makes this safe:** `src/host/vscode/hookInstall.ts` imports
only `fs` and `path` — **zero** `vscode` imports anywhere in the file. It is
already exactly as "vscode-free" as `src/core/state.ts`, which
`sharedLogic.mjs` already reuses via `createRequire` on the compiled output.

**Exact extension edit required:** **none**, in the minimal version. Add
`out/src/host/vscode/hookInstall.js` to `sharedLogic.mjs`'s list of verified
vscode-free compiled modules (a comment + a new `requireCompiled(...)` call
in `standalone/src/sharedLogic.mjs`, mirroring the existing `state.js` /
`mapHookRecord.js` entries) and export `mergeTycoonHooks` /
`TYCOON_HOOK_SLOTS` through it. `standalone/src/installHook.mjs` then calls
the shared function instead of its own `mergeHookIntoSettings`/local
`TYCOON_HOOK_SLOTS`, deleting ~50 duplicated lines. **`src/host/vscode/hookInstall.ts` itself does not need to change one byte** — this is a pure
consumption-side change on the standalone.

A slightly cleaner (but non-required) follow-up would relocate
`TYCOON_HOOK_SLOTS`/`mergeTycoonHooks` from `hookInstall.ts` into a new
`src/core/hookSettings.ts`, with `hookInstall.ts` importing and re-exporting
them so `panel.ts`'s existing `import { mergeTycoonHooks } from
"./hookInstall"` (panel.ts:122,127) keeps compiling unchanged. That is a
small, mechanical, behavior-preserving move (same exported names, same
values) — but it is optional polish, not required to get the win.

**Risk to the VSIX:** effectively none for the minimal version (no `src/`
edit at all). For the optional relocation: low — it is a pure code move with
identical exports, verified the same way any refactor here is (`tsc`, full
test suite, `vsce package` file count/size, `git diff` review of
`hookInstall.ts` shows only an import + re-export, no behavior change).

**How it would be proven safe:**
- `npx tsc -p .` clean (both before/after, and after building `out/` for the
  standalone to require).
- Full test suite green, specifically `standalone/test/installHook.test.mjs`
  (currently tests `mergeHookIntoSettings` — after the change it should
  exercise the shared function through the same public API, same test
  cases, same assertions) and the extension's existing `hookInstall`-related
  unit tests.
- `vsce package`: 54 files / 1.09MB unchanged (no `src/` file touched, or if
  the optional relocation happens, `git diff --stat -- src/host/vscode/hookInstall.ts` should show a small, reviewable diff and no other file changed).
- `media/main.js` byte-unchanged (irrelevant to this proposal but part of
  the standard battery — confirms no accidental spillover).
- `git diff` review: the only expected changed files are
  `standalone/src/sharedLogic.mjs` and `standalone/src/installHook.mjs` (plus,
  optionally, `src/host/vscode/hookInstall.ts` for the relocation variant).

**Verdict: RECOMMEND** (minimal, zero-extension-edit version).

### Proposal B — Webview DOM scaffold body (OPTIONAL)

**What to extract:** the body markup between `<canvas id="stage">` and the
closing `</div><!-- /app -->`/modals block that `_getHtmlForWebview` and
`buildHostHtml()` currently both hand-maintain — everything *except* the
`<head>` (CSP/nonce/`asWebviewUri`/`acquireVsCodeApi` shim, which are
genuinely host-specific and stay put) and the trailing `<script>` tags
(also host-specific: nonce'd `asWebviewUri` vs plain `/media/main.js`).

**New shared module:** a new, dependency-free `src/core/webviewBody.ts`
exporting a pure function, e.g. `buildWebviewBodyHtml({ version }: { version:
string }): string`, returning exactly the markup both files currently embed.
Compiled to `out/src/core/webviewBody.js`; `standalone/src/server.mjs`
requires it the same way `sharedLogic.mjs` requires `state.js` today.

**Exact edit required in the extension:** `panel.ts`'s
`_getHtmlForWebview` (around `panel.ts:5068-5104`) would call
`buildWebviewBodyHtml({ version })` and splice the result between its own
`<head>` and its own `<script>` tags, instead of inlining the ~330 lines of
markup directly. This is mechanical (cut markup out, paste into new file,
call function) but it does touch `panel.ts`, the single file the project
has explicitly fenced off pending human approval.

**Risk to the VSIX:** low in mechanism (a pure string-template extraction,
provably verifiable by asserting `_getHtmlForWebview`'s OUTPUT is
byte-identical before/after for a fixed nonce/styleUri/scriptUri/version —
i.e. this refactor can be regression-tested with a literal string-equality
assertion, not just "looks right"), but nonzero in the sense that it is an
edit to the most consequential file in the project, and any diff review here
carries the full weight of "did this break the panel." It also currently has
a real, known gap to resolve as part of the same change: `server.mjs`'s copy
is missing the `theme-builder.js` `<script>` tag panel.ts has (documented,
not accidental) — extracting the shared body would not by itself fix that
(the script tags stay host-specific), so this proposal does not silently
"fix" the gap, it only stops the *markup* from drifting further.

**How it would be proven safe:**
- A new unit test asserting `_getHtmlForWebview(...)`'s returned HTML string
  is byte-identical to a captured golden output from before the refactor
  (for fixed nonce/uris/version inputs) — the strongest possible guarantee
  for a pure-refactor change.
- `npx tsc -p .` clean; full 758-test suite green; `check:webview` green.
- `vsce package` — 54 files / 1.09MB, `media/main.js` byte-unchanged.
- `git diff -- src/host/vscode/panel.ts` reviewed line-by-line to confirm
  the change is subtractive (markup removed, one function call added) with
  no logic touched elsewhere in the 5,100-line file.
- Manual smoke: open the panel in VS Code/Antigravity and confirm the
  webview renders identically (boot loader, menu, badge HUD, metrics panel,
  all modals) — the one check that can't be fully automated for a DOM change.

**Verdict: OPTIONAL.** Real, the largest duplicate found, and provably
safe to verify — but it is the only proposal that touches `panel.ts`, so it
should wait for explicit sign-off rather than being bundled with Proposal A.

## 4. Explicitly rejected / deferred

- **No big-bang `panel.ts` refactor.** `panel.ts` is ~5,100 lines of VS Code
  extension API usage (webview lifecycle, `FileSystemWatcher`s, `vscode.Uri`,
  command registration) and cannot run outside a VS Code extension host. It
  is not, and should not become, a "shared core" module. Proposal B extracts
  one small, self-contained pure function *out of* it; it does not refactor
  or restructure the file itself.
- **`acquireVsCodeApi` shim — reject extraction.** There is no extension-side
  implementation to share it with; VS Code provides this API natively. Any
  "extraction" here would just be moving standalone-only code between
  standalone-only files, with zero benefit.
- **App-data directory (`appData.mjs`) — reject extraction.** Same reasoning:
  `vscode.ExtensionContext.globalStorageUri` has no extension-authored logic
  behind it to share. `appData.mjs` is the standalone's from-scratch,
  necessary equivalent, not a duplicate of anything.
- **Project-root resolution — reject extraction.** The two algorithms answer
  genuinely different questions (workspace-folder precedence vs.
  CLI/env/cwd precedence for a tool with no concept of an "open workspace").
  Unifying them would mean bolting standalone-only concerns onto
  `progressScope.ts` for no behavioral gain.
- **`MSG.STATE` wire string — defer, keep the guard test.** The "fix" would
  require either (a) making `messages.ts` itself dependency-free (dropping
  its `zod`/`projectPlan` imports — a real, unwanted architectural change to
  a file with much broader responsibilities than one constant), or (b)
  splitting out a separate `messages.constants.ts` just for this one string,
  which is more new surface area than the one-string problem justifies.
  `standalone/test/messageContract.test.mjs` already converts "silent drift"
  into "loud test failure" at near-zero cost. This is the textbook case of
  "the guard test is the right and cheaper answer."
- **Activity.jsonl line-parsing — defer.** ~15 lines, stable format, low
  drift risk. Not worth a shared module or an extension edit for a single-digit
  line count of boilerplate that both sides already implement correctly and
  identically.
- **Legacy/foreign hook cleanup (`cleanupForeignHookArtifacts` and friends)
  — defer, do not backport to standalone.** This is extension-only
  functionality with no current standalone equivalent; the standalone's
  install path is deliberately minimal by design (see `installHook.mjs`'s
  header). Backporting it was not asked for and is out of scope for a
  duplication cleanup pass — it would be *adding* new standalone behavior,
  not deduplicating existing behavior.

## 5. Per-proposal risk/reward verdict (for item-by-item approval)

| # | Proposal | Extension edit required | Risk | Reward | Verdict |
|---|---|---|---|---|---|
| A | Share `TYCOON_HOOK_SLOTS` + hook-settings merge logic via the existing `sharedLogic.mjs` `createRequire` pattern | None (minimal version) — `hookInstall.ts` is already vscode-free | Effectively none (no `src/` file touched) | Removes ~50 lines of hand-synced duplicate logic; one settings-merge bug fix now reaches both hosts automatically | **RECOMMEND** |
| A (opt.) | ...plus relocate the slots/merge fn into `src/core/hookSettings.ts` with `hookInstall.ts` re-exporting | Small, mechanical, behavior-preserving (`hookInstall.ts` only) | Low | Slightly cleaner architecture, matches the `src/core` "verified vscode-free" convention explicitly | OPTIONAL |
| B | Extract the ~330-line webview DOM scaffold body into `src/core/webviewBody.ts`, called from both `panel.ts` and `server.mjs` | Yes — `panel.ts`'s `_getHtmlForWebview` (subtractive, provably byte-identical-output verifiable) | Low-mechanism / touches the most sensitive file in the project | Largest line-count win found; stops the biggest, fastest-moving drift source (every new UI element) | **OPTIONAL — needs explicit sign-off before touching `panel.ts`** |
| — | `acquireVsCodeApi` shim | N/A — nothing to extract | N/A | None | REJECT |
| — | App-data directory | N/A — nothing to extract | N/A | None | REJECT |
| — | Project-root resolution | N/A — algorithms differ by design | N/A | None | REJECT |
| — | `MSG.STATE` wire string | Would require restructuring `messages.ts`'s dependencies | Low reward for real architectural cost | Marginal (already guarded by a test) | REJECT — keep the guard test |
| — | Activity.jsonl line-parsing | N/A | N/A | Marginal (~15 lines) | REJECT (defer) |
