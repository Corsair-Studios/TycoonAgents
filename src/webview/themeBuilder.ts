import { WorldState, BuildableObject, ThemeManifest } from '../shared/types';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export let worldState: WorldState = {
  current_mode: 'MODE_IDLE',
  active_build_target_id: null,
  build_progress_units: 0,
  active_rivals: []
};

export let activeManifest: ThemeManifest | null = null;
export const frameCache: Map<string, HTMLImageElement[]> = new Map();

declare const acquireVsCodeApi: any;
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

export let is_editor_mode = false;
export let placed_props: BuildableObject[] = [];

let draggedPropId: string | null = null;
let mouseX = 0;
let mouseY = 0;
let isValidPlacement = false;

type StateListener = (state: WorldState) => void;
const listeners: StateListener[] = [];

export function subscribeToState(listener: StateListener) {
  listeners.push(listener);
  listener(worldState); // Initial call
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx > -1) listeners.splice(idx, 1);
  };
}

export function updateState(updater: (state: WorldState) => WorldState) {
  worldState = updater(worldState);
  listeners.forEach(l => l(worldState));
}

// ============================================================================
// CANVAS RENDERER & NAV PATHFINDER
// ============================================================================

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const SPEED = 2.0;

const NAV_AREA = {
  minX: 100,
  maxX: 1180,
  minY: 400,
  maxY: 680
};

const NAV_POLYGON: [number, number][] = [
  [300, 400],
  [980, 400],
  [1180, 600],
  [980, 680],
  [300, 680],
  [100, 600]
];

const TANK_POS = { x: 510, y: 440 };
const TANK_EXCLUSION_RADIUS = 52;

interface Renderable {
  id: string;
  type: 'agent' | 'object';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  atlas_asset?: string;
  targetX?: number;
  targetY?: number;
  current_emote: string | null;
  emote_timer: number;
}

let renderQueue: Renderable[] = [];
let ctx: CanvasRenderingContext2D | null = null;
let animationFrameId: number;
let frameCount = 0;

