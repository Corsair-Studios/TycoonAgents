// Part: 100-slot-editor-settings
// Slot editor field builders and settings screen wiring.

  // ---------------------------------------------------------------------------
  // p25-t4: per-harness fallback-target dispatchability check, duplicated
  // (not imported) from src/core/fallbackTargets.ts's isFallbackTargetDispatchable
  // — media/main.js is a plain-JS concatenation build (scripts/build-webview.mjs)
  // with no module loader, so a compiled out/src/core/*.js cannot be required()
  // into the browser here. Keep this table in sync with fallbackTargets.ts by
  // hand; both are covered by the same case list (test/fallbackTargets.test.ts,
  // test/webviewSmoke.test.ts). This webview copy is a soft, UI-only check —
  // the host's saveRoutingProfile() (src/core/routingHostOps.ts) is the
  // authoritative gate that actually refuses a save.
  // ---------------------------------------------------------------------------
  var FALLBACK_TARGET_ANTHROPIC_LIKE = { anthropic: true };
  var FALLBACK_TARGET_OPENAI_COMPAT_LIKE = { "openai-compatible": true, local: true, moonshot: true };

  /**
   * @param {{vendor?: string}} slot
   * @param {string} harness
   * @param {boolean} geminiKeyPresent
   * @returns {{ok: boolean, reason?: string}}
   */
  function isFallbackTargetDispatchableWebview(slot, harness, geminiKeyPresent) {
    var vendor = slot && typeof slot.vendor === "string" ? slot.vendor.trim().toLowerCase() : "";
    if (!vendor) return { ok: true };
    if (harness === "codex") {
      if (FALLBACK_TARGET_ANTHROPIC_LIKE[vendor] || FALLBACK_TARGET_OPENAI_COMPAT_LIKE[vendor] || vendor === "openai") {
        return { ok: true };
      }
      if (vendor === "google") {
        return { ok: true, skip: true, reason: "Google fallbacks are skipped on the Codex host; the chain moves to the next entry" };
      }
      return { ok: false, reason: 'vendor "' + vendor + '" has no Codex dispatcher adapter' };
    }
    if (harness === "opencode") {
      return { ok: true, reason: 'opencode provider availability for "' + vendor + '" is not knowable offline' };
    }
    return { ok: true };
  }

  // Set once per renderRoutingModal() pass so buildFallbackEditor (which
  // does not otherwise receive the harness) can evaluate warnings without a
  // signature change at every call site.
  var routingCurrentHarness = "claude-code";
  var routingCurrentGeminiKeyPresent = false;
  // True when the render just produced at least one HARD (ok:false)
  // dispatchability warning — gates the Save button; a soft ok:true/reason
  // (e.g. opencode's "not knowable offline" note) never disables Save.
  var routingHasBlockingDispatchWarning = false;
  // p74 first-open fix follow-up (2026-09-23): live refs to the Settings
  // screen's "I use more than one AI provider" checkbox/help text, so a
  // later routing reply can update just this row (see
  // updateSettingsMultiProviderRow) instead of forcing a full
  // renderSettings() rebuild that would steal focus elsewhere in Settings.
  // Null when Settings hasn't rendered the row (not mounted, or hidden for
  // the OpenCode harness).
  var settingsMultiProviderCheckboxEl = null;
  var settingsMultiProviderHelpEl = null;

  /** Amber footnote (reuses the theme-review-retry-warning accent token) for an undispatchable fallback target. Returns null when `check.ok`. */
  function buildFallbackDispatchWarning(check) {
    if (check && check.ok === true && check.skip) {
      var soft = document.createElement("p");
      soft.className = "routing-fallback-dispatch-warning routing-fallback-skip-warning theme-review-retry-warning";
      soft.textContent = check.reason;
      return soft;
    }
    if (!check || check.ok !== false) return null;
    var note = document.createElement("p");
    note.className = "routing-fallback-dispatch-warning theme-review-retry-warning";
    note.textContent = "Not dispatchable under " + routingCurrentHarness + ": " + (check.reason || "unsupported target");
    return note;
  }

  // ---------------------------------------------------------------------------
  // p101: project .mcp.json facts (payload.bridge, computed host-side by
  // src/core/hostBridgeSettings.ts) used by the slot editor and fallback
  // editor. Absent on an older host -> every helper degrades to "unknown".
  // ---------------------------------------------------------------------------
  var GEMINI_AGY_MODEL_TEXT = "Gemini 3.5 Flash \u2014 set by Antigravity";
  var geminiBackendError = "";

  function routingBridgeInfo() {
    return (lastRoutingPayload && lastRoutingPayload.bridge) || null;
  }

  /** @returns {{known: boolean, serverPresent: boolean, value: string}} value is "agy" (wrapper default) or "gemini". */
  function geminiBackendState() {
    var g = routingBridgeInfo() && routingBridgeInfo().gemini;
    return { known: !!g, serverPresent: !!(g && g.serverPresent), value: g && g.value === "gemini" ? "gemini" : "agy" };
  }

  /** Warning text when a slot bridges via an MCP server that is not in .mcp.json, else "". */
  function missingMcpServerWarning(slot) {
    var bridge = routingBridgeInfo();
    if (!bridge || !slot || slot.transport !== "mcp" || !slot.mcpServer) return "";
    var names = bridge.mcpServers || [];
    if (names.indexOf(slot.mcpServer) !== -1) return "";
    return 'MCP server "' + slot.mcpServer + '" is not in .mcp.json, so this route cannot run until it is installed or the name is fixed.';
  }

  function buildMcpServerWarning(text) {
    if (!text) return null;
    var note = document.createElement("p");
    note.className = "routing-mcp-server-warning theme-review-retry-warning";
    note.textContent = text;
    return note;
  }

  /** Derived, read-only connection line for the Claude Code and Codex hosts (transport follows vendor + mcpServer). */
  function connectionLineText(slot) {
    var vendor = String(slot.vendor || "").toLowerCase();
    if (slot.transport === "mcp" && slot.mcpServer) return "Connection: via " + slot.mcpServer + " bridge";
    if (slot.transport === "openai-compatible") return "Connection: OpenAI-compatible endpoint";
    return vendor && vendor !== "anthropic" ? "Connection: native " + vendor + " (no bridge)" : "Connection: Native Claude";
  }

  /**
   * Gemini backend control: Antigravity sign-in | Paid key (Gemini CLI).
   * Writes GEMINI_MCP_BACKEND into the gemini server env of the project
   * .mcp.json (host-side, nothing else in the file changes).
   */
  function buildGeminiBackendControl() {
    var st = geminiBackendState();
    var row = document.createElement("div");
    row.className = "routing-field-row routing-field-row--full routing-gemini-backend";
    var label = document.createElement("label");
    label.textContent = "Gemini backend";
    row.appendChild(label);
    var sel = document.createElement("select");
    sel.setAttribute("data-field-key", "gemini.backend");
    [["agy", "Antigravity sign-in"], ["gemini", "Paid key (Gemini CLI)"]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      if (o[0] === st.value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.disabled = !st.serverPresent;
    sel.addEventListener("change", function () {
      geminiBackendError = "";
      vscode.postMessage({ type: ROUTING_MSG.SET_GEMINI_BACKEND, value: sel.value });
    });
    row.appendChild(sel);
    var hint = document.createElement("div");
    hint.className = "routing-env-note routing-gemini-backend-note";
    hint.textContent = !st.known
      ? "Backend unknown on this host."
      : !st.serverPresent
        ? 'No "gemini" server in .mcp.json; install the Gemini server to choose a backend (default: Antigravity).'
        : "Saved to .mcp.json (GEMINI_MCP_BACKEND). Claude Code must reload MCP servers (/mcp or Reload Window) after switching.";
    row.appendChild(hint);
    if (geminiBackendError) {
      var err = document.createElement("div");
      err.className = "routing-env-note theme-review-retry-warning";
      err.textContent = geminiBackendError;
      row.appendChild(err);
    }
    return row;
  }

  var EXTERNAL_SOURCE_LABELS = { "default": "default", "environment": "VS Code environment (MCP servers usually inherit it)" };

  /**
   * p101-t5: collapsible read-only box listing settings that live outside the
   * panel: effective value, where it comes from, where to change it. The
   * host computes everything (src/core/hostBridgeSettings.ts); no secrets.
   */
  function buildExternalSettingsBox(bridge) {
    var list = (bridge && bridge.externalSettings) || [];
    if (!list.length) return null;
    var box = document.createElement("details");
    box.className = "routing-external-settings";
    var summary = document.createElement("summary");
    summary.textContent = "Set outside the panel (" + list.length + ")";
    box.appendChild(summary);
    var help = document.createElement("p");
    help.className = "routing-defaults-help";
    help.textContent = "Read-only. These change runtime behaviour but are set in .mcp.json or your environment, then MCP servers must be reloaded.";
    box.appendChild(help);
    list.forEach(function (it) {
      var row = document.createElement("div");
      row.className = "routing-external-row";
      row.setAttribute("data-env-name", it.name);
      var head = document.createElement("div");
      head.className = "routing-external-head";
      var name = document.createElement("code");
      name.textContent = it.name;
      head.appendChild(name);
      var val = document.createElement("span");
      val.className = "routing-external-value";
      val.textContent = it.value;
      head.appendChild(val);
      var src = document.createElement("span");
      src.className = "routing-external-source";
      src.textContent = it.source === "mcp-json" ? ".mcp.json " + (it.server || "") + " env" : (EXTERNAL_SOURCE_LABELS[it.source] || it.source);
      head.appendChild(src);
      row.appendChild(head);
      var note = document.createElement("div");
      note.className = "routing-env-note";
      note.textContent = it.note + " " + it.where;
      row.appendChild(note);
      box.appendChild(row);
    });
    return box;
  }

  /** Per-host note atop the fallback chain editor. */
  function fallbackHostNoteText(harness) {
    if (harness === "opencode") return "Best-effort: switches model string";
    if (harness === "codex") return "Codex host: only vendors with a dispatcher adapter (anthropic, openai, openai-compatible, local, moonshot). Google is not supported on the Codex host.";
    return "Full fallback (dispatcher + hook)";
  }

  /**
   * `routingDraft.defaultFallback` isn't produced by buildRoutingDraft (owned
   * by 090-metrics-time-utils.js) — set here, right after every
   * `routingDraft = buildRoutingDraft(...)` call, so the picker has a working
   * copy without editing that file. `cloneRoutingSlot` is defined in
   * 090-metrics-time-utils.js but visible here — media/main.js concatenates
   * every part into one shared closure (scripts/build-webview.mjs).
   */
  function ensureDefaultFallbackDraft(draft, payload) {
    if (draft) draft.defaultFallback = cloneRoutingSlot((payload && payload.defaultFallback) || {});
    return draft;
  }

  // OpenCode + Claude: API key is the default route; the subscription route
  // (claude-cli MCP bridge, or an anthropic mcp slot billed as subscription)
  // is a per-user opt-in. Mirrors src/core/claudeSubscriptionBridge.ts.
  var CLAUDE_API_KEY_ENV_NAME = "ANTHROPIC_API_KEY";
  var CLAUDE_SUBSCRIPTION_NOTE = "Uses your own Claude Code CLI login. Anthropic's terms for third-party harnesses have changed several times; check them before relying on this.";

  function usesClaudeSubscriptionRoute(slot) {
    if (!slot || String(slot.vendor || "").toLowerCase() !== "anthropic") return false;
    if (slot.mcpServer === "claude-cli") return true;
    return slot.transport === "mcp" && slot.costModelClass === "subscription";
  }

  function claudeSubscriptionOptedIn() {
    return !!(lastRoutingPayload && lastRoutingPayload.claudeSubscriptionOptIn);
  }

  /**
   * True when the subscription route may NOT be newly picked for this slot:
   * OpenCode harness, anthropic vendor, opt-in off. A slot that already
   * uses the route is grandfathered (keeps working, shows the note).
   */
  function claudeSubscriptionLocked(slot, harness) {
    return harness === "opencode"
      && String(slot && slot.vendor || "").toLowerCase() === "anthropic"
      && !claudeSubscriptionOptedIn()
      && !usesClaudeSubscriptionRoute(slot);
  }

  /**
   * p26-t1: the harness's own native vendor (no bridge/MCP needed) —
   * "anthropic" for claude-code, "openai" for codex, null for opencode
   * (no single native vendor there). Reuses the same table
   * AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS (005-agent-accent.js) keys
   * roster accenting off of — media/main.js concatenates every part into
   * one shared closure (scripts/build-webview.mjs), so that table is
   * visible here without a separate import.
   * @param {string} harness
   * @returns {string|null}
   */
  function nativeVendorForHarness(harness) {
    return Object.prototype.hasOwnProperty.call(AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS, harness || "")
      ? AGENT_ACCENT_NATIVE_VENDOR_BY_HARNESS[harness]
      : null;
  }

  /**
   * p27-t3: the always-visible slot identity line — "<vendor> . <model> .
   * <route> . <billing> . <n> fallback(s)" — built from fields already on
   * `RoutingSlot` (src/core/routingProfile.ts), replacing the old chip row
   * as the slot's default-visible identity per docs/design/slot-editor-
   * redesign.md section 1/10.1. `route` derives from transport/mcpServer:
   * `transport: "mcp"` reads "bridged via MCP <name>" (name falls back to
   * "(not installed)" when `mcpServer` is unset, matching the
   * bridged-missing mockup); `transport: "openai-compatible"` reads
   * "OpenAI-compatible endpoint"; otherwise "native" ONLY when the vendor
   * actually matches the harness's native vendor — any other
   * transport/vendor combination (e.g. a stale "claude-native" transport
   * left on a foreign-vendor draft) is labeled by the literal transport
   * value instead, so the route text never contradicts the accent color
   * (review fix, p27-t3 round 2).
   * Accent (p24) goes on the vendor/model segment only, via agentAccent()
   * (005-agent-accent.js) — light blue (`agent-accent-foreign`) when the
   * vendor is foreign to the running harness; native slots get no accent.
   * The fallback count stays plain/neutral text (no accent) per the brief.
   * @param {object} slot
   * @param {string} harness
   * @param {{id?:string,name?:string,resolvedVendor?:string,resolvedModel?:string}} [agentInfo]
   *   `resolvedVendor`/`resolvedModel` are the same fallback values the old
   *   "Routed to <vendor>/<model>" chip used (`a.vendor || backend.vendor`,
   *   `a.resolvedModel || a.model`) — consulted only when the draft slot
   *   itself has no vendor/model yet (review fix, p27-t3 round 2), so an
   *   empty draft for an already-routed agent never shows "unknown model".
   * @param {boolean} [isFallbackEntry] p27-t5: true when this slot is itself
   *   a fallback-chain entry — forces the amber "fallback" accent
   *   (agentAccent()'s `fallbackOf` path) and appends the " (fb)" suffix
   *   per docs/design/slot-editor-redesign.md section 6, regardless of the
   *   entry's own vendor.
   * @param {boolean} [omitFallbackCount] p32-t3: true for the default
   *   fallback's own summary line — a "N fallbacks" count on the default
   *   itself reads as nonsense (nothing "defaults" onto the default), so
   *   it's dropped from the trailing segment entirely rather than shown as
   *   "0 fallbacks".
   * @returns {HTMLElement}
   */
  function buildSlotSummaryLine(slot, harness, agentInfo, isFallbackEntry, omitFallbackCount) {
    var s = slot || {};
    var info = agentInfo || {};
    // Empty string (not "unknown") when nothing resolves, so agentAccent()
    // below still reads a genuinely-native/no-vendor slot as native rather
    // than accenting the "unknown" placeholder as foreign.
    var resolvedVendor = s.vendor || info.resolvedVendor || "";
    var nativeVendor = nativeVendorForHarness(harness);
    var vendor = resolvedVendor || nativeVendor || "unknown";
    var model = s.model || info.resolvedModel || "unknown model";
    var isNativeVendor = !!nativeVendor && vendor.toLowerCase() === nativeVendor;
    var route;
    if (s.transport === "mcp") {
      route = "bridged via MCP " + (s.mcpServer ? s.mcpServer : "(not installed)");
    } else if (s.transport === "openai-compatible") {
      route = "OpenAI-compatible endpoint";
    } else if (isNativeVendor) {
      route = "native";
    } else {
      route = s.transport || "claude-native";
    }
    var billing = s.costModelClass || "metered";
    var fallbackCount = Array.isArray(s.fallback) ? s.fallback.length : 0;
    var fallbackText = fallbackCount + (fallbackCount === 1 ? " fallback" : " fallbacks");
    // p31-t2: append whether routingDraft.defaultFallback applies to this
    // slot — skipped for fallback-chain entries themselves and for the
    // defaultFallback slot's own summary line (nothing "defaults" onto it).
    if (!isFallbackEntry) {
      var dfSlotForSummary = typeof routingDraft !== "undefined" && routingDraft && routingDraft.defaultFallback;
      var isDefaultFallbackSelfForSummary = !!dfSlotForSummary && s === dfSlotForSummary;
      if (!isDefaultFallbackSelfForSummary) {
        if (s.useDefaultFallback === false) {
          fallbackText += " · no default";
        } else if (dfSlotForSummary && slotHasContent(dfSlotForSummary)) {
          fallbackText += " + default";
        }
      }
    }

    var line = document.createElement("p");
    line.className = "routing-slot-summary-line";

    var idSpan = document.createElement("span");
    idSpan.className = "routing-slot-summary-vendor-model";
    var accentKind = agentAccent({
      vendor: resolvedVendor,
      harness: harness,
      fallbackOf: isFallbackEntry ? "fallback" : null,
    });
    if (accentKind === "foreign") idSpan.className += " agent-accent-foreign";
    if (accentKind === "fallback") idSpan.className += " agent-accent-fallback";
    idSpan.textContent = vendor + " · " + model + (isFallbackEntry ? " (fb)" : "");
    line.appendChild(idSpan);

    var restSpan = document.createElement("span");
    restSpan.className = "routing-slot-summary-rest";
    restSpan.textContent = " · " + route + " · " + billing + (omitFallbackCount ? "" : " · " + fallbackText);
    line.appendChild(restSpan);

    if (harness === "opencode" && usesClaudeSubscriptionRoute(s)) {
      var claudeSubSpan = document.createElement("span");
      claudeSubSpan.className = "routing-slot-summary-claude-subscription-note";
      claudeSubSpan.textContent = " · " + CLAUDE_SUBSCRIPTION_NOTE;
      line.appendChild(claudeSubSpan);
    }

    return line;
  }

  /** "openai" -> "OpenAI", "google" -> "Google", else capitalized vendor id. */
  function subscriptionNoticeVendorLabel(vendor) {
    var v = String(vendor || "");
    if (v.toLowerCase() === "openai") return "OpenAI";
    if (v.toLowerCase() === "google") return "Google";
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  }

  /** The CLI a vendor's subscription is bridged through: Codex/Gemini for the two named vendors, else "<Vendor>". */
  function subscriptionNoticeCliName(vendor) {
    var v = String(vendor || "").toLowerCase();
    if (v === "openai") return "Codex";
    if (v === "google") return "Gemini";
    return subscriptionNoticeVendorLabel(vendor);
  }

  /**
   * Inline guidance notice for the slot editor (2026-09-07): a routing form
   * can pick vendor + cost class "subscription", or transport "mcp", but
   * this form has no way to create the vendor-CLI-as-MCP-server bridge and
   * hand-written backend: block those actually require (see
   * .claude/agents/codex-reviewer.md for the shape) — Save would otherwise
   * silently write a routing entry that can never run. Shown directly under
   * the cost-class select; dismissible per render until a relevant field
   * changes. Returns { el, refresh } — `refresh` re-evaluates visibility and
   * content and is wired to bubbling input/change events on the slot's own
   * fields (and, via editorWrap/card-level wiring at call sites, its
   * fallback chain's fields too) so the notice stays live without a full
   * modal rebuild.
   * @param {object} slot
   * @param {{id:string,name:string,handWrittenBackend?:boolean}|undefined} agentInfo
   */
  function buildSubscriptionMcpNotice(slot, agentInfo) {
    var wrap = document.createElement("div");
    wrap.className = "routing-subscription-notice";
    wrap.hidden = true;

    // p27-t4: the notice box is replaced by a single compact status row per
    // docs/design/slot-editor-redesign.md section 5. Three states:
    //   - bridged-connected (needsBridge && bridgeIsSetUp): status line only.
    //   - bridged-missing (needsBridge && !bridgeIsSetUp): status line plus
    //     one "Copy request" button; no textarea rendered by default — the
    //     generated prompt is only visible via the "Show request" <details>
    //     below, closed by default.
    //   - native (!needsBridge): nothing (wrap stays hidden).
    var statusRow = document.createElement("div");
    statusRow.className = "routing-subscription-bridge-status-row";
    wrap.appendChild(statusRow);

    var statusLine = document.createElement("p");
    statusLine.className = "routing-subscription-bridge-status delegation-mode-footnote";
    statusRow.appendChild(statusLine);

    var copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "skill-btn settings-btn routing-subscription-notice-copy";
    copyBtn.textContent = "Copy request";
    copyBtn.hidden = true;
    copyBtn.addEventListener("click", function () {
      var text = buildPrompt();
      var done = function () {
        var prevText = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(function () { copyBtn.textContent = prevText; }, 2000);
      };
      var fallbackCopy = function () {
        var tmp = document.createElement("textarea");
        tmp.value = text;
        tmp.style.position = "fixed";
        tmp.style.opacity = "0";
        document.body.appendChild(tmp);
        tmp.select();
        try { document.execCommand("copy"); } catch (e) { /* best effort */ }
        document.body.removeChild(tmp);
        done();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallbackCopy);
      } else {
        fallbackCopy();
      }
    });
    statusRow.appendChild(copyBtn);

    // "Show request" expander (bridged-missing only) — the same generated
    // prompt text, kept out of the default layout per section 5's "no
    // persistent textarea taking up card space".
    var requestDetails = document.createElement("details");
    requestDetails.className = "routing-subscription-request-details";
    requestDetails.hidden = true;
    var requestSummary = document.createElement("summary");
    requestSummary.textContent = "Show request";
    requestDetails.appendChild(requestSummary);
    var textarea = document.createElement("textarea");
    textarea.className = "routing-subscription-notice-textarea";
    textarea.rows = 3;
    textarea.readOnly = true;
    requestDetails.appendChild(textarea);
    wrap.appendChild(requestDetails);

    /**
     * p27-t1: true when this slot NEEDS a subscription/MCP bridge at all —
     * vendor foreign to the running harness AND (costModelClass subscription
     * OR transport mcp). Split out of the old shouldShow() so bridgeIsSetUp()
     * below can gate on it without re-showing the notice once a bridge
     * already exists.
     */
    function needsBridge() {
      var vendor = String(slot.vendor || "").toLowerCase();
      // p26-t1: the harness's own native vendor never needs a bridge — no
      // MCP server, no subscription-CLI notice — regardless of whatever
      // transport/costModelClass a previously-saved slot still carries.
      var harnessEff = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
      var nativeVendor = nativeVendorForHarness(harnessEff);
      if (nativeVendor && vendor === nativeVendor) return false;
      var subscriptionMismatch = slot.costModelClass === "subscription" && !!vendor && vendor !== "anthropic" && vendor !== "opencode";
      var mcpWithoutBackend = slot.transport === "mcp";
      return subscriptionMismatch || mcpWithoutBackend;
    }

    /**
     * p27-t1: "set up" = a hand-written backend: block (seeded from
     * .claude/agents/<id>.md, surfaced here as agentInfo.handWrittenBackend)
     * AND an MCP server name present on the slot. When true, the bridge this
     * notice would otherwise ask the orchestrator to create already exists.
     */
    function bridgeIsSetUp() {
      return !!(agentInfo && agentInfo.handWrittenBackend) && !!slot.mcpServer;
    }

    function shouldShow() {
      return needsBridge() && !bridgeIsSetUp();
    }

    /**
     * MCP server install state for slot.mcpServer, when knowable. Reuses the
     * same catalog list (lastMcpServers — {id, installed}, populated from
     * the "mcp"/catalog message, see 070-catalog-notices.js) that the "MCP 0"
     * settings chip and isUefnInstalledInProject() already read.
     * @returns {boolean|null} true/false when known, null when the server
     *   isn't in the catalog list — caller keeps the "connected" wording in
     *   that case (unknown installs are not shown as a problem).
     */
    function mcpServerInstallState() {
      var id = slot.mcpServer;
      if (!id || typeof lastMcpServers === "undefined" || !Array.isArray(lastMcpServers)) return null;
      var entry = lastMcpServers.filter(function (s) { return s && s.id === id; })[0];
      if (!entry) return null;
      return !!entry.installed;
    }

    function buildPrompt() {
      var vendor = slot.vendor || "";
      var vendorLabel = subscriptionNoticeVendorLabel(vendor);
      var cli = subscriptionNoticeCliName(vendor);
      var model = slot.model || "its default model";
      var agentName = (agentInfo && agentInfo.name) || "this";
      var agentId = (agentInfo && agentInfo.id) || "agent";
      var fallbackText = "Anthropic Sonnet";
      if (Array.isArray(slot.fallback) && slot.fallback.length && slot.fallback[0]) {
        var fb = slot.fallback[0];
        if (fb.vendor || fb.model) {
          fallbackText = (subscriptionNoticeVendorLabel(fb.vendor) + " " + (fb.model || "")).trim();
        }
      }
      var vendorModel = vendorLabel ? (vendorLabel + " " + model) : (model + " on the right vendor");
      var subscriptionPhrase = vendorLabel
        ? "through my " + vendorLabel + " subscription using the " + cli + " CLI's MCP server"
        : "through my subscription using the vendor CLI's MCP server";
      return (
        "Set up the " + agentName + " agent (" + agentId + ") to run on " + vendorModel +
        " " + subscriptionPhrase + " (like codex-reviewer does), " +
        "with a hand-written backend block in .claude/agents/" + agentId + ".md, cost class subscription, " +
        "and fall back to " + fallbackText + " when the provider is unavailable. " +
        "Keep the agent's keywords and delegation text unchanged."
      );
    }

    function refresh() {
      apply();
    }

    // p27-t4: section 5's three bridge states, verbatim wording.
    //   bridged-connected -> "Bridged via <CLI> MCP - connected." (status row only)
    //   bridged-missing   -> "Bridge via <CLI> MCP not installed." (status row + Copy request button)
    //   native            -> wrap stays hidden entirely
    function apply() {
      var missing = shouldShow();
      var connected = needsBridge() && bridgeIsSetUp();
      wrap.hidden = !(missing || connected);
      copyBtn.hidden = !missing;
      requestDetails.hidden = !missing;
      requestDetails.open = false;
      if (missing) {
        statusLine.className = "routing-subscription-bridge-status delegation-mode-footnote";
        var missingCli = subscriptionNoticeCliName(slot.vendor);
        statusLine.textContent = missingCli
          ? "Bridge via " + missingCli + " MCP not installed."
          : "Bridge not installed.";
        textarea.value = buildPrompt();
      } else if (connected) {
        var cli = subscriptionNoticeCliName(slot.vendor);
        var installState = mcpServerInstallState();
        var notInstalled = installState === false;
        statusLine.textContent = "Bridged via " + cli + " MCP - " +
          (notInstalled ? "MCP server not installed." : "connected.");
        statusLine.className = "routing-subscription-bridge-status delegation-mode-footnote" +
          (notInstalled ? " theme-review-retry-warning" : "");
      }
    }

    apply();

    // needsBridge/bridgeIsSetUp exposed (p27-t3) so buildSlotEditorFields
    // can decide the Connection <details> open state without duplicating
    // this logic.
    return { el: wrap, refresh: refresh, needsBridge: needsBridge, bridgeIsSetUp: bridgeIsSetUp };
  }

  function buildSlotEditorFields(slot, presets, onStructural, fieldKeyPrefix, agentInfo) {
    var keyPrefix = fieldKeyPrefix || "";
    var frag = document.createElement("div");
    frag.className = "routing-slot-fields";
    // p26-t1: this slot's vendor is the current harness's own native vendor
    // (claude-code -> anthropic, codex -> openai) — no bridge is needed, so
    // the bridge-only fields (transport, MCP server, credential/endpoint
    // env) render below only when this is false. Recomputed on every
    // (re)build, so a vendor or harness change picks it up immediately.
    var slotHarnessEff = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    var slotNativeVendor = nativeVendorForHarness(slotHarnessEff);
    var isNativeVendorSlot = !!slotNativeVendor && String(slot.vendor || "").toLowerCase() === slotNativeVendor;
    // Only the top-level agent slot (not a fallback entry, which has no
    // "Use another provider" checkbox of its own) auto-collapses back to
    // the native route when the user picks the native vendor.
    var isTopLevelAgentSlot = agentInfo && agentInfo.id && keyPrefix.indexOf(".fallback[") === -1;

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
      // p26-t1: picking the harness's own native vendor defaults "Use
      // another provider for this agent" back to unchecked (collapsed, no
      // draft override) so the next Save uses the plain native route —
      // matching what manually unchecking that box already does (see the
      // providerCheckbox "change" handler above in the card builder).
      // Setting routingExpandedAgents[id] = false (not delete) is
      // deliberate: with the key absent, the card recomputes `expanded`
      // from isRouted/handWrittenBackend and would immediately reopen for
      // an already-routed agent. This does NOT touch the on-disk profile —
      // an existing hand-written backend: block is left alone until the
      // user actually saves the slot with the native route selected.
      if (isTopLevelAgentSlot) {
        var newVendorIsNative = !!slotNativeVendor && String(slot.vendor || "").toLowerCase() === slotNativeVendor;
        if (newVendorIsNative) {
          routingExpandedAgents[agentInfo.id] = false;
          // Preserve a previously-picked model/tier across the collapse —
          // only the bridge fields (transport/mcpServer/credentialEnv/etc.)
          // are being dropped here, not an explicit model choice the user
          // already made on this same slot.
          var prevSlotForNative = routingDraft.agents[agentInfo.id];
          routingDraft.agents[agentInfo.id] = (prevSlotForNative && prevSlotForNative.model !== undefined)
            ? { model: prevSlotForNative.model }
            : {};
        }
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
    if (String(slot.vendor || "").toLowerCase() === "google") frag.appendChild(buildGeminiBackendControl());
    var modelRow = document.createElement("div");
    // Full row width, always — a model id (e.g. "anthropic/claude-sonnet-
    // 4-6") is the field most likely to overflow a shared 2-col grid cell;
    // sharing a row with Vendor is what truncated it (item 3 cleanup).
    modelRow.className = "routing-field-row routing-field-row--full";
    var modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    modelRow.appendChild(modelLabel);
    var isGoogleSlot = String(slot.vendor || "").toLowerCase() === "google";
    var geminiState = geminiBackendState();
    var geminiOnAgy = isGoogleSlot && geminiState.known && geminiState.value === "agy";
    var models = ((presets && presets.models) || []).filter(function (m) {
      return !slot.vendor || slot.vendor === ROUTING_VENDOR_CUSTOM || m.vendor === slot.vendor;
    });
    // Gemini CLI backend only accepts gemini-* ids (the dispatcher drops anything else).
    if (isGoogleSlot && geminiState.known && !geminiOnAgy) {
      models = models.filter(function (m) { return /(^|\/)gemini-/.test(String(m.id || "")); });
    }
    var matchesPreset = models.some(function (m) { return m.id === slot.model; });
    // Free-text branch: Custom-endpoint vendor, an unrecognized non-empty
    // model, OR the preset select's own "Custom…" option was just picked
    // (slot._modelCustomEdit, set below) — that pick clears slot.model to ""
    // specifically to open this branch, and gating on `slot.model` being
    // truthy alone used to send that case straight back into the preset
    // SELECT branch instead (the "Custom…" pick silently failed to open the
    // free-text field for a non-custom vendor with no model chosen yet).
    if (geminiOnAgy) {
      // Antigravity picks its own model; nothing the panel writes changes it.
      var agyModel = document.createElement("div");
      agyModel.className = "routing-model-readonly";
      agyModel.setAttribute("data-field-key", keyPrefix + ".model");
      agyModel.textContent = GEMINI_AGY_MODEL_TEXT;
      modelRow.appendChild(agyModel);
    } else if (isCustom || (!matchesPreset && (slot.model || slot._modelCustomEdit))) {
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

    // Transport — bridge-only field (mcp/openai-compatible are how a
    // foreign vendor gets bridged in); the harness's own native vendor
    // (p26-t1) has nothing to bridge, so this row is skipped for it.
    var transportDerived = slotHarnessEff !== "opencode";
    // Transport the slot carried before any MCP server was typed; clearing the field restores it.
    var storedBaseTransport = slot.transport && slot.transport !== "mcp" ? slot.transport : "claude-native";
    var connectionLineEl = null;
    if (!isNativeVendorSlot && transportDerived) {
      // Claude Code and Codex: the route follows vendor + MCP server (set
      // below); a separate Transport select changed nothing at runtime.
      connectionLineEl = document.createElement("div");
      connectionLineEl.className = "routing-connection-line";
      connectionLineEl.setAttribute("data-field-key", keyPrefix + ".connection");
      connectionLineEl.textContent = connectionLineText(slot);
      frag.appendChild(connectionLineEl);
    } else if (!isNativeVendorSlot) {
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
        if (t === "mcp" && claudeSubscriptionLocked(slot, slotHarnessEff)) {
          opt.disabled = true;
          opt.title = "Claude defaults to an Anthropic API key under OpenCode. Enable \"Allow Claude subscription via the claude CLI under OpenCode\" in Settings to bridge Claude through MCP.";
        }
        transportSel.appendChild(opt);
      });
      transportSel.addEventListener("change", function () { slot.transport = transportSel.value; onStructural(); });
      transportRow.appendChild(transportSel);
      frag.appendChild(transportRow);
    }

    // Cost model class
    var costRow = document.createElement("div");
    costRow.className = "routing-field-row";
    var costLabel = document.createElement("label");
    costLabel.textContent = "Billing label";
    costRow.appendChild(costLabel);
    var costSel = document.createElement("select");
    costSel.setAttribute("data-field-key", keyPrefix + ".costModelClass");
    ["metered", "subscription", "local"].forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c;
      opt.textContent = costClassLabel(c);
      if (c === slot.costModelClass) opt.selected = true;
      if (c === "subscription" && claudeSubscriptionLocked(slot, slotHarnessEff)) {
        opt.disabled = true;
        opt.title = "Claude defaults to an Anthropic API key under OpenCode. Enable the Claude subscription opt-in in Settings to use this.";
      }
      costSel.appendChild(opt);
    });
    costSel.addEventListener("change", function () { slot.costModelClass = costSel.value; });
    costRow.appendChild(costSel);
    var costHint = document.createElement("div");
    costHint.className = "routing-env-note routing-billing-hint";
    costHint.textContent = "Informational; on OpenCode it also controls the Claude subscription lock";
    costRow.appendChild(costHint);
    frag.appendChild(costRow);

    // Subscription/MCP guidance notice (2026-09-07): a routing form can pick
    // vendor + cost class "subscription", or transport "mcp", but this form
    // has no way to actually wire a vendor CLI (Codex, Gemini, …) bridged as
    // an MCP server with a hand-written backend: block — see
    // .claude/agents/codex-reviewer.md for the shape. Warn inline and hand
    // the user a ready-made request to paste to their orchestrator instead
    // of letting Save silently produce a routing entry that can't run.
    if (slotHarnessEff === "opencode") {
      var claudeSubNote = document.createElement("div");
      claudeSubNote.className = "delegation-mode-footnote routing-claude-subscription-note";
      claudeSubNote.textContent = CLAUDE_SUBSCRIPTION_NOTE;
      claudeSubNote.hidden = !usesClaudeSubscriptionRoute(slot);
      var refreshClaudeSubNote = function () { claudeSubNote.hidden = !usesClaudeSubscriptionRoute(slot); };
      frag.addEventListener("input", refreshClaudeSubNote);
      frag.addEventListener("change", refreshClaudeSubNote);
      frag.appendChild(claudeSubNote);
    }
    var subNotice = buildSubscriptionMcpNotice(slot, agentInfo);
    frag.appendChild(subNotice.el);
    frag._refreshSubscriptionNotice = subNotice.refresh;
    frag.addEventListener("input", subNotice.refresh);
    frag.addEventListener("change", subNotice.refresh);

    // Endpoint + credential env — bridge-only (a native vendor's credential
    // is whatever the harness/CLI already uses, not a routing-form env var).
    // For openai-compatible / Custom endpoint, endpoint comes first and both
    // fields carry connection-specific labels; other transports only need
    // the credential field.
    var fixedKeySpec = (slotHarnessEff !== "opencode" && !isCustom && !isNativeVendorSlot) ? vendorKeySpecForVendor(presets, slot.vendor) : null;
    if (fixedKeySpec && fixedKeySpec.id === "google" && geminiOnAgy) {
      var agyNote = document.createElement("div");
      agyNote.className = "routing-env-note";
      agyNote.textContent = "Antigravity sign-in needs no API key. Switch the Gemini backend to Paid key (Gemini CLI) to use GEMINI_API_KEY.";
      frag.appendChild(agyNote);
    } else if (fixedKeySpec) {
      frag.appendChild(buildVendorKeyBlock(fixedKeySpec, slot));
      var fixedNote = document.createElement("div");
      fixedNote.className = "routing-env-note";
      fixedNote.textContent = "These names are fixed for this vendor. Values are stored per user in the TycoonAgents app-data folder, never in this project.";
      frag.appendChild(fixedNote);
    } else if (!isNativeVendorSlot) {
      if ((slot.transport === "openai-compatible" || isCustom) && slotHarnessEff !== "opencode") {
        // Claude Code / Codex: the bridge resolves exactly these names (env, then the per-user store),
        // so several custom endpoints can sit side by side. Honest labels, set/unset words, Set value, Test.
        var customSlotId = (keyPrefix || "slot").replace(/[^A-Za-z0-9_.:[]-]/g, "_").slice(0, 120);
        frag.appendChild(buildEnvNameField("Base URL variable", slot.endpointEnv, function (v) { slot.endpointEnv = v; }, "endpoint", keyPrefix + ".endpointEnv", { placeholder: "e.g. OLLAMA_BASE_URL", stateWords: true }));
        var keyWarn = document.createElement("div");
        keyWarn.className = "routing-env-note routing-env-warn";
        var refreshKeyWarn = function (name) {
          var bad = !!name && !CUSTOM_KEY_NAME_RE_UI.test(name);
          keyWarn.hidden = !bad;
          keyWarn.textContent = bad ? "The API key variable must end in _API_KEY, _KEY or _TOKEN (e.g. GROQ_API_KEY) and cannot be another service's credential such as GITHUB_TOKEN." : "";
        };
        frag.appendChild(buildEnvNameField("API key variable — optional for local servers", slot.credentialEnv, function (v) { slot.credentialEnv = v; }, "credential", keyPrefix + ".credentialEnv", { placeholder: "e.g. GROQ_API_KEY", optional: true, stateWords: true, onNameChange: refreshKeyWarn }));
        refreshKeyWarn(slot.credentialEnv);
        frag.appendChild(keyWarn);
        var customNote = document.createElement("div");
        customNote.className = "routing-env-note";
        customNote.textContent = "Works with any OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenRouter, Groq, DeepSeek…). The URL must be https, or http for localhost. Give each custom endpoint its own variable names.";
        frag.appendChild(customNote);
        frag.appendChild(buildCustomEndpointTestControl(slot, customSlotId));
      } else if (slot.transport === "openai-compatible" || isCustom) {
        frag.appendChild(buildEnvNameField("Endpoint URL env", slot.endpointEnv, function (v) { slot.endpointEnv = v; }, "endpoint", keyPrefix + ".endpointEnv"));
        frag.appendChild(buildEnvNameField("API key env", slot.credentialEnv, function (v) { slot.credentialEnv = v; }, "credential", keyPrefix + ".credentialEnv"));
      } else {
        frag.appendChild(buildEnvNameField("Credential env", slot.credentialEnv, function (v) { slot.credentialEnv = v; }, "credential", keyPrefix + ".credentialEnv"));
      }

      var envNote = document.createElement("div");
      envNote.className = "routing-env-note";
      envNote.textContent = "Names here; the values are stored per user in the TycoonAgents app-data folder, never in this project.";
      frag.appendChild(envNote);
    }

    if (!isNativeVendorSlot && (slot.transport === "mcp" || (transportDerived && !isCustom))) {
      var mcpRow = document.createElement("div");
      mcpRow.className = "routing-field-row";
      var mcpLabel = document.createElement("label");
      mcpLabel.textContent = "MCP server";
      mcpRow.appendChild(mcpLabel);
      var mcpInput = document.createElement("input");
      mcpInput.type = "text";
      mcpInput.setAttribute("data-field-key", keyPrefix + ".mcpServer");
      mcpInput.value = slot.mcpServer || "";
      var mcpWarnHolder = document.createElement("div");
      var refreshMcpWarn = function () {
        mcpWarnHolder.textContent = "";
        if (keyPrefix.indexOf(".fallback[") !== -1) return; // the fallback list shows its own warning
        var w = buildMcpServerWarning(missingMcpServerWarning(slot));
        if (w) mcpWarnHolder.appendChild(w);
      };
      if (transportDerived && !isCustom) {
        // Naming an MCP server IS the bridge: it sets transport "mcp"; empty is the native route.
        var mcpList = document.createElement("datalist");
        mcpList.id = "mcp-servers-" + keyPrefix.replace(/[^a-zA-Z0-9_-]/g, "_");
        ((routingBridgeInfo() && routingBridgeInfo().mcpServers) || []).forEach(function (n) {
          var o = document.createElement("option");
          o.value = n;
          mcpList.appendChild(o);
        });
        mcpInput.setAttribute("list", mcpList.id);
        mcpInput.placeholder = "(none: native route)";
        mcpRow.appendChild(mcpList);
      }
      mcpInput.addEventListener("input", function () {
        slot.mcpServer = mcpInput.value;
        if (transportDerived && !isCustom) {
          slot.transport = mcpInput.value.trim() ? "mcp" : storedBaseTransport;
          if (!mcpInput.value.trim()) delete slot.mcpServer;
          if (connectionLineEl) connectionLineEl.textContent = connectionLineText(slot);
        }
        refreshMcpWarn();
      });
      mcpRow.appendChild(mcpInput);
      frag.appendChild(mcpRow);
      refreshMcpWarn();
      frag.appendChild(mcpWarnHolder);
    }

    // p27-t3: collapse the vendor..MCP-server field block (everything just
    // built above) behind a "Connection" <details> — absent entirely for a
    // native-vendor slot (nothing to configure, per docs/design/slot-editor-
    // redesign.md section 2/10.1), open by default only when the slot is
    // bridged-missing (needsBridge && !bridgeIsSetUp, p27-t1) or carries a
    // hard (ok:false) dispatch warning (isFallbackTargetDispatchableWebview
    // — the same check buildFallbackDispatchWarning uses for the amber
    // footnote). Moving frag's existing children into the <details> instead
    // of rebuilding them keeps every field builder above untouched.
    if (!isNativeVendorSlot) {
      var connDetails = document.createElement("details");
      connDetails.className = "routing-connection-details";
      // Keyed the same way buildSlotEditorFields' own data-field-key
      // attributes are (keyPrefix) so snapshotRoutingUiState/
      // restoreRoutingUiState can find this exact instance again across a
      // structural rebuild (review fix, p27-t3 round 2) — see
      // ~1097-1155 below.
      connDetails.setAttribute("data-connection-key", keyPrefix);
      var connSummary = document.createElement("summary");
      connSummary.textContent = "Connection";
      connDetails.appendChild(connSummary);
      while (frag.firstChild) {
        connDetails.appendChild(frag.firstChild);
      }
      var slotDispatchCheck = isFallbackTargetDispatchableWebview(slot, routingCurrentHarness, routingCurrentGeminiKeyPresent);
      var openConnection = (subNotice.needsBridge() && !subNotice.bridgeIsSetUp()) || slotDispatchCheck.ok === false || !!missingMcpServerWarning(slot);
      if (openConnection) connDetails.open = true;
      frag.appendChild(connDetails);
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
  function buildFallbackEditor(slot, presets, onStructural, agentKey, fieldKeyPrefix, agentInfo) {
    if (!Array.isArray(slot.fallback)) slot.fallback = [];
    var keyPrefix = fieldKeyPrefix || "";
    var details = document.createElement("details");
    details.className = "plan-task-details routing-fallback-details";
    details.setAttribute("data-agent-id", agentKey || "orchestrator");
    var summary = document.createElement("summary");
    summary.textContent = "Fallback chain (" + slot.fallback.length + ")";
    details.appendChild(summary);
    var hostNote = document.createElement("p");
    hostNote.className = "routing-fallback-host-note delegation-mode-footnote";
    hostNote.textContent = fallbackHostNoteText(routingCurrentHarness);
    details.appendChild(hostNote);

    var list = document.createElement("div");
    list.className = "routing-fallback-list";
    slot.fallback.forEach(function (fbSlot, idx) {
      var item = document.createElement("div");
      item.className = "routing-fallback-item";
      var line = document.createElement("div");
      line.className = "routing-fallback-item-line";
      // Keyboard order (section 10 item 3): position badge -> summary line
      // (non-interactive) -> up/down/remove controls.
      var title = document.createElement("span");
      title.className = "routing-fallback-position-badge";
      title.textContent = "#" + (idx + 1);
      line.appendChild(title);
      line.appendChild(buildSlotSummaryLine(fbSlot, routingCurrentHarness, agentInfo, true));

      var head = document.createElement("div");
      head.className = "routing-fallback-item-head";

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
      line.appendChild(head);
      item.appendChild(line);

      var entryKeyPrefix = keyPrefix + ".fallback[" + idx + "]";
      var fbCheck = isFallbackTargetDispatchableWebview(fbSlot, routingCurrentHarness, routingCurrentGeminiKeyPresent);
      var fbWarning = buildFallbackDispatchWarning(fbCheck);
      if (fbWarning) {
        if (fbCheck.ok === false) routingHasBlockingDispatchWarning = true;
        item.appendChild(fbWarning);
      }
      // Live: typing in the entry's MCP server field updates this warning without a rebuild.
      var fbMcpHolder = document.createElement("div");
      var refreshFbMcpWarning = function () {
        fbMcpHolder.textContent = "";
        var w = buildMcpServerWarning(missingMcpServerWarning(fbSlot));
        if (w) fbMcpHolder.appendChild(w);
      };
      refreshFbMcpWarning();
      item.appendChild(fbMcpHolder);
      item.addEventListener("input", refreshFbMcpWarning);

      // p27-t5: full field block moves into a per-entry <details>, closed
      // by default — reusing the .routing-fallback-details class and the
      // data-agent-id snapshot/restore mechanism (~1092-1181) so open/
      // closed state survives a structural rebuild. Key is the entry's own
      // field keyPrefix, which is unique per entry/slot and distinct from
      // the chain-level details' agentKey ("orchestrator"/agent id), so
      // both kinds coexist safely under the same snapshot map.
      var fieldsDetails = document.createElement("details");
      fieldsDetails.className = "routing-fallback-details routing-fallback-entry-details";
      fieldsDetails.setAttribute("data-agent-id", entryKeyPrefix);
      var fieldsSummary = document.createElement("summary");
      fieldsSummary.textContent = "Fields";
      fieldsDetails.appendChild(fieldsSummary);
      fieldsDetails.appendChild(buildSlotEditorFields(fbSlot, presets, onStructural, entryKeyPrefix, agentInfo));
      // Open by default when the entry has a blocking dispatch warning, or
      // is newly added and still empty (no vendor/model set yet).
      var entryIsEmpty = !fbSlot.vendor && !fbSlot.model;
      if (fbCheck.ok === false || entryIsEmpty) {
        fieldsDetails.open = true;
      }
      item.appendChild(fieldsDetails);

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

    // p31-t2: read-only "Default: <label>" row + opt-out checkbox, shown
    // for EVERY slot (including subscription/MCP and backend-configured
    // slots) — reads/writes routingDraft.defaultFallback (top-level, set by
    // ensureDefaultFallbackDraft) and this slot's own `useDefaultFallback`.
    var dfSlot = routingDraft && routingDraft.defaultFallback;
    var isThisSlotTheDefault = !!dfSlot && slot === dfSlot;
    var defaultRow = document.createElement("p");
    defaultRow.className = "routing-default-fallback-row";
    var defaultLabelSpan = document.createElement("span");
    if (isThisSlotTheDefault) {
      defaultLabelSpan.textContent = "Default: (this agent)";
    } else if (dfSlot && slotHasContent(dfSlot)) {
      defaultLabelSpan.className = "agent-accent-fallback";
      defaultLabelSpan.textContent = "Default: " + (dfSlot.vendor || "unknown") + " · " + (dfSlot.model || "unknown model") + " (dfb)";
    } else {
      defaultLabelSpan.textContent = "No default set — set one up below the orchestrator.";
    }
    defaultRow.appendChild(defaultLabelSpan);
    details.appendChild(defaultRow);

    var useDefaultLabel = document.createElement("label");
    useDefaultLabel.className = "routing-use-default-fallback-label";
    var useDefaultCheckbox = document.createElement("input");
    useDefaultCheckbox.type = "checkbox";
    useDefaultCheckbox.className = "routing-use-default-fallback-checkbox";
    useDefaultCheckbox.checked = slot.useDefaultFallback !== false;
    useDefaultCheckbox.disabled = isThisSlotTheDefault;
    useDefaultCheckbox.addEventListener("change", function () {
      if (useDefaultCheckbox.checked) {
        delete slot.useDefaultFallback;
      } else {
        slot.useDefaultFallback = false;
      }
      onStructural();
    });
    useDefaultLabel.appendChild(useDefaultCheckbox);
    useDefaultLabel.appendChild(document.createTextNode(" Use default fallback for this agent"));
    details.appendChild(useDefaultLabel);

    if (slot.useDefaultFallback === false && !isThisSlotTheDefault) {
      var optOutNote = document.createElement("p");
      optOutNote.className = "routing-defaults-help";
      optOutNote.textContent = "This agent will fail after its own chain.";
      details.appendChild(optOutNote);
    }

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
        `${fmtTokens(v.tokens)} tokens (${v.agents} agent${v.agents === 1 ? "" : "s"})`,
        "Sum of tokens for every agent whose actually-executed model belongs to this vendor (a fallback-tagged agent counts under the vendor that ran it, not the one originally assigned)."
      );
    }

    for (const c of rollup.byCostClass) {
      appendFooterRow(
        tbody,
        COLSPAN,
        `${costClassLabel(c.costModelClass)} total — `,
        `${fmtTokens(c.tokens)} tokens`,
        "Sum of tokens for every agent in this billing class."
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
      routingDraft = ensureDefaultFallbackDraft(buildRoutingDraft(lastRoutingPayload), lastRoutingPayload);
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
    // p27-t3 round 2: the "Connection" <details> per slot, keyed by its
    // buildSlotEditorFields keyPrefix (data-connection-key) — a manual
    // toggle here must survive the same structural rebuilds
    // .routing-fallback-details already tolerates. Absent from the map
    // when never snapshotted, so restoreRoutingUiState below leaves the
    // freshly-computed default (needsBridge/dispatch-warning) alone.
    var connectionOpenMap = {};
    if (routingContentEl) {
      routingContentEl.querySelectorAll(".routing-fallback-details").forEach(function (d) {
        var key = d.getAttribute("data-agent-id") || "orchestrator";
        openMap[key] = !!d.open;
      });
      routingContentEl.querySelectorAll(".routing-connection-details").forEach(function (d) {
        var key = d.getAttribute("data-connection-key") || "";
        connectionOpenMap[key] = !!d.open;
      });
    }
    // p32-t1: the "Default fallback" <details> (routing-default-fallback-
    // section) — same collapse-on-every-structural-rebuild problem as the
    // per-slot Connection details above. null when the section wasn't in
    // the DOM yet (never renders anywhere the map covers null).
    var defaultFallbackOpen = null;
    if (routingContentEl) {
      var dfDetailsSnap = routingContentEl.querySelector(".routing-default-fallback-section");
      if (dfDetailsSnap) defaultFallbackOpen = !!dfDetailsSnap.open;
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
    return { openMap: openMap, connectionOpenMap: connectionOpenMap, defaultFallbackOpen: defaultFallbackOpen, focus: focus, keywordEdits: keywordEdits };
  }

  function restoreRoutingUiState(snapshot) {
    if (!snapshot || !routingContentEl) return;
    routingContentEl.querySelectorAll(".routing-fallback-details").forEach(function (d) {
      var key = d.getAttribute("data-agent-id") || "orchestrator";
      if (Object.prototype.hasOwnProperty.call(snapshot.openMap, key)) {
        d.open = snapshot.openMap[key];
      }
    });
    if (snapshot.connectionOpenMap) {
      routingContentEl.querySelectorAll(".routing-connection-details").forEach(function (d) {
        var key = d.getAttribute("data-connection-key") || "";
        if (Object.prototype.hasOwnProperty.call(snapshot.connectionOpenMap, key)) {
          d.open = snapshot.connectionOpenMap[key];
        }
      });
    }
    if (snapshot.defaultFallbackOpen !== null && snapshot.defaultFallbackOpen !== undefined) {
      var dfDetailsRestore = routingContentEl.querySelector(".routing-default-fallback-section");
      if (dfDetailsRestore) dfDetailsRestore.open = snapshot.defaultFallbackOpen;
    }
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
          { id: "opencode", label: "OpenCode (Experimental)" },
          { id: "codex", label: "Codex (Experimental)" },
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
    if (typeof harness.warning === "string" && harness.warning.length > 0) {
      const harnessWarning = document.createElement("p");
      harnessWarning.className = "theme-review-retry-warning harness-select-warning";
      harnessWarning.textContent = harness.warning;
      harnessRow.appendChild(harnessWarning);
    }
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
    if (harnessSelect.value === "opencode") {
      harnessHint.textContent +=
        " OpenCode hosting is experimental and not yet thoroughly tested.";
    } else if (harnessSelect.value === "codex") {
      harnessHint.textContent +=
        " Codex hosting is experimental and not yet thoroughly tested.";
    }
    harnessRow.appendChild(harnessHint);

    // p23-t11: Codex hook/dispatcher install rows, shown only when Codex is
    // the effective harness. Uses the same footnote/button classes as the
    // rest of the Settings screen.
    if (harness.effective === "codex") {
      const buildInstallRow = (label, installedFlag, installMsg, uninstallMsg, warning) => {
        const row = document.createElement("p");
        row.className = "delegation-mode-footnote harness-codex-install-row";
        const installed = installedFlag === true;
        row.textContent = label + ": " + (installed ? "installed " : "not installed ");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "skill-btn settings-btn harness-codex-install-btn";
        btn.textContent = installed ? "Uninstall" : "Install";
        btn.addEventListener("click", () => {
          btn.disabled = true;
          vscode.postMessage({ type: installed ? uninstallMsg : installMsg });
        });
        row.appendChild(btn);
        if (typeof warning === "string" && warning.length > 0) {
          const warnEl = document.createElement("span");
          warnEl.className = "theme-review-retry-warning harness-select-warning";
          warnEl.textContent = " " + warning;
          row.appendChild(warnEl);
        }
        return row;
      };
      harnessRow.appendChild(
        buildInstallRow(
          "Codex hooks",
          harness.codexHooksInstalled,
          "installCodexHooks",
          "uninstallCodexHooks",
          harness.codexHooksWarning
        )
      );
      harnessRow.appendChild(
        buildInstallRow(
          "Dispatcher",
          harness.codexDispatcherInstalled,
          "installCodexDispatcher",
          "uninstallCodexDispatcher",
          harness.codexDispatcherWarning
        )
      );
      // Codex-doctrine-gap follow-up: AGENTS.md's TYCOON-CODEX-MANAGED
      // block refreshes automatically (hook install, provider switch to
      // codex, routing save) — no install button needed, just surface a
      // failure the same way codexHooksWarning/codexDispatcherWarning do.
      if (typeof harness.codexAgentsMdWarning === "string" && harness.codexAgentsMdWarning.length > 0) {
        const warnRow = document.createElement("div");
        warnRow.className = "theme-review-retry-warning harness-select-warning";
        warnRow.textContent = harness.codexAgentsMdWarning;
        harnessRow.appendChild(warnRow);
      }
    }
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
    let chipForeign = false;
    let chipCls = "unknown";
    if (a.isOrchestrator) {
      chipVsOrchText = "baseline";
    } else {
      const chipModel = m ? (m.model || a.model) : a.model;
      const chipCostModelClass = (m && m.costModelClass) || a.costModelClass || null;
      const chipAgentRate = modelPricePerMtok(chipModel, chipCostModelClass);
      const chipOrchestratorPrice = resolveOrchestratorModelRate(lastMetrics);
      const chipOrch = (lastMetrics || []).find((x) => x && x.id === "orchestrator");
      chipForeign = isForeignToOrchestrator({ id: a.id, vendor: a.vendor || (m && m.vendor), model: chipModel }, chipOrch);
      const chipBi = backendIdentity({ id: a.id, vendor: a.vendor || (m && m.vendor), model: chipModel, costModelClass: chipCostModelClass });
      const chipClassEff = chipForeign ? chipBi.costModelClass : chipCostModelClass;
      chipVsOrchText = vsOrchLabel(chipModel, chipAgentRate, chipOrchestratorPrice, chipClassEff, chipForeign);
      chipCls = chipForeign ? (chipClassEff || "unknown") : costModelClass(chipModel, chipCostModelClass);
    }
    const vsOrchChip = chip("vs. orch.", chipVsOrchText);
    vsOrchChip.title = vsOrchTitle(chipForeign, chipCls);
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
  // p35-t1: single-slot "clipboard" for Copy/Paste settings between agent
  // cards — last Copy wins, held only in webview memory (no host message:
  // this is pure UI state, nothing persisted). `slot` is a RoutingSlot-
  // shaped snapshot built via cloneRoutingSlot (SLOT_SCALAR_FIELDS +
  // fallback, 090-metrics-time-utils.js) so it can never carry id/name/
  // keywords or anything else identifying the source card — those aren't
  // part of the RoutingSlot shape at all.
  var routingSettingsClipboard = null; // { sourceName: string, slot: object } | null
  // Per-agent one-level undo: agent id -> the slot exactly as it was right
  // before the most recent Paste onto that card. Cleared by Undo.
  var routingPasteUndoByAgent = {};
  // Per-agent "Pasted from <name>" note text, shown under that card's
  // footer until Undo is clicked (or a fresh "routing" payload rebuilds
  // the draft — see handleRoutingPayload).
  var routingPasteNoticeByAgent = {};

  // p35-t3: inline SVG icons for the three footer actions (Copy/Paste/
  // Remove). 14px, stroke/fill "currentColor" so each icon inherits its
  // button's link color (including the muted Copy/Paste links, the
  // muted-danger Remove link, and the dimmed disabled-Paste state) with no
  // separate icon-font or asset dependency — standalone hosts have no
  // codicon font available. aria-hidden because the button's existing text
  // label remains the accessible name.
  var FOOTER_ACTION_ICONS = {
    copy:
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
      '<rect x="8" y="8" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M5.5 15.5H4.5A1.5 1.5 0 0 1 3 14V4.5A1.5 1.5 0 0 1 4.5 3H14a1.5 1.5 0 0 1 1.5 1.5v1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      "</svg>",
    paste:
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
      '<rect x="5" y="4" width="14" height="17" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      '<rect x="9" y="2.5" width="6" height="3" rx="1" fill="currentColor"/>' +
      '<path d="M8.5 11h7M8.5 14.5h7M8.5 18h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      "</svg>",
    remove:
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
      '<path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 12H8L7 9Zm3 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" fill="currentColor"/>' +
      "</svg>",
  };

  /**
   * Prefixes a footer action button's accessible text label with its icon,
   * keeping the label as the button's accessible name (icon is aria-hidden).
   */
  function setFooterActionIcon(btn, iconKey, label) {
    btn.innerHTML = "";
    const icon = document.createElement("span");
    icon.className = "agent-footer-action-icon";
    icon.innerHTML = FOOTER_ACTION_ICONS[iconKey];
    btn.appendChild(icon);
    btn.appendChild(document.createTextNode(label));
  }

  function appendCardRemoveFooter(card, a) {
    const footer = document.createElement("div");
    footer.className = "agent-remove-footer";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "link-button routing-copy-settings-link";
    setFooterActionIcon(copyBtn, "copy", "Copy settings");
    copyBtn.addEventListener("click", () => {
      const slot = (routingDraft && routingDraft.agents && routingDraft.agents[a.id]) || {};
      const snapshot = cloneRoutingSlot(slot);
      routingSettingsClipboard = { sourceName: a.name || a.id, slot: snapshot };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(JSON.stringify(snapshot)).catch(() => {});
      }
      renderRoutingModal();
    });
    footer.appendChild(copyBtn);

    const pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.className = "link-button routing-paste-settings-link";
    setFooterActionIcon(pasteBtn, "paste", "Paste settings");
    const hasClipboard = !!(routingSettingsClipboard && routingSettingsClipboard.slot);
    pasteBtn.disabled = !hasClipboard;
    pasteBtn.title = hasClipboard ? "" : "Copy settings from another agent first";
    pasteBtn.addEventListener("click", () => {
      if (!routingSettingsClipboard || !routingSettingsClipboard.slot) return;
      if (!routingDraft.agents) routingDraft.agents = {};
      routingPasteUndoByAgent[a.id] = cloneRoutingSlot(routingDraft.agents[a.id] || {});
      routingDraft.agents[a.id] = cloneRoutingSlot(routingSettingsClipboard.slot);
      // Expand the card so the pasted fields (and any dispatchability
      // warning they trigger) are immediately visible, matching what
      // "Override for this agent" already does on a fresh edit.
      routingExpandedAgents[a.id] = true;
      routingPasteNoticeByAgent[a.id] = routingSettingsClipboard.sourceName;
      renderRoutingModal();
    });
    footer.appendChild(pasteBtn);

    if (routingPasteNoticeByAgent[a.id]) {
      const note = document.createElement("p");
      note.className = "routing-paste-note delegation-mode-footnote";
      note.appendChild(document.createTextNode("Pasted from " + routingPasteNoticeByAgent[a.id] + " · "));
      const undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "routing-inline-link-btn routing-paste-undo-btn";
      undoBtn.textContent = "Undo";
      undoBtn.addEventListener("click", () => {
        if (Object.prototype.hasOwnProperty.call(routingPasteUndoByAgent, a.id)) {
          routingDraft.agents[a.id] = routingPasteUndoByAgent[a.id];
          delete routingPasteUndoByAgent[a.id];
        }
        delete routingPasteNoticeByAgent[a.id];
        renderRoutingModal();
      });
      note.appendChild(undoBtn);
      footer.appendChild(note);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "link-button agent-remove-link";
    setFooterActionIcon(removeBtn, "remove", "Remove");
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
    // Cross-vendor accent (p24-t2): color the slot's agent name as soon as
    // its assigned vendor is foreign/fallback to the current harness — even
    // with no run in progress, so users learn the color before they ever
    // see it live on the canvas. Vendor/costModelClass come from the roster
    // payload (agentMetrics, via metricsFor) when a run has reported them,
    // else from the slot editor's own selected backend vendor
    // (routingAgent.backend). harnessEffective is read live off
    // lastSettings so switching the harness select and re-running
    // renderRoutingModal (which rebuilds every card from scratch) always
    // reflects the new harness immediately — no separate recompute path.
    const cardHarness = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    const cardBackend = routingAgent && routingAgent.backend;
    const cardNameVendor = (m && m.vendor) || (cardBackend && cardBackend.vendor) || a.vendor || null;
    const cardNameCostClass = (m && m.costModelClass) || (cardBackend && cardBackend.costModelClass) || a.costModelClass || null;
    const cardNameFallbackOf = (m && m.fallbackOf) || null;
    const cardNameIsDefaultFallback = !!(m && m.fallbackIsDefault);
    const cardAccentKind = agentAccent({
      vendor: cardNameVendor,
      costModelClass: cardNameCostClass,
      fallbackOf: cardNameFallbackOf,
      harness: cardHarness,
    });
    // p27-t6: top-of-card accent bar signals "new agent starts here" and
    // reuses the same fallback/foreign/native classification as the
    // nameplate above — see agentAccent() in 005-agent-accent.js.
    card.classList.add("agent-card-accent-" + cardAccentKind);
    card.dataset.agentAccent = cardAccentKind;
    nameEl.className = "agent-name"
      + (cardAccentKind === "foreign" ? " agent-accent-foreign" : "")
      + (cardAccentKind === "fallback" ? " agent-accent-fallback" : "");
    nameEl.textContent = (a.name || a.id) + (cardAccentKind === "fallback" ? (cardNameIsDefaultFallback ? " (dfb)" : " (fb)") : "");
    head.appendChild(nameEl);

    // p68-t2: amber dot badge when this agent has one or more keyword-health
    // findings (lastKeywordHealth, refreshed by handleKeywordHealthPayload).
    var agentFindings = keywordHealthFindingsFor(a.id);
    if (agentFindings.length) {
      var kwBadge = document.createElement("span");
      kwBadge.className = "agent-keyword-health-badge";
      kwBadge.title = agentFindings.map(function (f) { return f.detail; }).join(" ");
      kwBadge.setAttribute("aria-label", agentFindings.length + " keyword routing issue" + (agentFindings.length === 1 ? "" : "s") + " for " + (a.name || a.id));
      head.appendChild(kwBadge);
    }

    if (density === "full" && routingAgent && routingAgent.description) {
      const desc = document.createElement("span");
      desc.className = "routing-agent-desc";
      desc.textContent = routingAgent.description;
      desc.title = routingAgent.description;
      head.appendChild(desc);
    }

    // p74-t2: single-provider mode (payload.uiMode === "single") replaces the
    // whole vendor/fallback/claudeTier decision tree below with one radio
    // group built from payload.singleProvider.tiers, matched against the
    // agent's current model string. Falls back to multi whenever uiMode is
    // absent (older host payload) per the interface contract.
    const singleMode = !!(payload && payload.uiMode === "single");
    const buildSingleProviderRadioGroup = () => {
      const group = document.createElement("div");
      group.className = "model-radio-group";
      const groupName = `model-single-${a.id}`;
      const tiers = (payload.singleProvider && payload.singleProvider.tiers) || [];
      const currentModel = a.model || a.resolvedModel || "";
      const hasMatch = tiers.some((t) => t.model === currentModel);
      tiers.forEach((tier) => {
        const lbl = document.createElement("label");
        lbl.className = "model-radio";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = groupName;
        input.value = tier.id;
        if (currentModel && tier.model === currentModel) input.checked = true;
        input.addEventListener("change", () => {
          if (input.checked) {
            justSetAgentModelId = a.id;
            vscode.postMessage({ type: "setAgentModel", id: a.id, model: tier.model });
          }
        });
        const span = document.createElement("span");
        span.textContent = tier.label;
        lbl.appendChild(input);
        lbl.appendChild(span);
        group.appendChild(lbl);
      });
      if (!hasMatch && currentModel) {
        const note = document.createElement("p");
        note.className = "delegation-mode-footnote single-provider-mismatch-note";
        note.textContent = `Uses ${currentModel}; turn on multi-provider in Settings to edit vendors and fallbacks.`;
        group.appendChild(note);
      }
      return group;
    };

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

    if (singleMode) {
      head.appendChild(buildSingleProviderRadioGroup());
    } else if (a.claudeTier) {
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

    // p74-t2: single mode stops here — no vendor dropdown, fallback chain
    // editor, routing profile picker, or cost-class controls. Keyword
    // health badge, name, keyword row and the remove footer above/below
    // already render for both modes.
    if (singleMode) {
      return appendCardRemoveFooter(card, a);
    }

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
      // A hand-written backend: block (e.g. codex-reviewer, gemini-reviewer)
      // always starts expanded — its checkbox is disabled/checked-read-only
      // below, so the user has no click to opt in with, but the fallback
      // editor still needs to render for these slots (p25-t1: the setup
      // notice used to appear INSTEAD of the slot body here since the body
      // never built at all for handWrittenBackend agents).
      const expanded = Object.prototype.hasOwnProperty.call(routingExpandedAgents, a.id)
        ? !!routingExpandedAgents[a.id]
        : (isRouted || !!a.handWrittenBackend);

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
        // p26-t1 fix: a hand-written-backend slot whose vendor is now
        // native to the running harness (e.g. codex-reviewer/openai under
        // Codex) has no bridge to describe — the checkbox stays disabled
        // (the user still can't opt out through this control) but reads
        // unchecked, and the help text drops the "via MCP (hand-written)"
        // bridge language so a native slot never shows a checked "Use
        // another provider" toggle with no provider fields beneath it.
        const providerNativeVendor = nativeVendorForHarness(cardHarness);
        const providerIsNativeVendor = !!providerNativeVendor && String(a.vendor || "").toLowerCase() === providerNativeVendor;
        const providerCheckbox = document.createElement("input");
        providerCheckbox.type = "checkbox";
        providerCheckbox.className = "agent-provider-checkbox";
        providerCheckbox.checked = a.handWrittenBackend && providerIsNativeVendor ? false : (!!a.handWrittenBackend || expanded);
        providerCheckbox.disabled = !!a.handWrittenBackend;
        const providerBody = document.createElement("span");
        providerBody.className = "delegation-mode-option-body";
        const providerLabelSpan = document.createElement("span");
        providerLabelSpan.className = "delegation-mode-option-label";
        providerLabelSpan.textContent = "Use another provider for this agent";
        const providerHelpSpan = document.createElement("span");
        providerHelpSpan.className = "delegation-mode-option-help";
        providerHelpSpan.textContent = a.handWrittenBackend
          ? (providerIsNativeVendor
            ? `Backend: ${vendorLabelFor(a.vendor || "unknown")} (native to this harness)`
            : `Backend: ${vendorLabelFor(a.vendor || "unknown")} via MCP (hand-written)`)
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

      if (expanded) {
        // p25-t1: render the slot body (fields + fallback editor) for
        // handWrittenBackend slots too, alongside the subscription/MCP
        // notice buildSlotEditorFields appends internally — previously this
        // block was gated `&& !a.handWrittenBackend`, so the notice showed
        // with no body underneath and buildFallbackEditor never ran for any
        // subscription-billed non-Anthropic vendor or backend-block slot.
        if (!routingDraft.agents[a.id]) routingDraft.agents[a.id] = {};
        if ((isRouted || a.handWrittenBackend) && !slotHasContent(routingDraft.agents[a.id])) {
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
          editorWrap.appendChild(chipLine);
        }
        // p27-t3: always-visible slot identity line, replacing the old
        // "Routed to <vendor>/<model>" chip (now folded into this line's
        // vendor/model/route text) — see buildSlotSummaryLine above.
        editorWrap.appendChild(buildSlotSummaryLine(slot, routingCurrentHarness, {
          id: a.id,
          name: a.name || a.id,
          // Same fallback values the old "Routed to <vendor>/<model>" chip
          // used, so an empty draft slot for an already-routed agent shows
          // the real vendor/model instead of "unknown" (review fix).
          resolvedVendor: a.vendor || (routingAgent.backend && routingAgent.backend.vendor),
          resolvedModel: a.resolvedModel || a.model,
        }));
    var slotFieldsEl = buildSlotEditorFields(slot, presets, renderRoutingModal, "agent:" + a.id, { id: a.id, name: a.name || a.id, handWrittenBackend: !!a.handWrittenBackend });
        editorWrap.appendChild(slotFieldsEl);
        editorWrap.appendChild(buildFallbackEditor(slot, presets, renderRoutingModal, a.id, "agent:" + a.id));
        if (slotFieldsEl._refreshSubscriptionNotice) {
          editorWrap.addEventListener("input", slotFieldsEl._refreshSubscriptionNotice);
          editorWrap.addEventListener("change", slotFieldsEl._refreshSubscriptionNotice);
        }
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
    slotTd.appendChild(buildSlotSummaryLine(slot, routingCurrentHarness, {
      id: a.id,
      name: a.name || a.id,
      resolvedVendor: a.vendor || (routingAgent.backend && routingAgent.backend.vendor),
      resolvedModel: a.resolvedModel || a.model,
    }));
    const fullSlotFieldsEl = buildSlotEditorFields(slot, presets, renderRoutingModal, "agent:" + a.id, { id: a.id, name: a.name || a.id, handWrittenBackend: !!a.handWrittenBackend });
    slotTd.appendChild(fullSlotFieldsEl);
    routingRow.appendChild(slotTd);

    card.appendChild(routingRow);

    const fbRow = document.createElement("div");
    fbRow.className = "routing-agent-fallback-row";
    fbRow.setAttribute("data-agent-id", a.id);
    fbRow.appendChild(buildFallbackEditor(slot, presets, renderRoutingModal, a.id, "agent:" + a.id));
    card.appendChild(fbRow);
    if (fullSlotFieldsEl._refreshSubscriptionNotice) {
      card.addEventListener("input", fullSlotFieldsEl._refreshSubscriptionNotice);
      card.addEventListener("change", fullSlotFieldsEl._refreshSubscriptionNotice);
    }

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
    if (!routingDraft) routingDraft = ensureDefaultFallbackDraft(buildRoutingDraft(lastRoutingPayload), lastRoutingPayload);

    var payload = lastRoutingPayload;
    // p74-t2: single-provider UI mode (2026-09-19 decision). Absent uiMode
    // (older host payload) renders multi, per the interface contract.
    var uiMode = payload.uiMode === "single" ? "single" : "multi";
    // Density (p20-t2): keyed on the harness itself, not the old
    // routing.visible toggle — full (OpenCode's editable routing table) when
    // the effective harness is opencode, classic (the plain agent cards)
    // otherwise.
    var harnessEffective = (lastSettings && lastSettings.harness && lastSettings.harness.effective) || "claude-code";
    var isClaudeHarness = harnessEffective !== "opencode";
    var density = isClaudeHarness ? "simple" : "full";

    // p25-t4: harness + GEMINI_API_KEY presence for this render pass, read
    // by buildFallbackEditor (per-fallback-item warnings) and the Default
    // fallback picker below; routingHasBlockingDispatchWarning accumulates
    // across both and gates the Save button at the bottom of this function.
    routingCurrentHarness = harnessEffective;
    var geminiProbe = routingEnvProbe["GEMINI_API_KEY"];
    routingCurrentGeminiKeyPresent = !!(geminiProbe && (geminiProbe.env || geminiProbe.stored));
    routingHasBlockingDispatchWarning = false;

    // Read-only "Runs on <harness> · Change in Settings" line atop the
    // Agents screen (2026-09-05 decision): the harness question is asked
    // ONLY in Settings now — no dropdown here, just a link back to it.
    // buildHarnessControl is still used by Settings itself, further below.
    // p68-t2: Keyword health card — above the harness line, both densities.
    var keywordHealthCardEl = buildKeywordHealthCard();
    if (keywordHealthCardEl) routingContentEl.appendChild(keywordHealthCardEl);

    var agentsHarnessLine = buildAgentsHarnessLine(harnessEffective);
    if (agentsHarnessLine) {
      routingContentEl.appendChild(agentsHarnessLine);
      // Cross-vendor accent legend (p24-t2): one short line explaining the
      // two accent colors used on roster/canvas nameplates so users learn
      // the association before ever hitting it live.
      // p71-t1: this single line also covers the fallback picker/warnings
      // below — a second "Amber (fb)/(dfb)" line used to render right after
      // it, duplicating the same legend.
      if (uiMode !== "single") {
        var accentLegend = document.createElement("p");
        accentLegend.className = "agent-accent-legend";
        accentLegend.textContent = "Light blue: running on an LLM foreign to this harness · Amber (fb): fallback · (dfb): default fallback";
        routingContentEl.appendChild(accentLegend);
      }
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
    var presets = { vendors: Object.keys(vendorSet).sort(), models: rawPresets.models || [], vendorKeys: rawPresets.vendorKeys || [] };

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

    var externalBox = buildExternalSettingsBox(payload.bridge);
    if (externalBox) routingContentEl.appendChild(externalBox);

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
      orchSection.appendChild(buildSlotSummaryLine(routingDraft.orchestrator, routingCurrentHarness, {
        id: "orchestrator",
        name: "Orchestrator",
        resolvedVendor: payload.orchestrator && payload.orchestrator.backend && payload.orchestrator.backend.vendor,
        resolvedModel: payload.orchestrator && payload.orchestrator.backend && payload.orchestrator.backend.model,
      }));
      var orchSlotFieldsEl = buildSlotEditorFields(routingDraft.orchestrator, presets, renderRoutingModal, "orchestrator", { id: "orchestrator", name: "Orchestrator" });
      orchSection.appendChild(orchSlotFieldsEl);
      orchSection.appendChild(buildFallbackEditor(routingDraft.orchestrator, presets, renderRoutingModal, "orchestrator", "orchestrator"));
      if (orchSlotFieldsEl._refreshSubscriptionNotice) {
        orchSection.addEventListener("input", orchSlotFieldsEl._refreshSubscriptionNotice);
        orchSection.addEventListener("change", orchSlotFieldsEl._refreshSubscriptionNotice);
      }
    }
    if (orchestratorAgent || density === "full") {
      routingContentEl.appendChild(orchSection);
    }

    // ── Default fallback (p25-t4, moved below Orchestrator + collapsed
    // p32-t1) — rendered in BOTH densities: it was previously gated behind
    // `density === "full"`, which meant a claude-code-harness user (density
    // "simple", the default harness) could never see or configure it at
    // all — that was the root cause of the "I don't see anywhere to set up
    // a default fallback" report. Top-level `defaultFallback` slot used at
    // RESOLVE time by any slot whose own `fallback` is empty (see
    // routingProfile.ts's defaultFallback doc comment) unless a slot's own
    // `useDefaultFallback` is explicitly false. Never preset — an empty
    // draft just means "None". Collapsed by default (<details>) so it reads
    // as an opt-in offer, not a required step; summary text reflects
    // current state so a set default is visible without expanding.
    if (!routingDraft.defaultFallback) routingDraft.defaultFallback = {};
    var defaultFallbackIsSet = slotHasContent(routingDraft.defaultFallback);
    if (uiMode !== "single") {
    var defaultFallbackDetails = document.createElement("details");
    defaultFallbackDetails.className = "routing-default-fallback-section";
    var defaultFallbackSummary = document.createElement("summary");
    if (defaultFallbackIsSet) defaultFallbackDetails.open = true;
    defaultFallbackDetails.appendChild(defaultFallbackSummary);
    var defaultFallbackSummaryHint = document.createElement("p");
    defaultFallbackSummaryHint.className = "routing-defaults-help routing-default-fallback-summary-hint";
    defaultFallbackSummaryHint.textContent = "Catches any agent that runs out of tokens or is unreachable after its own chain.";
    defaultFallbackDetails.appendChild(defaultFallbackSummaryHint);
    var defaultFallbackHelp = document.createElement("p");
    defaultFallbackHelp.className = "routing-defaults-help";
    defaultFallbackHelp.textContent = "Fires for any agent after its own fallback chain when it runs out of tokens or is unreachable. Agents can opt out below.";
    defaultFallbackDetails.appendChild(defaultFallbackHelp);
    var defaultFallbackSummaryLineEl = buildSlotSummaryLine(routingDraft.defaultFallback, routingCurrentHarness, { id: "defaultFallback", name: "Default fallback" }, false, true);
    defaultFallbackDetails.appendChild(defaultFallbackSummaryLineEl);
    var defaultFallbackFieldsEl = buildSlotEditorFields(routingDraft.defaultFallback, presets, renderRoutingModal, "defaultFallback", { id: "defaultFallback", name: "Default fallback" });
    defaultFallbackDetails.appendChild(defaultFallbackFieldsEl);
    var defaultFallbackCheck = isFallbackTargetDispatchableWebview(routingDraft.defaultFallback, routingCurrentHarness, routingCurrentGeminiKeyPresent);
    var defaultFallbackWarning = buildFallbackDispatchWarning(defaultFallbackCheck);
    if (defaultFallbackWarning) {
      if (defaultFallbackCheck.ok === false) routingHasBlockingDispatchWarning = true;
      defaultFallbackDetails.appendChild(defaultFallbackWarning);
    }

    // p32-t3: live summary refresh. The toggle <summary> and the
    // buildSlotSummaryLine row above are built once per renderRoutingModal
    // pass, but buildSlotEditorFields' model/cost-class <select> "change"
    // handlers mutate routingDraft.defaultFallback in place WITHOUT calling
    // onStructural (only vendor/transport changes trigger a full rebuild —
    // see buildSlotEditorFields) — so without this, the summary froze at
    // whatever the vendor picker last set (root cause of the "anthropic ·
    // unknown model" report: vendor was live, model wasn't). Recomputing
    // both text nodes from the live routingDraft.defaultFallback object on
    // every input/change inside the section (and once more right after
    // Save) keeps them honest without forcing a full DOM rebuild.
    function refreshDefaultFallbackSummary() {
      var isSet = slotHasContent(routingDraft.defaultFallback);
      if (isSet) {
        defaultFallbackSummary.className = "agent-accent-fallback";
        var s = routingDraft.defaultFallback;
        var nativeVendor = nativeVendorForHarness(routingCurrentHarness);
        var vendor = s.vendor || nativeVendor || "unknown";
        var model = s.model || "unknown model";
        var isNativeVendor = !!nativeVendor && vendor.toLowerCase() === nativeVendor;
        var route = s.transport === "mcp" ? "bridged via MCP " + (s.mcpServer || "(not installed)")
          : s.transport === "openai-compatible" ? "OpenAI-compatible endpoint"
          : isNativeVendor ? "native" : (s.transport || "claude-native");
        var billing = s.costModelClass || "metered";
        defaultFallbackSummary.textContent = "Default fallback: " + vendor + " · " + model + " · " + route + " · " + billing;
      } else {
        defaultFallbackSummary.textContent = "Set up a default fallback?";
      }
      defaultFallbackSummaryHint.hidden = isSet;
      var freshLine = buildSlotSummaryLine(routingDraft.defaultFallback, routingCurrentHarness, { id: "defaultFallback", name: "Default fallback" }, false, true);
      defaultFallbackSummaryLineEl.replaceWith(freshLine);
      defaultFallbackSummaryLineEl = freshLine;
      // clearDefaultFallbackBtn is created below (after this function is
      // declared and first invoked, since its own disabled state depends on
      // defaultFallbackIsSet computed up top) — guard against the var not
      // being assigned yet on that very first call.
      if (clearDefaultFallbackBtn) clearDefaultFallbackBtn.disabled = !isSet;
    }
    refreshDefaultFallbackSummary();
    defaultFallbackDetails.addEventListener("input", refreshDefaultFallbackSummary);
    defaultFallbackDetails.addEventListener("change", refreshDefaultFallbackSummary);
    if (defaultFallbackFieldsEl._refreshSubscriptionNotice) {
      defaultFallbackDetails.addEventListener("input", defaultFallbackFieldsEl._refreshSubscriptionNotice);
      defaultFallbackDetails.addEventListener("change", defaultFallbackFieldsEl._refreshSubscriptionNotice);
    }

    // p32-t3: per-section Save, identical persistence path to the per-agent
    // card Save button (doCardSave in buildUnifiedAgentCard) — both simply
    // call the shared saveRoutingProfile(), which assembles the WHOLE
    // routingDraft (including defaultFallback, see assembleRoutingProfile)
    // and posts ROUTING_MSG.SAVE. Gated the same way the footer Save button
    // is (routingSaving / routingHasBlockingDispatchWarning, p25-t4).
    var defaultFallbackFooter = document.createElement("div");
    defaultFallbackFooter.className = "routing-default-fallback-footer";
    var defaultFallbackSaveBtn = document.createElement("button");
    defaultFallbackSaveBtn.type = "button";
    defaultFallbackSaveBtn.className = "skill-btn settings-btn agent-card-save-btn routing-default-fallback-save-btn";
    defaultFallbackSaveBtn.textContent = "Save";
    defaultFallbackSaveBtn.title = "Save the default fallback";
    defaultFallbackSaveBtn.disabled = routingSaving || routingHasBlockingDispatchWarning;
    defaultFallbackSaveBtn.addEventListener("click", function () {
      refreshDefaultFallbackSummary();
      saveRoutingProfile();
      showToast("Saving…", "info");
    });
    defaultFallbackFooter.appendChild(defaultFallbackSaveBtn);
    var clearDefaultFallbackBtn = document.createElement("button");
    clearDefaultFallbackBtn.type = "button";
    clearDefaultFallbackBtn.className = "link-button agent-remove-link routing-clear-defaults-btn";
    clearDefaultFallbackBtn.textContent = "Remove default fallback";
    clearDefaultFallbackBtn.disabled = !defaultFallbackIsSet;
    clearDefaultFallbackBtn.addEventListener("click", function () {
      routingDraft.defaultFallback = {};
      renderRoutingModal();
    });
    defaultFallbackFooter.appendChild(clearDefaultFallbackBtn);
    defaultFallbackDetails.appendChild(defaultFallbackFooter);
    routingContentEl.appendChild(defaultFallbackDetails);
    } // uiMode !== "single"

    // ── Defaults (p17-t3) — full density only. One slot applied to every
    // agent that has neither its own routing.json entry nor a hand-written
    // backend block.
    if (density === "full" && uiMode !== "single") {
      var defaultsSection = buildSection("Default for all agents");
      var defaultsHelp = document.createElement("p");
      defaultsHelp.className = "routing-defaults-help";
      defaultsHelp.textContent = "Agents without their own route use this. Agents with a hand-written backend keep it.";
      defaultsSection.appendChild(defaultsHelp);
      if (!routingDraft.defaults) routingDraft.defaults = {};
      defaultsSection.appendChild(buildSlotSummaryLine(routingDraft.defaults, routingCurrentHarness, { id: "defaults", name: "Default for all agents" }));
      var defaultsSlotFieldsEl = buildSlotEditorFields(routingDraft.defaults, presets, renderRoutingModal, "defaults", { id: "defaults", name: "Default for all agents" });
      defaultsSection.appendChild(defaultsSlotFieldsEl);
      defaultsSection.appendChild(buildFallbackEditor(routingDraft.defaults, presets, renderRoutingModal, "defaults", "defaults"));
      if (defaultsSlotFieldsEl._refreshSubscriptionNotice) {
        defaultsSection.addEventListener("input", defaultsSlotFieldsEl._refreshSubscriptionNotice);
        defaultsSection.addEventListener("change", defaultsSlotFieldsEl._refreshSubscriptionNotice);
      }
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
    // Exclude the orchestrator from the roster card list: it is configured
    // by the dedicated slot block above, not by an ordinary agent card.
    // Match on payload.orchestrator.id (buildRoutingView's authoritative
    // orchestrator id) plus the literal ids/flags the hosts use elsewhere
    // (panel.ts _handleGetSettings, server.mjs buildStandaloneSettingsPayload,
    // removeAgent's "orchestrator"/"coordinator" guard) so a mismatched or
    // missing orchestrator.id still doesn't leak a duplicate card.
    var orchestratorRoutingId = payload.orchestrator && payload.orchestrator.id;
    function isOrchestratorRosterEntry(ag) {
      if (!ag) return false;
      if (ag.isOrchestrator) return true;
      if (ag.id === "orchestrator" || ag.id === "coordinator") return true;
      if (orchestratorRoutingId && ag.id === orchestratorRoutingId) return true;
      if (ag.tier === "coordinator" || ag.isCoordinator) return true;
      return false;
    }
    var routingAgentList = (payload.agents || []).filter(function (ag) {
      return !isOrchestratorRosterEntry(ag);
    });
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
      routingSaveBtnEl.disabled = routingSaving || routingHasBlockingDispatchWarning;
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

    // p25-t4: top-level defaultFallback, same sparse-save posture as
    // defaults above — an empty/cleared draft (the "None" button) simply
    // omits the key rather than writing `{}`.
    var defaultFallbackCleaned = cleanRoutingSlot(routingDraft.defaultFallback, undefined, presetVendors);
    if (defaultFallbackCleaned) profile.defaultFallback = defaultFallbackCleaned;

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

  /**
   * Warning-severity keyword-health findings for one agent id, or [] if
   * none/unknown. p71-t1: info-severity findings (specialist-to-specialist
   * shared keywords) are harmless and never drive the per-agent amber badge.
   */
  function keywordHealthFindingsFor(agentId) {
    if (!lastKeywordHealth || !Array.isArray(lastKeywordHealth.findings)) return [];
    return lastKeywordHealth.findings.filter(function (f) {
      return f && f.agentId === agentId && f.severity !== "info";
    });
  }

  /** p68-t2: KEYWORD_HEALTH push handler — re-renders the Agents screen if open. */
  function handleKeywordHealthPayload(payload) {
    // p71-t1: if this push follows a "Fix all" we just sent, diff the
    // before/after warning + info counts into a one-line result — computed
    // client-side from the two payloads, no dedicated host message.
    if (keywordHealthFixAllPending) {
      var afterFindings = (payload && Array.isArray(payload.findings)) ? payload.findings : [];
      var afterWarnings = afterFindings.filter(function (f) { return f && f.severity !== "info"; }).length;
      var afterInfo = afterFindings.filter(function (f) { return f && f.severity === "info"; }).length;
      var fixedCount = Math.max(0, keywordHealthFixAllBeforeWarnings - afterWarnings);
      keywordHealthFixResultText = "Fixed " + fixedCount + ". " + afterInfo
        + " shared keyword" + (afterInfo === 1 ? "" : "s") + " are informational.";
      keywordHealthFixAllPending = false;
    } else {
      // p71-t1 review fix: not a fix_all round-trip (e.g. a later
      // unrelated push, or the periodic GET_KEYWORD_HEALTH refresh) — clear
      // any stale result line so it never lingers past the round-trip it
      // was for.
      keywordHealthFixResultText = null;
    }
    lastKeywordHealth = payload || null;
    if (routingModalEl && !routingModalEl.hasAttribute("hidden") && lastRoutingPayload) {
      renderRoutingModal();
    }
  }

  /**
   * p68-t2: "Keyword health" card at the top of the Agents screen — a
   * single all-clear line, or the findings grouped by agent plus the
   * wildcard-fallthrough line with per-word "add to <agent>" chips. All
   * text nodes use textContent (findings/tokens are config-derived, but
   * never trusted as markup).
   */
  function buildKeywordHealthCard() {
    var health = lastKeywordHealth;
    // No payload yet (first paint before the host replies) — render nothing
    // rather than a misleading "all routable" claim.
    if (!health) return null;

    var card = document.createElement("div");
    card.className = "keyword-health-card";

    var allFindings = (health && Array.isArray(health.findings)) ? health.findings : [];
    // p71-t1: only warning-severity findings drive the header count/amber
    // state and the fixable list. info-severity findings (a token two
    // specialists both legitimately own) are harmless overlap, not a
    // routing bug — collapsed under "Shared keywords" below, never counted.
    var findings = allFindings.filter(function (f) { return f && f.severity !== "info"; });
    var infoFindings = allFindings.filter(function (f) { return f && f.severity === "info"; });
    var wildcardCount = (health && typeof health.wildcardTasksThisSession === "number") ? health.wildcardTasksThisSession : 0;
    var unmatchedWords = (health && Array.isArray(health.unmatchedWords)) ? health.unmatchedWords : [];

    if (findings.length === 0) {
      card.classList.add("keyword-health-card-ok");
      var okLine = document.createElement("p");
      okLine.className = "keyword-health-summary";
      okLine.textContent = "All agents routable";
      card.appendChild(okLine);
    } else {
      card.classList.add("keyword-health-card-warn");
      var head = document.createElement("div");
      head.className = "keyword-health-head";
      var warnLine = document.createElement("p");
      warnLine.className = "keyword-health-summary";
      warnLine.textContent = findings.length + " keyword routing issue" + (findings.length === 1 ? "" : "s");
      head.appendChild(warnLine);

      var actions = document.createElement("div");
      actions.className = "keyword-health-actions";
      var fixAllBtn = document.createElement("button");
      fixAllBtn.type = "button";
      fixAllBtn.className = "skill-btn settings-btn keyword-health-fix-all";
      fixAllBtn.textContent = "Fix all";
      fixAllBtn.addEventListener("click", function () {
        fixAllBtn.disabled = true;
        keywordHealthFixAllPending = true;
        keywordHealthFixAllBeforeWarnings = findings.length;
        keywordHealthFixResultText = null;
        vscode.postMessage({ type: KEYWORD_HEALTH_MSG.FIX, action: "fix_all" });
      });
      actions.appendChild(fixAllBtn);

      var openConfigBtn = document.createElement("button");
      openConfigBtn.type = "button";
      openConfigBtn.className = "skill-btn settings-btn keyword-health-open-config";
      openConfigBtn.textContent = "Open agent-keywords.json";
      openConfigBtn.addEventListener("click", function () {
        vscode.postMessage({ type: "OPEN_AGENT_KEYWORDS_FILE" });
      });
      actions.appendChild(openConfigBtn);
      head.appendChild(actions);
      card.appendChild(head);

      var list = document.createElement("ul");
      list.className = "keyword-health-findings";
      // Group by agentId, preserving first-seen order.
      var order = [];
      var byAgent = {};
      findings.forEach(function (f) {
        if (!f || !f.agentId) return;
        if (!byAgent[f.agentId]) { byAgent[f.agentId] = []; order.push(f.agentId); }
        byAgent[f.agentId].push(f);
      });
      order.forEach(function (agentId) {
        byAgent[agentId].forEach(function (f) {
          var item = document.createElement("li");
          item.className = "keyword-health-finding";
          var label = document.createElement("span");
          label.className = "keyword-health-finding-agent";
          label.textContent = agentId + ": ";
          item.appendChild(label);
          var detail = document.createElement("span");
          detail.textContent = f.detail || "";
          item.appendChild(detail);
          list.appendChild(item);
        });
      });
      card.appendChild(list);
    }

    // p71-t1: one-line "Fix all" result, computed client-side from the
    // before/after payloads (see handleKeywordHealthPayload). Cleared once
    // the health state changes again outside a fix_all round-trip via the
    // click handler above resetting it to null before the next request.
    if (keywordHealthFixResultText) {
      var fixResultLine = document.createElement("p");
      fixResultLine.className = "keyword-health-fix-result";
      fixResultLine.textContent = keywordHealthFixResultText;
      card.appendChild(fixResultLine);
    }

    // p71-t1: specialist-to-specialist duplicate_keyword findings are
    // informational only — collapsed by default, no amber, not counted.
    if (infoFindings.length) {
      var sharedDetails = document.createElement("details");
      sharedDetails.className = "keyword-health-shared";
      var sharedSummary = document.createElement("summary");
      sharedSummary.textContent = "Shared keywords (" + infoFindings.length + ")";
      sharedDetails.appendChild(sharedSummary);
      var sharedList = document.createElement("ul");
      sharedList.className = "keyword-health-findings keyword-health-findings-info";
      infoFindings.forEach(function (f) {
        var item = document.createElement("li");
        item.className = "keyword-health-finding keyword-health-finding-info";
        item.textContent = f.detail || "";
        sharedList.appendChild(item);
      });
      sharedDetails.appendChild(sharedList);
      card.appendChild(sharedDetails);
    }

    // Wildcard fall-through line — shown whenever there is something to
    // report, in both the ok and warn states.
    if (wildcardCount > 0 || unmatchedWords.length > 0) {
      var wcLine = document.createElement("p");
      wcLine.className = "keyword-health-wildcard-line";
      wcLine.textContent = wildcardCount + " task" + (wildcardCount === 1 ? "" : "s") + " fell through to Wildcard Agent this session";
      card.appendChild(wcLine);

      if (unmatchedWords.length) {
        var chipRow = document.createElement("div");
        chipRow.className = "keyword-health-chip-row";
        var rosterAgents = (lastSettings && Array.isArray(lastSettings.agents)) ? lastSettings.agents : [];
        unmatchedWords.forEach(function (word) {
          chipRow.appendChild(buildKeywordHealthChip(word, rosterAgents));
        });
        card.appendChild(chipRow);
      }
    }

    return card;
  }

  /** One unmatched-word chip with an inline "add to <agent>" picker (p68-t2). */
  function buildKeywordHealthChip(word, rosterAgents) {
    var chip = document.createElement("span");
    chip.className = "keyword-health-chip";

    var text = document.createElement("span");
    text.className = "keyword-health-chip-text";
    text.textContent = word;
    chip.appendChild(text);

    var isOpen = keywordHealthOpenPickerToken === word;
    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "keyword-health-chip-add";
    addBtn.textContent = "add to…";
    addBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    addBtn.addEventListener("click", function () {
      keywordHealthOpenPickerToken = isOpen ? null : word;
      renderRoutingModal();
    });
    chip.appendChild(addBtn);

    if (isOpen) {
      var picker = document.createElement("select");
      picker.className = "keyword-health-chip-picker";
      var placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose agent…";
      picker.appendChild(placeholder);
      rosterAgents
        .filter(function (ag) { return !ag.isOrchestrator; })
        .forEach(function (ag) {
          var opt = document.createElement("option");
          opt.value = ag.id;
          opt.textContent = ag.name || ag.id;
          picker.appendChild(opt);
        });
      picker.addEventListener("change", function () {
        var agentId = picker.value;
        if (!agentId) return;
        vscode.postMessage({ type: KEYWORD_HEALTH_MSG.FIX, action: "add", agentId: agentId, token: word });
        keywordHealthOpenPickerToken = null;
      });
      chip.appendChild(picker);
    }

    return chip;
  }

  function handleRoutingPayload(payload) {
    lastRoutingPayload = payload || null;
    // Gemini backend (agy|gemini) feeds the metrics billing badge.
    if (lastMetrics && lastMetrics.length) {
      renderMetricsTable(currentScopeMetrics());
      // Delegation tab's Model column shows the routed backend model.
      renderDelegationStats(state.modeStats);
    }
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
      routingDraft = ensureDefaultFallbackDraft(buildRoutingDraft(payload), payload);
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

  /**
   * Update the Settings screen's "I use more than one AI provider"
   * checkbox in place from a fresh lastRoutingPayload, without rebuilding
   * the rest of #setup-config (review fix 2026-09-23: a full renderSettings()
   * on every routing reply could steal focus from another field the user
   * has open). No-op when the row isn't currently mounted (Settings not
   * open yet, or hidden for the OpenCode harness) or when lastRoutingPayload
   * is still null.
   */
  function updateSettingsMultiProviderRow() {
    if (!settingsMultiProviderCheckboxEl || !lastRoutingPayload) return;
    settingsMultiProviderCheckboxEl.checked = !!lastRoutingPayload.multiProviderSetting;
    settingsMultiProviderCheckboxEl.disabled = false;
    settingsMultiProviderCheckboxEl.title = "";
    if (settingsMultiProviderHelpEl) {
      settingsMultiProviderHelpEl.textContent = "Shows vendor and fallback controls for every agent.";
    }
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

      // p74-t2: "I use more than one AI provider" checkbox (2026-09-19
      // decision), rendered directly under the harness line. These two
      // fields live on the Agents-screen payload (lastRoutingPayload), not
      // lastSettings, per the interface contract — read them from there.
      const multiProviderPayload = lastRoutingPayload;
      // p74 first-open fix (2026-09-23): lastRoutingPayload only arrives
      // once the Agents screen has been opened (openRoutingModal sends
      // ROUTING_MSG.GET). Settings is now given the same request on its
      // own first "settings" push (see the ROUTING_MSG.GET postMessage
      // below in the settings message handler), but until that reply
      // lands, default to showing the checkbox for any non-OpenCode
      // harness rather than hiding it — hiding-by-default is the bug.
      const multiProviderHarnessEff = (lastSettings.harness && lastSettings.harness.effective) || "claude-code";
      const showMultiProviderCheckbox = multiProviderPayload
        ? !!multiProviderPayload.multiProviderCheckboxVisible
        : multiProviderHarnessEff !== "opencode";
      if (showMultiProviderCheckbox) {
        const multiProviderRow = document.createElement("label");
        multiProviderRow.className = "delegation-mode-option settings-multi-provider-row";
        const multiProviderCheckbox = document.createElement("input");
        multiProviderCheckbox.type = "checkbox";
        multiProviderCheckbox.className = "settings-multi-provider-checkbox";
        // Review fix (2026-09-23): while multiProviderPayload hasn't arrived
        // yet, the checked state below is a placeholder (always false), not
        // the real persisted value — disable the control so a stray click
        // can't post setAgentsMultiProvider:false and clobber a saved true.
        // updateSettingsMultiProviderRow() re-enables it (with the real
        // checked value) once the routing reply lands, in place, without a
        // full renderSettings() rebuild.
        multiProviderCheckbox.checked = !!(multiProviderPayload && multiProviderPayload.multiProviderSetting);
        multiProviderCheckbox.disabled = !multiProviderPayload;
        multiProviderCheckbox.title = multiProviderPayload ? "" : "Loading…";
        multiProviderCheckbox.addEventListener("change", () => {
          if (multiProviderCheckbox.disabled) return;
          vscode.postMessage({ type: "setAgentsMultiProvider", value: multiProviderCheckbox.checked });
        });
        const multiProviderBody = document.createElement("span");
        multiProviderBody.className = "delegation-mode-option-body";
        const multiProviderLabelSpan = document.createElement("span");
        multiProviderLabelSpan.className = "delegation-mode-option-label";
        multiProviderLabelSpan.textContent = "I use more than one AI provider";
        const multiProviderHelpSpan = document.createElement("span");
        multiProviderHelpSpan.className = "delegation-mode-option-help";
        multiProviderHelpSpan.textContent = multiProviderPayload
          ? "Shows vendor and fallback controls for every agent."
          : "Shows vendor and fallback controls for every agent. Loading…";
        multiProviderBody.appendChild(multiProviderLabelSpan);
        multiProviderBody.appendChild(multiProviderHelpSpan);
        multiProviderRow.appendChild(multiProviderCheckbox);
        multiProviderRow.appendChild(multiProviderBody);
        harnessSection.appendChild(multiProviderRow);
        // Kept live so a later routing reply can update this exact row in
        // place (see updateSettingsMultiProviderRow) instead of forcing a
        // full renderSettings() rebuild that would steal focus elsewhere
        // in the Settings screen.
        settingsMultiProviderCheckboxEl = multiProviderCheckbox;
        settingsMultiProviderHelpEl = multiProviderHelpSpan;
      } else {
        settingsMultiProviderCheckboxEl = null;
        settingsMultiProviderHelpEl = null;
      }

      // OpenCode only: Claude models default to an Anthropic API key
      // (ANTHROPIC_API_KEY); routing through the user's Claude subscription
      // via the `claude -p` CLI bridge is an explicit per-user opt-in.
      if (multiProviderHarnessEff === "opencode") {
        const claudeSubRow = document.createElement("label");
        claudeSubRow.className = "delegation-mode-option settings-claude-subscription-row";
        const claudeSubCheckbox = document.createElement("input");
        claudeSubCheckbox.type = "checkbox";
        claudeSubCheckbox.className = "settings-claude-subscription-checkbox";
        claudeSubCheckbox.checked = claudeSubscriptionOptedIn();
        claudeSubCheckbox.disabled = !lastRoutingPayload;
        claudeSubCheckbox.addEventListener("change", () => {
          if (claudeSubCheckbox.disabled) return;
          vscode.postMessage({ type: "setClaudeSubscriptionOptIn", value: claudeSubCheckbox.checked });
        });
        const claudeSubBody = document.createElement("span");
        claudeSubBody.className = "delegation-mode-option-body";
        const claudeSubLabel = document.createElement("span");
        claudeSubLabel.className = "delegation-mode-option-label";
        claudeSubLabel.textContent = "Allow Claude subscription via the claude CLI under OpenCode";
        const claudeSubHelp = document.createElement("span");
        claudeSubHelp.className = "delegation-mode-option-help";
        claudeSubHelp.textContent = "Off by default: Claude models use an Anthropic API key (" + CLAUDE_API_KEY_ENV_NAME + "). " + CLAUDE_SUBSCRIPTION_NOTE;
        claudeSubBody.appendChild(claudeSubLabel);
        claudeSubBody.appendChild(claudeSubHelp);
        claudeSubRow.appendChild(claudeSubCheckbox);
        claudeSubRow.appendChild(claudeSubBody);
        harnessSection.appendChild(claudeSubRow);
      }

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
        label: "Direct (recommended for most projects)",
        help: "The orchestrator briefs specialist workers directly — it does the reviewing itself. Lowest coordination cost; best for focused fixes.",
      },
      {
        value: "team_leads",
        label: "Team Leads",
        help: "Adds persistent lead agents that manage domain teams (build, quality). Costs roughly 10-20% more tokens on small tasks and adds a coordination hop. Pays off on large builds from design docs — many features across many files — where it reduces orchestrator context churn, re-briefing, and mid-build context loss. If you mostly do focused fixes, stay Direct.",
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
    const parsedJournalEntries = parseInt(lastSettings.sessionJournalEntries, 10);
    const currentJournalEntries = Number.isNaN(parsedJournalEntries) ? 3 : Math.max(0, Math.min(5, parsedJournalEntries));
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
    // On-by-default toggle for the Project Plan tab in the metrics panel (see
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
    planTitle.textContent = "Project Plan (optional)";
    const planNote = document.createElement("small");
    planNote.textContent = "Phase/task planning workflow with approve/retry controls. On by default — uncheck to turn it off.";
    planTextWrap.appendChild(planTitle);
    planTextWrap.appendChild(planNote);
    planLabel.appendChild(planCheckbox);
    planLabel.appendChild(planTextWrap);
    planRow.appendChild(planLabel);
    planSection.appendChild(planRow);
    setupConfigEl.appendChild(planSection);

    // ── 1.7. Team setup export (p48-t3) ──
    // Exports the current roster/routing/skills/mcp/delegation state to
    // .claude/tycoon-team.json — no env var values, no absolute paths.
    const teamSetupSection = buildSection("Team setup");
    const teamSetupHint = document.createElement("p");
    teamSetupHint.className = "settings-empty";
    teamSetupHint.textContent = "Export the current agent roster, routing, skills, MCP servers, and delegation settings to .claude/tycoon-team.json — names only, never secrets.";
    teamSetupSection.appendChild(teamSetupHint);
    const teamSetupExportBtn = document.createElement("button");
    teamSetupExportBtn.className = "skill-btn settings-btn";
    teamSetupExportBtn.id = "team-setup-export-btn";
    teamSetupExportBtn.textContent = "Export team setup";
    const teamSetupNotice = document.createElement("p");
    teamSetupNotice.className = "theme-review-retry-warning";
    teamSetupNotice.id = "team-setup-export-notice";
    teamSetupNotice.setAttribute("hidden", "");
    teamSetupExportBtn.addEventListener("click", () => {
      teamSetupExportBtn.disabled = true;
      teamSetupNotice.setAttribute("hidden", "");
      vscode.postMessage({ type: "EXPORT_TEAM_SETUP" });
    });
    teamSetupSection.appendChild(teamSetupExportBtn);

    // ── 1.7b. Team setup apply (p49-t1) ──
    // Re-runs installers (agent seeding, routing merge, hooks, and — where
    // this host has them — opencode config / MCP catalog) from a committed
    // .claude/tycoon-team.json. Shares the notice element with Export so
    // only one status line shows at a time.
    const teamSetupApplyBtn = document.createElement("button");
    teamSetupApplyBtn.className = "skill-btn settings-btn";
    teamSetupApplyBtn.id = "team-setup-apply-btn";
    teamSetupApplyBtn.textContent = "Apply team setup";
    teamSetupApplyBtn.addEventListener("click", () => {
      teamSetupApplyBtn.disabled = true;
      teamSetupNotice.setAttribute("hidden", "");
      vscode.postMessage({ type: "APPLY_TEAM_SETUP" });
    });
    teamSetupSection.appendChild(teamSetupApplyBtn);
    teamSetupSection.appendChild(teamSetupNotice);

    // ── 1.7c. Team setup drift notice (p50-t2) ──
    // Populated/shown by the GET_TEAM_SETUP_DRIFT / TEAM_SETUP_DRIFT round
    // trip fired when Settings opens (010-modals-badges-rebirth.js). Apply
    // re-runs Apply; Dismiss hides it for this session only.
    const teamSetupDriftNotice = document.createElement("div");
    teamSetupDriftNotice.className = "theme-review-retry-warning";
    teamSetupDriftNotice.id = "team-setup-drift-notice";
    teamSetupDriftNotice.setAttribute("hidden", "");
    const teamSetupDriftText = document.createElement("span");
    teamSetupDriftText.textContent = "Team setup changed. Apply?";
    teamSetupDriftNotice.appendChild(teamSetupDriftText);
    const teamSetupDriftApplyBtn = document.createElement("button");
    teamSetupDriftApplyBtn.className = "skill-btn settings-btn";
    teamSetupDriftApplyBtn.id = "team-setup-drift-apply-btn";
    teamSetupDriftApplyBtn.textContent = "Apply";
    teamSetupDriftApplyBtn.addEventListener("click", () => {
      teamSetupDriftApplyBtn.disabled = true;
      vscode.postMessage({ type: "APPLY_TEAM_SETUP" });
    });
    const teamSetupDriftDismissBtn = document.createElement("button");
    teamSetupDriftDismissBtn.className = "skill-btn settings-btn";
    teamSetupDriftDismissBtn.id = "team-setup-drift-dismiss-btn";
    teamSetupDriftDismissBtn.textContent = "Dismiss";
    teamSetupDriftDismissBtn.addEventListener("click", () => {
      teamSetupDriftNotice.setAttribute("hidden", "");
    });
    teamSetupDriftNotice.appendChild(teamSetupDriftApplyBtn);
    teamSetupDriftNotice.appendChild(teamSetupDriftDismissBtn);
    teamSetupSection.appendChild(teamSetupDriftNotice);

    // Routing-only drift (p52-t2): the manifest's exported routing.json
    // reference changed but the roster (who's on the team) did not — the
    // roster is authoritative and routing is a reference, so this is
    // informational only and never offers an Apply button.
    const teamSetupRoutingDriftNotice = document.createElement("div");
    teamSetupRoutingDriftNotice.className = "theme-review-retry-warning";
    teamSetupRoutingDriftNotice.id = "team-setup-routing-drift-notice";
    teamSetupRoutingDriftNotice.setAttribute("hidden", "");
    const teamSetupRoutingDriftText = document.createElement("span");
    teamSetupRoutingDriftText.textContent = "Team routing changed (reference only)";
    teamSetupRoutingDriftNotice.appendChild(teamSetupRoutingDriftText);
    teamSetupSection.appendChild(teamSetupRoutingDriftNotice);

    // ── 1.7d. Readiness report (p50-t2) ──
    // "Check readiness" builds a TeamReadinessReport from the committed
    // .claude/tycoon-team.json (src/core/teamReadiness.ts) and renders a
    // compact per-agent list with a summary line on top.
    const teamReadinessHint = document.createElement("p");
    teamReadinessHint.className = "settings-empty";
    teamReadinessHint.textContent = "Check whether every agent in the exported team setup resolves to a usable backend.";
    teamSetupSection.appendChild(teamReadinessHint);

    const teamReadinessProbeLabel = document.createElement("label");
    teamReadinessProbeLabel.className = "settings-checkbox-row";
    const teamReadinessProbeCheckbox = document.createElement("input");
    teamReadinessProbeCheckbox.type = "checkbox";
    teamReadinessProbeCheckbox.id = "team-readiness-probe-checkbox";
    teamReadinessProbeLabel.appendChild(teamReadinessProbeCheckbox);
    teamReadinessProbeLabel.appendChild(document.createTextNode(" Probe reachability (may use vendor quota)"));
    teamSetupSection.appendChild(teamReadinessProbeLabel);

    const teamReadinessBtn = document.createElement("button");
    teamReadinessBtn.className = "skill-btn settings-btn";
    teamReadinessBtn.id = "team-readiness-check-btn";
    teamReadinessBtn.textContent = "Check readiness";
    teamReadinessBtn.addEventListener("click", () => {
      teamReadinessBtn.disabled = true;
      teamReadinessBtn.textContent = "Checking…";
      vscode.postMessage({ type: "CHECK_TEAM_READINESS", payload: { probeReachability: teamReadinessProbeCheckbox.checked } });
    });
    teamSetupSection.appendChild(teamReadinessBtn);

    const teamReadinessReportEl = document.createElement("div");
    teamReadinessReportEl.id = "team-readiness-report";
    teamReadinessReportEl.className = "team-readiness-report";
    teamReadinessReportEl.setAttribute("hidden", "");
    teamSetupSection.appendChild(teamReadinessReportEl);

    setupConfigEl.appendChild(teamSetupSection);

    // p59-t3: the "Attach walk pose guide (Experimental)" toggle was removed —
    // the Theme Service now always attaches its own pose-guide reference
    // image server-side for character boards (contract v3.4), so the client
    // has nothing left to opt in or out of.

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

