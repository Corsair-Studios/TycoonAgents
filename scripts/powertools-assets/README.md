# Trashbyrd's UEFN Power Tools

MCP server + Python tools for live, chat-driven inspection and editing of a UEFN project, Verse, and assets.

## What it is

Power Tools is a bridge between an AI chat client (or your own scripts) and a **live** Unreal Editor for Fortnite (UEFN) session. A small Python bridge runs inside UEFN's embedded Python console; a Node/TypeScript MCP server on your machine talks to that bridge over local file-based IPC. Anything the bridge can see or touch in the open project — devices, assets, materials, Niagara systems, Verse — becomes queryable and editable from your chat client while UEFN stays open with your project loaded.

This is an independent, community-built bridge to the live UEFN editor. It is not affiliated with or endorsed by Epic Games.

## Features

- **Device audit** — enumerate and inspect Creative devices placed in the level.
- **Asset, texture, material, and Niagara browsing** — search and inspect project assets, materials, textures, and particle (Niagara) systems.
- **Dependency and health scans** — trace asset dependencies and surface project health issues.
- **Verse snippets** — quick reference/insertion of common Verse code patterns.
- **Keyboard shortcuts and level stats** — surface editor shortcuts and summary stats about the current level.
- **Property inspection and reference finding** — look up actor/object properties and find references across the project.

Tool names above are illustrative of what's under `python/`; run the MCP server (see below) and query it from your client for the current, authoritative tool list.

## Architecture

```
MCP client (e.g. Claude Code)
      |
MCP server (uefn-server.ts, this repo, runs via tsx)
      |
file-based IPC (OS temp dir)
      |
Python bridge (python/, runs inside UEFN's embedded Python console)
```

The MCP server and the in-editor Python bridge are two separate processes that hand off work through files on disk — there's no network socket and no UEFN plugin beyond enabling the built-in Python Editor Script Plugin. UEFN must stay open with your project loaded for live queries and edits to work.

## Install

See [INSTALL.md](INSTALL.md) for step-by-step setup, including how to connect the MCP server to your AI client of choice (Claude Code, Gemini CLI, Codex CLI, Cursor, Windsurf, Antigravity IDE, or VS Code Copilot).
