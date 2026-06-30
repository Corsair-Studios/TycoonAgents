# TycoonAgents Host → Webview IPC Contract (Proposed)

This document is the coordination point between the extension host team and the webview team for the THEME_INITIALIZED handoff message. The host-side emit is currently DEFERRED (see main.ts) pending agreement on this schema.

---

## Messages: Host → Webview

### THEME_INITIALIZED

Sent once after a full theme generation run completes.

```json
{
  "type": "THEME_INITIALIZED",
  "payload": {
    "manifest": { },
    "frames": {
      "agent_0":  ["data:image/png;base64,..."],
      "agent_1":  ["data:image/png;base64,..."],
      "rival_rival_0": ["data:image/png;base64,..."],
      "environment_background": ["data:image/png;base64,..."]
    },
    "is_editor_mode": false
  }
}
```

**frames key conventions:**
- `agent_<slot_id>` — 20-frame animation atlas for the agent at that roster slot (e.g. `agent_0`, `agent_15`).
- `rival_<rival_id>` — 20-frame animation atlas for a rival (e.g. `rival_rival_0`).
- `environment_background` — single background image (array with 1 entry).

- `object_<object_id>` — one completed sprite sliced from the 12-object board.
- `expression_<0..15>` — one icon sliced from the 16-expression board. The first four are also aliased to the legacy `emote_smile`, `emote_sleep`, `emote_idea`, and `emote_team` renderer keys.
- `achievement_<0..19>` — one icon sliced from the 20-badge board; achievement rules are intentionally deferred.

**atlas_asset ref format:** Each `AgentConfig.atlas_asset` and `RivalConfig.atlas_asset` in a current manifest uses `frames.json#<key>`. To resolve it, split on `#` and use the right-hand side as the key into `frames`. Legacy `<theme_id>_frames.json#<key>` references remain readable.

---

### WORLD_TELEMETRY_UPDATE

Already implemented host-side in `src/extension/main.ts` via `sendTelemetryUpdate`.

```json
{
  "type": "WORLD_TELEMETRY_UPDATE",
  "payload": { }
}
```

---

## Open Questions (for webview team)

1. The webview currently has NO inbound listener and renders placeholder rectangles. This document is the proposal for the receiver.
2. Should `is_editor_mode` be a top-level flag or nested under manifest?
3. Are 20 data-URIs per character acceptable for the webview memory budget, or should only the first frame be sent initially with lazy loading for the rest?
4. Should `THEME_INITIALIZED` be re-sent on webview panel reload, or should the webview request it via an outbound `THEME_REQUEST` message?

---

## Status (2026-06-26)

- **Host broadcast is LIVE.** `THEME_INITIALIZED` is now emitted on generation completion (`is_editor_mode: true`) and on view-resolve re-hydration (`is_editor_mode: false`).
- **Rival key fixed.** Rival frames map keys are now `<rival_id>` (e.g. `rival_0`) — no double-prefix. The `atlas_asset` ref suffix and the frames key are identical.
- **Follow-up for webview team:** The boot `THEME_REQUEST` is sent via `window.parent.postMessage`, which does NOT reach the VS Code extension host. Switching to `acquireVsCodeApi().postMessage` would make reload re-hydration deterministic rather than best-effort.

---

## Themes Menu IPC (added 2026-06-26)

### Inbound Messages (Webview → Host)

| type | payload | description |
|------|---------|-------------|
| `LIST_THEMES` | _(none)_ | Request the list of saved themes from global storage. |
| `EXPORT_THEME` | `{ theme_id: string }` | Open a save dialog and package the theme folder as a portable `.zip` archive. |
| `IMPORT_THEME` | _(none)_ | Open a file dialog, validate a theme `.zip`, and install it. A matching theme ID requires native replacement confirmation. |
| `DELETE_THEME` | `{ theme_id: string }` | Permanently remove a saved theme and its retained source images. |
| `GET_THEME_IMAGE_SETTINGS` | _(none)_ | Request the selected image provider and per-provider configured status. Secrets are never returned. |
| `SAVE_THEME_IMAGE_SETTINGS` | `{ provider: "gemini" | "openai", api_key?: string }` | Select the provider and optionally save its key in VS Code Secret Storage. |
| `PLAN_THEME` | `{ prompt: string, image_provider: "gemini" | "openai" }` | Ask AI to prefill the editable theme plan: name, creative direction, 16 characters, environment, 12 objects, 3 enemies, 16 expressions, and 20 achievement badges. |
| `GENERATE_THEME` | `{ plan?: ThemePlan, resume_theme_id?: string, image_provider: "gemini" | "openai", pause_for_review: boolean }` | Generate 23 reviewable images from a new `plan`, or resume an interrupted `resume_theme_id`. Resume checkpoints retained images plus saved frames and generates only unfinished items. When `pause_for_review` is true (the UI default), newly generated images pause for approval; otherwise generation continues automatically. |
| `SET_THEME_PAUSE_FOR_REVIEW` | `{ pause_for_review: boolean }` | Change approval-pausing behavior during generation. Turning it off releases the current review gate after any in-flight retry completes; turning it on pauses after the next completed image. |
| `CANCEL_THEME_GENERATION` | _(none)_ | Abort the active provider request and stop generating additional theme images. Completed images are retained. |
| `SELECT_THEME` | `{ theme_id: string }` | Load and activate a previously generated theme by ID. |
| `OPEN_THEME_IMAGES` | `{ theme_id: string }` | Open the theme's folder of generated images for visual review. For legacy themes without retained originals, reconstruct review atlases from the saved frame sidecar. |
| `GET_THEME_IMAGE_REVIEW` | `{ theme_id: string }` | Load the inline review list and persisted decision state for every generated image. |
| `SET_THEME_IMAGE_REVIEW_STATUS` | `{ theme_id: string, item_id: string, status: "pending" | "accepted" | "rejected" }` | Persist a review decision. |
| `APPROVE_ALL_THEME_IMAGES` | `{ theme_id: string }` | Mark every generated review image accepted in one operation. Rejected while generation is active or any image is missing. |
| `RENAME_THEME_CHARACTER` | `{ theme_id: string, item_id: string, name: string }` | Rename an agent or rival from image review. Updates the plan, manifest, review metadata, and saved generation prompt without changing stable frame keys. During active generation, only the character currently awaiting review can be renamed. |
| `NORMALIZE_THEME_CHARACTER` | `{ theme_id: string, item_id: string, image_provider: "gemini" | "openai" }` | Regenerate a character board on a provider-enforced 1:1 canvas, retain it as an exact 512×512 PNG, then fit its square frames to the shared production scale. The replacement returns to pending review. During active generation, only the character currently awaiting review can be normalized. |
| `RETRY_THEME_IMAGE` | `{ theme_id: string, item_id: string, feedback?: string, mode: "augment" | "replace" | "retry", image_provider: "gemini" | "openai", character_name?: string }` | Generate or regenerate one image and update the corresponding saved frame keys. `retry` reuses the saved prompt verbatim and requires no feedback. This also recovers an unfinished item with no image after a run stops. During an active run, only the exact item waiting at the review gate is eligible. Character retries may rename the character in the same action. |

