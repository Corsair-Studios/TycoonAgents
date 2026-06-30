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
  const menuThemesBtn   = /** @type {HTMLElement} */ (document.getElementById("menu-themes"));
  
  // Themes Modal Elements
  const themesModalEl       = /** @type {HTMLElement} */ (document.getElementById("themes-modal"));
  const themesModalCloseBtn = /** @type {HTMLElement} */ (document.getElementById("themes-modal-close"));
  const tabThemePicker      = /** @type {HTMLElement} */ (document.getElementById("tab-theme-picker"));
  const tabThemeBuilder     = /** @type {HTMLElement} */ (document.getElementById("tab-theme-builder"));
  const themePickerList     = /** @type {HTMLElement} */ (document.getElementById("theme-picker-list"));
  const themeBuilderPanel   = /** @type {HTMLElement} */ (document.getElementById("theme-builder-panel"));
  const themePickerGrid     = /** @type {HTMLElement} */ (document.getElementById("theme-picker-grid"));
  const themePickerStatus   = /** @type {HTMLElement} */ (document.getElementById("theme-picker-status"));
  const themeImportBtn      = /** @type {HTMLButtonElement} */ (document.getElementById("theme-import-btn"));
  const themePromptInput    = /** @type {HTMLInputElement} */ (document.getElementById("theme-prompt-input"));
  const themeGenerateBtn    = /** @type {HTMLElement} */ (document.getElementById("theme-generate-btn"));
  const themePlanEditor     = /** @type {HTMLElement} */ (document.getElementById("theme-plan-editor"));
  const themePlanName       = /** @type {HTMLInputElement} */ (document.getElementById("theme-plan-name"));
  const themePlanDirection  = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-direction"));
  const themePlanCharacters = /** @type {HTMLElement} */ (document.getElementById("theme-plan-characters"));
  const themePlanEnvironment = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-environment"));
  const themePlanEnemies    = /** @type {HTMLElement} */ (document.getElementById("theme-plan-enemies"));
  const themePlanObjects    = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-objects"));
  const themePlanExpressions = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-expressions"));
  const themePlanAchievements = /** @type {HTMLTextAreaElement} */ (document.getElementById("theme-plan-achievements"));
  const themePlanValidation = /** @type {HTMLElement} */ (document.getElementById("theme-plan-validation"));
  const themePauseForReview = /** @type {HTMLInputElement} */ (document.getElementById("theme-pause-for-review"));
  const themeStartGenerationBtn = /** @type {HTMLButtonElement} */ (document.getElementById("theme-start-generation-btn"));
  const themeBuildStatus    = /** @type {HTMLElement} */ (document.getElementById("theme-build-status"));
  const themeBuildActions   = /** @type {HTMLElement} */ (document.getElementById("theme-build-actions"));
  const themeReviewImagesBtn = /** @type {HTMLElement} */ (document.getElementById("theme-review-images-btn"));
  const themeImageProvider  = /** @type {HTMLSelectElement} */ (document.getElementById("theme-image-provider"));
  const themeApiKeyInput    = /** @type {HTMLInputElement} */ (document.getElementById("theme-api-key-input"));
  const themeApiKeyLabel    = /** @type {HTMLElement} */ (document.getElementById("theme-api-key-label"));
  const themeApiKeySave     = /** @type {HTMLElement} */ (document.getElementById("theme-api-key-save"));
  const themeApiKeyStatus   = /** @type {HTMLElement} */ (document.getElementById("theme-api-key-status"));
  const themeImageReview    = /** @type {HTMLElement} */ (document.getElementById("theme-image-review"));
  const themeImageReviewTitle = /** @type {HTMLElement} */ (document.getElementById("theme-image-review-title"));
  const themeImageReviewSummary = /** @type {HTMLElement} */ (document.getElementById("theme-image-review-summary"));
  const themeImageReviewList = /** @type {HTMLElement} */ (document.getElementById("theme-image-review-list"));
  const themeReviewResumeGeneration = /** @type {HTMLButtonElement} */ (document.getElementById("theme-review-resume-generation"));
  const themeReviewStopGeneration = /** @type {HTMLButtonElement} */ (document.getElementById("theme-review-stop-generation"));
  const themeApproveAll = /** @type {HTMLButtonElement} */ (document.getElementById("theme-approve-all"));
  const themeOpenImagesFolder = /** @type {HTMLElement} */ (document.getElementById("theme-open-images-folder"));
  const themeImageLightbox = /** @type {HTMLElement} */ (document.getElementById("theme-image-lightbox"));
  const themeImageLightboxBackdrop = /** @type {HTMLElement} */ (document.getElementById("theme-image-lightbox-backdrop"));
  const themeImageLightboxClose = /** @type {HTMLButtonElement} */ (document.getElementById("theme-image-lightbox-close"));
  const themeImageLightboxTitle = /** @type {HTMLElement} */ (document.getElementById("theme-image-lightbox-title"));
  const themeImageLightboxImage = /** @type {HTMLImageElement} */ (document.getElementById("theme-image-lightbox-image"));
  const themeBuilderRoot = /** @type {HTMLElement} */ (document.getElementById("theme-builder-root"));
  const themesDialog = /** @type {HTMLElement} */ (document.getElementById("themes-dialog"));
  let reviewThemeId = "";
  /** @type {Array<any>} Last received THEMES_LIST payload, for re-render on selection change. */
  let lastThemesList = [];
  let currentThemePlan = null;
  let themeGenerationRunning = false;
  let themeGenerationStopping = false;
  let themeImageSettingsLoaded = false;
  let themeProviderConfigured = { gemini: false, openai: false };
  let themeImageLightboxTrigger = null;
  const themeReviewBusyItems = new Map();
  /** The review-card "Upload" button awaiting a host result (for busy reset). */
  let pendingUploadBtn = null;

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

  if (menuThemesBtn) {
    menuThemesBtn.addEventListener("click", () => {
      closeMenu();
      themePickerList.removeAttribute("hidden");
      themeBuilderPanel.setAttribute("hidden", "");
      openModal(themesModalEl, themesModalCloseBtn);
      vscode.postMessage({ type: 'LIST_THEMES' });
    });
  }

  if (themesModalCloseBtn) {
    themesModalCloseBtn.addEventListener("click", () => closeModal(themesModalEl));
  }

  if (themeImportBtn) {
    themeImportBtn.addEventListener("click", () => {
      themeImportBtn.disabled = true;
      if (themePickerStatus) {
        themePickerStatus.textContent = "Choose a theme .zip file...";
        themePickerStatus.classList.remove("theme-picker-status--error");
      }
      vscode.postMessage({ type: "IMPORT_THEME" });
    });
  }

  if (tabThemePicker && tabThemeBuilder) {
    tabThemePicker.addEventListener("click", () => {
      themePickerList.removeAttribute("hidden");
      themeBuilderPanel.setAttribute("hidden", "");
      tabThemeBuilder.focus();
      vscode.postMessage({ type: 'LIST_THEMES' });
    });

    tabThemeBuilder.addEventListener("click", () => {
      themeBuilderPanel.removeAttribute("hidden");
      themePickerList.setAttribute("hidden", "");
      tabThemePicker.focus();
      if (themeImageReview) themeImageReview.setAttribute("hidden", "");
      if (themeBuilderRoot) {
        if (themePlanEditor && !themePlanEditor.hasAttribute("hidden")) themeBuilderRoot.setAttribute("hidden", "");
        else themeBuilderRoot.removeAttribute("hidden");
      }

      // Boot up the theme builder canvas when the tab is first visited
      const root = document.getElementById("theme-builder-root");
      if (root && typeof window.initThemeBuilder === "function") {
        window.initThemeBuilder(root);
      }
      vscode.postMessage({ type: 'GET_THEME_IMAGE_SETTINGS' });
    });
  }

  function selectedThemeImageProvider() {
    return themeImageProvider && themeImageProvider.value === "gemini" ? "gemini" : "openai";
  }

  function updateThemeApiKeyUi(message, isError) {
    const provider = selectedThemeImageProvider();
    const providerLabel = provider === "openai" ? "OpenAI" : "Google Gemini";
    if (themeApiKeyLabel) themeApiKeyLabel.textContent = providerLabel + " API key";
    if (themeApiKeyInput) {
      themeApiKeyInput.placeholder = themeProviderConfigured[provider]
        ? "Key stored - paste to replace"
        : "Paste a key to save securely";
    }
    if (themeApiKeyStatus) {
      themeApiKeyStatus.textContent = message || (themeProviderConfigured[provider]
        ? providerLabel + " key is configured."
        : providerLabel + " key is not configured.");
      themeApiKeyStatus.style.color = isError
        ? "var(--vscode-errorForeground)"
        : "var(--vscode-descriptionForeground)";
    }
  }

  if (themeImageProvider) {
    themeImageProvider.addEventListener("change", () => updateThemeApiKeyUi("", false));
  }

  if (themeApiKeySave) {
    themeApiKeySave.addEventListener("click", () => {
      const provider = selectedThemeImageProvider();
      const apiKey = themeApiKeyInput ? themeApiKeyInput.value.trim() : "";
      if (!apiKey && !themeProviderConfigured[provider]) {
        updateThemeApiKeyUi("Paste an API key before saving.", true);
        return;
      }
      themeApiKeySave.setAttribute("disabled", "");
      themeApiKeySave.textContent = "Saving...";
      vscode.postMessage({
        type: 'SAVE_THEME_IMAGE_SETTINGS',
        payload: { provider, api_key: apiKey },
      });
    });
  }

  if (themeGenerateBtn && themePromptInput) {
    themeGenerateBtn.addEventListener("click", () => {
      const prompt = themePromptInput.value.trim();
      if (!prompt) return;
      const imageProvider = selectedThemeImageProvider();
      if (themeImageSettingsLoaded && !themeProviderConfigured[imageProvider]) {
        updateThemeApiKeyUi("Add and save an API key before generating.", true);
        return;
      }
      
      themeGenerateBtn.setAttribute("disabled", "");
      themeGenerateBtn.textContent = "Planning...";
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "AI is filling the theme slots...";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      
      vscode.postMessage({
        type: 'PLAN_THEME',
        payload: { prompt, image_provider: imageProvider },
      });
    });
  }

  function renderPlanSlots(container, values, groupName) {
    if (!container) return;
    container.innerHTML = "";
    values.forEach((value, index) => {
      const label = document.createElement("label");
      label.className = "theme-plan-slot";
      const number = document.createElement("span");
      number.textContent = String(index + 1).padStart(2, "0");
      const input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.dataset.planGroup = groupName;
      input.dataset.planIndex = String(index);
      label.appendChild(number);
      label.appendChild(input);
      container.appendChild(label);
    });
  }

  function renderThemePlan(plan) {
    currentThemePlan = plan;
    if (themePlanName) themePlanName.value = plan.display_name || "";
    if (themePlanDirection) themePlanDirection.value = plan.creative_direction || "";
    if (themePlanEnvironment) themePlanEnvironment.value = plan.environment || "";
    if (themePlanObjects) themePlanObjects.value = (plan.objects || []).join(", ");
    if (themePlanExpressions) themePlanExpressions.value = (plan.expressions || []).join(", ");
    if (themePlanAchievements) themePlanAchievements.value = (plan.achievements || []).join(", ");
    renderPlanSlots(themePlanCharacters, plan.characters || [], "characters");
    renderPlanSlots(themePlanEnemies, plan.enemies || [], "enemies");
    if (themePlanValidation) themePlanValidation.textContent = "";
    if (themePlanEditor) themePlanEditor.removeAttribute("hidden");
    if (themeImageReview) themeImageReview.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
  }

  function collectPlanSlots(container) {
    return container
      ? Array.from(container.querySelectorAll("input")).map((input) => input.value.trim()).filter(Boolean)
      : [];
  }

  function collectCommaList(input, expected, label) {
    const values = input ? input.value.split(",").map((value) => value.trim()).filter(Boolean) : [];
    if (values.length !== expected) throw new Error(`${label} needs exactly ${expected} comma-separated entries (currently ${values.length}).`);
    return values;
  }

  function collectEditedThemePlan() {
    const characters = collectPlanSlots(themePlanCharacters);
    const enemies = collectPlanSlots(themePlanEnemies);
    if (characters.length !== 16) throw new Error(`Characters needs all 16 filled slots (currently ${characters.length}).`);
    if (enemies.length !== 3) throw new Error(`Enemies needs all 3 filled slots (currently ${enemies.length}).`);
    const displayName = themePlanName ? themePlanName.value.trim() : "";
    const creativeDirection = themePlanDirection ? themePlanDirection.value.trim() : "";
    const environment = themePlanEnvironment ? themePlanEnvironment.value.trim() : "";
    if (!displayName || !creativeDirection || !environment) throw new Error("Theme name, creative direction, and environment are required.");
    return {
      ...currentThemePlan,
      theme_id: "",
      display_name: displayName,
      creative_direction: creativeDirection,
      characters,
      environment,
      enemies,
      objects: collectCommaList(themePlanObjects, 12, "Objects"),
      expressions: collectCommaList(themePlanExpressions, 16, "Expressions"),
      achievements: collectCommaList(themePlanAchievements, 20, "Achievement badges"),
    };
  }

  function requestThemeGenerationStop() {
    if (!themeGenerationRunning || themeGenerationStopping) return;
    themeGenerationStopping = true;
    if (themeStartGenerationBtn) {
      themeStartGenerationBtn.disabled = true;
      themeStartGenerationBtn.textContent = "Stopping...";
    }
    if (themeReviewStopGeneration) {
      themeReviewStopGeneration.disabled = true;
      themeReviewStopGeneration.textContent = "Stopping...";
    }
    vscode.postMessage({ type: 'CANCEL_THEME_GENERATION' });
  }

  function disableThemeRetryButtons() {
    if (!themeImageReviewList) return;
    for (const button of themeImageReviewList.querySelectorAll(".theme-review-retry")) {
      button.disabled = true;
    }
  }

  if (themePauseForReview) {
    themePauseForReview.addEventListener("change", () => {
      vscode.postMessage({
        type: 'SET_THEME_PAUSE_FOR_REVIEW',
        payload: { pause_for_review: themePauseForReview.checked },
      });
      if (themeGenerationRunning && themeBuildStatus) {
        if (!themePauseForReview.checked) disableThemeRetryButtons();
        themeBuildStatus.textContent = themePauseForReview.checked
          ? "Approval pauses are on. The next completed image will wait for review."
          : "Approval pauses are off. Generation will continue automatically.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
    });
  }

  if (themeStartGenerationBtn) {
    themeStartGenerationBtn.addEventListener("click", () => {
      if (themeGenerationRunning) {
        requestThemeGenerationStop();
        return;
      }
      try {
        const imageProvider = selectedThemeImageProvider();
        if (themeImageSettingsLoaded && !themeProviderConfigured[imageProvider]) {
          updateThemeApiKeyUi("Add and save an API key before generating.", true);
          return;
        }
        const plan = collectEditedThemePlan();
        currentThemePlan = plan;
        themeGenerationRunning = true;
        themeGenerationStopping = false;
        reviewThemeId = "";
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Stop generation";
        if (themeGenerateBtn) themeGenerateBtn.setAttribute("disabled", "");
        if (themePlanValidation) themePlanValidation.textContent = "";
        if (themeBuildActions) themeBuildActions.setAttribute("hidden", "");
        if (themeBuildStatus) {
          themeBuildStatus.textContent = themePauseForReview?.checked === false
            ? "Preparing 23 image generations..."
            : "Preparing the first image. Generation will pause for approval after each one.";
          themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
        }
        vscode.postMessage({
          type: 'GENERATE_THEME',
          payload: {
            plan,
            image_provider: imageProvider,
            pause_for_review: themePauseForReview?.checked !== false,
          },
        });
      } catch (error) {
        if (themePlanValidation) themePlanValidation.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  }

  if (themeReviewStopGeneration) {
    themeReviewStopGeneration.addEventListener("click", requestThemeGenerationStop);
  }

  if (themeReviewResumeGeneration) {
    themeReviewResumeGeneration.addEventListener("click", () => {
      if (!reviewThemeId || themeGenerationRunning) return;
      const imageProvider = selectedThemeImageProvider();
      if (themeImageSettingsLoaded && !themeProviderConfigured[imageProvider]) {
        updateThemeApiKeyUi("Add and save an API key before resuming.", true);
        return;
      }
      themeGenerationRunning = true;
      themeGenerationStopping = false;
      themeReviewResumeGeneration.hidden = true;
      themeReviewResumeGeneration.disabled = true;
      if (themeReviewStopGeneration) {
        themeReviewStopGeneration.hidden = false;
        themeReviewStopGeneration.disabled = false;
        themeReviewStopGeneration.textContent = "Stop generation";
      }
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Resuming unfinished image generations...";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      vscode.postMessage({
        type: 'GENERATE_THEME',
        payload: {
          resume_theme_id: reviewThemeId,
          image_provider: imageProvider,
          pause_for_review: themePauseForReview?.checked !== false,
        },
      });
    });
  }

  if (themeApproveAll) {
    themeApproveAll.addEventListener("click", () => {
      if (!reviewThemeId) return;
      themeApproveAll.disabled = true;
      themeApproveAll.textContent = "Approving...";
      vscode.postMessage({
        type: 'APPROVE_ALL_THEME_IMAGES',
        payload: { theme_id: reviewThemeId },
      });
    });
  }

  if (themeReviewImagesBtn) {
    themeReviewImagesBtn.addEventListener("click", () => {
      showThemeImageReview(reviewThemeId);
    });
  }

  if (themeOpenImagesFolder) {
    themeOpenImagesFolder.addEventListener("click", () => openThemeImages(reviewThemeId));
  }

  function openThemeImages(themeId) {
    if (!themeId) return;
    vscode.postMessage({ type: 'OPEN_THEME_IMAGES', payload: { theme_id: themeId } });
  }

  function openThemeImageLightbox(imageSrc, label, trigger) {
    if (!themeImageLightbox || !themeImageLightboxImage) return;
    themeImageLightboxTrigger = trigger;
    themeImageLightboxImage.src = imageSrc;
    themeImageLightboxImage.alt = label;
    if (themeImageLightboxTitle) themeImageLightboxTitle.textContent = label;
    themeImageLightbox.removeAttribute("hidden");
    themeImageLightboxClose?.focus();
  }

  function closeThemeImageLightbox() {
    if (!themeImageLightbox || themeImageLightbox.hasAttribute("hidden")) return;
    themeImageLightbox.setAttribute("hidden", "");
    if (themeImageLightboxImage) {
      themeImageLightboxImage.removeAttribute("src");
      themeImageLightboxImage.alt = "";
    }
    themeImageLightboxTrigger?.focus();
    themeImageLightboxTrigger = null;
  }

  themeImageLightboxClose?.addEventListener("click", closeThemeImageLightbox);
  themeImageLightboxBackdrop?.addEventListener("click", closeThemeImageLightbox);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && themeImageLightbox && !themeImageLightbox.hasAttribute("hidden")) {
      event.stopImmediatePropagation();
      closeThemeImageLightbox();
    }
  });

  function showThemeImageReview(themeId) {
    if (!themeId) return;
    reviewThemeId = themeId;
    themePickerList.setAttribute("hidden", "");
    themeBuilderPanel.removeAttribute("hidden");
    if (themePlanEditor) themePlanEditor.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
    if (themeImageReview) themeImageReview.removeAttribute("hidden");
    if (themeImageReviewList) themeImageReviewList.textContent = "Loading generated images...";
    if (themeApproveAll) {
      themeApproveAll.disabled = true;
      themeApproveAll.textContent = "Approve all";
    }
    vscode.postMessage({ type: 'GET_THEME_IMAGE_SETTINGS' });
    vscode.postMessage({ type: 'GET_THEME_IMAGE_REVIEW', payload: { theme_id: themeId } });
  }

  function captureThemeReviewUiState() {
    const drafts = new Map();
    if (themeImageReviewList) {
      for (const card of themeImageReviewList.querySelectorAll("[data-item-id]")) {
        const itemId = card.getAttribute("data-item-id");
        if (!itemId) continue;
        drafts.set(itemId, {
          feedback: card.querySelector(".theme-review-feedback")?.value || "",
          mode: card.querySelector(".theme-review-mode")?.value || "",
          characterName: card.querySelector(".theme-review-name-input")?.value || "",
          promptOpen: Boolean(card.querySelector(".theme-review-prompt")?.open),
        });
      }
    }
    return {
      drafts,
      scrollTop: themesDialog?.scrollTop || 0,
    };
  }

  function renderThemeImageReview(payload) {
    if (!themeImageReview || !themeImageReviewList) return;
    // Host updates can arrive while the user is editing a different card. Keep
    // those local drafts and the review position instead of treating every
    // update as a brand-new panel.
    const reviewUiState = captureThemeReviewUiState();
    themeImageReview.removeAttribute("hidden");
    if (themePlanEditor) themePlanEditor.setAttribute("hidden", "");
    if (themeBuilderRoot) themeBuilderRoot.setAttribute("hidden", "");
    themeImageReviewList.innerHTML = "";
    if (payload.error) {
      if (themeApproveAll) themeApproveAll.disabled = true;
      const error = document.createElement("div");
      error.className = "theme-review-empty theme-review-error";
      error.textContent = "Could not load generated images: " + payload.error;
      themeImageReviewList.appendChild(error);
      return;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const waitingForReviewItemId = payload.waiting_for_review_item_id || "";
    const accepted = items.filter((item) => item.status === "accepted").length;
    const rejected = items.filter((item) => item.status === "rejected").length;
    const blocked = items.filter((item) => Boolean(item.generation_error)).length;
    const unfinished = items.filter((item) => item.generated !== true).length;
    const allGenerated = items.length > 0 && items.every((item) => Boolean(item.image_src));
    const allApproved = items.length > 0 && accepted === items.length;
    const activeGenerationItemId = payload.generation_active && !waitingForReviewItemId
      ? items.find((item) => item.generated !== true)?.id || ""
      : "";
    themeGenerationRunning = Boolean(payload.generation_active);
    if (themePauseForReview && typeof payload.pause_for_review === "boolean") {
      themePauseForReview.checked = payload.pause_for_review;
    }
    if (themeImageReviewTitle) {
      themeImageReviewTitle.textContent = (payload.display_name || "Theme") + " images";
    }
    if (themeImageReviewSummary) {
      themeImageReviewSummary.classList.remove("theme-review-error");
      themeImageReviewSummary.textContent = items.length
        ? `${accepted} accepted · ${rejected} rejected · ${blocked} blocked · ${items.length - accepted - rejected - blocked} pending`
        : (payload.generation_active ? "Waiting for the first image..." : "No generated images found.");
    }
    if (themeReviewStopGeneration) {
      themeReviewStopGeneration.hidden = !payload.generation_active;
      themeReviewStopGeneration.disabled = themeGenerationStopping;
      themeReviewStopGeneration.textContent = themeGenerationStopping ? "Stopping..." : "Stop generation";
    }
    if (themeReviewResumeGeneration) {
      themeReviewResumeGeneration.hidden = Boolean(payload.generation_active) || unfinished === 0;
      themeReviewResumeGeneration.disabled = Boolean(payload.generation_active);
      themeReviewResumeGeneration.textContent = unfinished === 1
        ? "Resume 1 generation"
        : `Resume ${unfinished} generations`;
      themeReviewResumeGeneration.title = unfinished > 0
        ? "Continue from the first unfinished image without regenerating completed work."
        : "Every image generation is complete.";
    }
    if (themeApproveAll) {
      themeApproveAll.disabled = Boolean(payload.generation_active) || !allGenerated || allApproved;
      themeApproveAll.textContent = allApproved ? "All approved" : "Approve all";
      themeApproveAll.title = allApproved
        ? "Every theme image is approved."
        : payload.generation_active || !allGenerated
          ? "Available after every theme image has finished generating."
          : `Approve all ${items.length} theme images.`;
    }

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "theme-review-empty";
      empty.textContent = payload.generation_active
        ? "Generation is running. Images will appear here as they finish."
        : "No generated images are available for this theme.";
      themeImageReviewList.appendChild(empty);
      return;
    }

    for (const item of items) {
      const isCurrentReviewGate = waitingForReviewItemId === item.id;
      const card = document.createElement("article");
      card.className = "theme-review-card theme-review-card--" + item.status
        + (isCurrentReviewGate ? " theme-review-card--current" : "")
        + (item.generation_error ? " theme-review-card--blocked" : "");
      card.dataset.itemId = item.id;

      const preview = item.image_src ? document.createElement("button") : document.createElement("div");
      preview.className = "theme-review-preview" + (item.image_src ? "" : " theme-review-preview--missing");
      if (item.kind === "character_atlas") preview.classList.add("theme-review-preview--character");
      if (item.image_src) {
        preview.type = "button";
        preview.setAttribute("aria-label", `View full-size image of ${item.label}`);
        const previewImage = document.createElement("img");
        previewImage.src = item.image_src;
        previewImage.alt = item.label;
        preview.appendChild(previewImage);
        preview.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openThemeImageLightbox(item.image_src, item.label, preview);
        });
      } else {
        preview.textContent = item.generation_error ? "Generation blocked" : "Not generated yet";
      }

      const body = document.createElement("div");
      body.className = "theme-review-card-body";
      const heading = document.createElement("div");
      heading.className = "theme-review-card-heading";
      const title = document.createElement("h4");
      title.textContent = item.label;
      const status = document.createElement("span");
      status.className = "theme-review-status theme-review-status--"
        + (item.generation_error ? "blocked" : item.status);
      status.textContent = item.generation_error ? "blocked" : item.status;
      heading.appendChild(title);
      heading.appendChild(status);

      const meta = document.createElement("div");
      meta.className = "theme-review-meta";
      meta.textContent = `${item.kind.replace(/_/g, " ")} · revision ${item.revision}`;

      let generationError = null;
      if (item.generation_error) {
        generationError = document.createElement("div");
        generationError.className = "theme-review-generation-error";
        const errorMessage = document.createElement("strong");
        errorMessage.textContent = item.generation_error.message
          || "This image request was blocked. Revise its instructions and retry.";
        generationError.appendChild(errorMessage);
        const errorHelp = document.createElement("span");
        errorHelp.textContent = item.generation_error.request_id
          ? `Revise the creative direction below and retry. Request ID: ${item.generation_error.request_id}`
          : "Revise the creative direction below and retry.";
        generationError.appendChild(errorHelp);
      }

      let characterNameInput = null;
      let renameBtn = null;
      let nameRow = null;
      if (item.kind === "character_atlas") {
        nameRow = document.createElement("label");
        nameRow.className = "theme-review-name-row";
        const nameLabel = document.createElement("span");
        nameLabel.textContent = "Character name";
        characterNameInput = document.createElement("input");
        characterNameInput.className = "theme-review-name-input";
        characterNameInput.type = "text";
        characterNameInput.maxLength = 80;
        const savedDraft = reviewUiState.drafts.get(item.id);
        characterNameInput.value = savedDraft?.characterName || item.subject || item.label || "";
        characterNameInput.disabled = Boolean(payload.generation_active && !isCurrentReviewGate);
        renameBtn = document.createElement("button");
        renameBtn.className = "skill-btn theme-review-rename";
        renameBtn.type = "button";
        renameBtn.textContent = "Save name";
        renameBtn.disabled = true;
        const updateRenameState = () => {
          const nextName = characterNameInput.value.trim().replace(/\s+/g, " ");
          renameBtn.disabled = characterNameInput.disabled || !nextName || nextName === item.subject;
        };
        characterNameInput.addEventListener("input", updateRenameState);
        characterNameInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !renameBtn.disabled) {
            event.preventDefault();
            renameBtn.click();
          }
        });
        renameBtn.addEventListener("click", () => {
          const nextName = characterNameInput.value.trim().replace(/\s+/g, " ");
          if (!nextName) {
            characterNameInput.focus();
            characterNameInput.setAttribute("aria-invalid", "true");
            return;
          }
          characterNameInput.removeAttribute("aria-invalid");
          characterNameInput.disabled = true;
          renameBtn.disabled = true;
          renameBtn.textContent = "Saving...";
          themeReviewBusyItems.set(item.id, "rename");
          vscode.postMessage({
            type: 'RENAME_THEME_CHARACTER',
            payload: { theme_id: reviewThemeId, item_id: item.id, name: nextName },
          });
        });
        if (themeReviewBusyItems.get(item.id) === "rename") {
          characterNameInput.disabled = true;
          renameBtn.disabled = true;
          renameBtn.textContent = "Saving...";
        }
        nameRow.appendChild(nameLabel);
        nameRow.appendChild(characterNameInput);
        nameRow.appendChild(renameBtn);
      }

      const decisionRow = document.createElement("div");
      decisionRow.className = "theme-review-actions";
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "skill-btn theme-review-accept";
      acceptBtn.textContent = "Keep";
      acceptBtn.disabled = !item.image_src
        || themeReviewBusyItems.has(item.id)
        || (payload.generation_active && !isCurrentReviewGate);
      acceptBtn.addEventListener("click", () => {
        acceptBtn.disabled = true;
        rejectBtn.disabled = true;
        if (isCurrentReviewGate) disableThemeRetryButtons();
        acceptBtn.textContent = "Keeping...";
        vscode.postMessage({
          type: 'SET_THEME_IMAGE_REVIEW_STATUS',
          payload: { theme_id: reviewThemeId, item_id: item.id, status: 'accepted' },
        });
      });
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "skill-btn theme-review-reject";
      rejectBtn.textContent = "Needs changes";
      rejectBtn.disabled = !item.image_src
        || themeReviewBusyItems.has(item.id)
        || (payload.generation_active && !isCurrentReviewGate);
      rejectBtn.addEventListener("click", () => {
        vscode.postMessage({
          type: 'SET_THEME_IMAGE_REVIEW_STATUS',
          payload: { theme_id: reviewThemeId, item_id: item.id, status: 'rejected' },
        });
      });
      decisionRow.appendChild(acceptBtn);
      decisionRow.appendChild(rejectBtn);
      if (item.kind === "character_atlas") {
        const normalizeBtn = document.createElement("button");
        normalizeBtn.className = "skill-btn theme-review-normalize";
        normalizeBtn.type = "button";
        normalizeBtn.dataset.idleText = "Normalize size";
        normalizeBtn.textContent = "Normalize size";
        normalizeBtn.disabled = !item.image_src || Boolean(payload.generation_active && !isCurrentReviewGate);
        normalizeBtn.title = "Regenerate this character, then fit every frame to the shared production scale.";
        if (themeReviewBusyItems.get(item.id) === "normalize") {
          normalizeBtn.disabled = true;
          normalizeBtn.textContent = "Regenerating...";
        }
        normalizeBtn.addEventListener("click", () => {
          normalizeBtn.disabled = true;
          normalizeBtn.textContent = "Regenerating...";
          acceptBtn.disabled = true;
          rejectBtn.disabled = true;
          themeReviewBusyItems.set(item.id, "normalize");
          vscode.postMessage({
            type: 'NORMALIZE_THEME_CHARACTER',
            payload: {
              theme_id: reviewThemeId,
              item_id: item.id,
              image_provider: selectedThemeImageProvider(),
            },
          });
        });
        decisionRow.appendChild(normalizeBtn);
      }

      // Manual replacement: upload an image from disk for this specific asset.
      const uploadBtn = document.createElement("button");
      uploadBtn.className = "skill-btn theme-review-upload";
      uploadBtn.type = "button";
      uploadBtn.dataset.idleText = "Upload";
      uploadBtn.textContent = "Upload";
      uploadBtn.title = item.kind === "character_atlas"
        ? "Replace this character with a 512×512 atlas image from your computer (it will be re-sliced)."
        : "Replace this image with one from your computer.";
      uploadBtn.disabled = Boolean(payload.generation_active && !isCurrentReviewGate);
      uploadBtn.addEventListener("click", () => {
        uploadBtn.disabled = true;
        uploadBtn.textContent = "Uploading…";
        pendingUploadBtn = uploadBtn;
        vscode.postMessage({
          type: 'UPLOAD_THEME_IMAGE',
          payload: {
            theme_id: reviewThemeId,
            item_id: item.id,
            image_provider: selectedThemeImageProvider(),
          },
        });
      });
      decisionRow.appendChild(uploadBtn);

      const feedback = document.createElement("textarea");
      feedback.className = "theme-review-feedback";
      feedback.rows = 3;
      feedback.placeholder = item.generation_error
        ? "Replace the blocked creative direction with neutral, non-graphic visual instructions."
        : "Write a revised prompt or describe exactly what should change for this item.";
      const savedDraft = reviewUiState.drafts.get(item.id);
      if (savedDraft) feedback.value = savedDraft.feedback;
      const retryRow = document.createElement("div");
      retryRow.className = "theme-review-retry-row";
      const mode = document.createElement("select");
      mode.className = "theme-review-mode";
      const augmentOption = document.createElement("option");
      augmentOption.value = "augment";
      augmentOption.textContent = "Add notes to original prompt";
      const replaceOption = document.createElement("option");
      replaceOption.value = "replace";
      replaceOption.textContent = "Replace creative direction";
      const retryOption = document.createElement("option");
      retryOption.value = "retry";
      retryOption.textContent = "No notes, just retry";
      retryOption.disabled = !item.prompt;
      mode.appendChild(augmentOption);
      mode.appendChild(replaceOption);
      mode.appendChild(retryOption);
      if (item.generation_error) mode.value = "replace";
      if (savedDraft?.mode
          && Array.from(mode.options).some((option) => option.value === savedDraft.mode && !option.disabled)) {
        mode.value = savedDraft.mode;
      }
      const retryBtn = document.createElement("button");
      retryBtn.className = "skill-btn theme-review-retry";
      const retryIdleText = item.image_src || item.generation_error ? "Retry image" : "Generate image";
      retryBtn.dataset.idleText = retryIdleText;
      const retryBusy = themeReviewBusyItems.get(item.id) === "retry";
      retryBtn.textContent = retryBusy || item.id === activeGenerationItemId
        ? "Generating..."
        : payload.generation_active && !item.image_src && !isCurrentReviewGate
          ? "Queued"
          : retryIdleText;
      // An inactive run may leave a valid review item without an image. Let the
      // user recover that checkpoint directly; during an active run, only the
      // exact item paused at the review gate may issue a replacement request.
      retryBtn.disabled = retryBusy || Boolean(payload.generation_active && !isCurrentReviewGate);
      retryBtn.title = !item.image_src && !payload.generation_active
        ? "Generate this unfinished image using the notes above."
        : payload.generation_active && !isCurrentReviewGate
          ? "This image is generating or queued in the active run."
          : "Generate a replacement using the notes above.";
      retryBtn.addEventListener("click", () => {
        const notes = feedback.value.trim();
        if (mode.value !== "retry" && !notes) {
          feedback.focus();
          feedback.setAttribute("aria-invalid", "true");
          return;
        }
        feedback.removeAttribute("aria-invalid");
        retryBtn.disabled = true;
        retryBtn.textContent = "Generating...";
        themeReviewBusyItems.set(item.id, "retry");
        vscode.postMessage({
          type: 'RETRY_THEME_IMAGE',
          payload: {
            theme_id: reviewThemeId,
            item_id: item.id,
            feedback: notes,
            mode: mode.value,
            image_provider: selectedThemeImageProvider(),
            character_name: characterNameInput ? characterNameInput.value.trim() : undefined,
          },
        });
      });
      const updateRetryMode = () => {
        const retriesSavedPrompt = mode.value === "retry";
        feedback.disabled = retriesSavedPrompt;
        if (retriesSavedPrompt) feedback.removeAttribute("aria-invalid");
      };
      mode.addEventListener("change", updateRetryMode);
      updateRetryMode();
      const retryStatus = document.createElement("div");
      retryStatus.className = "theme-review-retry-status";
      retryRow.appendChild(mode);
      retryRow.appendChild(retryBtn);

      const promptDetails = document.createElement("details");
      promptDetails.className = "theme-review-prompt";
      promptDetails.open = Boolean(savedDraft?.promptOpen);
      const promptSummary = document.createElement("summary");
      promptSummary.textContent = "View generation prompt";
      const promptText = document.createElement("pre");
      promptText.textContent = item.prompt || "Legacy image — no original prompt was saved.";
      promptDetails.appendChild(promptSummary);
      promptDetails.appendChild(promptText);

      body.appendChild(heading);
      body.appendChild(meta);
      if (generationError) body.appendChild(generationError);
      if (nameRow) body.appendChild(nameRow);
      body.appendChild(decisionRow);
      body.appendChild(feedback);
      body.appendChild(retryRow);
      body.appendChild(retryStatus);
      body.appendChild(promptDetails);
      card.appendChild(preview);
      card.appendChild(body);
      themeImageReviewList.appendChild(card);
    }
    if (themesDialog) themesDialog.scrollTop = reviewUiState.scrollTop;
  }

  function renderThemesList(themes) {
    if (!themePickerGrid) return;
    themePickerGrid.innerHTML = "";
    
    if (!themes || themes.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.style.color = "var(--vscode-descriptionForeground)";
      emptyMsg.textContent = "No saved themes yet.";
      themePickerGrid.appendChild(emptyMsg);
      return;
    }
    
    for (const theme of themes) {
      const isSelected = selectedThemeId && theme.theme_id === selectedThemeId;
      const row = document.createElement("div");
      row.className = "theme-picker-row" + (isSelected ? " theme-picker-row--selected" : "");

      const themeName = theme.display_name || theme.theme_id;

      const btn = document.createElement("button");
      btn.className = "skill-btn theme-picker-select" + (isSelected ? " theme-picker-select--active" : "");
      const nameLabel = document.createElement("span");
      nameLabel.textContent = themeName;
      const approvalLabel = document.createElement("span");
      approvalLabel.className = "theme-picker-approval" + (theme.export_ready ? " theme-picker-approval--ready" : "");
      approvalLabel.textContent = theme.export_ready
        ? "Ready to export"
        : theme.total
          ? `${theme.accepted}/${theme.total} approved`
          : "Review required";
      btn.appendChild(nameLabel);
      // Selected badge
      if (isSelected) {
        const badge = document.createElement("span");
        badge.className = "theme-selected-badge";
        badge.textContent = "Selected";
        btn.appendChild(badge);
      }
      btn.appendChild(approvalLabel);
      btn.addEventListener("click", () => {
        selectedThemeId = theme.theme_id;
        vscode.postMessage({ type: 'SELECT_THEME', payload: { theme_id: theme.theme_id } });
        // Refresh the list so the selected highlight updates immediately
        renderThemesList(lastThemesList);
      });

      const reviewBtn = document.createElement("button");
      reviewBtn.className = "skill-btn";
      reviewBtn.textContent = "Review images";
      reviewBtn.addEventListener("click", () => {
        showThemeImageReview(theme.theme_id);
      });

      const exportBtn = document.createElement("button");
      exportBtn.className = "skill-btn";
      exportBtn.type = "button";
      exportBtn.textContent = "Export .zip";
      exportBtn.disabled = !theme.export_ready;
      exportBtn.dataset.exportReady = String(Boolean(theme.export_ready));
      exportBtn.title = theme.export_ready
        ? `Export ${themeName} as a .zip file`
        : `Approve every theme image before exporting (${theme.accepted || 0}/${theme.total || 0} approved)`;
      exportBtn.dataset.themeExportId = theme.theme_id;
      exportBtn.addEventListener("click", () => {
        exportBtn.disabled = true;
        if (themePickerStatus) {
          themePickerStatus.textContent = `Exporting ${themeName}...`;
          themePickerStatus.classList.remove("theme-picker-status--error");
        }
        vscode.postMessage({ type: "EXPORT_THEME", payload: { theme_id: theme.theme_id } });
      });

      const sizeLabel = document.createElement("span");
      sizeLabel.className = "theme-picker-size";
      sizeLabel.textContent = formatThemeDiskSize(theme.size_bytes);
      sizeLabel.title = `${Number(theme.size_bytes || 0).toLocaleString()} bytes on disk`;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "skill-btn theme-delete-btn";
      deleteBtn.type = "button";
      deleteBtn.title = `Delete ${themeName}`;
      deleteBtn.setAttribute("aria-label", `Delete ${themeName}`);
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 12H8L7 9Zm3 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z"/></svg>';
      deleteBtn.addEventListener("click", () => {
        deleteBtn.setAttribute("disabled", "");
        if (themePickerStatus) {
          themePickerStatus.textContent = `Waiting to delete ${themeName}…`;
          themePickerStatus.classList.remove("theme-picker-status--error");
        }
        vscode.postMessage({ type: 'DELETE_THEME', payload: { theme_id: theme.theme_id } });
      });

      row.appendChild(btn);
      row.appendChild(reviewBtn);
      row.appendChild(exportBtn);
      row.appendChild(sizeLabel);
      row.appendChild(deleteBtn);
      themePickerGrid.appendChild(row);
    }

    // ── Roster section inside Themes modal ──────────────────────────────────
    // Show the current theme's character roster (drag-reorderable) below the list.
    if (rosterOrder.length > 0) {
      const rosterSection = document.createElement("div");
      rosterSection.className = "modal-roster-section";

      const rosterHeading = document.createElement("div");
      rosterHeading.className = "modal-roster-heading";
      rosterHeading.textContent = "Character roster order";
      rosterSection.appendChild(rosterHeading);

      const rosterNote = document.createElement("div");
      rosterNote.className = "modal-roster-note";
      rosterNote.textContent = "Drag to reorder. The sequence maps agent slots to characters on stage.";
      rosterSection.appendChild(rosterNote);

      const rosterBody = document.createElement("div");
      rosterBody.className = "modal-roster-body";

      let modalDragId = null;

      for (const charId of rosterOrder) {
        const slots = themeImages[charId];
        const thumbImg = slots && (slots[16] || slots[0]);

        const thumb = document.createElement("div");
        thumb.className = "roster-thumb";
        thumb.dataset.charId = charId;
        thumb.draggable = true;
        thumb.title = charId;

        if (thumbImg) {
          const imgEl = document.createElement("img");
          imgEl.src = thumbImg.src;
          imgEl.width = 44;
          imgEl.height = 44;
          imgEl.draggable = false;
          imgEl.style.pointerEvents = "none";
          thumb.appendChild(imgEl);
        } else {
          thumb.textContent = charId.slice(0, 2).toUpperCase();
        }

        // Label below thumbnail
        const charLabel = document.createElement("div");
        charLabel.className = "modal-roster-char-label";
        charLabel.textContent = charId.slice(0, 8);
        thumb.appendChild(charLabel);

        thumb.addEventListener("dragstart", function (e) {
          modalDragId = charId;
          thumb.classList.add("roster-thumb--dragging");
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", charId);
          }
        });

        thumb.addEventListener("dragend", function () {
          thumb.classList.remove("roster-thumb--dragging");
          modalDragId = null;
          rosterBody.querySelectorAll(".roster-thumb--over").forEach(function (el) {
            el.classList.remove("roster-thumb--over");
          });
        });

        thumb.addEventListener("dragover", function (e) {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          if (modalDragId && modalDragId !== charId) {
            thumb.classList.add("roster-thumb--over");
          }
        });

        thumb.addEventListener("dragleave", function () {
          thumb.classList.remove("roster-thumb--over");
        });

        thumb.addEventListener("drop", function (e) {
          e.preventDefault();
          thumb.classList.remove("roster-thumb--over");
          if (!modalDragId || modalDragId === charId) return;

          const fromIdx = rosterOrder.indexOf(modalDragId);
          const toIdx = rosterOrder.indexOf(charId);
          if (fromIdx === -1 || toIdx === -1) return;
          rosterOrder.splice(fromIdx, 1);
          rosterOrder.splice(toIdx, 0, modalDragId);

          const prev = vscode.getState() || {};
          vscode.setState({ ...prev, rosterOrder: rosterOrder.slice() });

          // Also rebuild the stage strip (now a no-op since it's removed from stage)
          buildRosterStrip();
          // Re-render the modal roster
          renderThemesList(lastThemesList);
        });

        rosterBody.appendChild(thumb);
      }

      rosterSection.appendChild(rosterBody);
      themePickerGrid.appendChild(rosterSection);
    }
  }

  function formatThemeDiskSize(bytes) {
    const value = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length);
    const scaled = value / Math.pow(1024, exponent);
    return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[exponent - 1]}`;
  }

  setupBackBtn.addEventListener("click", () => {
    openedFromSettings = false;
    showMain();
  });

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("stage"));
  const ctx = canvas.getContext("2d");

  // Move canvas into #stage-area so CSS position:absolute;inset:0 fills it correctly
  (function repositionCanvas() {
    const sa = document.getElementById("stage-area");
    if (sa && canvas.parentElement !== sa) {
      sa.insertBefore(canvas, sa.firstChild);
    }
  })();

  // ── Theme character rendering ────────────────────────────────────────────
  // ATLAS_CLIPS mirrors src/extension/themePlan.ts exactly — keep in sync.
  const ATLAS_CLIPS = {
    walk:      { frames: [0, 1, 2, 3, 4],  fps: 10, loop: true,  flippable: true },
    idle:      { frames: [16],              fps: 0,  loop: true,  flippable: false, hold: true },
    sit:       { frames: [15],              fps: 0,  loop: true,  flippable: false, hold: true },
    melee:     { frames: [5, 6, 7, 8],     fps: 12, loop: false, flippable: true },
    build:     { frames: [5, 6, 7, 8],     fps: 6,  loop: true,  flippable: true },
    tool_idle: { frames: [9],              fps: 0,  loop: true,  flippable: true,  hold: true },
    shoot:     { frames: [10, 11],         fps: 8,  loop: false, flippable: true,  pingpong: true },
    dance:     { frames: [17, 18],         fps: 6,  loop: true,  flippable: false, pingpong: true },
    cheer:     { frames: [19],             fps: 0,  loop: true,  flippable: false, hold: true },
    point:     { frames: [12],             fps: 0,  loop: true,  flippable: true,  hold: true },
    signal:    { frames: [13],             fps: 0,  loop: true,  flippable: false, hold: true },
    dodge:     { frames: [14],             fps: 0,  loop: false, flippable: true,  hold: true },
  };

  /** Theme data set by THEME_INITIALIZED */
  let themeLoaded = false;
  /** @type {Record<string, string[]>} raw frames per character (slot → data-URI) */
  let themeFramesRaw = {};
  /** @type {Record<string, HTMLImageElement[]>} preloaded Image objects per character */
  let themeImages = {};
  /** @type {HTMLImageElement|null} background environment image */
  let themeBackgroundImg = null;
  /** @type {Record<string, {action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}>} */
  let workerAnimStates = {};

  // ── Facing direction tracking (Feature 1) ───────────────────────────────
  /** Previous canvas x position per worker id, for movement-based facing. */
  /** @type {Record<string, number>} */
  const workerPrevX = {};
  /** Per-worker facing flag: true = facing left (mirrored). Default false (right). */
  /** @type {Record<string, boolean>} */
  const workerFacingLeft = {};
  /** Deadzone in pixels — movements smaller than this are ignored to avoid flicker. */
  const FACING_EPS = 0.1;

  // ── Roster order (Feature 2) ─────────────────────────────────────────────
  /**
   * Ordered array of character IDs reflecting the current roster order.
   * Populated/restored when a theme is loaded.
   * @type {string[]}
   */
  let rosterOrder = [];
  /** Whether the roster strip is collapsed. */
  let rosterCollapsed = false;

  // ── Per-agent character map (Change 1: 1:1 agentMetrics visualization) ──
  /**
   * Webview-side character state keyed by agent.id.
   * Each entry tracks position, animation state, and facing direction
   * so agents without a live worker still animate independently.
   * @type {Record<string, {x: number, y: number, animState: {action:string,frameIndex:number,direction:number,elapsed:number,completed:boolean}, facingLeft: boolean, prevX: number}>}
   */
  let agentCharMap = {};

  /** Selected theme id, updated on SELECT_THEME post and THEME_INITIALIZED message. */
  let selectedThemeId = "";

  // ── Isometric floor / walkable polygon state ─────────────────────────────
  /** Default walkable nav polygon in native 533x751 coordinate space (trapezoid). */
  const DEFAULT_WALKABLE_POLY = [[267,4],[529,135],[529,611],[267,747],[4,612],[4,137]];
  /** Native canvas dimensions matching the walkable polygon coords. */
  const DEFAULT_NATIVE_W = 533;
  const DEFAULT_NATIVE_H = 751;
  /** Current walkable polygon (native coords). Reset on each THEME_INITIALIZED. */
  let walkablePolygon = DEFAULT_WALKABLE_POLY.map((p) => p.slice());
  let walkableNativeW = DEFAULT_NATIVE_W;
  let walkableNativeH = DEFAULT_NATIVE_H;

  // ── Per-theme stage tuning (read from manifest.viewport, persisted by host) ──
  /** Overall character sprite scale multiplier (1 = default 64px sprite). */
  let themeCharacterScale = 1;
  /** Overall build-prop/object scale multiplier. */
  let themeObjectScale = 1;
  /** Per-character scale overrides, keyed by character/frame id. */
  let themeCharScaleOverrides = {};
  /** Per-object scale overrides, keyed by buildable object id. */
  let themeObjScaleOverrides = {};
  /** Effective character scale for a given character/frame id. */
  function effectiveCharScale(charId) {
    const o = themeCharScaleOverrides[charId];
    return (typeof o === "number" && o > 0) ? o : themeCharacterScale;
  }

  // ── Stage editor (live polygon + scale tuning) ───────────────────────────
  /** True while the "Edit Stage" overlay is active. */
  let editStageMode = false;
  /** Index of the polygon vertex currently being dragged, or -1. */
  let dragVertexIndex = -1;
  /** Index of the polygon vertex under the cursor (for hover highlight), or -1. */
  let hoverVertexIndex = -1;
  /** Last drawn background rect (canvas px) — lets mouse handlers map canvas<->native. */
  let lastBgX = 0, lastBgY = 0, lastBgW = 1, lastBgH = 1;
  /** Character id selected in the per-character override control. */
  let editSelectedCharId = "";

  // ── Stage loading progress (a bar replaces placeholders while loading) ────
  const LOADING_TIMEOUT_MS = 6000;
  /** performance.now() when we began waiting for the stage to load. */
  let themeLoadStartTs = 0;
  function nowMs() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  /** Progress over the theme background + character frames: { ready, frac }. */
  function themeLoadProgress() {
    if (!themeLoaded) return { ready: false, frac: 0 };
    let total = 0, done = 0;
    const bgOk = !themeBackgroundImg || (themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0);
    if (themeBackgroundImg) { total++; if (themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0) done++; }
    for (const id in themeImages) {
      const arr = themeImages[id];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const im = arr[i];
        if (!im) continue;
        total++;
        if (im.complete && im.naturalWidth > 0) done++;
      }
    }
    const frac = total > 0 ? done / total : 0;
    return { ready: total > 0 && bgOk && frac >= 0.95, frac };
  }

  /** Convert a mouse event to canvas-pixel coords (accounts for CSS scaling). */
  function canvasMouse(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width > 0 ? canvas.width / rect.width : 1;
    const sy = rect.height > 0 ? canvas.height / rect.height : 1;
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
  }
  /** Inverse of nativeToCanvas using the last drawn background rect. */
  function canvasToNative(mx, my) {
    return [
      (mx - lastBgX) * (walkableNativeW / lastBgW),
      (my - lastBgY) * (walkableNativeH / lastBgH),
    ];
  }
  /** Index of the polygon vertex within rPx canvas px of (mx,my), else -1. */
  function vertexAt(mx, my, rPx) {
    for (let i = 0; i < walkablePolygon.length; i++) {
      const [vx, vy] = nativeToCanvas(walkablePolygon[i][0], walkablePolygon[i][1], lastBgX, lastBgY, lastBgW, lastBgH);
      const dx = vx - mx, dy = vy - my;
      if (dx * dx + dy * dy <= rPx * rPx) return i;
    }
    return -1;
  }
  /** Index of the edge whose midpoint is within rPx of (mx,my), else -1. */
  function edgeMidAt(mx, my, rPx) {
    for (let i = 0; i < walkablePolygon.length; i++) {
      const a = walkablePolygon[i];
      const b = walkablePolygon[(i + 1) % walkablePolygon.length];
      const [cxm, cym] = nativeToCanvas((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, lastBgX, lastBgY, lastBgW, lastBgH);
      const dx = cxm - mx, dy = cym - my;
      if (dx * dx + dy * dy <= rPx * rPx) return i;
    }
    return -1;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!editStageMode) return;
    const [mx, my] = canvasMouse(e);
    const vi = vertexAt(mx, my, 11);
    if (vi >= 0) { dragVertexIndex = vi; e.preventDefault(); }
  });
  canvas.addEventListener("mousemove", (e) => {
    if (!editStageMode) return;
    const [mx, my] = canvasMouse(e);
    if (dragVertexIndex >= 0) {
      const [nx, ny] = canvasToNative(mx, my);
      walkablePolygon[dragVertexIndex] = [
        Math.max(0, Math.min(walkableNativeW, nx)),
        Math.max(0, Math.min(walkableNativeH, ny)),
      ];
    } else {
      hoverVertexIndex = vertexAt(mx, my, 11);
      canvas.style.cursor = hoverVertexIndex >= 0 ? "grab" : "default";
    }
  });
  window.addEventListener("mouseup", () => {
    if (dragVertexIndex >= 0) dragVertexIndex = -1;
  });
  canvas.addEventListener("dblclick", (e) => {
    if (!editStageMode) return;
    const [mx, my] = canvasMouse(e);
    const ei = edgeMidAt(mx, my, 14);
    if (ei >= 0) {
      const a = walkablePolygon[ei];
      const b = walkablePolygon[(ei + 1) % walkablePolygon.length];
      walkablePolygon.splice(ei + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      e.preventDefault();
    }
  });
  canvas.addEventListener("contextmenu", (e) => {
    if (!editStageMode) return;
    e.preventDefault();
    const [mx, my] = canvasMouse(e);
    const vi = vertexAt(mx, my, 11);
    if (vi >= 0 && walkablePolygon.length > 3) {
      walkablePolygon.splice(vi, 1);
      hoverVertexIndex = -1;
    }
  });

  // ── Stage editor control panel (built lazily, toggled with edit mode) ─────
  let stageEditPanel = null;
  const stageEditEls = {};
  function buildStageEditPanel() {
    if (stageEditPanel) return;
    const stageAreaEl = document.getElementById("stage-area") || document.body;
    const wrap = document.createElement("div");
    wrap.id = "stage-edit-panel";
    wrap.setAttribute("hidden", "");
    wrap.style.cssText = "position:absolute;top:8px;left:8px;z-index:30;width:228px;padding:10px 12px;border-radius:8px;background:rgba(18,20,28,0.94);border:1px solid #ffc107;color:#eaeaea;font-family:monospace;font-size:11px;line-height:1.5;box-shadow:0 6px 18px rgba(0,0,0,0.55);";
    wrap.innerHTML =
      '<div id="se-h">⚙ Edit Stage</div>' +
      '<div>Character scale: <span id="se-cs-val">1.00</span></div>' +
      '<input id="se-cs" type="range" min="0.3" max="2" step="0.05" value="1">' +
      '<div style="margin-top:6px">Per-character override</div>' +
      '<select id="se-char"></select>' +
      '<input id="se-co" type="range" min="0.3" max="2" step="0.05" value="1">' +
      '<button id="se-co-clear" type="button">clear override</button>' +
      '<div style="margin-top:6px">Object scale: <span id="se-os-val">1.00</span></div>' +
      '<input id="se-os" type="range" min="0.3" max="2" step="0.05" value="1">' +
      '<button id="se-bg" type="button">Replace background…</button>' +
      '<div id="se-hint">Drag points · dbl-click edge to add · right-click to remove</div>' +
      '<div id="se-btns"><button id="se-save" type="button">Save</button><button id="se-done" type="button">Done</button></div>' +
      '<div id="se-status"></div>';
    stageAreaEl.appendChild(wrap);
    stageEditPanel = wrap;
    stageEditEls.cs = wrap.querySelector("#se-cs");
    stageEditEls.csVal = wrap.querySelector("#se-cs-val");
    stageEditEls.char = wrap.querySelector("#se-char");
    stageEditEls.co = wrap.querySelector("#se-co");
    stageEditEls.coClear = wrap.querySelector("#se-co-clear");
    stageEditEls.os = wrap.querySelector("#se-os");
    stageEditEls.osVal = wrap.querySelector("#se-os-val");
    stageEditEls.save = wrap.querySelector("#se-save");
    stageEditEls.done = wrap.querySelector("#se-done");
    stageEditEls.status = wrap.querySelector("#se-status");
    stageEditEls.bg = wrap.querySelector("#se-bg");
    // Cosmetic styling via CSSOM (CSP-safe).
    wrap.querySelector("#se-h").style.cssText = "font-weight:bold;color:#ffc107;margin-bottom:6px;";
    for (const el of [stageEditEls.cs, stageEditEls.co, stageEditEls.os, stageEditEls.char]) el.style.width = "100%";
    stageEditEls.bg.style.cssText = "width:100%;margin-top:8px;";
    wrap.querySelector("#se-hint").style.cssText = "opacity:0.7;margin:8px 0;";
    wrap.querySelector("#se-btns").style.cssText = "display:flex;gap:6px;margin-top:4px;";
    stageEditEls.save.style.flex = "1";
    stageEditEls.done.style.flex = "1";
    stageEditEls.coClear.style.cssText = "margin-top:3px;font-size:10px;";
    stageEditEls.status.style.cssText = "margin-top:6px;min-height:14px;color:#9fffa0;";

    // Wire controls.
    stageEditEls.cs.addEventListener("input", () => {
      themeCharacterScale = parseFloat(stageEditEls.cs.value) || 1;
      stageEditEls.csVal.textContent = themeCharacterScale.toFixed(2);
    });
    stageEditEls.os.addEventListener("input", () => {
      themeObjectScale = parseFloat(stageEditEls.os.value) || 1;
      stageEditEls.osVal.textContent = themeObjectScale.toFixed(2);
    });
    stageEditEls.char.addEventListener("change", () => {
      editSelectedCharId = stageEditEls.char.value;
      syncOverrideSlider();
    });
    stageEditEls.co.addEventListener("input", () => {
      if (!editSelectedCharId) return;
      themeCharScaleOverrides[editSelectedCharId] = parseFloat(stageEditEls.co.value) || 1;
    });
    stageEditEls.coClear.addEventListener("click", () => {
      if (editSelectedCharId) delete themeCharScaleOverrides[editSelectedCharId];
      syncOverrideSlider();
    });
    stageEditEls.save.addEventListener("click", saveStageTuning);
    stageEditEls.done.addEventListener("click", exitEditStage);
    stageEditEls.bg.addEventListener("click", () => {
      if (!selectedThemeId) {
        stageEditEls.status.textContent = "No theme selected.";
        return;
      }
      stageEditEls.status.style.color = "#9fffa0";
      stageEditEls.status.textContent = "Opening image picker…";
      vscode.postMessage({ type: "REPLACE_BACKGROUND", payload: { theme_id: selectedThemeId } });
    });
  }
  function syncOverrideSlider() {
    const ov = themeCharScaleOverrides[editSelectedCharId];
    stageEditEls.co.value = String(typeof ov === "number" && ov > 0 ? ov : themeCharacterScale);
  }
  function enterEditStage() {
    if (!themeLoaded) return;
    buildStageEditPanel();
    editStageMode = true;
    const ids = rosterOrder.length ? rosterOrder : Object.keys(themeImages).filter((id) => id !== "environment_background");
    stageEditEls.char.innerHTML = "";
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      stageEditEls.char.appendChild(opt);
    }
    editSelectedCharId = ids[0] || "";
    stageEditEls.cs.value = String(themeCharacterScale);
    stageEditEls.csVal.textContent = themeCharacterScale.toFixed(2);
    stageEditEls.os.value = String(themeObjectScale);
    stageEditEls.osVal.textContent = themeObjectScale.toFixed(2);
    syncOverrideSlider();
    stageEditEls.status.textContent = "";
    stageEditPanel.removeAttribute("hidden");
  }
  function exitEditStage() {
    editStageMode = false;
    dragVertexIndex = -1;
    hoverVertexIndex = -1;
    canvas.style.cursor = "default";
    if (stageEditPanel) stageEditPanel.setAttribute("hidden", "");
  }
  function saveStageTuning() {
    if (!selectedThemeId) {
      if (stageEditEls.status) stageEditEls.status.textContent = "No theme selected.";
      return;
    }
    const normPoly = walkablePolygon.map((p) => [
      +(p[0] / walkableNativeW).toFixed(5),
      +(p[1] / walkableNativeH).toFixed(5),
    ]);
    vscode.postMessage({
      type: "SAVE_STAGE_TUNING",
      payload: {
        theme_id: selectedThemeId,
        walkable_nav_polygon: normPoly,
        character_scale: themeCharacterScale,
        object_scale: themeObjectScale,
        character_scale_overrides: themeCharScaleOverrides,
        object_scale_overrides: themeObjScaleOverrides,
      },
    });
    if (stageEditEls.status) stageEditEls.status.textContent = "Saving…";
  }

  // Inject an "Edit Stage" item into the hamburger menu.
  (function injectEditStageMenuItem() {
    if (typeof menuPopoverEl === "undefined" || !menuPopoverEl) return;
    const btn = document.createElement("button");
    btn.className = "menu-item";
    btn.id = "menu-edit-stage";
    btn.type = "button";
    btn.textContent = "Edit Stage";
    const about = document.getElementById("menu-about");
    if (about && about.parentElement === menuPopoverEl) menuPopoverEl.insertBefore(btn, about);
    else menuPopoverEl.appendChild(btn);
    btn.addEventListener("click", () => {
      if (typeof closeMenu === "function") closeMenu();
      enterEditStage();
    });
  })();

  // Escape exits the stage editor.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editStageMode) exitEditStage();
  });

  /**
   * Ray-cast point-in-polygon test (native coord space).
   * @param {number} x @param {number} y @param {number[][]} poly
   * @returns {boolean}
   */
  function isPointInPolygon(x, y, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * If (x,y) is outside poly, pull it toward the centroid until inside.
   * Works in native polygon coordinate space.
   * @param {number} x @param {number} y @param {number[][]} poly
   * @returns {number[]} [cx, cy] guaranteed inside poly
   */
  function clampToPolygon(x, y, poly) {
    if (isPointInPolygon(x, y, poly)) return [x, y];
    // Compute centroid
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p[0]; cy += p[1]; }
    cx /= poly.length; cy /= poly.length;
    // Step from (x,y) toward centroid in increments
    const steps = 40;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const tx = x + (cx - x) * t;
      const ty = y + (cy - y) * t;
      if (isPointInPolygon(tx, ty, poly)) return [tx, ty];
    }
    return [cx, cy];
  }

  /**
   * Map a native-coord point to canvas pixel coords.
   * @param {number} nx @param {number} ny
   * @param {number} bgX @param {number} bgY @param {number} bgW @param {number} bgH
   * @returns {number[]} [canvasX, canvasY]
   */
  function nativeToCanvas(nx, ny, bgX, bgY, bgW, bgH) {
    return [
      bgX + nx * (bgW / walkableNativeW),
      bgY + ny * (bgH / walkableNativeH),
    ];
  }

  /**
   * Pick a random point inside the walkable polygon (rejection sample).
   * @param {number[][]} poly
   * @returns {number[]} [x, y] in native coords
   */
  function randomInsidePoly(poly) {
    // Compute bbox
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    for (let attempts = 0; attempts < 60; attempts++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);
      if (isPointInPolygon(x, y, poly)) return [x, y];
    }
    // Fallback: centroid
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p[0]; cy += p[1]; }
    return [cx / poly.length, cy / poly.length];
  }

  /**
   * 12 preset home slots spread across the floor polygon bounding box
   * in a 3-row diagonal grid layout (like OfficeAgents).
   * Returned as [u,v] fractions (0..1) within the polygon bbox.
   * @type {number[][]}
   */
  const ISO_SLOT_UVS = [
    // Row 0 (back)
    [0.25, 0.15], [0.50, 0.15], [0.75, 0.15],
    // Row 1 (mid)
    [0.15, 0.45], [0.40, 0.45], [0.60, 0.45], [0.85, 0.45],
    // Row 2 (front)
    [0.25, 0.72], [0.50, 0.72], [0.75, 0.72],
    // Extra front
    [0.38, 0.88], [0.62, 0.88],
  ];

  /**
   * Compute a stable native home position for slot index i.
   * Maps ISO_SLOT_UVS fraction into polygon bbox then clamps inside polygon.
   * @param {number} i
   * @param {number[][]} poly
   * @returns {number[]} [nx, ny]
   */
  function isoSlotHome(i, poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const uv = ISO_SLOT_UVS[i % ISO_SLOT_UVS.length];
    const nx = minX + uv[0] * (maxX - minX);
    const ny = minY + uv[1] * (maxY - minY);
    return clampToPolygon(nx, ny, poly);
  }

  /** Wander speed in native px / second. */
  const WANDER_SPEED = 45;
  /** How long (seconds) an agent waits before picking a new wander destination. */
  const WANDER_INTERVAL_MIN = 3;
  const WANDER_INTERVAL_MAX = 8;
  /** Radius (native px) around home for wander destination jitter (active agents). */
  const WANDER_RADIUS = 80;
  /** How close (native px) to destination before agent is considered arrived. */
  const WANDER_ARRIVED_EPS = 3;

  /**
   * Create a fresh animation state object.
   * @param {string} action
   */
  function createAnimState(action) {
    return { action, frameIndex: 0, direction: 1, elapsed: 0, completed: false };
  }

  /**
   * Advance an animation state by deltaSeconds; mirrors animationPlayback.ts logic.
   * @param {{action:string, frameIndex:number, direction:number, elapsed:number, completed:boolean}} s
   * @param {number} delta
   */
  function advanceAnim(s, delta) {
    const clip = ATLAS_CLIPS[s.action] || ATLAS_CLIPS.idle;
    if (clip.hold || clip.frames.length <= 1 || clip.fps <= 0) {
      s.frameIndex = 0;
      return;
    }
    if (s.completed || !Number.isFinite(delta) || delta <= 0) return;
    s.elapsed += delta;
    const dur = 1 / clip.fps;
    while (s.elapsed >= dur && !s.completed) {
      s.elapsed -= dur;
      const n = clip.frames.length;
      if (clip.pingpong) {
        s.frameIndex += s.direction;
        if (s.frameIndex >= n - 1) {
          s.frameIndex = n - 1;
          if (clip.loop) s.direction = -1; else s.completed = true;
        } else if (s.frameIndex <= 0) {
          s.frameIndex = 0;
          s.direction = 1;
        }
      } else {
        s.frameIndex += 1;
        if (s.frameIndex >= n) {
          if (clip.loop) s.frameIndex = 0;
          else { s.frameIndex = n - 1; s.completed = true; }
        }
      }
    }
  }

  /**
   * Return the atlas slot index for the current frame of an animation state.
   * @param {{action:string, frameIndex:number}} s
   */
  function currentSlot(s) {
    const clip = ATLAS_CLIPS[s.action] || ATLAS_CLIPS.idle;
    return clip.frames[Math.min(s.frameIndex, clip.frames.length - 1)];
  }

  /**
   * Map a worker state string to an ATLAS_CLIPS action name.
   * @param {string} workerState
   */
  function workerStateToClip(workerState) {
    switch (workerState) {
      case "walk":
      case "arrive":   return "walk";
      case "build":
      case "haul":     return "build";
      case "survey":   return "tool_idle";
      case "celebrate":return "cheer";
      case "leave":    return "walk";
      default:         return "idle";
    }
  }

  /**
   * Preload all character sprite images from raw frames data.
   * @param {Record<string, string[]>} rawFrames
   */
  function preloadThemeImages(rawFrames) {
    themeImages = {};
    themeBackgroundImg = null;
    const bgFrames = rawFrames["environment_background"];
    if (bgFrames && bgFrames[0]) {
      const bgImg = new Image();
      bgImg.src = bgFrames[0];
      themeBackgroundImg = bgImg;
    }
    for (const [charId, slots] of Object.entries(rawFrames)) {
      if (charId === "environment_background") continue;
      themeImages[charId] = slots.map((src) => {
        const img = new Image();
        img.src = src;
        return img;
      });
    }
  }

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
  let lastFrameTime = 0;

  function resize() {
    // Keep the canvas backing-store resolution in lockstep with its CSS
    // display size. If they drift, the browser stretches the rendered bitmap
    // (distorting the fixed-size background) and the layout math (bgX/bgY,
    // nativeToCanvas, nav-poly) computes against the wrong w/h.
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw <= 0 || ch <= 0) return; // not laid out yet; skip until it is
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
  }

  window.addEventListener("resize", resize);
  // The metrics handlebar resizes the #stage container WITHOUT firing a window
  // 'resize' event, so observe the canvas element directly to catch those drags
  // (and the initial layout settling) and re-sync the backing store.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
  }
  resize();

  // Tell the extension we're ready; it will push the current state back
  themeLoadStartTs = nowMs(); // begin the stage-loading window
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

  // Ask the host for current engine connection status immediately.
  vscode.postMessage({ type: "getEngineStatus" });

  // ── Engine connection chips (upper-left overlay) ─────────────────

  const engineChipsEl = document.createElement("div");
  engineChipsEl.id = "engine-chips";
  engineChipsEl.setAttribute("hidden", "");
  // Append into #stage-area so it shares the same positioning context.
  const stageAreaEl = document.getElementById("stage-area");
  if (stageAreaEl) {
    stageAreaEl.appendChild(engineChipsEl);
  }

  /**
   * Rebuild the engine chip row from a chips array.
   * @param {Array<{id:string, label:string, state:"connected"|"offline", detail:string}>} chips
   */
  function renderEngineChips(chips) {
    // Remove all existing chips
    while (engineChipsEl.firstChild) {
      engineChipsEl.removeChild(engineChipsEl.firstChild);
    }

    if (!chips || chips.length === 0) {
      engineChipsEl.setAttribute("hidden", "");
      return;
    }

    engineChipsEl.removeAttribute("hidden");

    for (const chip of chips) {
      const pill = document.createElement("div");
      pill.className = "engine-chip";
      if (chip.detail) {
        pill.title = chip.detail;
      }

      const dot = document.createElement("span");
      // Green for a live/ready engine (UEFN connected, or another engine whose
      // pack is installed); amber for offline/needs-setup.
      var dotGreen = chip.state === "connected" || chip.state === "ready";
      dot.className = dotGreen
        ? "engine-chip-dot engine-chip-dot--connected"
        : "engine-chip-dot engine-chip-dot--offline";

      const label = document.createElement("span");
      label.className = "engine-chip-label";
      label.textContent = chip.label;

      pill.appendChild(dot);
      pill.appendChild(label);
      engineChipsEl.appendChild(pill);
    }
  }

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
    if (msg && msg.type === "THEME_IMAGE_SETTINGS") {
      const payload = msg.payload || {};
      if (payload.error) {
        if (themeApiKeySave) {
          themeApiKeySave.removeAttribute("disabled");
          themeApiKeySave.textContent = "Save";
        }
        updateThemeApiKeyUi("Could not save the API key: " + payload.error, true);
      } else {
        themeImageSettingsLoaded = true;
        themeProviderConfigured = {
          gemini: Boolean(payload.providers?.gemini?.configured),
          openai: Boolean(payload.providers?.openai?.configured),
        };
        if (themeImageProvider && (payload.provider === "gemini" || payload.provider === "openai")) {
          themeImageProvider.value = payload.provider;
        }
        if (themeApiKeyInput) themeApiKeyInput.value = "";
        if (themeApiKeySave) {
          themeApiKeySave.removeAttribute("disabled");
          themeApiKeySave.textContent = "Save";
        }
        updateThemeApiKeyUi(payload.saved ? "API key settings saved securely." : "", false);
      }
    } else if (msg && msg.type === "THEMES_LIST") {
      lastThemesList = msg.payload?.themes || msg.themes || [];
      renderThemesList(lastThemesList);
      if (themePickerStatus) {
        const deleteError = msg.payload?.delete_error;
        themePickerStatus.textContent = deleteError
          ? "Could not delete theme: " + deleteError
          : msg.payload?.deleted_theme_id
            ? "Theme deleted."
            : "";
        themePickerStatus.classList.toggle("theme-picker-status--error", Boolean(deleteError));
      }
    } else if (msg && msg.type === "THEME_EXPORT_RESULT") {
      const payload = msg.payload || {};
      const exportButton = themePickerGrid?.querySelector(`[data-theme-export-id="${payload.theme_id || ""}"]`);
      if (exportButton) exportButton.disabled = exportButton.dataset.exportReady !== "true";
      if (themePickerStatus) {
        themePickerStatus.textContent = payload.error
          ? "Could not export theme: " + payload.error
          : payload.cancelled
            ? ""
            : `${payload.display_name || "Theme"} exported.`;
        themePickerStatus.classList.toggle("theme-picker-status--error", Boolean(payload.error));
      }
    } else if (msg && msg.type === "THEME_IMPORT_RESULT") {
      const payload = msg.payload || {};
      if (themeImportBtn) themeImportBtn.disabled = false;
      if (themePickerStatus) {
        themePickerStatus.textContent = payload.error
          ? "Could not import theme: " + payload.error
          : payload.cancelled
            ? ""
            : `${payload.display_name || "Theme"} ${payload.replaced ? "replaced" : "imported"}.`;
        themePickerStatus.classList.toggle("theme-picker-status--error", Boolean(payload.error));
      }
    } else if (msg && msg.type === "THEME_APPROVE_ALL_RESULT") {
      const payload = msg.payload || {};
      if (themeApproveAll) {
        themeApproveAll.disabled = false;
        themeApproveAll.textContent = "Approve all";
      }
      if (themeImageReviewSummary && payload.error) {
        themeImageReviewSummary.textContent = "Could not approve all: " + payload.error;
        themeImageReviewSummary.classList.add("theme-review-error");
      }
    } else if (msg && msg.type === "THEME_PLAN_READY") {
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      renderThemePlan(msg.payload?.plan || {});
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Review and edit the AI-filled slots, then generate the images.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
    } else if (msg && msg.type === "THEME_PLAN_ERROR") {
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Error: " + (msg.payload?.message || "Theme planning failed.");
        themeBuildStatus.style.color = "var(--vscode-errorForeground)";
      }
    } else if (msg && msg.type === "THEME_GENERATION_PROGRESS") {
      if (themeBuildStatus) {
        themeBuildStatus.textContent = msg.payload?.message || msg.message || "Working...";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
    } else if (msg && msg.type === "THEME_REVIEW_READY") {
      const readyThemeId = msg.payload?.theme_id;
      if (readyThemeId) {
        reviewThemeId = readyThemeId;
        if (themeBuildActions) themeBuildActions.removeAttribute("hidden");
        showThemeImageReview(readyThemeId);
      }
    } else if (msg && msg.type === "THEME_IMAGE_REVIEW") {
      if (msg.payload?.theme_id) reviewThemeId = msg.payload.theme_id;
      renderThemeImageReview(msg.payload || {});
    } else if (msg && (msg.type === "THEME_IMAGE_RETRY_STATE"
        || msg.type === "THEME_CHARACTER_RENAME_STATE"
        || msg.type === "THEME_CHARACTER_NORMALIZE_STATE")) {
      const itemId = msg.payload?.item_id;
      if (itemId) {
        if (msg.payload?.busy) {
          themeReviewBusyItems.set(itemId, msg.type === "THEME_IMAGE_RETRY_STATE"
            ? "retry"
            : msg.type === "THEME_CHARACTER_RENAME_STATE"
              ? "rename"
              : "normalize");
        } else {
          themeReviewBusyItems.delete(itemId);
        }
      }
      const cards = themeImageReviewList ? themeImageReviewList.querySelectorAll("[data-item-id]") : [];
      for (const card of cards) {
        if (card.getAttribute("data-item-id") !== itemId) continue;
        const retryBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-retry"));
        const renameBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-rename"));
        const normalizeBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-normalize"));
        const nameInput = /** @type {HTMLInputElement|null} */ (card.querySelector(".theme-review-name-input"));
        const acceptBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-accept"));
        const rejectBtn = /** @type {HTMLButtonElement|null} */ (card.querySelector(".theme-review-reject"));
        const statusEl = /** @type {HTMLElement|null} */ (card.querySelector(".theme-review-retry-status"));
        if (acceptBtn) acceptBtn.disabled = Boolean(msg.payload?.busy);
        if (rejectBtn) rejectBtn.disabled = Boolean(msg.payload?.busy);
        if (retryBtn && msg.type === "THEME_IMAGE_RETRY_STATE") {
          retryBtn.disabled = Boolean(msg.payload?.busy);
          retryBtn.textContent = msg.payload?.busy
            ? "Generating..."
            : retryBtn.dataset.idleText || "Retry image";
        }
        if (normalizeBtn && msg.type === "THEME_CHARACTER_NORMALIZE_STATE") {
          normalizeBtn.disabled = Boolean(msg.payload?.busy);
          normalizeBtn.textContent = msg.payload?.busy
            ? "Regenerating..."
            : normalizeBtn.dataset.idleText || "Normalize size";
        }
        if (renameBtn && msg.type === "THEME_CHARACTER_RENAME_STATE") {
          renameBtn.disabled = Boolean(msg.payload?.busy) || !msg.payload?.error;
          renameBtn.textContent = msg.payload?.busy ? "Saving..." : "Save name";
        }
        if (nameInput && msg.type === "THEME_CHARACTER_RENAME_STATE") {
          nameInput.disabled = Boolean(msg.payload?.busy);
        }
        if (statusEl) {
          statusEl.textContent = msg.payload?.error || msg.payload?.message || "";
          statusEl.classList.toggle("theme-review-error", Boolean(msg.payload?.error));
        }
      }
    } else if (msg && msg.type === "THEME_GENERATION_ERROR") {
      themeGenerationRunning = false;
      themeGenerationStopping = false;
      if (themeBuildStatus) {
        themeBuildStatus.textContent = "Error: " + (msg.payload?.message || msg.message || "Unknown error");
        themeBuildStatus.style.color = "var(--vscode-errorForeground)";
      }
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeStartGenerationBtn) {
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Generate images";
      }
      if (themeReviewStopGeneration) themeReviewStopGeneration.hidden = true;
    } else if (msg && msg.type === "THEME_GENERATION_CANCELLED") {
      themeGenerationRunning = false;
      themeGenerationStopping = false;
      const cancelledThemeId = msg.payload?.theme_id;
      if (cancelledThemeId) {
        reviewThemeId = cancelledThemeId;
        if (themeBuildActions) themeBuildActions.removeAttribute("hidden");
      }
      if (themeBuildStatus) {
        themeBuildStatus.textContent = msg.payload?.message || "Generation stopped.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeStartGenerationBtn) {
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Generate images";
      }
      if (themeReviewStopGeneration) themeReviewStopGeneration.hidden = true;
    } else if (msg && msg.type === "THEME_INITIALIZED") {
      const completedGeneration = themeGenerationRunning;
      themeGenerationRunning = false;
      themeGenerationStopping = false;
      if (themeStartGenerationBtn) {
        themeStartGenerationBtn.disabled = false;
        themeStartGenerationBtn.textContent = "Generate images";
      }
      if (themeGenerateBtn) {
        themeGenerateBtn.removeAttribute("disabled");
        themeGenerateBtn.textContent = "Plan theme";
      }
      if (themeReviewStopGeneration) themeReviewStopGeneration.hidden = true;
      if (completedGeneration && themeBuildStatus && themeBuildStatus.textContent.indexOf("Error") !== 0) {
        themeBuildStatus.textContent = "Theme generated successfully.";
        themeBuildStatus.style.color = "var(--vscode-descriptionForeground)";
      }
      const initializedThemeId = msg.payload?.manifest?.theme_id;
      if (initializedThemeId) {
        reviewThemeId = initializedThemeId;
        // Track which theme is currently loaded on stage (auto-loaded = selected)
        selectedThemeId = initializedThemeId;
        if (themeBuildActions) themeBuildActions.removeAttribute("hidden");
      }
      // Load theme character sprites for the stage canvas
      if (msg.payload?.frames && typeof msg.payload.frames === "object") {
        themeFramesRaw = msg.payload.frames;
        themeLoadStartTs = nowMs(); // restart the loading window for this theme's frames
        preloadThemeImages(themeFramesRaw);
        themeLoaded = true;
        // Reset per-worker animation/facing states so they start fresh
        workerAnimStates = {};
        agentCharMap = {};
        // Capture walkable floor polygon from manifest (native coord space)
        const vp = msg.payload?.manifest?.viewport;
        const rawPoly = vp && Array.isArray(vp.walkable_nav_polygon) && vp.walkable_nav_polygon.length >= 3
          ? vp.walkable_nav_polygon
          : null;
        if (rawPoly) {
          // The generator stores walkable_nav_polygon as NORMALIZED 0..1
          // fractions of the background, while native_width/height describe the
          // source image (e.g. 1280x720). If we scaled normalized coords by
          // native_width they'd collapse to a ~1px cluster at the image origin
          // (every agent + the nav overlay stacked in the top-left corner).
          // Detect that case and convert the polygon into the SAME canonical
          // native pixel space (533x751) used by the default polygon and the
          // pixel-tuned wander constants, so mapping AND movement both work.
          const cleaned = rawPoly
            .filter((p) => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]))
            .map((p) => [p[0], p[1]]);
          if (cleaned.length < 3) {
            // Degenerate after cleaning — fall back to the default floor.
            walkablePolygon = DEFAULT_WALKABLE_POLY.map((p) => p.slice());
            walkableNativeW = DEFAULT_NATIVE_W;
            walkableNativeH = DEFAULT_NATIVE_H;
          } else {
            const isNormalized = cleaned.every(
              (p) => Math.abs(p[0]) <= 1.5 && Math.abs(p[1]) <= 1.5
            );
            if (isNormalized) {
              walkablePolygon = cleaned.map((p) => [p[0] * DEFAULT_NATIVE_W, p[1] * DEFAULT_NATIVE_H]);
              walkableNativeW = DEFAULT_NATIVE_W;
              walkableNativeH = DEFAULT_NATIVE_H;
            } else {
              walkablePolygon = cleaned;
              walkableNativeW = (vp.native_width && vp.native_width > 0) ? vp.native_width : DEFAULT_NATIVE_W;
              walkableNativeH = (vp.native_height && vp.native_height > 0) ? vp.native_height : DEFAULT_NATIVE_H;
            }
          }
        } else {
          walkablePolygon = DEFAULT_WALKABLE_POLY.map((p) => p.slice());
          walkableNativeW = DEFAULT_NATIVE_W;
          walkableNativeH = DEFAULT_NATIVE_H;
        }
        // Per-theme scale tuning (optional manifest fields; default 1 / empty).
        themeCharacterScale = (vp && typeof vp.character_scale === "number" && vp.character_scale > 0) ? vp.character_scale : 1;
        themeObjectScale = (vp && typeof vp.object_scale === "number" && vp.object_scale > 0) ? vp.object_scale : 1;
        themeCharScaleOverrides = (vp && vp.character_scale_overrides && typeof vp.character_scale_overrides === "object") ? vp.character_scale_overrides : {};
        themeObjScaleOverrides = (vp && vp.object_scale_overrides && typeof vp.object_scale_overrides === "object") ? vp.object_scale_overrides : {};
        // Build rosterOrder from manifest character order (excluding background)
        const manifestChars = Object.keys(themeFramesRaw).filter(
          (id) => id !== "environment_background"
        );
        // Restore saved order if present and covers same characters
        const saved = vscode.getState() || {};
        const savedOrder = Array.isArray(saved.rosterOrder) ? saved.rosterOrder : [];
        const savedValid =
          savedOrder.length === manifestChars.length &&
          savedOrder.every((id) => manifestChars.includes(id));
        rosterOrder = savedValid ? savedOrder : manifestChars.slice();
        if (typeof saved.rosterCollapsed === "boolean") {
          rosterCollapsed = saved.rosterCollapsed;
        }
        buildRosterStrip();
      }
    } else if (msg && msg.type === "STAGE_TUNING_SAVED") {
      if (stageEditEls && stageEditEls.status) {
        const ok = msg.payload && msg.payload.ok;
        stageEditEls.status.textContent = ok ? "Saved to theme ✓" : "Save failed";
        stageEditEls.status.style.color = ok ? "#9fffa0" : "#ff9f9f";
      }
    } else if (msg && msg.type === "BACKGROUND_REPLACE_RESULT") {
      const ok = msg.payload && msg.payload.ok;
      const cancelled = msg.payload && msg.payload.cancelled;
      if (stageEditEls && stageEditEls.status) {
        stageEditEls.status.textContent = cancelled ? "" : (ok ? "Background replaced ✓" : "Replace failed");
        stageEditEls.status.style.color = ok ? "#9fffa0" : "#ff9f9f";
      }
      // Reset a pending review-card Upload button. On success the host re-posts
      // THEME_IMAGE_REVIEW which rebuilds the card, so only the cancel/failure
      // path needs an explicit reset of the (still-attached) button.
      if (pendingUploadBtn) {
        if (!ok) {
          pendingUploadBtn.disabled = false;
          pendingUploadBtn.textContent = "Upload";
        }
        pendingUploadBtn = null;
      }
    } else if (msg && msg.type === "state") {
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
    } else if (msg && msg.type === "engineStatus") {
      renderEngineChips(Array.isArray(msg.chips) ? msg.chips : []);
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
    } else if (msg && msg.type === "designDocDone") {
      /* handled by host info message */
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
    const hookHealth = (lastSettings.hookHealth) || { healthy: true, issueCount: 0 };
    const healthLine = document.createElement("div");
    healthLine.className = hookHealth.healthy ? "hook-ok" : "hook-warn";
    healthLine.textContent = hookHealth.healthy
      ? "✓ Hooks healthy — no issues detected"
      : `⚠ ${hookHealth.issueCount} issue(s) detected`;
    hookStatus.appendChild(healthLine);
    const troubleshootBtn = document.createElement("button");
    troubleshootBtn.className = "skill-btn settings-btn";
    troubleshootBtn.textContent = "Troubleshoot & Fix";
    troubleshootBtn.addEventListener("click", () => {
      troubleshootBtn.disabled = true;
      troubleshootBtn.textContent = "Checking…";
      vscode.postMessage({ type: "runDoctor" });
    });
    if (hookHealth.healthy) {
      troubleshootBtn.disabled = true;
      troubleshootBtn.classList.add("btn-disabled");
    }
    hookRow.appendChild(hookStatus);
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
  const directSearches = (typeof dh.directSearches === "number") ? dh.directSearches : 0;
  const directReads    = (typeof dh.directReads    === "number") ? dh.directReads    : 0;
  const directEdits    = (typeof dh.directEdits    === "number") ? dh.directEdits    : 0;
  const delegations    = (typeof dh.delegations    === "number") ? dh.delegations    : 0;
  const warnThreshold  = (typeof dh.warnThreshold  === "number") ? dh.warnThreshold  : 5;
  // Reads are allowed for known files (per CLAUDE.md) — they are NOT a leak, so
  // they are excluded from the ratio. Only direct Grep/Glob and edits count.
  const dhLeak = directSearches + directEdits;
  const dhTotal = delegations + dhLeak;
  if (dhTotal === 0) {
    const emptyP = document.createElement("p");
    emptyP.className = "settings-empty";
    emptyP.textContent = "No delegatable activity yet this session.";
    dhSection.appendChild(emptyP);
  } else {
    const ratio = delegations / dhTotal;
    // Green / yellow / red traffic light, consistent with the rest of the UI.
    const light = ratio >= 0.6
      ? { color: "var(--status-active)", label: "Delegating well", glow: true }
      : ratio >= 0.35
        ? { color: "var(--status-done)", label: "Some direct work", glow: false }
        : { color: "var(--status-error)", label: "Low delegation", glow: false };
    const badge = document.createElement("div");
    badge.className = "settings-row";
    badge.style.flexDirection = "row";
    badge.style.alignItems = "center";
    badge.style.gap = "6px";
    const dot = document.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "9px";
    dot.style.height = "9px";
    dot.style.borderRadius = "50%";
    dot.style.background = light.color;
    if (light.glow) { dot.style.boxShadow = "0 0 5px " + light.color; }
    const badgeSpan = document.createElement("span");
    badgeSpan.style.fontWeight = "600";
    badgeSpan.textContent = `${light.label} · ${Math.round(ratio * 100)}%`;
    badge.appendChild(dot);
    badge.appendChild(badgeSpan);
    dhSection.appendChild(badge);

    const summaryRow = document.createElement("div");
    summaryRow.className = "settings-row";
    const summarySpan = document.createElement("span");
    summarySpan.textContent = `Orchestrator delegated ${delegations} tasks; did ${directSearches} searches and ${directEdits} edits directly.`;
    summaryRow.appendChild(summarySpan);
    dhSection.appendChild(summaryRow);

    const delegRow = document.createElement("div");
    delegRow.className = "settings-row";
    const delegSpan = document.createElement("span");
    delegSpan.textContent = `Delegations: ${delegations}`;
    delegRow.appendChild(delegSpan);
    dhSection.appendChild(delegRow);

    const searchRow = document.createElement("div");
    searchRow.className = "settings-row";
    const searchSpan = document.createElement("span");
    searchSpan.textContent = `Direct searches (Grep/Glob): ${directSearches} — delegate to search-retrieval (Haiku, ~40x cheaper)`;
    if (directSearches > warnThreshold) { searchSpan.style.color = "var(--status-error)"; }
    searchRow.appendChild(searchSpan);
    dhSection.appendChild(searchRow);

    const editRow = document.createElement("div");
    editRow.className = "settings-row";
    const editSpan = document.createElement("span");
    editSpan.textContent = `Direct edits: ${directEdits} — delegate to coding-specialist (Sonnet)`;
    editRow.appendChild(editSpan);
    dhSection.appendChild(editRow);

    const readRow = document.createElement("div");
    readRow.className = "settings-row";
    const readSpan = document.createElement("span");
    readSpan.style.color = "var(--muted)";
    readSpan.textContent = `Direct file reads: ${directReads} — allowed for known files`;
    readRow.appendChild(readSpan);
    dhSection.appendChild(readRow);

    const noteRow = document.createElement("div");
    noteRow.className = "settings-row";
    const noteSpan = document.createElement("span");
    noteSpan.style.color = "var(--muted)";
    noteSpan.style.fontSize = "11px";
    noteSpan.textContent = "Session totals — reflects the whole session so far.";
    noteRow.appendChild(noteSpan);
    dhSection.appendChild(noteRow);

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

    // ── 3c. Context budget ──
    const budgetSection = buildSection("Context budget");
    const cb = (lastSettings && lastSettings.contextBudget) || null;
    if (!cb) {
      const emptyNote = document.createElement("p");
      emptyNote.className = "settings-empty";
      emptyNote.textContent = "No context data.";
      budgetSection.appendChild(emptyNote);
    } else {
      /** @param {"ok"|"warn"|"high"} grade */
      function budgetDot(grade) {
        const dot = document.createElement("span");
        dot.style.display = "inline-block";
        dot.style.width = "8px";
        dot.style.height = "8px";
        dot.style.borderRadius = "50%";
        dot.style.marginRight = "6px";
        dot.style.flexShrink = "0";
        if (grade === "high") {
          dot.style.backgroundColor = "var(--status-error)";
        } else if (grade === "warn") {
          dot.style.backgroundColor = "var(--status-done)";
        } else {
          dot.style.backgroundColor = "var(--status-active)";
        }
        return dot;
      }
      /** @param {number} n */
      function formatK(n) {
        if (n >= 1000) return (Math.round(n / 100) / 10).toFixed(1) + "k";
        return String(n);
      }

      // Headline row
      const headlineRow = document.createElement("div");
      headlineRow.className = "settings-row";
      headlineRow.style.display = "flex";
      headlineRow.style.flexDirection = "row";
      headlineRow.style.alignItems = "center";
      headlineRow.style.justifyContent = "flex-start";
      headlineRow.style.textAlign = "left";
      headlineRow.style.gap = "6px";
      headlineRow.appendChild(budgetDot(cb.overall));
      const headlineText = document.createElement("span");
      headlineText.textContent = "Per prompt: ~" + formatK(cb.perPromptTokens) + " tokens (CLAUDE.md)";
      headlineRow.appendChild(headlineText);
      budgetSection.appendChild(headlineRow);

      // CLAUDE.md row
      const claudeRow = document.createElement("div");
      claudeRow.className = "settings-row";
      claudeRow.style.display = "flex";
      claudeRow.style.flexDirection = "row";
      claudeRow.style.alignItems = "center";
      claudeRow.style.justifyContent = "flex-start";
      claudeRow.style.textAlign = "left";
      claudeRow.style.gap = "6px";
      if (cb.claudeMd) {
        claudeRow.appendChild(budgetDot(cb.claudeMd.grade));
        const claudeText = document.createElement("span");
        claudeText.textContent = "CLAUDE.md: ~" + formatK(cb.claudeMd.tokens) + " tokens";
        claudeRow.appendChild(claudeText);
      } else {
        const noDot = document.createElement("span");
        noDot.style.width = "14px";
        noDot.style.display = "inline-block";
        claudeRow.appendChild(noDot);
        const missingText = document.createElement("span");
        missingText.textContent = "CLAUDE.md: not found";
        claudeRow.appendChild(missingText);
      }
      budgetSection.appendChild(claudeRow);

      // Agent file rows
      const agentFiles = Array.isArray(cb.agents) ? cb.agents : [];
      for (const af of agentFiles) {
        const agentRow = document.createElement("div");
        agentRow.className = "settings-row";
        agentRow.style.display = "flex";
        agentRow.style.flexDirection = "row";
        agentRow.style.alignItems = "center";
        agentRow.style.justifyContent = "flex-start";
        agentRow.style.textAlign = "left";
        agentRow.style.gap = "6px";
        agentRow.appendChild(budgetDot(af.grade));
        const agentText = document.createElement("span");
        agentText.textContent = af.name + ": ~" + formatK(af.tokens) + " tokens";
        agentRow.appendChild(agentText);
        budgetSection.appendChild(agentRow);
      }

      // Muted note
      const agentNote = document.createElement("p");
      agentNote.className = "settings-empty";
      agentNote.textContent = "Agent files load per sub-agent spawn, not every prompt.";
      budgetSection.appendChild(agentNote);

      // Review for trimming button
      const trimBtn = document.createElement("button");
      trimBtn.className = "skill-btn settings-btn";
      trimBtn.textContent = "Review for trimming";
      trimBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "copyPrompt", text: "Review CLAUDE.md and the agent definition files in .claude/agents/ for context bloat. CLAUDE.md is loaded into every prompt, so prioritize it: flag verbose, duplicated, or non-essential lines and propose a tighter rewrite that preserves every behavioral rule and the delegation routing. Then do the same for each .claude/agents/*.md (loaded per spawn). For each file give a before/after token estimate and the specific cuts." });
      });
      budgetSection.appendChild(trimBtn);
    }
    setupConfigEl.appendChild(budgetSection);

    // ── 4. Design docs ──
    const docsSection = buildSection("Design docs");
    const docsDesc = document.createElement("p");
    docsDesc.className = "settings-empty";
    docsDesc.textContent = "Generate a design doc (GDD/PRD) from what's built, or review one you've edited. Installs the design-doc skill and copies a prompt to paste into Claude Code.";
    docsSection.appendChild(docsDesc);
    const generateBtn = document.createElement("button");
    generateBtn.className = "skill-btn settings-btn";
    generateBtn.textContent = "Generate design doc";
    generateBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "designDocAction", mode: "generate" });
    });
    docsSection.appendChild(generateBtn);
    const reviewBtn = document.createElement("button");
    reviewBtn.className = "skill-btn settings-btn";
    reviewBtn.textContent = "Review design docs";
    reviewBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "designDocAction", mode: "review" });
    });
    docsSection.appendChild(reviewBtn);
    setupConfigEl.appendChild(docsSection);

    // ── 5. Danger zone ──
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
    // Show on-stage agent count (matches metrics table rows) instead of raw worker count.
    const agentCount = Array.isArray(state.agentMetrics) ? state.agentMetrics.length : Object.keys(state.workers).length;
    const tasks = state.completedTasks;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(8, 8, 220, 68);

    ctx.fillStyle = "#c8d8f0";
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "left";
    ctx.fillText(`Session: ${sessionText}`, 16, 28);
    ctx.fillText(`Agents: ${agentCount}`, 16, 46);
    ctx.fillText(`Built: ${tasks}`, 16, 64);
    ctx.restore();
  }

  // ── Roster strip (Feature 2 / Change 3) ─────────────────────────────────
  // The roster is now hosted inside the Themes modal (renderThemesList injects it).
  // buildRosterStrip() is kept as a no-op so existing call sites remain valid.
  function buildRosterStrip() {
    // Roster is rendered inside the Themes modal via renderThemesList.
    // This function intentionally does nothing to the stage DOM.
  }

  function render(timestamp) {
    // Delta time for animation advancement (capped at 100ms to avoid jumps on tab focus)
    const delta = lastFrameTime === 0 ? 0 : Math.min((timestamp - lastFrameTime) / 1000, 0.1);
    lastFrameTime = timestamp;

    frame++;
    const w = canvas.width;
    const h = canvas.height;

    // While the stage is still loading its theme art, suppress placeholder
    // buildings/stick-figures and show a single loading bar instead.
    const _load = themeLoadProgress();
    const _loadElapsed = themeLoadStartTs > 0 ? (nowMs() - themeLoadStartTs) : Infinity;
    const loadingActive = !_load.ready && themeLoadStartTs > 0 && _loadElapsed < LOADING_TIMEOUT_MS;

    // ── Change 2: Fixed-size background (does NOT stretch on resize) ──────────
    if (themeLoaded && themeBackgroundImg && themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0) {
      // Letterbox fill: solid backdrop so edges outside the fixed BG are clean.
      ctx.fillStyle = "#0a0a12";
      ctx.fillRect(0, 0, w, h);

      // Draw at the image's natural size, centered horizontally, TOP-anchored.
      // Top-anchoring keeps the background (and everything mapped to it) at a
      // fixed screen position: the metrics handlebar resizes the stage from its
      // bottom edge, so a top-anchored image never shifts when h changes.
      const bgW = themeBackgroundImg.naturalWidth;
      const bgH = themeBackgroundImg.naturalHeight;
      const bgX = Math.floor((w - bgW) / 2);
      const bgY = 0; // top-anchor → static regardless of handlebar / canvas height
      ctx.drawImage(themeBackgroundImg, bgX, bgY, bgW, bgH);
    } else {
      // Fallback placeholder background
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, w, h);

      // Sky gradient strip
      const grad = ctx.createLinearGradient(0, 0, 0, h * 0.7);
      grad.addColorStop(0, "#0d1b3e");
      grad.addColorStop(1, "#1a2a50");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h * 0.7);
    }

    // Ground band (always drawn for worker footing reference)
    const groundY = Math.floor(h * 0.78);
    if (!themeLoaded || !themeBackgroundImg || !themeBackgroundImg.complete) {
      ctx.fillStyle = "#2a3a2a";
      ctx.fillRect(0, groundY, w, h - groundY);
      ctx.strokeStyle = "#4a6a4a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(w, groundY);
      ctx.stroke();
    }

    // Buildings (left side) — only shown when no theme is active (and not loading)
    if (!loadingActive && (!themeLoaded || !themeBackgroundImg || !themeBackgroundImg.complete || themeBackgroundImg.naturalWidth === 0)) {
      drawBuildings(groundY, state.completedTasks);
    }

    // ── Isometric character placement + wander on themed floor ───────────────
    // Derive the agent list from the metrics table (same source as renderMetrics).
    // While loading, use an empty list so no placeholder/half-loaded sprites show.
    const agentList = loadingActive ? [] : (Array.isArray(state.agentMetrics) ? state.agentMetrics : []);

    // Prune stale entries from agentCharMap (agents no longer in metrics).
    const agentIds = new Set(agentList.map((a) => a.id));
    for (const id of Object.keys(agentCharMap)) {
      if (!agentIds.has(id)) delete agentCharMap[id];
    }

    // Resolve character sprite roster.
    const charIds = rosterOrder.length > 0 ? rosterOrder : Object.keys(themeImages);

    // Compute bg rect for native->canvas mapping (matches the draw above).
    const bgImgReady = themeLoaded && themeBackgroundImg && themeBackgroundImg.complete && themeBackgroundImg.naturalWidth > 0;
    const bgW = bgImgReady ? themeBackgroundImg.naturalWidth  : w;
    const bgH = bgImgReady ? themeBackgroundImg.naturalHeight : h;
    const bgX = bgImgReady ? Math.floor((w - bgW) / 2) : 0;
    const bgY = 0; // top-anchor (matches the background draw) → static on resize
    // Cache for the stage-editor mouse handlers (canvas<->native mapping).
    lastBgX = bgX; lastBgY = bgY; lastBgW = bgW; lastBgH = bgH;

    // Polygon bbox for depth scale computation.
    let polyMinY = Infinity, polyMaxY = -Infinity;
    for (const p of walkablePolygon) {
      if (p[1] < polyMinY) polyMinY = p[1];
      if (p[1] > polyMaxY) polyMaxY = p[1];
    }
    const polyRangeY = Math.max(polyMaxY - polyMinY, 1);

    agentList.forEach((agent, idx) => {
      // Look up a live worker (if one exists) for this agent.
      const worker = state.workers[agent.id] || null;

      // ── Initialise per-agent entry ─────────────────────────────────
      if (!agentCharMap[agent.id]) {
        const home = isoSlotHome(idx, walkablePolygon);
        const wanderDelay = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
        agentCharMap[agent.id] = {
          // Native-coord position (polygon space)
          nx: home[0],
          ny: home[1],
          // Native home
          homeNx: home[0],
          homeNy: home[1],
          // Native wander destination
          destNx: home[0],
          destNy: home[1],
          // Timer until next wander pick
          wanderTimer: wanderDelay,
          // Legacy canvas x/y (kept for facing, not for positioning)
          x: 0,
          y: 0,
          prevX: 0,
          animState: createAnimState(worker ? workerStateToClip(worker.state) : "idle"),
          facingLeft: false,
        };
      }
      const charEntry = agentCharMap[agent.id];

      // ── Active check ───────────────────────────────────────────────
      const isActive = worker
        ? (worker.state !== "idle" && worker.state !== "leave")
        : ((agent.status || "idle").toLowerCase() === "active" || (agent.status || "").toLowerCase() === "working");
      charEntry.isActive = isActive; // surfaced to the draw pass for the active light

      // ── Wander logic (native polygon space) ───────────────────────
      charEntry.wanderTimer -= delta;
      if (charEntry.wanderTimer <= 0) {
        // Pick new destination: active agents roam freely; idle agents stay near home.
        let dest;
        if (isActive) {
          dest = randomInsidePoly(walkablePolygon);
        } else {
          // Jitter around home within WANDER_RADIUS; clamp inside polygon.
          const angle = Math.random() * Math.PI * 2;
          const r = Math.random() * WANDER_RADIUS * 0.5;
          const tx = charEntry.homeNx + Math.cos(angle) * r;
          const ty = charEntry.homeNy + Math.sin(angle) * r;
          dest = clampToPolygon(tx, ty, walkablePolygon);
        }
        charEntry.destNx = dest[0];
        charEntry.destNy = dest[1];
        charEntry.wanderTimer = WANDER_INTERVAL_MIN + Math.random() * (WANDER_INTERVAL_MAX - WANDER_INTERVAL_MIN);
      }

      // ── Step toward destination ────────────────────────────────────
      const dxNative = charEntry.destNx - charEntry.nx;
      const dyNative = charEntry.destNy - charEntry.ny;
      const distNative = Math.sqrt(dxNative * dxNative + dyNative * dyNative);
      let isMoving = false;
      if (distNative > WANDER_ARRIVED_EPS) {
        const step = Math.min(WANDER_SPEED * delta, distNative);
        charEntry.nx += (dxNative / distNative) * step;
        charEntry.ny += (dyNative / distNative) * step;
        // Clamp inside polygon after movement
        const clamped = clampToPolygon(charEntry.nx, charEntry.ny, walkablePolygon);
        charEntry.nx = clamped[0];
        charEntry.ny = clamped[1];
        isMoving = true;
      }

      // ── Map native pos to canvas ───────────────────────────────────
      const canvasPt = nativeToCanvas(charEntry.nx, charEntry.ny, bgX, bgY, bgW, bgH);
      const cx = canvasPt[0];
      const cy = canvasPt[1];

      // ── Movement-based facing ──────────────────────────────────────
      const prevX = charEntry.prevX;
      if (typeof prevX === "number") {
        const dxCanvas = cx - prevX;
        if (dxCanvas < -FACING_EPS) charEntry.facingLeft = true;
        else if (dxCanvas > FACING_EPS) charEntry.facingLeft = false;
      }
      charEntry.prevX = cx;
      charEntry.x = cx;
      charEntry.y = cy;

      // ── Clip selection ─────────────────────────────────────────────
      let desiredClip;
      if (worker) {
        desiredClip = workerStateToClip(worker.state);
      } else {
        desiredClip = isActive ? "walk" : "idle";
      }
      // Override with walk while physically moving, else use status clip.
      if (isMoving && desiredClip !== "build" && desiredClip !== "cheer") desiredClip = "walk";
      else if (!isMoving && (desiredClip === "walk")) desiredClip = "idle";

      const anim = charEntry.animState;
      if (anim.action !== desiredClip) {
        anim.action = desiredClip;
        anim.frameIndex = 0;
        anim.direction = 1;
        anim.elapsed = 0;
        anim.completed = false;
      }
      advanceAnim(anim, delta);
    });

    // ── Sort agents back-to-front by native Y (isometric depth order) ─────────
    const sortedAgentList = agentList.slice().sort((a, b) => {
      const entA = agentCharMap[a.id];
      const entB = agentCharMap[b.id];
      const nyA = entA ? entA.ny : 0;
      const nyB = entB ? entB.ny : 0;
      return nyA - nyB;
    });

    sortedAgentList.forEach((agent, _sortIdx) => {
      const idx = agentList.indexOf(agent);
      const charEntry = agentCharMap[agent.id];
      if (!charEntry) return;

      const worker = state.workers[agent.id] || null;
      const desiredClip = charEntry.animState ? charEntry.animState.action : "idle";
      const anim = charEntry.animState;

      const cx = charEntry.x;
      const cy = charEntry.y;

      // Depth scale: agents further back (small native Y) draw slightly smaller.
      const tDepth = Math.max(0, Math.min(1, (charEntry.ny - polyMinY) / polyRangeY));
      const depthScale = 0.8 + tDepth * 0.3; // 0.8 (back) → 1.1 (front)

      if (bgImgReady && charIds.length > 0) {
        // Pick character sprite by agent index in roster order.
        const charId = charIds[idx % charIds.length];
        const slots = themeImages[charId];

        const slot = currentSlot(anim);
        const img = slots && slots[slot];

        if (img && img.complete && img.naturalWidth > 0) {
          const spriteSize = Math.round(64 * depthScale * effectiveCharScale(charId));
          // Foot-anchor: bottom of sprite sits at canvas floor point
          const drawX = cx - spriteSize / 2;
          const drawY = cy - spriteSize; // feet at cy

          const clip = ATLAS_CLIPS[anim.action] || ATLAS_CLIPS.idle;
          const shouldFlip = clip.flippable && charEntry.facingLeft === true;

          // Draw the sprite inside its own save/restore so the horizontal-flip
          // transform NEVER leaks into the label below (a flipped+scaled context
          // would mirror-map the label to ~spriteSize/2 and fling it offscreen).
          ctx.save();
          if (shouldFlip) {
            ctx.translate(cx + spriteSize / 2, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, drawY, spriteSize, spriteSize);
          } else {
            ctx.drawImage(img, drawX, drawY, spriteSize, spriteSize);
          }
          ctx.restore();

          // Label below feet — drawn in un-flipped canvas coords so it stays
          // centered directly under the agent regardless of facing direction.
          const labelFont = Math.round(9 * depthScale);
          ctx.fillStyle = "#e0e0e0";
          ctx.font = `${labelFont}px monospace`;
          ctx.textAlign = "center";
          const label = (agent.name || agent.id).slice(0, 12);
          const labelY = cy + Math.round(14 * depthScale);
          ctx.fillText(label, cx, labelY);

          // Active indicator: a small glowing green light immediately to the
          // LEFT of the name text (reads as "this agent, working") instead of
          // floating by the head.
          if (charEntry.isActive) {
            const labelW = ctx.measureText(label).width;
            const lightR = Math.max(2, 2.6 * depthScale);
            const lightX = cx - labelW / 2 - lightR - 3;
            const lightY = labelY - labelFont * 0.32; // vertical-center on the text
            ctx.save();
            ctx.shadowColor = "#39ff14";
            ctx.shadowBlur = 5;
            ctx.fillStyle = "#39ff14";
            ctx.beginPath();
            ctx.arc(lightX, lightY, lightR, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        } else {
          // Sprite not yet loaded — fallback stick figure
          drawWorker(cx, cy, worker || { id: agent.id, role: agent.name, state: desiredClip }, idx);
        }
      } else {
        // No theme loaded — placeholder stick figure on groundY
        const fallbackX = Math.max(40, (w - Math.min(80, (w - 40) / Math.max(agentList.length, 1)) * agentList.length) / 2) + idx * Math.min(80, (w - 40) / Math.max(agentList.length, 1));
        drawWorker(fallbackX, groundY, worker || { id: agent.id, role: agent.name, state: desiredClip }, idx);
      }
    });

    // (Nav-polygon debug overlay removed — the Stage Editor now shows/edits
    //  the walkable polygon, so the standalone N-key view is no longer needed.)

    // ── Stage editor overlay (draggable polygon handles) ───────────────
    if (editStageMode && themeLoaded && walkablePolygon && walkablePolygon.length > 2) {
      ctx.save();
      // Filled + stroked outline (amber to distinguish from the green nav view)
      ctx.beginPath();
      const [e0x, e0y] = nativeToCanvas(walkablePolygon[0][0], walkablePolygon[0][1], bgX, bgY, bgW, bgH);
      ctx.moveTo(e0x, e0y);
      for (let i = 1; i < walkablePolygon.length; i++) {
        const [px, py] = nativeToCanvas(walkablePolygon[i][0], walkablePolygon[i][1], bgX, bgY, bgW, bgH);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(255,193,7,0.10)";
      ctx.fill();
      ctx.strokeStyle = "#ffc107";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Edge midpoint "+" hints (double-click an edge to insert a vertex)
      ctx.fillStyle = "rgba(255,193,7,0.55)";
      for (let i = 0; i < walkablePolygon.length; i++) {
        const a = walkablePolygon[i];
        const b = walkablePolygon[(i + 1) % walkablePolygon.length];
        const [mx, my] = nativeToCanvas((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, bgX, bgY, bgW, bgH);
        ctx.beginPath();
        ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Draggable vertex handles
      for (let i = 0; i < walkablePolygon.length; i++) {
        const [vx, vy] = nativeToCanvas(walkablePolygon[i][0], walkablePolygon[i][1], bgX, bgY, bgW, bgH);
        const active = (i === dragVertexIndex) || (i === hoverVertexIndex);
        ctx.beginPath();
        ctx.arc(vx, vy, active ? 8 : 6, 0, Math.PI * 2);
        ctx.fillStyle = active ? "#fff3cd" : "#ffc107";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#7a5b00";
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Stage loading bar (replaces placeholders while the theme loads) ──
    if (loadingActive) {
      ctx.save();
      const barW = Math.min(280, w * 0.6);
      const barH = 8;
      const bx = Math.round((w - barW) / 2);
      const by = Math.round(h * 0.47);
      // Title + subtitle
      ctx.textAlign = "center";
      ctx.fillStyle = "#eef0f6";
      ctx.font = "600 14px system-ui, -apple-system, sans-serif";
      ctx.fillText("TycoonAgents", w / 2, by - 26);
      ctx.fillStyle = "rgba(186,196,214,0.85)";
      ctx.font = "11px system-ui, -apple-system, sans-serif";
      ctx.fillText(themeLoaded ? "Loading characters…" : "Loading…", w / 2, by - 10);
      // Track
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(bx, by, barW, barH);
      // Fill
      if (themeLoaded) {
        const frac = Math.max(0, Math.min(1, _load.frac));
        ctx.fillStyle = "#39ff14";
        ctx.fillRect(bx, by, Math.max(barH, barW * frac), barH);
        ctx.fillStyle = "rgba(186,196,214,0.85)";
        ctx.font = "10px system-ui, -apple-system, sans-serif";
        ctx.fillText(Math.round(frac * 100) + "%", w / 2, by + barH + 15);
      } else {
        // Indeterminate ping-pong segment while waiting for the theme payload.
        const segW = barW * 0.34;
        const t = 0.5 - 0.5 * Math.cos((nowMs() / 700) % (Math.PI * 2));
        const segX = bx + (barW - segW) * t;
        ctx.fillStyle = "#39ff14";
        ctx.fillRect(segX, by, segW, barH);
      }
      ctx.restore();
    }

    // HUD overlay
    drawHUD(w);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
