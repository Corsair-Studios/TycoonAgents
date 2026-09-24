/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

/**
 * Review fix (replacing the per-panel-instance Set gate, which missed a
 * fresh first-time generation failure — no THEME_IMAGE_REVIEW is ever
 * posted before that failure, so its FIRST post already carried a live
 * error and the Set-based "first post == reload" heuristic wrongly dropped
 * it): one random id, generated once per extension-host activation, held in
 * memory only (never persisted, never sent to the webview on its own).
 *
 * Every transient error_kind persisted this run (recordUserCorrectableGenerationError
 * in themeService.ts, covering both a fresh generation failure and a retry
 * failure — both route through setThemeImageReviewErrorKind) is stamped
 * with this id as item.error_session. panel.ts's _postThemeImageReview then
 * drops a transient error_kind only when its error_session is MISSING or
 * differs from this run's id — i.e. it was persisted by an EARLIER process
 * (a genuine reload/restart), never because of which post number this is.
 * A restart re-imports this module fresh, so the id changes and every
 * previously-live transient error becomes "different session" and is
 * dropped, exactly like the reload behavior this replaces.
 */
import { randomUUID } from 'node:crypto';

export const THEME_SERVICE_HOST_SESSION_ID: string = randomUUID();
