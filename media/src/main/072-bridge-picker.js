// Part: 72-bridge-picker
// Multi-LLM pack picker (one checkbox per model + "Other" OpenAI-compatible
// endpoint) and the "Needs setup" badge for installed bridge agents. Env var
// NAMES only are ever shown or sent; key values go through the existing
// per-user key entry UI (Agents > Routing), never through this picker.

  /** Pack id -> picker UI state, kept across packs-list re-renders. */
  var bridgePickerState = {};

  function bridgePickerStateFor(packId) {
    if (!bridgePickerState[packId]) {
      bridgePickerState[packId] = { open: false, checked: {}, others: [], formOpen: false, message: "", busy: false };
    }
    return bridgePickerState[packId];
  }

  /**
   * One-line status for a bridge: server + key/sign-in, names only.
   * @param {any} setup BridgeSetupInfo from the host (may be null)
   * @returns {{text:string, warn:boolean}}
   */
  function bridgeStatusSummary(setup) {
    if (!setup) return { text: "No setup needed", warn: false };
    const bits = [];
    if (setup.serverState === "missing") bits.push("Server not installed");
    else if (setup.serverState === "installed") bits.push("Server ready");
    else if (setup.serverState === "dispatcher") bits.push("Runs through the dispatcher");
    const env = Array.isArray(setup.env) ? setup.env : [];
    const missing = env.filter(function (e) { return e.required && !e.present; });
    if (missing.length) {
      bits.push("Missing " + missing.map(function (e) { return e.name; }).join(", "));
    } else if (setup.keyState === "signin") {
      bits.push("Uses your " + (setup.signIn || "CLI") + " sign-in");
    } else if (env.some(function (e) { return e.kind === "credential" && e.present; })) {
      bits.push("Key set (" + env.filter(function (e) { return e.kind === "credential" && e.present; }).map(function (e) { return e.name; }).join(", ") + ")");
    }
    return { text: bits.join(" · "), warn: !!setup.needsSetup };
  }

  /** Slug rule mirrored from src/core/bridgeSetup.ts (host re-validates). */
  var BRIDGE_SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;
  var BRIDGE_ENDPOINT_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}_BASE_URL$/;
  var BRIDGE_KEY_ENV_RE = /^[A-Z][A-Z0-9_]*(_API_KEY|_KEY|_TOKEN)$/;

  function bridgeKnownAgentIds(pack) {
    const ids = new Set();
    if (lastSettings && Array.isArray(lastSettings.agents)) {
      for (const a of lastSettings.agents) if (a && a.id) ids.add(String(a.id).toLowerCase());
    }
    if (pack && Array.isArray(pack.agents)) for (const a of pack.agents) ids.add(String(a.id).toLowerCase());
    if (pack && pack.picker && Array.isArray(pack.picker.others)) for (const o of pack.picker.others) ids.add(String(o.agentId).toLowerCase());
    return ids;
  }

  function toggleBridgePicker(packId) {
    const st = bridgePickerStateFor(packId);
    st.open = !st.open;
    st.message = "";
    const panel = packsListEl ? packsListEl.querySelector('[data-bridge-picker="' + CSS.escape(packId) + '"]') : null;
    if (panel) panel.hidden = !st.open;
  }

  function bridgeField(labelText, input, hint) {
    const wrap = document.createElement("label");
    wrap.className = "bridge-other-field";
    const lab = document.createElement("span");
    lab.className = "bridge-other-label";
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    if (hint) {
      const h = document.createElement("span");
      h.className = "bridge-other-hint";
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  function bridgeTextInput(name, placeholder, maxLen) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "bridge-other-input";
    inp.name = name;
    inp.placeholder = placeholder || "";
    inp.maxLength = maxLen || 120;
    inp.autocomplete = "off";
    inp.spellcheck = false;
    return inp;
  }

  /**
   * Build the picker panel for a picker pack. Hidden until the pack's
   * "Choose models" button is clicked; state survives list re-renders.
   * @param {any} pack
   */
  function buildBridgePickerPanel(pack) {
    const st = bridgePickerStateFor(pack.id);
    const picker = pack.picker || { models: [], others: [], dispatcherHost: false };
    const panel = document.createElement("div");
    panel.className = "bridge-picker";
    panel.setAttribute("data-bridge-picker", pack.id);
    panel.hidden = !st.open;

    const intro = document.createElement("p");
    intro.className = "bridge-picker-note";
    intro.textContent = picker.dispatcherHost
      ? "Tick the models you use. This project runs bridges through the TycoonAgents dispatcher, so only the agent files are added; nothing is written to .mcp.json."
      : "Tick the models you use. Each one is installed with the MCP server it needs; Claude Code asks you to approve a new server the first time it is used.";
    panel.appendChild(intro);

    const list = document.createElement("ul");
    list.className = "bridge-picker-list";
    for (const m of picker.models || []) {
      if (st.checked[m.agentId] === undefined) st.checked[m.agentId] = !!m.installed;
      const li = document.createElement("li");
      li.className = "bridge-picker-row";
      li.setAttribute("data-bridge-model", m.agentId);
      const lab = document.createElement("label");
      lab.className = "bridge-picker-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!st.checked[m.agentId];
      cb.setAttribute("data-bridge-agent", m.agentId);
      cb.addEventListener("change", function () { st.checked[m.agentId] = cb.checked; });
      lab.appendChild(cb);
      const nm = document.createElement("span");
      nm.className = "bridge-picker-name";
      nm.textContent = m.label + (m.installed ? " (installed)" : "");
      lab.appendChild(nm);
      li.appendChild(lab);
      const status = bridgeStatusSummary(m.setup);
      const stEl = document.createElement("span");
      stEl.className = "bridge-status" + (status.warn ? " bridge-status--warn" : " bridge-status--ok");
      stEl.textContent = status.text;
      li.appendChild(stEl);
      if (m.setup && Array.isArray(m.setup.env) && m.setup.env.some(function (e) { return e.required && !e.present; })) {
        const keyLink = document.createElement("button");
        keyLink.type = "button";
        keyLink.className = "link-button bridge-key-link";
        keyLink.textContent = "Enter key in Agents";
        keyLink.addEventListener("click", function () { openRoutingModal(); });
        li.appendChild(keyLink);
      }
      list.appendChild(li);
    }
    for (const o of picker.others || []) {
      const li = document.createElement("li");
      li.className = "bridge-picker-row bridge-picker-row--other";
      li.setAttribute("data-bridge-other-installed", o.agentId);
      const nm = document.createElement("span");
      nm.className = "bridge-picker-name";
      nm.textContent = o.label + " (custom endpoint, installed)";
      li.appendChild(nm);
      const status = bridgeStatusSummary(o.setup);
      const stEl = document.createElement("span");
      stEl.className = "bridge-status" + (status.warn ? " bridge-status--warn" : " bridge-status--ok");
      stEl.textContent = status.text;
      li.appendChild(stEl);
      list.appendChild(li);
    }
    st.others.forEach(function (o, idx) {
      const li = document.createElement("li");
      li.className = "bridge-picker-row bridge-picker-row--other";
      li.setAttribute("data-bridge-other-pending", o.agentId);
      const nm = document.createElement("span");
      nm.className = "bridge-picker-name";
      nm.textContent = o.label + " (custom endpoint, will be added)";
      li.appendChild(nm);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "link-button";
      rm.textContent = "Remove";
      rm.addEventListener("click", function () {
        st.others.splice(idx, 1);
        renderPacksList(lastPacks);
      });
      li.appendChild(rm);
      list.appendChild(li);
    });
    panel.appendChild(list);

    // "Other (OpenAI-compatible endpoint)" form.
    const otherBtn = document.createElement("button");
    otherBtn.type = "button";
    otherBtn.className = "link-button bridge-other-toggle";
    otherBtn.textContent = st.formOpen ? "Hide Other (OpenAI-compatible endpoint)" : "Add Other (OpenAI-compatible endpoint)…";
    otherBtn.addEventListener("click", function () {
      st.formOpen = !st.formOpen;
      renderPacksList(lastPacks);
    });
    panel.appendChild(otherBtn);

    if (st.formOpen) {
      const form = document.createElement("div");
      form.className = "bridge-other-form";
      const help = document.createElement("p");
      help.className = "bridge-picker-note";
      help.textContent = "For a local model (Ollama, LM Studio, a VM-hosted model) or any provider with an OpenAI-compatible API. Enter variable NAMES; the key value is stored on this machine through the Agents key fields, never in your project.";
      form.appendChild(help);
      const fName = bridgeTextInput("agentId", "my-local-model", 40);
      const fLabel = bridgeTextInput("label", "My local model", 60);
      const fModel = bridgeTextInput("model", "llama3", 120);
      const fUrlEnv = bridgeTextInput("endpointEnv", "OLLAMA_BASE_URL", 64);
      const fKeyEnv = bridgeTextInput("apiKeyEnv", "OLLAMA_API_KEY (optional)", 64);
      const fUrl = bridgeTextInput("baseUrl", "http://localhost:11434/v1 (optional)", 300);
      const fRole = bridgeTextInput("role", "Optional one-line role", 240);
      const fKw = bridgeTextInput("keywords", "Optional routing keywords, e.g. local|ollama", 200);
      form.appendChild(bridgeField("Agent name", fName, "Lower-case letters, digits and hyphens."));
      form.appendChild(bridgeField("Display label", fLabel));
      form.appendChild(bridgeField("Model id", fModel));
      form.appendChild(bridgeField("Base URL variable name", fUrlEnv, "Must end in _BASE_URL."));
      form.appendChild(bridgeField("API key variable name", fKeyEnv, "Optional for a local server. Name only."));
      form.appendChild(bridgeField("Base URL value", fUrl, "Optional. https, or http for localhost only. Stored on this machine, not in the project."));
      form.appendChild(bridgeField("Role", fRole));
      form.appendChild(bridgeField("Keywords", fKw));
      const formErr = document.createElement("div");
      formErr.className = "skill-install-error bridge-other-error";
      formErr.setAttribute("role", "alert");
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "skill-btn";
      addBtn.textContent = "Add endpoint";
      addBtn.addEventListener("click", function () {
        const spec = {
          agentId: fName.value.trim(),
          label: fLabel.value.trim(),
          model: fModel.value.trim(),
          endpointEnv: fUrlEnv.value.trim(),
        };
        if (fKeyEnv.value.trim()) spec.apiKeyEnv = fKeyEnv.value.trim();
        if (fUrl.value.trim()) spec.baseUrl = fUrl.value.trim();
        if (fRole.value.trim()) spec.role = fRole.value.trim();
        if (fKw.value.trim()) spec.keywords = fKw.value.trim();
        let problem = "";
        const known = bridgeKnownAgentIds(pack);
        if (!BRIDGE_SLUG_RE.test(spec.agentId)) problem = "Agent name must be a lower-case slug (letters, digits, hyphens; starts with a letter).";
        else if (known.has(spec.agentId.toLowerCase()) || st.others.some(function (o) { return o.agentId === spec.agentId; })) problem = "An agent named \"" + spec.agentId + "\" already exists.";
        else if (!spec.label) problem = "Enter a display label.";
        else if (!spec.model) problem = "Enter a model id.";
        else if (!BRIDGE_ENDPOINT_ENV_RE.test(spec.endpointEnv)) problem = "Base URL variable must be upper case and end in _BASE_URL, e.g. OLLAMA_BASE_URL.";
        else if (spec.apiKeyEnv && !BRIDGE_KEY_ENV_RE.test(spec.apiKeyEnv)) problem = "API key variable must look like OLLAMA_API_KEY (ends in _API_KEY, _KEY or _TOKEN).";
        if (problem) {
          formErr.textContent = problem;
          return;
        }
        st.others.push(spec);
        st.formOpen = false;
        renderPacksList(lastPacks);
      });
      form.appendChild(addBtn);
      form.appendChild(formErr);
      panel.appendChild(form);
    }

    const actions = document.createElement("div");
    actions.className = "bridge-picker-actions";
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "skill-btn";
    installBtn.setAttribute("data-bridge-install", pack.id);
    installBtn.textContent = st.busy ? "Installing…" : "Install selected";
    installBtn.disabled = !!st.busy;
    installBtn.addEventListener("click", function () {
      const agents = Object.keys(st.checked).filter(function (k) { return st.checked[k]; });
      if (agents.length === 0 && st.others.length === 0) {
        st.message = "Tick at least one model first.";
        renderPacksList(lastPacks);
        return;
      }
      st.busy = true;
      st.message = "";
      installBtn.textContent = "Installing…";
      installBtn.disabled = true;
      vscode.postMessage({
        type: "installPack",
        id: pack.id,
        thirdParty: false,
        disclosures: [],
        selection: { agents: agents, others: st.others.slice() },
      });
    });
    actions.appendChild(installBtn);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "link-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", function () { toggleBridgePicker(pack.id); });
    actions.appendChild(closeBtn);
    panel.appendChild(actions);

    const msg = document.createElement("div");
    msg.className = "skill-install-error bridge-picker-error";
    msg.setAttribute("role", "alert");
    msg.textContent = st.message || "";
    panel.appendChild(msg);
    return panel;
  }

  /**
   * packInstalled for a picker pack. Returns true when handled (the caller skips
   * the generic single-button logic).
   */
  function handleBridgePackInstalled(id, ok, results, error, cancelled) {
    const panel = packsListEl ? packsListEl.querySelector('[data-bridge-picker="' + CSS.escape(id) + '"]') : null;
    if (!panel) return false;
    const st = bridgePickerStateFor(id);
    st.busy = false;
    if (cancelled) {
      renderPacksList(lastPacks);
      return true;
    }
    const notes = [];
    if (results && results.mcp) {
      for (const k of Object.keys(results.mcp)) {
        const v = results.mcp[k];
        if (v && typeof v === "object" && v.error) notes.push("Could not add " + k + ": " + v.error);
      }
    }
    if (results && Array.isArray(results.agents)) {
      for (const a of results.agents) if (a.status === "error" || a.status === "skipped") notes.push(a.id + ": " + (a.error || a.status));
    }
    if (ok && notes.length === 0) {
      st.open = false;
      st.others = [];
      st.checked = {};
      st.message = "";
    } else {
      st.message = [error].concat(notes).filter(Boolean).join(" ");
    }
    vscode.postMessage({ type: "getPacks" });
    renderPacksList(lastPacks);
    return true;
  }

  /**
   * Agents-screen "Needs setup" badge + actions for an installed bridge agent.
   * @param {any} a roster entry with bridgeSetup
   * @returns {HTMLElement|null}
   */
  function buildBridgeNeedsSetup(a) {
    const setup = a && a.bridgeSetup;
    if (!setup) return null;
    const wrap = document.createElement("div");
    wrap.className = "agent-bridge-setup";
    wrap.setAttribute("data-bridge-setup-agent", a.id);
    const status = bridgeStatusSummary(setup);
    if (setup.needsSetup) {
      const badge = document.createElement("span");
      badge.className = "agent-needs-setup-badge";
      badge.textContent = "Needs setup";
      badge.title = (setup.reasons || []).join("; ");
      wrap.appendChild(badge);
    }
    const txt = document.createElement("span");
    txt.className = "bridge-status" + (setup.needsSetup ? " bridge-status--warn" : " bridge-status--ok");
    txt.textContent = status.text;
    wrap.appendChild(txt);
    if (setup.serverState === "missing") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-button bridge-install-server";
      btn.textContent = "Install " + setup.server + " server";
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.textContent = "Installing…";
        vscode.postMessage({ type: "installBridgeServer", id: a.id });
      });
      wrap.appendChild(btn);
    }
    if ((setup.env || []).some(function (e) { return e.required && !e.present; })) {
      const keyBtn = document.createElement("button");
      keyBtn.type = "button";
      keyBtn.className = "link-button bridge-key-link";
      keyBtn.textContent = "Enter key in Agents";
      keyBtn.addEventListener("click", function () { openRoutingModal(); });
      wrap.appendChild(keyBtn);
    }
    return wrap;
  }

  function handleBridgeServerInstalled(id, ok, error) {
    const wrap = document.querySelector('[data-bridge-setup-agent="' + CSS.escape(id) + '"]');
    if (wrap && !ok) {
      let err = wrap.querySelector(".bridge-setup-error");
      if (!err) {
        err = document.createElement("span");
        err.className = "skill-install-error bridge-setup-error";
        wrap.appendChild(err);
      }
      err.textContent = error || "Could not add the server.";
      const b = wrap.querySelector(".bridge-install-server");
      if (b) {
        b.disabled = false;
        b.textContent = "Install server";
      }
    }
  }
