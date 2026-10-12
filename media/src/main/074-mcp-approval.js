// Part: 74-mcp-approval
// Explicit, user-clicked "Approve TycoonAgents servers for this project".
// The host derives which servers are ours and re-validates every request;
// this UI only shows the host's lists (settings.mcpApproval) and sends back
// the ids the user confirmed. Nothing is ever approved without the click.

  /** @type {HTMLElement|null} */
  var mcpApprovalModalEl = null;

  function closeMcpApprovalModal() {
    if (mcpApprovalModalEl) mcpApprovalModalEl.setAttribute("hidden", "");
  }

  /**
   * Confirmation listing exactly which server ids will be approved, with an
   * unchecked opt-in for the mcp__<id> allow rules.
   * @param {string[]} ids
   */
  function openMcpApprovalModal(ids) {
    if (mcpApprovalModalEl) mcpApprovalModalEl.remove();
    const modal = document.createElement("div");
    modal.id = "mcp-approval-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "mcp-approval-title");
    const backdrop = document.createElement("div");
    backdrop.id = "mcp-approval-backdrop";
    backdrop.addEventListener("click", closeMcpApprovalModal);
    modal.appendChild(backdrop);
    const dialog = document.createElement("div");
    dialog.id = "mcp-approval-dialog";

    const title = document.createElement("div");
    title.id = "mcp-approval-title";
    title.textContent = "Approve TycoonAgents servers?";
    dialog.appendChild(title);

    const msg = document.createElement("p");
    msg.className = "mcp-approval-text";
    msg.textContent = "This adds these servers to enabledMcpjsonServers in .claude/settings.local.json for this project only:";
    dialog.appendChild(msg);

    const list = document.createElement("ul");
    list.className = "mcp-approval-list";
    ids.forEach(function (id) {
      const li = document.createElement("li");
      li.textContent = id;
      list.appendChild(li);
    });
    dialog.appendChild(list);

    const trust = document.createElement("p");
    trust.className = "mcp-approval-text";
    trust.textContent = "These servers run TycoonAgents' scripts copied into this project (.claude/hooks); they were checked against your installed TycoonAgents version.";
    dialog.appendChild(trust);

    const label = document.createElement("label");
    label.className = "mcp-approval-optin";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = false;
    label.appendChild(box);
    const labelText = document.createElement("span");
    labelText.textContent = "Also let TycoonAgents tools run without asking each time";
    label.appendChild(labelText);
    dialog.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "reset-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "skill-btn settings-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeMcpApprovalModal);
    actions.appendChild(cancel);
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "skill-btn settings-btn";
    ok.textContent = "Approve";
    ok.addEventListener("click", function () {
      closeMcpApprovalModal();
      vscode.postMessage({ type: "approveTycoonMcp", ids: ids.slice(), allowTools: box.checked });
    });
    actions.appendChild(ok);
    dialog.appendChild(actions);
    modal.appendChild(dialog);
    document.body.appendChild(modal);
    mcpApprovalModalEl = modal;
    ok.focus();
  }

  /**
   * Build the approval block from settings.mcpApproval, or null when there is
   * nothing to show (non-Claude harness, or nothing pending/rejected/removable).
   * @returns {HTMLElement|null}
   */
  function buildMcpApprovalBlock() {
    const a = lastSettings && lastSettings.mcpApproval;
    const onCodex = lastSettings && lastSettings.harness && lastSettings.harness.effective === "codex";
    if (!a || onCodex) return null;
    const pending = Array.isArray(a.pending) ? a.pending : [];
    const rejected = Array.isArray(a.rejected) ? a.rejected : [];
    const foreign = Array.isArray(a.foreign) ? a.foreign : [];
    const removable = Array.isArray(a.removable) ? a.removable : [];
    const modified = Array.isArray(a.modified) ? a.modified : [];
    const changed = Array.isArray(a.changedApproved) ? a.changedApproved : [];
    const blockedBy = Array.isArray(a.dispatcherBlockedBy) ? a.dispatcherBlockedBy : [];
    if (!pending.length && !rejected.length && !foreign.length && !removable.length && !modified.length && !changed.length && !blockedBy.length && !a.outFallback && !a.pathHijack && !a.homeUnreadable && !a.unsafeSettingsPath) return null;
    const wrap = document.createElement("div");
    wrap.className = "mcp-approval-block";
    if (a.localUnreadable) {
      const w = document.createElement("div");
      w.className = "hook-warn";
      w.textContent = ".claude/settings.local.json cannot be read, so nothing will be written until it is fixed.";
      wrap.appendChild(w);
    }
    const warn = function (text) {
      const w = document.createElement("div");
      w.className = "mcp-approval-line hook-warn";
      w.textContent = text;
      wrap.appendChild(w);
    };
    if (a.pathHijack) warn("A file named " + a.pathHijack + " in the project folder could run instead of Node, so nothing can be approved. Remove it first.");
    if (a.outFallback) warn(".claude/out exists in this project and can replace TycoonAgents' scripts, so its servers are treated as modified. Remove that folder.");
    if (blockedBy.length) warn("The tycoon dispatcher starts the other bridge servers, so it cannot be approved while " + blockedBy.join(", ") + " is not an unmodified TycoonAgents install.");
    changed.forEach(function (id) {
      const c = document.createElement("div");
      c.className = "mcp-approval-line hook-warn";
      c.textContent = "An approved TycoonAgents server changed since approval: " + id;
      wrap.appendChild(c);
      const rv = document.createElement("button");
      rv.type = "button";
      rv.className = "skill-btn settings-btn mcp-approval-btn";
      rv.textContent = "Revoke approval";
      rv.addEventListener("click", function () { vscode.postMessage({ type: "revokeTycoonMcpApproval", id: id }); });
      wrap.appendChild(rv);
    });
    if (a.homeUnreadable) warn("Your Claude Code settings (~/.claude.json) cannot be read, so rejections cannot be checked and nothing can be approved.");
    if (a.unsafeSettingsPath) warn(".claude or .claude/settings.local.json is a symbolic link or junction, so nothing will be written.");
    if (pending.length) {
      const t = document.createElement("div");
      t.className = "mcp-approval-line";
      t.textContent = "Not yet approved in Claude Code: " + pending.join(", ");
      wrap.appendChild(t);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "skill-btn settings-btn mcp-approval-btn";
      btn.textContent = "Approve TycoonAgents servers for this project";
      btn.disabled = !!a.localUnreadable;
      btn.addEventListener("click", function () { openMcpApprovalModal(pending); });
      wrap.appendChild(btn);
    }
    if (rejected.length) {
      const r = document.createElement("div");
      r.className = "mcp-approval-line";
      r.textContent = "Rejected in Claude Code (left alone): " + rejected.join(", ");
      wrap.appendChild(r);
    }
    if (modified.length) {
      const m = document.createElement("div");
      m.className = "mcp-approval-line hook-warn";
      m.textContent = modified.join(", ") + ": modified copy \u2014 reinstall hooks from TycoonAgents to fix";
      wrap.appendChild(m);
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "skill-btn settings-btn mcp-approval-btn";
      fix.textContent = "Reinstall TycoonAgents hooks";
      fix.addEventListener("click", function () { vscode.postMessage({ type: "repairTycoonMcpHooks" }); });
      wrap.appendChild(fix);
    }
    foreign.forEach(function (id) {
      const f = document.createElement("div");
      f.className = "mcp-approval-line hook-warn";
      f.textContent = id + ": not installed by TycoonAgents — review in .mcp.json";
      wrap.appendChild(f);
    });
    if (removable.length) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "skill-btn settings-btn mcp-approval-btn";
      rm.textContent = "Remove TycoonAgents approvals";
      rm.title = "Removes " + removable.join(", ") + " from the approvals this action adds in .claude/settings.local.json";
      rm.disabled = !!a.localUnreadable;
      rm.addEventListener("click", function () { vscode.postMessage({ type: "removeTycoonMcpApprovals" }); });
      wrap.appendChild(rm);
    }
    return wrap;
  }

  /** @param {{ok:boolean, action:string, ids?:string[], error?:string}} msg */
  function handleMcpApprovalResult(msg) {
    if (mcpLoaded) vscode.postMessage({ type: "getMcp" });
    if (!msg.ok) {
      showToast(msg.error || "Could not update approvals", "error");
      return;
    }
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    showToast(msg.action === "remove"
      ? (ids.length ? "Removed approvals: " + ids.join(", ") : "No TycoonAgents approvals to remove")
      : msg.action === "revoke"
        ? (ids.length ? "Revoked approval: " + ids.join(", ") : "Nothing to revoke")
      : msg.action === "repair"
        ? (ids.length ? "Reinstalled hooks for: " + ids.join(", ") : "Nothing to reinstall")
        : "Approved: " + ids.join(", "));
  }
