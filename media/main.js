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
  const menuCatalogBtn  = /** @type {HTMLElement} */ (document.getElementById("menu-catalog"));
  const skillsListEl    = /** @type {HTMLElement} */ (document.getElementById("skills-list"));

  // ── Catalog tabs (Skills / MCP / Packs) ───────────────────────────
  const tabSkillsBtn = /** @type {HTMLElement} */ (document.getElementById("tab-skills"));
  const tabMcpBtn    = /** @type {HTMLElement} */ (document.getElementById("tab-mcp"));
  const tabPacksBtn  = /** @type {HTMLElement} */ (document.getElementById("tab-packs"));
  const mcpListEl    = /** @type {HTMLElement} */ (document.getElementById("mcp-list"));
  const packsListEl  = /** @type {HTMLElement} */ (document.getElementById("packs-list"));

  // Tracks whether each catalog has been fetched yet (lazy-load on first view).
  let mcpLoaded = false;
  let packsLoaded = false;

  /**
   * Switch the active catalog tab. The three tabs (skills/mcp/packs) are
   * mutually exclusive — exactly one list is visible at a time.
   * @param {"skills"|"mcp"|"packs"} tab
   */
  function showCatalogTab(tab) {
    /** @type {Array<[HTMLElement|null, HTMLElement|null, string]>} */
    const tabs = [
      [tabSkillsBtn, skillsListEl, "skills"],
      [tabMcpBtn, mcpListEl, "mcp"],
      [tabPacksBtn, packsListEl, "packs"],
    ];
    for (const [btn, list, key] of tabs) {
      const isActive = key === tab;
      if (list) {
        if (isActive) list.removeAttribute("hidden");
        else list.setAttribute("hidden", "");
      }
      if (btn) {
        btn.classList.toggle("catalog-tab--active", isActive);
        btn.setAttribute("aria-selected", String(isActive));
      }
    }
    if (tab === "mcp" && !mcpLoaded) {
      mcpLoaded = true;
      vscode.postMessage({ type: "getMcp" });
    }
    if (tab === "packs" && !packsLoaded) {
      packsLoaded = true;
      vscode.postMessage({ type: "getPacks" });
    }
  }

  if (tabSkillsBtn) {
    tabSkillsBtn.addEventListener("click", () => showCatalogTab("skills"));
  }
  if (tabMcpBtn) {
    tabMcpBtn.addEventListener("click", () => showCatalogTab("mcp"));
  }
  if (tabPacksBtn) {
    tabPacksBtn.addEventListener("click", () => showCatalogTab("packs"));
  }

  if (menuCatalogBtn) {
    menuCatalogBtn.addEventListener("click", () => {
      closeMenu();
      openModal(skillsModalEl, skillsCloseBtn);
      showCatalogTab("skills");
      vscode.postMessage({ type: "getSkills" });
    });
  }

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

  // ── MCP list install-button handler (event delegation) ───────────

  if (mcpListEl) {
    mcpListEl.addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement|null} */ (
        /** @type {HTMLElement} */ (e.target).closest("[data-mcp-id]")
      );
      if (!btn || btn.hasAttribute("disabled")) return;
      const id = btn.getAttribute("data-mcp-id");

      // Confirmation for third-party MCP servers happens HOST-side via a native
      // modal (window.confirm is unreliable in VS Code webviews — it can
      // silently return false). We pass thirdParty so the host can prompt.
      const server = lastMcpServers.find((s) => s && s.id === id);

      btn.textContent = "Installing…";
      btn.setAttribute("disabled", "");
      vscode.postMessage({
        type: "installMcp",
        id,
        thirdParty: !!(server && server.thirdParty),
      });
    });
  }

  // ── Packs list install-button handler (event delegation) ─────────

  if (packsListEl) {
    packsListEl.addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement|null} */ (
        /** @type {HTMLElement} */ (e.target).closest("[data-pack-id]")
      );
      if (!btn || btn.hasAttribute("disabled")) return;
      const id = btn.getAttribute("data-pack-id");

      // Confirmation for third-party packs happens HOST-side via a native modal
      // (window.confirm is unreliable in VS Code webviews — it can silently
      // return false). We pass thirdParty + disclosures so the host can prompt.
      const pack = lastPacks.find((p) => p && p.id === id);
      const disclosures = (pack && Array.isArray(pack.disclosures)) ? pack.disclosures : [];

      btn.textContent = "Installing…";
      btn.setAttribute("disabled", "");
      vscode.postMessage({
        type: "installPack",
        id,
        thirdParty: !!(pack && pack.thirdParty),
        disclosures,
      });
    });
  }

  // ── Setup / install overlay ──────────────────────────────────────

  const setupViewEl    = /** @type {HTMLElement} */ (document.getElementById("setup-view"));
  const appEl          = /** @type {HTMLElement} */ (document.getElementById("app"));
  const setupStatusEl  = /** @type {HTMLElement} */ (document.getElementById("setup-status"));
  const installHooksBtn = /** @type {HTMLElement} */ (document.getElementById("install-hooks-btn"));
  const setupErrorEl   = /** @type {HTMLElement} */ (document.getElementById("setup-error"));
  const setupConfigEl  = /** @type {HTMLElement} */ (document.getElementById("setup-config"));
  const setupBackBtn   = /** @type {HTMLElement} */ (document.getElementById("setup-back-btn"));
  const menuSettingsBtn = /** @type {HTMLElement} */ (document.getElementById("menu-settings"));

  // Tracks whether the setup screen was reached via Settings (vs. first-run
  // install). When opened from Settings we stay on the screen even once the
  // hooks are installed, to show the (Phase 2) config + a Back button.
  let openedFromSettings = false;

  /** Tracks last uefnDetected state from checkInstall. */
  let lastUefnDetected = false;

  /** Show the full-bleed setup overlay; hide the live app view. */
  function showSetup() {
    setupViewEl.removeAttribute("hidden");
    appEl.setAttribute("hidden", "");
  }

  /** Show the live app view; hide the setup overlay. */
  function showMain() {
    setupViewEl.setAttribute("hidden", "");
    appEl.removeAttribute("hidden");
  }

  /**
   * React to an install-state push from the host.
   * @param {{installed:boolean, busy?:boolean, error?:string}} info
   */
  function handleInstallState(info) {
    if (info && info.busy) {
      showSetup();
      setupStatusEl.textContent = "Installing…";
      installHooksBtn.removeAttribute("hidden");
      installHooksBtn.setAttribute("disabled", "");
      installHooksBtn.textContent = "Installing…";
      setupErrorEl.setAttribute("hidden", "");
      setupConfigEl.setAttribute("hidden", "");
      setupBackBtn.setAttribute("hidden", "");
      return;
    }

    if (info && info.installed === false) {
      showSetup();
      setupStatusEl.textContent =
        "The TycoonAgents hook isn't installed yet. Install it to start visualizing agent activity.";
      installHooksBtn.removeAttribute("hidden");
      installHooksBtn.removeAttribute("disabled");
      installHooksBtn.textContent = "Install hooks";
      setupConfigEl.setAttribute("hidden", "");
      setupBackBtn.setAttribute("hidden", "");
      if (info.error) {
        setupErrorEl.textContent = info.error;
        setupErrorEl.removeAttribute("hidden");
      } else {
        setupErrorEl.setAttribute("hidden", "");
      }
      return;
    }

    // installed === true
    if (openedFromSettings) {
      showSetup();
      setupStatusEl.textContent = "Hooks installed ✓";
      installHooksBtn.setAttribute("hidden", "");
      setupConfigEl.removeAttribute("hidden");
      setupBackBtn.removeAttribute("hidden");
      if (info && info.error) {
        setupErrorEl.textContent = info.error;
        setupErrorEl.removeAttribute("hidden");
        installHooksBtn.removeAttribute("hidden");
        installHooksBtn.removeAttribute("disabled");
        installHooksBtn.textContent = "Install hooks";
      } else {
        setupErrorEl.setAttribute("hidden", "");
      }
    } else {
      showMain();
    }
  }

  installHooksBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "installHooks" });
  });

  menuSettingsBtn.addEventListener("click", () => {
    closeMenu();
    openedFromSettings = true;
    showSetup();
    vscode.postMessage({ type: "checkInstall" });
    vscode.postMessage({ type: "getSettings" });
  });

  setupBackBtn.addEventListener("click", () => {
    openedFromSettings = false;
    showMain();
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
  let idleFreezeMs = 180000, sanityCapMs = 900000;

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

  // Initial state: keep the setup overlay up until we hear back about install
  // status, so we never flash the live view before knowing the hook exists.
  showSetup();
  setupStatusEl.textContent = "Checking installation…";
  installHooksBtn.setAttribute("hidden", "");
  setupErrorEl.setAttribute("hidden", "");
  setupConfigEl.setAttribute("hidden", "");
  setupBackBtn.setAttribute("hidden", "");
  vscode.postMessage({ type: "checkInstall" });

  /**
   * Render the UEFN project detected card inside #setup-card.
   * Called when checkInstall response carries uefnDetected:true.
   * @param {string[]} signals
   */
  function renderUefnPrompt(signals) {
    // Remove any existing card first (idempotent)
    const existing = document.getElementById("uefn-prompt-card");
    if (existing) existing.remove();

    const setupCard = document.getElementById("setup-card");
    if (!setupCard) return;

    const card = document.createElement("div");
    card.id = "uefn-prompt-card";
    card.className = "uefn-prompt-card";

    const heading = document.createElement("h2");
    heading.className = "uefn-prompt-heading";
    heading.textContent = "UEFN project detected";
    card.appendChild(heading);

    const body = document.createElement("p");
    body.className = "uefn-prompt-body";
    body.id = "uefn-prompt-body";
    body.textContent = "This looks like a UEFN project. Set up the Verse Expert and Auditor agents and stage the UEFN bridge (uefn_bridge.py into Content/Python)?";
    card.appendChild(body);

    const btnRow = document.createElement("div");
    btnRow.className = "uefn-prompt-btns";

    const yesBtn = document.createElement("button");
    yesBtn.className = "skill-btn";
    yesBtn.id = "uefn-yes-btn";
    yesBtn.textContent = "Yes, set up UEFN";
    yesBtn.addEventListener("click", function () {
      yesBtn.setAttribute("disabled", "");
      notNowBtn.setAttribute("disabled", "");
      body.textContent = "Setting up…";
      vscode.postMessage({ type: "setupUefnProject" });
    });

    const notNowBtn = document.createElement("button");
    notNowBtn.className = "skill-btn";
    notNowBtn.id = "uefn-notnow-btn";
    notNowBtn.textContent = "Not now";
    notNowBtn.addEventListener("click", function () {
      card.remove();
    });

    btnRow.appendChild(yesBtn);
    btnRow.appendChild(notNowBtn);
    card.appendChild(btnRow);

    setupCard.appendChild(card);
  }

  /**
   * Handle the uefnSetupDone message from the host.
   * @param {{ok:boolean, results?:{pack:string, bridge:"staged"|"exists"}, error?:string}} msg
   */
  function handleUefnSetupDone(msg) {
    const card = document.getElementById("uefn-prompt-card");
    if (!card) return;
    const body = document.getElementById("uefn-prompt-body");
    const btns = card.querySelector(".uefn-prompt-btns");
    if (btns) btns.remove();
    if (msg.ok && msg.results) {
      const r = msg.results;
      const lines = [];
      lines.push("UEFN setup complete:");
      lines.push("Agents: Verse Expert + Auditor installed");
      lines.push("Skill: uefn");
      lines.push("MCP: uefn-bridge");
      lines.push("Content/Python/uefn_bridge.py: " + r.bridge);
      if (body) body.textContent = lines.join("\n");
    } else {
      if (body) body.textContent = "Setup failed: " + (msg.error || "unknown error");
    }
  }

  window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
    const msg = event.data;
    if (msg && msg.type === "state") {
      state = msg.state;
      idleFreezeMs = state.idleFreezeMs ?? 180000;
      sanityCapMs = state.sanityCapMs ?? 900000;
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
    } else if (msg && msg.type === "mcp") {
      renderMcpList(msg.servers, msg.error);
    } else if (msg && msg.type === "mcpInstalled") {
      handleMcpInstalled(msg.id, msg.ok, msg.alreadyExisted, msg.error, msg.cancelled);
    } else if (msg && msg.type === "packs") {
      renderPacksList(msg.packs, msg.error);
    } else if (msg && msg.type === "packInstalled") {
      handlePackInstalled(msg.id, msg.ok, msg.results, msg.error, msg.cancelled);
    } else if (msg && msg.type === "installState") {
      handleInstallState(msg);
      if (msg.uefnDetected) {
        lastUefnDetected = true;
        renderUefnPrompt(msg.uefnSignals || []);
      }
    } else if (msg && msg.type === "uefnSetupDone") {
      handleUefnSetupDone(msg);
    } else if (msg && msg.type === "settings") {
      lastSettings = msg.payload || null;
      renderSettings();
    } else if (msg && msg.type === "settingsUpdated") {
      handleSettingsUpdated(msg);
    } else if (msg && msg.type === "metricsReset") {
      handleMetricsReset(msg);
    } else if (msg && msg.type === "doctorReport") {
      const el = document.getElementById("doctor-results");
      if (!el) return;
      el.innerHTML = "";

      // Re-enable the troubleshoot button
      document.querySelectorAll("button").forEach(b => {
        if (b.textContent === "Checking…") {
          b.disabled = false;
          b.textContent = "Troubleshoot & Fix";
        }
      });

      const findings = Array.isArray(msg.findings) ? msg.findings : [];
      const foreign = Array.isArray(msg.foreign) ? msg.foreign : [];

      for (const f of findings) {
        const row = document.createElement("div");
        row.className = "doctor-finding";
        const icon = document.createElement("span");
        icon.className = f.severity === "ok" ? "doctor-icon-ok" : f.severity === "warn" ? "doctor-icon-warn" : "doctor-icon-error";
        icon.textContent = f.severity === "ok" ? "✓" : f.severity === "warn" ? "⚠" : "✗";
        const text = document.createElement("span");
        text.className = "doctor-finding-text";
        const title = document.createElement("strong");
        title.textContent = f.title;
        const detail = document.createElement("span");
        detail.className = "doctor-detail";
        detail.textContent = " — " + f.detail;
        text.appendChild(title);
        text.appendChild(detail);
        row.appendChild(icon);
        row.appendChild(text);
        el.appendChild(row);
      }

      const hasFixable = findings.some(f => f.fixable && !f.destructive);
      if (hasFixable) {
        const fixRow = document.createElement("div");
        fixRow.className = "doctor-action-row";
        const fixBtn = document.createElement("button");
        fixBtn.className = "skill-btn settings-btn";
        fixBtn.textContent = "Fix issues";
        fixBtn.addEventListener("click", () => {
          fixBtn.disabled = true;
          fixBtn.textContent = "Fixing…";
          vscode.postMessage({ type: "applyDoctorFix", removeForeign: false });
        });
        fixRow.appendChild(fixBtn);
        el.appendChild(fixRow);
      }

      if (foreign.length > 0) {
        const cautionDiv = document.createElement("div");
        cautionDiv.className = "doctor-caution";
        const cautionTitle = document.createElement("div");
        cautionTitle.className = "doctor-caution-title";
        cautionTitle.textContent = "Foreign hook commands in Tycoon event-slots:";
        cautionDiv.appendChild(cautionTitle);
        for (const cmd of foreign) {
          const cmdEl = document.createElement("div");
          cmdEl.className = "doctor-foreign-cmd";
          cmdEl.textContent = cmd;
          cautionDiv.appendChild(cmdEl);
        }
        const removeBtn = document.createElement("button");
        removeBtn.className = "skill-btn settings-btn danger-btn";
        removeBtn.textContent = `Remove foreign hooks (${foreign.length})`;
        removeBtn.addEventListener("click", () => {
          removeBtn.disabled = true;
          removeBtn.textContent = "Removing…";
          vscode.postMessage({ type: "applyDoctorFix", removeForeign: true });
        });
        cautionDiv.appendChild(removeBtn);
        el.appendChild(cautionDiv);
      }
    } else if (msg && msg.type === "doctorFixDone") {
      const el = document.getElementById("doctor-results");
      if (!el) return;
      el.innerHTML = "";

      if (!msg.ok) {
        const errEl = document.createElement("div");
        errEl.className = "doctor-finding";
        const icon = document.createElement("span");
        icon.className = "doctor-icon-error";
        icon.textContent = "✗";
        const text = document.createElement("span");
        text.className = "doctor-finding-text";
        text.textContent = "Fix failed: " + (msg.error || "Unknown error");
        errEl.appendChild(icon);
        errEl.appendChild(text);
        el.appendChild(errEl);
        return;
      }

      const changes = Array.isArray(msg.changes) ? msg.changes : [];
      if (changes.length === 0) {
        const noChange = document.createElement("div");
        noChange.className = "doctor-finding";
        noChange.textContent = "No changes needed.";
        el.appendChild(noChange);
      } else {
        for (const change of changes) {
          const row = document.createElement("div");
          row.className = "doctor-finding";
          const icon = document.createElement("span");
          icon.className = "doctor-icon-ok";
          icon.textContent = "✓";
          const text = document.createElement("span");
          text.className = "doctor-finding-text";
          text.textContent = change;
          row.appendChild(icon);
          row.appendChild(text);
          el.appendChild(row);
        }
      }

      const findings = Array.isArray(msg.findings) ? msg.findings : [];
      const foreign = Array.isArray(msg.foreign) ? msg.foreign : [];
      const refreshEl = document.createElement("div");
      refreshEl.className = "doctor-refresh";
      for (const f of findings) {
        const row = document.createElement("div");
        row.className = "doctor-finding";
        const icon = document.createElement("span");
        icon.className = f.severity === "ok" ? "doctor-icon-ok" : f.severity === "warn" ? "doctor-icon-warn" : "doctor-icon-error";
        icon.textContent = f.severity === "ok" ? "✓" : f.severity === "warn" ? "⚠" : "✗";
        const text = document.createElement("span");
        text.textContent = " " + f.title + (f.detail ? ": " + f.detail : "");
        row.appendChild(icon);
        row.appendChild(text);
        refreshEl.appendChild(row);
      }
      if (foreign.length > 0) {
        const cautionDiv = document.createElement("div");
        cautionDiv.className = "doctor-caution";
        for (const cmd of foreign) {
          const cmdEl = document.createElement("div");
          cmdEl.className = "doctor-foreign-cmd";
          cmdEl.textContent = cmd;
          cautionDiv.appendChild(cmdEl);
        }
        refreshEl.appendChild(cautionDiv);
      }
      el.appendChild(refreshEl);
    }
  });

  // ── Transparency / third-party disclosure ────────────────────────
  //
  // Installing an MCP server (or a Pack that bundles one) runs third-party
  // code on the user's machine and may call external services. We surface a
  // standing banner per list, a per-row disclosure block, and a confirm gate
  // before any networked install proceeds.

  /** Last MCP server array received, for disclosure lookup in the click handler. */
  let lastMcpServers = [];
  /** Last packs array received, for disclosure lookup in the click handler. */
  let lastPacks = [];

  /**
   * Build the standing notice for a catalog list.
   * @param {"third-party"|"local"} kind
   * @returns {HTMLElement}
   */
  function buildCatalogNotice(kind) {
    const el = document.createElement("p");
    if (kind === "local") {
      el.className = "catalog-notice catalog-notice--local";
      el.textContent =
        "Skills are local prompt files bundled with the extension — no third-party code or network calls.";
    } else {
      el.className = "catalog-notice";
      el.textContent =
        "⚠ These install third-party software that runs on your machine and may contact external services. " +
        "Review each item's source and data use, and check your organization's policy before installing.";
    }
    return el;
  }

  /**
   * Build a per-item disclosure block (used by MCP rows and Pack disclosures).
   * @param {{vendor?:string,package?:string,homepage?:string,network?:boolean,dataNote?:string,label?:string}} d
   * @returns {HTMLElement}
   */
  function buildDisclosureBlock(d) {
    const block = document.createElement("div");
    block.className = "disclosure";

    const tagLine = document.createElement("div");
    tagLine.className = "disclosure-tagline";
    const tag = document.createElement("span");
    tag.className = "disclosure-tag";
    tag.textContent = "Third-party";
    tagLine.appendChild(tag);
    if (d.vendor) {
      const vendor = document.createElement("span");
      vendor.className = "disclosure-vendor";
      vendor.textContent = d.label ? `${d.label} · ${d.vendor}` : d.vendor;
      tagLine.appendChild(vendor);
    }
    block.appendChild(tagLine);

    if (d.package) {
      const pkg = document.createElement("div");
      pkg.className = "disclosure-pkg";
      pkg.textContent = `Runs: ${d.package}`;
      block.appendChild(pkg);
    }

    const net = document.createElement("div");
    if (d.network) {
      net.className = "disclosure-net";
      net.textContent = `Sends data externally: ${d.dataNote || "contacts an external service."}`;
    } else {
      net.className = "disclosure-local";
      net.textContent = `Local only: ${d.dataNote || "runs locally with no network calls."}`;
    }
    block.appendChild(net);

    if (d.homepage) {
      const src = document.createElement("a");
      src.className = "disclosure-src";
      src.href = d.homepage;
      src.target = "_blank";
      src.rel = "noopener noreferrer";
      src.textContent = "source ↗";
      block.appendChild(src);
    }

    return block;
  }

  /**
   * Build a confirm message for a third-party install.
   * @param {{name?:string,vendor?:string,package?:string,network?:boolean,dataNote?:string,homepage?:string}} item
   * @returns {string}
   */
  function buildInstallConfirm(item) {
    const lines = [];
    lines.push(`Install ${item.name || "this item"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine.");
    if (item.vendor) lines.push(`Vendor: ${item.vendor}`);
    if (item.package) lines.push(`Runs: ${item.package}`);
    if (item.network) {
      lines.push(`Sends data externally: ${item.dataNote || "contacts an external service."}`);
    } else if (item.dataNote) {
      lines.push(`Local only: ${item.dataNote}`);
    }
    if (item.homepage) lines.push(`Source: ${item.homepage}`);
    lines.push("");
    lines.push("Check your organization's policy before continuing. Proceed?");
    return lines.join("\n");
  }

  /**
   * Rebuild #skills-list from the catalog payload.
   * @param {Array<{id:string,name:string,description:string,installed:boolean,mcpNote?:string,thirdParty?:boolean,source?:string}>} skills
   * @param {string|undefined} error
   */
  function renderSkillsList(skills, error) {
    skillsListEl.innerHTML = "";
    skillsListEl.appendChild(buildCatalogNotice("local"));
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

      if (skill.mcpNote) {
        const noteEl = document.createElement("span");
        noteEl.className = "skill-mcpnote";
        noteEl.textContent = `⚙ ${skill.mcpNote}`;
        textBlock.appendChild(noteEl);
      }

      if (skill.thirdParty) {
        const attrLine = document.createElement("div");
        attrLine.className = "skill-attribution disclosure-tagline";
        const tag = document.createElement("span");
        tag.className = "disclosure-tag";
        tag.textContent = "Third-party";
        attrLine.appendChild(tag);
        if (skill.source) {
          const src = document.createElement("a");
          src.className = "disclosure-src";
          src.href = skill.source;
          src.target = "_blank";
          src.rel = "noopener noreferrer";
          src.textContent = "source ↗";
          attrLine.appendChild(src);
        }
        textBlock.appendChild(attrLine);
      }

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

  // ── MCP servers list ─────────────────────────────────────────────

  /**
   * Rebuild #mcp-list from the catalog payload. Mirrors renderSkillsList.
   * @param {Array<{id:string,name:string,description:string,installed:boolean,requiresEnv?:string[],note?:string,docsUrl?:string}>} servers
   * @param {string|undefined} error
   */
  function renderMcpList(servers, error) {
    if (!mcpListEl) return;
    lastMcpServers = Array.isArray(servers) ? servers : [];
    mcpListEl.innerHTML = "";
    mcpListEl.appendChild(buildCatalogNotice("third-party"));
    if (error) {
      const errEl = document.createElement("p");
      errEl.className = "skills-error";
      errEl.textContent = error;
      mcpListEl.appendChild(errEl);
      return;
    }
    if (!servers || servers.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "skills-empty";
      emptyEl.textContent = "No MCP servers available.";
      mcpListEl.appendChild(emptyEl);
      return;
    }
    for (const server of servers) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.mcpRowId = server.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = server.name;

      const descEl = document.createElement("span");
      descEl.className = "skill-desc";
      descEl.textContent = server.description;

      textBlock.appendChild(nameEl);
      textBlock.appendChild(descEl);

      if (server.requiresEnv && server.requiresEnv.length) {
        const reqEl = document.createElement("span");
        reqEl.className = "mcp-req";
        reqEl.textContent = `Requires: ${server.requiresEnv.join(", ")}`;
        textBlock.appendChild(reqEl);
      }

      if (server.note) {
        const noteEl = document.createElement("span");
        noteEl.className = "mcp-req";
        noteEl.textContent = server.note;
        textBlock.appendChild(noteEl);
      }

      if (server.docsUrl) {
        const docsEl = document.createElement("a");
        docsEl.className = "mcp-docs";
        docsEl.href = server.docsUrl;
        docsEl.target = "_blank";
        docsEl.rel = "noopener noreferrer";
        docsEl.textContent = "docs";
        textBlock.appendChild(docsEl);
      }

      if (server.thirdParty) {
        textBlock.appendChild(buildDisclosureBlock({
          vendor: server.vendor,
          package: server.package,
          homepage: server.homepage,
          network: server.network,
          dataNote: server.dataNote,
        }));
      }

      const btn = document.createElement("button");
      btn.className = "skill-btn" + (server.installed ? " skill-btn--installed" : "");
      if (server.installed) {
        btn.textContent = "Installed";
        btn.setAttribute("disabled", "");
      } else {
        btn.textContent = "Install";
        btn.setAttribute("data-mcp-id", server.id);
      }

      row.appendChild(textBlock);
      row.appendChild(btn);
      mcpListEl.appendChild(row);
    }
  }

  /**
   * Update an MCP row after an install attempt. Mirrors handleSkillInstalled.
   * @param {string} id
   * @param {boolean} ok
   * @param {boolean|undefined} alreadyExisted
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handleMcpInstalled(id, ok, alreadyExisted, error, cancelled) {
    if (!mcpListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      mcpListEl.querySelector(`[data-mcp-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    // User dismissed the host confirmation modal — silently restore the button.
    if (cancelled) {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      btn.textContent = "Installed";
      btn.classList.add("skill-btn--installed");
      btn.setAttribute("disabled", "");
      btn.removeAttribute("data-mcp-id");
    } else {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
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

  // ── Packs list (capability bundles: skill + MCP + agent) ─────────

  /** Part keys in display order, with their chip labels. */
  const PACK_PARTS = [
    ["skill", "Skill"],
    ["mcp", "MCP"],
    ["agent", "Agent"],
  ];

  /**
   * True when every part the pack `has` is also `installed`.
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   * @returns {boolean}
   */
  function packFullyInstalled(pack) {
    const has = pack.has || {};
    const installed = pack.installed || {};
    return PACK_PARTS.every(([key]) => !has[key] || installed[key]);
  }

  /**
   * Build the "includes" chip row for a pack into a container element.
   * @param {HTMLElement} container
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   */
  function renderPackChips(container, pack) {
    container.innerHTML = "";
    const has = pack.has || {};
    const installed = pack.installed || {};
    for (const [key, label] of PACK_PARTS) {
      if (!has[key]) continue;
      const done = !!installed[key];
      const chip = document.createElement("span");
      chip.className = "pack-chip" + (done ? " pack-chip--done" : "");
      chip.textContent = done ? `${label} ✓` : label;
      container.appendChild(chip);
    }
  }

  /**
   * Rebuild #packs-list from the catalog payload. Mirrors renderMcpList.
   * @param {Array<{id:string,name:string,description:string,has:Record<string,boolean>,installed:Record<string,boolean>}>} packs
   * @param {string|undefined} error
   */
  function renderPacksList(packs, error) {
    if (!packsListEl) return;
    lastPacks = Array.isArray(packs) ? packs : [];
    packsListEl.innerHTML = "";
    packsListEl.appendChild(buildCatalogNotice("third-party"));
    if (error) {
      const errEl = document.createElement("p");
      errEl.className = "skills-error";
      errEl.textContent = error;
      packsListEl.appendChild(errEl);
      return;
    }
    if (!packs || packs.length === 0) {
      const emptyEl = document.createElement("p");
      emptyEl.className = "skills-empty";
      emptyEl.textContent = "No packs available.";
      packsListEl.appendChild(emptyEl);
      return;
    }
    for (const pack of packs) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.packRowId = pack.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = pack.name;

      const descEl = document.createElement("span");
      descEl.className = "skill-desc";
      descEl.textContent = pack.description;

      textBlock.appendChild(nameEl);
      textBlock.appendChild(descEl);

      const parts = document.createElement("div");
      parts.className = "pack-parts";
      renderPackChips(parts, pack);
      textBlock.appendChild(parts);

      // Muted line listing each bundled skill with a per-skill done marker.
      if (Array.isArray(pack.skills) && pack.skills.length) {
        const includes = document.createElement("div");
        includes.className = "pack-skills";
        const lead = document.createElement("span");
        lead.className = "pack-skills-lead";
        lead.textContent = "Includes: ";
        includes.appendChild(lead);
        pack.skills.forEach((s, i) => {
          const item = document.createElement("span");
          item.className = "pack-skills-item" + (s && s.installed ? " pack-skills-item--done" : "");
          const label = (s && (s.name || s.id)) || "";
          item.textContent = (s && s.installed) ? `${label} ✓` : label;
          includes.appendChild(item);
          if (i < pack.skills.length - 1) {
            const sep = document.createElement("span");
            sep.className = "pack-skills-sep";
            sep.textContent = ", ";
            includes.appendChild(sep);
          }
        });
        textBlock.appendChild(includes);
      }

      if (pack.thirdParty && Array.isArray(pack.disclosures) && pack.disclosures.length) {
        for (const d of pack.disclosures) {
          textBlock.appendChild(buildDisclosureBlock(d));
        }
      } else {
        const local = document.createElement("div");
        local.className = "disclosure-local";
        local.textContent =
          "Local only — installs a bundled skill + a local agent; no third-party servers.";
        textBlock.appendChild(local);
      }

      const btn = document.createElement("button");
      const fully = packFullyInstalled(pack);
      btn.className = "skill-btn" + (fully ? " skill-btn--installed" : "");
      if (fully) {
        btn.textContent = "Installed";
        btn.setAttribute("disabled", "");
      } else {
        btn.textContent = "Install";
        btn.setAttribute("data-pack-id", pack.id);
      }

      row.appendChild(textBlock);
      row.appendChild(btn);
      packsListEl.appendChild(row);
    }
  }

  /**
   * Update a pack row after an install attempt. Mirrors handleMcpInstalled.
   * On success marks the row installed and re-fetches the catalog so chips
   * reflect authoritative per-part state.
   * @param {string} id
   * @param {boolean} ok
   * @param {{skill?:string,mcp?:string,agent?:string}|undefined} _results
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handlePackInstalled(id, ok, _results, error, cancelled) {
    if (!packsListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      packsListEl.querySelector(`[data-pack-id="${CSS.escape(id)}"]`)
    );
    // User dismissed the host confirmation modal — silently restore the button.
    if (cancelled) {
      if (btn) {
        btn.textContent = "Install";
        btn.removeAttribute("disabled");
      }
      return;
    }
    if (ok) {
      if (btn) {
        btn.textContent = "Installed";
        btn.classList.add("skill-btn--installed");
        btn.setAttribute("disabled", "");
        btn.removeAttribute("data-pack-id");
        const row = btn.closest(".skill-row");
        const parts = row && row.querySelector(".pack-parts");
        if (parts) {
          // Optimistically mark every present chip done; the getPacks
          // refresh below reconciles to authoritative state.
          for (const chip of parts.querySelectorAll(".pack-chip")) {
            chip.classList.add("pack-chip--done");
            if (!chip.textContent.includes("✓")) chip.textContent += " ✓";
          }
        }
      }
      // Re-fetch so chips/buttons reflect real per-part install results.
      vscode.postMessage({ type: "getPacks" });
    } else if (btn) {
      btn.textContent = "Install";
      btn.removeAttribute("disabled");
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
      const isActive = status === "active";
      const frozen = isActive && (agent.lastActivityAt != null) && (Date.now() - agent.lastActivityAt > idleFreezeMs);
      const showActive = isActive && !frozen;
      const row = document.createElement("tr");

      const displayName = agent.name || agent.id;

      const nameTd = document.createElement("td");
      nameTd.className = `col-name${showActive ? " name--active" : ""}`;
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
      const rawPct = tokensPerMin !== null
        ? Math.round(Math.min(tokensPerMin / maxTokensPerMin, 1) * 100)
        : 0;
      const fillPct = showActive ? Math.max(rawPct, 15) : rawPct;
      const statusTd = document.createElement("td");
      statusTd.className = "col-status";
      statusTd.title = "Tokens/min — average tokens generated per minute of active time. The bar is scaled to the busiest agent.";
      const track = document.createElement("div");
      track.className = "status-bar-track";
      const fill = document.createElement("div");
      fill.className = `status-bar-fill ${showActive ? "status-bar-fill--active" : "status-bar-fill--idle"}`;
      fill.style.width = `${fillPct}%`;
      const label = document.createElement("span");
      label.className = "status-bar-label";
      label.textContent = showActive ? "active" : (tokensPerMin !== null ? fmtTokens(Math.round(tokensPerMin)) : "—");
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

      // Show live elapsed time while active, capped by idle-freeze and sanity cap.
      const seg = agent.workStartAt
        ? Math.min(Math.max(0, Math.min(Date.now(), (agent.lastActivityAt ?? Date.now()) + idleFreezeMs) - agent.workStartAt), sanityCapMs)
        : 0;
      const liveMs = (agent.activeMs || 0) + (isActive ? seg : 0);
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

  // ── Settings (Phase 2) ──────────────────────────────────────────

  /**
   * Most recent settings payload from the host.
   * @type {{hook:{installed:boolean,lastActivityAt:number|null}, agents:Array<{id:string,name:string,model:("opus"|"sonnet"|"haiku"|null),isOrchestrator:boolean,keywords:string}>}|null}
   */
  let lastSettings = null;

  /** Cost weight by model (relative price); used for savings estimates. */
  const COST_WEIGHT = { opus: 15, sonnet: 3, haiku: 0.8 };

  /** Relative capability/cost rank of each model (lower = cheaper/lighter). */
  const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };

  /**
   * Highest model an agent should normally need. When an agent is set above
   * its floor we proactively suggest stepping down to the cheaper model.
   */
  const SUGGESTED_MAX = {
    "search-retrieval": "haiku",
    "testing-specialist": "haiku",
    "workspace-monitor": "haiku",
  };

  /**
   * Format a timestamp as a short relative time ("3m ago", "—" if null).
   * @param {number|null|undefined} ts
   * @returns {string}
   */
  function relativeTime(ts) {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    if (diff < 0) return "just now";
    const sec = Math.floor(diff / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }

  /**
   * Compute savings percent moving from a (more expensive) current model to a
   * cheaper one. Returns a non-negative integer.
   * @param {string} current
   * @param {string} cheaper
   * @returns {number}
   */
  function savingsPct(current, cheaper) {
    const c = COST_WEIGHT[current];
    const ch = COST_WEIGHT[cheaper];
    if (!c || !ch) return 0;
    return Math.max(0, Math.round((1 - ch / c) * 100));
  }

  /** Find the metrics entry matching an agent id (or null). */
  function metricsFor(id) {
    return lastMetrics.find((m) => m && m.id === id) || null;
  }

  /**
   * Compute a recommendation for an agent given its settings + metrics.
   * @param {{id:string,model:string|null,isOrchestrator:boolean}} agent
   * @param {{taskCount?:number}|null} m
   * @returns {{text:string, suggest:(string|null), kind:"amber"|"info"}|null}
   */
  function recommendationFor(agent, m) {
    const model = agent.model;
    const taskCount = (m && m.taskCount) || 0;

    // Proactive down-size: agent is set above its suggested floor. This
    // supersedes (and replaces) the old search-retrieval-only rule, and when
    // it fires we skip the generic opus→sonnet suggestion below to avoid
    // double-recommending.
    const floor = !agent.isOrchestrator ? SUGGESTED_MAX[agent.id] : undefined;
    if (floor && model && MODEL_RANK[model] > MODEL_RANK[floor]) {
      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      return {
        text: `Could run on ${cap(floor)} — ${agent.name || agent.id} handles routine work that rarely needs ${cap(model)} (~${savingsPct(model, floor)}% cheaper)`,
        suggest: floor,
        kind: "amber",
      };
    }

    if (model === "opus" && !agent.isOrchestrator && taskCount >= 1) {
      return {
        text: `Opus is heavy for routine work; Sonnet ~${savingsPct("opus", "sonnet")}% cheaper`,
        suggest: "sonnet",
        kind: "amber",
      };
    }
    if (taskCount === 0 && !agent.isOrchestrator && agent.id !== "primary-agent") {
      return {
        text: "No tasks yet — check routing keywords",
        suggest: null,
        kind: "info",
      };
    }
    return null;
  }

  /**
   * Compute the routing fallback note for the keyword-routing section.
   * `light` drives the traffic-light dot: green = healthy, red = high
   * fallback rate, yellow = not enough data yet.
   * @returns {{text:string, kind:"amber"|"info", light:"green"|"yellow"|"red"}}
   */
  function fallbackNote() {
    const total = lastMetrics.reduce((sum, m) => sum + ((m && m.taskCount) || 0), 0);
    if (total < 5) return { text: "Routing health: not enough data", kind: "info", light: "yellow" };
    const primary = metricsFor("primary-agent");
    const primaryTasks = (primary && primary.taskCount) || 0;
    const ratio = primaryTasks / total;
    if (ratio > 0.2) {
      const pct = Math.round(ratio * 100);
      return {
        text: `High fallback rate (${pct}%): tune keywords so work routes to specialists.`,
        kind: "amber",
        light: "red",
      };
    }
    return { text: "Routing healthy", kind: "info", light: "green" };
  }

  /** Build a section wrapper with a heading. */
  function buildSection(title) {
    const section = document.createElement("section");
    section.className = "settings-section";
    const h = document.createElement("h2");
    h.className = "settings-heading";
    h.textContent = title;
    section.appendChild(h);
    return section;
  }

  /** Flash a small "saved ✓" note inside a row element. */
  function flashSaved(rowEl) {
    if (!rowEl) return;
    let note = rowEl.querySelector(".settings-saved");
    if (!note) {
      note = document.createElement("span");
      note.className = "settings-saved";
      rowEl.appendChild(note);
    }
    note.classList.remove("settings-error-note");
    note.textContent = "saved ✓";
  }

  /** Show an inline error inside a row element. */
  function flashError(rowEl, message) {
    if (!rowEl) return;
    let note = rowEl.querySelector(".settings-saved");
    if (!note) {
      note = document.createElement("span");
      note.className = "settings-saved";
      rowEl.appendChild(note);
    }
    note.classList.add("settings-error-note");
    note.textContent = message || "Failed";
  }

  /**
   * Handle a settingsUpdated ack from the host.
   * @param {{ok:boolean, id?:string, field?:string, error?:string}} msg
   */
  function handleSettingsUpdated(msg) {
    const row = msg.id
      ? setupConfigEl.querySelector(`[data-agent-row="${CSS.escape(msg.id)}"]`)
      : null;
    if (msg.ok) {
      flashSaved(row);
      // Refresh authoritative state from the host.
      vscode.postMessage({ type: "getSettings" });
    } else {
      flashError(row, msg.error || "Update failed");
    }
  }

  /**
   * Handle a metricsReset ack from the host.
   * @param {{ok:boolean, error?:string}} msg
   */
  function handleMetricsReset(msg) {
    if (msg.ok) {
      lastMetrics = [];
      renderMetrics([]);
      renderSettings();
    } else if (dangerStatusEl) {
      dangerStatusEl.textContent = msg.error || "Reset failed";
      dangerStatusEl.classList.add("settings-error-note");
    }
  }

  /** Reference to the danger-zone status line (set during render). */
  let dangerStatusEl = null;

  /** Render all settings sections into #setup-config from lastSettings. */
  function renderSettings() {
    if (!setupConfigEl) return;
    setupConfigEl.innerHTML = "";
    dangerStatusEl = null;

    if (!lastSettings) {
      const p = document.createElement("p");
      p.className = "settings-empty";
      p.textContent = "Loading settings…";
      setupConfigEl.appendChild(p);
      return;
    }

    const agents = lastSettings.agents || [];
    const hook = lastSettings.hook || { installed: false, lastActivityAt: null };

    // ── 1. Hook health ──
    const hookSection = buildSection("Hook health");
    const hookRow = document.createElement("div");
    hookRow.className = "settings-row hook-row";
    const hookStatus = document.createElement("div");
    hookStatus.className = "hook-status";
    const installedLine = document.createElement("div");
    installedLine.className = hook.installed ? "hook-ok" : "hook-bad";
    installedLine.textContent = hook.installed ? "Hook installed ✓" : "Hook installed ✗";
    const activityLine = document.createElement("div");
    activityLine.className = "hook-activity";
    activityLine.textContent = `Last activity: ${relativeTime(hook.lastActivityAt)}`;
    hookStatus.appendChild(installedLine);
    hookStatus.appendChild(activityLine);
    const repairBtn = document.createElement("button");
    repairBtn.className = "skill-btn settings-btn";
    repairBtn.textContent = "Repair";
    repairBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "repairHook" });
    });
    const troubleshootBtn = document.createElement("button");
    troubleshootBtn.className = "skill-btn settings-btn";
    troubleshootBtn.textContent = "Troubleshoot & Fix";
    troubleshootBtn.addEventListener("click", () => {
      troubleshootBtn.disabled = true;
      troubleshootBtn.textContent = "Checking…";
      vscode.postMessage({ type: "runDoctor" });
    });
    hookRow.appendChild(hookStatus);
    hookRow.appendChild(repairBtn);
    hookRow.appendChild(troubleshootBtn);
    hookSection.appendChild(hookRow);
    const doctorResultsEl = document.createElement("div");
    doctorResultsEl.id = "doctor-results";
    hookSection.appendChild(doctorResultsEl);
    setupConfigEl.appendChild(hookSection);

    // ── 2. Agents ──
    const agentsSection = buildSection("Agents");
    for (const agent of agents) {
      const m = metricsFor(agent.id);
      const row = document.createElement("div");
      row.className = "settings-row agent-row";
      row.dataset.agentRow = agent.id;

      const head = document.createElement("div");
      head.className = "agent-row-head";

      const nameEl = document.createElement("span");
      nameEl.className = "agent-name";
      nameEl.textContent = agent.name || agent.id;
      head.appendChild(nameEl);

      if (agent.isOrchestrator) {
        const ro = document.createElement("span");
        ro.className = "agent-model-readonly";
        ro.textContent = "session model (set by Claude Code)";
        head.appendChild(ro);
      } else {
        const group = document.createElement("div");
        group.className = "model-radio-group";
        const groupName = `model-${agent.id}`;
        for (const model of ["opus", "sonnet", "haiku"]) {
          const lbl = document.createElement("label");
          lbl.className = "model-radio";
          const input = document.createElement("input");
          input.type = "radio";
          input.name = groupName;
          input.value = model;
          if (agent.model === model) input.checked = true;
          input.addEventListener("change", () => {
            if (input.checked) {
              vscode.postMessage({ type: "setAgentModel", id: agent.id, model });
            }
          });
          const span = document.createElement("span");
          span.textContent = model.charAt(0).toUpperCase() + model.slice(1);
          lbl.appendChild(input);
          lbl.appendChild(span);
          group.appendChild(lbl);
        }
        head.appendChild(group);
      }
      row.appendChild(head);

      // Stats from matched metrics
      const stats = document.createElement("div");
      stats.className = "agent-stats";
      const mins = m && m.activeMs ? m.activeMs / 60000 : 0;
      const tpm = mins > 0 ? Math.round((m.tokens || 0) / mins) : 0;
      const chip = (label, value) => {
        const c = document.createElement("span");
        c.className = "stat-chip";
        c.textContent = `${label} ${value}`;
        return c;
      };
      stats.appendChild(chip("tok/min", fmtTokens(tpm)));
      stats.appendChild(chip("tasks", String((m && m.taskCount) || 0)));
      stats.appendChild(chip("MCP", String((m && m.mcpCount) || 0)));
      row.appendChild(stats);

      // Recommendation badge
      const rec = recommendationFor(agent, m);
      if (rec) {
        const badge = document.createElement("div");
        badge.className = `rec-badge rec-${rec.kind}`;
        const txt = document.createElement("span");
        txt.className = "rec-text";
        txt.textContent = rec.text;
        badge.appendChild(txt);
        if (rec.suggest) {
          const apply = document.createElement("button");
          apply.className = "skill-btn settings-btn rec-apply";
          apply.textContent = "Apply";
          apply.addEventListener("click", () => {
            vscode.postMessage({ type: "setAgentModel", id: agent.id, model: rec.suggest });
          });
          badge.appendChild(apply);
        }
        row.appendChild(badge);
      }

      agentsSection.appendChild(row);
    }
    setupConfigEl.appendChild(agentsSection);

    // ── 3. Keyword routing ──
    const routingSection = buildSection("Keyword routing");
    const note = fallbackNote();
    const noteEl = document.createElement("div");
    noteEl.className = `routing-note rec-${note.kind}`;
    const light = document.createElement("span");
    light.className = `routing-light routing-light--${note.light}`;
    const noteText = document.createElement("span");
    noteText.className = "routing-note-text";
    noteText.textContent = note.text;
    noteEl.appendChild(light);
    noteEl.appendChild(noteText);
    routingSection.appendChild(noteEl);

    for (const agent of agents) {
      if (agent.isOrchestrator) continue;
      const row = document.createElement("div");
      row.className = "settings-row keyword-row";
      row.dataset.agentRow = agent.id;

      const lbl = document.createElement("label");
      lbl.className = "keyword-label";
      lbl.textContent = agent.name || agent.id;
      row.appendChild(lbl);

      const inputWrap = document.createElement("div");
      inputWrap.className = "keyword-input-wrap";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "keyword-input";
      input.value = agent.keywords || "";
      input.placeholder = "kw1|kw2|kw3";
      const saveBtn = document.createElement("button");
      saveBtn.className = "skill-btn settings-btn";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "setAgentKeywords", id: agent.id, pattern: input.value });
      });
      inputWrap.appendChild(input);
      inputWrap.appendChild(saveBtn);
      row.appendChild(inputWrap);

      routingSection.appendChild(row);
    }
    setupConfigEl.appendChild(routingSection);

  // ── 3b. Delegation Health ──
  const dhSection = buildSection("Delegation Health");
  const dh = (lastSettings && lastSettings.delegationHealth) || {};
  const directSurveys = (typeof dh.directSurveys === "number") ? dh.directSurveys : 0;
  const directEdits   = (typeof dh.directEdits   === "number") ? dh.directEdits   : 0;
  const delegations   = (typeof dh.delegations   === "number") ? dh.delegations   : 0;
  const warnThreshold = (typeof dh.warnThreshold === "number") ? dh.warnThreshold : 5;
  const dhTotal = directSurveys + directEdits + delegations;
  if (dhTotal === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "settings-empty";
    emptyP.textContent = "No delegatable activity yet this session.";
    dhSection.appendChild(emptyP);
  } else {
    const ratio = delegations / dhTotal;
    const grade = ratio >= 0.8 ? "Excellent" : ratio >= 0.6 ? "Good" : ratio >= 0.4 ? "Fair" : "Needs work";
    const badge = document.createElement("div");
    badge.className = "rec-badge rec-info";
    const badgeSpan = document.createElement("span");
    badgeSpan.className = "rec-text";
    badgeSpan.textContent = `${grade} — ${Math.round(ratio * 100)}%`;
    badge.appendChild(badgeSpan);
    dhSection.appendChild(badge);

    const summaryRow = document.createElement("div");
    summaryRow.className = "settings-row";
    const summarySpan = document.createElement("span");
    summarySpan.textContent = `Orchestrator ran ${directSurveys} searches and ${directEdits} edits directly, and delegated ${delegations} tasks.`;
    summaryRow.appendChild(summarySpan);
    dhSection.appendChild(summaryRow);

    const searchRow = document.createElement("div");
    searchRow.className = "settings-row";
    const searchSpan = document.createElement("span");
    searchSpan.textContent = `Direct searches: ${directSurveys} — delegate to search-retrieval (Haiku, ~40x cheaper)`;
    if (directSurveys > warnThreshold) { searchSpan.style.color = "#e0a000"; }
    searchRow.appendChild(searchSpan);
    dhSection.appendChild(searchRow);

    const editRow = document.createElement("div");
    editRow.className = "settings-row";
    const editSpan = document.createElement("span");
    editSpan.textContent = `Direct edits: ${directEdits} — delegate to coding-specialist (Sonnet)`;
    editRow.appendChild(editSpan);
    dhSection.appendChild(editRow);

    const delegRow = document.createElement("div");
    delegRow.className = "settings-row";
    const delegSpan = document.createElement("span");
    delegSpan.textContent = `Delegations: ${delegations}`;
    delegRow.appendChild(delegSpan);
    dhSection.appendChild(delegRow);

    const btnRow = document.createElement("div");
    btnRow.className = "settings-row";
    const copyBtn = document.createElement("button");
    copyBtn.className = "skill-btn settings-btn";
    copyBtn.textContent = "Copy delegation tip";
    copyBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "copyNudge", text: "Delegate all searches and file reads to sub-agents per CLAUDE.md - search-retrieval for lookups, coding-specialist for edits." });
    });
    btnRow.appendChild(copyBtn);
    dhSection.appendChild(btnRow);
  }
  setupConfigEl.appendChild(dhSection);

    // ── 4. Danger zone ──
    const dangerSection = buildSection("Danger zone");
    dangerSection.classList.add("danger-section");
    const dangerRow = document.createElement("div");
    dangerRow.className = "settings-row danger-row";
    const resetBtn = document.createElement("button");
    resetBtn.className = "skill-btn settings-btn danger-btn";
    resetBtn.textContent = "Reset session metrics";
    resetBtn.addEventListener("click", () => {
      if (window.confirm("Reset all session metrics? This cannot be undone.")) {
        vscode.postMessage({ type: "resetMetrics" });
      }
    });
    dangerStatusEl = document.createElement("span");
    dangerStatusEl.className = "danger-status";
    dangerRow.appendChild(resetBtn);
    dangerRow.appendChild(dangerStatusEl);
    dangerSection.appendChild(dangerRow);
    setupConfigEl.appendChild(dangerSection);
  }

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
