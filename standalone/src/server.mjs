#!/usr/bin/env node
// TycoonAgents standalone server.
//
// Runs the TycoonAgents live agent visualization outside VS Code by serving
// a plain HTML host page that boots the UNMODIFIED media/main.js + media/
// style.css in place from the repo's media/ directory (single source of
// truth — never copied into standalone/).
//
// Routes:
//   GET  /              host page (DOM scaffold main.js expects + the real
//                        acquireVsCodeApi() shim: postMessage -> POST
//                        /message, SSE /events -> window 'message', and
//                        getState/setState -> localStorage — see the block
//                        comment above buildHostHtml() below)
//   GET  /media/<path>  static passthrough into the repo's media/ dir
//                        (path-traversal guarded)
//   GET  /events         SSE stream (server -> browser); connected clients
//                        are tracked so later tasks can broadcast() to them
//   POST /message        browser -> server message intake (JSON body);
//                        logged/dispatched — later tasks fill in real
//                        handling (wiring into the same message handling
//                        src/host/vscode/panel.ts's webview.onDidReceiveMessage
//                        does)
//
// MVP constraint: Node built-in modules only (http, fs, path, url) — no
// third-party dependencies (ws/express/electron etc.) until a later task
// introduces them deliberately.
//
// stateFeed.mjs (wired in main() below) watches the resolved primary
// project root's .claude/tycoon/activity.jsonl via activityWatcher.mjs and
// broadcast()s MSG.STATE-shaped { type: "state", state } messages over
// /events as "message" SSE events — see stateFeed.mjs's module header for
// the full panel.ts-parity contract. Which project root(s) are watched is
// resolved by projectRoots.mjs's resolveProjectRoots() (CLI arg(s) > env var
// > cwd default; see that module and the MULTI-DIR SEMANTICS comment on
// main() below) — this replaces vscode.workspace.workspaceFolders for the
// standalone host.
//
// Later tasks will add:
//   - a watcher over the rest of .claude/tycoon/*.json (plan.json,
//     active-agent.json UI-facing bits beyond state, etc.)
//
// The `npx tycoonagents-standalone` CLI wrapper (p4-t1) is cli.mjs's `watch`
// command, which drives this module's exported startServer() — see that
// function's doc comment below for the seam contract.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStateFeed } from './stateFeed.mjs';
import { resolveProjectRoots, ProjectRootError } from './projectRoots.mjs';
import { createDefaultAppData } from './appData.mjs';
import {
  createFsThemeFileStore,
  themeImagesDirectoryPath,
  themeManifestPath,
  legacyManifestPath,
} from './themeFileStoreFs.mjs';
import {
  MSG_WIRE as THEME_MSG_WIRE,
  handleListThemes,
  handleSelectTheme,
  handleDeleteTheme,
  handleGetThemeImageReview,
} from './themeMessages.mjs';
import { exportThemeArchiveFromStore, importThemeArchiveToStore } from './themeArchive.mjs';
import { configureThemeFileStore } from './themeGenerationBridge.mjs';
import {
  handlePlanTheme,
  handleGenerateTheme,
  handleRetryThemeImage,
  handleResliceThemeImage,
  handleNormalizeThemeCharacter,
  handleSetThemeImageReviewStatus,
  handleSetThemePauseForReview,
  handleCancelThemeGeneration,
  handleSetThemeItemNames,
  handleSetThemeItemDescriptions,
  handleSetThemeCreativeDirection,
  handleRenameThemeCharacter,
  handleApproveAllThemeImages,
} from './themeGenerationMessages.mjs';
import { handleRestorePlanBackup } from './projectPlanMessages.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// standalone/src -> standalone -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MEDIA_DIR = path.join(REPO_ROOT, 'media');

const PORT = Number(process.env.TYCOON_STANDALONE_PORT) || 4173;
const HOST = process.env.TYCOON_STANDALONE_HOST || '127.0.0.1';

// ── MIME map (media/ only ships a handful of extensions today) ─────────────
const MIME_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── SSE client registry ─────────────────────────────────────────────────────
// Later tasks (file watchers over .claude/tycoon/*.json etc.) will call
// broadcast() to push events to every connected browser tab. Exported so
// test harnesses can drive it directly without a real file-watcher wired up
// yet; eventName "message" is what the host page's acquireVsCodeApi() shim
// listens for and re-dispatches as a window 'message' event (see
// buildHostHtml() below).
const sseClients = new Set();

export function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ── Initial-message catch-up for late-connecting clients ───────────────────
// broadcast() only reaches clients ALREADY connected at the time it's
// called. A browser tab that connects to /events after e.g. stateFeed.mjs
// has already computed real state from existing activity.jsonl backlog
// would otherwise sit on a blank board until the next live write triggers a
// broadcast — which could be a long time into an already-running session.
// Providers registered here are called once per new /events connection
// (this new client only — never re-broadcast to already-connected clients,
// which already have this state or something newer) and any messages they
// return are replayed to just that client before live SSE traffic begins.
/** @type {Array<() => Array<{ eventName: string, data: object }> | undefined>} */
let initialMessageProviders = [];

export function registerInitialMessageProvider(fn) {
  if (typeof fn !== 'function') return () => {};
  initialMessageProviders.push(fn);
  return () => {
    initialMessageProviders = initialMessageProviders.filter((f) => f !== fn);
  };
}

function writeSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── /message dispatch hook point ────────────────────────────────────────────
// Dispatches the 4 non-AI theme messages (project-plan task pB-t1) — see
// themeMessages.mjs's module header for why those are REIMPLEMENTED against
// the vscode-free ThemeFileStore rather than importing themeService.ts
// directly (themeService.ts/themeStorage.ts/themeImageReviewState.ts all
// `import vscode` at load time). Everything else still just logs; later
// tasks wire in the remaining (AI-touching) message handling
// src/host/vscode/panel.ts's webview.onDidReceiveMessage does.
//
// `themeStore` is set by startServer() below (rooted at that call's
// appData.dir — see the pB-t1 CRITICAL note on startServer()'s theme-store
// wiring). A message that arrives before any startServer() call has run
// (should not happen in practice; only a defensive guard) is logged and
// dropped rather than throwing.
let themeStore;

// `primaryProjectRoot` is set by startServer() below to the resolved primary
// project root (`primary.root` — see the MULTI-DIR SEMANTICS comment on
// startServer()), the standalone's analog of panel.ts's `_projectRoot()`.
// Used ONLY by the Project Plan (phase/task) RESTORE_PLAN_BACKUP handler
// (projectPlanMessages.mjs) — an unrelated feature to theme generation that
// happens to be dispatched from this same switch (see that module's header
// for why). Never touched by any theme handler.
let primaryProjectRoot;

// `themeImageConfigGetter` is set by startServer() below to a closure over
// THAT call's own `env`/`appData` (never raw process.env — see
// getThemeImageConfig()'s doc comment), so the five theme GENERATION message
// handlers (pC-t1 step 2) always resolve the CURRENT server instance's
// provider/API-key config, mirroring themeStore's per-call-instance posture
// above (both null out any stale prior startServer() call's config on a
// fresh call, e.g. in tests).
let themeImageConfigGetter;

