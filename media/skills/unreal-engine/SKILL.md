---
name: unreal-engine
description: Unreal Engine C++/Blueprint gameplay, actors, and editor workflows, plus live editor control through Unreal's built-in MCP server.
---

# Unreal Engine

Practical guide for building and modifying an Unreal Engine project with Claude Code agents. Use this skill whenever a task touches a `.uproject`, `Content/`, Blueprints, `.uasset`/`.umap` files, or C++ gameplay classes under `Source/`.

Note: for **UEFN** (Unreal Editor for Fortnite) specifically, prefer the dedicated `uefn` / `uefn-bridge` skills — this skill covers general Unreal Engine (UE4/UE5) projects.

## When to use this

- The workspace root has a `.uproject` file and a `Content/` folder.
- The task mentions Actors, Components, Blueprints, Pawns/Characters, `.uasset`/`.umap`, or the Unreal Editor.
- A `Source/<ProjectName>/` folder with `.Build.cs` module files is present (C++ project).

## Project structure & key files

- `<Project>.uproject` — JSON manifest listing enabled plugins and modules; the double-click entry point that launches the editor.
- `Content/` — all binary editor assets (`.uasset` for objects/Blueprints, `.umap` for levels). These are binary and not diffable — treat them as opaque; don't attempt text edits.
- `Source/<ProjectName>/` — C++ gameplay code. Each module has a `.Build.cs` (dependency/module config), a `<ProjectName>.h/.cpp` module entry point, and per-class `.h`/`.cpp` pairs.
- **Blueprints vs C++**: Blueprints are visual-scripted `.uasset` graphs, good for designer-facing tuning and rapid iteration; C++ is for performance-critical or deeply reusable systems. Common pattern: a C++ base class exposes `UPROPERTY`/`UFUNCTION` hooks, and a Blueprint subclass tunes values or adds designer-authored logic on top.
- Modules — a project can have multiple modules (e.g. a runtime module and an editor-only module); each is declared in the `.uproject` and has its own `.Build.cs`.

## Scripting model

Gameplay classes derive from Unreal base types (`AActor`, `APawn`, `ACharacter`, `UActorComponent`) and use Unreal's reflection macros to expose members to the editor/Blueprint layer.

```cpp
// PickupActor.h
UCLASS()
class MYGAME_API APickupActor : public AActor
{
    GENERATED_BODY()

public:
    APickupActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pickup")
    int32 ScoreValue = 10;

    UFUNCTION(BlueprintCallable, Category = "Pickup")
    void OnCollected(APawn* Collector);

protected:
    virtual void BeginPlay() override;

    UPROPERTY(VisibleAnywhere)
    UStaticMeshComponent* MeshComponent;
};
```

`UPROPERTY` exposes a field to the editor/Blueprint (with access specifiers like `EditAnywhere`, `BlueprintReadWrite`); `UFUNCTION(BlueprintCallable)` exposes a method callable from Blueprint graphs. `GENERATED_BODY()` is required boilerplate that the Unreal Header Tool (UHT) expands.

## Common tasks

- **New level**: `File > New Level` in-editor, saved as a `.umap`; place Actors by dragging from Content Browser or spawning at runtime with `GetWorld()->SpawnActor<T>()`.
- **Add a component**: create a `UActorComponent`/`USceneComponent` subclass in C++, or add it directly to an Actor/Blueprint via the editor's Components panel.
- **Handle input**: modern UE5 projects use the **Enhanced Input** system — `UInputAction` assets bound to `UInputMappingContext`s, triggered via `EnhancedInputComponent->BindAction()`. Older/UE4 projects may still use the legacy Action/Axis mapping in `DefaultInput.ini`; check which is set up before assuming.
- **Wire events**: C++ multicast delegates (`DECLARE_DYNAMIC_MULTICAST_DELEGATE`) exposed as `UPROPERTY(BlueprintAssignable)` so Blueprints can bind to them; or native `TDelegate`/lambda bindings for C++-only code.
- **Build/run**: Play-in-Editor (PIE) for fast iteration; for C++ changes, use **Live Coding** (Ctrl+Alt+F11 in-editor) for small recompiles, or a full rebuild via the generated `.sln`/`UnrealBuildTool` for structural changes (new classes, changed `UCLASS`/`UPROPERTY` macros).

