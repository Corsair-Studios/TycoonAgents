/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

// Canvas renderer and panel controller for TycoonAgents webview.
// Receives WorldState from the VS Code extension host via postMessage.

(function () {
  const vscode = acquireVsCodeApi();

  // ── Resize handle: drag to control metrics panel height ─────────

  const metricsPanelEl = /** @type {HTMLElement} */ (document.getElementById("metrics-panel"));
  const resizeHandleEl = /** @type {HTMLElement} */ (document.getElementById("resize-handle"));

  const MIN_METRICS_PX = 44;   // header must always stay visible

  /** Apply a metrics panel height in px, clamped to valid range. */
  function applyMetricsHeight(px) {
    const clamped = Math.max(MIN_METRICS_PX, Math.min(px, window.innerHeight));
    metricsPanelEl.style.setProperty("height", `${clamped}px`);
    return clamped;
  }

  /** Persist the current metrics height into webview state. */
  function saveMetricsHeight(px) {
    const prev = vscode.getState() || {};
    vscode.setState({ ...prev, metricsHeight: px });
  }

  // Restore saved height before first render to avoid a layout flash.
  (function restoreSavedHeight() {
    const saved = vscode.getState();
    if (saved && typeof saved.metricsHeight === "number") {
      applyMetricsHeight(saved.metricsHeight);
    }
  })();

  // Re-clamp saved px height if the window is resized (e.g. sidebar width change).
  window.addEventListener("resize", () => {
    const saved = vscode.getState();
    if (saved && typeof saved.metricsHeight === "number") {
      applyMetricsHeight(saved.metricsHeight);
    }
  });

  // Pointer-drag on the resize handle.
  resizeHandleEl.addEventListener("pointerdown", (e) => {
    resizeHandleEl.setPointerCapture(e.pointerId);
    resizeHandleEl.classList.add("dragging");

    function onMove(ev) {
      // Metrics height = distance from pointer to bottom of viewport.
      const px = window.innerHeight - ev.clientY;
      applyMetricsHeight(px);
    }

    function onUp(ev) {
      const px = window.innerHeight - ev.clientY;
      const clamped = applyMetricsHeight(px);
      saveMetricsHeight(clamped);
      resizeHandleEl.classList.remove("dragging");
      resizeHandleEl.removeEventListener("pointermove", onMove);
      resizeHandleEl.removeEventListener("pointerup", onUp);
    }

    resizeHandleEl.addEventListener("pointermove", onMove);
    resizeHandleEl.addEventListener("pointerup", onUp);
  });

  // ── Hamburger menu: scaffold for future panel actions ───────────

  const menuBtnEl     = /** @type {HTMLElement} */ (document.getElementById("menu-btn"));
  const menuPopoverEl = /** @type {HTMLElement} */ (document.getElementById("menu-popover"));

  function openMenu() {
    menuPopoverEl.removeAttribute("hidden");
    menuBtnEl.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    menuPopoverEl.setAttribute("hidden", "");
    menuBtnEl.setAttribute("aria-expanded", "false");
  }

  menuBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuPopoverEl.hasAttribute("hidden")) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  // Close on click outside.
  document.addEventListener("click", (e) => {
    if (!menuPopoverEl.hasAttribute("hidden") &&
        !menuPopoverEl.contains(/** @type {Node} */ (e.target)) &&
        e.target !== menuBtnEl) {
      closeMenu();
    }
  });

  // ── Modal helpers (generic: works for any modal element) ────────

  /**
   * Open a modal element and focus its close button.
   * @param {HTMLElement} modalEl
   * @param {HTMLElement} closeBtnEl
   */
  function openModal(modalEl, closeBtnEl) {
    modalEl.removeAttribute("hidden");
    closeBtnEl.focus();
  }

  /**
   * Close a modal element and return focus to the menu button.
   * @param {HTMLElement} modalEl
   */
  function closeModal(modalEl) {
    modalEl.setAttribute("hidden", "");
    menuBtnEl.focus();
  }

  // ── About modal ─────────────────────────────────────────────────

  const aboutModalEl  = /** @type {HTMLElement} */ (document.getElementById("about-modal"));
  const aboutBackdrop = /** @type {HTMLElement} */ (document.getElementById("about-backdrop"));
  const modalCloseBtn = /** @type {HTMLElement} */ (document.getElementById("modal-close"));
  const menuAboutBtn  = /** @type {HTMLElement} */ (document.getElementById("menu-about"));

  menuAboutBtn.addEventListener("click", () => {
    closeMenu();
    openModal(aboutModalEl, modalCloseBtn);
  });

  modalCloseBtn.addEventListener("click", () => {
    closeModal(aboutModalEl);
  });

  aboutBackdrop.addEventListener("click", () => {
    closeModal(aboutModalEl);
  });

  // ── Skills modal ─────────────────────────────────────────────────

  const skillsModalEl   = /** @type {HTMLElement} */ (document.getElementById("skills-modal"));
  const skillsBackdrop  = /** @type {HTMLElement} */ (document.getElementById("skills-backdrop"));
  const skillsCloseBtn  = /** @type {HTMLElement} */ (document.getElementById("skills-modal-close"));
  const menuSkillsBtn   = /** @type {HTMLElement} */ (document.getElementById("menu-skills"));
  const skillsListEl    = /** @type {HTMLElement} */ (document.getElementById("skills-list"));

  menuSkillsBtn.addEventListener("click", () => {
    closeMenu();
    openModal(skillsModalEl, skillsCloseBtn);
    vscode.postMessage({ type: "getSkills" });
  });

  skillsCloseBtn.addEventListener("click", () => {
    closeModal(skillsModalEl);
  });

  skillsBackdrop.addEventListener("click", () => {
    closeModal(skillsModalEl);
  });

  // Close on Escape — modals take priority; skills modal checked first since
  // it was opened more recently, then about modal, then menu.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!skillsModalEl.hasAttribute("hidden")) {
        closeModal(skillsModalEl);
      } else if (!aboutModalEl.hasAttribute("hidden")) {
        closeModal(aboutModalEl);
      } else if (!menuPopoverEl.hasAttribute("hidden")) {
        closeMenu();
        menuBtnEl.focus();
      }
    }
  });

  // ── Skills list install-button handler (event delegation) ────────

  skillsListEl.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target).closest("[data-skill-id]")
    );
    if (!btn || btn.hasAttribute("disabled")) return;
    const id = btn.getAttribute("data-skill-id");
    btn.textContent = "Installing…";
    btn.setAttribute("disabled", "");
    vscode.postMessage({ type: "installSkill", id });
  });

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
      // Update metrics panel
      renderMetrics(state.agentMetrics);
    } else if (msg && msg.type === "skills") {
      renderSkillsList(msg.skills, msg.error);
    } else if (msg && msg.type === "skillInstalled") {
      handleSkillInstalled(msg.id, msg.ok, msg.alreadyExisted, msg.error);
    }
  });

  /**
   * Rebuild #skills-list from the catalog payload.
   * @param {Array<{id:string,name:string,description:string,installed:boolean}>} skills
   * @param {string|undefined} error
   */
  function renderSkillsList(skills, error) {
    skillsListEl.innerHTML = "";
    if (error) {
      const errEl = document.createElement("p");
      errEl.className = "skills-error";
      errEl.textContent = error;
      skillsListEl.appendChild(errEl);
      return;
    }
    if (!skills || skills.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "skills-empty";
      emptyEl.textContent = "No skills available.";
      skillsListEl.appendChild(emptyEl);
      return;
    }
    for (const skill of skills) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.skillRowId = skill.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = skill.name;

      const descEl = document.createElement("span");
      descEl.className = "skill-desc";
      descEl.textContent = skill.description;

      textBlock.appendChild(nameEl);
      textBlock.appendChild(descEl);

      const btn = document.createElement("button");
      btn.className = "skill-btn" + (skill.installed ? " skill-btn--installed" : "");
      if (skill.installed) {
        btn.textContent = "Installed";
        btn.setAttribute("disabled", "");
      } else {
        btn.textContent = "Install";
        btn.setAttribute("data-skill-id", skill.id);
      }

      row.appendChild(textBlock);
      row.appendChild(btn);
      skillsListEl.appendChild(row);
    }
  }

  /**
   * Update a skill row after an install attempt.
   * @param {string} id
   * @param {boolean} ok
   * @param {boolean|undefined} alreadyExisted
   * @param {string|undefined} error
   */
  function handleSkillInstalled(id, ok, alreadyExisted, error) {
    const btn = /** @type {HTMLElement|null} */ (
      skillsListEl.querySelector(`[data-skill-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    if (ok) {
      btn.textContent = "Installed";
      btn.classList.add("skill-btn--installed");
      btn.setAttribute("disabled", "");
      btn.removeAttribute("data-skill-id");
    } else {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
      // Show error near the row
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Install failed";
      }
    }
  }

  // ── Metrics panel ───────────────────────────────────────────────

  /**
   * Format a token count compactly.
   * < 1000      → "450"
   * 1k–999k     → "1.2k", "2.1k"  (trailing ".0" trimmed)
   * >= 1 000 000 → "1.5M"          (trailing ".0" trimmed)
   * @param {number} n
   * @returns {string}
   */
  function fmtTokens(n) {
    if (!n || n < 1000) return String(n ?? 0);
    if (n < 1_000_000) {
      const val = (n / 1000).toFixed(1).replace(/\.0$/, "");
      return `${val}k`;
    }
    const val = (n / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${val}M`;
  }

  /**
   * Format milliseconds as "Xm Ys".
   * @param {number} ms
   * @returns {string}
   */
  function fmtMs(ms) {
    if (!ms || ms < 0) return "0m 0s";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }

  /**
   * Conjugate a verb into its third-person singular form.
   * @param {string} verb
   * @returns {string}
   */
  function thirdPersonVerb(verb) {
    const lower = verb.toLowerCase();
    const irregular = { are: "is", have: "has", do: "does", go: "goes" };
    let conj;
    if (irregular[lower]) conj = irregular[lower];
    else if (/(s|sh|ch|x|z|o)$/.test(lower)) conj = lower + "es";
    else if (/[^aeiou]y$/.test(lower)) conj = lower.slice(0, -1) + "ies";
    else conj = lower + "s";
    return verb[0] === verb[0].toUpperCase() ? conj[0].toUpperCase() + conj.slice(1) : conj;
  }

  /**
   * Rewrite a second-person agent description into a third-person role blurb
   * for hover tooltips (e.g. "You are the Orchestrator — you coordinate work"
   * → "Coordinates work"). The agent name is shown separately, so a leading
   * self-introduction is dropped.
   * @param {string|undefined} desc
   * @returns {string}
   */
  function describeRole(desc) {
    if (!desc) return "";
    let s = String(desc).trim();
    // Drop a leading self-introduction "You are the/a/an <Name> — " so the
    // descriptive clause leads (the name is shown separately).
    s = s.replace(/^you\s+are\s+(?:the|a|an)\s+[^—:-]+?\s*[—–-]\s*/i, "");
    // Otherwise drop just the "You are " lead-in.
    s = s.replace(/^you\s+are\s+/i, "");
    // Convert sentence-initial "You <verb>" (start, or after . ! ?) to third person.
    s = s.replace(/(^|[.!?]\s+)you\s+([a-z]+)/gi, (_, pre, verb) => pre + thirdPersonVerb(verb));
    // Pronouns.
    s = s.replace(/\byour\b/gi, "its");
    s = s.replace(/\byou\b/gi, "it");
    // Capitalize first character.
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /**
   * Render the agentMetrics array into the DOM table.
   * @param {Array<{id:string,name:string,status:string,taskCount:number,mcpCount:number,activeMs:number,tokens:number,model?:string,description?:string}>|undefined} metrics
   */
  /** Last metrics array received, re-rendered on a timer so live time ticks. */
  let lastMetrics = [];

  function renderMetrics(metrics) {
    lastMetrics = metrics || [];
    const emptyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-empty"));
    const tableEl = /** @type {HTMLElement} */ (document.getElementById("metrics-table"));
    const tbodyEl = /** @type {HTMLElement} */ (document.getElementById("metrics-tbody"));

    if (!emptyEl || !tableEl || !tbodyEl) return;

    if (!metrics || metrics.length === 0) {
      emptyEl.style.display = "";
      tableEl.style.display = "none";
      return;
    }

    emptyEl.style.display = "none";
    tableEl.style.display = "";

    // Raw tokens per minute of active time: each agent's token total divided by
    // its finalized active minutes (no model weighting). Used to scale the status bar.
    const maxTokensPerMin = Math.max(1, ...metrics.map(a => {
      const mins = (a.activeMs || 0) / 60000;
      return mins > 0 ? (a.tokens || 0) / mins : 0;
    }));

    // Rebuild rows
    tbodyEl.innerHTML = "";
    for (const agent of metrics) {
      const status = (agent.status || "idle").toLowerCase();
      const row = document.createElement("tr");

      const displayName = agent.name || agent.id;

      const nameTd = document.createElement("td");
      nameTd.className = `col-name${status === "active" ? " name--active" : ""}`;
      nameTd.textContent = displayName;
      // Per-column tooltip: agent name + model + third-person role description.
      const role = describeRole(agent.description);
      let nameTitle = displayName;
      if (agent.model && role) {
        nameTitle = `${displayName} — ${agent.model}\n${role}`;
      } else if (agent.model) {
        nameTitle = `${displayName} — ${agent.model}`;
      } else if (role) {
        nameTitle = `${displayName}\n${role}`;
      }
      nameTd.title = nameTitle;
      row.appendChild(nameTd);

      // Status bar: green while active, gray while idle. Width encodes the
      // raw tokens per minute of active time (tokens / activeMs minutes), normalized
      // to the agent with the highest tokens-per-minute. Active agents always show
      // a visible green sliver so "working" is never invisible.
      const mins = (agent.activeMs || 0) / 60000;
      const tokensPerMin = mins > 0 ? (agent.tokens || 0) / mins : null;
      const isActive = status === "active";
      const rawPct = tokensPerMin !== null
        ? Math.round(Math.min(tokensPerMin / maxTokensPerMin, 1) * 100)
        : 0;
      const fillPct = isActive ? Math.max(rawPct, 15) : rawPct;
      const statusTd = document.createElement("td");
      statusTd.className = "col-status";
      statusTd.title = "Tokens/min — average tokens generated per minute of active time. The bar is scaled to the busiest agent.";
      const track = document.createElement("div");
      track.className = "status-bar-track";
      const fill = document.createElement("div");
      fill.className = `status-bar-fill ${isActive ? "status-bar-fill--active" : "status-bar-fill--idle"}`;
      fill.style.width = `${fillPct}%`;
      const label = document.createElement("span");
      label.className = "status-bar-label";
      label.textContent = isActive ? "active" : (tokensPerMin !== null ? fmtTokens(Math.round(tokensPerMin)) : "—");
      track.appendChild(fill);
      track.appendChild(label);
      statusTd.appendChild(track);
      row.appendChild(statusTd);

      const tasksTd = document.createElement("td");
      tasksTd.className = "col-tasks";
      tasksTd.title = "Tasks — number of Task-tool delegations routed to this agent.";
      tasksTd.textContent = String(agent.taskCount ?? 0);
      row.appendChild(tasksTd);

      const mcpTd = document.createElement("td");
      mcpTd.className = "col-mcp";
      mcpTd.title = "MCP — number of MCP tool calls this agent has made.";
      mcpTd.textContent = String(agent.mcpCount ?? 0);
      row.appendChild(mcpTd);

      // Show live elapsed time while active (activeMs only finalizes on stop).
      const liveMs = isActive && agent.workStartAt
        ? agent.activeMs + Math.max(0, Date.now() - agent.workStartAt)
        : agent.activeMs;
      const timeTd = document.createElement("td");
      timeTd.className = "col-time";
      timeTd.title = "Active time this agent has spent working.";
      timeTd.textContent = fmtMs(liveMs);
      row.appendChild(timeTd);

      const tokensTd = document.createElement("td");
      tokensTd.className = "col-tokens";
      tokensTd.title = "Total tokens this agent has consumed.";
      tokensTd.textContent = fmtTokens(agent.tokens ?? 0);
      row.appendChild(tokensTd);

      tbodyEl.appendChild(row);
    }
  }

  // Re-render once a second so any active agent's live time keeps advancing
  // between state pushes.
  setInterval(() => {
    if (lastMetrics.length && lastMetrics.some((a) => (a.status || "").toLowerCase() === "active")) {
      renderMetrics(lastMetrics);
    }
  }, 1000);

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
