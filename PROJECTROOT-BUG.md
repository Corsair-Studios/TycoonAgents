# Bug: `_projectRoot()` trusts CLAUDE_PROJECT_DIR over the open workspace → cross-project data bleed

## Severity
High — defeats the per-project scoping added in 0.0.240 and causes one project's
activity/badges/builds/settings to appear in every other project.

## Symptom
The panel in Project A (e.g. `D:\Vignetta App`) shows badges/built objects and
metrics that actually belong to Project B (`D:\ACode\TycoonAgents`, the plugin's
own source dir). Reinstalling the extension, reloading, and full-restarting VS
Code do not clear it. The counts persist because they are re-derived on every
load from the WRONG project's `.claude/tycoon/activity.jsonl`.

## Root cause
`src/host/vscode/panel.ts` → `_projectRoot()` (~L2887):

    private _projectRoot(): string {
      return (
        process.env["CLAUDE_PROJECT_DIR"] ??               // ← wrong priority
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        ""
      );
    }

`CLAUDE_PROJECT_DIR` is a PROCESS-WIDE environment variable inherited by the VS
Code / extension-host process from whatever shell or Claude Code session launched
it. It is global to the process, not per-window, so it cannot represent "which
workspace this panel belongs to." When VS Code (or the F5 Extension Development
Host) is launched from the plugin's source dir, that path leaks into EVERY
window's `_projectRoot()`.

Because every `.claude/tycoon/*` path derives from this one method, the leak is
total:
- activity log read + truncated in `_handleResetMetrics()` (~L3615)
- `execution.json` / `plan.json` path helpers (~L136-140)
- **`projectScopeKey(this._projectRoot())`** (~L1539) — the per-project scope
  key introduced in 0.0.240 is computed from the wrong root, so the scoping fix
  is nullified at its source: everything is keyed under the source dir.

## Evidence observed
- `D:\ACode\TycoonAgents\.claude\tycoon\activity.jsonl` = 18,509 lines / ~1,582
  completion events -> replayed as the "20 badges" + built objects.
- The intended project `D:\Vignetta App\.claude\tycoon\activity.jsonl` = 136
  lines / ~14 completions, and had NO tycoon workspace state of its own.
- The webview state (`tycoon.theaterView`) + all activity resolved to the
  `D:\ACode\TycoonAgents` workspace-storage, regardless of which project the
  user believed the panel represented.

## Fix
Prefer the open workspace; use the env var only as a fallback when no workspace
is open, and never let a non-matching env value override an open workspace.

Minimal:

    private _projectRoot(): string {
      return (
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        process.env["CLAUDE_PROJECT_DIR"] ??
        ""
      );
    }

Hardened (multi-root aware — honor the env var only if it IS one of the open
folders; otherwise ignore it as stale/inherited):

    private _projectRoot(): string {
      const folders = vscode.workspace.workspaceFolders;
      const primary = folders?.[0]?.uri.fsPath;
      if (primary) {
        const env = process.env["CLAUDE_PROJECT_DIR"];
        const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
        if (env && folders!.some(f => norm(f.uri.fsPath) === norm(env))) return env;
        return primary;
      }
      return process.env["CLAUDE_PROJECT_DIR"] ?? "";   // empty window fallback
    }

## Why the env var can't be the primary source
`CLAUDE_PROJECT_DIR` reflects the launching context of the whole process, not the
per-window workspace. Two windows in one VS Code instance share it. The workspace
folder is the only per-window source of truth for "which project is this panel."

## Verification
1. In the extension host: Help -> Toggle Developer Tools -> Console ->
   `process.env.CLAUDE_PROJECT_DIR` — confirm it points at the source dir on an
   affected machine.
2. After the fix: open Project A; confirm the panel reads/writes
   `A/.claude/tycoon/activity.jsonl` and shows A's counts; open Project B in a
   second window; confirm each window is independent.
3. Add a unit test for `_projectRoot()` precedence: workspace folder present +
   env var set to a different path => returns the workspace folder; no workspace
   + env set => returns env; env equal to an open folder => returns that folder.

## Note (not bugs — for support docs)
- Extensions install globally per VS Code install, not per project.
- Multiple version folders under `~/.vscode/extensions` are expected; VS Code
  marks superseded ones in `.obsolete` and prunes them on a full restart. Only
  the newest loads.
