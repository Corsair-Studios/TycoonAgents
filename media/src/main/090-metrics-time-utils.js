// Part: 90-metrics-time-utils
// Relative time formatting and metrics/delegation panel helpers.
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

  /** Floating toast host, created lazily and reused across calls. */
  let toastHostEl = null;
  let toastHideTimer = null;

  /**
   * Show a floating toast near the bottom of the screen. `kind` is "info",
   * "success" (default-styled) or "error" (uses --status-error). Fades out
   * on its own after ~2.5s; a new call replaces whatever toast is showing.
   */
  function showToast(text, kind) {
    if (!toastHostEl) {
      toastHostEl = document.createElement("div");
      toastHostEl.id = "toast-host";
      document.body.appendChild(toastHostEl);
    }
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    toastHostEl.textContent = text;
    toastHostEl.className = kind === "error" ? "toast-visible toast-error" : "toast-visible";
    // Force reflow so re-triggering the animation/opacity transition works
    // even when a toast is already visible.
    void toastHostEl.offsetWidth;
    toastHostEl.classList.add("toast-shown");
    toastHideTimer = setTimeout(() => {
      toastHostEl.classList.remove("toast-shown");
      toastHideTimer = null;
    }, 2500);
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
   * A colored status chip for one Path Health row. Mirrors
   * pathHealth.ts's own buildPathDiagnosticText status derivation exactly
   * (NOT FOUND / SET-BUT-MISSING / OK) so the webview never invents a
   * fourth reading of the same three states. Reuses the existing
   * `.stat-chip` shape (see the Agents section above) with inline colors
   * pulled from the same CSS custom properties/hex values the rest of this
   * file already uses for red/green severity (danger-btn's red, routing-
   * light--green's green) — no new CSS classes, per the "don't introduce a
   * new visual language" constraint.
   * @param {{source:string, exists:boolean}} entry
   */
  function buildPathStatusChip(entry) {
    const chip = document.createElement("span");
    chip.className = "stat-chip";
    if (entry.source === "not-found") {
      chip.textContent = "NOT FOUND";
      chip.style.color = "var(--status-error)";
      chip.style.background = "rgba(251, 113, 133, 0.16)";
      chip.style.borderColor = "var(--status-error)";
      chip.style.fontWeight = "700";
    } else if (!entry.exists) {
      chip.textContent = "SET, BUT MISSING ON DISK";
      chip.style.color = "var(--status-error)";
      chip.style.background = "rgba(251, 113, 133, 0.16)";
      chip.style.borderColor = "var(--status-error)";
      chip.style.fontWeight = "700";
    } else {
      const sourceLabel = entry.source === "override" ? "override" : entry.source === "env" ? "env var" : "auto-detected";
      chip.textContent = `OK · ${sourceLabel}`;
      chip.style.color = "var(--status-active)";
      chip.style.background = "rgba(63, 185, 80, 0.12)";
      chip.style.borderColor = "var(--status-active)";
    }
    return chip;
  }

  /**
   * Build one Path Health row: label + description, resolved value, status
   * chip, on-disk existence, the candidate ladder (collapsed, shown when
   * something's wrong), and the override text input + Save/Clear. Field
   * names below are read straight off src/host/vscode/pathHealth.ts's
   * `PathHealthEntry` (key/label/description/resolvedPath/source/exists/
   * candidates) — see that file's own interface for the authoritative shape.
   * @param {{key:string,label:string,description:string,resolvedPath:(string|null),source:string,exists:boolean,candidates:Array<{origin:string,location:string}>}} entry
   */
  function buildPathHealthRow(entry) {
    const row = document.createElement("div");
    row.className = "settings-row path-health-row";
    row.dataset.agentRow = "path-" + entry.key;

    const head = document.createElement("div");
    head.className = "agent-row-head";
    const nameEl = document.createElement("span");
    nameEl.className = "agent-name";
    nameEl.textContent = entry.label;
    head.appendChild(nameEl);
    head.appendChild(buildPathStatusChip(entry));
    row.appendChild(head);

    const descEl = document.createElement("p");
    descEl.className = "settings-empty";
    descEl.style.padding = "0";
    descEl.textContent = entry.description;
    row.appendChild(descEl);

    const resolvedEl = document.createElement("div");
    resolvedEl.className = "hook-activity";
    resolvedEl.textContent = "Resolved path: " + (entry.resolvedPath || "(none)");
    row.appendChild(resolvedEl);

    const existsEl = document.createElement("div");
    existsEl.className = "hook-activity";
    existsEl.textContent = "Exists on disk: " + (entry.exists ? "Yes" : "No");
    row.appendChild(existsEl);

    // Candidate ladder — only worth expanding when something's wrong; an OK
    // row already told the user everything they need. Collapsed <details>,
    // never innerHTML — every value here came off the user's own filesystem.
    if ((entry.source === "not-found" || !entry.exists) && Array.isArray(entry.candidates) && entry.candidates.length > 0) {
      const details = document.createElement("details");
      details.className = "hook-activity";
      const summary = document.createElement("summary");
      summary.textContent = `Locations checked (${entry.candidates.length})`;
      details.appendChild(summary);
      const list = document.createElement("div");
      list.style.marginTop = "4px";
      list.style.fontFamily = "var(--mono-font, monospace)";
      for (const c of entry.candidates) {
        const line = document.createElement("div");
        line.textContent = `[${c.origin}] ${c.location}`;
        list.appendChild(line);
      }
      details.appendChild(list);
      row.appendChild(details);
    }

    // Override entry — text input + Save/Clear, per-row. Save posts
    // SET_PATH_OVERRIDE {key, path}; the host validates the path actually
    // exists on disk BEFORE accepting it and replies PATH_OVERRIDE_RESULT
    // (handled by handlePathOverrideResult above) — never assume success.
    const overrideWrap = document.createElement("div");
    overrideWrap.className = "keyword-input-wrap";
    const overrideInput = document.createElement("input");
    overrideInput.type = "text";
    overrideInput.className = "keyword-input";
    overrideInput.placeholder = "Absolute path to override " + entry.key;
    if (entry.source === "override" && entry.resolvedPath) {
      overrideInput.value = entry.resolvedPath;
    }
    const saveBtn = document.createElement("button");
    saveBtn.className = "skill-btn settings-btn";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const val = overrideInput.value.trim();
      if (!val) {
        flashError(row, "Enter a path first");
        return;
      }
      saveBtn.disabled = true;
      clearBtn.disabled = true;
      vscode.postMessage({ type: "setPathOverride", key: entry.key, path: val });
    });
    const clearBtn = document.createElement("button");
    clearBtn.className = "skill-btn settings-btn";
    clearBtn.textContent = "Clear";
    if (entry.source !== "override") {
      clearBtn.disabled = true;
      clearBtn.classList.add("btn-disabled");
    }
    clearBtn.addEventListener("click", () => {
      saveBtn.disabled = true;
      clearBtn.disabled = true;
      vscode.postMessage({ type: "clearPathOverride", key: entry.key });
    });
    overrideWrap.appendChild(overrideInput);
    overrideWrap.appendChild(saveBtn);
    overrideWrap.appendChild(clearBtn);
    row.appendChild(overrideWrap);

    return row;
  }

  /**
   * Build the "Verse extension" status block inside the Path Health section
   * — three distinct states from pathHealth.ts's detectVerseExtensionState
   * (enabled / installed-but-disabled / not-installed), each with different
   * real-world consequences the host already phrased correctly in
   * `verse.message` (rendered verbatim here rather than re-authored, so the
   * UI never drifts from the host's own reasoning). multipleVersions is
   * surfaced as its own note since a stale analyzer reports confidently
   * wrong diagnostics.
   * @param {{state:string,enabledVersion:(string|null),versionsFound:Array<{version:string,ideDir:string,extensionDir:string}>,multipleVersions:boolean,message:string}} verse
   */
  function buildVerseExtensionBlock(verse) {
    const wrap = document.createElement("div");
    wrap.className = "settings-row";

    const label = document.createElement("div");
    label.className = "keyword-label";
    label.textContent = "Verse extension (epicgames.verse)";
    wrap.appendChild(label);

    const stateLine = document.createElement("div");
    if (verse.state === "enabled") {
      stateLine.className = "hook-ok";
    } else if (verse.state === "disabled") {
      stateLine.className = "hook-warn";
    } else {
      stateLine.className = "hook-bad";
    }
    stateLine.textContent = verse.message;
    wrap.appendChild(stateLine);

    if (verse.multipleVersions && Array.isArray(verse.versionsFound) && verse.versionsFound.length > 0) {
      const multiNote = document.createElement("div");
      multiNote.className = "hook-warn";
      multiNote.textContent = "Multiple Verse extension versions found on disk:";
      wrap.appendChild(multiNote);
      const list = document.createElement("div");
      list.className = "hook-activity";
      for (const v of verse.versionsFound) {
        const line = document.createElement("div");
        line.textContent = `[${v.ideDir}] v${v.version} — ${v.extensionDir}`;
        list.appendChild(line);
      }
      wrap.appendChild(list);
    }

    return wrap;
  }

  /**
   * Shared Path Health rollup — the single source of truth for "is
   * everything OK" that both the UEFN/Verse modal's own rollup line AND the
   * compact Settings summary line (buildUefnHealthSummaryRow, below) read
   * from, so the two can never drift into disagreeing with each other.
   * `notFoundCount` counts entries the override->env->auto-detect ladder
   * couldn't resolve; `verseNeedsAttention` is true whenever the Verse
   * extension report exists and isn't in the "enabled" state.
   * @param {Array<{source:string,exists:boolean}>} entries
   * @param {{state:string}|null} verse
   * @returns {{healthy:boolean, notFoundCount:number, verseNeedsAttention:boolean, text:string}}
   */
  function computePathHealthRollup(entries, verse) {
    const notFoundCount = entries.filter((e) => e.source === "not-found" || !e.exists).length;
    const verseNeedsAttention = verse !== null && verse.state !== "enabled";
    const healthy = notFoundCount === 0 && !verseNeedsAttention;
    const text = healthy
      ? "✓ All required paths detected"
      : `⚠ ${notFoundCount} path${notFoundCount === 1 ? "" : "s"} not detected${verseNeedsAttention ? " · Verse extension needs attention" : ""}`;
    return { healthy, notFoundCount, verseNeedsAttention, text };
  }

  /**
   * Build the whole "Path Health" settings section — the visible half of
   * this repo's Path & Environment Discovery core principle (see CLAUDE.md
   * and src/host/vscode/pathHealth.ts). Reads lastPathHealth/
   * lastPathOverridesFilePath/lastPathOverridesFileExists/
   * lastVerseExtensionState (populated by the "installState" handler above).
   * A NOT FOUND path or a non-enabled Verse extension surfaces a prominent
   * (not quiet-grey) rollup line at the top, reusing the exact hook-ok/
   * hook-bad classes Hook health already uses above — same alert language,
   * not a new one.
   */
  function buildPathHealthSection() {
    const section = buildSection("Path Health");
    const entries = Array.isArray(lastPathHealth) ? lastPathHealth : [];
    const verse = lastVerseExtensionState;

    if (entries.length === 0) {
      const emptyP = document.createElement("p");
      emptyP.className = "settings-empty";
      emptyP.textContent = "No project root open — Path Health needs an open folder to probe.";
      section.appendChild(emptyP);
      return section;
    }

    const pathRollup = computePathHealthRollup(entries, verse);

    const rollup = document.createElement("div");
    rollup.className = pathRollup.healthy ? "hook-ok" : "hook-bad";
    rollup.textContent = pathRollup.text;
    section.appendChild(rollup);

    if (lastPathOverridesFilePath) {
      const overridesFileNote = document.createElement("div");
      overridesFileNote.className = "hook-activity";
      overridesFileNote.textContent =
        "Overrides file: " + lastPathOverridesFilePath + (lastPathOverridesFileExists ? "" : " (not created yet)");
      section.appendChild(overridesFileNote);
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "settings-row";
    actionsRow.style.flexDirection = "row";
    actionsRow.style.gap = "8px";
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "skill-btn settings-btn";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Refreshing…";
      vscode.postMessage({ type: "refreshPathHealth" });
    });
    const copyDiagBtn = document.createElement("button");
    copyDiagBtn.className = "skill-btn settings-btn";
    copyDiagBtn.textContent = "Copy for Claude";
    copyDiagBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "copyPathDiagnostic" });
    });
    actionsRow.appendChild(refreshBtn);
    actionsRow.appendChild(copyDiagBtn);
    section.appendChild(actionsRow);

    for (const entry of entries) {
      section.appendChild(buildPathHealthRow(entry));
    }

    if (verse) {
      section.appendChild(buildVerseExtensionBlock(verse));
    }

    return section;
  }

  /**
   * Open the UEFN/Verse modal, re-rendering its body first so it never shows
   * stale data — the exact same open path the "menu-uefn" hamburger item
   * uses (see that click handler above), extracted so the Settings summary
   * button below and the menu item can't drift into opening the modal two
   * different ways.
   */
  function openUefnModal() {
    renderUefnModalBody();
    openModal(uefnModalEl, uefnModalCloseBtn);
  }

  /**
   * Settings-only entry point for the UEFN/Verse modal: closes the full-bleed
   * #setup-view (via the existing showMain() toggle) BEFORE opening the
   * modal, so the two full-screen overlays switch instead of stacking —
   * #setup-view is z-index:200, above the modal's z-index:100/501, so
   * leaving Settings open left the modal opened-but-invisible behind it.
   * The "menu-uefn" hamburger path calls openUefnModal() directly and is
   * untouched — Settings isn't open on that path, so there's nothing to
   * close first.
   */
  function openUefnModalFromSettings() {
    showMain();
    openUefnModal();
  }

  /**
   * True when UEFN support is installed IN THIS PROJECT — the UEFN skill
   * (catalog id "uefn" in lastSkills), the UEFN pack (catalog id "uefn" in
   * lastPacks, via packAnyInstalled so a partially-installed pack still
   * counts), or the UEFN Bridge MCP server (catalog id "uefn-bridge" in
   * lastMcpServers). Deliberately NOT lastUefnInstalled — that flag is
   * installState's `uefnInstalled`, a MACHINE-LEVEL check (does
   * %LOCALAPPDATA%\UnrealEditorFortnite exist) that says nothing about
   * whether THIS project uses UEFN, so it warned in every project on a
   * machine with UEFN installed (feedback issue #16 all over again).
   * @returns {boolean}
   */
  function isUefnInstalledInProject() {
    const skillInstalled = Array.isArray(lastSkills) &&
      lastSkills.some((s) => s && s.id === "uefn" && s.installed);
    const mcpInstalled = Array.isArray(lastMcpServers) &&
      lastMcpServers.some((s) => s && s.id === "uefn-bridge" && s.installed);
    const packInstalled = Array.isArray(lastPacks) &&
      lastPacks.some((p) => p && p.id === "uefn" && packAnyInstalled(p));
    return skillInstalled || mcpInstalled || packInstalled;
  }

  /**
   * Build the compact "UEFN health" summary row for Settings — a single
   * line (green/yellow only, no red state here) plus a button that opens
   * the full "UEFN / Verse" modal (#uefn-modal) for detail. Replaces the
   * full Path Health section that used to render inline in Settings (see
   * the "1a. Path Health" comment below); this line and the modal's own
   * rollup both read computePathHealthRollup() so they can't disagree.
   * Rendered ONLY when isUefnInstalledInProject() is true — a non-UEFN
   * project must see nothing here at all (feedback issue #16).
   * @returns {HTMLElement|null}
   */
  function buildUefnHealthSummaryRow() {
    if (!isUefnInstalledInProject()) return null;

    const entries = Array.isArray(lastPathHealth) ? lastPathHealth : [];
    if (entries.length === 0) return null;

    const rollup = computePathHealthRollup(entries, lastVerseExtensionState);

    const row = document.createElement("div");
    row.className = "settings-row hook-row";
    const line = document.createElement("div");
    line.className = rollup.healthy ? "hook-ok" : "hook-warn";
    line.textContent = rollup.healthy ? "✓ UEFN paths healthy" : rollup.text;
    const detailsBtn = document.createElement("button");
    detailsBtn.className = "skill-btn settings-btn";
    detailsBtn.textContent = "UEFN / Verse details";
    // Settings is open on this path (this row only renders inside it), so
    // use the Settings-aware wrapper that closes #setup-view first — see
    // openUefnModalFromSettings() doc comment for why (z-index switch, not
    // stack). The "menu-uefn" hamburger handler above still calls
    // openUefnModal() directly since Settings isn't open on that path.
    detailsBtn.addEventListener("click", openUefnModalFromSettings);
    row.appendChild(line);
    row.appendChild(detailsBtn);
    return row;
  }

  /**
   * Populate the "UEFN / Verse" modal body (#uefn-modal-body) with a fresh
   * Path Health section. This is the modal-ized replacement for the old
   * inline "── 1a. Path Health ──" block in renderSettings() — Path Health
   * used to rebuild automatically on every "settings"/"installState" push
   * because renderSettings() rebuilt it as a side effect. Now that it lives
   * in its own modal container (not #setup-config), it needs its own calls
   * at the same two trigger points so it never goes stale while open:
   *   1. The "installState" handler (~ where lastPathHealthSnapshot is
   *      diffed) — a Refresh/Save/Clear re-probe.
   *   2. The "settings" handler — kept for parity even though Path Health
   *      itself doesn't read lastSettings, so any future field that does
   *      doesn't silently go stale.
   * Also called directly from the "menu-uefn" click handler so opening the
   * modal always shows current data immediately, not stale data from
   * whenever it last happened to rebuild in the background.
   * No-ops if the modal body node isn't in the DOM yet (defensive; it's a
   * static element in panel.ts's HTML so this should never actually fire).
   */
  function renderUefnModalBody() {
    const bodyEl = document.getElementById("uefn-modal-body");
    if (!bodyEl) return;
    bodyEl.innerHTML = "";
    bodyEl.appendChild(buildPathHealthSection());
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
      // On failure the host doesn't push a fresh "settings" message, so the
      // delegation-mode radios / review-pass checkbox (disabled while the
      // change was in flight) would otherwise stay stuck — re-enable here.
      if (msg.field === "delegationMode" && row) {
        row.querySelectorAll('input[type="radio"]').forEach((el) => { el.disabled = false; });
      } else if (msg.field === "reviewEnabled" && row) {
        row.querySelectorAll('input[type="checkbox"]').forEach((el) => { el.disabled = false; });
      } else if (msg.field === "sessionJournalEntries" && row) {
        row.querySelectorAll('select').forEach((el) => { el.disabled = false; });
      }
    }
  }

  /**
   * Handle a pathOverrideResult ack from SET_PATH_OVERRIDE/CLEAR_PATH_OVERRIDE
   * (see src/host/vscode/panel.ts's _handleSetPathOverride /
   * _handleClearPathOverride). `ok:false` carries a human-readable `error`
   * (e.g. "nothing exists at that path") — rendered inline via flashError so
   * a rejected override is visible on the row, never a silent no-op. On
   * success the host has already re-run _handleCheckInstall and will push a
   * fresh "installState" momentarily, which rebuilds this whole row with the
   * new probe (see the "installState" handler above) — this only needs to
   * re-enable the buttons and flash a confirm in the meantime.
   * @param {{key:string, ok:boolean, error?:string}} msg
   */
  function handlePathOverrideResult(msg) {
    // Bug fix: Path Health rows render inside #uefn-modal-body, a sibling of
    // setupConfigEl (#setup-config) — not a descendant of it. Querying from
    // setupConfigEl always returned null here, so the guard below fired and
    // the Save/Clear buttons never re-enabled / never showed saved/error
    // feedback (the override still saved host-side; only the in-flight UI
    // feedback was lost). Query from document instead, matching how
    // handleSettingsUpdated's row lookup already works for setupConfigEl.
    const row = msg.key
      ? document.querySelector(`[data-agent-row="path-${CSS.escape(msg.key)}"]`)
      : null;
    if (!row) return;
    row.querySelectorAll("button").forEach((el) => { el.disabled = false; });
    if (msg.ok) {
      flashSaved(row);
    } else {
      flashError(row, msg.error || "Could not save override");
    }
  }

  /**
   * Handle a metricsReset ack from the host.
   * @param {{ok:boolean, error?:string}} msg
   */
  function handleMetricsReset(msg) {
    if (msg.ok) {
      // Bug fix: do NOT blank the metrics table / delegation stats here.
      // The host's runtime.reset() + WorkerRegistered re-seed loop already
      // fires onChange -> a "state" message (see the msg.type === "state"
      // handler above, L6442) carrying the full roster with zeroed stats,
      // and that "state" message arrives BEFORE this metricsReset ack.
      // Clearing lastMetrics/renderMetrics/renderDelegationStats here ran
      // AFTER that correct re-seed render and wiped it out, leaving the
      // AGENT METRICS table empty until the next task's "state" push.
      // renderMetrics()/renderDelegationStats() are driven by the "state"
      // handler (L6459-6460) and self-maintain lastMetrics (see
      // renderMetrics, L7790) — nothing to do here.
      renderSettings();
      // ── Bug fix: also clear persisted badge/build/rebirth WORLD state so
      // the medal count + built objects actually disappear on Reset, instead
      // of surviving Reset/reload/upgrade via the webview's own getState()
      // cache and buildBuiltCount (requiredRebirthBadgeIds is intentionally
      // left alone — it's the host-driven requirement definition, not
      // progress, and gets repopulated by the next host payload). ──────────
      unlockedBadgeIds = new Set();
      // Also clear the per-badge dot-tracking working sets/maps (ALL themes —
      // badgeKnownByTheme/badgeUnseenByTheme are keyed by theme_id, not just
      // the current one) so a full Reset leaves no stale "known" baseline
      // that would suppress a dot on a badge re-earned after Reset.
      unseenBadgeIds = new Set();
      knownBadgeIds = new Set();
      badgeUnseenByTheme = {};
      badgeKnownByTheme = {};
      cycleObjectsBuilt = 0;
      cycleRivalsEvicted = 0;
      cyclePeakActive = 0;
      rebirthCount = 0;
      rebirthBaseline = { built: 0, evicted: 0, tasks: 0 };
      // buildBuiltCount/buildCurrentProgress drive the WORLD's visible built
      // objects (see computeBuildState) — a separate counter from
      // cycleObjectsBuilt (badge/rebirth-cycle progress only). Without
      // zeroing these the built objects stay visible after Reset.
      buildBuiltCount = 0;
      buildCurrentProgress = 0;
      // Ranged weapons must re-lock on Reset too — the weapons rack is a
      // rebirthCount>=1 unlock, and rebirthCount was just zeroed above. D4:
      // this is a full data wipe (prev.rebirth is deleted below too), so the
      // durable permanent-unlock flag and the rack's queued position are
      // cleared along with it — unlike doRebirth(), which must never touch
      // either.
      rangedUnlocked = false;
      rangedPermanentlyUnlocked = false;
      rackInsertIndex = null;
      // Victory lap's edge-trigger latch/participant set/in-flight run must
      // not survive a Reset either (rebirthCount was just zeroed above,
      // which changes the upgraded/base decision for anything in flight —
      // see resetVictoryLapForSceneReset's doc).
      resetVictoryLapForSceneReset();
      // Purge the persisted blob so a reload can't rehydrate stale progress.
      try {
        const prev = vscode.getState() || {};
        delete prev.rebirth;
        delete prev.badgeUnseenByTheme;
        delete prev.badgeKnownByTheme;
        vscode.setState(prev);
      } catch (e) { /* best-effort */ }
      renderBadgePanel();
      renderRebirthPanel();
      // Mirrors the update site used everywhere else the unlocked count
      // changes (see updateBadgeHud, L708) rather than duplicating its
      // hidden/pop-animation logic here.
      updateBadgeHud();
      updateTrophyRow();
    } else if (dangerStatusEl) {
      dangerStatusEl.textContent = msg.error || "Reset failed";
      dangerStatusEl.classList.add("settings-error-note");
    }
  }

  /** Reference to the danger-zone status line (set during render). */
  let dangerStatusEl = null;

  // ── Submit feedback (Settings area) ───────────────────────────────────
  // Two-step flow per docs/FEEDBACK-PIPELINE-SPEC.md §5: "submitFeedback"
  // only builds a preview (no network call, nothing sent); "confirmFeedback
  // Send" is the ONLY message that actually sends. Element refs are rebuilt
  // each renderSettings() call (Settings re-renders its whole subtree); the
  // ticketId/in-flight flags below persist across renders since Settings
  // normally stays open through the whole flow.
  //
  // Invalidation design: rather than a live input-diff, form fields are
  // DISABLED the instant a preview is requested and stay disabled until
  // "Back to edit" is pressed. Editing is therefore structurally impossible
  // without going through Back first, and Back always clears the ticketId —
  // so "editing after a preview invalidates it" holds by construction, with
  // no separate dirty-tracking path that could drift out of sync.
  let feedbackCategoryEl = null;
  let feedbackDescEl = null;
  let feedbackDiagCheckbox = null;
  let feedbackContactEl = null;
  let feedbackCharCounterEl = null;
  let feedbackFormStatusEl = null;
  let feedbackPreviewBtn = null;
  let feedbackPreviewSection = null;
  let feedbackPreviewTicketEl = null;
  let feedbackPreviewJsonEl = null;
  let feedbackSendBtn = null;
  let feedbackBackBtn = null;
  let feedbackResultEl = null;
  /** ticketId of the currently active (previewed, unsent or send-failed) preview; null when no preview is active. */
  let feedbackPreviewTicketId = null;
  /** True while confirmFeedbackSend is awaiting a feedbackResult reply; guards against double-submit. */
  let feedbackSendInFlight = false;

  function setFeedbackFieldsDisabled(disabled) {
    if (feedbackCategoryEl) feedbackCategoryEl.disabled = disabled;
    if (feedbackDescEl) feedbackDescEl.disabled = disabled;
    if (feedbackDiagCheckbox) feedbackDiagCheckbox.disabled = disabled;
    if (feedbackContactEl) feedbackContactEl.disabled = disabled;
  }

  /** Live character counter + Preview-button validity gate for the description textarea. */
  function updateFeedbackCharCounter() {
    if (!feedbackDescEl || !feedbackCharCounterEl) return;
    const len = feedbackDescEl.value.length;
    feedbackCharCounterEl.textContent = len + " / 4000";
    feedbackCharCounterEl.classList.toggle("feedback-char-counter--warn", len >= 3800);
    if (feedbackPreviewBtn && !feedbackPreviewBtn.hasAttribute("hidden")) {
      feedbackPreviewBtn.disabled = feedbackDescEl.value.trim().length === 0;
    }
  }

  /** Clear the form back to its defaults after a successful send. */
  function resetFeedbackForm() {
    feedbackPreviewTicketId = null;
    feedbackSendInFlight = false;
    if (feedbackCategoryEl) feedbackCategoryEl.value = "bug";
    if (feedbackDescEl) feedbackDescEl.value = "";
    if (feedbackDiagCheckbox) feedbackDiagCheckbox.checked = true;
    if (feedbackContactEl) feedbackContactEl.value = "";
    setFeedbackFieldsDisabled(false);
    if (feedbackPreviewSection) feedbackPreviewSection.setAttribute("hidden", "");
    if (feedbackPreviewBtn) {
      feedbackPreviewBtn.removeAttribute("hidden");
      feedbackPreviewBtn.disabled = true; // re-gated by updateFeedbackCharCounter below (description is now empty)
      feedbackPreviewBtn.textContent = "Preview";
    }
    if (feedbackFormStatusEl) feedbackFormStatusEl.textContent = "";
    updateFeedbackCharCounter();
  }

  /** "Back to edit" — invalidates the current preview and unlocks the fields. Does NOT clear result text (caller decides). */
  function cancelFeedbackPreview() {
    feedbackPreviewTicketId = null;
    feedbackSendInFlight = false;
    setFeedbackFieldsDisabled(false);
    if (feedbackPreviewSection) feedbackPreviewSection.setAttribute("hidden", "");
    if (feedbackPreviewBtn) {
      feedbackPreviewBtn.removeAttribute("hidden");
      feedbackPreviewBtn.disabled = false;
      feedbackPreviewBtn.textContent = "Preview";
    }
    if (feedbackFormStatusEl) feedbackFormStatusEl.textContent = "";
    if (feedbackResultEl) {
      feedbackResultEl.textContent = "";
      feedbackResultEl.className = "feedback-status";
    }
    updateFeedbackCharCounter();
  }

  /** [Preview] click — posts submitFeedback. THIS ONLY BUILDS A PREVIEW; no network call happens until confirmFeedbackSend. */
  function requestFeedbackPreview() {
    if (!feedbackDescEl || !feedbackCategoryEl) return;
    const description = feedbackDescEl.value;
    if (description.trim().length === 0) {
      if (feedbackFormStatusEl) feedbackFormStatusEl.textContent = "Description is required.";
      return;
    }
    if (feedbackFormStatusEl) feedbackFormStatusEl.textContent = "Building preview…";
    if (feedbackPreviewBtn) {
      feedbackPreviewBtn.disabled = true;
      feedbackPreviewBtn.textContent = "Building preview…";
    }
    setFeedbackFieldsDisabled(true);
    vscode.postMessage({
      type: "submitFeedback",
      category: feedbackCategoryEl.value,
      userDescription: description,
      includeDiagnostics: Boolean(feedbackDiagCheckbox && feedbackDiagCheckbox.checked),
      contact: feedbackContactEl ? feedbackContactEl.value : "",
    });
  }

  /** Host replied with the built preview — render the exact JSON + reveal Send/Back. */
  function handleFeedbackPreview(msg) {
    feedbackPreviewTicketId = msg.ticketId || null;
    feedbackSendInFlight = false;
    if (feedbackFormStatusEl) feedbackFormStatusEl.textContent = "";
    if (feedbackPreviewBtn) feedbackPreviewBtn.setAttribute("hidden", "");
    if (feedbackPreviewTicketEl) feedbackPreviewTicketEl.textContent = "Ticket ID: " + (msg.ticketId || "");
    if (feedbackPreviewJsonEl) feedbackPreviewJsonEl.textContent = msg.payloadJson || "";
    if (feedbackPreviewSection) feedbackPreviewSection.removeAttribute("hidden");
    if (feedbackSendBtn) {
      feedbackSendBtn.disabled = false;
      feedbackSendBtn.textContent = "Send";
    }
  }

  /** [Send] click — the ONLY action that actually transmits anything. */
  function sendFeedbackConfirmed() {
    if (!feedbackPreviewTicketId || feedbackSendInFlight) return;
    feedbackSendInFlight = true;
    if (feedbackSendBtn) {
      feedbackSendBtn.disabled = true;
      feedbackSendBtn.textContent = "Sending…";
    }
    if (feedbackResultEl) {
      feedbackResultEl.textContent = "";
      feedbackResultEl.className = "feedback-status";
    }
    vscode.postMessage({ type: "confirmFeedbackSend", ticketId: feedbackPreviewTicketId });
  }

  /** Host replied to confirmFeedbackSend — show success (with ticketId) or failure (clipboard fallback + retry). */
  function handleFeedbackResult(msg) {
    // Ignore a stale reply for a preview that's since been backed-out-of/replaced.
    if (feedbackPreviewTicketId && msg.ticketId && msg.ticketId !== feedbackPreviewTicketId) return;
    feedbackSendInFlight = false;
    if (msg.ok) {
      if (feedbackResultEl) {
        feedbackResultEl.textContent = "Sent — thank you. Ticket ID: " + (msg.ticketId || "");
        feedbackResultEl.className = "feedback-status feedback-status--ok";
      }
      resetFeedbackForm();
    } else {
      if (feedbackResultEl) {
        feedbackResultEl.textContent = (msg.error || "Send failed") +
          " — copied to your clipboard. Retry, or use the fallback form: https://feedback.corsairstudios.com";
        feedbackResultEl.className = "feedback-status feedback-status--error";
      }
      if (feedbackSendBtn) {
        feedbackSendBtn.disabled = false;
        feedbackSendBtn.textContent = "Retry Send";
      }
    }
  }

  /**
   * Populate the "Feedback" modal body (#feedback-modal-body) with the
   * Submit Feedback form. Moved out of renderSettings() into its own modal
   * so Settings is less overwhelming — this used to be section "── 5b.
   * Submit feedback ──" inside renderSettings(), rebuilt as a side effect of
   * every "settings" push. It doesn't read lastSettings at all (a static
   * form), so unlike renderUefnModalBody() it's only called once per modal
   * open (from the "menu-feedback" click handler), not wired to any
   * settings/installState push. All feedbackXEl module-level refs are
   * reassigned here exactly as they were inside renderSettings() — every
   * function that touches them (setFeedbackFieldsDisabled,
   * updateFeedbackCharCounter, resetFeedbackForm, cancelFeedbackPreview,
   * requestFeedbackPreview, handleFeedbackPreview, sendFeedbackConfirmed,
   * handleFeedbackResult above) reads them through the same null-checked
   * module variables, so they keep working unchanged regardless of which
   * container the nodes live in.
   */
  function renderFeedbackModalBody() {
    const bodyEl = document.getElementById("feedback-modal-body");
    if (!bodyEl) return;
    bodyEl.innerHTML = "";

    // Two-step preview-then-send flow to a private GitHub-issue-backed
    // intake pipeline; see docs/FEEDBACK-PIPELINE-SPEC.md. The webview never
    // sends anything on its own — "submitFeedback" only asks the host to
    // build a preview, and "confirmFeedbackSend" (posted only from the Send
    // button below, after a preview has been shown) is the sole message
    // that triggers a network call, made host-side.
    const feedbackSection = buildSection("Submit feedback");

    const feedbackIntro = document.createElement("p");
    feedbackIntro.className = "settings-empty";
    feedbackIntro.textContent = "Report a bug, share an idea, or ask a question. Nothing is sent until you review the exact preview below and press Send.";
    feedbackSection.appendChild(feedbackIntro);

    // Plain-language disclosure — VERBATIM copy from
    // docs/FEEDBACK-PIPELINE-SPEC.md §7 "Plain-language disclosure (what
    // gets sent)". That section is the single source of truth for this
    // text; do not reword, reorder, or summarize it here — update this
    // block only by copying the spec's text again if it ever changes.
    const feedbackDisclosure = document.createElement("div");
    feedbackDisclosure.className = "feedback-disclosure";

    const discTitle = document.createElement("p");
    discTitle.textContent = "Here's exactly what this form sends when you press Send:";
    feedbackDisclosure.appendChild(discTitle);

    const discList = document.createElement("ul");

    // Each area collapses into its own <details>/<summary> — same
    // construction technique as buildProjectPlanTaskCard's collapsible
    // detail block (createElement, className set, summary created and
    // appended BEFORE the body content, no `open` attribute so it defaults
    // closed). Mirroring that order avoids a known webview quirk where a
    // closed <details> built a different way renders wrong. The verbatim
    // disclosure text from docs/FEEDBACK-PIPELINE-SPEC.md §7 moves into the
    // details body unchanged — only the one-line <summary> is new copy.

    const discLi1 = document.createElement("li");
    const discDetails1 = document.createElement("details");
    discDetails1.className = "feedback-disclosure-details";
    const discSummary1 = document.createElement("summary");
    discSummary1.textContent = "Your description and contact info are sent, with secrets automatically removed.";
    discDetails1.appendChild(discSummary1);
    const discBody1 = document.createElement("p");
    discBody1.textContent = "Your description and (if you add one) your contact info, exactly as you typed them — local file paths and recognizable API keys or tokens are automatically removed before anything is sent.";
    discDetails1.appendChild(discBody1);
    discLi1.appendChild(discDetails1);
    discList.appendChild(discLi1);

    const discLi2 = document.createElement("li");
    const discDetails2 = document.createElement("details");
    discDetails2.className = "feedback-disclosure-details";
    const discSummary2 = document.createElement("summary");
    discSummary2.textContent = "Six additional setup details are sent if you include diagnostics.";
    discDetails2.appendChild(discSummary2);
    const discBody2 = document.createElement("p");
    discBody2.textContent = "If \"Include diagnostic report\" is checked, it also sends:";
    discDetails2.appendChild(discBody2);
    const discSubList = document.createElement("ul");
    [
      "Your extension version, operating system, IDE name and variant, and when the report was generated",
      "Whether the background hook is installed, whether it's working, and when it last ran",
      "Your delegation settings",
      "A list of your agent names and whether each one has routing configured",
      "Whether your project's instructions file (CLAUDE.md) has any leftover sections from an older format",
      "A size check of your instructions and agent files (so we can tell if they're getting too long)",
      "The connection status of any configured engines (like UEFN). For MCP servers, only which ones are configured — not their connection status",
    ].forEach((t) => {
      const sub = document.createElement("li");
      sub.textContent = t;
      discSubList.appendChild(sub);
    });
    discDetails2.appendChild(discSubList);
    discLi2.appendChild(discDetails2);
    discList.appendChild(discLi2);

    const discLi3 = document.createElement("li");
    const discDetails3 = document.createElement("details");
    discDetails3.className = "feedback-disclosure-details";
    const discSummary3 = document.createElement("summary");
    discSummary3.textContent = "What's never sent: your code, files, project names, or API keys.";
    discDetails3.appendChild(discSummary3);
    const discBody3 = document.createElement("p");
    const discNeverStrong = document.createElement("strong");
    discNeverStrong.textContent = "What's never sent:";
    discBody3.appendChild(discNeverStrong);
    discBody3.appendChild(document.createTextNode(" your source code, file contents, project names (only redacted paths), API keys (they're removed), or anything running in the background. Nothing leaves your machine until you press Send — and you'll see the exact data being sent right before that happens. Separately: theme prompts and generated images go to the Corsair Theme Service only when you generate a theme — never when you upload or hand-make one — and the extension holds no image-provider API key of yours."));
    discDetails3.appendChild(discBody3);
    discLi3.appendChild(discDetails3);
    discList.appendChild(discLi3);

    feedbackDisclosure.appendChild(discList);
    feedbackSection.appendChild(feedbackDisclosure);

    // Category
    const feedbackCatRow = document.createElement("div");
    feedbackCatRow.className = "settings-row feedback-field";
    const feedbackCatLabel = document.createElement("label");
    feedbackCatLabel.textContent = "Category";
    feedbackCatLabel.setAttribute("for", "feedback-category");
    feedbackCatRow.appendChild(feedbackCatLabel);
    feedbackCategoryEl = document.createElement("select");
    feedbackCategoryEl.id = "feedback-category";
    [["bug", "Bug"], ["idea", "Idea"], ["question", "Question"], ["other", "Other"]].forEach(([v, l]) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = l;
      feedbackCategoryEl.appendChild(opt);
    });
    feedbackCatRow.appendChild(feedbackCategoryEl);
    feedbackSection.appendChild(feedbackCatRow);

    // Description
    const feedbackDescRow = document.createElement("div");
    feedbackDescRow.className = "settings-row feedback-field";
    const feedbackDescLabel = document.createElement("label");
    feedbackDescLabel.textContent = "Description";
    feedbackDescLabel.setAttribute("for", "feedback-description");
    feedbackDescRow.appendChild(feedbackDescLabel);
    feedbackDescEl = document.createElement("textarea");
    feedbackDescEl.id = "feedback-description";
    feedbackDescEl.rows = 5;
    feedbackDescEl.maxLength = 4000;
    feedbackDescEl.placeholder = "What happened, or what would you like to see?";
    feedbackDescRow.appendChild(feedbackDescEl);
    feedbackCharCounterEl = document.createElement("span");
    feedbackCharCounterEl.className = "feedback-char-counter";
    feedbackDescRow.appendChild(feedbackCharCounterEl);
    feedbackDescEl.addEventListener("input", updateFeedbackCharCounter);
    feedbackSection.appendChild(feedbackDescRow);

    // Include diagnostics (default checked)
    const feedbackDiagRow = document.createElement("label");
    feedbackDiagRow.className = "feedback-checkbox-row";
    feedbackDiagCheckbox = document.createElement("input");
    feedbackDiagCheckbox.type = "checkbox";
    feedbackDiagCheckbox.checked = true;
    feedbackDiagRow.appendChild(feedbackDiagCheckbox);
    feedbackDiagRow.appendChild(document.createTextNode("Include diagnostic report"));
    feedbackSection.appendChild(feedbackDiagRow);

    // Contact (optional)
    const feedbackContactRow = document.createElement("div");
    feedbackContactRow.className = "settings-row feedback-field";
    const feedbackContactLabel = document.createElement("label");
    feedbackContactLabel.textContent = "Contact (optional)";
    feedbackContactLabel.setAttribute("for", "feedback-contact");
    feedbackContactRow.appendChild(feedbackContactLabel);
    feedbackContactEl = document.createElement("input");
    feedbackContactEl.type = "text";
    feedbackContactEl.id = "feedback-contact";
    feedbackContactEl.maxLength = 500;
    feedbackContactEl.placeholder = "Email or Discord handle, if you'd like a reply";
    feedbackContactRow.appendChild(feedbackContactEl);
    feedbackSection.appendChild(feedbackContactRow);

    feedbackFormStatusEl = document.createElement("p");
    feedbackFormStatusEl.className = "feedback-status";
    feedbackSection.appendChild(feedbackFormStatusEl);

    feedbackPreviewBtn = document.createElement("button");
    feedbackPreviewBtn.className = "skill-btn settings-btn";
    feedbackPreviewBtn.textContent = "Preview";
    feedbackPreviewBtn.disabled = true; // gated on non-empty description by updateFeedbackCharCounter
    feedbackPreviewBtn.addEventListener("click", requestFeedbackPreview);
    feedbackSection.appendChild(feedbackPreviewBtn);

    // Preview step (hidden until the host replies with feedbackPreview).
    // The Send action does not exist/isn't reachable until this is shown.
    feedbackPreviewSection = document.createElement("div");
    feedbackPreviewSection.className = "feedback-preview";
    feedbackPreviewSection.setAttribute("hidden", "");

    const feedbackPreviewHeading = document.createElement("p");
    feedbackPreviewHeading.className = "settings-empty";
    feedbackPreviewHeading.textContent = "Nothing has been sent yet — this is the exact JSON that will be POSTed if you press Send.";
    feedbackPreviewSection.appendChild(feedbackPreviewHeading);

    feedbackPreviewTicketEl = document.createElement("p");
    feedbackPreviewTicketEl.className = "settings-empty";
    feedbackPreviewSection.appendChild(feedbackPreviewTicketEl);

    feedbackPreviewJsonEl = document.createElement("pre");
    feedbackPreviewJsonEl.className = "feedback-preview-json";
    feedbackPreviewJsonEl.tabIndex = 0;
    feedbackPreviewSection.appendChild(feedbackPreviewJsonEl);

    const feedbackPreviewActions = document.createElement("div");
    feedbackPreviewActions.className = "feedback-preview-actions";

    feedbackSendBtn = document.createElement("button");
    feedbackSendBtn.className = "skill-btn settings-btn";
    feedbackSendBtn.textContent = "Send";
    feedbackSendBtn.addEventListener("click", sendFeedbackConfirmed);
    feedbackPreviewActions.appendChild(feedbackSendBtn);

    feedbackBackBtn = document.createElement("button");
    feedbackBackBtn.className = "skill-btn settings-btn";
    feedbackBackBtn.textContent = "Back to edit";
    feedbackBackBtn.addEventListener("click", cancelFeedbackPreview);
    feedbackPreviewActions.appendChild(feedbackBackBtn);

    feedbackPreviewSection.appendChild(feedbackPreviewActions);
    feedbackSection.appendChild(feedbackPreviewSection);

    feedbackResultEl = document.createElement("p");
    feedbackResultEl.className = "feedback-status";
    feedbackSection.appendChild(feedbackResultEl);

    bodyEl.appendChild(feedbackSection);
    updateFeedbackCharCounter();
  }

  // ── Routing panel (plan p13-t1, webview half) ───────────────────────────
  // Wire strings mirror src/host/vscode/messages.ts's routing block byte-for-
  // byte, the same way every other handler in this file matches messages.ts
  // literals by hand (main.js has no MSG constant object of its own to
  // import from — see the `settings`/`getSettings` pair above for the
  // existing pattern this follows).
  var ROUTING_MSG = {
    GET: "getRouting",
    ROUTING: "routing",
    SAVE: "saveRouting",
    SAVED: "routingSaved",
    CLEAR: "clearRouting",
    PROBE: "probeEnv",
    PROBE_REPLY: "envProbe",
    SET_LOCAL: "setLocalEnvValue",
    CLEAR_LOCAL: "clearLocalEnvValue",
  };

  // p68-t2: mirrors MSG.GET_KEYWORD_HEALTH / KEYWORD_HEALTH / KEYWORD_HEALTH_FIX
  // in src/host/vscode/messages.ts.
  var KEYWORD_HEALTH_MSG = {
    GET: "GET_KEYWORD_HEALTH",
    HEALTH: "KEYWORD_HEALTH",
    FIX: "KEYWORD_HEALTH_FIX",
  };

  var ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
  var SLOT_SCALAR_FIELDS = ["vendor", "transport", "mcpServer", "model", "costModelClass", "endpointEnv", "credentialEnv", "useDefaultFallback"];

  var lastRoutingPayload = null; // last "routing" push from host: { profile, path, errors, orchestrator, agents, envProbe, presets, lastApplied }

  // p68-t2: last "KEYWORD_HEALTH" push from host: { findings, wildcardTasksThisSession, unmatchedWords }
  var lastKeywordHealth = null;
  // Which agent a given unmatched-word chip's "add to <agent>" picker is
  // currently open for (chip token -> true), so re-renders keep the picker
  // expanded across unrelated state changes.
  var keywordHealthOpenPickerToken = null;
  var routingDraft = null;       // working copy: { orchestrator: slot|null, agents: { [id]: slot } }
  var routingEnvProbe = {};      // merged env-var name -> {env: boolean, stored: boolean} cache, seeded from payload.envProbe + envProbe replies
  var routingSaving = false;
  // Set by handleRoutingSaved when the host reports ok:false. The server
  // always follows a saveRouting/clearRouting reply with a fresh "routing"
  // push reflecting on-disk state — on a failed save that state is
  // unchanged, and rebuilding routingDraft from it would silently discard
  // every field the user just typed with no visible error. Consumed
  // (cleared) by the next handleRoutingPayload call so it only suppresses
  // that one immediate post-failure push, not every future one.
  var routingSuppressNextRebuild = false;
  var routingLastResult = null;  // last routingSaved payload, for the collapsed check/write output block
  var routingModalEl = null, routingBackdropEl = null, routingCloseBtnEl = null, routingBodyEl = null, routingContentEl = null;
  var routingSaveBtnEl = null, routingRevertBtnEl = null, routingClearBtnEl = null, routingFooterCloseBtnEl = null;
  // Agent ids the user has explicitly expanded via "Override" (p17-t3) —
  // a provenance:"default" agent card renders collapsed until its id is in
  // here. Reset whenever routingDraft is rebuilt from a fresh payload (see
  // handleRoutingPayload) so a reload doesn't leave stale expansions.
  var routingExpandedAgents = {};
  // Agent id -> the resolved-default slot (RoutingSlot shape, uncleaned) an
  // Override started from, for provenance:"default" agents only. Used by
  // assembleRoutingProfile to emit a sparse per-agent entry (only the
  // fields the user actually changed) instead of the full resolved backend
  // (coordinator review fix, p17-t3). Rebuilt in buildRoutingDraft; entries
  // for expanded agents are carried across a live rebuild in
  // handleRoutingPayload the same way routingDraft.agents[id] is.
  var routingDefaultBaseline = {};

  function cloneSlotFromBackend(backend) {
    if (!backend) return {};
    var slot = { vendor: backend.vendor, transport: backend.transport, model: backend.model, costModelClass: backend.costModelClass };
    if (backend.mcpServer) slot.mcpServer = backend.mcpServer;
    if (Array.isArray(backend.tools) && backend.tools.length) slot.tools = backend.tools.slice();
    if (backend.endpointEnv) slot.endpointEnv = backend.endpointEnv;
    if (backend.apiKeyEnv) slot.credentialEnv = backend.apiKeyEnv; // Backend.apiKeyEnv -> RoutingSlot.credentialEnv
    return slot;
  }

  /** Deep-copy a RoutingSlot (or slot-shaped object) including its fallback chain, dropping empty string fields. */
  function cloneRoutingSlot(slot) {
    if (!slot) return {};
    var out = {};
    SLOT_SCALAR_FIELDS.forEach(function (k) {
      if (slot[k] !== undefined && slot[k] !== "") out[k] = slot[k];
    });
    if (Array.isArray(slot.tools) && slot.tools.length) out.tools = slot.tools.slice();
    out.fallback = Array.isArray(slot.fallback) ? slot.fallback.slice(0, 3).map(cloneRoutingSlot) : [];
    return out;
  }

  /**
   * Strip empty/undefined fields + empty fallback arrays for the outgoing
   * profile. Never a key that looks like a secret — only env var NAMES ever
   * land here.
   *
   * `notes` (optional array) collects human-readable strings describing any
   * corrective coercion this call performed, so a caller can surface them
   * (e.g. as a tooltip on the "will be written" marker) without re-deriving
   * the same check.
   */
  function cleanRoutingSlot(slot, notes, presetVendors) {
    if (!slot) return undefined;
    var out = {};
    SLOT_SCALAR_FIELDS.forEach(function (k) {
      if (slot[k] !== undefined && slot[k] !== null && slot[k] !== "") out[k] = slot[k];
    });
    // Guard against a stray/inherited transport "openai-compatible" on a
    // *known preset* vendor (e.g. "opencode") with no endpoint env
    // configured. That combination can't produce a real openai-compatible
    // connection and would make the generator emit a bogus provider block
    // for a vendor that was never actually configured as a custom
    // OpenAI-compatible endpoint — see the vendor-select change handler in
    // buildSlotEditorFields for the corresponding UI-side fix that prevents
    // this going forward. Coerce rather than reject so an already-saved
    // profile self-heals on next save instead of hard-failing. Gated on
    // `presetVendors` (payload.presets.vendors) rather than "not literally
    // ROUTING_VENDOR_CUSTOM" — once the user types a real Custom-endpoint
    // provider name (e.g. "ollama-windows"), slot.vendor holds that typed
    // name, not the ROUTING_VENDOR_CUSTOM sentinel, and that legitimate
    // custom endpoint must NOT be coerced just because endpointEnv hasn't
    // been filled in yet.
    if (
      out.transport === "openai-compatible" &&
      out.vendor &&
      Array.isArray(presetVendors) &&
      presetVendors.indexOf(out.vendor) !== -1 &&
      !out.endpointEnv
    ) {
      out.transport = "claude-native";
      if (Array.isArray(notes)) {
        notes.push('transport reset to claude-native — "openai-compatible" on vendor "' + out.vendor + '" had no endpoint env set');
      }
    }
    // For custom/openai-compatible vendors the field editor collects a bare
    // model id (e.g. "qwen3.6:latest") since the vendor is already selected
    // separately — but the generators (and the routing.json schema) expect
    // "provider/model" form. Assemble it here, once, at the outgoing edge,
    // rather than mutating slot.model while the user is still editing (that
    // would break the "display bare text" round-trip in buildSlotEditorFields
    // below). A model that already contains "/" (loaded from an existing
    // profile, untouched) is left as-is.
    if (out.transport === "openai-compatible" && out.model && out.vendor && out.model.indexOf("/") === -1) {
      out.model = out.vendor + "/" + out.model;
    }
    if (Array.isArray(slot.tools) && slot.tools.length) out.tools = slot.tools.slice();
    if (Array.isArray(slot.fallback) && slot.fallback.length) {
      var fb = slot.fallback.slice(0, 3).map(function (fbSlot) { return cleanRoutingSlot(fbSlot, notes, presetVendors); }).filter(Boolean);
      if (fb.length) out.fallback = fb;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** Build the editable working copy from a fresh "routing" payload. */
  function buildRoutingDraft(payload) {
    var draft = { orchestrator: null, agents: {}, defaults: {} };
    var profile = payload && payload.profile;
    if (payload && payload.orchestrator) {
      draft.orchestrator = cloneRoutingSlot((profile && profile.orchestrator) || cloneSlotFromBackend(payload.orchestrator.backend));
    }
    // Top-level `defaults` slot (p17-t3) — same shape as an agent slot, no
    // fallback-to-a-resolved-backend the way orchestrator/agents get, since
    // there is no "effective backend" for defaults on its own: an empty
    // object just means no defaults are configured yet.
    draft.defaults = cloneRoutingSlot((payload && payload.defaults) || {});
    routingDefaultBaseline = {};
    var agents = (payload && payload.agents) || [];
    agents.forEach(function (a) {
      var existing = profile && profile.agents && profile.agents[a.id];
      draft.agents[a.id] = cloneRoutingSlot(existing || cloneSlotFromBackend(a.backend));
      if (a.provenance === "default") {
        // Baseline = the resolved-default slot itself, uncleaned — diffed
        // against the (also uncleaned-until-save) draft slot in
        // assembleRoutingProfile so an Override that only touched `model`
        // saves just `{ model }`.
        routingDefaultBaseline[a.id] = cloneRoutingSlot(cloneSlotFromBackend(a.backend));
      }
    });
    return draft;
  }

  /**
   * Sparse per-agent entry for a provenance:"default" agent (coordinator
   * review fix, p17-t3): only fields where the fully-cleaned draft slot
   * differs from the fully-cleaned baseline (the resolved-default slot the
   * Override started from) are emitted — a model-only edit saves
   * `{ model: "..." }`, not the full resolved backend. Returns undefined
   * when nothing differs (Override was opened and closed with no edit).
   */
  function diffSlotFromDefaultBaseline(slot, baseline, presetVendors) {
    var full = cleanRoutingSlot(slot, undefined, presetVendors);
    if (!full) return undefined;
    var base = cleanRoutingSlot(baseline, undefined, presetVendors) || {};
    var out = {};
    SLOT_SCALAR_FIELDS.forEach(function (k) {
      if (full[k] !== undefined && full[k] !== base[k]) out[k] = full[k];
    });
    if (Array.isArray(full.tools) && full.tools.length && JSON.stringify(full.tools) !== JSON.stringify(base.tools || [])) {
      out.tools = full.tools;
    }
    var fFallback = Array.isArray(full.fallback) ? full.fallback : [];
    var bFallback = Array.isArray(base.fallback) ? base.fallback : [];
    if (fFallback.length && JSON.stringify(fFallback) !== JSON.stringify(bFallback)) {
      out.fallback = fFallback;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** True when a cloned/cleaned RoutingSlot carries any actual field (p17-t3). */
  function slotHasContent(slot) {
    if (!slot) return false;
    for (var i = 0; i < SLOT_SCALAR_FIELDS.length; i++) {
      if (slot[SLOT_SCALAR_FIELDS[i]]) return true;
    }
    return Array.isArray(slot.fallback) && slot.fallback.length > 0;
  }

  function sanitizeEnvName(raw) {
    return String(raw || "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  }

  /**
   * Normalize one envProbe cache entry. The host now replies with
   * {env: boolean, stored: boolean} (env set in the process's real
   * environment vs. a value stored locally on this machine by
   * setLocalEnvValue). A bare boolean (older host build, or a defensive
   * fallback) is treated as {env: bool, stored: false}.
   */
  function normalizeEnvProbeEntry(v) {
    if (v && typeof v === "object") return { env: !!v.env, stored: !!v.stored };
    return { env: !!v, stored: false };
  }

  /** Re-render the status area (dot + Set value/Clear buttons) of every
   * .routing-env-field currently in the DOM for this env var name. */
  function updateRoutingEnvDots(name) {
    document.querySelectorAll('.routing-env-field[data-env-name="' + name.replace(/"/g, '\\"') + '"]').forEach(function (wrap) {
      var area = wrap.querySelector(".routing-env-status");
      if (area) refreshEnvStatusArea(area, name, wrap.getAttribute("data-env-kind") || "credential");
    });
  }

  function probeEnvName(name) {
    if (!name || !ENV_NAME_RE.test(name)) return;
    vscode.postMessage({ type: ROUTING_MSG.PROBE, names: [name] });
  }

  /**
   * Build/refresh the dot + "Set value…"/"Clear stored value" controls for
   * one env var name. Rebuilt from scratch on every call (cheap — a handful
   * of nodes) so it always reflects the current routingEnvProbe cache.
   */
  function refreshEnvStatusArea(area, name, kind) {
    area.innerHTML = "";
    var known = !!(name && Object.prototype.hasOwnProperty.call(routingEnvProbe, name));
    var state = known ? routingEnvProbe[name] : { env: false, stored: false };

    var dot = document.createElement("span");
    var dotClass, dotTitle;
    if (!name || !known) {
      dotClass = "routing-env-dot--unknown";
      dotTitle = name ? name + " not probed yet" : "enter an env var name";
    } else if (state.env) {
      dotClass = "routing-env-dot--set";
      dotTitle = "set in environment";
    } else if (state.stored) {
      dotClass = "routing-env-dot--stored";
      dotTitle = "stored locally on this machine";
    } else {
      dotClass = "routing-env-dot--unset";
      dotTitle = "not set";
    }
    dot.className = "routing-env-dot " + dotClass;
    dot.title = dotTitle;
    dot.setAttribute("data-env-name", name || "");
    area.appendChild(dot);

    var validName = !!(name && ENV_NAME_RE.test(name));

    var setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "routing-inline-link-btn routing-set-value-btn";
    setBtn.textContent = "Set value…";
    setBtn.disabled = !validName;
    setBtn.addEventListener("click", function () {
      openSetValueInline(area, name, kind);
    });
    area.appendChild(setBtn);

    if (state.stored) {
      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "routing-inline-link-btn routing-inline-link-btn--danger routing-clear-value-btn";
      clearBtn.textContent = "Clear stored value";
      clearBtn.addEventListener("click", function () {
        vscode.postMessage({ type: ROUTING_MSG.CLEAR_LOCAL, name: name });
      });
      area.appendChild(clearBtn);
    }
  }

  /**
   * Open (or close, if already open) an inline Save/Cancel value editor next
   * to the Set value… button. The typed value never touches a JS variable
   * beyond the single postMessage call — it's read straight off the input
   * and the input is cleared/removed immediately after posting, so it never
   * lingers in the DOM or in memory.
   */
  function openSetValueInline(area, name, kind) {
    var existing = area.querySelector(".routing-set-value-inline");
    if (existing) {
      existing.remove();
      return;
    }
    var inline = document.createElement("span");
    inline.className = "routing-set-value-inline";

    var input = document.createElement("input");
    input.type = kind === "credential" ? "password" : "text";
    input.className = "routing-set-value-input";
    input.placeholder = kind === "credential" ? "value" : "https://…";
    inline.appendChild(input);

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "routing-inline-link-btn";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", function () {
      vscode.postMessage({ type: ROUTING_MSG.SET_LOCAL, name: name, value: input.value });
      input.value = "";
      inline.remove();
    });
    inline.appendChild(saveBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "routing-inline-link-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () {
      input.value = "";
      inline.remove();
    });
    inline.appendChild(cancelBtn);

    area.appendChild(inline);
    input.focus();
  }

  /** An env-var name input (never a value) + its live status/Set-value controls.
   * `kind` is "credential" (password-type Set value input) or "endpoint"
   * (plain text — a URL is not a secret). */
  function buildEnvNameField(labelText, value, onChange, kind, fieldKey) {
    var wrap = document.createElement("div");
    wrap.className = "routing-env-field";
    wrap.setAttribute("data-env-name", value || "");
    wrap.setAttribute("data-env-kind", kind || "credential");
    var label = document.createElement("label");
    label.textContent = labelText;
    wrap.appendChild(label);
    var input = document.createElement("input");
    input.type = "text";
    input.className = "routing-env-input";
    input.value = value || "";
    input.placeholder = "env var NAME, never the value";
    if (fieldKey) input.setAttribute("data-field-key", fieldKey);
    wrap.appendChild(input);

    var statusArea = document.createElement("span");
    statusArea.className = "routing-env-status";
    wrap.appendChild(statusArea);
    refreshEnvStatusArea(statusArea, value, kind);

    input.addEventListener("input", function () {
      var clean = sanitizeEnvName(input.value);
      if (clean !== input.value) input.value = clean;
      onChange(clean);
      wrap.setAttribute("data-env-name", clean);
      refreshEnvStatusArea(statusArea, clean, kind);
    });
    input.addEventListener("blur", function () {
      if (input.value) probeEnvName(input.value);
    });
    return wrap;
  }

  var ROUTING_VENDOR_CUSTOM = "custom-endpoint";

  /**
   * Render the editor for one RoutingSlot (orchestrator, an agent row, or a
   * fallback entry). `opts.presets` is payload.presets. `onStructural` is
   * called (with no args) when a change should re-render the whole modal
   * (vendor/transport switches, which change which fields are visible);
   * scalar edits mutate `slot` in place with no re-render.
   *
   * `fieldKeyPrefix` (e.g. "orchestrator", "agent:coding-specialist",
   * "agent:coding-specialist.fallback[0]") tags each interactive field with
   * a stable `data-field-key` attribute so renderRoutingModal can restore
   * focus/selection across a full rebuild (see the focus-preservation note
   * on renderRoutingModal).
   */
