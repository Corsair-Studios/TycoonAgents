---
name: blender
description: Blender 4/5 modeling, materials, shading, animation, and Python (bpy) scripting; live-editor control via the official Blender Lab MCP (Blender 5.1+).
---

# Blender

Guidance for Blender 4/5 modeling, shading, and `bpy` Python scripting, plus live
control of a running Blender session via the official **Blender Lab MCP** server (Blender 5.1+).

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

## Official Blender MCP setup (Blender Lab, Blender 5.1+)

1. Use **Blender 5.1 or newer** (the official server is not available on 4.x).
2. Install the Blender Lab MCP extension from https://www.blender.org/lab/mcp-server/:
   drag and drop it into a running Blender window (twice - the first drop adds the
   Blender Lab extension repository, the second installs the add-on) or use
   Install from Disk, then enable it and start the MCP server from inside Blender.
3. Connect your MCP client as described in Blender's Setup wiki:
   https://projects.blender.org/lab/blender_mcp/wiki/Setup. The official page does
   not publish a Claude Code command or URL, so do not guess one.
4. **Security warning (from Blender):** the MCP server executes LLM-generated code
   in Blender with no guards against data removal or sending data to a remote
   location. Use a virtual machine or a system without sensitive data, and save
   or back up your `.blend` first.

### Community alternative: `blender-mcp` (not the official server)

A community bridge, not published by Blender Foundation, that uses its own add-on:

- Install the **`uv`** package manager (provides `uvx`).
- Server command (stdio): `uvx blender-mcp`; client entry
  `"blender": { "command": "uvx", "args": ["blender-mcp"] }`.
- Follow that project's own add-on install; it connects over a socket (env
  `BLENDER_HOST` default `localhost`, `BLENDER_PORT` default `9876`).

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
