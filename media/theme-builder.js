"use strict";
(() => {
  // src/webview/themeBuilder.ts
  var worldState = {
    current_mode: "MODE_IDLE",
    active_build_target_id: null,
    build_progress_units: 0,
    active_rivals: []
  };
  var activeManifest = null;
  var frameCache = /* @__PURE__ */ new Map();
  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  var is_editor_mode = false;
  var placed_props = [];
  var draggedPropId = null;
  var mouseX = 0;
  var mouseY = 0;
  var isValidPlacement = false;
  var listeners = [];
  function subscribeToState(listener) {
    listeners.push(listener);
    listener(worldState);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx > -1) listeners.splice(idx, 1);
    };
  }
  function updateState(updater) {
    worldState = updater(worldState);
    listeners.forEach((l) => l(worldState));
  }
  var CANVAS_WIDTH = 1280;
  var CANVAS_HEIGHT = 720;
  var SPEED = 2;
  var NAV_AREA = {
    minX: 100,
    maxX: 1180,
    minY: 400,
    maxY: 680
  };
  var NAV_POLYGON = [
    [300, 400],
    [980, 400],
    [1180, 600],
    [980, 680],
    [300, 680],
    [100, 600]
  ];
  var TANK_POS = { x: 510, y: 440 };
  var TANK_EXCLUSION_RADIUS = 52;
  var renderQueue = [];
  var ctx = null;
  var animationFrameId;
  var frameCount = 0;
  function distance(x1, y1, x2, y2) {
    return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  }
  function isPointInPolygon(point, vs) {
    const x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i][0], yi = vs[i][1];
      const xj = vs[j][0], yj = vs[j][1];
      const intersect = yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function getRandomNavPoint() {
    let x = 0, y = 0;
    let valid = false;
    while (!valid) {
      x = Math.random() * (NAV_AREA.maxX - NAV_AREA.minX) + NAV_AREA.minX;
      y = Math.random() * (NAV_AREA.maxY - NAV_AREA.minY) + NAV_AREA.minY;
      if (isPointInPolygon([x, y], NAV_POLYGON) && distance(x, y, TANK_POS.x, TANK_POS.y) > TANK_EXCLUSION_RADIUS) {
        valid = true;
      }
    }
    return { x, y };
  }
  function getPointOnTankRing() {
    const angle = Math.random() * Math.PI * 2;
    const radius = TANK_EXCLUSION_RADIUS + 1;
    return {
      x: TANK_POS.x + Math.cos(angle) * radius,
      y: TANK_POS.y + Math.sin(angle) * radius
    };
  }
  function renderLoop() {
    if (!ctx) return;
    frameCount++;
    if (frameCount % 60 === 0) {
      const isIdle = worldState.active_build_target_id === null && worldState.active_rivals.length === 0;
      if (isIdle) {
        for (const obj of renderQueue) {
          if (obj.type === "agent" && Math.random() < 0.08) {
            obj.current_emote = Math.random() < 0.5 ? "emote_smile" : "emote_sleep";
            obj.emote_timer = 180;
          }
        }
      }
    }
    if (worldState.active_rivals.length > 0) {
      for (const obj of renderQueue) {
        if (obj.type === "agent") {
          obj.current_emote = "emote_team";
          obj.emote_timer = 2;
        }
      }
    }
    for (const obj of renderQueue) {
      if (obj.type === "agent" && obj.targetX !== void 0 && obj.targetY !== void 0) {
        const cx = obj.x + obj.width / 2;
        const cy = obj.y + obj.height / 2;
        const dist = distance(cx, cy, obj.targetX, obj.targetY);
        if (dist > SPEED) {
          const dx = obj.targetX - cx;
          const dy = obj.targetY - cy;
          const nx = dx / dist;
          const ny = dy / dist;
          obj.x += nx * SPEED;
          obj.y += ny * SPEED;
        } else {
          if (worldState.active_build_target_id !== "hiss_tank") {
            const pt = getRandomNavPoint();
            obj.targetX = pt.x;
            obj.targetY = pt.y;
          } else {
            if (obj.current_emote !== "emote_idea") {
              obj.current_emote = "emote_idea";
              obj.emote_timer = 120;
            }
          }
        }
      }
    }
    renderQueue.sort((a, b) => a.y + a.height - (b.y + b.height));
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (frameCache.has("environment_background")) {
      const bgFrames = frameCache.get("environment_background");
      if (bgFrames.length > 0) {
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        const background = bgFrames[0];
        const scale = Math.min(CANVAS_WIDTH / background.width, CANVAS_HEIGHT / background.height);
        const width = background.width * scale;
        const height = background.height * scale;
        ctx.drawImage(background, (CANVAS_WIDTH - width) / 2, (CANVAS_HEIGHT - height) / 2, width, height);
      } else {
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    } else {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    if (is_editor_mode) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "#00ffff";
      ctx.beginPath();
      for (let i = 0; i < NAV_POLYGON.length; i++) {
        const p = NAV_POLYGON[i];
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(255, 165, 0, 0.8)";
      for (const obj of renderQueue) {
        if (obj.type === "object") {
          ctx.beginPath();
          const radius = obj.id === "hiss_tank" ? TANK_EXCLUSION_RADIUS : 32;
          ctx.arc(obj.x + obj.width / 2, obj.y + obj.height / 2, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    } else {
      ctx.strokeStyle = "#222";
      ctx.beginPath();
      for (let i = 0; i < NAV_POLYGON.length; i++) {
        const p = NAV_POLYGON[i];
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.stroke();
    }
    for (const obj of renderQueue) {
      let drawnFromAtlas = false;
      if (obj.atlas_asset && obj.atlas_asset.includes("#")) {
        const key = obj.atlas_asset.split("#")[1];
        const frames = frameCache.get(key);
        if (frames && frames.length > 0) {
          const frameIndex = obj.type === "object" ? frames.length - 1 : Math.floor(frameCount / 5) % frames.length;
          ctx.drawImage(frames[frameIndex], obj.x, obj.y, obj.width, obj.height);
          drawnFromAtlas = true;
        }
      }
      if (!drawnFromAtlas) {
        ctx.fillStyle = obj.color;
        ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
        ctx.strokeStyle = "black";
        ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
      }
      if (obj.current_emote !== null && obj.emote_timer > 0) {
        const bubbleX = obj.x + obj.width / 2;
        const bubbleY = obj.y - 22;
        ctx.beginPath();
        ctx.arc(bubbleX, bubbleY, 16, 0, Math.PI * 2);
        ctx.fillStyle = "white";
        ctx.fill();
        ctx.strokeStyle = "#333";
        ctx.stroke();
        const emoteFrames = frameCache.get(obj.current_emote);
        if (emoteFrames && emoteFrames.length > 0) {
          const emoteFrame = emoteFrames[Math.floor(frameCount / 5) % emoteFrames.length];
          ctx.drawImage(emoteFrame, bubbleX - 14, bubbleY - 14, 28, 28);
        } else {
          ctx.fillStyle = "black";
          ctx.font = "12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("?", bubbleX, bubbleY);
        }
        obj.emote_timer--;
        if (obj.emote_timer <= 0) {
          obj.current_emote = null;
        }
      }
    }
    if (is_editor_mode && draggedPropId) {
      ctx.fillStyle = isValidPlacement ? "rgba(0, 255, 0, 0.4)" : "rgba(255, 0, 0, 0.4)";
      ctx.fillRect(mouseX - 32, mouseY - 32, 64, 64);
    }
    animationFrameId = requestAnimationFrame(renderLoop);
  }
  function handleKeyDown(e) {
    if (e.code === "Space") {
      e.preventDefault();
      const newTarget = worldState.active_build_target_id === "hiss_tank" ? null : "hiss_tank";
      updateState((s) => ({
        ...s,
        active_build_target_id: newTarget
      }));
    }
  }
  var isInitialized = false;
  var unsubscribe = null;
  function rebuildRenderQueue() {
    renderQueue = [];
    const generatedTarget = activeManifest?.buildable_objects?.[0];
    renderQueue.push({
      id: "hiss_tank",
      type: "object",
      x: TANK_POS.x - 48,
      y: TANK_POS.y - 48,
      width: 96,
      height: 96,
      color: "#333333",
      atlas_asset: generatedTarget?.sprite_asset,
      current_emote: null,
      emote_timer: 0
    });
    if (activeManifest) {
      if (activeManifest.roster_agents) {
        activeManifest.roster_agents.forEach((agent) => {
          const pt = getRandomNavPoint();
          renderQueue.push({
            id: `agent_${agent.slot_id}`,
            type: "agent",
            x: pt.x - 32,
            y: pt.y - 32,
            width: 64,
            height: 64,
            color: "cyan",
            atlas_asset: agent.atlas_asset,
            targetX: pt.x,
            targetY: pt.y,
            current_emote: null,
            emote_timer: 0
          });
        });
      }
      if (activeManifest.roster_rivals) {
        activeManifest.roster_rivals.forEach((rival) => {
          const pt = getRandomNavPoint();
          const key = rival.rival_id.startsWith("rival_") ? rival.rival_id : `rival_${rival.rival_id}`;
          renderQueue.push({
            id: key,
            type: "agent",
            x: pt.x - 32,
            y: pt.y - 32,
            width: 64,
            height: 64,
            color: "crimson",
            atlas_asset: rival.atlas_asset,
            targetX: pt.x,
            targetY: pt.y,
            current_emote: null,
            emote_timer: 0
          });
        });
      }
    } else {
      const agentColors = ["cyan", "gold", "crimson"];
      for (let i = 0; i < 3; i++) {
        const pt = getRandomNavPoint();
        renderQueue.push({
          id: `agent_${i}`,
          type: "agent",
          x: pt.x - 32,
          y: pt.y - 32,
          width: 64,
          height: 64,
          color: agentColors[i],
          targetX: pt.x,
          targetY: pt.y,
          current_emote: null,
          emote_timer: 0
        });
      }
    }
  }
  function refreshPropPalette() {
    const palette = document.querySelector("#prop-palette");
    if (!palette || !activeManifest?.buildable_objects?.length) return;
    palette.innerHTML = "";
    for (const object of activeManifest.buildable_objects) {
      const item = document.createElement("li");
      item.setAttribute("data-id", object.object_id);
      item.setAttribute("data-name", object.display_name);
      item.setAttribute("draggable", "true");
      item.textContent = object.display_name;
      palette.appendChild(item);
    }
  }
  function initThemeBuilder(containerElement) {
    if (isInitialized) return;
    isInitialized = true;
    containerElement.innerHTML = `
    <div class="tycoon-container">
      <header class="hud-overlay" id="tb-hud">
        <h2>Project Theme Tycoon</h2>
        <div class="hud-stats" id="tb-stats">
          <!-- Populated dynamically -->
        </div>
        <button id="toggle-editor-btn" style="margin-top:8px;">Toggle Level Editor</button>
      </header>

      <div id="editor-overlay" class="editor-panel" hidden>
        <h3>Prop Palette</h3>
        <ul id="prop-palette">
          <li data-id="hiss_tank" data-name="H.I.S.S. Tank" draggable="true">H.I.S.S. Tank</li>
          <li data-id="command_desk" data-name="Command Desk" draggable="true">Command Desk</li>
          <li data-id="server_col" data-name="Server Column" draggable="true">Server Column</li>
        </ul>
        <button id="export-manifest-btn">Export Manifest JSON</button>
      </div>

      <div class="canvas-wrapper">
        <canvas class="tycoon-canvas" id="tb-canvas"></canvas>
      </div>
    </div>
  `;
    const canvasElement = containerElement.querySelector("#tb-canvas");
    canvasElement.width = CANVAS_WIDTH;
    canvasElement.height = CANVAS_HEIGHT;
    ctx = canvasElement.getContext("2d");
    if (!ctx) {
      console.error("Failed to get 2D context");
      return;
    }
    rebuildRenderQueue();
    const statsEl = containerElement.querySelector("#tb-stats");
    unsubscribe = subscribeToState((state) => {
      const isSwarming = state.active_build_target_id === "hiss_tank";
      for (const obj of renderQueue) {
        if (obj.type === "agent") {
          if (isSwarming) {
            const pt = getPointOnTankRing();
            obj.targetX = pt.x;
            obj.targetY = pt.y;
          } else {
            const pt = getRandomNavPoint();
            obj.targetX = pt.x;
            obj.targetY = pt.y;
          }
        }
      }
      if (statsEl) {
        statsEl.innerHTML = `
        <p>Mode: ${state.current_mode}</p>
        ${state.active_build_target_id ? `<p>Target: ${state.active_build_target_id}</p><p>Progress: 0.0%</p>` : `<p>Target: None (Press Spacebar to toggle build site)</p>`}
      `;
      }
    });
    const editorOverlay = containerElement.querySelector("#editor-overlay");
    const toggleEditorBtn = containerElement.querySelector("#toggle-editor-btn");
    toggleEditorBtn?.addEventListener("click", () => {
      is_editor_mode = !is_editor_mode;
      if (is_editor_mode) {
        editorOverlay?.removeAttribute("hidden");
      } else {
        editorOverlay?.setAttribute("hidden", "");
      }
    });
    function getCanvasPos(evt) {
      const rect = canvasElement.getBoundingClientRect();
      const scaleX = canvasElement.width / rect.width;
      const scaleY = canvasElement.height / rect.height;
      return {
        x: (evt.clientX - rect.left) * scaleX,
        y: (evt.clientY - rect.top) * scaleY
      };
    }
    refreshPropPalette();
    const propPalette = containerElement.querySelector("#prop-palette");
    propPalette?.addEventListener("dragstart", (event) => {
      const e = event;
      const target = e.target.closest("[data-id]");
      draggedPropId = target?.getAttribute("data-id") ?? null;
      e.dataTransfer?.setData("text/plain", draggedPropId || "");
    });
    propPalette?.addEventListener("dragend", () => {
      draggedPropId = null;
    });
    canvasElement.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!draggedPropId) return;
      const pos = getCanvasPos(e);
      mouseX = pos.x;
      mouseY = pos.y;
      isValidPlacement = isPointInPolygon([mouseX, mouseY], NAV_POLYGON);
    });
    canvasElement.addEventListener("drop", (e) => {
      e.preventDefault();
      if (isValidPlacement && draggedPropId && is_editor_mode) {
        const normX = mouseX / CANVAS_WIDTH;
        const normY = mouseY / CANVAS_HEIGHT;
        const generatedDefinition = activeManifest?.buildable_objects?.find(
          (object) => object.object_id === draggedPropId
        );
        const newProp = generatedDefinition ? {
          ...generatedDefinition,
          build_order: placed_props.length,
          anchor_coord: [normX, normY]
        } : {
          build_order: placed_props.length,
          object_id: draggedPropId,
          display_name: draggedPropId.replace("_", " "),
          sprite_asset: `assets/${draggedPropId}.png`,
          anchor_coord: [normX, normY],
          exclusion_radius: 32,
          work_units_required: 100
        };
        placed_props.push(newProp);
        renderQueue.push({
          id: `${draggedPropId}_${Date.now()}`,
          type: "object",
          x: mouseX - 32,
          y: mouseY - 32,
          width: 64,
          height: 64,
          color: "#888",
          atlas_asset: newProp.sprite_asset,
          current_emote: null,
          emote_timer: 0
        });
      }
      draggedPropId = null;
    });
    const exportBtn = containerElement.querySelector("#export-manifest-btn");
    exportBtn?.addEventListener("click", () => {
      const manifest = {
        manifest_version: "1.0.0",
        theme_id: "custom_theme",
        display_name: "Custom Theme",
        author: "Theme Builder",
        viewport: {
          native_width: CANVAS_WIDTH,
          native_height: CANVAS_HEIGHT,
          background_asset: "bg.png",
          walkable_nav_polygon: NAV_POLYGON
        },
        roster_agents: [],
        roster_rivals: [],
        buildable_objects: placed_props,
        badges: []
      };
      if (vscode) {
        vscode.postMessage({ type: "EXPORT_THEME_MANIFEST", payload: JSON.stringify(manifest, null, 2) });
      } else {
        window.parent.postMessage({ type: "EXPORT_THEME_MANIFEST", payload: JSON.stringify(manifest, null, 2) }, "*");
      }
      console.log("Exported Manifest:", manifest);
    });
    window.addEventListener("keydown", handleKeyDown);
    cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(renderLoop);
    if (vscode) {
      vscode.postMessage({ type: "THEME_REQUEST" });
    } else {
      window.parent.postMessage({ type: "THEME_REQUEST" }, "*");
    }
  }
  function cleanupThemeBuilder() {
    if (!isInitialized) return;
    window.removeEventListener("keydown", handleKeyDown);
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }
    if (unsubscribe) unsubscribe();
    isInitialized = false;
  }
  window.initThemeBuilder = initThemeBuilder;
  window.cleanupThemeBuilder = cleanupThemeBuilder;
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "THEME_INITIALIZED") {
      const payload = message.payload;
      if (payload.manifest) activeManifest = payload.manifest;
      if (payload.is_editor_mode !== void 0) {
        is_editor_mode = payload.is_editor_mode;
        const editorOverlay = document.querySelector("#editor-overlay");
        if (editorOverlay) {
          if (is_editor_mode) editorOverlay.removeAttribute("hidden");
          else editorOverlay.setAttribute("hidden", "true");
        }
      }
      frameCache.clear();
      const framesMap = payload.frames || {};
      for (const key of Object.keys(framesMap)) {
        const dataUris = framesMap[key];
        const images = [];
        for (const uri of dataUris) {
          const img = new Image();
          img.src = uri;
          images.push(img);
        }
        frameCache.set(key, images);
      }
      rebuildRenderQueue();
      refreshPropPalette();
    }
  });
})();
