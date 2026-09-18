# Building from source

Instructions for building TycoonAgents from source, used when registering the OpenCode plugin or developing the extension itself. End users installing the shipped VSIX don't need this.

1. **Build** — from the repo root:

  ```sh
  npm install && npm run build
  ```

  This compiles the TypeScript sources and copies the hook runtime files the OpenCode plugin needs.

2. **Select the provider** — VS Code setting `tycoonagents.provider: "opencode"`, or the `TYCOON_PROVIDER=opencode` environment variable (which always overrides the setting), or `--provider opencode` in the standalone host.
3. **Generate the roster** — `npm run opencode:config` writes an OpenCode-flavored agent config from the same specialist roster the VS Code extension seeds.
4. **Register the plugin** — copy `hooks/tycoon-opencode-plugin.ts`, `hooks/agentBackend.js`, `hooks/modelAliases.js`, `hooks/delegationEnforcement.js`, and `hooks/fallbackChain.js` into your project's `.opencode/plugin/` directory (OpenCode loads `.ts` plugins from there); the standalone host can do this for you — see [`standalone/README.md`](../standalone/README.md#opencode-plugin-registration).
5. **Run a session** in OpenCode as usual — the plugin appends hook records to the same activity log the Claude Code hook writes to. On a headless or remote machine, set `TYCOON_STANDALONE_NO_OPEN=1` so the standalone does not try to launch a browser.
6. **What the panel shows** — the same live agent visualization and metrics, sourced from OpenCode's events instead of Claude Code's.

See [`OPENCODE-PROVIDER.md`](OPENCODE-PROVIDER.md) for the full IPC contract and mapping details.

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