## Gotchas

- **Hot reload / Live Coding** only handles small, additive C++ changes safely — changing a `UCLASS`/`UPROPERTY`/`UFUNCTION` signature, adding new reflected members, or touching a `.Build.cs` usually requires closing the editor and doing a full rebuild; partial hot-reloads after structural changes can crash or silently desync the editor.
- `.uasset`/`.umap` are binary — never hand-edit, and expect large "changed" blobs in diffs/version control even for small edits made in-editor; use source control (Perforce is standard for Unreal teams; Git works but needs LFS for binary assets).
- Blueprint logic that shadows/overrides a C++ base method can be invisible from a code-only read — check whether a Blueprint subclass exists before assuming C++ is the whole story.
- `GENERATED_BODY()` and UHT-generated `.generated.h` includes are mandatory for any `UCLASS`/`USTRUCT`/`UENUM` — deleting or misordering the include breaks compilation in ways that look unrelated to the actual edit.
- Garbage-collected `UObject`/`AActor` pointers must be held via `UPROPERTY()` (even on non-editor-exposed fields) or they can be GC'd out from under you.

## Live editor control (Unreal MCP)

Recent Unreal Engine versions ship an MCP server inside the editor (HTTP `127.0.0.1:8000/mcp` by default). It is provided by the **ModelContextProtocol** plugin, and it exposes no tools unless the **AllToolsets** plugin is also enabled.

Setup:
1. Enable both plugins in the project and restart the editor.
2. Start the server with the console command `ModelContextProtocol.StartServer` (optionally pass a port), or turn on auto-start in Editor Preferences.
3. Run `ModelContextProtocol.GenerateClientConfig ClaudeCode` to write the project's `.mcp.json`. Re-run it if the port or URL changes.
4. Confirm the `unreal-mcp` server is connected via `/mcp`. A connected client does not prove the editor is reachable, so make a read-only call first.

Discovery workflow: do not rely on remembered tool names. The server advertises three meta-tools; use them in order:
1. `list_toolsets` to see the available toolsets (30+).
2. `describe_toolset` for the one you need, to get its real tool names and argument schemas.
3. `call_tool` with the toolset, tool name, and arguments.

If a tool seems missing, the editor may be down or the client may hold a stale catalog; re-run `list_toolsets`. Check every result, since some failures return a status instead of an error. Run dependent calls one at a time, save the project before and after bulk changes (edits are not always undoable), wait for compilation to finish, and stop Play-in-Editor if results look wrong. If the project registers Agent Skills, check `AgentSkillToolset.ListSkills` first and follow them.

Official plugin: Epic publishes a fuller skill as a Claude Code plugin. Install it with `/plugin install unreal-engine-skills-for-claude-code@claude-plugins-official` (add the marketplace first with `/plugin marketplace add anthropics/claude-plugins-official` if needed). On Windows it needs bash on PATH (Git Bash or WSL) for its session hook. When it is installed, defer to its guidance for MCP operations; this skill then only supplies the general project knowledge above and the TycoonAgents routing below.

Safety:
- `ProgrammaticToolset.execute_tool_script` runs arbitrary Python inside the editor with full project access and can change or delete content.
- Localhost is not a trust boundary: any process running as the same user can reach the server. Do not expose the port beyond loopback or run it on shared machines.
- Never bypass permission prompts (for example `--dangerously-skip-permissions`) with this server connected. Use source control and review diffs afterward.

## TycoonAgents integration

TycoonAgents shows a live **Unreal connection chip** in the agent visualization panel when the Unreal MCP bridge is active. Route Unreal-specific implementation work (Actors, Components, Blueprint graphs, C++ gameplay classes) to coding-specialist rather than editing `Source/`/`Content/` files from the orchestrator directly. For UEFN/Fortnite-specific work, use the `uefn`/`uefn-bridge` skills instead.
