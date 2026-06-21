/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

// Canvas renderer for TycoonAgents webview.
// Receives WorldState from the VS Code extension host via postMessage.

(function () {
  const vscode = acquireVsCodeApi();

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("stage"));
  const ctx = canvas.getContext("2d");

  // Worker color by state
  const STATE_COLOR = {
    arrive:    "#7fb3ff",
    walk:      "#5fd06b",
    build:     "#ff9a3c",
    haul:      "#c08457",
    survey:    "#39c2c2",
    wait:      "#9a9a9a",
    celebrate: "#ffd23c",
    leave:     "rgba(150,150,150,0.45)",
  };

  /** @type {{ sessionActive: boolean; workers: Record<string, { id: string; role?: string; state: string }>; completedTasks: number }} */
  let state = { sessionActive: false, workers: {}, completedTasks: 0 };

  // Stable insertion-order tracking so x positions don't jump
  /** @type {string[]} */
  const workerOrder = [];

  let frame = 0;

  function resize() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }

  window.addEventListener("resize", resize);
  resize();

  // Tell the extension we're ready; it will push the current state back
  vscode.postMessage({ type: "ready" });

  window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    const msg = event.data;
    if (msg && msg.type === "state") {
      state = msg.state;
      // Maintain insertion order for stable x positions
      for (const id of Object.keys(state.workers)) {
        if (!workerOrder.includes(id)) {
          workerOrder.push(id);
        }
      }
      // Remove workers no longer in state
      for (let i = workerOrder.length - 1; i >= 0; i--) {
        if (!state.workers[workerOrder[i]]) {
          workerOrder.splice(i, 1);
        }
      }
    }
  });

  function drawWorker(x, groundY, worker, idx) {
    const color = STATE_COLOR[worker.state] || "#9a9a9a";
    const isLeave = worker.state === "leave";

    // Per-frame motion
    let bobY = 0;
    let wobbleX = 0;

    if (worker.state === "celebrate") {
      // Bounce
      bobY = -Math.abs(Math.sin(frame * 0.18 + idx) * 14);
    } else if (worker.state === "build") {
      // Quick hammer wobble
      wobbleX = Math.sin(frame * 0.4 + idx) * 3;
      bobY = Math.abs(Math.sin(frame * 0.4 + idx) * 2) - 2;
    } else if (worker.state === "walk" || worker.state === "arrive") {
      // Gentle walk bob
      bobY = Math.sin(frame * 0.15 + idx) * 3;
    } else {
      // Idle sway
      bobY = Math.sin(frame * 0.08 + idx) * 1.5;
    }

    ctx.save();
    if (isLeave) ctx.globalAlpha = 0.45;

    const cx = x + wobbleX;
    const bodyTop = groundY - 36 + bobY;
    const bodyH = 22;
    const bodyW = 14;

    // Body rect
    ctx.fillStyle = color;
    ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);

    // Head circle
    const headR = 8;
    const headCy = bodyTop - headR - 2;
    ctx.beginPath();
    ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = "#e0e0e0";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    const label = (worker.role || worker.id).slice(0, 12);
    ctx.fillText(label, cx, groundY + 14);
    ctx.fillText(worker.state, cx, groundY + 26);

    ctx.restore();
  }

  function drawBuildings(groundY, count) {
    if (count === 0) return;
    const maxBuildings = Math.min(count, 20);
    const startX = 20;
    const spacing = 28;
    for (let i = 0; i < maxBuildings; i++) {
      const bx = startX + i * spacing;
      // Heights grow as more tasks complete (capped)
      const bh = Math.min(12 + (count - i) * 3, 60);
      ctx.fillStyle = "#3a4a6a";
      ctx.fillRect(bx, groundY - bh, 20, bh);
      // Windows
      ctx.fillStyle = "#7fb3ff44";
      ctx.fillRect(bx + 4, groundY - bh + 4, 5, 5);
      ctx.fillRect(bx + 11, groundY - bh + 4, 5, 5);
    }
  }

  function drawHUD(w) {
    const sessionText = state.sessionActive ? "active" : "idle";
    const workerCount = Object.keys(state.workers).length;
    const tasks = state.completedTasks;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(8, 8, 220, 68);

    ctx.fillStyle = "#c8d8f0";
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`Session: ${sessionText}`, 16, 28);
    ctx.fillText(`Workers: ${workerCount}`, 16, 46);
    ctx.fillText(`Built: ${tasks}`, 16, 64);
    ctx.restore();
  }

  function render() {
    frame++;
    const w = canvas.width;
    const h = canvas.height;

    // Background
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, w, h);

    // Sky gradient strip
    const grad = ctx.createLinearGradient(0, 0, 0, h * 0.7);
    grad.addColorStop(0, "#0d1b3e");
    grad.addColorStop(1, "#1a2a50");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h * 0.7);

    // Ground band
    const groundY = Math.floor(h * 0.78);
    ctx.fillStyle = "#2a3a2a";
    ctx.fillRect(0, groundY, w, h - groundY);

    // Ground line
    ctx.strokeStyle = "#4a6a4a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(w, groundY);
    ctx.stroke();

    // Buildings (left side)
    drawBuildings(groundY, state.completedTasks);

    // Workers
    const workers = workerOrder
      .map((id) => state.workers[id])
      .filter(Boolean);

    const spacing = Math.min(80, (w - 40) / Math.max(workers.length, 1));
    const startX = Math.max(40, (w - spacing * workers.length) / 2);

    workers.forEach((worker, idx) => {
      const x = startX + idx * spacing;
      drawWorker(x, groundY, worker, idx);
    });

    // HUD overlay
    drawHUD(w);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