function handleBrowserMessage(msg) {
  if (!msg || typeof msg.type !== 'string') {
    console.log('[tycoonagents-standalone] /message: malformed payload, dropping:', JSON.stringify(msg));
    return;
  }
  if (!themeStore) {
    console.log('[tycoonagents-standalone] /message:', JSON.stringify(msg), '(no theme store configured yet)');
    return;
  }
  const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
  switch (msg.type) {
    case THEME_MSG_WIRE.LIST_THEMES:
      handleListThemes(themeStore, broadcast).catch((err) => {
        console.error('[tycoonagents-standalone] LIST_THEMES failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SELECT_THEME:
      handleSelectTheme(themeStore, broadcast, payload.theme_id).catch((err) => {
        console.error('[tycoonagents-standalone] SELECT_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.DELETE_THEME:
      handleDeleteTheme(themeStore, broadcast, payload.theme_id).catch((err) => {
        console.error('[tycoonagents-standalone] DELETE_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.GET_THEME_IMAGE_REVIEW:
      handleGetThemeImageReview(themeStore, broadcast, payload.theme_id).catch((err) => {
        console.error('[tycoonagents-standalone] GET_THEME_IMAGE_REVIEW failed:', err);
      });
      break;
    // ── Theme GENERATION messages (pC-t1 step 2) — drive the REAL
    // themeService.ts pipeline via themeGenerationBridge.mjs. Fire-and-forget
    // like every other case here: progress/results stream back over SSE
    // (broadcast) rather than blocking this POST /message response, which is
    // essential for GENERATE_THEME/RETRY_THEME_IMAGE/NORMALIZE_THEME_CHARACTER
    // since those can run for a long time (real image-generation API calls).
    case THEME_MSG_WIRE.PLAN_THEME:
      handlePlanTheme(themeStore, broadcast, themeImageConfigGetter, payload).catch((err) => {
        console.error('[tycoonagents-standalone] PLAN_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.GENERATE_THEME:
      handleGenerateTheme(themeStore, broadcast, themeImageConfigGetter, payload).catch((err) => {
        console.error('[tycoonagents-standalone] GENERATE_THEME failed:', err);
      });
      break;
    case THEME_MSG_WIRE.RETRY_THEME_IMAGE:
      handleRetryThemeImage(themeStore, broadcast, themeImageConfigGetter, payload).catch((err) => {
        console.error('[tycoonagents-standalone] RETRY_THEME_IMAGE failed:', err);
      });
      break;
    case THEME_MSG_WIRE.RESLICE_THEME_IMAGE:
      handleResliceThemeImage(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] RESLICE_THEME_IMAGE failed:', err);
      });
      break;
    case THEME_MSG_WIRE.NORMALIZE_THEME_CHARACTER:
      handleNormalizeThemeCharacter(themeStore, broadcast, themeImageConfigGetter, payload).catch((err) => {
        console.error('[tycoonagents-standalone] NORMALIZE_THEME_CHARACTER failed:', err);
      });
      break;
    // Minimal support messages the generation gate needs — see
    // themeGenerationMessages.mjs's module header for why these are wired
    // alongside the five primary generation messages above.
    case THEME_MSG_WIRE.SET_THEME_IMAGE_REVIEW_STATUS:
      handleSetThemeImageReviewStatus(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_IMAGE_REVIEW_STATUS failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SET_THEME_PAUSE_FOR_REVIEW:
      handleSetThemePauseForReview(payload);
      break;
    case THEME_MSG_WIRE.CANCEL_THEME_GENERATION:
      handleCancelThemeGeneration(broadcast);
      break;
    // ── Theme review-EDITOR + recovery messages (pC-t2) ─────────────────
    case THEME_MSG_WIRE.SET_THEME_ITEM_NAMES:
      handleSetThemeItemNames(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_ITEM_NAMES failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SET_THEME_ITEM_DESCRIPTIONS:
      handleSetThemeItemDescriptions(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_ITEM_DESCRIPTIONS failed:', err);
      });
      break;
    case THEME_MSG_WIRE.SET_THEME_CREATIVE_DIRECTION:
      handleSetThemeCreativeDirection(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] SET_THEME_CREATIVE_DIRECTION failed:', err);
      });
      break;
    case THEME_MSG_WIRE.RENAME_THEME_CHARACTER:
      handleRenameThemeCharacter(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] RENAME_THEME_CHARACTER failed:', err);
      });
      break;
    case THEME_MSG_WIRE.APPROVE_ALL_THEME_IMAGES:
      handleApproveAllThemeImages(themeStore, broadcast, payload).catch((err) => {
        console.error('[tycoonagents-standalone] APPROVE_ALL_THEME_IMAGES failed:', err);
      });
      break;
    // RESTORE_PLAN_BACKUP is the unrelated Project Plan (phase/task) feature
    // (see projectPlanMessages.mjs's header) — synchronous, no theme store
    // involved, keyed off primaryProjectRoot instead of a theme_id payload.
    case THEME_MSG_WIRE.RESTORE_PLAN_BACKUP:
      try {
        handleRestorePlanBackup(primaryProjectRoot, broadcast);
      } catch (err) {
        console.error('[tycoonagents-standalone] RESTORE_PLAN_BACKUP failed:', err);
      }
      break;
    default:
      console.log('[tycoonagents-standalone] /message (unhandled):', JSON.stringify(msg));
  }
}

// ── Static file serving (media/ in place, path-traversal guarded) ──────────
function serveMediaFile(reqPath, res) {
  // reqPath is the URL path AFTER the /media/ prefix has been stripped.
  const decoded = decodeURIComponent(reqPath);
  const resolved = path.resolve(MEDIA_DIR, `.${path.sep}${decoded}`);
  const relative = path.relative(MEDIA_DIR, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(resolved),
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ── Theme image static route (pB-t1) ────────────────────────────────────────
// GET /theme-images/<theme_id>/<filename> serves a generated review image
// straight off disk — the standalone analog of the VS Code extension's
// `webview.asWebviewUri()` conversion in panel.ts's _postThemeImageReview()
// (which can't be used here: there is no webview origin to rewrite into).
// Rooted at `themeImagesRootDir` (== the active startServer() call's
// appData.dir — see that function's theme-store wiring), guarded against
// path traversal the same way serveMediaFile() guards /media/<path>.
let themeImagesRootDir;

function serveThemeImageFile(themeId, rawFilename, res) {
  if (!themeImagesRootDir || !/^[a-z0-9_]+$/.test(themeId || '')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const imagesDir = path.join(themeImagesRootDir, ...themeImagesDirectoryPath(themeId).split('/'));
  const decoded = decodeURIComponent(rawFilename);
  const resolved = path.resolve(imagesDir, `.${path.sep}${decoded}`);
  const relative = path.relative(imagesDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(resolved),
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ── Theme export/import routes (pB-t2) ──────────────────────────────────────
// Reuses the SAME vscode-free archive logic the VS Code extension's Export/
// Import commands use (src/extension/themeArchiveOps.ts, moved out of
// themeService.ts for exactly this reuse — see themeArchive.mjs's module
// header) — no duplicated zip code, same 0.0.371 `images/raw/` exclusion,
// same export-readiness (all images approved) gate. `themeStore` is the same
// module-level fs-backed store handleBrowserMessage()/serveThemeImageFile()
// already use (set by startServer() below).

// GET /theme-export/<theme_id> streams a portable .zip download.
async function serveThemeExport(themeId, res) {
  if (!themeStore || !/^[a-z0-9_]+$/.test(themeId || '')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  // Explicit existence check BEFORE calling exportThemeArchiveFromStore:
  // that function (mirroring the VS Code extension's original behavior
  // exactly) checks export-readiness (all images approved) before it ever
  // notices the theme doesn't exist, so a wholly missing theme_id would
  // otherwise surface as a 400 "Approve all theme images..." rather than a
  // 404 - this pre-check keeps the "theme dir doesn't exist -> 404"
  // contract without changing that shared, behavior-identical logic.
  //
  // Checks BOTH the modern per-theme-directory manifest (themes/<id>/
  // manifest.json) and the legacy pre-per-theme-directory flat sidecar
  // (<id>_manifest.json at the store root — see themeFileStore.ts's
  // legacyManifestPath, ~line 117) because exportThemeArchiveFromStore's own
  // legacy-normalize fallback (themeArchiveOps.ts's loadThemeFromStore) can
  // still export a theme that only has the legacy manifest — a dir-only
  // check would wrongly 404 that theme even though the archive op would
  // have handled it.
  let exists;
  try {
    const [hasModern, hasLegacy] = await Promise.all([
      themeStore.exists(themeManifestPath(themeId)),
      themeStore.exists(legacyManifestPath(themeId)),
    ]);
    exists = hasModern || hasLegacy;
  } catch {
    exists = false;
  }
  if (!exists) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  exportThemeArchiveFromStore(themeStore, themeId)
    .then((bytes) => {
      const safeId = themeId.replace(/[^a-z0-9_]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${safeId}.zip"`,
        'Content-Length': bytes.length,
      });
      res.end(Buffer.from(bytes));
    })
    .catch((err) => {
      const message = String(err?.message ?? err);
      const notFound = /theme not found/i.test(message);
      res.writeHead(notFound ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
}

// 100 MB cap on the raw POST /theme-import body (theme archives are small —
// generated art PNGs, not video — this only exists to stop an unbounded
// buffer accumulation from an oversized/malicious upload).
const MAX_THEME_IMPORT_BYTES = 100 * 1024 * 1024;

// POST /theme-import reads the RAW request body as the archive bytes
// themselves — there is no vscode open-file dialog in the standalone, the
// browser client posts the .zip's contents directly as the request body —
// and installs it (never replacing an existing theme; the client is
// expected to re-request with an explicit replace flow in a later task if
// that UX is added).
function handleThemeImport(req, res) {
  if (!themeStore) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Theme store not configured yet.' }));
    return;
  }
  const chunks = [];
  let totalBytes = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_THEME_IMPORT_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({ error: `Import body exceeds the ${MAX_THEME_IMPORT_BYTES}-byte limit.` }),
        () => req.destroy(),
      );
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', (err) => {
    if (aborted) return;
    aborted = true;
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  });
  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    importThemeArchiveToStore(themeStore, new Uint8Array(body), false)
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
  });
}

// ── Host page ────────────────────────────────────────────────────────────────
// Standalone analog of src/host/vscode/panel.ts's _getHtmlForWebview(): same
// DOM scaffold (element ids) media/main.js's getElementById calls expect, so
// the unmodified script drives identically outside VS Code. Asset URIs point
// at the /media/* static route (served in place from the repo's media/ dir,
// never copied). theme-builder.js is included AFTER main.js (pD-t1), matching
// panel.ts's load order; main.js does not require it to boot on its own (see
// test/webviewSmoke.test.ts, which boots main.js alone). theme-builder.js's
// own top-level `acquireVsCodeApi()` call (media/theme-builder.js:92) is safe
// here because the shim below returns a singleton on every call — see the
// acquireVsCodeApi() note a few lines down.
//
// acquireVsCodeApi(): the REAL shim (p1-t3) so media/main.js's top-level
// `const vscode = acquireVsCodeApi();` (media/main.js:11) works identically
// to the VS Code webview contract:
//   - postMessage(msg)      -> POST /message (JSON body); network failures
//                              are swallowed + logged, never thrown, so a
//                              transient hiccup can't kill main.js's render
//                              loop (main.js calls postMessage from inside
//                              its rAF loop in several places). TWO types
//                              are special-cased instead of being POSTed
//                              (the server has no /message handler for
//                              either): EXPORT_THEME triggers a browser
//                              download of the pB-t2 GET /theme-export/<id>
//                              route, IMPORT_THEME opens a hidden file input
//                              and POSTs the chosen file's raw bytes to the
//                              pB-t2 POST /theme-import route (pD-t2); both
//                              then synthesize the matching
//                              THEME_EXPORT_RESULT/THEME_IMPORT_RESULT via
//                              deliverSyntheticMessage() below using the
//                              exact same window-'message'-event mechanism
//                              real SSE pushes use, so main.js needs no
//                              changes to react to either.
//   - getState()/setState(s) -> window.localStorage, single JSON key, so
//                              webview state survives a real page reload
//                              exactly like VS Code's webview state does.
//   - inbound server -> browser pushes ride SSE (/events) and are
//     re-dispatched as `window` 'message' events with event.data === the
//     object the server sent — the exact shape media/main.js's
//     `window.addEventListener("message", e => ...)` listener
//     (media/main.js:7175) already expects from the extension host's
//     webview.postMessage(). The server-side broadcast(eventName, data)
//     (see sseClients/broadcast above) MUST use eventName "message" for
//     anything meant to land here — "message" is the default SSE event
//     type EventSource's 'message' listener fires for.
//   - acquireVsCodeApi() may only be called ONCE in a real VS Code webview
//     (a second call throws there); this returns a singleton on every call
//     so main.js's single real call site (media/main.js:11) behaves
//     identically.
// Defined entirely in this host page's inline <script>, BEFORE
// /media/main.js is loaded below — media/main.js itself is never touched.
function buildHostHtml() {
  let version = '';
  try {
    const pkgRaw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    version = JSON.parse(pkgRaw).version || '';
  } catch {
    /* version stays empty if package.json can't be read */
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="/media/style.css" rel="stylesheet" />
  <title>TycoonAgents (standalone)</title>
  <script>
    // acquireVsCodeApi() shim — see the block comment above buildHostHtml()
    // in standalone/src/server.mjs for the full contract. This is the ONLY
    // place the shim lives; media/main.js is unmodified and unaware it is
    // not running inside a real VS Code webview.
    (function () {
      var STATE_KEY = 'tycoonagents:standalone:webviewState';
      var apiSingleton = null;

      function readState() {
        try {
          var raw = window.localStorage.getItem(STATE_KEY);
          return raw ? JSON.parse(raw) : undefined;
        } catch (err) {
          console.error('[tycoonagents-standalone] getState failed:', err);
          return undefined;
        }
      }

      function writeState(s) {
        try {
          window.localStorage.setItem(STATE_KEY, JSON.stringify(s));
        } catch (err) {
          console.error('[tycoonagents-standalone] setState failed:', err);
        }
        return s;
      }

      function postToServer(message) {
        // Resilient by design: postMessage must never throw synchronously or
        // reject visibly back into main.js's render loop over a transient
        // network error — swallow + log only.
        try {
          fetch('/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
          }).catch(function (err) {
            console.error('[tycoonagents-standalone] postMessage: /message request failed:', err);
          });
        } catch (err) {
          console.error('[tycoonagents-standalone] postMessage threw synchronously:', err);
        }
      }

      // Synthesizes an inbound host->webview message the exact same way
      // connectEvents() below turns a real SSE push into one: a window
      // 'message' event whose event.data is { type, payload }, matching what
      // media/main.js's window.addEventListener("message", e => ...)
      // listener (media/main.js:7175) already expects from a real VS Code
      // webview.postMessage(). Used by the EXPORT_THEME/IMPORT_THEME
      // special-cases below to deliver THEME_EXPORT_RESULT/
      // THEME_IMPORT_RESULT without a server round-trip (pD-t2).
      function deliverSyntheticMessage(type, payload) {
        window.dispatchEvent(new MessageEvent('message', { data: { type: type, payload: payload || {} } }));
      }

      // EXPORT_THEME (pD-t2): there is no vscode save-dialog in the
      // standalone, so exporting is a browser download of the pB-t2
      // GET /theme-export/<theme_id> route (which already sets
      // Content-Disposition: attachment). A transient off-DOM <a download>
      // click is the most reliable cross-browser way to start that download
      // without navigating the page away. main.js only needs the
      // THEME_EXPORT_RESULT that follows to re-enable the Export button and
      // show status (media/main.js:7904) - it does not care how the bytes
      // actually reached the browser.
      function triggerThemeExport(themeId) {
        if (!themeId) {
          deliverSyntheticMessage('THEME_EXPORT_RESULT', { theme_id: themeId, error: 'No theme selected to export.' });
          return;
        }
        try {
          var link = document.createElement('a');
          link.href = '/theme-export/' + encodeURIComponent(themeId);
          link.download = themeId + '.zip';
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          deliverSyntheticMessage('THEME_EXPORT_RESULT', { theme_id: themeId, display_name: themeId });
        } catch (err) {
          console.error('[tycoonagents-standalone] EXPORT_THEME failed:', err);
          deliverSyntheticMessage('THEME_EXPORT_RESULT', { theme_id: themeId, error: String((err && err.message) || err) });
        }
      }

      // IMPORT_THEME (pD-t2): there is no vscode open-dialog in the
      // standalone, so a hidden <input type="file"> stands in for it. The
      // chosen file's raw bytes are POSTed as the request body to the pB-t2
      // POST /theme-import route (which expects the RAW archive bytes, not a
      // multipart form - see handleThemeImport above). Cancel detection uses
      // the standard window-'focus'-after-dialog-closes trick (there is no
      // native file-input cancel event): if 'change' has not already fired
      // and settled things shortly after focus returns, we treat it as a
      // cancel - this mirrors what main.js's IMPORT_THEME button expects
      // (payload.cancelled, media/main.js:7942).
      function triggerThemeImport() {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        var settled = false;
        var focusTimer = null;

        // Detaches the focus-based cancel watcher (listener + its pending
        // grace timer, if any). Called the instant a real file is chosen
        // (synchronously, before the async upload starts) so a slow
        // fetch/unzip can never let the timer fire underneath it; also
        // called on the genuine-cancel and true-cancel paths below.
        function removeFocusWatcher() {
          window.removeEventListener('focus', onFocus);
          if (focusTimer !== null) {
            clearTimeout(focusTimer);
            focusTimer = null;
          }
        }

        function removeInput() {
          if (input.parentNode) input.parentNode.removeChild(input);
        }

        function onFocus() {
          // Give a just-fired 'change' event a chance to settle() first.
          focusTimer = setTimeout(function () {
            focusTimer = null;
            if (settled) return;
            settled = true;
            removeFocusWatcher();
            removeInput();
            deliverSyntheticMessage('THEME_IMPORT_RESULT', { cancelled: true });
          }, 300);
        }

        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) {
            // True dialog cancel: no file was ever selected.
            if (settled) return;
            settled = true;
            removeFocusWatcher();
            removeInput();
            deliverSyntheticMessage('THEME_IMPORT_RESULT', { cancelled: true });
            return;
          }
          // A real file was chosen: settle SYNCHRONOUSLY, before the async
          // upload starts, and detach the focus watcher right away. A real
          // import's fetch (network + server unzip/write) easily exceeds
          // the 300ms cancel grace period; without this the focus timer
          // would fire first, deliver a spurious {cancelled:true}, and the
          // eventual real result would be silently swallowed by an
          // early-return settled guard. The upload's own result is
          // delivered unconditionally below - settled is already true and
          // is not re-checked, so exactly one message goes out per pick.
          settled = true;
          removeFocusWatcher();
          file.arrayBuffer()
            .then(function (buf) {
              return fetch('/theme-import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: buf,
              });
            })
            .then(function (res) {
              return res.json().then(function (data) {
                return { ok: res.ok, data: data };
              });
            })
            .then(function (result) {
              removeInput();
              if (result.ok && !(result.data && result.data.error)) {
                deliverSyntheticMessage('THEME_IMPORT_RESULT', {
                  display_name: result.data && result.data.display_name,
                  replaced: result.data && result.data.replaced,
                });
                // Refresh the theme list through the normal channel so the
                // imported theme appears - the standalone's LIST_THEMES
                // handler broadcasts THEMES_LIST, which main.js already
                // renders (media/main.js's THEMES_LIST listener).
                postToServer({ type: 'LIST_THEMES' });
              } else {
                deliverSyntheticMessage('THEME_IMPORT_RESULT', {
                  error: (result.data && result.data.error) || 'Import failed.',
                });
              }
            })
            .catch(function (err) {
              removeInput();
              console.error('[tycoonagents-standalone] IMPORT_THEME failed:', err);
              deliverSyntheticMessage('THEME_IMPORT_RESULT', { error: String((err && err.message) || err) });
            });
        });

        window.addEventListener('focus', onFocus);
        document.body.appendChild(input);
        input.click();
      }

      // postMessage entry point used by the acquireVsCodeApi() singleton
      // below: EXPORT_THEME/IMPORT_THEME are special-cased into the browser
      // download/file-pick flows above (the server has no /message handler
      // for either - the pB-t2 routes are plain HTTP, not postMessage
      // dispatch); everything else goes to the server exactly as before.
      function dispatchPostMessage(message) {
        if (message && message.type === 'EXPORT_THEME') {
          triggerThemeExport(message.payload && message.payload.theme_id);
          return;
        }
        if (message && message.type === 'IMPORT_THEME') {
          triggerThemeImport();
          return;
        }
        postToServer(message);
      }

      function connectEvents() {
        // Server -> browser pushes ride SSE and are re-dispatched as window
        // 'message' events so media/main.js's existing
        // window.addEventListener("message", e => ...) needs no changes.
        try {
          var es = new EventSource('/events');
          es.addEventListener('message', function (evt) {
            try {
              var data = JSON.parse(evt.data);
              window.dispatchEvent(new MessageEvent('message', { data: data }));
            } catch (err) {
              console.error('[tycoonagents-standalone] SSE payload parse failed:', err, evt.data);
            }
          });
          es.onerror = function (err) {
            // EventSource auto-reconnects on its own; just log, never throw.
            console.error('[tycoonagents-standalone] SSE connection error (auto-retrying):', err);
          };
        } catch (err) {
          console.error('[tycoonagents-standalone] EventSource unavailable:', err);
        }
      }

      window.acquireVsCodeApi = function () {
        // Singleton: mirrors the real VS Code webview, where a second call
        // throws. main.js only ever calls this once (media/main.js:11), so
        // returning the same instance on any further call is equivalent.
        if (apiSingleton) return apiSingleton;
        apiSingleton = {
          postMessage: dispatchPostMessage,
          getState: readState,
          setState: writeState,
        };
        connectEvents();
        return apiSingleton;
      };
    })();
  </script>
</head>
<body>
  <!-- Boot loader: full-viewport overlay painted as part of the INITIAL HTML
       (styled by media/style.css, which is a render-blocking <link> above)
       so it is on screen before media/main.js has even parsed, let alone
       before the theme payload/art arrives. media/main.js drives its
       progress/visibility off real boot milestones; see the "Boot loader
       overlay" block near the top of that file. Sits above #app but below
       #setup-view so the onboarding/install card always wins if it needs
       to show (see showSetup()). -->
  <div id="boot-loader" role="status" aria-live="polite">
    <div class="boot-loader-glow" aria-hidden="true"></div>
    <div class="boot-loader-inner">
      <div class="boot-loader-title">TycoonAgents</div>
      <div class="boot-loader-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="boot-loader-track">
        <div id="boot-loader-fill" class="boot-loader-fill"></div>
      </div>
      <div id="boot-loader-label" class="boot-loader-label">Starting&hellip;</div>
    </div>
  </div>

  <!-- Canvas kept in DOM so existing render loop does not crash; hidden via CSS -->
  <canvas id="stage"></canvas>

  <!-- App shell: stage on top, resize handle, metrics panel on bottom -->
  <div id="app">

    <!-- Stage area: placeholder for future characters / background -->
    <div id="stage-area">
      <!-- Hamburger menu: scaffold for future panel controls -->
      <button id="menu-btn" aria-label="Open menu" aria-expanded="false" aria-haspopup="true">&#9776;</button>
      <div id="menu-popover" role="menu" hidden>
        <button class="menu-item" role="menuitem" id="menu-catalog">Skills / MCP / Packs</button>
        <button class="menu-item" role="menuitem" id="menu-settings">Settings</button>
        <button class="menu-item" role="menuitem" id="menu-themes">Themes</button>
        <button class="menu-item" role="menuitem" id="menu-about">About</button>
        ${version ? `<div class="menu-version" role="presentation">v${version}</div>` : ''}
      </div>
      <!-- Badge HUD: lower-right gold medallion, shown/updated by media/main.js -->
      <button id="badge-hud-btn" class="badge-hud" hidden aria-label="Badges" title="Badges — click to view your unlocked badges">
        <svg class="badge-hud-svg" viewBox="0 0 52 52" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="badgeHudGoldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#fff2c2" />
              <stop offset="40%" stop-color="#ffb020" />
              <stop offset="100%" stop-color="#8a4d06" />
            </linearGradient>
            <linearGradient id="badgeHudRibbonGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#7a1c26" />
              <stop offset="100%" stop-color="#4a1017" />
            </linearGradient>
            <clipPath id="badgeHudDiscClip">
              <circle cx="26" cy="21" r="17" />
            </clipPath>
          </defs>
          <path class="badge-hud-ribbon" d="M19 23 L13 50 L26 41 L39 50 L33 23 Z" fill="url(#badgeHudRibbonGrad)" stroke="#141418" stroke-width="1.5" stroke-linejoin="round" />
          <circle class="badge-hud-disc" cx="26" cy="21" r="17" fill="url(#badgeHudGoldGrad)" stroke="#141418" stroke-width="2.5" />
          <circle class="badge-hud-disc-rim" cx="26" cy="21" r="12.5" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="1" />
          <g clip-path="url(#badgeHudDiscClip)">
            <path class="badge-hud-shine" d="M12 15 A17 17 0 0 1 34 7 L26 21 Z" fill="rgba(255,255,255,0.4)" />
          </g>
        </svg>
        <span class="badge-hud-count">0</span>
      </button>
    </div>

    <!-- Resize handle: drag to split stage vs metrics panel -->
    <div id="resize-handle" role="separator" aria-label="Drag to resize panels">
      <span class="resize-grip"></span>
    </div>

    <!-- Metrics panel -->
    <div id="metrics-panel">
      <div id="metrics-header">
        <span class="header-dot"></span>
        <span class="header-title">Tycoon Agents &mdash; Agent Metrics</span>
      </div>
      <!-- Tab bar: switches between Metrics and the optional Project Plan
           view. Hidden entirely unless PLAN_STATE reports enabled:true (see
           updateMetricsTabsUI() in media/main.js) so nothing new shows for
           projects that haven't opted in. -->
      <div id="metrics-tabs" class="metrics-tabs" role="tablist" hidden>
        <button id="metrics-tab-btn" class="metrics-tab-btn" type="button" role="tab" aria-selected="true" aria-controls="metrics-body">Metrics</button>
        <button id="plan-tab-btn" class="metrics-tab-btn" type="button" role="tab" aria-selected="false" aria-controls="project-plan-body">Project Plan</button>
      </div>
      <div id="metrics-body">
        <div id="metrics-empty">No agents yet &mdash; start a session to see activity.</div>
        <table id="metrics-table" style="display:none">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Tokens/min</th>
              <th class="col-tasks">Tasks</th>
              <th class="col-mcp">MCP</th>
              <th class="col-time">Time</th>
              <th class="col-tokens">Tokens</th>
            </tr>
          </thead>
          <tbody id="metrics-tbody"></tbody>
        </table>
        <!-- Delegation stats (Team Lead Mode Phase 4: measurement) — populated
             by renderDelegationStats() in media/main.js from state.modeStats.
             Hidden by default; shown only when at least one mode has data. -->
        <div id="delegation-stats" hidden></div>
      </div>
      <!-- Project Plan (optional feature, opt-in via Settings): tab content
           hosted next to Metrics inside the same panel. Hidden unless
           PLAN_STATE reports enabled:true; rebuilt by
           renderProjectPlanSection() in media/main.js. -->
      <div id="project-plan-body" class="project-plan-body" hidden></div>
    </div>

  </div><!-- /#app -->

  <!-- Setup / onboarding overlay (styled + toggled by media/main.js) -->
  <div id="setup-view">
    <div id="setup-card">
      <h1>TycoonAgents</h1>
      <p id="setup-status">Checking installation&hellip;</p>
      <p id="setup-error" hidden></p>
      <!-- Pre-install delegation chooser: hidden by default; main.js reveals
           it ONLY when checkInstall reports hooks not installed. Installed
           projects use the "Delegation style" section renderSettings() builds
           inside #setup-config instead — never both at once. -->
      <div id="delegation-mode-group" class="delegation-mode-group" hidden>
        <div class="delegation-mode-title">Delegation style</div>
        <label class="delegation-mode-option">
          <input type="radio" name="delegation-mode" id="delegation-mode-flat" value="flat" checked>
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Direct (recommended for most projects)</span>
            <span class="delegation-mode-option-help">The orchestrator briefs specialist workers directly &mdash; it does the reviewing itself. Lowest coordination cost; best for focused fixes.</span>
          </span>
        </label>
        <label class="delegation-mode-option">
          <input type="radio" name="delegation-mode" id="delegation-mode-team-leads" value="team_leads">
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Team Leads</span>
            <span class="delegation-mode-option-help">Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs &mdash; many features across many files &mdash; where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Direct.</span>
          </span>
        </label>
        <label class="delegation-mode-option review-pass-option">
          <input type="checkbox" id="review-pass-checkbox" checked>
          <span class="delegation-mode-option-body">
            <span class="delegation-mode-option-label">Review pass (optional, on by default)</span>
            <span class="delegation-mode-option-help">Routes each significant change through a reviewer agent before it's marked done. Catches bugs and regressions early; roughly 20-40% more tokens on non-trivial tasks. Turn off for speed/lowest cost.</span>
          </span>
        </label>
        <p class="delegation-mode-footnote">You can change this anytime in Settings. Switching updates this project's agent roster and delegation instructions.</p>
      </div>
      <button id="install-hooks-btn" hidden>Install hooks</button>
      <div id="setup-config" hidden><!-- Phase 2: agent model settings --></div>
      <button id="setup-back-btn" hidden>Back</button>
    </div>
  </div>

  <!-- Skills modal overlay -->
  <div id="skills-modal" role="dialog" aria-modal="true" aria-label="Catalog" hidden>
    <div id="skills-backdrop"></div>
    <div id="skills-dialog">
      <button id="skills-modal-close" aria-label="Close dialog">&times;</button>
      <div class="catalog-tabs" role="tablist">
        <button id="tab-packs" class="catalog-tab" role="tab" aria-selected="false">Packs</button>
        <button id="tab-skills" class="catalog-tab catalog-tab--active" role="tab" aria-selected="true">Skills</button>
        <button id="tab-mcp" class="catalog-tab" role="tab" aria-selected="false">MCP servers</button>
      </div>
      <div id="packs-list" role="tabpanel" hidden></div>
      <div id="skills-list" role="tabpanel"></div>
      <div id="skills-footer">
        <a id="skills-more-link" href="https://github.com/anthropics/skills" target="_blank" rel="noopener noreferrer">Get more skills &rarr; Claude Agent Skills marketplace</a>
      </div>
      <div id="mcp-list" role="tabpanel" hidden></div>
    </div>
  </div>

  <!-- About modal overlay -->
  <div id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title" hidden>
    <div id="about-backdrop"></div>
    <div id="about-dialog">
      <button id="modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="about-modal-title">TycoonAgents</h2>
      <p>Created by Scott McClellan</p>
      <p>
        <a href="https://x.com/thetrashbyrd" target="_blank" rel="noopener noreferrer">@thetrashbyrd</a>
      </p>
      <p>
        <a href="https://github.com/Corsair-Studios/TycoonAgents" target="_blank" rel="noopener noreferrer">GitHub repository</a>
      </p>
    </div>
  </div>

  <!-- Badge modal overlay: lists all of the current theme's badges -->
  <div id="badge-modal" role="dialog" aria-modal="true" aria-labelledby="badge-modal-title" hidden>
    <div id="badge-backdrop"></div>
    <div id="badge-dialog">
      <button id="badge-modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="badge-modal-title">Badges</h2>
      <div id="badge-list"></div>
    </div>
  </div>

  <!-- Themes modal overlay -->
  <div id="themes-modal" role="dialog" aria-modal="true" aria-label="Themes" hidden>
    <div id="themes-backdrop"></div>
    <div id="themes-dialog">
      <button id="themes-modal-close" aria-label="Close dialog">&times;</button>
      <div id="themes-scroll">
      <div id="theme-picker-list" role="tabpanel">
        <section id="theme-library-section" class="theme-library-section">
          <h2 style="margin: 0 0 16px;">Themes</h2>
          <div id="theme-picker-grid" style="display: flex; flex-direction: column; gap: 8px;"></div>
          <div id="theme-picker-status" class="theme-picker-status" role="status" aria-live="polite"></div>
          <div class="theme-picker-actions">
            <button id="theme-import-btn" class="skill-btn">Import .zip</button>
            <button id="tab-theme-builder" class="skill-btn theme-builder-launch">Theme Builder</button>
          </div>
          <p class="theme-library-caption">Add a theme &mdash; build one with AI or import a shared .zip.</p>
        </section>
        <section id="theme-selected-section" class="theme-selected-section" hidden>
          <h3 id="theme-selected-heading" class="theme-selected-heading">Selected theme</h3>
          <div id="theme-selected-roster"></div>
        </section>
      </div>
      <div id="theme-builder-panel" role="tabpanel" hidden>
        <button id="tab-theme-picker" class="skill-btn" style="margin-bottom: 16px;">&larr; Back to themes</button>
        <div id="theme-image-settings" class="theme-image-settings">
          <div class="theme-image-settings-heading">Image generation</div>
          <div class="theme-image-settings-row">
            <label for="theme-image-provider">Image provider</label>
            <select id="theme-image-provider">
              <option value="openai">OpenAI (GPT Image 2)</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>
          <div class="theme-image-settings-row theme-api-key-row">
            <label for="theme-api-key-input" id="theme-api-key-label">Google Gemini API key</label>
            <input
              type="password"
              id="theme-api-key-input"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste a key to save securely"
            />
            <button id="theme-api-key-save" class="skill-btn theme-api-key-save-btn">Save</button>
          </div>
          <div id="theme-api-key-status" class="theme-api-key-status" role="status"></div>
        </div>
        <p class="theme-generation-approval-warning" style="margin: 6px 0 0; padding: 8px 10px; border-left: 3px solid #d9a441; background: rgba(217, 164, 65, 0.12); border-radius: 4px; font-size: 12px; line-height: 1.4;">
          &#9888; AI image generation isn't perfect &mdash; expect to regenerate some images and do a little manual cleanup (use Retry, Upload, or edit the prompt).
        </p>
        <div id="theme-prompt-container" class="theme-prompt-container">
          <input type="text" id="theme-prompt-input" placeholder="Name or describe a new theme" />
          <button id="theme-generate-btn" class="skill-btn">Plan theme</button>
        </div>
        <section id="theme-plan-editor" class="theme-plan-editor" hidden>
          <div class="theme-plan-header">
            <div>
              <h3>Review the theme plan</h3>
              <p>AI filled every slot. Edit anything you want before image generation begins.</p>
            </div>
            <span class="theme-plan-count">25 reviewable images</span>
          </div>
          <label class="theme-plan-field theme-plan-field--primary">
            <span>Theme name</span>
            <input id="theme-plan-name" type="text" />
          </label>
          <label class="theme-plan-field">
            <span>Creative direction</span>
            <textarea id="theme-plan-direction" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Characters <span>16 individual sprite boards</span></legend>
            <div id="theme-plan-characters" class="theme-plan-slots"></div>
          </fieldset>
          <label class="theme-plan-field">
            <span>Environment <small>1 image</small></span>
            <textarea id="theme-plan-environment" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Enemies <span>4 individual enemy rows &middot; 1 sprite board</span></legend>
            <div id="theme-plan-enemies" class="theme-plan-slots"></div>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Objects <span>21 objects &middot; 2 sprite sheets</span></legend>
            <div id="theme-plan-objects-slots" class="theme-plan-slots"></div>
            <label class="theme-plan-field theme-plan-field--sub">
              <span>Crate <small>fixed object &middot; appearance only</small></span>
              <textarea id="theme-plan-crate-desc" rows="2" placeholder="Appearance / description (optional)"></textarea>
            </label>
            <label class="theme-plan-field theme-plan-field--sub">
              <span>Poof effect <small>fixed object &middot; appearance only</small></span>
              <textarea id="theme-plan-poof-desc" rows="2" placeholder="Appearance / description (optional)"></textarea>
            </label>
            <label class="theme-plan-field theme-plan-field--sub">
              <span>Ranged projectile <small>fixed object &middot; appearance only &middot; animates muzzle &rarr; flight &rarr; impact &rarr; blast</small></span>
              <textarea id="theme-plan-projectile-desc" rows="2" placeholder="Appearance / description for the ranged combat projectile (optional)"></textarea>
            </label>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Decor <span>9 items &middot; 1 sprite board</span></legend>
            <p class="theme-plan-group-note">Decor: slots 1-4 are sittable seats (seat 1 is the leader's throne), 5-8 are static props, 9 is animated.</p>
            <div id="theme-plan-decor-slots" class="theme-plan-slots"></div>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Expressions <span>8 fixed slots &middot; 1 sprite sheet</span></legend>
            <p class="theme-plan-group-note">Expression slots are fixed (gameplay maps events by position) &mdash; you can restyle each one's look, not its meaning.</p>
            <div id="theme-plan-expressions-slots" class="theme-plan-slots"></div>
          </fieldset>
          <fieldset class="theme-plan-group">
            <legend>Achievement badges <span>25 designs &middot; 1 sprite sheet</span></legend>
            <p class="theme-plan-group-note">Each badge's unlock trigger and threshold are fixed per slot &mdash; you can rename and restyle, but not change what unlocks it.</p>
            <div id="theme-plan-achievements-slots" class="theme-plan-slots"></div>
          </fieldset>
          <div class="theme-plan-footer">
            <div id="theme-plan-validation" class="theme-plan-validation" role="status"></div>
            <div class="theme-plan-footer-actions">
              <label class="theme-generation-approval-toggle theme-generation-approval-toggle--footer" for="theme-pause-for-review">
                <input id="theme-pause-for-review" type="checkbox" checked />
                <span>
                  Pause after each image for approval
                  <small>Change this any time. Turning it off resumes a paused generation.</small>
                </span>
              </label>
              <button id="theme-start-generation-btn" class="skill-btn">Generate images</button>
            </div>
          </div>
        </section>
        <div id="theme-build-status" style="margin-bottom: 12px; font-style: italic; min-height: 20px; color: var(--vscode-descriptionForeground);"></div>
        <div id="theme-build-actions" hidden style="margin-bottom: 12px;">
          <button id="theme-review-images-btn" class="skill-btn">Review generated images</button>
        </div>
        <section id="theme-image-review" class="theme-image-review" hidden>
          <div class="theme-image-review-header">
            <div>
              <h3 id="theme-image-review-title">Generated images</h3>
              <div id="theme-image-review-summary" class="theme-image-review-summary"></div>
            </div>
            <div class="theme-image-review-header-actions">
              <button id="theme-review-resume-generation" class="skill-btn" hidden>Resume generation</button>
              <button id="theme-review-stop-generation" class="skill-btn" hidden>Stop generation</button>
              <button id="theme-approve-all" class="skill-btn">Approve all</button>
              <button id="theme-open-images-folder" class="skill-btn">Open folder</button>
              <button id="theme-health-check-btn" class="skill-btn">Check theme health</button>
            </div>
          </div>
          <div id="theme-health-results" class="theme-health-results" hidden></div>
          <div id="theme-image-review-list" class="theme-image-review-list"></div>
        </section>
        <div id="theme-builder-root"></div>
      </div>
      </div>
      <div id="themes-footer">
        <button id="themes-footer-close" class="skill-btn theme-footer-close">Close</button>
      </div>
    </div>
  </div>

  <div id="theme-image-lightbox" role="dialog" aria-modal="true" aria-labelledby="theme-image-lightbox-title" hidden>
    <div id="theme-image-lightbox-backdrop"></div>
    <div id="theme-image-lightbox-dialog">
      <div class="theme-image-lightbox-header">
        <h3 id="theme-image-lightbox-title">Full-size image</h3>
        <button id="theme-image-lightbox-close" aria-label="Close full-size image">&times;</button>
      </div>
      <div class="theme-image-lightbox-viewport">
        <img id="theme-image-lightbox-image" alt="" />
      </div>
    </div>
  </div>

  <script src="/media/main.js"></script>
  <script src="/media/theme-builder.js"></script>
</body>
</html>`;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = buildHostHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/media/')) {
    serveMediaFile(pathname.slice('/media/'.length), res);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/theme-images/')) {
    const rest = pathname.slice('/theme-images/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex === -1) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const themeId = decodeURIComponent(rest.slice(0, slashIndex));
    const filename = rest.slice(slashIndex + 1);
    serveThemeImageFile(themeId, filename, res);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/theme-export/')) {
    const themeId = decodeURIComponent(pathname.slice('/theme-export/'.length));
    serveThemeExport(themeId, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/theme-import') {
    handleThemeImport(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    // Catch this ONE new client up on current state (see
    // registerInitialMessageProvider doc comment above) before any live
    // broadcast() traffic arrives.
    for (const provider of initialMessageProviders) {
      let messages;
      try {
        messages = provider();
      } catch (err) {
        console.error('[tycoonagents-standalone] initial message provider failed:', err);
        continue;
      }
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        if (msg && typeof msg.eventName === 'string') {
          writeSseEvent(res, msg.eventName, msg.data);
        }
      }
    }
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/message') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
        return;
      }
      handleBrowserMessage(parsed);
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function createStandaloneServer() {
  return http.createServer(requestListener);
}

// ── Project target resolution (p3-t1) ───────────────────────────────────────
// Replaces vscode.workspace.workspaceFolders: the standalone host is told
// EXPLICITLY which project dir(s) to watch, via (in this precedence order)
// CLI positional args, then TYCOON_STANDALONE_PROJECT_ROOT (comma-separated
// for multiple), then a default. See projectRoots.mjs for the full
// rationale and the pure resolveProjectRoots() this delegates to.

// ── App data + theme image config (pA-t3) ───────────────────────────────────
// Wires appData.mjs (previously unwired — see its module header) into the
// server: resolves the OS-appropriate persistent app-data directory
// (honoring TYCOON_STANDALONE_DATA_DIR) and derives a `themes/` subdirectory
// under it — the root a LATER task's theme storage adapter will read/write
// generated theme manifests/images from/to. This task only resolves and
// exposes that path (via startServer()'s returned `appData`/`themeDataDir`);
// it does not create any theme files itself.
//
// getThemeImageConfig() is the standalone analog of the VS Code extension's
// resolveThemeImageSettings()/getThemeImageConfigurationStatus() (see
// src/extension/themeImageSettings.ts) and matches
// src/extension/imageClient.ts's ThemeImageConfig shape EXACTLY —
// { provider?: 'openai' | 'gemini', openaiApiKey?: string, geminiApiKey?: string }
// — so a later task can pass this straight into generateThemeImage()'s
// `config` parameter unchanged. The extension stores its provider/keys in
// vscode.SecretStorage (OS keychain); the standalone has no keychain, so
// this reads plain environment variables instead (documented as a security
// step-down in README.md). Only the PROVIDER selection may optionally be
// persisted via appData (never the API keys themselves — keys stay
// env-only, never written to disk here) so a user's provider choice
// survives a restart even without re-exporting the env var; an explicit env
// var always wins over any persisted value.
const THEME_IMAGE_PROVIDER_FILE = 'themeImageProvider.json';

function normalizeThemeImageProvider(value) {
  // Mirrors src/extension/themeImageSettings.ts's normalizeThemeImageProvider
  // exactly: only the literal 'gemini' selects Gemini, everything else
  // (including undefined/unset) defaults to 'openai'.
  return value === 'gemini' ? 'gemini' : 'openai';
}

/**
 * Resolves the standalone's theme image provider/API-key config from
 * environment variables (optionally falling back to an appData-persisted
 * provider choice). Env vars always take precedence.
 *
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env] defaults to
 *   `process.env`.
 * @param {{ readJson: (name: string, fallback?: unknown) => unknown }} [opts.appData]
 *   optional — when provided, a persisted `{ provider }` is consulted as the
 *   fallback when `TYCOON_THEME_IMAGE_PROVIDER` is unset.
 * @returns {{ provider: 'openai' | 'gemini', openaiApiKey?: string, geminiApiKey?: string }}
 */
export function getThemeImageConfig({ env = process.env, appData } = {}) {
  let persistedProvider;
  if (appData && typeof appData.readJson === 'function') {
    const stored = appData.readJson(THEME_IMAGE_PROVIDER_FILE, null);
    if (stored && typeof stored.provider === 'string') {
      persistedProvider = stored.provider;
    }
  }

  const envProvider =
    typeof env.TYCOON_THEME_IMAGE_PROVIDER === 'string' && env.TYCOON_THEME_IMAGE_PROVIDER.trim() !== ''
      ? env.TYCOON_THEME_IMAGE_PROVIDER.trim()
      : undefined;

  /** @type {{ provider: 'openai' | 'gemini', openaiApiKey?: string, geminiApiKey?: string }} */
  const config = { provider: normalizeThemeImageProvider(envProvider ?? persistedProvider) };

  if (typeof env.TYCOON_OPENAI_API_KEY === 'string' && env.TYCOON_OPENAI_API_KEY.trim() !== '') {
    config.openaiApiKey = env.TYCOON_OPENAI_API_KEY.trim();
  }
  if (typeof env.TYCOON_GEMINI_API_KEY === 'string' && env.TYCOON_GEMINI_API_KEY.trim() !== '') {
    config.geminiApiKey = env.TYCOON_GEMINI_API_KEY.trim();
  }
  return config;
}

/** Thrown when the server cannot bind its port (e.g. EADDRINUSE). Callers
 * should print `.message` and exit non-zero — never let this surface as a
 * raw Node stack trace. */
export class ServerStartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServerStartError';
  }
}

// ── startServer(): the CLI-drivable seam (p4-t1) ────────────────────────────
// Everything main() used to do inline (resolve targets -> create the http
// server -> wire the primary/secondary stateFeeds -> listen), refactored
// into an async function that RETURNS a handle instead of calling
// process.exit()/installing its own signal handlers. main() below is now a
// thin wrapper around it (identical `npm start` behavior: cwd defaults to
// REPO_ROOT, same console output, same print-and-exit(1) on a bad project
// dir). standalone/src/cli.mjs's `watch` command uses this exact same
// function — no reimplementation of main()'s wiring — with ONE required
// difference: it MUST pass `cwd: process.cwd()` (the user's real shell cwd),
// never REPO_ROOT, so a relative `watch ./myproject` resolves against the
// user's actual directory rather than this repo checkout (the p3-t1 review
// footgun this task was flagged to fix).
//
// `cwd` has NO default here (unlike the old resolveTargets(), which
// hardcoded REPO_ROOT) — every caller must be explicit about which cwd this
// call's relative-path resolution and cwd-tier default should use. This
// module's own main() passes REPO_ROOT; cli.mjs's watch command passes
// process.cwd().
/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv] positional project-dir args forwarded to
 *   resolveProjectRoots(). Defaults to `process.argv.slice(2)`.
 * @param {Record<string, string | undefined>} [opts.env] defaults to
 *   `process.env`; forwarded to resolveProjectRoots() and consulted for
 *   TYCOON_STANDALONE_PORT / TYCOON_STANDALONE_HOST, and (pA-t3) for the
 *   appData dir override (TYCOON_STANDALONE_DATA_DIR, via appData.mjs) and
 *   theme image provider/keys (TYCOON_THEME_IMAGE_PROVIDER,
 *   TYCOON_OPENAI_API_KEY, TYCOON_GEMINI_API_KEY, via getThemeImageConfig()).
 * @param {string} opts.cwd base for relative-path resolution and the
 *   cwd-tier default target (see resolveProjectRoots()). Required — callers
 *   must be explicit (see module header above).
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   url: string,
 *   port: number,
 *   host: string,
 *   primary: object,
 *   secondary: object[],
 *   close: () => Promise<void>,
 *   appData: ReturnType<typeof createDefaultAppData>,
 *   themeDataDir: string,
 *   getThemeImageConfig: () => ReturnType<typeof getThemeImageConfig>,
 * }>}
 * @throws {ProjectRootError} on a missing/invalid project directory (see
 *   resolveProjectRoots()) — thrown synchronously but this is an async
 *   function, so callers see it as a rejection.
 * @throws {ServerStartError} if the requested port is already in use.
 */
export async function startServer({
  argv = process.argv.slice(2),
  env = process.env,
  cwd,
  port = env.TYCOON_STANDALONE_PORT ? Number(env.TYCOON_STANDALONE_PORT) : PORT,
  host = env.TYCOON_STANDALONE_HOST || HOST,
} = {}) {
  const { roots } = resolveProjectRoots({ argv, env, cwd });
  const [primary, ...secondary] = roots;

  // Set here (not just captured in the closure below) so a fresh
  // startServer() call (e.g. a test harness spinning up multiple server
  // instances in the same process) always points RESTORE_PLAN_BACKUP at the
  // CURRENT call's primary root, never a stale prior instance's — same
  // posture as themeStore/themeImagesRootDir below.
  primaryProjectRoot = primary.root;

  const server = createStandaloneServer();

  // App data + theme config (pA-t3) — see the section comment above
  // getThemeImageConfig() for the full contract. Resolved from the SAME
  // `env` this call already threads through (not raw process.env), so tests
  // that pass a fake env (TYCOON_STANDALONE_DATA_DIR, TYCOON_OPENAI_API_KEY,
  // etc.) get an isolated, deterministic app-data dir and config.
  const appData = createDefaultAppData({ env });
  const themeDataDir = path.join(appData.dir, 'themes');
  console.log(`[tycoonagents-standalone] app data dir: ${appData.dir}`);
  console.log(`[tycoonagents-standalone] theme data dir: ${themeDataDir}`);

  // Theme file store (pB-t1) — CRITICAL: rooted at appData.dir, NOT
  // themeDataDir. themeImagesDirectoryPath()/themeManifestPath()/etc. (see
  // themeFileStoreFs.mjs, re-exported from the compiled
  // out/src/extension/themeFileStore.js) already return paths PREFIXED with
  // 'themes/' — rooting the store at themeDataDir (which is itself
  // `${appData.dir}/themes`) would double-nest every theme under
  // themes/themes/<id>/... This module-level `themeStore` var is what
  // handleBrowserMessage() (LIST_THEMES/SELECT_THEME/DELETE_THEME/
  // GET_THEME_IMAGE_REVIEW dispatch) and serveThemeImageFile() (the
  // /theme-images/<id>/<file> static route) both read from — set here so a
  // later startServer() call (e.g. in tests) always points both at the
  // CURRENT call's appData.dir, never a stale prior instance's.
  themeStore = createFsThemeFileStore(appData.dir);
  themeImagesRootDir = appData.dir;
  themeImageConfigGetter = () => getThemeImageConfig({ env, appData });

  // Theme GENERATION bridge wiring (pC-t1 step 2) — configure the REAL
  // themeService.ts generation pipeline (out/src/extension/themeService.js,
  // required lazily by themeGenerationBridge.mjs) to resolve ITS
  // ThemeFileStore to this exact fs-backed `themeStore` instance, so
  // planTheme/generateTheme/retryThemeImage/resliceThemeImageFromRaw/
  // normalizeThemeCharacterAtlas below all read/write the same on-disk
  // layout LIST_THEMES/SELECT_THEME/etc. above already use. Called on every
  // startServer() call (not just once per process) so a second call in the
  // same process — e.g. a test harness spinning up multiple server
  // instances — always points generation at the CURRENT call's store, never
  // a stale prior instance's (same posture as themeStore/themeImagesRootDir
  // above).
  configureThemeFileStore(themeStore);

  // MULTI-DIR SEMANTICS (documented per task brief — do not silently mix
  // projects' sessions into one board): the FIRST resolved target is the
  // PRIMARY root. It alone drives the rendered state board — its stateFeed
  // is wired to broadcast() (SSE -> every connected browser tab) and to
  // registerInitialMessageProvider (late-connecting tab catch-up). Any
  // additional targets are still watched CONCURRENTLY (their stateFeed is
  // created for real, so a bad additional path would still surface via
  // activityWatcher's onError, and file handles/timers are real and are
  // closed cleanly on shutdown) but their computed state is intentionally
  // NOT broadcast to the board — only logged — so multiple projects' agent
  // sessions never get merged into a single, misleading metrics table. A
  // future task could add a project switcher / aggregated view; until then
  // this is the simplest choice that cannot silently corrupt what the board
  // shows.
  const stateFeed = createStateFeed({ projectRoot: primary.root, broadcast });
  const unregisterInitialMessage = registerInitialMessageProvider(() => {
    const msg = stateFeed.getStateMessage();
    return [{ eventName: 'message', data: msg }];
  });

  const secondaryFeeds = secondary.map((target) =>
    createStateFeed({
      projectRoot: target.root,
      broadcast: (eventName, data) => {
        // Intentionally NOT forwarded to the SSE board — see the
        // MULTI-DIR SEMANTICS comment above. Logged only, so this
        // additional watch is still observably alive/working.
        console.log(`[tycoonagents-standalone] (secondary: ${target.root}) ${eventName}`, JSON.stringify(data));
      },
    }),
  );

  // Port-in-use (and any other bind error) must surface as a clean,
  // catchable ServerStartError — never an unhandled EADDRINUSE stack trace
  // (task requirement). 'error' is attached before 'listening'/listen() so a
  // synchronous-ish bind failure can't race past it.
  await new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new ServerStartError(
            `TycoonAgents standalone: port ${port} is already in use on ${host}. Set TYCOON_STANDALONE_PORT to ` +
              `a different port, or stop whatever else is using it.`,
          ),
        );
        return;
      }
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  // Real bound port (server.address().port resolves the OS-assigned port
  // when `port` was 0 — used by tests for an ephemeral, collision-free bind;
  // otherwise identical to the requested `port`).
  const boundPort = server.address().port;
  const url = `http://${host}:${boundPort}`;

  console.log(`[tycoonagents-standalone] serving on ${url}`);
  console.log(`[tycoonagents-standalone] media dir (in place): ${MEDIA_DIR}`);
  console.log(`[tycoonagents-standalone] watching project (primary, drives the board): ${primary.root}`);
  for (const target of secondary) {
    console.log(`[tycoonagents-standalone] watching project (secondary, not shown on board): ${target.root}`);
  }

  let closed = false;
  // Clean shutdown (task requirement): closes every project's
  // activity.jsonl watcher (interval + fs.watch handle — already .unref()'d,
  // but closing explicitly is cleaner on an intentional stop), unregisters
  // this instance's initial-message provider (so a second startServer() call
  // in the same process, e.g. in tests, never leaks a stale provider that
  // would double-catch-up a later /events client), then forcibly terminates
  // any open SSE/keep-alive sockets — http.Server#close() alone only stops
  // ACCEPTING new connections and waits indefinitely for existing ones to
  // end, which would hang forever with a live SSE tab still connected.
  // res.end() first for a graceful SSE close, then
  // server.closeAllConnections() (Node >=18.2) as the belt-and-braces
  // guarantee that server.close()'s callback actually fires.
  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    stateFeed.close();
    for (const feed of secondaryFeeds) feed.close();
    unregisterInitialMessage();
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    server,
    url,
    port: boundPort,
    host,
    primary,
    secondary,
    close,
    appData,
    themeDataDir,
    getThemeImageConfig: () => getThemeImageConfig({ env, appData }),
  };
}

function main() {
  // `npm start` dogfood behavior, UNCHANGED from before this task: cwd
  // defaults to REPO_ROOT (not the shell's literal process.cwd(), which for
  // `npm start` is always standalone/ — see startServer()'s module header
  // above for the full rationale). No browser auto-open here; that is a
  // `watch`-CLI-only behavior (see cli.mjs) so `npm start` dogfooding never
  // unexpectedly pops a browser window.
  startServer({ cwd: REPO_ROOT })
    .then((runtime) => {
      const shutdown = () => {
        runtime.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      if (err instanceof ProjectRootError || err instanceof ServerStartError) {
        console.error(err.message);
        process.exit(1);
        return;
      }
      throw err;
    });
}

// Only auto-start when run directly (`node src/server.mjs`), not when
// imported (e.g. by a future test harness). Compared via pathToFileURL (not
// a raw `file://${argv[1]}` template) so this works on Windows, where
// argv[1] is a drive-letter path (`D:\...`) that doesn't already look like
// a file URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
