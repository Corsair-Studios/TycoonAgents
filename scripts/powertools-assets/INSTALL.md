# Install

## System requirements

- **UEFN** (Unreal Editor for Fortnite) installed, with your project open.
- The **Python Editor Script Plugin** enabled in UEFN (`Edit -> Plugins`, search "Python Editor Script Plugin", enable it, restart UEFN if prompted).
- **Node.js 18+** on the machine running the MCP server.
- An MCP-capable client (e.g. Claude Code) to talk to the server.

Before you enable Python, read **Use at your own risk** in [README.md](README.md#use-at-your-own-risk) — Python is known to crash UEFN, including during project sync.

## 1. Install the Python bridge into your UEFN project

Copy the **contents** of this repo's `python/` folder into your UEFN project's `Content/Python/` directory.

`Content/Python` lives inside the folder that holds your project's `.uefnproject` file — that's your UEFN project root. If a `Python` folder doesn't already exist under `Content`, create it:

```
<your-uefn-project>/Content/Python/
```

After copying, `<your-uefn-project>/Content/Python/` should contain `init_unreal.py` directly — **not** a nested `Content/Python/python/init_unreal.py`. Copy the folder's contents, not the folder itself.

**Symptom of copying the folder instead of its contents:** no error, no console output — UEFN silently finds nothing and the tools never appear. **Check:** if `Content/Python/python/` exists on disk, your files are one level too deep; move everything up into `Content/Python/` directly.

- Start the Python bridge by opening UEFN's Python console once your project is open and running `import init_unreal` — see **Starting the bridge** below.
- If UEFN prompts you to enable the Python Editor Script Plugin, accept it and restart UEFN.
- Once the bridge is started, run `import pt` in the same console to open the Power Tools window.

### Starting the bridge

Open UEFN's Python console (Output Log panel → console dropdown → **Python**) and run:

```python
import init_unreal
```

That starts the bridge, launcher, and Tools-menu entries in one call. Follow it with `import pt` to open the Power Tools window.

**Symptom if you skip this step:** no Power Tools launcher window, no Tools-menu entries, and the MCP server reports the bridge unreachable.

Run `import init_unreal` once per UEFN session — after each restart of UEFN, repeat the step.

**If `import init_unreal` produces no output and nothing starts:** Python only runs a module's top-level code the *first* time it's imported in a session — once `init_unreal` is already in `sys.modules` (for example, from an earlier import that session), a repeat `import init_unreal` is a silent no-op: no output, no bridge, no error. To force it to actually run again, reload the module instead:

```python
import importlib, uefn_bridge
importlib.reload(uefn_bridge)
```

### "Rejected command.json with missing/mismatched session token"

**Known issue, not yet fixed.** If the Output Log shows `uefn_bridge: Bridge started.` twice in a row, followed by a rejection message like this, two bridge instances registered with two different session tokens and are now fighting over the same IPC files. **Fix:** restart UEFN to clear the duplicate registration — a full restart, not just re-running `import init_unreal` or reloading the module.

### A tool seems to be running an old version

UEFN can load Python from two places: your project's `Content/Python/` (where you just copied files) and an engine-side copy inside your Fortnite installation, at `FortniteGame/Content/Python/` under wherever your Epic Games Launcher installed Fortnite. That parent location varies by machine and by Launcher settings, so no single real path is given here.

`init_unreal.py` syncs the newest project copy over the engine copy automatically when the bridge starts, comparing the `BRIDGE_VERSION` stamp in `bridge_version.py`. If that stamp already matches on both sides, the sync can skip copying even when the file contents underneath differ — so the engine copy can end up running stale code behind a version number that looks current.

**Symptom:** a bug you know was fixed is still happening, or a feature you just added isn't there, even though the project copy on disk is correct.

**Check which version is loaded:** the Power Tools launcher window footer (`import pt`) shows the bridge version currently running.

**Manual fix:** copy this repo's `python/` files into the engine-side `FortniteGame/Content/Python/` directory as well as the project copy, delete any `__pycache__` folder in both locations, and restart UEFN.

## 2. Run the MCP server

If you downloaded a release, you already have everything you need: the zip includes `uefn-server.mjs` at its root, a self-contained bundle with no dependencies to install. Run it directly:

```bash
node uefn-server.mjs
```

Point your MCP client's configuration at that same `node uefn-server.mjs` command — see **Connecting an AI client** below.

**If you cloned the source repo instead** (to fork or modify Power Tools), run the TypeScript source directly instead of the bundled `.mjs`:

```bash
npm install
npm start
```

`npm start` runs `tsx uefn-server.ts`. Point your MCP client's configuration at that command (or at `npx tsx <path-to-your-clone>/uefn-server.ts`) instead of the `node uefn-server.mjs` form.

## 3. How it connects

The MCP server and the in-UEFN Python bridge communicate through file-based IPC in the OS temp directory — no network port, no additional UEFN plugin. Keep UEFN open with your project loaded whenever you want live queries or edits to reach the editor; if UEFN isn't running (or the bridge hasn't started), the MCP server will report the bridge as unreachable.