### Outbound Messages (Host → Webview)

| type | payload | description |
|------|---------|-------------|
| `THEMES_LIST` | `{ themes: Array<{ theme_id: string; display_name: string; total: number; accepted: number; export_ready: boolean; size_bytes: number }>, deleted_theme_id?: string, delete_error?: string }` | Response to list/delete requests. Approval metadata controls export availability; `size_bytes` includes the theme directory and legacy sidecars. |
| `THEME_EXPORT_RESULT` | `{ theme_id: string, display_name?: string, cancelled?: boolean, error?: string }` | Completion state for a theme export dialog/write. |
| `THEME_IMPORT_RESULT` | `{ theme_id?: string, display_name?: string, replaced?: boolean, cancelled?: boolean, error?: string }` | Completion state for a validated theme import. |
| `THEME_APPROVE_ALL_RESULT` | `{ theme_id: string, error: string }` | Reports an approve-all failure. Success is reflected by refreshed review and theme-list messages. |
| `THEME_IMAGE_SETTINGS` | `{ provider: "gemini" | "openai", providers: { gemini: { configured: boolean }, openai: { configured: boolean } }, saved?: boolean, error?: string }` | Image-provider state; never contains API-key contents. |
| `THEME_PLAN_READY` | `{ plan: ThemePlan }` | Complete AI-prefilled plan for user editing before generation. |
| `THEME_PLAN_ERROR` | `{ message: string }` | Planning request failure. |
| `THEME_GENERATION_PROGRESS` | `{ message: string }` | Streamed progress updates during `GENERATE_THEME`. |
| `THEME_GENERATION_CANCELLED` | `{ theme_id?: string, message: string }` | Confirms generation stopped; `theme_id` identifies the partial, reviewable theme when initialization had completed. |
| `THEME_REVIEW_READY` | `{ theme_id: string }` | Sent once the review folder exists, before image generation finishes. |
| `THEME_IMAGE_REVIEW` | `{ theme_id, display_name, generation_active, pause_for_review, waiting_for_review_item_id?, items: Array<{ id, filename, label, subject?, kind, status, prompt, revision, generated, image_src, generation_error? }> }` | Current inline review list. `generated` confirms both the retained image and its saved frame data exist, and controls interrupted-run resume availability. `subject` is the editable character name for character atlases. `waiting_for_review_item_id` identifies the image that must be kept before generation continues. `image_src` is a webview-safe URI. `generation_error` contains a safe user-facing message plus optional provider code, request ID, moderation stage, and coarse categories; blocked items can be revised and retried before an image exists. |
| `THEME_IMAGE_RETRY_STATE` | `{ item_id: string, busy?: boolean, message?: string, error?: string }` | Progress or failure state for a single-image retry. |
| `THEME_CHARACTER_RENAME_STATE` | `{ item_id: string, busy?: boolean, message?: string, error?: string }` | Progress or failure state while saving an edited character name. |
| `THEME_CHARACTER_NORMALIZE_STATE` | `{ item_id: string, busy?: boolean, message?: string, error?: string }` | Progress or failure state while rebuilding a retained character board at the production scale. |
| `THEME_GENERATION_ERROR` | `{ message: string }` | Error from `GENERATE_THEME` or `SELECT_THEME` (theme not found). |
| `THEME_INITIALIZED` | `{ manifest: ThemeManifest; frames: Record<string, string[]>; is_editor_mode: boolean }` | Sent to both `TycoonPanel` webview (via panel.ts handlers) and `TheaterView` webview (via main.ts `broadcastTheme`). `is_editor_mode: true` = freshly generated; `false` = loaded/restored. |

## Theme Storage Layout

New themes are stored in the user's local TycoonAgents extension data directory:

```text
themes/
  <theme_id>/
    plan.json
    manifest.json
    frames.json
    review.json
    images/
      agent_01_<name>.png ... agent_16_<name>.png
      enemy_01_<name>.png ... enemy_03_<name>.png
      environment.png
      objects.png
      expressions.png
      achievements.png
```

Flat-storage themes made by older releases remain readable.
