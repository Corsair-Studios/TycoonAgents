---
name: roblox
description: Roblox Studio + Luau scripting — instances, services, and experience workflows.
---

# Roblox

Guidance for building and scripting Roblox experiences with Luau in Roblox Studio.

## What it is

Roblox experiences ("games") are built in **Roblox Studio** and scripted in **Luau**, a
statically-typeable dialect of Lua 5.1. There is no separate compiled build step during
development — scripts run live inside Studio and on Roblox's cloud servers when published.

## Project structure

A place file (`.rbxl` binary or `.rbxlx` XML) serializes the **DataModel** — a tree of
`Instance` objects, browsable in Studio's Explorer panel. Key services (top-level DataModel
children) you'll touch constantly:

| Service | Purpose |
|---|---|
| `Workspace` | The 3D world — parts, models, terrain. Replicated to every client. |
| `ServerScriptService` | Server-only `Script`s. Never replicated to clients. |
| `ReplicatedStorage` | Shared assets/`ModuleScript`s visible to both server and client. Home for `RemoteEvent`/`RemoteFunction`. |
| `StarterPlayer` / `StarterGui` / `StarterPack` | Templates copied into each player's client on join (`PlayerGui`, `Backpack`, character scripts). |
| `Players` | The live roster of connected `Player` instances. |

Three script types:
- **`Script`** — runs on the server, placed under `ServerScriptService` or `Workspace`.
- **`LocalScript`** — runs on one client, placed under `StarterPlayer`/`StarterGui`/a player's `PlayerGui`.
- **`ModuleScript`** — returns a table/value via `require()`; shared logic imported by either side, never runs on its own.

## Server/client boundary

Roblox is **server-authoritative**: the server owns game state, clients render and send input.
Cross the boundary with `RemoteEvent` (fire-and-forget) or `RemoteFunction` (request/response,
yields the caller — avoid for latency-sensitive paths).

```lua
-- ServerScriptService/GrantCoins.server.lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local grantCoins = Instance.new("RemoteEvent")
grantCoins.Name = "GrantCoins"
grantCoins.Parent = ReplicatedStorage

grantCoins.OnServerEvent:Connect(function(player, amount)
    -- Re-validate on the server — never trust the client's amount as-is.
    local safeAmount = math.clamp(amount, 0, 100)
    local leaderstats = player:FindFirstChild("leaderstats")
    if leaderstats and leaderstats:FindFirstChild("Coins") then
        leaderstats.Coins.Value += safeAmount
    end
end)
```

```lua
-- StarterPlayerScripts/RequestCoins.client.lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local grantCoins = ReplicatedStorage:WaitForChild("GrantCoins")
grantCoins:FireServer(10)
```

## Common tasks

- **Create instances**: `Instance.new("Part")`, set `.Parent` last (avoids redundant replication events).
- **Detect touch**: `part.Touched:Connect(function(hit) ... end)` — debounce it, `Touched` fires repeatedly.
- **Build GUI**: `ScreenGui` → `Frame`/`TextButton` under `StarterGui`, styled with `UIListLayout`/`UICorner`.
- **Persist data**: `DataStoreService:GetDataStore(name)`, `:GetAsync`/`:UpdateAsync` — wrap in `pcall`, never write on every frame.
- **Sync with an external editor**: use **Rojo** to map a filesystem folder (edited in VS Code) to the DataModel two-way, so Luau lives in real files under source control instead of only inside the `.rbxl`.

## Gotchas

- **Never trust the client.** Validate every `RemoteEvent`/`RemoteFunction` payload server-side — clients can fire arbitrary values.
- **Replication is one-way for Workspace changes originating client-side** by default; only the server's writes to `Workspace`/data reliably replicate to all clients.
- **`FilteringEnabled`** is mandatory on all modern experiences (legacy toggle, always on) — client-only changes to server-replicated instances don't propagate.
- **DataStore limits**: per-key write budget (~4MB/key, request throttling) — batch and cache in memory, only write on meaningful state changes or `game:BindToClose`.

## TycoonAgents integration

TycoonAgents shows a live **Roblox connection chip** in the panel when an MCP-based Roblox
Studio bridge is connected. Delegate Roblox implementation work (Luau scripts, DataModel
changes, Studio plugin actions) to coding-specialist rather than hand-editing Luau
files yourself.

With the **Roblox Studio MCP** (`roblox-studio`) connected, besides the data-model and Luau
tools it exposes `list_plugin_guis` and `capture_plugin_gui` for Studio plugin UI. Read each
tool's description from the MCP server for its parameters and return shape; don't guess them.

### Verifying plugin UI

After rebuilding a plugin or toolkit:
1. Call `list_plugin_guis` to find the plugin's panel.
2. Call `capture_plugin_gui` on it and inspect the captured image.
3. Compare against the intended layout and fix any differences.

Ask the user for a screenshot only if these tools are unavailable (older Studio/MCP
versions) or the calls fail.
