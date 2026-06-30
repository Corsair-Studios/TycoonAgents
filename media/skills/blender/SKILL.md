---
name: blender
description: Blender 4 modeling, materials, shading, animation, and Python (bpy) scripting; live-editor control via the official Blender MCP.
---

# Blender

Guidance for Blender 4 modeling, shading, and `bpy` Python scripting, plus live
control of a running Blender session via the official **Blender MCP** server.

## bpy scripting conventions

- **`bpy.data`** — the actual datablocks (objects, meshes, materials, scenes).
  Persistent, saved with the `.blend` file.
- **`bpy.context`** — the current UI/state pointer (active object, selected
  objects, active scene, view layer). Only valid in the right context (some
  attributes are `None` in `--background` mode — avoid `bpy.context.object`
  in headless scripts; use `bpy.data.objects[...]` instead).
- **Operators (`bpy.ops.*`)** — UI-style actions (`bpy.ops.mesh.primitive_cube_add()`,
  `bpy.ops.object.modifier_add()`). They depend on context (active object,
  mode, selection) and report `{'FINISHED'}` / `{'CANCELLED'}`.
- **Data API** — direct, context-free manipulation (`bpy.data.objects.new(...)`,
  editing mesh vertices via `bmesh`). Prefer the data API in headless/batch
  scripts since it doesn't depend on a UI context.

## Core areas

- **Modeling** — mesh primitives, edit-mode bmesh operations, modifiers
  (Subdivision Surface, Mirror, Array, Boolean, Solidify) stacked via
  `object.modifiers.new(name, type)`.
- **Materials & nodes** — `bpy.data.materials.new()`, enable `use_nodes`, then
  wire `material.node_tree.nodes` / `.links` (Principled BSDF is the default
  PBR shader node).
- **Lighting** — light datablocks (`bpy.data.lights.new(type='SUN'|'POINT'|'AREA'|'SPOT')`)
  linked to an object; world shading via `scene.world.node_tree`.
- **Animation** — keyframes via `obj.keyframe_insert(data_path="location", frame=N)`;
  drive playback range with `scene.frame_start` / `scene.frame_end`.
- **Headless runs** — `blender --background --python script.py [-- args]`.
  No UI context exists, so scripts must use the data API and explicit object/
  scene references rather than `bpy.context`-dependent operators. Useful for
  batch renders, asset export, and CI validation.

## Official Blender MCP setup

1. Install the **`uv`** package manager (provides `uvx`).
2. MCP server command (stdio): `uvx blender-mcp`
3. Client config entry:
   ```json
   "blender": { "command": "uvx", "args": ["blender-mcp"] }
   ```
4. Install the official **Blender MCP** add-on: drag-and-drop the add-on file
   from https://www.blender.org/lab/mcp-server/ into a running Blender window,
   enable it in Preferences, then start the MCP panel inside Blender.
5. The `uvx blender-mcp` server connects to the Blender add-on over a socket.
   Env vars: `BLENDER_HOST` (default `localhost`), `BLENDER_PORT` (default `9876`).
6. Docs: https://www.blender.org/lab/mcp-server/
   Setup wiki: https://projects.blender.org/lab/blender_mcp/wiki/Setup

The MCP exposes: scene inspection/modification, object/material/lighting
control, and arbitrary `bpy` Python execution against the live session.

## When to use the MCP vs scripting

- **Use the MCP** when Blender is already open and you want to inspect or
  change the live scene interactively (iterate on a material, nudge an
  object, check what's currently selected) without restarting the app.
- **Use a standalone `bpy` script** (often via `--background --python`) for
  reproducible, version-controlled pipelines — batch asset generation,
  automated renders, CI/export jobs — where no live session is involved.

**Examples:**
- "What objects are in the current scene and what materials do they use?" →
  query via the MCP against the live session.
- "Generate 20 low-poly rock variations and export each as glTF" → headless
  `bpy` script run via `blender --background --python generate_rocks.py`.
