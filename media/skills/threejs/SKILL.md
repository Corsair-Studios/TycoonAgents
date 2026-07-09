---
name: threejs
description: Three.js scenes, meshes, lighting, and render-loop lifecycle.
---

# Three.js

Guidance for building 3D scenes with three.js, a JavaScript/TypeScript library for
real-time graphics in the browser.

## What it is

Three.js is a **library, not an editor-based engine** — there's no separate authoring
application or scene-file format to open. You write JavaScript/TypeScript that builds a
scene graph and hands frames to the GPU via **WebGL** (the default `WebGLRenderer`) or
**WebGPU** (the newer `WebGPURenderer`). Everything lives in your web app's source and
bundler, same as any other npm dependency.

## Core objects

| Object | Role |
|---|---|
| `THREE.Scene` | Root container — a graph of everything that can be rendered. |
| `THREE.PerspectiveCamera(fov, aspect, near, far)` | The viewpoint; `aspect` must track the canvas size. |
| `THREE.WebGLRenderer` | Owns the `<canvas>` and draws `scene` from `camera`'s POV each frame. |
| `THREE.Mesh(geometry, material)` | A drawable object — `geometry` is vertex/shape data, `material` is how it's shaded/lit. |
| `THREE.Light` subclasses | `AmbientLight`, `DirectionalLight`, `PointLight` — most materials (`MeshStandardMaterial`, etc.) need at least one to be visible. |

The render loop is driven by `requestAnimationFrame`, not a fixed engine tick — you own
timing, physics stepping, and input polling yourself.

## Minimal scene

```js
import * as THREE from "three";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x4488ff })
);
scene.add(cube);
scene.add(new THREE.DirectionalLight(0xffffff, 1).translateZ(3));

function animate() {
  requestAnimationFrame(animate);
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
}
animate();
```

## Common tasks

- **Load models**: `GLTFLoader` (from `three/examples/jsm/loaders/GLTFLoader.js`) for `.glb`/`.gltf` — the standard interchange format; loading is async, always `await` or use the callback before touching the result.
- **Lighting**: combine an `AmbientLight` (fill) with a `DirectionalLight` or `PointLight` (shape/shadow); enable `renderer.shadowMap.enabled` and per-light/mesh `castShadow`/`receiveShadow` for shadows.
- **Camera controls**: `OrbitControls` (from `three/examples/jsm/controls/OrbitControls.js`) for mouse-drag orbit/zoom/pan around a target.
- **Handle resize**: listen for `window.resize`, update `camera.aspect`, call `camera.updateProjectionMatrix()`, then `renderer.setSize(...)`.
- **Picking**: `THREE.Raycaster` cast from the camera through normalized device coordinates (`-1..1`) derived from the mouse/pointer position, then `raycaster.intersectObjects(scene.children)`.

## Gotchas

- **Dispose GPU resources explicitly.** Removing a mesh from the scene does not free GPU
  memory — call `.dispose()` on geometries, materials, and textures when an object is
  permanently gone, or you'll leak VRAM over a long session.
- **Resize correctly.** Forgetting `setPixelRatio` makes high-DPI displays render blurry;
  forgetting `updateProjectionMatrix()` after changing `aspect` distorts the scene.
- **Loading is asynchronous.** Loaders (`GLTFLoader`, `TextureLoader`) return before the
  asset is ready — don't reference geometry/material data before the load callback/promise
  resolves.
- **One renderer, one canvas, one render loop.** Spinning up a second `WebGLRenderer` for
  the same view (e.g. on a React re-mount without cleanup) doubles GPU work and leaks
  contexts — tear down the old one first.

## TycoonAgents integration

Three.js is a web library with no Studio/Editor process to attach to, so it does **not**
get a TycoonAgents engine connection chip the way Roblox or UEFN do. Route three.js work
(scene code, shaders, render-loop changes) through the **ux-ui-designer** agent when it's
UI/visual-facing, or **coding-specialist** for general implementation — it typically runs
inside a standard web/frontend build, not a dedicated game-engine pipeline.