**"Connected" in your MCP client is not proof the bridge is running.** A client-side "Connected" status only means the client successfully launched `node uefn-server.mjs` — it says nothing about whether the Python bridge inside UEFN has started. You can see a client report the server as connected while the Power Tools panel shows "Bridge disconnected" and no heartbeat file exists at all. The only trustworthy check is calling the `uefn_status` tool from your client, or reading the bridge state directly in the Power Tools launcher window (`import pt`) — trust those over the client's own connection indicator.

## 4. Connecting an AI client

The MCP server (`uefn-server.mjs`) speaks plain stdio MCP, so any MCP-capable client can launch it the same way: a `command` plus `args` that run the server, with an optional `env` block for the [environment overrides](#environment-overrides) below. Each client stores that config in its own file, using its own key name, and each client resolves that file from a different location — the subsections below give a complete, standalone, step-by-step walkthrough for each one. Pick the section for the client you're using and follow it top to bottom; you should not need to read any other client's section.

**Before you start any of these, know your server path.** Wherever you unzipped the Power Tools release is where `uefn-server.mjs` lives. That location must be **permanent** — not your Downloads folder, not a temp folder, not a location you plan to delete or move later — because every config below hard-codes a path to that file. If you move the unzipped folder after configuring a client, that client's config breaks until you update the path. In every example below, replace the placeholder path `D:/ACode/PowerToolsLocation/uefn-server.mjs` with the real, full path to your own `uefn-server.mjs`, using forward slashes (`/`) even on Windows — Node accepts forward slashes in paths, and using them avoids backslash-escaping mistakes in JSON and TOML files (double backslashes, `\\`, are easy to get wrong and are a real source of broken configs).

**If you cloned the source repo instead** of downloading a release, and are running the TypeScript source directly (`npm start`), swap the `"command"`/`"args"` pair in every example below for:

```json
"command": "npx",
"args": ["tsx", "D:/ACode/trashbyrds-power-tools/uefn-server.ts"]
```

(again, replace that path with your own clone's location).

If you're using the in-UEFN launcher window (`import pt` → MCP Bridge info), its **Copy config for selected client** button fills in the real, discovered path and command for your install automatically — you don't need to hand-edit the placeholder paths below if you use that button. The walkthroughs below assume you're editing the config file by hand.

**Officially supported clients: Claude Code, Codex CLI, and Gemini CLI.** These three have been verified end to end on a real machine, including a live round trip to a running UEFN project, and each gets a full standalone walkthrough below. If you work inside VS Code or Antigravity IDE, note that those are editors, not MCP clients themselves — see **Other MCP clients (community / untested)** below for what that means for you. Every other client (Cursor, Windsurf, and anything else not listed) is community/untested and is covered together in that same section.

**A client reporting the server "Connected" is not proof anything is working.** This is repeated in every section below because it is the single most common point of confusion: a "Connected" status in your AI client only means the client successfully launched `node uefn-server.mjs` as a child process. It says nothing about whether the Python bridge inside UEFN has started. You can have a fully "Connected" client, call a tool, and have it fail — because UEFN was never told to start the bridge. The only real proof that everything is working end to end is calling the `uefn_status` tool from inside your client and getting back a real level name and actor count, as described in each section's verification step.

### Claude Code

This is the **verified** integration — confirmed working end to end on a real machine, including a live round trip to a running UEFN project.

**1. Which file, and where.** Claude Code reads its MCP configuration from a file named `.mcp.json`. This file is **project-local**, not global — Claude Code looks for it in the directory you launch Claude Code from, not in your home folder. You must place it at the root of your UEFN project: the same folder that directly contains your project's `.uefnproject` file (the same folder where you created `Content/Python/` in step 1 above).

**2. Create the directory first?** No new directory is needed — `.mcp.json` is a single file that goes directly in your UEFN project root, alongside (not inside) the `Content` folder.

**3. Full file content.** Create a file named exactly `.mcp.json` (note the leading dot, and no other file extension) in your UEFN project root, with this complete content:

```json
{
  "mcpServers": {
    "uefn": {
      "command": "node",
      "args": ["D:/ACode/PowerToolsLocation/uefn-server.mjs"],
      "env": {
        "UEFN_BRIDGE_DIR": "D:/ACode/PowerToolsLocation/bridge-dir"
      }
    }
  }
}
```

Replace `D:/ACode/PowerToolsLocation/uefn-server.mjs` with the real, full path to your own unzipped `uefn-server.mjs`. The `env` block is **optional** — if you don't need a non-default bridge directory, delete the entire `"env": { ... }` block (including its comma on the line above it) and just leave `"command"` and `"args"`.

**4. Where to launch Claude Code from.** This is the step people get wrong. Claude Code only reads `.mcp.json` from the directory you **launch it in** — not from any other folder, and not recursively from parent folders. You must open your terminal (or your editor's integrated terminal) in your UEFN project root — the exact folder where you just created `.mcp.json` — and start Claude Code from there. If you launch Claude Code from your home directory, your Desktop, or any other folder, it will not find this `.mcp.json` and the `uefn` server will not appear at all.

**5. In UEFN's Python console, in order.** With your UEFN project open, open the Python console (Output Log panel → console dropdown → **Python**) and run these two lines, in this order:

```python
import importlib, uefn_bridge
importlib.reload(uefn_bridge)
```

Do not just run `import init_unreal` on its own if you have already imported it earlier in this UEFN session — Python only executes a module's startup code the *first* time it's imported per session, so a second plain `import init_unreal` is a silent no-op with no output, no bridge, and no error. The `importlib.reload(uefn_bridge)` form above forces the bridge to actually (re)start regardless of what you've already imported this session, so it's the reliable command to run before connecting a client. If this is the very first thing you've run this UEFN session, `import init_unreal` also works, but the reload form above is always safe and always works.

**6. Verify it worked.** In Claude Code, ask it to call the `uefn_status` tool (or just ask "check the UEFN bridge status"). A real, working connection returns a specific level name and an actor count greater than zero. If you get an error, a generic "unreachable" message, or no level name, the bridge is not actually running even if Claude Code's own connection indicator looks fine — go back to step 5.

**Claude Code showing the `uefn` server as "Connected" is not proof anything is working.** A "Connected" status in Claude Code only means Claude Code successfully launched `node uefn-server.mjs` as a child process — it says nothing about whether the Python bridge inside UEFN has started. You can have a fully "Connected" server in Claude Code, call a tool, and have it fail, or you can have Claude Code report "Connected" while the Power Tools launcher window shows "Bridge disconnected" and no heartbeat file exists at all. The only trustworthy check is calling the `uefn_status` tool from Claude Code and getting back a real level name and an actor count greater than zero, as described above — trust that result over Claude Code's own connection indicator.

**7. If it doesn't work:**
- Double-check you launched Claude Code from the exact folder containing `.mcp.json` — this is the most common mistake.
- Confirm `.mcp.json` is valid JSON — a trailing comma or missing brace will make Claude Code silently ignore the whole file. Paste it into any JSON validator if unsure.
- Confirm the path in `"args"` points at a `uefn-server.mjs` file that actually exists at that exact location, using forward slashes.
- Re-run the two-line reload command from step 5 — UEFN must be open with your project loaded, and the bridge must be re-started after every UEFN restart.
- Check the Power Tools launcher window (`import pt`) — its footer shows whether the bridge is actually running and which version.

### Codex CLI

This is a **verified** integration — confirmed working end to end on a real machine — but it has a sharp edge (the sandbox gotcha in step 7) that has caused real confusion, so read this whole section including step 7 before you try it.

**1. Which file, and where.** Codex CLI reads MCP server configuration from exactly one file: `~/.codex/config.toml`. This is a **global** file — it lives in your user home directory, not in your UEFN project. There is no such thing as a project-local Codex config: a `.codex` folder placed anywhere inside your project (including inside `Content/`) is never read by Codex CLI. `~/` means your home directory — on Windows that's `C:/Users/<your-username>` (Codex CLI itself resolves the `~`; you don't need to expand it yourself when editing the file, but if your editor doesn't expand `~` either, use the full path).

**2. Create the directory first?** The `.codex` folder may not exist yet if you've never run Codex CLI before. Create it if needed: on Windows, in File Explorer, go to your user folder (`C:/Users/<your-username>`) and create a folder named `.codex` (you may need to type the name including the leading dot in the "New Folder" rename box). From a terminal, `mkdir "$env:USERPROFILE\.codex"` in PowerShell, or `mkdir ~/.codex` in a bash-like shell, does the same thing.

**3. Full file content.** Inside `~/.codex/config.toml`, add this complete table (if the file already has other content in it from other MCP servers or settings, add this table without disturbing what's already there):

```toml
[mcp_servers.uefn]
command = "node"
args = ["D:/ACode/PowerToolsLocation/uefn-server.mjs"]

[mcp_servers.uefn.env]
UEFN_BRIDGE_DIR = "D:/ACode/PowerToolsLocation/bridge-dir"
```

Replace `D:/ACode/PowerToolsLocation/uefn-server.mjs` with the real, full path to your own unzipped `uefn-server.mjs`, using forward slashes. The `[mcp_servers.uefn.env]` table is **optional** — omit that entire two-line block if you don't need a non-default bridge directory (it defaults to a per-machine temp directory).

**4. Where to launch Codex CLI from.** It does not matter. Because Codex CLI's config is global (step 1), you can launch `codex` from any directory on your machine and it will find the same `~/.codex/config.toml` and the same `uefn` server entry every time.

**5. In UEFN's Python console, in order.** With your UEFN project open, open the Python console (Output Log panel → console dropdown → **Python**) and run these two lines, in this order:

```python
import importlib, uefn_bridge
importlib.reload(uefn_bridge)
```

This reload form reliably (re)starts the bridge regardless of whether `init_unreal` was already imported earlier in this UEFN session — a plain repeated `import init_unreal` is a silent no-op (no output, no bridge, no error) once it's already in `sys.modules`. Run this once per UEFN session, and again after every UEFN restart.

**6. Verify it worked.** From a Codex CLI session, ask it to call the `uefn_status` tool. A working connection returns a real level name and an actor count greater than zero — that's the only proof that matters. A "Connected" server status in Codex CLI on its own only means Node launched successfully, not that UEFN's bridge is reachable.

**7. If it doesn't work:**
- **The sandbox gotcha (read this first):** Codex CLI's default `sandbox_mode = "read-only"` auto-denies the very first MCP tool call in `codex exec` — instantly, before it ever reaches the server — with a message like `"user cancelled MCP tool call"`. That message reads exactly as if a human rejected the call, but no human did anything; the sandbox blocked it automatically. If your first `uefn_status` call fails with that message, this is almost certainly the cause, not a broken server or bridge. Fix it by either running Codex CLI interactively so you can approve the tool call when prompted, or by starting Codex with the sandbox opened (not read-only), so `uefn_*` calls are allowed through.
- Confirm you edited `~/.codex/config.toml` and not some other file — there is no project-local alternative, so a project-local `.codex` folder anywhere will silently do nothing.
- Confirm the TOML syntax is valid — table headers (`[mcp_servers.uefn]`) must appear before the keys that belong to them, and string values need double quotes.
- Confirm the path in `args` points at a real, existing `uefn-server.mjs`, with forward slashes.
- Re-run the two-line reload command from step 5 in UEFN's Python console — UEFN must be open with your project loaded.

### Gemini CLI

This is a **verified** integration — confirmed working end to end on a real machine.

**1. Which file, and where.** Gemini CLI supports two locations, and either one works — pick one, don't use both:
- **Global:** `~/.gemini/settings.json` (in your home directory — on Windows, `C:/Users/<your-username>/.gemini/settings.json`). Use this if you want the `uefn` server available no matter which project you're in.
- **Project-local:** `.gemini/settings.json` inside your UEFN project root (the folder holding your `.uefnproject` file). Use this if you only want the `uefn` server available for this specific project.

**2. Create the directory first?** Whichever location you pick, the `.gemini` folder likely doesn't exist yet. Create it before creating the file inside it:
- For the global option, create a folder named `.gemini` directly inside your user home directory.
- For the project-local option, create a folder named `.gemini` directly inside your UEFN project root (the same folder that holds `Content/` and `.uefnproject`).

**3. Full file content.** Inside whichever `settings.json` you chose, put this complete content (if the file already exists with other settings, merge this `mcpServers` key into the existing JSON object rather than replacing the whole file):

```json
{
  "mcpServers": {
    "uefn": {
      "command": "node",
      "args": ["D:/ACode/PowerToolsLocation/uefn-server.mjs"],
      "env": {
        "UEFN_BRIDGE_DIR": "D:/ACode/PowerToolsLocation/bridge-dir"
      }
    }
  }
}
```

Replace `D:/ACode/PowerToolsLocation/uefn-server.mjs` with the real, full path to your own unzipped `uefn-server.mjs`, using forward slashes. The `env` block is optional — remove it entirely if you don't need a non-default bridge directory. Gemini CLI's `env` values also support `$VAR_NAME` expansion, so instead of a literal path you can reference a variable already set in your shell, e.g. `"UEFN_BRIDGE_DIR": "$MY_BRIDGE_DIR"`.

**4. Where to launch Gemini CLI from.** If you used the **global** file, it doesn't matter — launch `gemini` from anywhere. If you used the **project-local** file, you must launch `gemini` from your UEFN project root (the folder containing the `.gemini` folder you just created), the same way Claude Code requires.

**5. In UEFN's Python console, in order.** With your UEFN project open, open the Python console (Output Log panel → console dropdown → **Python**) and run these two lines, in this order:

```python
import importlib, uefn_bridge
importlib.reload(uefn_bridge)
```

This reliably (re)starts the bridge even if `init_unreal` was already imported earlier this session (a plain repeated `import init_unreal` is a silent no-op once it's already in `sys.modules`). Run this once per UEFN session, and again after every UEFN restart.

**6. Verify it worked.** From a Gemini CLI session, ask it to call the `uefn_status` tool. A working connection returns a real level name and an actor count greater than zero. A "Connected" status for the server on its own only confirms Node started — it does not confirm the bridge is reachable.

**7. If it doesn't work:**
- Confirm you edited the file at the location you intended — if you used the project-local file but launched Gemini CLI from a different folder, it won't be found.
- Confirm the JSON is valid — a trailing comma or missing brace makes Gemini CLI silently ignore the file.
- Confirm the path in `"args"` points at a real, existing `uefn-server.mjs`, with forward slashes.
- Re-run the two-line reload command from step 5 in UEFN's Python console.
- Check the Power Tools launcher window (`import pt`) footer for the bridge's actual running status and version.

### Other MCP clients (community / untested)

**These are not officially supported, and none of them have been tested end to end with Power Tools.** Only Claude Code, Codex CLI, and Gemini CLI (above) have a confirmed live round trip against a running UEFN project. The clients below are documented on a best-effort basis, from each client's own published MCP config format, with no verification that a `uefn_status` call actually comes back with a real level name and actor count. If you get one of these working (or can't), please report it.

**Using VS Code or Antigravity IDE? You probably don't need this section.** VS Code and Antigravity IDE are editors — they are hosts you run a terminal inside, not MCP clients in their own right. If you're using either one, the normal path is to open its integrated terminal and run Claude Code, Codex CLI, or Gemini CLI there, then follow that CLI's section above exactly as written. The editor itself needs no separate MCP setup; only the CLI running inside it does. The VS Code Copilot agent-mode and Antigravity-native config entries below exist only for people who specifically want the editor's own built-in agent (not a CLI in its terminal) to talk to the bridge, which is the untested path.

Every client below uses the same config **shape** as the Claude Code section above: a `command` of `node`, an `args` array pointing at your `uefn-server.mjs`, and an optional `env` block for `UEFN_BRIDGE_DIR` (see the Claude Code section's `.mcp.json` example for the full JSON to copy and adapt). What differs per client is only the file location and, in one case, the top-level key name:

| Client | Config file | Key |
| --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-local) | `mcpServers` |
| Windsurf | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` (Windows; global only) | `mcpServers` |
| Antigravity IDE (native) | `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json` (workspace) — also reachable via agent side panel → menu → **MCP Servers** → **Manage MCP Servers** → **View raw config** | `mcpServers` |
| VS Code Copilot (agent mode) | `.vscode/mcp.json` (project-local) | `servers` — **not** `mcpServers`, and each entry needs an added `"type": "stdio"` field |

**Windows-specific gotcha for Windsurf:** a leading `~` in any path inside `mcp_config.json` is **not** automatically expanded by Windsurf on Windows the way it is in a Unix shell. Use `%USERPROFILE%` or a full drive-letter path instead of `~/...`.

For all four: after saving the config, launch the client from your UEFN project root if the file you used is project-local (Cursor project-local, Antigravity workspace, VS Code); global files (Cursor global, Windsurf, Antigravity global) work from anywhere. Then start the bridge in UEFN's Python console the same way as every other client:

```python
import importlib, uefn_bridge
importlib.reload(uefn_bridge)
```

**A "Connected" status here is not proof of anything**, exactly as with the three supported clients above: it only means the client launched `node uefn-server.mjs`, not that the Python bridge inside UEFN has started. The only trustworthy check is calling the `uefn_status` tool from the client and getting back a real level name and an actor count greater than zero.

If it doesn't work: double-check the file is valid JSON at the exact path for your client, confirm the path in `"args"` points at a real `uefn-server.mjs` with forward slashes, re-run the reload command above, check the Power Tools launcher window (`import pt`) footer for the bridge's actual status, and consult that client's own current MCP documentation in case its format has changed since this was written — then let us know what you find either way.

### Environment overrides

These are the client-neutral way to point the bridge and its tools at a non-default location — set them in the shell/process that launches the MCP server (or, where a client's `env` block is supported, there):

| Variable | What it points to |
| --- | --- |
| `UEFN_BRIDGE_DIR` | The bridge IPC directory the MCP server and the in-UEFN Python bridge use to hand off work. Defaults to a per-machine temp directory if unset. |
| `UEFN_VERSE_PROJECT_DIR` | UEFN's `VerseProject` data root — where digests and `.vproject` files live. |
| `VERSE_LSP_PATH` | The Verse language server binary, used by tools that run compiler diagnostics. |
| `VERSE_LSP_CHECK_SCRIPT` | Where `verse_lsp_check.py` itself lives (see below) — a different thing from `VERSE_LSP_PATH`, which is the analyzer binary the script locates internally. |

### The `uefn_verse_check` tool needs `verse_lsp_check.py`

`uefn_verse_check` doesn't talk to the in-UEFN Python bridge like the other tools — it runs `verse_lsp_check.py` directly as a local subprocess, which drives Epic's bundled Verse language server headless. That means it needs the script to be present on disk, separately from everything else this repo installs.

This repo ships that script at `skills/uefn/verse_lsp_check.py`. Point the server at it with the `VERSE_LSP_CHECK_SCRIPT` environment variable:

```json
"env": {
  "VERSE_LSP_CHECK_SCRIPT": "C:\\path\\to\\trashbyrds-power-tools\\skills\\uefn\\verse_lsp_check.py"
}
```

Add that to whichever client config you're already using from **Connecting an AI client** above (alongside `UEFN_BRIDGE_DIR` if you're setting that too). Without it, `uefn_verse_check` fails with an honest error listing every location it tried — set the variable to the path above and it resolves.

## 5. Epic's official UEFN MCP server

Epic ships its own official UEFN MCP server. Enable it in UEFN via **Project Settings → Python Editor Scripting** and **Project Settings → UEFN MCP Toolsets**; once enabled it binds `http://127.0.0.1:8000/mcp` by default. You can install and run both Epic's server and Power Tools at the same time — that's the intended configuration, not a conflict. See Epic's own documentation for what its server covers: https://dev.epicgames.com/documentation/fortnite/uefn-mcp

Power Tools (this server) focuses on bulk queries over a project's actors, plus moderation, dependency, texture, material, and Niagara-usage scanning.

## Updating

Download the latest release and re-copy the contents of `python/` into `<your-uefn-project>/Content/Python/`, then restart UEFN (or reload the bridge module from the Python console) to pick up changes. If you cloned the source repo, `git pull` instead. If a tool still behaves like the old version afterward, see [A tool seems to be running an old version](#a-tool-seems-to-be-running-an-old-version) — the engine-side copy may need updating too.
