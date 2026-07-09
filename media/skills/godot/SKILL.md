---
name: godot
description: Godot 4 GDScript nodes, scenes, signals, and game systems.
---

# Godot

Practical guide for building and modifying a Godot 4 project with Claude Code agents. Use this skill whenever a task touches `.tscn`/`.gd` files, `project.godot`, or asks to add a scene, node, script, or signal wiring in a Godot project.

## When to use this

- The workspace root (or a subfolder) has a `project.godot` file.
- The task mentions nodes, scenes, GDScript, `.tscn`/`.tres`, signals, or the Godot editor.
- A `.godot/` cache folder is present (confirms an opened/imported project).

## Project structure & key files

- `project.godot` — the project manifest (autoloads, input map, rendering settings). Text-based, safe to read/diff.
- `*.tscn` — scene files (text format by default in Godot 4). A scene is a tree of nodes; each node has a type (`Node2D`, `CharacterBody2D`, `Control`, …) and a resource path back to its script.
- `*.gd` — GDScript source, one script typically attached to one node.
- `*.tres` — text resources (materials, custom Resource subclasses, themes).
- `*.import` — auto-generated import metadata for every asset (textures, audio). Never hand-edit; regenerate by re-importing in-editor or deleting and letting Godot rebuild it.
- `addons/` — plugins (each needs `plugin.cfg` and must be enabled in Project Settings > Plugins).

## Scripting model

GDScript is duck-typed, Python-like, and attaches per-node. Nodes talk to each other via **node paths** (`$Player/Sprite2D`, `get_node("../HUD")`) or, preferably, **signals** for decoupling.

```gdscript
extends CharacterBody2D

const SPEED := 300.0
const JUMP_VELOCITY := -400.0

signal died

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity.y += ProjectSettings.get_setting("physics/2d/default_gravity") * delta
    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = JUMP_VELOCITY
    var direction := Input.get_axis("move_left", "move_right")
    velocity.x = direction * SPEED if direction else move_toward(velocity.x, 0, SPEED)
    move_and_slide()

func take_damage(amount: int) -> void:
    if amount > 0:
        died.emit()
```

## Common tasks

- **New scene**: create a root node of the right type, save as `.tscn` under a feature folder (e.g. `scenes/player/player.tscn`), attach a script with `extends <BaseType>`.
- **Add a component**: prefer composition — child nodes (`Area2D` for hitboxes, `AnimationPlayer`, `Timer`) over deep inheritance.
- **Handle input**: define actions in Project Settings > Input Map (or edit `input/*` entries in `project.godot` directly), then read with `Input.is_action_pressed/just_pressed` or override `_unhandled_input(event)`.
- **Wire signals**: connect in the editor (Node dock) or in code with `node.some_signal.connect(_on_some_signal)`; custom signals are declared with `signal name(args)` and fired with `emit()`.
- **Build/run**: no compile step for GDScript — run via the editor's Play button, or headless with `godot --path <project_dir>` from the command line for smoke tests/exports.

## Gotchas

- Node paths (`$Foo/Bar`) break silently if the scene tree is restructured — prefer `@onready var bar := $Foo/Bar` so failures surface at scene load, and prefer exported node references (`@export var bar: Node`) over string paths when possible.
- Signals must be connected *after* both nodes exist (usually in `_ready()`); connecting too early throws.
- `.import` files and the `.godot/` cache are regenerated — don't hand-edit, and don't worry about touching them in diffs (they're typically gitignored or safe to ignore in review).
- Autoloads (singletons) are project-global state declared in `project.godot` — changing/removing one can silently break scenes that reference it by name.
- Static typing (`var x: int`) is optional but catches real bugs early; use it for anything performance- or correctness-sensitive.

## TycoonAgents integration

TycoonAgents shows a live **Godot connection chip** in the agent visualization panel when the Godot MCP bridge is active, so you can see engine connectivity at a glance. Route Godot-specific implementation work (scenes, GDScript, signal wiring, scene tree changes) to the engine specialist agent rather than editing `.tscn`/`.gd` files from the orchestrator directly.
