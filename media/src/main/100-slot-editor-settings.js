// Part: 100-slot-editor-settings
// Slot editor field builders and settings screen wiring.
  function buildSlotEditorFields(slot, presets, onStructural, fieldKeyPrefix) {
    var keyPrefix = fieldKeyPrefix || "";
    var frag = document.createElement("div");
    frag.className = "routing-slot-fields";

    // Vendor (+ the "Custom endpoint" preset)
    var vendorRow = document.createElement("div");
    vendorRow.className = "routing-field-row";
    var vendorLabel = document.createElement("label");
    vendorLabel.textContent = "Vendor";
    vendorRow.appendChild(vendorLabel);
    var vendorSel = document.createElement("select");
    vendorSel.className = "routing-vendor-select";
    vendorSel.setAttribute("data-field-key", keyPrefix + ".vendor");
    var vendorOptions = (presets && presets.vendors) || [];
    [""].concat(vendorOptions).forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v || "(none)";
      if (v === slot.vendor) opt.selected = true;
      vendorSel.appendChild(opt);
    });
    var isCustom = !!slot.vendor && vendorOptions.indexOf(slot.vendor) === -1;

    var customOpt = document.createElement("option");
    customOpt.value = ROUTING_VENDOR_CUSTOM;
    customOpt.textContent = "Custom endpoint…";
    if (isCustom) customOpt.selected = true;
    vendorSel.appendChild(customOpt);
    vendorSel.addEventListener("change", function () {
      slot.vendor = vendorSel.value;
      if (vendorSel.value === ROUTING_VENDOR_CUSTOM) {
        slot.transport = "openai-compatible";
      } else if (!(slot.transport === "mcp" && slot.mcpServer)) {
        // Switching to any non-custom preset vendor (e.g. away from Custom
        // endpoint, or between presets) resets transport to claude-native
        // rather than leaving behind a stale value from whatever vendor was
        // selected before — a leftover "openai-compatible" on a preset
        // vendor with no endpoint env would emit a bogus provider block for
        // it (see cleanRoutingSlot's matching save-time coercion). An
        // existing mcp slot that already names an mcpServer is preserved,
        // since that's a deliberate, valid combination for any vendor.
        slot.transport = "claude-native";
      }
      onStructural();
    });
    vendorRow.appendChild(vendorSel);
    frag.appendChild(vendorRow);

    if (isCustom) {
      var nameRow = document.createElement("div");
      nameRow.className = "routing-field-row";
      var nameLabel = document.createElement("label");
      nameLabel.textContent = "Provider name";
      nameRow.appendChild(nameLabel);
      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "routing-vendor-name-input";
      nameInput.setAttribute("data-field-key", keyPrefix + ".vendorName");
      nameInput.placeholder = "e.g. ollama-windows";
      nameInput.value = slot.vendor === ROUTING_VENDOR_CUSTOM ? "" : slot.vendor;
      nameInput.addEventListener("input", function () {
        var clean = nameInput.value.toLowerCase().replace(/[^a-z0-9_.-]/g, "");
        if (clean !== nameInput.value) nameInput.value = clean;
        slot.vendor = clean || ROUTING_VENDOR_CUSTOM;
      });
      nameInput.addEventListener("blur", function () {
        if (!nameInput.value) {
          nameInput.value = ROUTING_VENDOR_CUSTOM;
          slot.vendor = ROUTING_VENDOR_CUSTOM;
        }
      });
      nameRow.appendChild(nameInput);
      frag.appendChild(nameRow);
    }

    // Model: preset select-with-free-text, or a bare free-text input for Custom endpoint.
    var modelRow = document.createElement("div");
    // Full row width, always — a model id (e.g. "anthropic/claude-sonnet-
    // 4-6") is the field most likely to overflow a shared 2-col grid cell;
    // sharing a row with Vendor is what truncated it (item 3 cleanup).
    modelRow.className = "routing-field-row routing-field-row--full";
    var modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    modelRow.appendChild(modelLabel);
    var models = ((presets && presets.models) || []).filter(function (m) {
      return !slot.vendor || slot.vendor === ROUTING_VENDOR_CUSTOM || m.vendor === slot.vendor;
    });
    var matchesPreset = models.some(function (m) { return m.id === slot.model; });
    // Free-text branch: Custom-endpoint vendor, an unrecognized non-empty
    // model, OR the preset select's own "Custom…" option was just picked
    // (slot._modelCustomEdit, set below) — that pick clears slot.model to ""
    // specifically to open this branch, and gating on `slot.model` being
    // truthy alone used to send that case straight back into the preset
    // SELECT branch instead (the "Custom…" pick silently failed to open the
    // free-text field for a non-custom vendor with no model chosen yet).
    if (isCustom || (!matchesPreset && (slot.model || slot._modelCustomEdit))) {
      var modelInput = document.createElement("input");
      modelInput.type = "text";
      modelInput.className = "routing-model-input";
      modelInput.setAttribute("data-field-key", keyPrefix + ".model");
      modelInput.placeholder = "model id";
      // For an openai-compatible/custom vendor, the stored model may already
      // carry a "vendor/" prefix (assembled at save time — see
      // cleanRoutingSlot) from a previously-saved profile; show the bare
      // text here so re-editing doesn't force the user to retype/strip it,
      // and so a no-op edit round-trips byte-identically.
      var displayModel = slot.model || "";
      if (slot.vendor && displayModel.indexOf(slot.vendor + "/") === 0) {
        displayModel = displayModel.slice(slot.vendor.length + 1);
      }
      modelInput.value = displayModel;
      modelInput.addEventListener("input", function () { slot.model = modelInput.value; });
      modelRow.appendChild(modelInput);
      if (!isCustom) {
        var backToPreset = document.createElement("button");
        backToPreset.type = "button";
        backToPreset.className = "routing-inline-link-btn";
        backToPreset.textContent = "Choose from list";
        backToPreset.addEventListener("click", function () { slot.model = ""; slot._modelCustomEdit = false; onStructural(); });
        modelRow.appendChild(backToPreset);
      }
    } else {
      var modelSel = document.createElement("select");
      modelSel.className = "routing-model-select";
      modelSel.setAttribute("data-field-key", keyPrefix + ".model");
      var blankOpt = document.createElement("option");
      blankOpt.value = "";
      blankOpt.textContent = "(none)";
      if (!slot.model) blankOpt.selected = true;
      modelSel.appendChild(blankOpt);
      models.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        if (m.id === slot.model) opt.selected = true;
        modelSel.appendChild(opt);
      });
      var customModelOpt = document.createElement("option");
      customModelOpt.value = "__custom__";
      customModelOpt.textContent = "Custom…";
      modelSel.appendChild(customModelOpt);
      modelSel.addEventListener("change", function () {
        if (modelSel.value === "__custom__") { slot.model = ""; slot._modelCustomEdit = true; onStructural(); return; }
        slot.model = modelSel.value;
        var pickedPreset = models.filter(function (m) { return m.id === modelSel.value; })[0];
        if (pickedPreset && pickedPreset.costModelClass && costSel) {
          slot.costModelClass = pickedPreset.costModelClass;
          costSel.value = pickedPreset.costModelClass;
        }
      });
      modelRow.appendChild(modelSel);
    }
    frag.appendChild(modelRow);

    // Transport
    var transportRow = document.createElement("div");
    transportRow.className = "routing-field-row";
    var transportLabel = document.createElement("label");
    transportLabel.textContent = "Transport";
    transportRow.appendChild(transportLabel);
    var transportSel = document.createElement("select");
    transportSel.setAttribute("data-field-key", keyPrefix + ".transport");
    transportSel.disabled = isCustom; // Custom endpoint forces openai-compatible.
    ["claude-native", "mcp", "openai-compatible"].forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      if (t === slot.transport) opt.selected = true;
      transportSel.appendChild(opt);
    });
    transportSel.addEventListener("change", function () { slot.transport = transportSel.value; onStructural(); });
    transportRow.appendChild(transportSel);
    frag.appendChild(transportRow);

    // Cost model class
    var costRow = document.createElement("div");
    costRow.className = "routing-field-row";
    var costLabel = document.createElement("label");
    costLabel.textContent = "Cost class";
    costRow.appendChild(costLabel);
    var costSel = document.createElement("select");
    costSel.setAttribute("data-field-key", keyPrefix + ".costModelClass");
    ["metered", "subscription", "local"].forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c;
      opt.textContent = costClassLabel(c);
      if (c === slot.costModelClass) opt.selected = true;
      costSel.appendChild(opt);
    });
    costSel.addEventListener("change", function () { slot.costModelClass = costSel.value; });
    costRow.appendChild(costSel);
    frag.appendChild(costRow);

    // Endpoint + credential env. For openai-compatible / Custom endpoint,
    // endpoint comes first and both fields carry connection-specific labels;
    // other transports only need the credential field.
    if (slot.transport === "openai-compatible" || isCustom) {
      frag.appendChild(buildEnvNameField("Endpoint URL env", slot.endpointEnv, function (v) { slot.endpointEnv = v; }, "endpoint", keyPrefix + ".endpointEnv"));
      frag.appendChild(buildEnvNameField("API key env", slot.credentialEnv, function (v) { slot.credentialEnv = v; }, "credential", keyPrefix + ".credentialEnv"));
    } else {
      frag.appendChild(buildEnvNameField("Credential env", slot.credentialEnv, function (v) { slot.credentialEnv = v; }, "credential", keyPrefix + ".credentialEnv"));
    }

    var envNote = document.createElement("div");
    envNote.className = "routing-env-note";
    envNote.textContent = "Names here; the values are stored per user in the TycoonAgents app-data folder, never in this project.";
    frag.appendChild(envNote);

    if (slot.transport === "mcp") {
      var mcpRow = document.createElement("div");
      mcpRow.className = "routing-field-row";
      var mcpLabel = document.createElement("label");
      mcpLabel.textContent = "MCP server";
      mcpRow.appendChild(mcpLabel);
      var mcpInput = document.createElement("input");
      mcpInput.type = "text";
      mcpInput.setAttribute("data-field-key", keyPrefix + ".mcpServer");
      mcpInput.value = slot.mcpServer || "";
      mcpInput.addEventListener("input", function () { slot.mcpServer = mcpInput.value; });
      mcpRow.appendChild(mcpInput);
      frag.appendChild(mcpRow);
    }

    return frag;
  }

  /**
   * Fallback chain editor: up to 3 entries, add/remove/reorder.
   * `agentKey` ("orchestrator" or an agent id) tags the <details> with
   * `data-agent-id` so renderRoutingModal can find it again after a rebuild
   * and restore whether it was open. `fieldKeyPrefix` is the same prefix
   * buildSlotEditorFields uses for this slot, used to build each fallback
   * entry's own field keys.
   */
  function buildFallbackEditor(slot, presets, onStructural, agentKey, fieldKeyPrefix) {
    if (!Array.isArray(slot.fallback)) slot.fallback = [];
    var keyPrefix = fieldKeyPrefix || "";
    var details = document.createElement("details");
    details.className = "plan-task-details routing-fallback-details";
    details.setAttribute("data-agent-id", agentKey || "orchestrator");
    var summary = document.createElement("summary");
    summary.textContent = "Fallback chain (" + slot.fallback.length + ")";
    details.appendChild(summary);

    var list = document.createElement("div");
    list.className = "routing-fallback-list";
    slot.fallback.forEach(function (fbSlot, idx) {
      var item = document.createElement("div");
      item.className = "routing-fallback-item";
      var head = document.createElement("div");
      head.className = "routing-fallback-item-head";
      var title = document.createElement("span");
      title.textContent = "Fallback #" + (idx + 1);
      head.appendChild(title);

      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "routing-inline-link-btn";
      upBtn.textContent = "↑";
      upBtn.disabled = idx === 0;
      upBtn.addEventListener("click", function () {
        var tmp = slot.fallback[idx - 1];
        slot.fallback[idx - 1] = slot.fallback[idx];
        slot.fallback[idx] = tmp;
        onStructural();
      });
      head.appendChild(upBtn);

      var downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "routing-inline-link-btn";
      downBtn.textContent = "↓";
      downBtn.disabled = idx === slot.fallback.length - 1;
      downBtn.addEventListener("click", function () {
        var tmp = slot.fallback[idx + 1];
        slot.fallback[idx + 1] = slot.fallback[idx];
        slot.fallback[idx] = tmp;
        onStructural();
      });
      head.appendChild(downBtn);

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "routing-inline-link-btn routing-inline-link-btn--danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", function () {
        slot.fallback.splice(idx, 1);
        onStructural();
      });
      head.appendChild(removeBtn);

      item.appendChild(head);
      item.appendChild(buildSlotEditorFields(fbSlot, presets, onStructural, keyPrefix + ".fallback[" + idx + "]"));
      list.appendChild(item);
    });
    details.appendChild(list);

    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "skill-btn settings-btn routing-add-fallback-btn";
    addBtn.textContent = "+ Add fallback";
    addBtn.disabled = slot.fallback.length >= 3;
    addBtn.addEventListener("click", function () {
      if (slot.fallback.length >= 3) return;
      // A new fallback entry starts with transport claude-native explicitly
      // (never inherited from the parent slot) — pushing {} left `transport`
      // undefined, which the vendor <select>'s default-first-option display
      // made LOOK like claude-native while the parent's actual transport
      // (e.g. openai-compatible from a Custom-endpoint parent) could still
      // leak through once a vendor was picked, since nothing had explicitly
      // reset it. See the vendorSel change handler above for the matching
      // reset-on-vendor-change fix.
      slot.fallback.push({ transport: "claude-native" });
      onStructural();
    });
    details.appendChild(addBtn);

    return details;
  }

  // Plain-word labels for RoutingSource — no FRONTMATTER/ALIAS jargon chips.
  // Renders as a small muted text line under the agent name (item 1 cleanup);
  // class name kept as "routing-source-chip" (styled as plain text now, not
  // a pill) so existing DOM lookups by that class keep working.
  var ROUTING_SOURCE_LABELS = {
    routing: "model from routing.json",
    frontmatter: "model from agent file",
    alias: "model from Claude alias",
    default: "default",
  };

  function routingSourceChip(source) {
    var chip = document.createElement("span");
    chip.className = "routing-source-chip routing-source-chip--" + (source || "default");
    chip.textContent = ROUTING_SOURCE_LABELS[source] || ROUTING_SOURCE_LABELS.default;
    return chip;
  }

  /**
   * Build the fallback-status chip for one Routing table row (p13-t3),
   * using the SAME agentMetrics the Metrics board reads (currentScopeMetrics(),
   * no duplicated lookup logic). Returns null when the agent has neither run
   * on a fallback nor ever fired one — callers append nothing in that case.
   *
   * agentMetrics carries one entry per agent id (see AgentMetric in
   * src/core/state.ts), so "latest" is simply the item whose id matches.
   * @param {string} agentId
   * @returns {HTMLElement|null}
   */
  function buildRoutingFallbackChip(agentId) {
    var metrics = currentScopeMetrics();
    var item = Array.isArray(metrics) ? metrics.find(function (m) { return m && m.id === agentId; }) : null;
    if (!item) return null;

    if (item.fallbackOf) {
      var chip = document.createElement("span");
      chip.className = "routing-source-chip routing-source-chip--fallback";
      chip.textContent = "ran on fallback";
      chip.title =
        "last run fell back from " + item.fallbackOf + " to " + (item.model || "unknown") +
        " (depth " + (item.fallbackDepth || 0) + ")";
      return chip;
    }

    if (item.fallbackCount > 0) {
      var countEl = document.createElement("span");
      countEl.className = "routing-fallback-count";
      countEl.textContent = item.fallbackCount + " fallback" + (item.fallbackCount === 1 ? "" : "s");
      countEl.title = agentId + " has fired " + item.fallbackCount + " fallback dispatch" + (item.fallbackCount === 1 ? "" : "es") + " (not on the most recent run).";
      return countEl;
    }

    return null;
  }

  /**
   * Render the Routing view's "Totals" block: per-vendor / per-cost-class
   * rollup rows plus the fallbacks-fired line, computed by
   * buildMetricsRollup() on the SAME agentMetrics the Metrics board uses
   * (currentScopeMetrics()) — no duplicated calculation. Reuses
   * appendFooterRow() so a rollup row looks and reads identically in both
   * places.
   * @returns {HTMLElement}
   */
  function buildRoutingTotalsBlock() {
    var section = buildSection("Totals");
    section.id = "routing-totals-section";
    var metrics = currentScopeMetrics();
    var rollup = buildMetricsRollup(metrics);

    var table = document.createElement("table");
    table.className = "metrics-table routing-totals-table";
    var tbody = document.createElement("tbody");
    table.appendChild(tbody);
    var COLSPAN = 1;

    if (!rollup.byVendor.length && !rollup.byCostClass.length && !rollup.fallbackCount) {
      var emptyRow = document.createElement("p");
      emptyRow.className = "settings-empty";
      emptyRow.textContent = "No routing activity recorded yet.";
      section.appendChild(emptyRow);
      return section;
    }

    for (const v of rollup.byVendor) {
      appendFooterRow(
        tbody,
        COLSPAN,
        `${v.vendor} total — `,
        `${fmtTokens(v.tokens)} tokens, ${v.costLabel} (${v.agents} agent${v.agents === 1 ? "" : "s"})`,
        "Sum of tokens and estimated cost for every agent whose actually-executed model belongs to this vendor (a fallback-tagged agent counts under the vendor that ran it, not the one originally assigned)."
      );
    }

    for (const c of rollup.byCostClass) {
      appendFooterRow(
        tbody,
        COLSPAN,
        `${costClassLabel(c.costModelClass)} total — `,
        `${fmtTokens(c.tokens)} tokens, ${c.costLabel}`,
        "Sum of tokens and estimated cost for every agent in this billing class. Subscription models show \"quota\" and local models show \"local\" — neither has a comparable per-token dollar figure."
      );
    }

    if (rollup.fallbackCount > 0) {
      appendFooterRow(
        tbody,
        COLSPAN,
        "Fallbacks fired — ",
        `${rollup.fallbackCount}`,
        "Number of times a task was re-dispatched to a fallback model/provider after its originally assigned agent could not run it."
      );
    }

    section.appendChild(table);
    return section;
  }

  /** Create the Routing modal's DOM skeleton once (lazily, on first open). */
  function ensureRoutingModal() {
    if (routingModalEl) return;
    routingModalEl = document.createElement("div");
    routingModalEl.id = "routing-modal";
    routingModalEl.setAttribute("role", "dialog");
    routingModalEl.setAttribute("aria-modal", "true");
    routingModalEl.setAttribute("aria-labelledby", "routing-modal-title");
    routingModalEl.setAttribute("hidden", "");

    routingBackdropEl = document.createElement("div");
    routingBackdropEl.id = "routing-backdrop";
    routingModalEl.appendChild(routingBackdropEl);

    // #routing-dialog is a column flex container: [header (flex:none)]
    // [#routing-modal-body (flex:1; overflow-y:auto) — the ONLY scroll
    // region] [footer .routing-actions-row (flex:none)]. Header and footer
    // sit outside the scroll container so they stay put — no
    // position:sticky needed — while the body between them scrolls.
    var dialog = document.createElement("div");
    dialog.id = "routing-dialog";

    var header = document.createElement("div");
    header.id = "routing-modal-header";
    header.className = "routing-modal-header";

    var title = document.createElement("h2");
    title.id = "routing-modal-title";
    title.textContent = "Agents";
    header.appendChild(title);

    routingCloseBtnEl = document.createElement("button");
    routingCloseBtnEl.id = "routing-modal-close";
    routingCloseBtnEl.setAttribute("aria-label", "Close dialog");
    routingCloseBtnEl.innerHTML = "&times;";
    routingCloseBtnEl.addEventListener("click", function () {
      // Same staleness guard as the open path: don't let a suppression
      // armed by this session's failed save bleed into a future reopen.
      routingSuppressNextRebuild = false;
      closeModal(routingModalEl);
    });
    header.appendChild(routingCloseBtnEl);

    dialog.appendChild(header);

    // routingBodyEl is the ONLY scroll container. Horizontal padding lives
    // on routingContentEl (the inner wrapper) instead of here, so the
    // scrollbar itself sits flush against the dialog's right edge.
    routingBodyEl = document.createElement("div");
    routingBodyEl.id = "routing-modal-body";
    // Re-apply a chip/Totals update that updateRoutingViewLive deferred
    // (routingUpdatePending) because focus was inside the body — "focusout"
    // bubbles and fires once focus actually leaves routingBodyEl (or the
    // whole document), unlike "blur" which doesn't bubble.
    routingBodyEl.addEventListener("focusout", function () {
      if (!routingUpdatePending) return;
      setTimeout(function () {
        if (routingUpdatePending) updateRoutingViewLive();
      }, 0);
    });

    routingContentEl = document.createElement("div");
    routingContentEl.id = "routing-modal-content";
    routingBodyEl.appendChild(routingContentEl);

    dialog.appendChild(routingBodyEl);

    // Fixed footer — Save/Revert/Clear must always stay visible so the user
    // knows to save, regardless of scroll position. Created once here;
    // renderRoutingModal only updates button state/text.
    var footer = document.createElement("div");
    footer.id = "routing-modal-footer";
    footer.className = "routing-actions-row";

    routingSaveBtnEl = document.createElement("button");
    routingSaveBtnEl.id = "routing-save-btn";
    routingSaveBtnEl.className = "skill-btn settings-btn";
    routingSaveBtnEl.textContent = "Save";
    routingSaveBtnEl.addEventListener("click", saveRoutingProfile);
    footer.appendChild(routingSaveBtnEl);

    routingRevertBtnEl = document.createElement("button");
    routingRevertBtnEl.id = "routing-revert-btn";
    routingRevertBtnEl.className = "skill-btn settings-btn";
    routingRevertBtnEl.textContent = "Revert";
    routingRevertBtnEl.addEventListener("click", function () {
      routingDraft = buildRoutingDraft(lastRoutingPayload);
      renderRoutingModal();
    });
    footer.appendChild(routingRevertBtnEl);

    routingClearBtnEl = document.createElement("button");
    routingClearBtnEl.id = "routing-clear-btn";
    routingClearBtnEl.className = "skill-btn settings-btn routing-clear-btn";
    routingClearBtnEl.textContent = "Clear profile";
    routingClearBtnEl.addEventListener("click", function () {
      routingSaving = true;
      renderRoutingModal();
      vscode.postMessage({ type: ROUTING_MSG.CLEAR });
    });
    footer.appendChild(routingClearBtnEl);

    // Simple-density footer (p19-t1): tier/keyword/remove actions already
    // post immediately, so there's nothing to save — just Close. Hidden by
    // default; renderRoutingModal toggles this vs. the three buttons above
    // per density.
    routingFooterCloseBtnEl = document.createElement("button");
    routingFooterCloseBtnEl.id = "routing-footer-close-btn";
    routingFooterCloseBtnEl.className = "skill-btn settings-btn";
    routingFooterCloseBtnEl.textContent = "Close";
    routingFooterCloseBtnEl.hidden = true;
    routingFooterCloseBtnEl.addEventListener("click", function () {
      routingSuppressNextRebuild = false;
      closeModal(routingModalEl);
    });
    footer.appendChild(routingFooterCloseBtnEl);

    dialog.appendChild(footer);

    routingModalEl.appendChild(dialog);
    document.body.appendChild(routingModalEl);
  }

  // Set when a live `state` update arrives while the Routing view is open
  // AND focus sits inside routingBodyEl (mid-edit) — the in-place update is
  // skipped in that case (see updateRoutingViewLive) so it can't steal focus
  // out from under a field the user is actively typing into. The blur
  // handler registered in ensureRoutingModal re-applies it once focus
  // leaves.
  var routingUpdatePending = false;

  /**
   * In-place refresh of the Routing view's fallback chips + Totals block
   * only, called on every `state` message while the view is open (p13-t3
   * audit fix). Deliberately does NOT touch routingBodyEl's slot inputs or
   * fallback-chain <details> elements — a full renderRoutingModal() rebuild
   * there would drop focus/caret out of a field mid-typing and collapse any
   * open <details>. Skips entirely (deferring via routingUpdatePending)
   * while focus is inside routingBodyEl, so a keystroke never gets
   * interrupted by a chip/totals repaint either.
   */
  function updateRoutingViewLive() {
    if (!routingModalEl || routingModalEl.hasAttribute("hidden") || !routingBodyEl) return;
    if (!lastRoutingPayload) return;

    // Check routingContentEl (not routingBodyEl) — routingBodyEl also
    // contains the sticky header's close button, and focus landing there
    // (e.g. right after the modal opens) must not be treated as "mid-edit
    // in a slot field" and defer this repaint forever.
    if (document.activeElement && routingContentEl && routingContentEl.contains(document.activeElement)) {
      routingUpdatePending = true;
      return;
    }
    routingUpdatePending = false;

    var agents = lastRoutingPayload.agents || [];
    agents.forEach(function (a) {
      var row = routingBodyEl.querySelector('.routing-agent-row[data-agent-id="' + String(a.id).replace(/"/g, '\\"') + '"]');
      if (!row) return;
      var sourceLine = row.querySelector(".routing-agent-source-line");
      if (!sourceLine) return;
      sourceLine.querySelectorAll(".routing-source-chip--fallback, .routing-fallback-count").forEach(function (el) {
        el.remove();
      });
      var chip = buildRoutingFallbackChip(a.id);
      if (chip) sourceLine.appendChild(chip);
    });

    var oldTotals = routingBodyEl.querySelector("#routing-totals-section");
    var newTotals = buildRoutingTotalsBlock();
    if (oldTotals) {
      oldTotals.replaceWith(newTotals);
    } else {
      routingContentEl.appendChild(newTotals);
    }
  }

  /**
   * Snapshot every `.routing-fallback-details`'s open/closed state (keyed by
   * its `data-agent-id`, "orchestrator" included) plus which field currently
   * has focus (by `data-field-key`, with its selection range for a text
   * input) so a full rebuild can restore both afterward. Root cause of the
   * "fallback details collapses on every edit" bug: nearly every field
   * change here (vendor switch, transport switch, add/remove/reorder
   * fallback, "Custom…"/"Choose from list") calls `onStructural`, which IS
   * `renderRoutingModal` itself — a full innerHTML rebuild with no memory of
   * which <details> were open or which input had focus. Some of those
   * really do need a full rebuild (e.g. switching vendor to Custom reveals a
   * new "Provider name" field), so instead of trying to avoid the rebuild,
   * this snapshots UI state before it and restores it after.
   */
  function snapshotRoutingUiState() {
    var openMap = {};
    if (routingContentEl) {
      routingContentEl.querySelectorAll(".routing-fallback-details").forEach(function (d) {
        var key = d.getAttribute("data-agent-id") || "orchestrator";
        openMap[key] = !!d.open;
      });
    }
    var focus = null;
    var active = document.activeElement;
    if (active && routingContentEl && routingContentEl.contains(active)) {
      var fieldKey = active.getAttribute && active.getAttribute("data-field-key");
      if (fieldKey) {
        focus = { fieldKey: fieldKey };
        if (typeof active.selectionStart === "number") {
          focus.selectionStart = active.selectionStart;
          focus.selectionEnd = active.selectionEnd;
        }
      }
    }
    // Also capture any keyword-input the user has typed into but not yet
    // saved, keyed by agent id: renderRoutingModal always sets
    // `kwInput.value = loadedKeywords` on rebuild (e.g. the "settings" reply
    // to the getSettings this modal posts on open), which would otherwise
    // clobber in-progress typing before the user hits Save.
    var keywordEdits = {};
    if (routingContentEl) {
      routingContentEl.querySelectorAll(".keyword-input").forEach(function (inp) {
        var agentId = inp.dataset.agentId;
        if (!agentId) return;
        var loaded = inp.dataset.loaded || "";
        if (inp.value !== loaded) {
          keywordEdits[agentId] = inp.value;
        }
      });
    }
    return { openMap: openMap, focus: focus, keywordEdits: keywordEdits };
  }

  function restoreRoutingUiState(snapshot) {
    if (!snapshot || !routingContentEl) return;
    routingContentEl.querySelectorAll(".routing-fallback-details").forEach(function (d) {
      var key = d.getAttribute("data-agent-id") || "orchestrator";
      if (Object.prototype.hasOwnProperty.call(snapshot.openMap, key)) {
        d.open = snapshot.openMap[key];
      }
    });
    if (snapshot.keywordEdits) {
      routingContentEl.querySelectorAll(".keyword-input").forEach(function (inp) {
        var agentId = inp.dataset.agentId;
        if (!agentId || !Object.prototype.hasOwnProperty.call(snapshot.keywordEdits, agentId)) return;
        inp.value = snapshot.keywordEdits[agentId];
        // Re-fire the input event so the card's own "input" listener marks
        // kwUserEdited = true — that flag lives in the card's closure and
        // was rebuilt fresh, so it can only be set this way, not assigned
        // directly.
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    if (snapshot.focus) {
      var el = routingContentEl.querySelector('[data-field-key="' + snapshot.focus.fieldKey.replace(/"/g, '\\"') + '"]');
      if (el) {
        el.focus();
        if (typeof snapshot.focus.selectionStart === "number" && typeof el.setSelectionRange === "function") {
          try { el.setSelectionRange(snapshot.focus.selectionStart, snapshot.focus.selectionEnd); } catch (e) { /* not a text-selectable input */ }
        }
      }
    }
  }

  /**
   * Shared harness dropdown builder (p20-t2). Renders the "Which tool runs
   * your agents?" select + hint from `lastSettings.harness` — used both by
   * the Settings screen's "Agent harness" section and by the Agents screen
   * header. `idPrefix` keeps the two <select> ids unique when both are
   * mounted at once. Returns null when lastSettings.harness isn't loaded
   * yet (caller decides whether to render a section around it).
   */
  function buildHarnessControl(idPrefix) {
    if (!lastSettings || !lastSettings.harness) return null;
    const harness = lastSettings.harness;
    const harnessRow = document.createElement("div");
    harnessRow.className = "settings-row feedback-field";
    harnessRow.dataset.agentRow = "harness";
    const harnessLabel = document.createElement("label");
    harnessLabel.textContent = "Which tool runs your agents?";
    harnessLabel.setAttribute("for", idPrefix + "-harness-select");
    harnessRow.appendChild(harnessLabel);
    const harnessSelect = document.createElement("select");
    harnessSelect.id = idPrefix + "-harness-select";
    const harnessOptions = Array.isArray(harness.options)
      ? harness.options
      : [
          { id: "claude-code", label: "Claude Code" },
          { id: "opencode", label: "OpenCode" },
        ];
    harnessOptions.forEach((opt) => {
      const optEl = document.createElement("option");
      optEl.value = opt.id;
      optEl.textContent = opt.label;
      if (opt.id === harness.effective) optEl.selected = true;
      harnessSelect.appendChild(optEl);
    });
    const overridden = harness.source === "env" || harness.source === "setting";
    harnessSelect.disabled = overridden;
    harnessSelect.addEventListener("change", () => {
      harnessSelect.disabled = true;
      vscode.postMessage({ type: "setHarness", provider: harnessSelect.value });
    });
    harnessRow.appendChild(harnessSelect);
    const harnessHint = document.createElement("p");
    harnessHint.className = "delegation-mode-footnote";
    if (overridden) {
      harnessHint.textContent =
        harness.source === "env"
          ? "Overridden by TYCOON_PROVIDER"
          : "Overridden by the tycoonagents.provider VS Code setting";
    } else if (harness.mismatch || harness.requiresRestart) {
      harnessHint.textContent = "Restart to apply";
    } else {
      harnessHint.textContent = "Applies immediately.";
    }
    harnessRow.appendChild(harnessHint);
    return harnessRow;
  }

  /**
   * Read-only "Session model" card for the orchestrator, rendered at the top
   * of the Agents screen in both densities (p19-t1). Ported verbatim from
   * the old Settings agents-loop orchestrator branch — keeps the
   * `[data-agent-row="orchestrator"]` hook and every warning/help string.
   */
  /**
   * `.agent-stats` chip row (vs. orch., tasks, MCP, vendor, billing) shared
   * by the orchestrator card and every other agent's unified card — ported
   * verbatim from the old Settings agents-loop so the orchestrator keeps
   * its "vs. orch. baseline" chip after the p19-t1 move.
   */
  function buildAgentStatsRow(a, m) {
    const stats = document.createElement("div");
    stats.className = "agent-stats";
    const chip = (label, value) => {
      const c = document.createElement("span");
      c.className = "stat-chip";
      c.textContent = `${label} ${value}`;
      return c;
    };
    let chipVsOrchText;
    if (a.isOrchestrator) {
      chipVsOrchText = "baseline";
    } else {
      const chipModel = m ? (m.model || a.model) : a.model;
      const chipCostModelClass = (m && m.costModelClass) || a.costModelClass || null;
      const chipAgentRate = modelPricePerMtok(chipModel, chipCostModelClass);
      const chipOrchestratorPrice = resolveOrchestratorModelRate(lastMetrics);
      chipVsOrchText = vsOrchLabel(chipModel, chipAgentRate, chipOrchestratorPrice, chipCostModelClass);
    }
    const vsOrchChip = chip("vs. orch.", chipVsOrchText);
    vsOrchChip.title = "How much cheaper this agent's model is per token than the orchestrator's (metered models only) — flat-rate subscription and local models have no comparable per-token rate, so they show their billing class instead of a ratio.";
    stats.appendChild(vsOrchChip);
    stats.appendChild(chip("tasks", String((m && m.taskCount) || 0)));
    stats.appendChild(chip("MCP", String((m && m.mcpCount) || 0)));
    const cardVendor = a.vendor || (m && m.vendor) || null;
    if (cardVendor && cardVendor !== "anthropic") {
      stats.appendChild(chip("vendor", vendorLabelFor(cardVendor)));
    }
    const cardCostClass = a.costModelClass || (m && m.costModelClass) || null;
    if (cardCostClass === "subscription") {
      stats.appendChild(chip("billing", "quota"));
    } else if (cardCostClass === "local") {
      stats.appendChild(chip("billing", "local"));
    }
    return stats;
  }

  function buildOrchestratorSimpleCard(agent, isClaudeHarness) {
    const m = metricsFor(agent.id);
    const row = document.createElement("div");
    row.className = "settings-row agent-row";
    row.dataset.agentRow = "orchestrator";
    row.setAttribute("data-agent-id", agent.id);

    const head = document.createElement("div");
    head.className = "agent-row-head";
    const nameEl = document.createElement("span");
    nameEl.className = "agent-name";
    nameEl.textContent = agent.name || agent.id;
    head.appendChild(nameEl);

    const observedFamily = modelFamily(m && m.model);
    const ro = document.createElement("span");
    ro.className = "agent-model-readonly";
    if (observedFamily === "Sonnet" || observedFamily === "Haiku") {
      ro.className += " agent-model-readonly--bad";
    } else if (observedFamily === "Opus" || observedFamily === "Fable") {
      ro.className += " agent-model-readonly--good";
    }
    ro.textContent = observedFamily ? `Session model: ${observedFamily}` : "Session model: Unknown yet";
    head.appendChild(ro);
    row.appendChild(head);

    row.appendChild(buildAgentStatsRow({ ...agent, isOrchestrator: true }, m));

    const roHelp = document.createElement("p");
    roHelp.className = "delegation-mode-option-help orchestrator-model-help";
    roHelp.textContent = observedFamily
      ? "Read from Claude Code's session model — set via /model, VS Code chat settings, or ANTHROPIC_MODEL. Not a TycoonAgents setting, so there's no picker here."
      : "Read from Claude Code's session model (set via /model, VS Code chat settings, or ANTHROPIC_MODEL) once observed from activity — not a TycoonAgents setting. Run a task to populate this.";
    if (isClaudeHarness) {
      roHelp.textContent += " Routing the orchestrator applies only when OpenCode runs your agents.";
    }
    row.appendChild(roHelp);

    if (observedFamily === "Sonnet" || observedFamily === "Haiku") {
      const warn = document.createElement("p");
      warn.className = "orchestrator-model-warning";
      warn.textContent =
        `TycoonAgents expects Opus or above as the orchestrator — it distills and delegates cheap work to Sonnet/Haiku workers. Running the orchestrator itself on ${observedFamily} removes those savings. Fix: run /model opus.`;
      row.appendChild(warn);
    } else if (!observedFamily && agentActivityObserved && orchestratorModelGraceElapsed) {
      const warn = document.createElement("p");
      warn.className = "orchestrator-model-warning orchestrator-model-warning--info";
      warn.textContent =
        "TycoonAgents hasn't detected the orchestrator's model yet. This is read from Claude Code's session model, not a TycoonAgents setting — check it with /model, the VS Code chat model selector, or the ANTHROPIC_MODEL environment variable. TycoonAgents expects Opus or above for the orchestrator, since it distills and delegates cheap work to smaller models. Detection populates once agent activity has been observed, so running a task may resolve this.";
      row.appendChild(warn);
    }

    showOrchestratorModelBanner(observedFamily);
    return row;
  }

  /**
   * Unified agent card (p19-t1). Simple density = the original Settings
   * agent card: tier radios/backend line/routed chip, keyword editor, stats
   * chips, recommendation badge, Remove. Full density appends the routing
   * slot editor, fallback editor, and provenance/override controls (needs
   * the matching entry from the routing payload's `agents[]`, passed as
   * `routingAgent`; simple density never touches it).
   */
  /**
   * Appends the bottom-of-card Remove control (quiet danger link,
   * right-aligned) and returns the card. Called at every return point of
   * buildUnifiedAgentCard so Remove always ends up below the keyword/slot/
   * fallback content regardless of which density/branch built it.
   */
  function appendCardRemoveFooter(card, a) {
    const footer = document.createElement("div");
    footer.className = "agent-remove-footer";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "link-button agent-remove-link";
    removeBtn.textContent = "Remove";
    removeBtn.dataset.removeAgentId = a.id;
    removeBtn.addEventListener("click", () => {
      openRemoveAgentConfirmModal(a.id, a.name, () => {
        removeBtn.disabled = true;
        removeBtn.textContent = "Removing…";
        vscode.postMessage({ type: "removeAgent", id: a.id });
      });
    });
    footer.appendChild(removeBtn);
    card.appendChild(footer);
    return card;
  }

  function buildUnifiedAgentCard(a, routingAgent, density, presets, payload, routingDraft, hasDefaults) {
    const m = metricsFor(a.id);
    const card = document.createElement("div");
    card.className = "routing-agent-card";
    card.setAttribute("data-agent-id", a.id);

    const row = document.createElement("div");
    row.className = "settings-row agent-row";
    row.dataset.agentRow = a.id;
    row.setAttribute("data-agent-id", a.id);

    const head = document.createElement("div");
    head.className = "agent-row-head";

    const nameEl = document.createElement("span");
    nameEl.className = "agent-name";
    nameEl.textContent = a.name || a.id;
    head.appendChild(nameEl);

    if (density === "full" && routingAgent && routingAgent.description) {
      const desc = document.createElement("span");
      desc.className = "routing-agent-desc";
      desc.textContent = routingAgent.description;
      desc.title = routingAgent.description;
      head.appendChild(desc);
    }

    // p18-t2: route-aware model row. Three shapes, mutually exclusive:
    //  1. claudeTier set        -> the radios as before, that tier checked.
    //  2. handWrittenBackend    -> a static "Backend: <vendor> via MCP" line.
    //  3. routed to a non-Claude vendor -> a "Routed to <vendor>/<model>" chip.
    const buildModelRadioGroup = () => {
      const group = document.createElement("div");
      group.className = "model-radio-group";
      const groupName = `model-${a.id}`;
      for (const model of ["fable", "opus", "sonnet", "haiku"]) {
        const lbl = document.createElement("label");
        lbl.className = "model-radio";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = groupName;
        input.value = model;
        if (a.claudeTier === model) input.checked = true;
        input.addEventListener("change", () => {
          if (input.checked) {
            justSetAgentModelId = a.id;
            vscode.postMessage({ type: "setAgentModel", id: a.id, model });
          }
        });
        const span = document.createElement("span");
        span.textContent = model.charAt(0).toUpperCase() + model.slice(1);
        lbl.appendChild(input);
        lbl.appendChild(span);
        group.appendChild(lbl);
      }
      return group;
    };

    if (a.claudeTier) {
      head.appendChild(buildModelRadioGroup());
    } else {
      const buildUseClaudeDisclosure = () => {
        const details = document.createElement("details");
        details.className = "use-claude-tier-disclosure";
        const summary = document.createElement("summary");
        summary.className = "link-button";
        summary.textContent = "Use Claude model…";
        details.appendChild(summary);
        details.appendChild(buildModelRadioGroup());
        return details;
      };

      if (a.handWrittenBackend) {
        const backendLine = document.createElement("span");
        backendLine.className = "agent-backend-line";
        backendLine.textContent = `Backend: ${vendorLabelFor(a.vendor || "unknown")} via MCP`;
        head.appendChild(backendLine);

        // Provenance line: where the hand-written backend: block actually
        // came from, plus an "Open" link (openAgentFile -> panel.ts opens
        // the file in an editor tab; standalone reveals it in the OS file
        // manager). Pack attribution is appended only when the settings
        // payload actually carries it (a.packId) — no new payload field is
        // added here.
        const provenanceLine = document.createElement("span");
        provenanceLine.className = "agent-backend-provenance-line";
        let provenanceText = `Defined in .claude/agents/${a.id}.md`;
        if (a.packId) {
          provenanceText += ` · from the ${a.packId} pack`;
        }
        provenanceLine.appendChild(document.createTextNode(provenanceText + " "));
        const openLink = document.createElement("button");
        openLink.type = "button";
        openLink.className = "link-button agent-backend-open-link";
        openLink.textContent = "Open";
        openLink.addEventListener("click", () => {
          vscode.postMessage({ type: "openAgentFile", id: a.id });
        });
        provenanceLine.appendChild(openLink);
        head.appendChild(provenanceLine);

        head.appendChild(buildUseClaudeDisclosure());
      } else {
        if (density === "full") {
          // OpenCode (full density): unchanged — routed chip + Edit-in-Routing
          // link live in the head.
          const routedRow = document.createElement("span");
          routedRow.className = "stat-chip agent-routed-chip";
          const routedModel = a.resolvedModel || a.model || "unknown model";
          routedRow.textContent = `Routed to ${vendorLabelFor(a.vendor || "unknown")}/${routedModel}`;
          head.appendChild(routedRow);
        }
        // Classic (Claude Code) density, non-handwritten, non-claudeTier: the
        // routed chip moves inside the per-card "Use another provider"
        // expansion below (p20-t2) instead of living in the head — but the
        // "Use Claude tier…" disclosure (and its radio group, which
        // setAgentModel/justSetAgentModelId suppression depends on) still
        // renders on every classic card, expanded or not.
        head.appendChild(buildUseClaudeDisclosure());
      }
    }

    // The host has sent this field as `keywords` all along (panel.ts
    // _handleGetSettings / standalone buildStandaloneSettingsPayload), but
    // resolve defensively across the field-name variants a future payload
    // shape might use so a rename on either host can't blank this input.
    const loadedKeywords = a.keywords ?? a.keywordPattern ?? a.pattern ?? "";
    const originalKeywords = loadedKeywords || "";
    // kwInputRef is filled in once the keyword input is built below — the
    // Save button is created first (head renders above the keyword row) but
    // both need each other, so a mutable box breaks the ordering dependency.
    // Declared before cardSaveBtn so the dependency doesn't rely on hoisting.
    var kwInputRef = {};
    // Set only by the keyword input's own "input" event — i.e. the user
    // actually typed/pasted/cleared it. doCardSave must never post a
    // pattern the user didn't touch: a card rebuilt with a stale/empty
    // `a.keywords` (e.g. a settings payload that raced ahead of the
    // keywords config on disk) must not get its real saved pattern wiped
    // out just because the freshly-built input's value no longer matches
    // that stale `originalKeywords` baseline.
    var kwUserEdited = false;
    const cardSaveBtn = document.createElement("button");
    cardSaveBtn.type = "button";
    cardSaveBtn.className = "skill-btn settings-btn agent-card-save-btn";
    cardSaveBtn.textContent = "Save";
    cardSaveBtn.title = "Save this agent's keywords and routing";
    const doCardSave = () => {
      if (
        kwUserEdited &&
        kwInputRef.value !== undefined &&
        kwInputRef.value.value !== originalKeywords
      ) {
        vscode.postMessage({ type: "setAgentKeywords", id: a.id, pattern: kwInputRef.value.value });
      }
      saveRoutingProfile();
      showToast("Saving…", "info");
    };
    cardSaveBtn.addEventListener("click", doCardSave);
    head.appendChild(cardSaveBtn);
    row.appendChild(head);

    // Stats
    row.appendChild(buildAgentStatsRow(a, m));

    // Recommendation badge
    const suppressRecFor = justSetAgentModelId;
    const rec = suppressRecFor === a.id ? null : recommendationFor(a, m);
    if (rec) {
      const badge = document.createElement("div");
      badge.className = `rec-badge rec-${rec.kind} rec-badge--detached`;
      const txt = document.createElement("span");
      txt.className = "rec-text";
      txt.textContent = rec.text;
      badge.appendChild(txt);
      if (rec.suggest) {
        const targetLabel = rec.suggest.charAt(0).toUpperCase() + rec.suggest.slice(1);
        const apply = document.createElement("button");
        apply.className = "skill-btn settings-btn rec-apply";
        apply.textContent = `Switch to ${targetLabel}`;
        apply.addEventListener("click", () => {
          vscode.postMessage({ type: "setAgentModel", id: a.id, model: rec.suggest });
        });
        badge.appendChild(apply);
      }
      row.appendChild(badge);
    }

    card.appendChild(row);

    // Keyword editor row (moved from the old "Keyword routing" section).
    const kwRow = document.createElement("div");
    kwRow.className = "settings-row keyword-row";
    kwRow.setAttribute("data-agent-id", a.id);
    const kwLbl = document.createElement("label");
    kwLbl.className = "keyword-label";
    kwLbl.textContent = "Keywords";
    kwRow.appendChild(kwLbl);
    const kwInputWrap = document.createElement("div");
    kwInputWrap.className = "keyword-input-wrap";
    const kwInput = document.createElement("input");
    kwInput.type = "text";
    kwInput.className = "keyword-input";
    kwInput.value = loadedKeywords;
    kwInput.dataset.agentId = a.id;
    kwInput.dataset.loaded = loadedKeywords;
    kwInput.placeholder = "kw1|kw2|kw3";
    if (!loadedKeywords || String(loadedKeywords).trim() === "") {
      kwInput.title = "No routing keywords set — routing to this agent is disabled";
      kwInput.style.borderColor = "var(--status-error)";
    }
    kwInput.addEventListener("input", () => {
      kwUserEdited = true;
    });
    kwInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        doCardSave();
      }
    });
    kwInputRef.value = kwInput;
    kwInputWrap.appendChild(kwInput);
    kwRow.appendChild(kwInputWrap);
    card.appendChild(kwRow);

    if (density !== "full") {
      // ── Classic (Claude Code) density: "Use another provider" checkbox
      // (p20-t2). No routing controls render until it's checked. ──
      if (!routingAgent) return appendCardRemoveFooter(card, a);
      const routeSource = routingAgent.routeSource || routingAgent.provenance || "frontmatter";
      // "default" (inherited from the Default-for-all-agents route) has no
      // explicit per-agent entry, so it must not auto-expand like a real
      // explicit route would — it starts collapsed behind the "Override for
      // this agent" link (p21-t7 Part B) until the user opts in.
      const isRouted = routeSource !== "frontmatter" && routeSource !== "default";
      const expanded = Object.prototype.hasOwnProperty.call(routingExpandedAgents, a.id)
        ? !!routingExpandedAgents[a.id]
        : isRouted;

      if (routeSource === "default") {
        // Inherited from the Default-for-all-agents route: there is no
        // explicit per-agent entry to clear, so no checkbox — a checked box
        // that "unchecks" into clearAgentRoute would have nothing to remove
        // (p21-t7 Part B). Show an inherit note plus an override link that
        // opens the same sparse-entry editor a checkbox check would have.
        const inheritRow = document.createElement("div");
        inheritRow.className = "settings-row provider-toggle-row";
        inheritRow.setAttribute("data-agent-id", a.id);
        const inheritLine = document.createElement("div");
        inheritLine.className = "delegation-mode-option-body classic-inherit-line";
        const inheritText = document.createElement("span");
        inheritText.className = "delegation-mode-option-label";
        const inheritVendor = (routingAgent.backend && routingAgent.backend.vendor) || a.vendor || "unknown";
        const inheritModel = (routingAgent.backend && routingAgent.backend.model) || a.resolvedModel || a.model || "unknown model";
        inheritText.textContent = `Inherits the Default for all agents route · ${vendorLabelFor(inheritVendor)}/${inheritModel}`;
        inheritLine.appendChild(inheritText);
        if (!expanded) {
          const overrideBtn = document.createElement("button");
          overrideBtn.type = "button";
          overrideBtn.className = "routing-inline-link-btn routing-override-btn";
          overrideBtn.textContent = "Override for this agent";
          overrideBtn.addEventListener("click", () => {
            routingExpandedAgents[a.id] = true;
            if (!slotHasContent(routingDraft.agents[a.id])) {
              routingDraft.agents[a.id] = cloneSlotFromBackend(routingAgent.backend) || {};
            }
            renderRoutingModal();
          });
          inheritLine.appendChild(overrideBtn);
        }
        inheritRow.appendChild(inheritLine);
        const inheritHint = document.createElement("span");
        inheritHint.className = "delegation-mode-option-help";
        inheritHint.textContent = "To stop inheriting, clear the Default card (available when OpenCode runs your agents).";
        inheritRow.appendChild(inheritHint);
        card.appendChild(inheritRow);
      } else {
        const providerRow = document.createElement("div");
        providerRow.className = "settings-row provider-toggle-row";
        providerRow.setAttribute("data-agent-id", a.id);
        const providerLabel = document.createElement("label");
        providerLabel.className = "delegation-mode-option";
        const providerCheckbox = document.createElement("input");
        providerCheckbox.type = "checkbox";
        providerCheckbox.className = "agent-provider-checkbox";
        providerCheckbox.checked = !!a.handWrittenBackend || expanded;
        providerCheckbox.disabled = !!a.handWrittenBackend;
        const providerBody = document.createElement("span");
        providerBody.className = "delegation-mode-option-body";
        const providerLabelSpan = document.createElement("span");
        providerLabelSpan.className = "delegation-mode-option-label";
        providerLabelSpan.textContent = "Use another provider for this agent";
        const providerHelpSpan = document.createElement("span");
        providerHelpSpan.className = "delegation-mode-option-help";
        providerHelpSpan.textContent = a.handWrittenBackend
          ? `Backend: ${vendorLabelFor(a.vendor || "unknown")} via MCP (hand-written)`
          : "Applies to MCP-bridged agents now, and to every agent when OpenCode runs them.";
        providerBody.appendChild(providerLabelSpan);
        providerBody.appendChild(providerHelpSpan);
        providerLabel.appendChild(providerCheckbox);
        providerLabel.appendChild(providerBody);
        providerRow.appendChild(providerLabel);
        card.appendChild(providerRow);

        providerCheckbox.addEventListener("change", () => {
          if (a.handWrittenBackend) return;
          if (providerCheckbox.checked) {
            routingExpandedAgents[a.id] = true;
            if (!slotHasContent(routingDraft.agents[a.id])) {
              routingDraft.agents[a.id] = cloneSlotFromBackend(routingAgent.backend) || {};
            }
          } else {
            delete routingExpandedAgents[a.id];
            routingDraft.agents[a.id] = {};
            if (isRouted) {
              vscode.postMessage({ type: "clearAgentRoute", agentId: a.id });
            }
          }
          renderRoutingModal();
        });
      }

      if (expanded && !a.handWrittenBackend) {
        if (!routingDraft.agents[a.id]) routingDraft.agents[a.id] = {};
        if (isRouted && !slotHasContent(routingDraft.agents[a.id])) {
          routingDraft.agents[a.id] = cloneSlotFromBackend(routingAgent.backend) || {};
        }
        const slot = routingDraft.agents[a.id];
        const editorWrap = document.createElement("div");
        editorWrap.className = "routing-agent-fallback-row classic-provider-editor";
        editorWrap.setAttribute("data-agent-id", a.id);
        if (isRouted) {
          const chipLine = document.createElement("div");
          chipLine.className = "routing-agent-source-line";
          chipLine.appendChild(routingSourceChip(routingAgent.source || routeSource));
          const routedChip = document.createElement("span");
          routedChip.className = "stat-chip agent-routed-chip";
          const routedVendor = a.vendor || (routingAgent.backend && routingAgent.backend.vendor) || "unknown";
          const routedModel = a.resolvedModel || a.model || "unknown model";
          routedChip.textContent = `Routed to ${vendorLabelFor(routedVendor)}/${routedModel}`;
          chipLine.appendChild(routedChip);
          editorWrap.appendChild(chipLine);
        }
        editorWrap.appendChild(buildSlotEditorFields(slot, presets, renderRoutingModal, "agent:" + a.id));
        editorWrap.appendChild(buildFallbackEditor(slot, presets, renderRoutingModal, a.id, "agent:" + a.id));
        card.appendChild(editorWrap);
      }

      return appendCardRemoveFooter(card, a);
    }

    // ── Full density: routing slot editor, fallback editor, provenance ──
    if (!routingDraft.agents[a.id]) routingDraft.agents[a.id] = {};
    const slot = routingDraft.agents[a.id];

    const routingRow = document.createElement("div");
    routingRow.className = "routing-agent-row";
    routingRow.setAttribute("data-agent-id", a.id);

    const nameTd = document.createElement("div");
    nameTd.className = "routing-agent-name-td";
    const sourceLine = document.createElement("div");
    sourceLine.className = "routing-agent-source-line";

    if (routingAgent.handWrittenBackend) {
      const handWrittenNote = document.createElement("span");
      handWrittenNote.className = "routing-source-chip routing-source-chip--handwritten";
      handWrittenNote.textContent = "hand-written backend";
      handWrittenNote.title = "This agent's own frontmatter has a hand-written backend: block — defaults never apply to it.";
      sourceLine.appendChild(handWrittenNote);
    }

    const collapsedForDefault = routingAgent.provenance === "default" && !routingExpandedAgents[a.id];

    if (collapsedForDefault) {
      const inheritLabel = document.createElement("span");
      inheritLabel.className = "routing-source-chip";
      const vendorLabel = (routingAgent.backend && routingAgent.backend.vendor) || "?";
      const modelLabel = (routingAgent.backend && routingAgent.backend.model) || "?";
      inheritLabel.textContent = "Inherits default · " + vendorLabel + "/" + modelLabel;
      sourceLine.appendChild(inheritLabel);

      const overrideBtn = document.createElement("button");
      overrideBtn.type = "button";
      overrideBtn.className = "routing-inline-link-btn routing-override-btn";
      overrideBtn.textContent = "Override";
      overrideBtn.addEventListener("click", () => {
        routingExpandedAgents[a.id] = true;
        renderRoutingModal();
      });
      sourceLine.appendChild(overrideBtn);

      nameTd.appendChild(sourceLine);
      routingRow.appendChild(nameTd);
      card.appendChild(routingRow);
      return appendCardRemoveFooter(card, a);
    }

    sourceLine.appendChild(routingSourceChip(routingAgent.source));
    const fallbackChip = buildRoutingFallbackChip(a.id);
    if (fallbackChip) sourceLine.appendChild(fallbackChip);
    const agentWasInProfile = !!(payload.profile && payload.profile.agents && payload.profile.agents[a.id]);
    const slotCoercionNotes = [];
    if (shouldIncludeRoutingSlot(cleanRoutingSlot(slot, slotCoercionNotes, (payload.presets && payload.presets.vendors) || []), agentWasInProfile, routingAgent.backend)) {
      const dirtyMarker = document.createElement("span");
      dirtyMarker.className = "routing-source-chip routing-source-chip--dirty";
      dirtyMarker.textContent = "will be written to routing.json";
      if (slotCoercionNotes.length) dirtyMarker.title = slotCoercionNotes.join("; ");
      sourceLine.appendChild(dirtyMarker);
    }

    if (routingAgent.provenance === "explicit" && hasDefaults && !routingAgent.handWrittenBackend) {
      const useDefaultBtn = document.createElement("button");
      useDefaultBtn.type = "button";
      useDefaultBtn.className = "routing-inline-link-btn routing-use-default-btn";
      useDefaultBtn.textContent = "Use default";
      useDefaultBtn.addEventListener("click", () => {
        routingDraft.agents[a.id] = {};
        delete routingExpandedAgents[a.id];
        renderRoutingModal();
      });
      sourceLine.appendChild(useDefaultBtn);
    }
    if (routingAgent.provenance === "default" && routingExpandedAgents[a.id]) {
      const revertBtn = document.createElement("button");
      revertBtn.type = "button";
      revertBtn.className = "routing-inline-link-btn routing-use-default-btn";
      revertBtn.textContent = "Use default";
      revertBtn.addEventListener("click", () => {
        routingDraft.agents[a.id] = {};
        delete routingExpandedAgents[a.id];
        renderRoutingModal();
      });
      sourceLine.appendChild(revertBtn);
    }

    nameTd.appendChild(sourceLine);
    routingRow.appendChild(nameTd);

    const slotTd = document.createElement("div");
    slotTd.className = "routing-slot-td";
    slotTd.appendChild(buildSlotEditorFields(slot, presets, renderRoutingModal, "agent:" + a.id));
    routingRow.appendChild(slotTd);

    card.appendChild(routingRow);

    const fbRow = document.createElement("div");
    fbRow.className = "routing-agent-fallback-row";
    fbRow.setAttribute("data-agent-id", a.id);
    fbRow.appendChild(buildFallbackEditor(slot, presets, renderRoutingModal, a.id, "agent:" + a.id));
    card.appendChild(fbRow);

    return appendCardRemoveFooter(card, a);
  }

  /** Full re-render of the Routing modal body from lastRoutingPayload + routingDraft. */
  function renderRoutingModal() {
    if (!routingContentEl) return;
    var uiSnapshot = snapshotRoutingUiState();
    routingContentEl.innerHTML = "";

    if (!lastRoutingPayload) {
      var loading = document.createElement("p");
      loading.className = "settings-empty";
      loading.textContent = "Loading routing…";
      routingContentEl.appendChild(loading);
      return;
    }
    if (!routingDraft) routingDraft = buildRoutingDraft(lastRoutingPayload);

    var payload = lastRoutingPayload;
    // Density (p20-t2): keyed on the harness itself, not the old
    // routing.visible toggle — full (OpenCode's editable routing table) when
    // the effective harness is opencode, classic (the plain agent cards)
    // otherwise.
    var harnessEffective = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    var isClaudeHarness = harnessEffective !== "opencode";
    var density = isClaudeHarness ? "simple" : "full";

    // Read-only "Runs on <harness> · Change in Settings" line atop the
    // Agents screen (2026-09-05 decision): the harness question is asked
    // ONLY in Settings now — no dropdown here, just a link back to it.
    // buildHarnessControl is still used by Settings itself, further below.
    var agentsHarnessLine = buildAgentsHarnessLine(harnessEffective);
    if (agentsHarnessLine) {
      routingContentEl.appendChild(agentsHarnessLine);
    }

    var rawPresets = payload.presets || { vendors: [], models: [] };
    // Every vendor present in presets.models, plus any vendor already on the
    // current payload's orchestrator/agents — so a saved profile's vendor
    // (e.g. a custom "ollama-windows" endpoint) is always selectable, never
    // silently missing from the dropdown. Dedup + sorted.
    var vendorSet = {};
    (rawPresets.vendors || []).forEach(function (v) { vendorSet[v] = true; });
    (rawPresets.models || []).forEach(function (m) { if (m && m.vendor) vendorSet[m.vendor] = true; });
    function collectBackendVendor(backend) {
      if (backend && backend.vendor) vendorSet[backend.vendor] = true;
    }
    collectBackendVendor(payload.orchestrator && payload.orchestrator.backend);
    (payload.agents || []).forEach(function (a) { collectBackendVendor(a && a.backend); });
    var presets = { vendors: Object.keys(vendorSet).sort(), models: rawPresets.models || [] };

    if (Array.isArray(payload.errors) && payload.errors.length) {
      var errBox = document.createElement("div");
      errBox.className = "routing-errors";
      payload.errors.forEach(function (e) {
        var p = document.createElement("p");
        p.className = "routing-error-line";
        p.textContent = e;
        errBox.appendChild(p);
      });
      routingContentEl.appendChild(errBox);
    }

    // ── Orchestrator (p19-t1: read-only session-model card in both
    // densities; full-only slot/fallback editor appended below it) ──
    var orchestratorAgent = ((lastSettings && lastSettings.agents) || []).find(function (ag) { return ag.isOrchestrator; });
    var orchSection = buildSection("Orchestrator");
    if (orchestratorAgent) orchSection.appendChild(buildOrchestratorSimpleCard(orchestratorAgent, isClaudeHarness));
    if (density === "full") {
      if (!routingDraft.orchestrator) routingDraft.orchestrator = {};
      var orchMeta = document.createElement("div");
      orchMeta.className = "routing-slot-meta routing-agent-source-line";
      if (payload.orchestrator) {
        var orchChip = routingSourceChip(payload.orchestrator.source);
        orchMeta.appendChild(orchChip);
      }
      orchSection.appendChild(orchMeta);
      orchSection.appendChild(buildSlotEditorFields(routingDraft.orchestrator, presets, renderRoutingModal, "orchestrator"));
      orchSection.appendChild(buildFallbackEditor(routingDraft.orchestrator, presets, renderRoutingModal, "orchestrator", "orchestrator"));
    }
    if (orchestratorAgent || density === "full") {
      routingContentEl.appendChild(orchSection);
    }

    // ── Defaults (p17-t3) — full density only. One slot applied to every
    // agent that has neither its own routing.json entry nor a hand-written
    // backend block.
    if (density === "full") {
      var defaultsSection = buildSection("Default for all agents");
      var defaultsHelp = document.createElement("p");
      defaultsHelp.className = "routing-defaults-help";
      defaultsHelp.textContent = "Agents without their own route use this. Agents with a hand-written backend keep it.";
      defaultsSection.appendChild(defaultsHelp);
      if (!routingDraft.defaults) routingDraft.defaults = {};
      defaultsSection.appendChild(buildSlotEditorFields(routingDraft.defaults, presets, renderRoutingModal, "defaults"));
      defaultsSection.appendChild(buildFallbackEditor(routingDraft.defaults, presets, renderRoutingModal, "defaults", "defaults"));
      var clearDefaultsBtn = document.createElement("button");
      clearDefaultsBtn.type = "button";
      clearDefaultsBtn.className = "routing-inline-link-btn routing-inline-link-btn--danger routing-clear-defaults-btn";
      clearDefaultsBtn.textContent = "Clear defaults";
      clearDefaultsBtn.disabled = !slotHasContent(routingDraft.defaults);
      clearDefaultsBtn.addEventListener("click", function () {
        routingDraft.defaults = {};
        renderRoutingModal();
      });
      defaultsSection.appendChild(clearDefaultsBtn);
      routingContentEl.appendChild(defaultsSection);
    }

    // ── Per-agent cards (unified: simple or full density) ──
    // Iterate the routing payload's agents (always present once a "routing"
    // reply has landed, including in every existing test fixture) as the
    // primary list, merging in the matching lastSettings.agents entry (name,
    // claudeTier, keywords, vendor/model, stats) when the host has also
    // pushed a "settings" payload — falling back to a stub built from the
    // routing entry alone so the card still renders correctly without it.
    var agentsSection = buildSection("Agents");
    var settingsAgentsById = {};
    ((lastSettings && lastSettings.agents) || []).forEach(function (ag) {
      if (!ag.isOrchestrator) settingsAgentsById[ag.id] = ag;
    });
    var routingAgentList = payload.agents || [];
    if (!routingAgentList.length) {
      var noAgents = document.createElement("p");
      noAgents.className = "settings-empty";
      noAgents.textContent = "No agents found.";
      agentsSection.appendChild(noAgents);
    } else {
      if (density === "full") {
        var header = document.createElement("div");
        header.className = "routing-agents-header";
        ["Agent", "Slot"].forEach(function (h) {
          var span = document.createElement("span");
          span.textContent = h;
          header.appendChild(span);
        });
        agentsSection.appendChild(header);
      }

      var list = document.createElement("div");
      list.className = "routing-agents-list";
      var hasDefaults = slotHasContent(payload.defaults);
      routingAgentList.forEach(function (routingAgent) {
        var a = settingsAgentsById[routingAgent.id] || {
          id: routingAgent.id,
          name: routingAgent.name,
          keywords: "",
          claudeTier: null,
          handWrittenBackend: routingAgent.handWrittenBackend,
          vendor: routingAgent.backend && routingAgent.backend.vendor,
          resolvedModel: routingAgent.backend && routingAgent.backend.model,
          model: routingAgent.backend && routingAgent.backend.model,
          costModelClass: null,
        };
        var card = buildUnifiedAgentCard(a, routingAgent, density, presets, payload, routingDraft, hasDefaults);
        list.appendChild(card);
      });
      // Read-once flag (see buildUnifiedAgentCard): cleared after every
      // agent in this render pass has had a chance to check it, so a stale
      // id never survives past the render it was meant to suppress.
      justSetAgentModelId = null;
      agentsSection.appendChild(list);
    }
    routingContentEl.appendChild(agentsSection);
    if (density === "full") {
      routingContentEl.appendChild(buildRoutingTotalsBlock());
    }

    // ── Fixed footer button state (buttons themselves live outside the
    // scroll container — created once in ensureRoutingModal). Classic
    // density shows Save/Revert only once a card's "Use another provider"
    // checkbox has expanded its editor (p20-t2); Clear profile stays
    // full-density-only. With nothing expanded, only Close shows.
    var classicAnyExpanded = density !== "full" && Object.keys(routingExpandedAgents).some(function (id) {
      return routingExpandedAgents[id];
    });
    var showSaveRevert = density === "full" || classicAnyExpanded;
    if (routingSaveBtnEl) {
      routingSaveBtnEl.hidden = !showSaveRevert;
      routingSaveBtnEl.textContent = routingSaving ? "Saving…" : "Save";
      routingSaveBtnEl.disabled = routingSaving;
    }
    if (routingRevertBtnEl) {
      routingRevertBtnEl.hidden = !showSaveRevert;
      routingRevertBtnEl.disabled = routingSaving;
    }
    if (routingClearBtnEl) {
      routingClearBtnEl.hidden = density !== "full";
      routingClearBtnEl.disabled = routingSaving;
    }
    if (routingFooterCloseBtnEl) {
      routingFooterCloseBtnEl.hidden = showSaveRevert;
    }

    if (routingLastResult && routingLastResult.ok === false) {
      // Visible banner — the collapsed <details> below is easy to miss
      // entirely, which is how a failed save used to look identical to a
      // silent success (the draft would just revert with no explanation).
      var banner = document.createElement("div");
      banner.className = "routing-error-banner";
      banner.setAttribute("role", "alert");
      var bannerTitle = document.createElement("strong");
      bannerTitle.textContent = "Save failed — your changes were kept, nothing was written.";
      banner.appendChild(bannerTitle);
      if (Array.isArray(routingLastResult.errors) && routingLastResult.errors.length) {
        var bannerList = document.createElement("ul");
        routingLastResult.errors.forEach(function (e) {
          var li = document.createElement("li");
          li.textContent = e;
          bannerList.appendChild(li);
        });
        banner.appendChild(bannerList);
      }
      routingContentEl.appendChild(banner);
    }

    if (routingLastResult) {
      var resultDetails = document.createElement("details");
      resultDetails.className = "plan-task-details";
      var resultSummary = document.createElement("summary");
      resultSummary.textContent = routingLastResult.ok ? "Save succeeded — check/write output" : "Save failed — check/write output";
      resultDetails.appendChild(resultSummary);
      if (Array.isArray(routingLastResult.errors) && routingLastResult.errors.length) {
        var resErrList = document.createElement("ul");
        routingLastResult.errors.forEach(function (e) {
          var li = document.createElement("li");
          li.textContent = e;
          resErrList.appendChild(li);
        });
        resultDetails.appendChild(resErrList);
      }
      var pre = document.createElement("pre");
      pre.className = "feedback-preview-json";
      pre.textContent = JSON.stringify({ check: routingLastResult.check, write: routingLastResult.write }, null, 2);
      resultDetails.appendChild(pre);
      routingContentEl.appendChild(resultDetails);
    }

    restoreRoutingUiState(uiSnapshot);
  }

  /** Canonical cleaned-slot shape for a resolved Backend, for dirty-comparison against a draft slot. */
  function backendToCleanSlot(backend) {
    var presetVendors = (lastRoutingPayload && lastRoutingPayload.presets && lastRoutingPayload.presets.vendors) || [];
    return cleanRoutingSlot(cloneSlotFromBackend(backend), undefined, presetVendors) || {};
  }

  /** True when `cleanedSlot` (already run through cleanRoutingSlot) differs from `backend`'s own effective shape. */
  function slotDiffersFromBackend(cleanedSlot, backend) {
    return JSON.stringify(cleanedSlot || {}) !== JSON.stringify(backendToCleanSlot(backend));
  }

  /**
   * Whether one slot belongs in the outgoing profile (p13 sparse-save fix):
   * an agent/orchestrator the user never touched must not be materialized
   * into routing.json just because opening the Routing view seeded a draft
   * for every row. Included when either (a) it was already present in the
   * loaded profile — editing a previously-routed agent back to its
   * frontmatter/alias values keeps it explicit rather than silently
   * dropping it — or (b) the draft now differs from the resolved backend
   * the row started from.
   */
  function shouldIncludeRoutingSlot(cleanedSlot, wasInProfile, backend) {
    if (!cleanedSlot) return false;
    if (wasInProfile) return true;
    if (!backend) return true; // nothing to diff against — err toward keeping an explicit edit
    return slotDiffersFromBackend(cleanedSlot, backend);
  }

  function assembleRoutingProfile() {
    var profile = { version: 1, agents: {} };
    var payload = lastRoutingPayload;
    var existingProfile = payload && payload.profile;
    var presetVendors = (payload && payload.presets && payload.presets.vendors) || [];

    // Defaults (p17-t3): driven entirely by the live draft, not the loaded
    // profile — so editing the Default card's fields, or hitting Clear
    // defaults (which sets routingDraft.defaults = {}), round-trips
    // correctly. cleanRoutingSlot drops it to undefined for an empty draft.
    var defaultsCleaned = cleanRoutingSlot(routingDraft.defaults, undefined, presetVendors);
    if (defaultsCleaned) profile.defaults = defaultsCleaned;

    var orchCleaned = cleanRoutingSlot(routingDraft.orchestrator, undefined, presetVendors);
    var orchWasInProfile = !!(existingProfile && existingProfile.orchestrator);
    var orchBackend = payload && payload.orchestrator && payload.orchestrator.backend;
    // Never write an orchestrator slot with no model — buildRoutingView
    // deliberately blanks a "default" orchestrator's model to "" rather
    // than a placeholder, and that blank must not round-trip into a
    // materialized (and effectively meaningless) routing.json entry.
    if (orchCleaned && orchCleaned.model && shouldIncludeRoutingSlot(orchCleaned, orchWasInProfile, orchBackend)) {
      profile.orchestrator = orchCleaned;
    }

    var agents = (payload && payload.agents) || [];
    agents.forEach(function (a) {
      var wasInProfile = !!(existingProfile && existingProfile.agents && existingProfile.agents[a.id]);
      if (a.provenance === "default" && !wasInProfile && routingDefaultBaseline[a.id]) {
        // Sparse Override save (coordinator review fix): only fields that
        // differ from the resolved-default baseline, never the full backend.
        var diffCleaned = diffSlotFromDefaultBaseline(routingDraft.agents[a.id], routingDefaultBaseline[a.id], presetVendors);
        if (diffCleaned) profile.agents[a.id] = diffCleaned;
        return;
      }
      var cleaned = cleanRoutingSlot(routingDraft.agents[a.id], undefined, presetVendors);
      if (shouldIncludeRoutingSlot(cleaned, wasInProfile, a.backend)) {
        profile.agents[a.id] = cleaned;
      }
    });
    return profile;
  }

  function saveRoutingProfile() {
    if (routingSaving) {
      showToast("Save already in progress", "info");
      return;
    }
    var profile;
    try {
      profile = assembleRoutingProfile();
    } catch (err) {
      // Assembling from routingDraft threw (e.g. a malformed custom-vendor
      // or fallback entry) before anything was posted — surface it the same
      // way a host-reported save failure is surfaced instead of silently
      // doing nothing, so the user isn't left staring at an inert Save
      // button with no idea why.
      routingSaving = false;
      routingLastResult = {
        ok: false,
        errors: ["could not assemble routing profile: " + (err && err.message ? err.message : String(err))],
        check: {},
        write: {},
      };
      showToast(routingLastResult.errors[0], "error");
      renderRoutingModal();
      return;
    }
    routingSaving = true;
    routingLastResult = null;
    renderRoutingModal();
    vscode.postMessage({ type: ROUTING_MSG.SAVE, profile: profile });
  }

  function handleRoutingPayload(payload) {
    lastRoutingPayload = payload || null;
    if (routingSuppressNextRebuild) {
      // The save/clear that just failed already left routingDraft (the
      // user's in-progress edits) untouched — keep it. Still refresh the
      // env-probe cache and re-render so the failure banner + totals reflect
      // the latest host state, just without clobbering the draft.
      routingSuppressNextRebuild = false;
    } else {
      // Preserve routingExpandedAgents (and its agents' in-progress draft +
      // baseline) across a live payload push — only openRoutingModal()
      // resets it, on a genuinely fresh open. Without this, a "routing"
      // repush that arrives while an Override card is expanded but not yet
      // saved would silently re-collapse it and drop the unsaved edit.
      var prevDraft = routingDraft;
      var prevBaseline = routingDefaultBaseline;
      routingDraft = buildRoutingDraft(payload);
      Object.keys(routingExpandedAgents).forEach(function (id) {
        if (!routingExpandedAgents[id]) return;
        if (prevDraft && prevDraft.agents && Object.prototype.hasOwnProperty.call(prevDraft.agents, id)) {
          routingDraft.agents[id] = prevDraft.agents[id];
        }
        if (prevBaseline && Object.prototype.hasOwnProperty.call(prevBaseline, id)) {
          routingDefaultBaseline[id] = prevBaseline[id];
        }
      });
    }
    if (payload && payload.envProbe && typeof payload.envProbe === "object") {
      Object.keys(payload.envProbe).forEach(function (name) {
        routingEnvProbe[name] = normalizeEnvProbeEntry(payload.envProbe[name]);
      });
    }
    renderRoutingModal();
  }

  function handleRoutingSaved(msg) {
    // Flat on the message (not under payload) — both panel.ts's
    // _handleSaveRouting/_handleClearRouting and server.mjs's saveRouting/
    // clearRouting cases post `{ type: MSG.ROUTING_SAVED, ...result }`.
    routingSaving = false;
    routingLastResult = msg ? { ok: msg.ok, errors: msg.errors, check: msg.check, write: msg.write } : null;
    if (msg && msg.ok === false) routingSuppressNextRebuild = true;
    if (msg && msg.ok === false) {
      var errText = (msg.errors && msg.errors.length) ? msg.errors.join("; ") : "Save failed";
      showToast(errText, "error");
    } else if (msg) {
      showToast("Saved to disk", "success");
    }
    renderRoutingModal();
    // p17-t4: a successful save can change routing.json's `defaults` slot,
    // which the Settings screen's harness.needsDefaultRoute hint depends on
    // (see renderHarnessSection) — refetch settings so a filled-in default
    // makes the hint disappear without requiring a panel reload.
    if (msg && msg.ok !== false) {
      vscode.postMessage({ type: "getSettings" });
    }
  }

  function handleEnvProbeReply(msg) {
    var probe = (msg && msg.payload) || {};
    Object.keys(probe).forEach(function (name) {
      routingEnvProbe[name] = normalizeEnvProbeEntry(probe[name]);
      updateRoutingEnvDots(name);
    });
  }

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

    // ── Legacy/foreign managed CLAUDE.md block removal (Settings entry point) ──
    // Same affordance as the Setup Wizard Step-2 rows (renderSetupOptionals)
    // for users who already had hooks installed before this feature shipped
    // and so never see the wizard. One row per detected non-tycoon managed
    // block (legacy config carried over from a prior setup, or a
    // currently-installed other tool's own block). Clicking Remove posts
    // "removeManagedBlock" with that block's namespace, which re-triggers
    // _handleGetSettings host-side, reposting "settings" with the block gone
    // from foreignManagedBlocks, so the row disappears (replaced by a
    // "✓ Removed" line) on the next renderSettings() without a manual reload.
    const settingsForeignBlocks = Array.isArray(lastSettings.foreignManagedBlocks)
      ? lastSettings.foreignManagedBlocks
      : [];
    settingsForeignBlocks.forEach(function (block) {
      const ns = block.namespace;
      const legacyRow = document.createElement("div");
      legacyRow.id = "settings-managed-block-row-" + ns;
      legacyRow.className = "settings-row";
      const legacyText = document.createElement("span");
      const lineNote = typeof block.lines === "number" && block.lines > 0 ? " (" + block.lines + " lines)" : "";
      legacyText.textContent = "Legacy config block `" + ns + ":*` detected in CLAUDE.md" + lineNote;
      legacyRow.appendChild(legacyText);
      const legacyBtn = document.createElement("button");
      legacyBtn.id = "settings-remove-managed-block-btn-" + ns;
      legacyBtn.className = "skill-btn settings-btn";
      legacyBtn.textContent = "Remove";
      legacyBtn.addEventListener("click", () => {
        legacyBtn.disabled = true;
        legacyBtn.textContent = "Removing…";
        managedBlockRemovalRequested.add(ns);
        vscode.postMessage({ type: "removeManagedBlock", namespace: ns });
      });
      legacyRow.appendChild(legacyBtn);
      hookSection.appendChild(legacyRow);
    });
    managedBlockRemovalRequested.forEach(function (ns) {
      const stillPresent = settingsForeignBlocks.some(function (b) {
        return b.namespace === ns;
      });
      if (!stillPresent) {
        const legacyConfirm = document.createElement("p");
        legacyConfirm.id = "settings-managed-block-confirm-" + ns;
        legacyConfirm.className = "settings-empty";
        legacyConfirm.textContent = "✓ Removed legacy config block `" + ns + ":*`";
        hookSection.appendChild(legacyConfirm);
      }
    });

    setupConfigEl.appendChild(hookSection);

    // ── 1a. Path Health ──
    // Moved out of Settings into its own "UEFN / Verse" modal (see
    // renderUefnModalBody()) so the Settings screen is less overwhelming.
    // renderUefnModalBody() is called independently wherever this data
    // changes (installState/settings pushes) and on modal open — see the
    // "UEFN / Verse modal" wiring block for the full render-timing story.
    // In its place, a single compact "UEFN health" summary line (green/
    // yellow only) plus a button to open that modal — rendered ONLY when
    // isUefnInstalledInProject() is true (UEFN skill/pack/MCP installed in
    // THIS project), so a non-UEFN project sees nothing here.
    const uefnHealthRow = buildUefnHealthSummaryRow();
    if (uefnHealthRow) {
      setupConfigEl.appendChild(uefnHealthRow);
    }

    // ── 1.4b. Harness selection (p13-t7, refactored p20-t2) ──
    // "Which tool runs your agents?" dropdown, built by the same shared
    // helper the Agents screen header uses (buildHarnessControl) so both
    // copies stay in lockstep. Settings adds an "Open Agents" link plus the
    // OpenCode default-route nudge; the Use-multiple-LLMs toggle and
    // hidden-profile disclosure are gone — visibility of the routing editor
    // is now purely a function of the harness (see renderRoutingModal).
    if (lastSettings.harness) {
      const harness = lastSettings.harness;
      const harnessSection = buildSection("Agent harness");
      const harnessRow = buildHarnessControl("settings");
      if (harnessRow) harnessSection.appendChild(harnessRow);

      // Exactly one "Open Agents" link in this section (2026-09-05 fix):
      // when the OpenCode needsDefaultRoute hint shows, its own trailing
      // link is the single link; otherwise show a standalone link in its
      // place. See computeNeedsDefaultRoute in src/core/routingHostOps.ts
      // (shared by both host settings builders). Recomputed on every
      // settings payload, so this reflects the live state each render.
      if (harness.needsDefaultRoute && harness.effective === "opencode") {
        const defaultRouteHint = document.createElement("p");
        defaultRouteHint.className = "delegation-mode-footnote settings-harness-default-route-hint";
        defaultRouteHint.textContent =
          "OpenCode runs each agent on its routed model. Set a default model your OpenCode install can reach. ";
        const openRoutingLink = document.createElement("button");
        openRoutingLink.type = "button";
        openRoutingLink.className = "link-button";
        openRoutingLink.textContent = "Open Agents";
        openRoutingLink.addEventListener("click", () => {
          openRoutingModal();
        });
        defaultRouteHint.appendChild(openRoutingLink);
        harnessSection.appendChild(defaultRouteHint);
      } else {
        const openAgentsRow = document.createElement("p");
        openAgentsRow.className = "delegation-mode-footnote";
        const openAgentsLink = document.createElement("button");
        openAgentsLink.type = "button";
        openAgentsLink.className = "link-button";
        openAgentsLink.textContent = "Open Agents";
        openAgentsLink.addEventListener("click", () => {
          openRoutingModal();
        });
        openAgentsRow.appendChild(openAgentsLink);
        harnessSection.appendChild(openAgentsRow);
      }

      setupConfigEl.appendChild(harnessSection);
    }

    // ── 1.4d. Menu "Agents" entry (p19-t1) ──
    // #menu-routing (label now "Agents") is static markup (both hosts' HTML
    // template) and is always visible — the Agents screen itself picks its
    // density from lastSettings.harness (p20-t2), so there is no gating to
    // apply here any more.

    // ── 1.5. Delegation style (Team Lead Mode, Phase 2) ──
    // Same radio block + exact copy as the pre-install setup-view picker
    // (#delegation-mode-group in the HTML), rebuilt here so it reflects the
    // project's actual current mode and applies changes immediately.
    const delegSection = buildSection("Delegation style");
    const delegRow = document.createElement("div");
    delegRow.className = "settings-row";
    delegRow.dataset.agentRow = "delegation-mode";
    const delegGroup = document.createElement("div");
    delegGroup.className = "delegation-mode-group";
    const currentDelegationMode = lastSettings.delegation_mode === "team_leads" ? "team_leads" : "flat";
    const delegOptions = [
      {
        value: "flat",
        label: "Flat — no team leads (recommended for most projects)",
        help: "The orchestrator briefs specialist workers directly — it does the reviewing itself. Lowest coordination cost; best for focused fixes.",
      },
      {
        value: "team_leads",
        label: "Team leads",
        help: "Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs — many features across many files — where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Flat.",
      },
    ];
    const delegInputs = [];
    for (const opt of delegOptions) {
      const optLabel = document.createElement("label");
      optLabel.className = "delegation-mode-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "settings-delegation-mode";
      input.value = opt.value;
      if (currentDelegationMode === opt.value) input.checked = true;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        delegInputs.forEach((el) => { el.disabled = true; });
        vscode.postMessage({ type: "setDelegationMode", delegation_mode: opt.value });
      });
      delegInputs.push(input);
      const body = document.createElement("span");
      body.className = "delegation-mode-option-body";
      const labelSpan = document.createElement("span");
      labelSpan.className = "delegation-mode-option-label";
      labelSpan.textContent = opt.label;
      const helpSpan = document.createElement("span");
      helpSpan.className = "delegation-mode-option-help";
      helpSpan.textContent = opt.help;
      body.appendChild(labelSpan);
      body.appendChild(helpSpan);
      optLabel.appendChild(input);
      optLabel.appendChild(body);
      delegGroup.appendChild(optLabel);
    }
    const delegFootnote = document.createElement("p");
    delegFootnote.className = "delegation-mode-footnote";
    delegFootnote.textContent = "You can change this anytime in Settings. Switching updates this project's agent roster and delegation instructions.";
    delegGroup.appendChild(delegFootnote);
    delegRow.appendChild(delegGroup);
    delegSection.appendChild(delegRow);
    setupConfigEl.appendChild(delegSection);

    // ── 1.5b. Review pass (optional, on by default) ──
    // Composes with either delegation style above rather than being a third
    // radio — a separate checkbox row in the same "Delegation style" section.
    const reviewRow = document.createElement("div");
    reviewRow.className = "settings-row";
    reviewRow.dataset.agentRow = "review-enabled";
    const reviewGroup = document.createElement("div");
    reviewGroup.className = "delegation-mode-group";
    const reviewOptLabel = document.createElement("label");
    reviewOptLabel.className = "delegation-mode-option review-pass-option";
    const reviewCheckbox = document.createElement("input");
    reviewCheckbox.type = "checkbox";
    reviewCheckbox.id = "review-pass-enabled-checkbox";
    // Absent/undefined reads as enabled — the toggle is on by default.
    reviewCheckbox.checked = lastSettings.reviewEnabled !== false;
    reviewCheckbox.addEventListener("change", () => {
      reviewCheckbox.disabled = true;
      vscode.postMessage({ type: "setReviewEnabled", enabled: reviewCheckbox.checked });
    });
    const reviewBody = document.createElement("span");
    reviewBody.className = "delegation-mode-option-body";
    const reviewLabelSpan = document.createElement("span");
    reviewLabelSpan.className = "delegation-mode-option-label";
    reviewLabelSpan.textContent = "Review pass (optional, on by default)";
    const reviewHelpSpan = document.createElement("span");
    reviewHelpSpan.className = "delegation-mode-option-help";
    reviewHelpSpan.textContent = "Routes each significant change through a reviewer agent before it's marked done. Catches bugs and regressions early; roughly 20-40% more tokens on non-trivial tasks. Turn off for speed/lowest cost.";
    reviewBody.appendChild(reviewLabelSpan);
    reviewBody.appendChild(reviewHelpSpan);
    reviewOptLabel.appendChild(reviewCheckbox);
    reviewOptLabel.appendChild(reviewBody);
    reviewGroup.appendChild(reviewOptLabel);
    reviewRow.appendChild(reviewGroup);
    delegSection.appendChild(reviewRow);

    // ── 1.5c. Session journal (optional, off by default) ──
    // Rolling log of the last N prompts + a one-line summary, so a new
    // session can pick up where the last one left off. Grouped right next
    // to the review-pass row since both are delegation/behavior toggles.
    // A range input is preferred, but the settings panel itself has no
    // range-input precedent (the .se-range sliders live in the Stage
    // Editor's #stage-edit-panel, a different surface) — a <select>
    // matches this panel's established look instead (see feedbackCategoryEl).
    const journalRow = document.createElement("div");
    journalRow.className = "settings-row";
    journalRow.dataset.agentRow = "session-journal-entries";
    const journalGroup = document.createElement("div");
    journalGroup.className = "delegation-mode-group";
    const journalOptLabel = document.createElement("div");
    journalOptLabel.className = "delegation-mode-option";
    const journalBody = document.createElement("span");
    journalBody.className = "delegation-mode-option-body";
    const journalLabelSpan = document.createElement("span");
    journalLabelSpan.className = "delegation-mode-option-label";
    journalLabelSpan.textContent = "Session journal";
    const journalHelpSpan = document.createElement("span");
    journalHelpSpan.className = "delegation-mode-option-help";
    journalHelpSpan.textContent = "Keeps the last N prompts with a one-line summary of what was done, so a new session can pick up where the last one left off. Off by default.";
    const journalSelect = document.createElement("select");
    journalSelect.id = "session-journal-entries-select";
    journalSelect.className = "session-journal-select";
    journalSelect.setAttribute("aria-label", "Session journal entries to keep");
    for (let n = 0; n <= 5; n++) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n === 0 ? "Off" : String(n);
      journalSelect.appendChild(opt);
    }
    // Clamp defensively — the contract is an integer 0-5, but don't trust
    // a stale/out-of-range value from an older settings payload.
    const currentJournalEntries = Math.max(0, Math.min(5, parseInt(lastSettings.sessionJournalEntries, 10) || 0));
    journalSelect.value = String(currentJournalEntries);
    const journalWarning = document.createElement("p");
    journalWarning.className = "theme-review-retry-warning";
    journalWarning.id = "session-journal-privacy-warning";
    journalWarning.textContent = "Stores your prompt text on disk at .claude/session-journal.json — added to .gitignore when the project uses git.";
    if (currentJournalEntries === 0) journalWarning.setAttribute("hidden", "");
    journalSelect.addEventListener("change", () => {
      journalSelect.disabled = true;
      const entries = Math.max(0, Math.min(5, parseInt(journalSelect.value, 10) || 0));
      if (entries > 0) journalWarning.removeAttribute("hidden");
      else journalWarning.setAttribute("hidden", "");
      vscode.postMessage({ type: "setSessionJournalEntries", entries });
    });
    journalBody.appendChild(journalLabelSpan);
    journalBody.appendChild(journalHelpSpan);
    journalBody.appendChild(journalSelect);
    journalBody.appendChild(journalWarning);
    journalOptLabel.appendChild(journalBody);
    journalGroup.appendChild(journalOptLabel);
    journalRow.appendChild(journalGroup);
    delegSection.appendChild(journalRow);

    // ── 1.6. Project Plan (optional) ──
    // Opt-in toggle for the Project Plan tab in the metrics panel (see
    // #project-plan-body / renderProjectPlanSection()).
    // Reuses the same checkbox-row visual language as the theme builder's
    // "Pause after each image" toggle.
    const planSection = buildSection("Project Plan");
    const planRow = document.createElement("div");
    planRow.className = "settings-row";
    planRow.dataset.agentRow = "project-plan-enabled";
    const planLabel = document.createElement("label");
    planLabel.className = "theme-generation-approval-toggle";
    const planCheckbox = document.createElement("input");
    planCheckbox.type = "checkbox";
    planCheckbox.id = "project-plan-enabled-checkbox";
    planCheckbox.checked = projectPlanEnabled;
    planCheckbox.addEventListener("change", () => {
      vscode.postMessage({ type: "SET_PROJECT_PLAN_ENABLED", enabled: planCheckbox.checked });
    });
    projectPlanCheckboxEl = planCheckbox;
    const planTextWrap = document.createElement("span");
    const planTitle = document.createElement("span");
    planTitle.textContent = "Project Plan (optional, experimental)";
    const planNote = document.createElement("small");
    planNote.textContent = "Opt-in phase/task planning workflow with approve/retry controls. Off by default.";
    planTextWrap.appendChild(planTitle);
    planTextWrap.appendChild(planNote);
    planLabel.appendChild(planCheckbox);
    planLabel.appendChild(planTextWrap);
    planRow.appendChild(planLabel);
    planSection.appendChild(planRow);
    const planInstallHint = document.createElement("p");
    planInstallHint.className = "settings-empty";
    planInstallHint.textContent = "Auto-installed and kept up to date whenever Project Plan is enabled above — use this only to repair a damaged install.";
    planSection.appendChild(planInstallHint);
    const planInstallBtn = document.createElement("button");
    planInstallBtn.className = "skill-btn settings-btn";
    planInstallBtn.textContent = "Reinstall / Repair skill";
    planInstallBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "projectPlanAction" });
    });
    planSection.appendChild(planInstallBtn);
    setupConfigEl.appendChild(planSection);


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

      // Agent file rows. Size alone is not a defect for an agent file — a
      // legitimately large REFERENCE/knowledge agent (e.g. a domain-expert
      // agent) is correctly large by design, so "warn"/"high" here read as
      // informational, not as a "trim this" verdict — never single out a
      // specific agent as bloat.
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
        if (af.grade === "warn" || af.grade === "high") {
          agentText.textContent += " (large — reference agents can be intentionally large)";
        }
        agentRow.appendChild(agentText);
        budgetSection.appendChild(agentRow);
      }

      // Muted note
      const agentNote = document.createElement("p");
      agentNote.className = "settings-empty";
      agentNote.textContent = "Agent files load per sub-agent spawn, not every prompt. Size alone isn't a problem — a reference/knowledge agent is expected to be larger.";
      budgetSection.appendChild(agentNote);

      // Review for trimming button
      const trimBtn = document.createElement("button");
      trimBtn.className = "skill-btn settings-btn";
      trimBtn.textContent = "Review for trimming";
      trimBtn.addEventListener("click", () => {
        vscode.postMessage({ type: "copyPrompt", text: "Do not modify, reword, condense, or remove the TycoonAgents-managed block in CLAUDE.md or any delegation routing rule anywhere in CLAUDE.md or the agent definitions, and never remove or alter the <!-- tycoon:delegation --> and <!-- /tycoon:delegation --> comment markers that bound that block — TycoonAgents uses them to locate and repair its section, and trimming that content or those markers breaks agent delegation. Outside of that, review CLAUDE.md and the agent definition files in .claude/agents/ for context that can be tightened: flag verbose, duplicated, or non-essential lines and propose a tighter rewrite that preserves every behavioral rule and the delegation routing. Then look at each .claude/agents/*.md (loaded per spawn, not every prompt) — but only flag a file if it has genuine verbosity or duplication to cut; a large reference/knowledge agent (e.g. a domain-expert agent with a big fact table) can be intentionally large and should not be flagged just because of its size. For any file with real cuts available, give a before/after token estimate and the specific cuts." });
      });
      budgetSection.appendChild(trimBtn);
    }

    // Legacy/foreign managed CLAUDE.md blocks (see legacyDoctrine.ts
    // detectForeignManagedBlocks) are surfaced with an actionable Remove
    // row under "Hook health" above, not duplicated here.

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

    // ── 5. Report a bug / Diagnostics ──
    // Sanitized Markdown snapshot of the health signals already computed
    // above (hook health, delegation mode, doctrine health, context budget,
    // roster consistency, engine/UEFN status) — see diagnosticReport.ts.
    // Purely local: no network call, no runtime AI. The host writes the
    // report, opens it for review, and copies it to the clipboard so the
    // user can paste it wherever they report bugs.
    const diagSection = buildSection("Report a bug / Diagnostics");
    const diagDesc = document.createElement("p");
    diagDesc.className = "settings-empty";
    diagDesc.textContent = "Creates a sanitized report of your TycoonAgents setup you can send to the maintainer. Absolute paths and secrets are stripped — review before sharing.";
    diagSection.appendChild(diagDesc);
    const diagDeeperNote = document.createElement("p");
    diagDeeperNote.className = "settings-empty";
    diagDeeperNote.textContent = "For a deeper, reasoned analysis, run /tycoon-diagnose in Claude Code.";
    diagSection.appendChild(diagDeeperNote);
    const diagBtn = document.createElement("button");
    diagBtn.className = "skill-btn settings-btn";
    diagBtn.textContent = "Generate diagnostic report";
    diagBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "generateDiagnostic" });
    });
    diagSection.appendChild(diagBtn);
    setupConfigEl.appendChild(diagSection);

    // ── 5b. Submit feedback ──
    // Moved out of Settings into its own "Feedback" modal — see
    // renderFeedbackModalBody() (defined near the other feedback helpers
    // above), called from the "menu-feedback" click handler. Doesn't read
    // lastSettings, so unlike Path Health it only needs to build once per
    // modal open, not on every settings/installState push.

    // ── 6. Danger zone ──
    const dangerSection = buildSection("Danger zone");
    dangerSection.classList.add("danger-section");
    const dangerRow = document.createElement("div");
    dangerRow.className = "settings-row danger-row";
    const resetBtn = document.createElement("button");
    resetBtn.className = "skill-btn settings-btn danger-btn";
    resetBtn.textContent = "Reset session metrics";
    resetBtn.addEventListener("click", () => {
      showResetConfirmModal();
    });
    dangerStatusEl = document.createElement("span");
    dangerStatusEl.className = "danger-status";
    dangerRow.appendChild(resetBtn);
    dangerRow.appendChild(dangerStatusEl);
    dangerSection.appendChild(dangerRow);
    setupConfigEl.appendChild(dangerSection);
  }

  // drawWorker (placeholder stick figures) and drawBuildings (placeholder
  // cityscape) were removed: entities render only as real themed art, popping
  // in on their first decoded frame. See the sprite draw paths in render().

