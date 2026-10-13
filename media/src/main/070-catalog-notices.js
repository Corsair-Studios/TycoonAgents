// Part: 70-catalog-notices
// Catalog notice building and packs catalog UI.
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
   * Truncate text to `max` chars on a word boundary, appending "…". Used for
   * the one-line collapsed summary so long authored/derived text never
   * blows out the collapsed row height.
   * @param {string} text
   * @param {number} [max]
   * @returns {string}
   */
  function truncateCatalogSummary(text, max) {
    const limit = max || 120;
    if (!text) return "";
    if (text.length <= limit) return text;
    const slice = text.slice(0, limit - 1);
    const lastSpace = slice.lastIndexOf(" ");
    const cut = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
    return cut.trimEnd() + "…";
  }

  /**
   * Derive a one-sentence fallback summary from a longer description: strip
   * backticks, take up to the first sentence terminator, then truncate to
   * 120 chars on a word boundary. Used only until an item's authored
   * `summary` field lands from the catalogs/hosts.
   * @param {string|undefined} description
   * @returns {string}
   */
  function firstSentenceCatalogSummary(description) {
    if (!description) return "";
    const cleaned = String(description).replace(/`/g, "");
    const match = cleaned.match(/^.*?[.!?](?:\s|$)/);
    const sentence = match ? match[0].trim() : cleaned.trim();
    return truncateCatalogSummary(sentence, 120);
  }

  /**
   * One-sentence summary for a catalog item (skill/pack/MCP server): prefers
   * the authored `item.summary` field (once the catalogs/hosts populate it),
   * falling back to a derived first-sentence-of-description client-side so
   * the UI works with either payload shape.
   * @param {{summary?:string, description?:string}} item
   * @returns {string}
   */
  function catalogSummaryFor(item) {
    if (item && item.summary) {
      return truncateCatalogSummary(String(item.summary).replace(/`/g, ""), 120);
    }
    return firstSentenceCatalogSummary(item && item.description);
  }

  /** vscode.getState() key holding the open/closed map for catalog <details>
   *  disclosures, keyed by entry id ("skill:<id>", "mcp:<id>", "pack:<id>").
   *  Shared across the Skills/Packs/MCP lists so ids never collide. */
  const CATALOG_DISCLOSURE_STATE_KEY = "catalogDisclosureOpen";

  /**
   * Read the persisted open/closed map for catalog <details> disclosures.
   * @returns {Record<string, boolean>}
   */
  function getCatalogDisclosureState() {
    const st = vscode.getState() || {};
    return st[CATALOG_DISCLOSURE_STATE_KEY] || {};
  }

  /**
   * Persist a single entry's open/closed state, reusing the same
   * vscode.getState()/setState() blob used elsewhere in this file so it
   * survives a VS Code webview reload and works identically in the
   * standalone host (whose acquireVsCodeApi shim backs the same calls with
   * localStorage).
   * @param {string} id
   * @param {boolean} open
   */
  function setCatalogDisclosureOpen(id, open) {
    const prev = vscode.getState() || {};
    const map = { ...(prev[CATALOG_DISCLOSURE_STATE_KEY] || {}) };
    if (open) {
      map[id] = true;
    } else {
      delete map[id];
    }
    vscode.setState({ ...prev, [CATALOG_DISCLOSURE_STATE_KEY]: map });
  }

  /**
   * Build a collapsed-by-default <details class="catalog-details"> block for
   * one catalog entry. `fill` receives the details' body container to
   * populate with everything that used to always render inline (full
   * description, notes, disclosure box, docs/env links). Native <details>
   * gives keyboard access (Enter/Space on the <summary>) for free.
   * @param {string} id Stable entry id, e.g. "skill:foo".
   * @param {(body: HTMLElement) => void} fill
   * @returns {HTMLDetailsElement}
   */
  function buildCatalogDetails(id, fill) {
    const details = /** @type {HTMLDetailsElement} */ (document.createElement("details"));
    details.className = "catalog-details";
    details.dataset.catalogId = id;
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = "Details";
    details.appendChild(summaryEl);
    const body = document.createElement("div");
    body.className = "catalog-details-body";
    fill(body);
    details.appendChild(body);
    if (getCatalogDisclosureState()[id]) details.open = true;
    details.addEventListener("toggle", () => {
      setCatalogDisclosureOpen(id, details.open);
    });
    return details;
  }

  /**
   * Build the "Expand all" / "Collapse all" control bar for one catalog list.
   * Operates on every `details.catalog-details` currently in `listEl` (called
   * after the list has been rendered), and persists the resulting state.
   * @param {HTMLElement} listEl
   * @returns {HTMLElement}
   */
  function buildCatalogExpandBar(listEl) {
    const bar = document.createElement("div");
    bar.className = "catalog-expand-bar";
    const setAll = (open) => {
      const list = listEl.querySelectorAll("details.catalog-details");
      for (const d of list) {
        d.open = open;
        const id = d.dataset.catalogId;
        if (id) setCatalogDisclosureOpen(id, open);
      }
    };
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "catalog-expand-btn";
    expandBtn.textContent = "Expand all";
    expandBtn.addEventListener("click", () => setAll(true));
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "catalog-expand-btn";
    collapseBtn.textContent = "Collapse all";
    collapseBtn.addEventListener("click", () => setAll(false));
    bar.appendChild(expandBtn);
    bar.appendChild(collapseBtn);
    return bar;
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
    lastSkills = Array.isArray(skills) ? skills : [];
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
    skillsListEl.appendChild(buildCatalogExpandBar(skillsListEl));
    for (const skill of skills) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.skillRowId = skill.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const header = document.createElement("div");
      header.className = "catalog-header";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = skill.name;
      header.appendChild(nameEl);

      if (skill.thirdParty) {
        const tag = document.createElement("span");
        tag.className = "disclosure-tag";
        tag.textContent = "Third-party";
        header.appendChild(tag);
      }

      const btn = document.createElement("button");
      if (skill.installed) {
        btn.className = "skill-btn skill-btn--remove";
        btn.textContent = "Remove";
        btn.setAttribute("data-remove-skill-id", skill.id);
      } else {
        btn.className = "skill-btn";
        btn.textContent = "Install";
        btn.setAttribute("data-skill-id", skill.id);
      }
      header.appendChild(btn);
      textBlock.appendChild(header);

      const summaryLine = document.createElement("div");
      summaryLine.className = "catalog-summary";
      summaryLine.textContent = catalogSummaryFor(skill);
      textBlock.appendChild(summaryLine);

      const details = buildCatalogDetails(`skill:${skill.id}`, (body) => {
        const descEl = document.createElement("span");
        descEl.className = "skill-desc";
        descEl.textContent = skill.description;
        body.appendChild(descEl);

        if (skill.mcpNote) {
          const noteEl = document.createElement("span");
          noteEl.className = "skill-mcpnote";
          noteEl.textContent = `⚙ ${skill.mcpNote}`;
          body.appendChild(noteEl);
        }

        if (skill.thirdParty) {
          const attrLine = document.createElement("div");
          attrLine.className = "skill-attribution disclosure-tagline";
          const tag2 = document.createElement("span");
          tag2.className = "disclosure-tag";
          tag2.textContent = "Third-party";
          attrLine.appendChild(tag2);
          if (skill.source) {
            const src = document.createElement("a");
            src.className = "disclosure-src";
            src.href = skill.source;
            src.target = "_blank";
            src.rel = "noopener noreferrer";
            src.textContent = "source ↗";
            attrLine.appendChild(src);
          }
          body.appendChild(attrLine);
        }
      });
      textBlock.appendChild(details);

      row.appendChild(textBlock);
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

  /**
   * Update a skill row after a remove attempt. On success the host re-posts
   * the skills list, so we mainly reconcile the in-flight button; on cancel we
   * silently restore, and on error we restore + surface the message.
   * @param {string} id
   * @param {boolean} ok
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handleSkillRemoved(id, ok, error, cancelled) {
    const btn = /** @type {HTMLElement|null} */ (
      skillsListEl.querySelector(`[data-remove-skill-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    if (cancelled) {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      // Host re-posts the skills list which re-renders this row as
      // not-installed. As a fallback (in case that message is missed) flip the
      // button back to Install here too.
      btn.textContent = "Install";
      btn.classList.remove("skill-btn--remove");
      btn.removeAttribute("disabled");
      btn.removeAttribute("data-remove-skill-id");
      btn.setAttribute("data-skill-id", id);
    } else {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
      }
    }
  }

  /**
   * Update an agent row after a remove attempt. Mirrors handleSkillRemoved.
   * The host runs the native confirm + actual removal, then re-posts the
   * roster/settings on success (which re-renders the settings list). So on ok
   * we simply let that re-render happen (and re-request settings as a fallback);
   * on cancelled/error we restore the button.
   * @param {string} id
   * @param {boolean} ok
   * @param {boolean} [cancelled]
   * @param {string} [error]
   */
  function handleAgentRemoved(id, ok, cancelled, error) {
    const btn = /** @type {HTMLElement|null} */ (
      setupConfigEl
        ? setupConfigEl.querySelector(`[data-remove-agent-id="${CSS.escape(id)}"]`)
        : null
    );
    if (ok) {
      // Host re-posts the settings payload which re-renders this list. As a
      // fallback (in case that message is missed) request settings again.
      vscode.postMessage({ type: "getSettings" });
      return;
    }
    if (!btn) return;
    // cancelled or error → restore the button to its clickable state.
    btn.removeAttribute("disabled");
    btn.textContent = "Remove";
    if (!cancelled && error) {
      const row = btn.closest(".agent-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
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
    const approvalBlock = buildMcpApprovalBlock();
    if (approvalBlock) mcpListEl.appendChild(approvalBlock);
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
    mcpListEl.appendChild(buildCatalogExpandBar(mcpListEl));
    for (const server of servers) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.mcpRowId = server.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const header = document.createElement("div");
      header.className = "catalog-header";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = server.name;
      header.appendChild(nameEl);

      if (server.installed && server.unpinned) {
        const pinBadge = document.createElement("span");
        pinBadge.className = "mcp-setup-badge";
        pinBadge.textContent = "unpinned — reinstall to pin";
        header.appendChild(pinBadge);
      }

      if (server.needsSetup) {
        const setupBadge = document.createElement("span");
        setupBadge.className = "mcp-setup-badge";
        setupBadge.textContent = "Template — needs setup";
        header.appendChild(setupBadge);
      }

      // Listed in the project's .mcp.json but not loaded by Claude Code: offer
      // an explicit "Enable" (registers our pinned catalog config; never automatic).
      const pendingEnable = !server.installed && server.pending === true;
      if (pendingEnable) {
        const pendingBadge = document.createElement("span");
        pendingBadge.className = "mcp-setup-badge";
        pendingBadge.textContent = "not enabled";
        header.appendChild(pendingBadge);
      }

      const btn = document.createElement("button");
      if (server.installed) {
        btn.className = "skill-btn skill-btn--remove";
        btn.textContent = "Remove";
        btn.setAttribute("data-remove-mcp-id", server.id);
      } else {
        btn.className = "skill-btn";
        // A server owned by another product (Power Tools) is never installed from here: its action is always "Enable MCP".
        const enableLabel = pendingEnable || !!server.providedBy;
        btn.textContent = enableLabel ? "Enable MCP" : "Install";
        if (enableLabel) btn.setAttribute("data-mcp-label", "Enable MCP");
        btn.setAttribute("data-mcp-id", server.id);
      }
      header.appendChild(btn);
      textBlock.appendChild(header);

      const summaryLine = document.createElement("div");
      summaryLine.className = "catalog-summary";
      summaryLine.textContent = catalogSummaryFor(server);
      textBlock.appendChild(summaryLine);

      const details = buildCatalogDetails(`mcp:${server.id}`, (body) => {
        const descEl = document.createElement("span");
        descEl.className = "skill-desc";
        descEl.textContent = server.description;
        body.appendChild(descEl);

        if (server.requiresEnv && server.requiresEnv.length) {
          const reqEl = document.createElement("span");
          reqEl.className = "mcp-req";
          reqEl.textContent = `Requires: ${server.requiresEnv.join(", ")}`;
          body.appendChild(reqEl);
        }

        if (server.note) {
          const noteEl = document.createElement("span");
          noteEl.className = "mcp-req";
          noteEl.textContent = server.note;
          body.appendChild(noteEl);
        }

        if (server.docsUrl) {
          const docsEl = document.createElement("a");
          docsEl.className = "mcp-docs";
          docsEl.href = server.docsUrl;
          docsEl.target = "_blank";
          docsEl.rel = "noopener noreferrer";
          docsEl.textContent = "docs";
          body.appendChild(docsEl);
        }

        if (server.thirdParty) {
          body.appendChild(buildDisclosureBlock({
            vendor: server.vendor,
            package: server.package,
            homepage: server.homepage,
            network: server.network,
            dataNote: server.dataNote,
          }));
        }
      });
      textBlock.appendChild(details);

      row.appendChild(textBlock);
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
  function handleMcpInstalled(id, ok, alreadyExisted, error, cancelled, newChatHint) {
    if (!mcpListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      mcpListEl.querySelector(`[data-mcp-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    // User dismissed the host confirmation modal — silently restore the button.
    const idleLabel = btn.getAttribute("data-mcp-label") || "Install";
    if (cancelled) {
      btn.textContent = idleLabel;
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      btn.textContent = "Installed";
      btn.classList.add("skill-btn--installed");
      btn.setAttribute("disabled", "");
      btn.removeAttribute("data-mcp-id");
      if (newChatHint) showToast(NEW_CHAT_HINT, "info");
      const okRow = btn.closest(".skill-row");
      const harnessInfo = lastSettings && lastSettings.harness;
      const onCodex = harnessInfo && harnessInfo.effective === "codex";
      const approvalPending = !!(lastSettings && lastSettings.mcpApproval && Array.isArray(lastSettings.mcpApproval.pending) && lastSettings.mcpApproval.pending.length > 0);
      if (okRow && !onCodex && !newChatHint && approvalPending && !okRow.querySelector(".mcp-approval-note")) {
        const note = document.createElement("span");
        note.className = "mcp-approval-note";
        note.textContent = MCP_APPROVAL_NOTE;
        okRow.appendChild(note);
        const rowBlock = buildMcpApprovalBlock();
        if (rowBlock) okRow.appendChild(rowBlock);
      }
    } else {
      btn.textContent = idleLabel;
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

  /**
   * Update an MCP row after a remove attempt. Mirrors handleSkillRemoved.
   * @param {string} id
   * @param {boolean} ok
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
  function handleMcpRemoved(id, ok, error, cancelled) {
    if (!mcpListEl) return;
    const btn = /** @type {HTMLElement|null} */ (
      mcpListEl.querySelector(`[data-remove-mcp-id="${CSS.escape(id)}"]`)
    );
    if (!btn) return;
    if (cancelled) {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      return;
    }
    if (ok) {
      // Host re-posts the MCP list; flip button as a fallback.
      btn.textContent = "Install";
      btn.classList.remove("skill-btn--remove");
      btn.removeAttribute("disabled");
      btn.removeAttribute("data-remove-mcp-id");
      btn.setAttribute("data-mcp-id", id);
    } else {
      btn.textContent = "Remove";
      btn.removeAttribute("disabled");
      const row = btn.closest(".skill-row");
      if (row) {
        let errSpan = /** @type {HTMLElement|null} */ (row.querySelector(".skill-install-error"));
        if (!errSpan) {
          errSpan = document.createElement("span");
          errSpan.className = "skill-install-error";
          row.appendChild(errSpan);
        }
        errSpan.textContent = error || "Remove failed";
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
   * True when the pack's MCP server is listed only in the project's .mcp.json
   * (Claude Code harness): present but not enabled, so the host reports it not installed.
   * @param {{mcpId?:string, mcpState?:string}} pack
   * @returns {boolean}
   */
  function packMcpPending(pack) {
    return !!pack && pack.mcpState === "pending" && typeof pack.mcpId === "string";
  }

  /**
   * True when the pack's MCP server can be enabled from here: listed only in .mcp.json (pending), or owned by
   * another product (Power Tools) and not registered yet. The host finds the entry or the product folder.
   * @param {{mcpId?:string, mcpState?:string, mcpProvidedBy?:object}} pack
   * @returns {boolean}
   */
  function packMcpEnableable(pack) {
    return packMcpPending(pack) || (packMcpExternal(pack) && typeof pack.mcpId === "string" && pack.mcpState !== "installed");
  }

  /**
   * True when every part the pack `has`, other than its MCP server, is `installed`.
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   * @returns {boolean}
   */
  function packOthersInstalled(pack) {
    const has = pack.has || {};
    const installed = pack.installed || {};
    return PACK_PARTS.every(([key]) => key === "mcp" || !has[key] || installed[key]);
  }

  /**
   * True when every part the pack `has` is also `installed`.
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   * @returns {boolean}
   */
  function packFullyInstalled(pack) {
    const has = pack.has || {};
    const installed = pack.installed || {};
    return PACK_PARTS.every(([key]) => !has[key] || installed[key] || (key === "mcp" && packMcpExternal(pack)));
  }

  /**
   * True when the pack's MCP server is provided by a separately installed product (host `mcpProvidedBy`):
   * the pack never installs it, so it does not count toward the pack being installed.
   * @param {{mcpProvidedBy?:{label?:string,url?:string}}} pack
   * @returns {boolean}
   */
  function packMcpExternal(pack) {
    return !!pack && !!pack.mcpProvidedBy;
  }

  /**
   * True when at least one part the pack `has` is `installed`.
   * @param {{has:Record<string,boolean>, installed:Record<string,boolean>}} pack
   * @returns {boolean}
   */
  function packAnyInstalled(pack) {
    const has = pack.has || {};
    const installed = pack.installed || {};
    return PACK_PARTS.some(([key]) => has[key] && installed[key] && !(key === "mcp" && packMcpExternal(pack)));
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
      const notEnabled = key === "mcp" && !done && packMcpEnableable(pack);
      const chip = document.createElement("span");
      chip.className = "pack-chip" + (done ? " pack-chip--done" : "");
      if (key === "mcp" && packMcpExternal(pack)) {
        chip.textContent = done ? `${label} ✓ · via Power Tools` : notEnabled ? `${label} · via Power Tools · not enabled` : `${label} · via Power Tools`;
      } else {
        chip.textContent = done ? `${label} ✓` : notEnabled ? `${label} · not enabled` : label;
      }
      container.appendChild(chip);
    }
  }

  /**
   * Rebuild #packs-list from the catalog payload. Mirrors renderMcpList.
   * @param {Array<{id:string,name:string,description:string,has:Record<string,boolean>,installed:Record<string,boolean>}>} packs
   * @param {string|undefined} error
   */
  function renderPacksList(packs, error) {
    lastPacks = Array.isArray(packs) ? packs : [];
    // The Setup Wizard Step-2 Optionals list (renderSetupOptionals) may have
    // already painted its "Installs: ..." lines from the pre-getPacks
    // fallback (describePackageInstalls with no matching pack) if this
    // response landed after that first render. Re-render it now that
    // lastPacks is populated, but ONLY while that step is actually on
    // screen: gated on setupStage so nothing fires once the user has moved
    // past it (Continue / Advanced settings both flip setupStage away from
    // "optionals"), plus a DOM check as a belt-and-suspenders guard. This
    // never touches the Settings > Packs list below, and never disturbs the
    // user's ticks — setupPackageSelection is seeded exactly once per
    // session (see its declaration) and renderSetupOptionals reads from it
    // on every call, including this one.
    if (setupStage === "optionals" && document.getElementById("setup-optionals-top")) {
      renderSetupOptionals(lastSetupOptionalsInfo);
    }
    if (!packsListEl) return;
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
    packsListEl.appendChild(buildCatalogExpandBar(packsListEl));
    for (const pack of packs) {
      const row = document.createElement("div");
      row.className = "skill-row";
      row.dataset.packRowId = pack.id;

      const textBlock = document.createElement("div");
      textBlock.className = "skill-text";

      const header = document.createElement("div");
      header.className = "catalog-header";

      const nameEl = document.createElement("span");
      nameEl.className = "skill-name";
      nameEl.textContent = pack.name;
      header.appendChild(nameEl);

      const parts = document.createElement("div");
      parts.className = "pack-parts";
      renderPackChips(parts, pack);
      header.appendChild(parts);

      const fully = packFullyInstalled(pack);
      const anyInstalled = packAnyInstalled(pack);

      const btn = document.createElement("button");
      if (fully) {
        btn.className = "skill-btn skill-btn--installed";
        btn.textContent = "Installed";
        btn.setAttribute("disabled", "");
      } else {
        btn.className = "skill-btn";
        btn.textContent = "Install";
        btn.setAttribute("data-pack-id", pack.id);
      }
      // Skill and agent are installed and only the MCP is pending: Install has nothing
      // left to do, so show just "Enable MCP" and "Remove".
      const onlyMcpPending = !fully && packMcpEnableable(pack) && packOthersInstalled(pack);
      if (!onlyMcpPending) header.appendChild(btn);

      // MCP server only in .mcp.json: Claude Code has not loaded it. Offer the same
      // explicit Enable as the MCP tab (registers the pinned config at local scope).
      if (packMcpEnableable(pack)) {
        const enableBtn = document.createElement("button");
        enableBtn.className = "skill-btn";
        enableBtn.textContent = "Enable MCP";
        enableBtn.setAttribute("data-pack-enable-mcp", pack.mcpId);
        header.appendChild(enableBtn);
      }

      // Show a Remove button whenever any component is installed (fully or
      // partially). It sits alongside the Install/Installed button.
      if (anyInstalled) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "skill-btn skill-btn--remove";
        removeBtn.textContent = "Remove";
        removeBtn.setAttribute("data-remove-pack-id", pack.id);
        header.appendChild(removeBtn);
      }

      textBlock.appendChild(header);

      const summaryLine = document.createElement("div");
      summaryLine.className = "catalog-summary";
      summaryLine.textContent = catalogSummaryFor(pack);
      textBlock.appendChild(summaryLine);

      if (packMcpExternal(pack)) {
        const viaLine = document.createElement("div");
        viaLine.className = "catalog-summary pack-mcp-via";
        viaLine.appendChild(document.createTextNode(`The MCP comes from ${pack.mcpProvidedBy.label || "its own product"}, installed separately. Source: `));
        if (pack.mcpProvidedBy.url) {
          const link = document.createElement("a");
          link.href = pack.mcpProvidedBy.url;
          link.textContent = pack.mcpProvidedBy.url;
          viaLine.appendChild(link);
        }
        textBlock.appendChild(viaLine);
      }

      const details = buildCatalogDetails(`pack:${pack.id}`, (body) => {
        const descEl = document.createElement("span");
        descEl.className = "skill-desc";
        descEl.textContent = pack.description;
        body.appendChild(descEl);

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
          body.appendChild(includes);
        }

        if (pack.thirdParty && Array.isArray(pack.disclosures) && pack.disclosures.length) {
          for (const d of pack.disclosures) {
            body.appendChild(buildDisclosureBlock(d));
          }
        } else {
          const local = document.createElement("div");
          local.className = "disclosure-local";
          local.textContent =
            "Local only — installs a bundled skill + a local agent; no third-party servers.";
          body.appendChild(local);
        }
      });
      textBlock.appendChild(details);
      row.appendChild(textBlock);
      packsListEl.appendChild(row);
    }
  }

  /**
   * Result of a pack-row / picker "Enable" click (same installMcp round trip as the
   * MCP tab). Restores idle buttons on failure or cancel; the packs list is
   * re-fetched on success by the message dispatcher.
   * @param {string} id MCP server id
   * @param {boolean} ok
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   * @param {boolean|undefined} newChatHint
   */
  function handlePackMcpEnabled(id, ok, error, cancelled, newChatHint) {
    if (!packsListEl) return;
    const btns = packsListEl.querySelectorAll(`[data-pack-enable-mcp="${CSS.escape(id)}"]`);
    if (btns.length === 0) return;
    if (ok) {
      if (newChatHint) showToast(NEW_CHAT_HINT, "info");
      return;
    }
    for (const b of btns) {
      b.textContent = "Enable MCP";
      b.removeAttribute("disabled");
    }
    if (!cancelled && error) showToast(error, "error");
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
    if (handleBridgePackInstalled(id, ok, _results, error, cancelled)) return;
    if (!packsListEl) return;
    if (!ok && !cancelled && error && !packsListEl.querySelector(`[data-pack-id="${CSS.escape(id)}"]`)) {
      // No picker panel and no row button (e.g. started from the setup wizard): still tell the user why.
      showToast(error, "error");
    }
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
      // Never silent: an MCP step the pack could not complete is reported (a provided MCP is not a failure).
      const mcpResult = _results && _results.mcp;
      if (mcpResult && typeof mcpResult === "object" && mcpResult.status === "skipped") {
        showToast(String(mcpResult.error || "The MCP server was not installed."), "error");
      }
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
          const mcpDone = !mcpResult || mcpResult === "installed" || mcpResult === "exists";
          for (const chip of parts.querySelectorAll(".pack-chip")) {
            if (!mcpDone && /^MCP/.test(chip.textContent || "")) continue;
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

  /**
   * Update a pack row after a remove attempt. On success the host re-posts the
   * packs list (authoritative chip/button state); we also re-fetch as a
   * fallback. On cancel we silently restore; on error we restore + surface it.
   * @param {string} id
   * @param {boolean} ok
   * @param {{skill?:string,mcp?:string,agent?:string}|undefined} _results
   * @param {string|undefined} error
   * @param {boolean|undefined} cancelled
   */
