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

**atlas_asset ref format:** Each `AgentConfig.atlas_asset` and `RivalConfig.atlas_asset` in the manifest is a ref string of the form `<theme_id>_frames.json#<key>`. To resolve: split on `#`, use the right-hand side as the key into `frames`. For example, `gi_joe_cobra_frames.json#agent_0` → `frames["agent_0"]` (20 data-URIs, one per animation frame).

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
| `GENERATE_THEME` | `{ prompt: string }` | Start AI generation of a new theme from a text prompt. |
| `SELECT_THEME` | `{ theme_id: string }` | Load and activate a previously generated theme by ID. |

### Outbound Messages (Host → Webview)

| type | payload | description |
|------|---------|-------------|
| `THEMES_LIST` | `{ themes: Array<{ theme_id: string; display_name: string }> }` | Response to `LIST_THEMES`. |
| `THEME_GENERATION_PROGRESS` | `{ message: string }` | Streamed progress updates during `GENERATE_THEME`. |
| `THEME_GENERATION_ERROR` | `{ message: string }` | Error from `GENERATE_THEME` or `SELECT_THEME` (theme not found). |
| `THEME_INITIALIZED` | `{ manifest: ThemeManifest; frames: Record<string, string[]>; is_editor_mode: boolean }` | Sent to both `TycoonPanel` webview (via panel.ts handlers) and `TheaterView` webview (via main.ts `broadcastTheme`). `is_editor_mode: true` = freshly generated; `false` = loaded/restored. |