function distance(x1: number, y1: number, x2: number, y2: number) {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

function isPointInPolygon(point: [number, number], vs: [number, number][]) {
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getRandomNavPoint(): { x: number; y: number } {
  let x = 0, y = 0;
  let valid = false;
  
  while (!valid) {
    x = Math.random() * (NAV_AREA.maxX - NAV_AREA.minX) + NAV_AREA.minX;
    y = Math.random() * (NAV_AREA.maxY - NAV_AREA.minY) + NAV_AREA.minY;
    
    // Check polygon bounds and collision rejection rule
    if (isPointInPolygon([x, y], NAV_POLYGON) && distance(x, y, TANK_POS.x, TANK_POS.y) > TANK_EXCLUSION_RADIUS) {
      valid = true;
    }
  }
  
  return { x, y };
}

function getPointOnTankRing(): { x: number; y: number } {
  // Random angle
  const angle = Math.random() * Math.PI * 2;
  // +1 to ensure they are on the outer edge, avoiding float rounding issues triggering rejection
  const radius = TANK_EXCLUSION_RADIUS + 1; 
  return {
    x: TANK_POS.x + Math.cos(angle) * radius,
    y: TANK_POS.y + Math.sin(angle) * radius
  };
}

function renderLoop() {
  if (!ctx) return;
  
  frameCount++;
  
  // Epiphany Roll (8% chance every 60 frames for idle agents)
  if (frameCount % 60 === 0) {
    const isIdle = worldState.active_build_target_id === null && worldState.active_rivals.length === 0;
    if (isIdle) {
      for (const obj of renderQueue) {
        if (obj.type === 'agent' && Math.random() < 0.08) {
          obj.current_emote = Math.random() < 0.5 ? 'emote_smile' : 'emote_sleep';
          obj.emote_timer = 180;
        }
      }
    }
  }

  // Combat Override
  if (worldState.active_rivals.length > 0) {
    for (const obj of renderQueue) {
      if (obj.type === 'agent') {
        obj.current_emote = 'emote_team';
        obj.emote_timer = 2; // Keep alive while in combat
      }
    }
  }

  // 1. Update Pathfinding (LERP / Step towards target)
  for (const obj of renderQueue) {
    if (obj.type === 'agent' && obj.targetX !== undefined && obj.targetY !== undefined) {
      // Aim the center of the agent at the target
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
        // Reached target
        if (worldState.active_build_target_id !== 'hiss_tank') {
          // Pick a new idle point
          const pt = getRandomNavPoint();
          obj.targetX = pt.x;
          obj.targetY = pt.y;
        } else {
          // Construct Override: trigger emote_idea upon arrival at perimeter
          if (obj.current_emote !== 'emote_idea') {
             obj.current_emote = 'emote_idea';
             obj.emote_timer = 120;
          }
        }
      }
    }
  }
  
  // 2. Y-Sorting (Painter's Algorithm)
  renderQueue.sort((a, b) => (a.y + a.height) - (b.y + b.height));
  
  // 3. Clear and Draw
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  
  // Draw floor background
  if (frameCache.has('environment_background')) {
    const bgFrames = frameCache.get('environment_background')!;
    if (bgFrames.length > 0) {
      ctx.drawImage(bgFrames[0], 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  
  if (is_editor_mode) {
    // Draw neon-blue dashed NAV_POLYGON
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#00ffff';
    ctx.beginPath();
    for (let i = 0; i < NAV_POLYGON.length; i++) {
      const p = NAV_POLYGON[i];
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw exclusion radii rings for placed props
    ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
    for (const obj of renderQueue) {
      if (obj.type === 'object') {
         ctx.beginPath();
         const radius = obj.id === 'hiss_tank' ? TANK_EXCLUSION_RADIUS : 32;
         ctx.arc(obj.x + obj.width / 2, obj.y + obj.height / 2, radius, 0, Math.PI * 2);
         ctx.stroke();
      }
    }
  } else {
    // Regular bounds display if not in editor mode
    ctx.strokeStyle = '#222';
    ctx.beginPath();
    for (let i = 0; i < NAV_POLYGON.length; i++) {
      const p = NAV_POLYGON[i];
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.stroke();
  }
  
  // Draw renderables
  for (const obj of renderQueue) {
    let drawnFromAtlas = false;
    if (obj.atlas_asset && obj.atlas_asset.includes('#')) {
      const key = obj.atlas_asset.split('#')[1];
      const frames = frameCache.get(key);
      if (frames && frames.length > 0) {
        // Cycle through frames. Use floor(frameCount / 5) for speed throttling
        const frameIndex = Math.floor(frameCount / 5) % frames.length;
        ctx.drawImage(frames[frameIndex], obj.x, obj.y, obj.width, obj.height);
        drawnFromAtlas = true;
      }
    }
    
    if (!drawnFromAtlas) {
      ctx.fillStyle = obj.color;
      ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
      
      // Draw bounding box
      ctx.strokeStyle = 'black';
      ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
    }

    // Emote Bubbles (Head-Space Keying)
    if (obj.current_emote !== null && obj.emote_timer > 0) {
      const bubbleX = obj.x + (obj.width / 2);
      const bubbleY = obj.y - 22; // Offset so top edge is obj.y - 38 roughly (radius 16)

      ctx.beginPath();
      ctx.arc(bubbleX, bubbleY, 16, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.stroke();

      // Placeholder icon/text inside bubble
      ctx.fillStyle = 'black';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      let symbol = '?';
      if (obj.current_emote === 'emote_smile') symbol = ':)';
      else if (obj.current_emote === 'emote_sleep') symbol = 'Zz';
      else if (obj.current_emote === 'emote_idea') symbol = '!';
      else if (obj.current_emote === 'emote_team') symbol = '⚔';
      
      ctx.fillText(symbol, bubbleX, bubbleY);

      obj.emote_timer--;
      if (obj.emote_timer <= 0) {
        obj.current_emote = null;
      }
    }
  }

  // Draw Ghost Prop in Editor Mode
  if (is_editor_mode && draggedPropId) {
    ctx.fillStyle = isValidPlacement ? 'rgba(0, 255, 0, 0.4)' : 'rgba(255, 0, 0, 0.4)';
    ctx.fillRect(mouseX - 32, mouseY - 32, 64, 64);
  }
  
  animationFrameId = requestAnimationFrame(renderLoop);
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.code === 'Space') {
    e.preventDefault(); 
    const newTarget = worldState.active_build_target_id === 'hiss_tank' ? null : 'hiss_tank';
    
    updateState(s => ({
      ...s,
      active_build_target_id: newTarget
    }));
  }
}

let isInitialized = false;
let unsubscribe: (() => void) | null = null;

export function rebuildRenderQueue() {
  renderQueue = [];
  
  // 1. Mock H.I.S.S. Tank
  renderQueue.push({
    id: 'hiss_tank',
    type: 'object',
    x: TANK_POS.x - 48,
    y: TANK_POS.y - 48,
    width: 96,
    height: 96,
    color: '#333333',
    current_emote: null,
    emote_timer: 0
  });
  
  if (activeManifest) {
    if (activeManifest.roster_agents) {
      activeManifest.roster_agents.forEach(agent => {
        const pt = getRandomNavPoint();
        renderQueue.push({
          id: `agent_${agent.slot_id}`,
          type: 'agent',
          x: pt.x - 32,
          y: pt.y - 32,
          width: 64,
          height: 64,
          color: 'cyan',
          atlas_asset: agent.atlas_asset,
          targetX: pt.x,
          targetY: pt.y,
          current_emote: null,
          emote_timer: 0
        });
      });
    }
    if (activeManifest.roster_rivals) {
      activeManifest.roster_rivals.forEach(rival => {
        const pt = getRandomNavPoint();
        const key = rival.rival_id.startsWith('rival_') ? rival.rival_id : `rival_${rival.rival_id}`;
        renderQueue.push({
          id: key,
          type: 'agent',
          x: pt.x - 32,
          y: pt.y - 32,
          width: 64,
          height: 64,
          color: 'crimson',
          atlas_asset: rival.atlas_asset,
          targetX: pt.x,
          targetY: pt.y,
          current_emote: null,
          emote_timer: 0
        });
      });
    }
  } else {
    // 2. Mock Agents
    const agentColors = ['cyan', 'gold', 'crimson'];
    for (let i = 0; i < 3; i++) {
      const pt = getRandomNavPoint();
      renderQueue.push({
        id: `agent_${i}`,
        type: 'agent',
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

export function initThemeBuilder(containerElement: HTMLElement) {
  if (isInitialized) return;
  isInitialized = true;

  // Setup DOM structure
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

  const canvasElement = containerElement.querySelector('#tb-canvas') as HTMLCanvasElement;
  canvasElement.width = CANVAS_WIDTH;
  canvasElement.height = CANVAS_HEIGHT;
  ctx = canvasElement.getContext('2d');
  
  if (!ctx) {
    console.error("Failed to get 2D context");
    return;
  }

  rebuildRenderQueue();

  const statsEl = containerElement.querySelector('#tb-stats');

  // Handle world state changes for pathfinding targets and UI
  unsubscribe = subscribeToState(state => {
    const isSwarming = state.active_build_target_id === 'hiss_tank';
    
    for (const obj of renderQueue) {
      if (obj.type === 'agent') {
        if (isSwarming) {
          const pt = getPointOnTankRing();
          obj.targetX = pt.x;
          obj.targetY = pt.y;
        } else {
          // Returning to idle, give new random target
          const pt = getRandomNavPoint();
          obj.targetX = pt.x;
          obj.targetY = pt.y;
        }
      }
    }

    if (statsEl) {
      statsEl.innerHTML = `
        <p>Mode: ${state.current_mode}</p>
        ${state.active_build_target_id 
          ? `<p>Target: ${state.active_build_target_id}</p><p>Progress: 0.0%</p>` 
          : `<p>Target: None (Press Spacebar to toggle build site)</p>`
        }
      `;
    }
  });

  // Editor Mode UI Toggles
  const editorOverlay = containerElement.querySelector('#editor-overlay');
  const toggleEditorBtn = containerElement.querySelector('#toggle-editor-btn');
  toggleEditorBtn?.addEventListener('click', () => {
    is_editor_mode = !is_editor_mode;
    if (is_editor_mode) {
      editorOverlay?.removeAttribute('hidden');
    } else {
      editorOverlay?.setAttribute('hidden', '');
    }
  });

  // Drag and Drop Logic
  function getCanvasPos(evt: DragEvent) {
    const rect = canvasElement.getBoundingClientRect();
    const scaleX = canvasElement.width / rect.width;
    const scaleY = canvasElement.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY
    };
  }

  const paletteItems = containerElement.querySelectorAll('#prop-palette li');
  paletteItems.forEach(item => {
    item.addEventListener('dragstart', (e: any) => {
      draggedPropId = (e.target as HTMLElement).getAttribute('data-id');
      e.dataTransfer?.setData('text/plain', draggedPropId || '');
    });
    item.addEventListener('dragend', () => {
      draggedPropId = null;
    });
  });

  canvasElement.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!draggedPropId) return;
    const pos = getCanvasPos(e);
    mouseX = pos.x;
    mouseY = pos.y;
    isValidPlacement = isPointInPolygon([mouseX, mouseY], NAV_POLYGON);
  });

  canvasElement.addEventListener('drop', (e) => {
    e.preventDefault();
    if (isValidPlacement && draggedPropId && is_editor_mode) {
      const normX = mouseX / CANVAS_WIDTH;
      const normY = mouseY / CANVAS_HEIGHT;
      
      const newProp: BuildableObject = {
        build_order: placed_props.length,
        object_id: draggedPropId,
        display_name: draggedPropId.replace('_', ' '),
        sprite_asset: `assets/${draggedPropId}.png`,
        anchor_coord: [normX, normY],
        exclusion_radius: 32,
        work_units_required: 100
      };
      placed_props.push(newProp);

      renderQueue.push({
        id: `${draggedPropId}_${Date.now()}`,
        type: 'object',
        x: mouseX - 32,
        y: mouseY - 32,
        width: 64,
        height: 64,
        color: '#888',
        current_emote: null,
        emote_timer: 0
      });
    }
    draggedPropId = null;
  });

  // Manifest Export
  const exportBtn = containerElement.querySelector('#export-manifest-btn');
  exportBtn?.addEventListener('click', () => {
    const manifest: ThemeManifest = {
      manifest_version: '1.0.0',
      theme_id: 'custom_theme',
      display_name: 'Custom Theme',
      author: 'Theme Builder',
      viewport: {
        native_width: CANVAS_WIDTH,
        native_height: CANVAS_HEIGHT,
        background_asset: 'bg.png',
        walkable_nav_polygon: NAV_POLYGON
      },
      roster_agents: [],
      roster_rivals: [],
      buildable_objects: placed_props,
      badges: []
    };
    if (vscode) {
      vscode.postMessage({ type: 'EXPORT_THEME_MANIFEST', payload: JSON.stringify(manifest, null, 2) });
    } else {
      window.parent.postMessage({ type: 'EXPORT_THEME_MANIFEST', payload: JSON.stringify(manifest, null, 2) }, '*');
    }
    console.log("Exported Manifest:", manifest);
  });

  // Attach Spacebar Event Listener
  window.addEventListener('keydown', handleKeyDown);

  // Start loop
  cancelAnimationFrame(animationFrameId);
  animationFrameId = requestAnimationFrame(renderLoop);
  
  // Request theme state from host
  if (vscode) {
    vscode.postMessage({ type: 'THEME_REQUEST' });
  } else {
    window.parent.postMessage({ type: 'THEME_REQUEST' }, '*');
  }
}

export function cleanupThemeBuilder() {
  if (!isInitialized) return;
  window.removeEventListener('keydown', handleKeyDown);
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  if (unsubscribe) unsubscribe();
  isInitialized = false;
}

// Bind to window so main.js can access it
(window as any).initThemeBuilder = initThemeBuilder;
(window as any).cleanupThemeBuilder = cleanupThemeBuilder;

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'THEME_INITIALIZED') {
    const payload = message.payload;
    if (payload.manifest) activeManifest = payload.manifest;
    
    if (payload.is_editor_mode !== undefined) {
      is_editor_mode = payload.is_editor_mode;
      const editorOverlay = document.querySelector('#editor-overlay') as HTMLElement;
      if (editorOverlay) {
        if (is_editor_mode) editorOverlay.removeAttribute('hidden');
        else editorOverlay.setAttribute('hidden', 'true');
      }
    }
    
    // Clear and rebuild frame cache
    frameCache.clear();
    const framesMap = payload.frames || {};
    for (const key of Object.keys(framesMap)) {
      const dataUris = framesMap[key];
      const images: HTMLImageElement[] = [];
      for (const uri of dataUris) {
        const img = new Image();
        img.src = uri;
        images.push(img);
      }
      frameCache.set(key, images);
    }
    
    // Rebuild render queue
    rebuildRenderQueue();
  }
});
