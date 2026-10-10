# Building from source

Instructions for building TycoonAgents from source, used when developing the extension itself. End users installing the shipped VSIX don't need this.

1. **Build** — from the repo root:

  ```sh
  npm install && npm run build
  ```

  This compiles the TypeScript sources and copies the hook runtime files.

2. **Run a session** in Claude Code (or Codex (Experimental)) as usual — the hooks append records to the activity log the panel reads. On a headless or remote machine, set `TYCOON_STANDALONE_NO_OPEN=1` so the standalone does not try to launch a browser.

OpenCode support is coming soon; it is not selectable yet.

## Release checklist

Every GitHub Release must attach both artifacts, next to each other:

1. **VSIX** — `npm run package` writes `dist/tycoonagents-<version>.vsix`.
2. **Standalone zip** — `npm run package:standalone` writes
   `dist/tycoonagents-standalone-<version>.zip` (version read from the root
   `package.json`). It builds `out/` first, then bundles `out/`,
   `standalone/src`, `media/`, `hooks/`, a trimmed root `package.json`, and
   a generated `README-STANDALONE.md` — no `node_modules`, no dev tooling.
   See `scripts/package-standalone.mjs` for the exact file list.
3. Upload both files to the release (`gh release upload <tag> <file>...`)
   and include each file's sha256 and size in the release notes.
