// Part: 20-theme-plan-editor
// Theme plan slot collection/rendering, theme generation stop/retry, theme health result, theme image review capture and rows.
  function collectPlanSlotsWithDesc(container) {
    const names = [];
    const descriptions = [];
    const attackStyles = [];
    if (!container) return { names, descriptions, attackStyles };
    const rows = Array.from(container.querySelectorAll(".theme-plan-slot-row"));
    rows.forEach((row) => {
      const nameInput = row.querySelector('[data-plan-field="name"]');
      names.push(nameInput ? nameInput.value.trim() : "");
      const descInput = row.querySelector('[data-plan-field="desc"]');
      descriptions.push(descInput ? descInput.value.trim() : "");
      const attackInput = row.querySelector('[data-plan-field="attack"]');
      attackStyles.push(attackInput ? attackInput.value : undefined);
    });
    return { names, descriptions, attackStyles };
  }

  function collectEditedThemePlan() {
    const characterSlots = collectPlanSlotsWithDesc(themePlanCharacters);
    const characters = characterSlots.names;
    const characterFilled = characters.filter(Boolean).length;
    if (characters.length !== THEME_PLAN_CHARACTER_COUNT || characterFilled !== THEME_PLAN_CHARACTER_COUNT) {
      throw new Error(`Characters needs all ${THEME_PLAN_CHARACTER_COUNT} filled slots (currently ${characterFilled}).`);
    }

    const enemySlots = collectPlanSlotsWithDesc(themePlanEnemies);
    const enemies = enemySlots.names;
    const enemyFilled = enemies.filter(Boolean).length;
    if (enemies.length !== THEME_PLAN_ENEMY_COUNT || enemyFilled !== THEME_PLAN_ENEMY_COUNT) {
      throw new Error(`Enemies needs all ${THEME_PLAN_ENEMY_COUNT} filled slots (currently ${enemyFilled}).`);
    }
    const enemyAttackStyles = enemySlots.attackStyles.map((style) => (style === "ranged" ? "ranged" : "melee"));

    const decorSlots = collectPlanSlotsWithDesc(themePlanDecorSlots);
    const decor = decorSlots.names;
    const decorFilled = decor.filter(Boolean).length;
    if (decor.length !== THEME_PLAN_DECOR_COUNT || decorFilled !== THEME_PLAN_DECOR_COUNT) {
      throw new Error(`Decor needs all ${THEME_PLAN_DECOR_COUNT} named slots (currently ${decorFilled}).`);
    }

    const displayName = themePlanName ? themePlanName.value.trim() : "";
    const creativeDirection = themePlanDirection ? themePlanDirection.value.trim() : "";
    const environment = themePlanEnvironment ? themePlanEnvironment.value.trim() : "";
    if (!displayName || !creativeDirection || !environment) throw new Error("Theme name, creative direction, and environment are required.");

    const objectSlots = collectPlanSlotsWithDesc(themePlanObjectsSlots);
    const objects = objectSlots.names;
    const objectFilled = objects.filter(Boolean).length;
    if (objects.length !== THEME_PLAN_OBJECT_COUNT || objectFilled !== THEME_PLAN_OBJECT_COUNT) {
      throw new Error(`Objects needs all ${THEME_PLAN_OBJECT_COUNT} named slots (currently ${objectFilled}).`);
    }

    const achievementSlots = collectPlanSlotsWithDesc(themePlanAchievementsSlots);
    const achievements = achievementSlots.names;
    const achievementFilled = achievements.filter(Boolean).length;
    if (achievements.length !== THEME_PLAN_ACHIEVEMENT_COUNT || achievementFilled !== THEME_PLAN_ACHIEVEMENT_COUNT) {
      throw new Error(`Achievement badges needs all ${THEME_PLAN_ACHIEVEMENT_COUNT} named slots (currently ${achievementFilled}).`);
    }

    const expressionSlots = collectPlanSlotsWithDesc(themePlanExpressionsSlots);

    return {
      ...currentThemePlan,
      theme_id: "",
      display_name: displayName,
      creative_direction: creativeDirection,
      characters,
      character_descriptions: characterSlots.descriptions,
      environment,
      enemies,
      enemy_descriptions: enemySlots.descriptions,
      enemy_attack_styles: enemyAttackStyles,
      decor,
      decor_descriptions: decorSlots.descriptions,
      objects,
      object_descriptions: objectSlots.descriptions,
      crate_description: themePlanCrateDesc ? themePlanCrateDesc.value.trim() : "",
      poof_description: themePlanPoofDesc ? themePlanPoofDesc.value.trim() : "",
      projectile_description: themePlanProjectileDesc ? themePlanProjectileDesc.value.trim() : (currentThemePlan.projectile_description || undefined),
      expressions: THEME_PLAN_FIXED_EXPRESSION_LABELS.slice(),
      expression_descriptions: expressionSlots.descriptions,
      achievements,
      achievement_descriptions: achievementSlots.descriptions,
    };
  }

  /**
   * p76-t2: lenient counterpart to collectEditedThemePlan for the "Save
   * theme" button — takes the plan editor fields exactly as typed, with no
   * required-slot validation (a hand-saved theme can be partially filled;
   * saveThemePlan's host-side normalizer pads any missing slots). Reused by
   * both a fresh draft (currentThemePlan is the empty template from
   * buildEmptyThemePlan) and re-saving an already-saved/generated plan.
   * @returns {object}
   */
  /**
   * p79-t2 review fix: currentThemePlan is now the single source of truth
   * for every slot (both the plan editor and the board cards write into it
   * live — see bindThemePlanEditorLiveSync in 010-modals-badges-rebirth.js
   * and applyThemeReviewFieldToPlan below) — this no longer re-reads
   * plan-editor DOM rows, which could hold stale AI-filled text that would
   * otherwise clobber a later card edit. Only the one authoritative name
   * field (#theme-prompt-input, synced to #theme-plan-name) is read here.
   * @returns {object}
   */
  function collectDraftThemePlan() {
    const displayName = themePlanName ? themePlanName.value.trim() : "";
    if (!displayName) throw new Error("Give the theme a name before saving.");
    return {
      ...(currentThemePlan || {}),
      theme_id: "",
      display_name: displayName,
      expressions: THEME_PLAN_FIXED_EXPRESSION_LABELS.slice(),
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

  /**
   * Save-before-generate: if the creative-direction textarea currently
   * rendered in the review (buildThemeReviewCreativeDirectionSection) holds
   * an unsaved edit, posts SET_THEME_CREATIVE_DIRECTION for it first, marks
   * the field clean, THEN invokes sendFn() to post the caller's own
   * generate/regenerate/retry message. No-ops straight to sendFn() when the
   * textarea isn't present (e.g. the initial Start Generation click, before
   * any review exists) or holds no unsaved edit.
   * @param {() => void} sendFn
   */
  function saveCreativeDirectionIfDirtyThenSend(sendFn) {
    const textarea = themeImageReviewList
      && themeImageReviewList.querySelector(".theme-review-creative-direction-input");
    if (textarea) {
      const value = textarea.value.trim();
      if (value && value !== textarea.dataset.original) {
        vscode.postMessage({
          type: "SET_THEME_CREATIVE_DIRECTION",
          payload: { theme_id: reviewThemeId, creative_direction: value },
        });
        textarea.dataset.original = value;
        const saveBtn = themeImageReviewList.querySelector(".theme-review-creative-direction-save");
        if (saveBtn) saveBtn.classList.remove("theme-review-creative-direction-save-dirty");
      }
    }
    sendFn();
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
    themeStartGenerationBtn.title = "Saves your creative-direction edit first";
    themeStartGenerationBtn.addEventListener("click", () => {
      if (themeGenerationRunning) {
        requestThemeGenerationStop();
        return;
      }
      try {
        const imageProvider = selectedThemeImageProvider();
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
        saveCreativeDirectionIfDirtyThenSend(() => {
          vscode.postMessage({
            type: 'GENERATE_THEME',
            payload: {
              plan,
              image_provider: imageProvider,
              pause_for_review: themePauseForReview?.checked !== false,
            },
          });
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
    themeReviewResumeGeneration.title = "Saves your creative-direction edit first";
    themeReviewResumeGeneration.addEventListener("click", () => {
      if (!reviewThemeId || themeGenerationRunning) return;
      const imageProvider = selectedThemeImageProvider();
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
      saveCreativeDirectionIfDirtyThenSend(() => {
        vscode.postMessage({
          type: 'GENERATE_THEME',
          payload: {
            resume_theme_id: reviewThemeId,
            image_provider: imageProvider,
            pause_for_review: themePauseForReview?.checked !== false,
          },
        });
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

  if (themeHealthCheckBtn) {
    themeHealthCheckBtn.addEventListener("click", () => {
      if (!reviewThemeId) return;
      themeHealthCheckBtn.disabled = true;
      themeHealthCheckBtn.textContent = "Checking…";
      if (themeHealthResults) {
        themeHealthResults.hidden = false;
        themeHealthResults.textContent = "";
        const pending = document.createElement("div");
        pending.className = "theme-health-row theme-health-pending";
        pending.textContent = "Running theme health check…";
        themeHealthResults.appendChild(pending);
      }
      vscode.postMessage({
        type: 'RUN_THEME_HEALTH_CHECK',
        payload: { theme_id: reviewThemeId },
      });
    });
  }

  function renderThemeHealthResult(payload) {
    if (themeHealthCheckBtn) {
      themeHealthCheckBtn.disabled = false;
      themeHealthCheckBtn.textContent = "Check theme health";
    }
    if (!themeHealthResults) return;
    themeHealthResults.hidden = false;
    themeHealthResults.textContent = "";
    const issues = Array.isArray(payload && payload.issues) ? payload.issues : [];
    if (payload && payload.error && issues.length === 0) {
      const row = document.createElement("div");
      row.className = "theme-health-row theme-health-error";
      row.textContent = "Health check failed: " + String(payload.error);
      themeHealthResults.appendChild(row);
      return;
    }
    if (issues.length === 0) {
      const row = document.createElement("div");
      row.className = "theme-health-row theme-health-ok";
      row.textContent = "No issues found ✓";
      themeHealthResults.appendChild(row);
      return;
    }
    issues.forEach((issue) => {
      const severity = issue && issue.severity === "warning" ? "warning" : "error";
      const row = document.createElement("div");
      row.className = "theme-health-row theme-health-" + severity;
      const tag = document.createElement("span");
      tag.className = "theme-health-severity";
      tag.textContent = severity === "warning" ? "WARN" : "ERROR";
      row.appendChild(tag);
      const text = document.createElement("span");
      text.className = "theme-health-message";
      const entity = issue && (issue.entity || issue.key)
        ? " (" + [issue.entity, issue.key].filter(Boolean).join(" · ") + ")"
        : "";
      text.textContent = (issue && issue.message ? String(issue.message) : "Unknown issue") + entity;
      row.appendChild(text);
      themeHealthResults.appendChild(row);
    });
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

  /**
   * @param {string} themeId
   * p79-t2 review fix: no longer toggles element visibility itself — every
   * screen element's shown/hidden state is decided in one place,
   * renderThemeBuilderScreen (010-modals-badges-rebirth.js), which this
   * calls at the end so every caller's transition ends there too, whatever
   * themeBuilderScreen was already set to by that caller.
   */
  function showThemeImageReview(themeId) {
    if (!themeId) return;
    // p77-t1 review fix: opening review for a theme other than the one
    // being drafted drops the stale draft state first (picker "Review
    // images" on a different saved theme). Same theme_id as the draft
    // (e.g. right after saveThemePlan) keeps the draft intact.
    if (draftThemeId && themeId !== draftThemeId) {
      clearThemeBuilderDraftState();
    }
    reviewThemeId = themeId;
    themePickerList.setAttribute("hidden", "");
    themeBuilderPanel.removeAttribute("hidden");
    if (themeImageReviewList) themeImageReviewList.textContent = "Loading generated images...";
    if (themeApproveAll) {
      themeApproveAll.disabled = true;
      themeApproveAll.textContent = "Approve all";
    }
    renderThemeBuilderScreen();
    vscode.postMessage({ type: 'GET_THEME_IMAGE_REVIEW', payload: { theme_id: themeId } });
  }

  function captureThemeReviewUiState() {
    const drafts = new Map();
    if (themeImageReviewList) {
      for (const card of themeImageReviewList.querySelectorAll("[data-item-id]")) {
        const itemId = card.getAttribute("data-item-id");
        if (!itemId) continue;
        const names = {};
        for (const input of card.querySelectorAll(".theme-review-names-input")) {
          const rowId = input.getAttribute("data-row-id");
          if (rowId) names[rowId] = input.value;
        }
        const descriptions = {};
        for (const textarea of card.querySelectorAll(".theme-review-descriptions-input")) {
          const rowId = textarea.getAttribute("data-row-id");
          if (rowId) descriptions[rowId] = textarea.value;
        }
        const bodyPlans = {};
        for (const control of card.querySelectorAll(".theme-body-plan-control")) {
          const rowId = control.getAttribute("data-row-id");
          if (rowId) bodyPlans[rowId] = control.dataset.value || "";
        }
        drafts.set(itemId, {
          characterName: card.querySelector(".theme-review-name-input")?.value || "",
          // Single merged section now — namesOpen drives the one <details>
          // (the old, separate descriptionsOpen flag is retired). The Creative
          // Direction section moved out of per-item cards entirely (0.0.362 —
          // now a single always-visible panel at the top of the review), so
          // there is no per-card open/closed state left to capture for it.
          namesOpen: Boolean(card.querySelector(".theme-review-names-descriptions-details")?.open),
          names,
          descriptions,
          bodyPlans,
        });
      }
    }
    let creativeDirectionDraft = null;
    const cdTextarea = themeImageReviewList?.querySelector(".theme-review-creative-direction-input");
    if (cdTextarea && cdTextarea.value !== cdTextarea.dataset.original) {
      creativeDirectionDraft = { value: cdTextarea.value, dirty: true };
    }
    return {
      drafts,
      creativeDirectionDraft,
      scrollTop: themesScrollEl?.scrollTop || 0,
    };
  }

  /**
   * Board-row metadata for the theme review screen's inline "Names" editor.
   * Manifest display_names drive board regeneration prompts (see
   * buildReplacementPrompt/objectRowsForItem/decorRowsForItem/rivalRowsForItem
   * in themeService.ts), so this is the ONLY supported way to rename buildable
   * objects, decor items, and rivals — the old Stage Editor "✎ Rename" buttons
   * were removed because window.prompt() is disabled in VS Code webviews and
   * silently no-ops. Character boards already have a working single-item
   * rename ("Character name" / Save name, RENAME_THEME_CHARACTER) and are
   * intentionally left out of this batch editor.
   * @param {any} item a THEME_IMAGE_REVIEW review item
   * @returns {Array<{rowId: string, itemKind: "object"|"decor"|"rival"|"badge", label: string, original: string}>}
   */
  function themeReviewNameRows(item) {
    if (item.kind === "object_atlas" && Array.isArray(item.object_rows)) {
      // v3 object pipeline (themeImageReviewState.ts ThemeObjectBoardRow):
      // board `objects_01` is exactly OBJECT_BOARD1_STATIC_COUNT (16)
      // `object_static` rows (Object 1..16); board `objects_02` is the fixed
      // 7-entry order [object_anim, object_anim, poof, object_static,
      // object_static, object_static, crate] — 2 animated (row 1-2), a poof
      // one-shot (row 3), 3 static objects + a crate (row 4).
      // Labels use the global object number, not the humanized object_id,
      // since the id is immutable and a humanized-id label would read as
      // "the old name" forever once renamed via this editor.
      // `poof`/`crate` rows carry no object_id/display_name and aren't
      // renameable (SET_THEME_ITEM_NAMES's item_kind enum has no 'poof' or
      // 'crate' case — see messages.ts), so they're filtered out here same
      // as any other row missing an object_id; this is NOT a fixed
      // rows-per-board chunk boundary, it mirrors OBJECT_BOARD1_STATIC_COUNT
      // (the host's own board-1/board-2 split point in themeAssetPrompts.ts).
      // Board 2's row array is in CELL order (anim, anim, poof, static x3,
      // crate), but its true global spec order (themeObjectSpecs) is board-2
      // statics (17-19) THEN animated (20-21) — see objectSpecs slicing in
      // reviewSynthesisItems (themeService.ts): board2StaticSpecs is
      // objectSpecs[16..19), animatedSpecs is objectSpecs[19..21). So the
      // number is derived per-kind (independent static/anim counters), not
      // from array position, to match the board-2 label ("Objects 17-21 (3
      // static + 2 animated)") and avoid a 17/18 vs 20/21 swap.
      const OBJECT_BOARD1_STATIC_COUNT = 16;
      const OBJECT_BOARD2_STATIC_COUNT = 3;
      const boardMatch = /objects_(\d+)/.exec(item.id || "");
      const boardNumber = boardMatch ? Number(boardMatch[1]) || 1 : 1;
      let staticIndex = 0;
      let animIndex = 0;
      // Board 2's row array is in CELL order (anim, anim, static x3), not
      // numeric order (statics are 17-19, animated are 20-21 — see the
      // globalNumber derivation below, which is the SAME value used for both
      // the displayed label and this sort key so a row can never show one
      // number while sorting as another). Sort ascending by that global
      // number so the editor lists 17, 18, 19, 20, 21 — the build order —
      // instead of the board's cell order. This is a no-op on board 1, whose
      // rows are already produced in ascending 1-16 order.
      return item.object_rows
        .filter((row) => row && (row.kind === "object_static" || row.kind === "object_anim") && row.object_id)
        .map((row) => {
          let globalNumber;
          if (boardNumber <= 1) {
            staticIndex += 1;
            globalNumber = staticIndex;
          } else if (row.kind === "object_static") {
            staticIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + staticIndex;
          } else {
            animIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + OBJECT_BOARD2_STATIC_COUNT + animIndex;
          }
          return {
            rowId: row.object_id,
            itemKind: "object",
            globalNumber,
            label:
              "Object " +
              globalNumber +
              (row.is_ranged_rack ? " (Weapons Rack)" : "") +
              (row.kind === "object_anim" ? " (animated)" : ""),
            original: row.display_name || "",
          };
        })
        .sort((a, b) => a.globalNumber - b.globalNumber);
    }
    if (item.kind === "background_decor_atlas" && Array.isArray(item.decor_rows)) {
      const rows = [];
      let seatIndex = 0;
      let decorIndex = 0;
      for (const row of item.decor_rows) {
        if (!row || !row.decor_id) continue;
        if (row.kind === "seat") {
          seatIndex += 1;
          rows.push({
            rowId: row.decor_id,
            itemKind: "decor",
            label: "Seat " + seatIndex + (seatIndex === 1 ? " (Leader's Throne)" : ""),
            original: row.display_name || "",
          });
        } else if (row.kind === "decor") {
          decorIndex += 1;
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Decor " + decorIndex, original: row.display_name || "" });
        } else if (row.kind === "decor_anim") {
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Animated decor", original: row.display_name || "" });
        }
        // Projectile rows are intentionally excluded — no display_name, not user-facing.
      }
      return rows;
    }
    if (item.kind === "rival_atlas" && Array.isArray(item.rival_rows)) {
      // Positional labels ("Rival 1"..), same reasoning as the object rows above.
      let rivalIndex = 0;
      return item.rival_rows
        .filter((row) => row && row.rival_id)
        .map((row) => {
          rivalIndex += 1;
          return {
            rowId: row.rival_id,
            itemKind: "rival",
            label: "Rival " + rivalIndex,
            original: row.display_name || "",
          };
        });
    }
    if (item.kind === "achievement_atlas" && Array.isArray(item.achievement_names)) {
      // Themed, positional badge names (Badge 1..25). Posts item_kind "badge",
      // rowId achievement_<index> — see applyThemeItemNameChanges' badge branch.
      // Enrich each slot label with the event the badge rewards, derived from
      // the manifest badge at the SAME index (themeBadges === manifest.badges,
      // populated where manifest is applied) via badgeEventTitle — which reads
      // the canonical trigger_type + threshold, NOT display_name (that gets
      // overwritten with themed flavor text on rename). The "Badge N" prefix is
      // kept so existing UX/tests that match it still hold; the " — <title>"
      // suffix is purely additive context. Fully guarded: a missing/short
      // themeBadges, or a badge with no trigger_type/threshold, cleanly falls
      // back to plain "Badge N".
      const badges = Array.isArray(themeBadges) ? themeBadges : [];
      return item.achievement_names.map((name, index) => {
        const bd = badges[index] || null;
        const eventTitle = bd ? badgeEventTitle(bd) : null;
        return {
          rowId: "achievement_" + index,
          itemKind: "badge",
          label: "Badge " + (index + 1) + (eventTitle ? " — " + eventTitle : ""),
          original: name || "",
        };
      });
    }
    return [];
  }

  /**
   * Board-row metadata for the theme review screen's inline "Descriptions"
   * editor (0.0.265's per-item visual_description text, added 0.0.266). Unlike
   * themeReviewNameRows, this INCLUDES the character_atlas card (one row, the
   * board's own item.id/character_description) since character descriptions
   * have no other edit surface — the existing "Character name" field only
   * covers the name. Descriptions live in plan.json
   * (character_descriptions/object_descriptions/decor_descriptions/
   * enemy_descriptions), never the manifest — see SET_THEME_ITEM_DESCRIPTIONS
   * and applyThemeItemDescriptionChanges in themeService.ts.
   * @param {any} item a THEME_IMAGE_REVIEW review item
   * @returns {Array<{rowId: string, itemKind: "object"|"decor"|"rival"|"character", label: string, original: string}>}
   */
  /**
   * p58-t2: word-boundary, case-insensitive quadruped inference used when a
   * character slot has no explicit `bodyPlan` set — mirrors the SAME word
   * list the host uses for its own inference (contract shared with
   * src/extension for pose-guide selection): dog, cat, wolf, fox, horse,
   * cow, pig, sheep, deer, bear, lion, tiger, quadruped, four-legged, plus
   * plurals. Matches against the character's description text (falling back
   * to its name) and returns "quadruped" on a hit, "biped" otherwise — the
   * inferred value is display-only until the user explicitly picks a
   * control, at which point bodyPlan is written.
   * @param {string} text
   * @returns {"biped"|"quadruped"}
   */
  function inferBodyPlan(text) {
    const words = ["dog", "cat", "wolf", "fox", "horse", "cow", "pig", "sheep", "deer", "bear", "lion", "tiger", "quadruped", "four-legged"];
    const pattern = new RegExp("\\b(" + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("s?|") + "s?)\\b", "i");
    return pattern.test(String(text || "")) ? "quadruped" : "biped";
  }

  function themeReviewDescriptionRows(item) {
    if (item.kind === "character_atlas") {
      return [{
        rowId: item.id,
        itemKind: "character",
        label: "Visual description",
        original: item.character_description || "",
        // "biped" | "quadruped" | undefined (auto — inferred client-side).
        bodyPlan: item.body_plan === "biped" || item.body_plan === "quadruped" ? item.body_plan : undefined,
        subject: item.subject || item.label || "",
      }];
    }
    if (item.kind === "object_atlas" && Array.isArray(item.object_rows)) {
      // v3 object pipeline — see the matching comment in themeReviewNameRows
      // above for the full board-1/board-2 layout and the per-kind global
      // numbering (board 2 statics are 17-19, animated are 20-21).
      const OBJECT_BOARD1_STATIC_COUNT = 16;
      const OBJECT_BOARD2_STATIC_COUNT = 3;
      const boardMatch = /objects_(\d+)/.exec(item.id || "");
      const boardNumber = boardMatch ? Number(boardMatch[1]) || 1 : 1;
      let staticIndex = 0;
      let animIndex = 0;
      // See the matching sort comment in themeReviewNameRows: board 2's row
      // array is in CELL order (anim, anim, static x3), so sort ascending by
      // the same globalNumber used for the label to list 17-19 then 20-21
      // (build order). No-op on board 1 (already 1-16 in order). crate/poof
      // are pushed onto `rows` AFTER this sort, so they stay last.
      const rows = item.object_rows
        .filter((row) => row && (row.kind === "object_static" || row.kind === "object_anim") && row.object_id)
        .map((row) => {
          let globalNumber;
          if (boardNumber <= 1) {
            staticIndex += 1;
            globalNumber = staticIndex;
          } else if (row.kind === "object_static") {
            staticIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + staticIndex;
          } else {
            animIndex += 1;
            globalNumber = OBJECT_BOARD1_STATIC_COUNT + OBJECT_BOARD2_STATIC_COUNT + animIndex;
          }
          return {
            rowId: row.object_id,
            itemKind: "object",
            globalNumber,
            label:
              "Object " +
              globalNumber +
              (row.is_ranged_rack ? " (Weapons Rack)" : "") +
              (row.kind === "object_anim" ? " (animated)" : ""),
            original: row.visual_description || "",
          };
        })
        .sort((a, b) => a.globalNumber - b.globalNumber);
      // Object board 2 also carries the single REQUIRED build crate and
      // build-completion poof effect (v3 object pipeline — see
      // buildObjectBoard2Prompt in themeAssetPrompts.ts). Unlike every other
      // row above, these are description-ONLY (no name row — see
      // themeReviewNameRows, which deliberately omits 'crate'/'poof' from
      // SET_THEME_ITEM_NAMES' item_kind enum) and are never renamed or
      // removed; only their appearance is editable. They only exist on
      // board 2 (the board whose item carries crate_description/
      // poof_description), never board 1.
      if (boardNumber >= 2) {
        rows.push({ rowId: "crate", itemKind: "crate", label: "Build crate (required)", original: item.crate_description || "" });
        rows.push({ rowId: "poof", itemKind: "poof", label: "Build poof effect (required)", original: item.poof_description || "" });
      }
      return rows;
    }
    if (item.kind === "background_decor_atlas" && Array.isArray(item.decor_rows)) {
      const rows = [];
      let seatIndex = 0;
      let decorIndex = 0;
      for (const row of item.decor_rows) {
        if (!row || !row.decor_id) continue;
        if (row.kind === "seat") {
          seatIndex += 1;
          rows.push({
            rowId: row.decor_id,
            itemKind: "decor",
            label: "Seat " + seatIndex + (seatIndex === 1 ? " (Leader's Throne)" : ""),
            original: row.visual_description || "",
          });
        } else if (row.kind === "decor") {
          decorIndex += 1;
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Decor " + decorIndex, original: row.visual_description || "" });
        } else if (row.kind === "decor_anim") {
          rows.push({ rowId: row.decor_id, itemKind: "decor", label: "Animated decor", original: row.visual_description || "" });
        }
      }
      // The ranged-weapon-fire projectile FX (row 4, four frames) is describe-only —
      // like crate/poof on the object board, it has no display_name and is never
      // renamed or removed (see themeReviewNameRows, which omits 'projectile' from
      // SET_THEME_ITEM_NAMES' item_kind enum). Its appearance lives in the single
      // plan.projectile_description field, not a decor row id.
      rows.push({ rowId: "projectile", itemKind: "projectile", label: "Ranged projectile (required)", original: item.projectile_description || "" });
      return rows;
    }
    if (item.kind === "rival_atlas" && Array.isArray(item.rival_rows)) {
      let rivalIndex = 0;
      return item.rival_rows
        .filter((row) => row && row.rival_id)
        .map((row) => {
          rivalIndex += 1;
          return {
            rowId: row.rival_id,
            itemKind: "rival",
            label: "Rival " + rivalIndex,
            original: row.visual_description || "",
          };
        });
    }
    if (item.kind === "expression_atlas") {
      // Expression APPEARANCE descriptions — positional, rowId expression_<index>,
      // item_kind "expression" (see applyThemeItemDescriptionChanges' expression
      // branch). The 8 expression LABELS are FIXED semantic hooks (love, idea,
      // anger, …) and are NOT editable — only the per-cell appearance text is.
      // There is deliberately NO name row for expressions (themeReviewNameRows
      // has no expression case), so this description-only row is unioned in as
      // descRow with a read-only label. item.expression_names carries the fixed
      // labels (plan.expressions === FIXED_EXPRESSION_LABELS); fall back to the
      // hardcoded list if it's absent.
      const FIXED_EXPRESSION_LABELS = [
        "Love", "Idea / discovery spark", "Anger", "Team action / rally",
        "Thumbs up", "Music", "Sleep / low-energy zzz", "Dazed / hit",
      ];
      const names = Array.isArray(item.expression_names) ? item.expression_names : [];
      const descriptions = Array.isArray(item.expression_descriptions) ? item.expression_descriptions : [];
      const rows = [];
      for (let i = 0; i < 8; i += 1) {
        const label = names[i] || FIXED_EXPRESSION_LABELS[i] || ("Expression " + (i + 1));
        rows.push({
          rowId: "expression_" + i,
          itemKind: "expression",
          label: "Expression " + (i + 1) + ": " + label,
          original: descriptions[i] || "",
        });
      }
      return rows;
    }
    if (item.kind === "achievement_atlas" && Array.isArray(item.achievement_names)) {
      // Badge APPEARANCE descriptions — positional, rowId achievement_<index>,
      // item_kind "badge" (see applyThemeItemDescriptionChanges' badge branch).
      // These share rowIds with the badge NAME rows (themeReviewNameRows), so
      // themeReviewNamesDescriptionsRows merges each badge's name input and this
      // description textarea into one block. Kept separate from the name/title so
      // a user's appearance text no longer has to be crammed into the title.
      // Label matches the name rows (Badge N — <event>) via badgeEventTitle.
      const badges = Array.isArray(themeBadges) ? themeBadges : [];
      const descriptions = Array.isArray(item.achievement_descriptions) ? item.achievement_descriptions : [];
      return item.achievement_names.map((name, index) => {
        const bd = badges[index] || null;
        const eventTitle = bd ? badgeEventTitle(bd) : null;
        return {
          rowId: "achievement_" + index,
          itemKind: "badge",
          label: "Badge " + (index + 1) + (eventTitle ? " — " + eventTitle : ""),
          original: descriptions[index] || "",
        };
      });
    }
    return [];
  }

  /**
   * Unions themeReviewNameRows(item) and themeReviewDescriptionRows(item) by
   * rowId (== the underlying object_id/decor_id/rival_id/achievement row id/
   * character item.id) so the merged "Names & descriptions" editor can render
   * one block per item with the name input directly above its description
   * textarea. Preserves the row-set asymmetry from the two sources instead of
   * papering over it: badge rows have nameRow only (no description column for
   * achievements), character rows have descRow only (name lives in the
   * separate "Character name" / RENAME_THEME_CHARACTER widget), and
   * object/decor/rival rows have both. Order follows themeReviewNameRows
   * first (covers the common both-rows case), then appends any
   * description-only rows (character) not already seen.
   * @param {any} item a THEME_IMAGE_REVIEW review item
   * @returns {Array<{rowId: string, label: string, nameRow: object|null, descRow: object|null}>}
   */
  function themeReviewNamesDescriptionsRows(item) {
    const nameRows = themeReviewNameRows(item);
    const descRows = themeReviewDescriptionRows(item);
    const nameById = new Map(nameRows.map((row) => [row.rowId, row]));
    const descById = new Map(descRows.map((row) => [row.rowId, row]));
    const orderedIds = [];
    const seen = new Set();
    for (const row of nameRows) {
      if (seen.has(row.rowId)) continue;
      seen.add(row.rowId);
      orderedIds.push(row.rowId);
    }
    for (const row of descRows) {
      if (seen.has(row.rowId)) continue;
      seen.add(row.rowId);
      orderedIds.push(row.rowId);
    }
    return orderedIds.map((rowId) => {
      const nameRow = nameById.get(rowId) || null;
      const descRow = descById.get(rowId) || null;
      return { rowId, label: (nameRow || descRow).label, nameRow, descRow };
    });
  }

  /**
   * Builds the per-frame regeneration picker (feedback #18): a clickable grid
   * of the board's individual frame_slots entries, each thumbnailed from
   * item.frame_slots[i].data — see panel.ts's _postThemeImageReview. For
   * multi-key boards (objects/decor/rivals) each entry is one frame_keys
   * entry (its first stored frame). For character boards, which own exactly
   * one frame_keys entry holding ALL poses, each entry instead enumerates one
   * pose WITHIN that key (slot.index set, see the isWithinKeyPose branch
   * below) — otherwise the array would always be length 1 and never clear the
   * `slots.length < 2` gate below. Either way, a tile's POSITION in the array
   * is what gets toggled and sent as `slots` on the RETRY_THEME_IMAGE
   * payload; the host (retryThemeImage) decides whether that position
   * addresses a key or a within-key pose from the item's own stored shape.
   * Clicking a tile toggles it in/out of themeReviewSelectedFrameSlots[item.id];
   * the existing whole-board Retry button (unchanged) reads that selection at
   * click time. A full board is ALWAYS generated behind the scenes — image
   * models produce a board atomically, there is no per-cell API — this picker
   * only controls what gets KEPT from the result, so the hint text below says
   * so explicitly rather than implying a cheaper/faster partial regeneration.
   * Returns null when the item has fewer than 2 frame slots (nothing to pick
   * between) or no image yet, so genuinely single-frame boards (environment)
   * and not-yet-generated cards are unaffected — this is purely additive.
   * @param {any} item
   * @param {boolean} disabledForGeneration true while an unrelated active generation run blocks edits
   */
  function buildThemeReviewFrameGrid(item, disabledForGeneration) {
    const slots = Array.isArray(item.frame_slots) ? item.frame_slots : [];
    if (slots.length < 2 || !item.image_src) return null;
    if (!themeReviewSelectedFrameSlots.has(item.id)) {
      themeReviewSelectedFrameSlots.set(item.id, new Set());
    }
    const selected = themeReviewSelectedFrameSlots.get(item.id);

    const section = document.createElement("div");
    section.className = "theme-review-frame-grid-section";
    const details = document.createElement("details");
    details.className = "theme-review-frame-grid-details";
    details.open = selected.size > 0;
    const summary = document.createElement("summary");
    summary.textContent = "Regenerate individual frames";
    details.appendChild(summary);

    const hint = document.createElement("div");
    hint.className = "theme-review-names-descriptions-hint";
    hint.textContent = "Select the frame(s) to fix, then use Retry image below. The whole board is regenerated "
      + "either way (same cost/time) — only the frame(s) you select are kept from the new result, unless the "
      + "regenerated board's layout doesn't match the current one, in which case the whole board is replaced.";
    details.appendChild(hint);

    const grid = document.createElement("div");
    grid.className = "theme-review-frame-grid";
    slots.forEach((slot, index) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "theme-review-frame-tile";
      tile.disabled = disabledForGeneration;
      const isSelected = selected.has(index);
      tile.classList.toggle("theme-review-frame-tile--selected", isSelected);
      tile.setAttribute("aria-pressed", String(isSelected));
      // Character boards enumerate WITHIN one key's pose array (see panel.ts's
      // _postThemeImageReview): slot.index is set there, distinguishing "pose N of
      // this character" from the normal "key N of this board" phrasing used by
      // multi-key boards (objects/decor/rivals), where each entry is its own key.
      const isWithinKeyPose = typeof slot.index === "number";
      tile.title = isWithinKeyPose
        ? `Pose ${index + 1} of ${slots.length} — click to ${isSelected ? "deselect" : "select for regeneration"}`
        : slot.key
          ? `${slot.key} (frame ${index + 1} of ${slots.length}) — click to ${isSelected ? "deselect" : "select for regeneration"}`
          : `Frame ${index + 1} of ${slots.length}`;
      if (slot.data) {
        const img = document.createElement("img");
        img.src = slot.data;
        img.alt = isWithinKeyPose ? `Pose ${index + 1}` : slot.key || `Frame ${index + 1}`;
        tile.appendChild(img);
      } else {
        tile.classList.add("theme-review-frame-tile--empty");
      }
      tile.addEventListener("click", () => {
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
        tile.classList.toggle("theme-review-frame-tile--selected", selected.has(index));
        tile.setAttribute("aria-pressed", String(selected.has(index)));
      });
      grid.appendChild(tile);
    });
    details.appendChild(grid);
    section.appendChild(details);
    return section;
  }

  /**
   * p79-t2 fix: positional index within the matching plan array for a
   * board-card row, so live typing can write straight into
   * currentThemePlan.<field>[index] (see applyThemeReviewFieldToPlan).
   * badge/expression/character rowIds already carry their index
   * (achievement_<n>/expression_<n>/agent_<n>); object/decor/rival rowIds
   * are the manifest's own opaque ids, looked up against the roster arrays
   * (themeBuildables/themeDecor/themeRivals) that share plan array order.
   * @param {string} itemKind
   * @param {string} rowId
   * @returns {number} -1 when no matching slot is found
   */
  function themeReviewIndexForRow(itemKind, rowId) {
    if (itemKind === "badge" || itemKind === "expression" || itemKind === "character") {
      const match = /(\d+)$/.exec(rowId || "");
      return match ? parseInt(match[1], 10) : -1;
    }
    if (itemKind === "object") {
      return (Array.isArray(themeBuildables) ? themeBuildables : []).findIndex((o) => o && o.object_id === rowId);
    }
    if (itemKind === "decor") {
      return (Array.isArray(themeDecor) ? themeDecor : []).findIndex((d) => d && d.decor_id === rowId);
    }
    if (itemKind === "rival") {
      return (Array.isArray(themeRivals) ? themeRivals : []).findIndex((r) => r && r.rival_id === rowId);
    }
    return -1;
  }

  /** @type {Record<string, [string|null, string|null]>} itemKind -> [namesArrayField, descriptionsArrayField] */
  const THEME_REVIEW_PLAN_FIELD_BY_KIND = {
    character: ["characters", "character_descriptions"],
    rival: ["enemies", "enemy_descriptions"],
    decor: ["decor", "decor_descriptions"],
    object: ["objects", "object_descriptions"],
    expression: [null, "expression_descriptions"],
    badge: ["achievements", "achievement_descriptions"],
  };

  /**
   * p79-t2 fix: keeps currentThemePlan live-updated as the user types a
   * board card's name/description, so Save theme / the post-upload
   * autosave (collectDraftThemePlan reads currentThemePlan directly) carry
   * exactly what's on the cards without requiring the card's own Apply
   * click first.
   * @param {string} itemKind
   * @param {string} rowId
   * @param {"name"|"desc"} field
   * @param {string} value
   */
  /** @type {Record<string, string>} itemKind -> scalar plan field (description-only rows with no array slot). */
  const THEME_REVIEW_SCALAR_FIELD_BY_KIND = {
    crate: "crate_description",
    poof: "poof_description",
    projectile: "projectile_description",
  };

  function applyThemeReviewFieldToPlan(itemKind, rowId, field, value) {
    if (field === "desc" && THEME_REVIEW_SCALAR_FIELD_BY_KIND[itemKind]) {
      if (!currentThemePlan) currentThemePlan = {};
      currentThemePlan[THEME_REVIEW_SCALAR_FIELD_BY_KIND[itemKind]] = value;
      return;
    }
    const fields = THEME_REVIEW_PLAN_FIELD_BY_KIND[itemKind];
    if (!fields) return;
    const arrayKey = field === "name" ? fields[0] : fields[1];
    if (!arrayKey) return;
    const index = themeReviewIndexForRow(itemKind, rowId);
    if (index < 0) return;
    if (!currentThemePlan) currentThemePlan = {};
    if (!Array.isArray(currentThemePlan[arrayKey])) currentThemePlan[arrayKey] = [];
    currentThemePlan[arrayKey][index] = value;
  }

  /**
   * Builds the single, merged "Names & descriptions" editor: one block per
   * unioned row (see themeReviewNamesDescriptionsRows) with the name <input>
   * directly above the description <textarea> — omitting whichever field the
   * row doesn't carry (badges: name only; characters: description only). One
   * "Apply" button gathers CHANGED fields from both kinds and posts
   * SET_THEME_ITEM_NAMES / SET_THEME_ITEM_DESCRIPTIONS (existing payload
   * shapes, unchanged) — either, or both, depending on what actually changed.
   * Collapsed by default; open state is persisted the same way the old
   * separate sections did (captureThemeReviewUiState() reads
   * .theme-review-names-descriptions-details.open into savedDraft.namesOpen —
   * the old, now-retired descriptionsOpen flag no longer exists). Returns
   * null when the item's kind carries no nameable or describable rows.
   * @param {any} item
   * @param {{names?: Record<string,string>, descriptions?: Record<string,string>}|undefined} savedDraft
   * @param {boolean} busy true while a previous Apply for this board is in flight
   * @param {boolean} disabledForGeneration true while an unrelated active generation run blocks edits
   * @param {boolean} descriptionsStale true when saved descriptions were generated under a previous
   *   creative direction — shows a "stale" pill next to each description row's header
   */
  function buildThemeReviewNamesDescriptionsSection(item, savedDraft, busy, disabledForGeneration, descriptionsStale) {
    const rows = themeReviewNamesDescriptionsRows(item);
    if (!rows.length) return null;
    const section = document.createElement("div");
    section.className = "theme-review-names-descriptions";
    const details = document.createElement("details");
    details.className = "theme-review-names-descriptions-details";
    // p80-t4: every board card shows its name/description fields visible by
    // default, no extra click — open unless the user has explicitly
    // collapsed this card before (savedDraft.namesOpen === false).
    details.open = savedDraft?.namesOpen === false ? false : true;
    const summary = document.createElement("summary");
    summary.textContent = "Names & descriptions";
    details.appendChild(summary);
    details.addEventListener("toggle", () => {
      if (savedDraft) savedDraft.namesOpen = details.open;
    });
    const hint = document.createElement("div");
    hint.className = "theme-review-names-descriptions-hint";
    hint.textContent = "Descriptions are optional — leave blank to let the image generator work from the name alone.";
    details.appendChild(hint);
    const grid = document.createElement("div");
    grid.className = "theme-review-names-descriptions-grid";
    const inputsDisabled = busy || disabledForGeneration;
    const nameInputs = [];
    const descInputs = [];
    const bodyPlanControls = [];
    for (const row of rows) {
      // The build crate and poof effect are required for every theme (never
      // renamed or removed) — flag that once, right before the first of the
      // two rows, so it reads as a note about them specifically rather than
      // a blanket statement at the top of the whole editor.
      if (row.rowId === "crate") {
        const requiredNote = document.createElement("div");
        requiredNote.className = "theme-review-names-descriptions-hint";
        requiredNote.textContent = "The build crate and poof effect below are required for every theme — you can describe their appearance, but not rename or remove them.";
        grid.appendChild(requiredNote);
      }
      const rowEl = document.createElement("div");
      rowEl.className = "theme-review-names-descriptions-row";
      const labelEl = document.createElement("span");
      labelEl.className = "theme-review-names-descriptions-label";
      labelEl.textContent = row.label;
      rowEl.appendChild(labelEl);
      if (row.descRow && descriptionsStale) {
        const stalePill = document.createElement("span");
        stalePill.className = "theme-desc-stale";
        stalePill.textContent = "stale";
        rowEl.appendChild(stalePill);
      }
      if (row.nameRow) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "theme-review-name-input theme-review-names-input";
        input.maxLength = 60;
        input.placeholder = "Name";
        input.dataset.rowId = row.nameRow.rowId;
        input.dataset.itemKind = row.nameRow.itemKind;
        input.dataset.original = row.nameRow.original;
        const draftValue = savedDraft?.names && Object.prototype.hasOwnProperty.call(savedDraft.names, row.nameRow.rowId)
          ? savedDraft.names[row.nameRow.rowId]
          : row.nameRow.original;
        input.value = draftValue;
        input.disabled = inputsDisabled;
        rowEl.appendChild(input);
        nameInputs.push(input);
      }
      if (row.descRow) {
        const textarea = document.createElement("textarea");
        textarea.className = "theme-review-description-input theme-review-descriptions-input";
        textarea.rows = 2;
        textarea.maxLength = 400;
        textarea.placeholder = "Optional appearance description…";
        textarea.dataset.rowId = row.descRow.rowId;
        textarea.dataset.itemKind = row.descRow.itemKind;
        textarea.dataset.original = row.descRow.original;
        const draftValue = savedDraft?.descriptions && Object.prototype.hasOwnProperty.call(savedDraft.descriptions, row.descRow.rowId)
          ? savedDraft.descriptions[row.descRow.rowId]
          : row.descRow.original;
        textarea.value = draftValue;
        textarea.disabled = inputsDisabled;
        rowEl.appendChild(textarea);
        descInputs.push(textarea);

        // p58-t2: character-only "Body" control — two-option toggle (two-
        // legged / four-legged) plus a neutral "auto" state that shows the
        // client-side inferred value (inferBodyPlan) until the user picks
        // one explicitly. Draft persists via savedDraft.bodyPlans, mirroring
        // the names/descriptions draft maps above.
        if (row.descRow.itemKind === "character") {
          const rowId = row.descRow.rowId;
          const original = row.descRow.bodyPlan || "";
          const draftHasEntry = savedDraft?.bodyPlans && Object.prototype.hasOwnProperty.call(savedDraft.bodyPlans, rowId);
          let currentValue = draftHasEntry ? savedDraft.bodyPlans[rowId] : original;

          const bodyControl = document.createElement("div");
          bodyControl.className = "theme-body-plan-control";
          bodyControl.dataset.rowId = rowId;
          bodyControl.dataset.itemKind = "character";
          bodyControl.dataset.original = original;
          bodyControl.dataset.value = currentValue;

          const bodyLabel = document.createElement("span");
          bodyLabel.className = "theme-review-names-descriptions-label theme-body-plan-label";
          bodyLabel.textContent = "Body";
          bodyControl.appendChild(bodyLabel);

          const bodyButtons = document.createElement("div");
          bodyButtons.className = "theme-body-plan-buttons";
          bodyButtons.setAttribute("role", "group");
          bodyButtons.setAttribute("aria-label", "Body");

          const bipedBtn = document.createElement("button");
          bipedBtn.type = "button";
          bipedBtn.className = "skill-btn theme-body-plan-btn";
          bipedBtn.textContent = "Two-legged";
          const quadrupedBtn = document.createElement("button");
          quadrupedBtn.type = "button";
          quadrupedBtn.className = "skill-btn theme-body-plan-btn";
          quadrupedBtn.textContent = "Four-legged";
          const resetBtn = document.createElement("button");
          resetBtn.type = "button";
          resetBtn.className = "link-button theme-body-plan-reset";
          resetBtn.textContent = "Reset to auto";

          const refreshBodyControl = () => {
            const inferred = inferBodyPlan(textarea.value || row.descRow.subject);
            const isAuto = !currentValue;
            const effective = currentValue || inferred;
            [[bipedBtn, "biped"], [quadrupedBtn, "quadruped"]].forEach(([btn, value]) => {
              const pressed = effective === value;
              btn.setAttribute("aria-pressed", String(pressed));
              btn.classList.toggle("theme-body-plan-btn--pressed", pressed);
              btn.classList.toggle("theme-body-plan-btn--auto", pressed && isAuto);
              btn.disabled = inputsDisabled;
            });
            resetBtn.hidden = isAuto;
            resetBtn.disabled = inputsDisabled;
          };
          bipedBtn.addEventListener("click", () => {
            currentValue = "biped";
            bodyControl.dataset.value = currentValue;
            if (savedDraft) { savedDraft.bodyPlans = savedDraft.bodyPlans || {}; savedDraft.bodyPlans[rowId] = currentValue; }
            refreshBodyControl();
            updateApplyState();
          });
          quadrupedBtn.addEventListener("click", () => {
            currentValue = "quadruped";
            bodyControl.dataset.value = currentValue;
            if (savedDraft) { savedDraft.bodyPlans = savedDraft.bodyPlans || {}; savedDraft.bodyPlans[rowId] = currentValue; }
            refreshBodyControl();
            updateApplyState();
          });
          resetBtn.addEventListener("click", () => {
            currentValue = "";
            bodyControl.dataset.value = currentValue;
            if (savedDraft) { savedDraft.bodyPlans = savedDraft.bodyPlans || {}; savedDraft.bodyPlans[rowId] = currentValue; }
            refreshBodyControl();
            updateApplyState();
          });
          // The inferred (auto) value changes live as the description is
          // edited, so re-render the control on every desc keystroke too.
          textarea.addEventListener("input", refreshBodyControl);

          bodyButtons.appendChild(bipedBtn);
          bodyButtons.appendChild(quadrupedBtn);
          bodyControl.appendChild(bodyButtons);
          bodyControl.appendChild(resetBtn);

          const bodyHelp = document.createElement("div");
          bodyHelp.className = "theme-review-names-descriptions-hint theme-body-plan-help";
          bodyHelp.textContent = "Two-legged suits upright humans and robots; Four-legged suits dog- and cat-like bodies.";
          bodyControl.appendChild(bodyHelp);

          refreshBodyControl();
          rowEl.appendChild(bodyControl);
          bodyPlanControls.push(bodyControl);
        }
      }
      // Opt-in "Acts as turret" toggle — ONLY on animated buildable-object
      // rows. Gated on the runtime frame-array truth (themeImages[...].length
      // > 1), not manifest anim_fps (that's 5 on every object, static and
      // animated alike, so it can't discriminate — see objectAnimParams
      // above). Fires immediately on change (SET_THEME_OBJECT_TURRET), unlike
      // names/descriptions which stage behind the shared Apply button, since
      // it's always exactly one field on one row.
      if (row.nameRow && row.nameRow.itemKind === "object") {
        const turretObjectId = row.nameRow.rowId;
        const isAnimatedObject = (themeImages["object_" + turretObjectId]?.length || 0) > 1;
        if (isAnimatedObject) {
          const turretLabel = document.createElement("label");
          turretLabel.className = "theme-review-turret-toggle";
          const turretCheckbox = document.createElement("input");
          turretCheckbox.type = "checkbox";
          const manifestObj = themeBuildables.find((obj) => obj.object_id === turretObjectId);
          turretCheckbox.checked = !!(manifestObj && manifestObj.is_turret === true);
          turretCheckbox.disabled = inputsDisabled;
          turretCheckbox.addEventListener("change", () => {
            vscode.postMessage({
              type: "SET_THEME_OBJECT_TURRET",
              payload: { theme_id: reviewThemeId, object_id: turretObjectId, is_turret: turretCheckbox.checked },
            });
          });
          turretLabel.appendChild(turretCheckbox);
          turretLabel.appendChild(document.createTextNode(" Acts as turret (auto-fires at attackers)"));
          rowEl.appendChild(turretLabel);
        }
      }
      grid.appendChild(rowEl);
    }
    details.appendChild(grid);
    const applyBtn = document.createElement("button");
    applyBtn.className = "skill-btn theme-review-names-descriptions-apply";
    applyBtn.type = "button";
    applyBtn.textContent = busy ? "Saving..." : "Apply";
    const statusEl = document.createElement("div");
    statusEl.className = "theme-review-names-descriptions-status";
    const dirtyNameChanges = () => nameInputs
      .map((input) => ({ input, trimmed: input.value.trim().replace(/\s+/g, " ") }))
      .filter(({ input, trimmed }) => trimmed && trimmed.length <= 60 && trimmed !== input.dataset.original);
    // Unlike names, a description edit is dirty (and valid) even when the new
    // value is blank — clearing a description is a legitimate change.
    const dirtyDescriptionChanges = () => descInputs
      .map((input) => ({ input, trimmed: input.value.trim() }))
      .filter(({ input, trimmed }) => trimmed.length <= 400 && trimmed !== input.dataset.original);
    const dirtyBodyPlanControls = () => bodyPlanControls
      .filter((control) => control.dataset.value !== control.dataset.original);
    const updateApplyState = () => {
      applyBtn.disabled = inputsDisabled
        || (dirtyNameChanges().length === 0 && dirtyDescriptionChanges().length === 0 && dirtyBodyPlanControls().length === 0);
    };
    // p79-t2 fix: live-sync currentThemePlan on every keystroke — independent
    // of Apply (which still exists to persist immediately via
    // SET_THEME_ITEM_NAMES/DESCRIPTIONS below) — so Save theme/autosave
    // (collectDraftThemePlan) always see the card's current text even while
    // the user is still typing and hasn't clicked Apply.
    for (const input of nameInputs) {
      input.addEventListener("input", updateApplyState);
      input.addEventListener("input", () => {
        applyThemeReviewFieldToPlan(input.dataset.itemKind, input.dataset.rowId, "name", input.value);
      });
    }
    for (const input of descInputs) {
      input.addEventListener("input", updateApplyState);
      input.addEventListener("input", () => {
        applyThemeReviewFieldToPlan(input.dataset.itemKind, input.dataset.rowId, "desc", input.value);
      });
    }
    updateApplyState();
    applyBtn.addEventListener("click", () => {
      const nameChanges = [];
      for (const input of nameInputs) {
        const trimmed = input.value.trim().replace(/\s+/g, " ");
        if (!trimmed || trimmed.length > 60 || trimmed === input.dataset.original) {
          // Empty/whitespace/too-long edits are rejected client-side — revert
          // to the last known-good value instead of blocking the rest.
          input.value = input.dataset.original;
          continue;
        }
        nameChanges.push({ item_kind: input.dataset.itemKind, id: input.dataset.rowId, name: trimmed });
      }
      const descriptionChanges = [];
      const descChangeByRowId = new Map();
      for (const input of descInputs) {
        const trimmed = input.value.trim();
        if (trimmed.length > 400 || trimmed === input.dataset.original) {
          if (trimmed.length > 400) input.value = input.dataset.original;
          continue;
        }
        const change = { item_kind: input.dataset.itemKind, id: input.dataset.rowId, description: trimmed };
        descriptionChanges.push(change);
        descChangeByRowId.set(input.dataset.rowId, change);
      }
      // p58-t2: bodyPlan rides in the SAME SET_THEME_ITEM_DESCRIPTIONS change
      // entry as the description, alongside it — merging into an existing
      // dirty-description entry for that row, or creating a description-only
      // (unchanged text) entry when only bodyPlan changed. "" (Reset to
      // auto) is sent as body_plan: undefined so the host clears it.
      for (const control of bodyPlanControls) {
        if (control.dataset.value === control.dataset.original) continue;
        const rowId = control.dataset.rowId;
        const bodyPlanValue = control.dataset.value || undefined;
        const existing = descChangeByRowId.get(rowId);
        if (existing) {
          existing.body_plan = bodyPlanValue;
        } else {
          const change = { item_kind: control.dataset.itemKind, id: rowId, description: control.dataset.original === undefined ? "" : (descInputs.find((i) => i.dataset.rowId === rowId)?.dataset.original || ""), body_plan: bodyPlanValue };
          descriptionChanges.push(change);
          descChangeByRowId.set(rowId, change);
        }
      }
      if (!nameChanges.length && !descriptionChanges.length) {
        updateApplyState();
        return;
      }
      for (const input of nameInputs) input.disabled = true;
      for (const input of descInputs) input.disabled = true;
      for (const control of bodyPlanControls) control.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
      applyBtn.disabled = true;
      applyBtn.textContent = "Saving...";
      statusEl.textContent = "";
      statusEl.classList.remove("theme-review-error");
      // Both messages can be in flight at once (host handles each
      // independently and resyncs with its own fresh THEME_IMAGE_REVIEW +
      // *_RESULT reply) — track which of the two this Apply actually sent so
      // the single button/inputs only re-enable once ALL of them have
      // settled (see applyThemeItemNamesResult/applyThemeItemDescriptionsResult).
      const pending = new Set();
      if (nameChanges.length) pending.add("names");
      if (descriptionChanges.length) pending.add("descriptions");
      themeReviewNamesDescriptionsPending.set(item.id, pending);
      themeReviewBusyItems.set(item.id, "names_descriptions");
      if (nameChanges.length) {
        vscode.postMessage({
          type: "SET_THEME_ITEM_NAMES",
          payload: { theme_id: reviewThemeId, board_id: item.id, changes: nameChanges },
        });
      }
      if (descriptionChanges.length) {
        vscode.postMessage({
          type: "SET_THEME_ITEM_DESCRIPTIONS",
          payload: { theme_id: reviewThemeId, board_id: item.id, changes: descriptionChanges },
        });
      }
    });
    details.appendChild(applyBtn);
    // Badge board only: restore canonical default badge TITLES, moving any custom
    // title the user typed into the badge's appearance description (host-side —
    // see resetThemeBadgeNames). The host shows a native modal confirm (webview
    // confirm() is a no-op) and reposts the review, which rebuilds this card and
    // clears the transient "Resetting…" state — so no separate result handler is
    // needed here.
    if (item.kind === "achievement_atlas") {
      const resetBtn = document.createElement("button");
      resetBtn.className = "skill-btn theme-review-reset-badge-names";
      resetBtn.type = "button";
      resetBtn.textContent = "Reset names to default";
      resetBtn.title = "Restore every badge's default title. Any custom title you typed is moved into that badge's appearance description so the art keeps it.";
      resetBtn.disabled = inputsDisabled;
      resetBtn.addEventListener("click", () => {
        resetBtn.disabled = true;
        resetBtn.textContent = "Resetting…";
        vscode.postMessage({
          type: "RESET_THEME_BADGE_NAMES",
          payload: { theme_id: reviewThemeId },
        });
      });
      details.appendChild(resetBtn);
    }
    details.appendChild(statusEl);
    section.appendChild(details);
    return section;
  }

  /**
   * Builds the post-generation "Creative Direction" panel: a single,
   * whole-theme textarea for ThemePlan.creative_direction (the art seed
   * themePlanCreativeDirection() threads into EVERY board's image prompt).
   * Rendered exactly once, as a dedicated section at the TOP of the theme
   * review — above every board card — rather than nested inside the
   * environment/background card, so the theme's original/current creative
   * direction is immediately visible instead of hidden behind a click.
   * Always visible (no collapsible <details>): a heading, the prefilled
   * textarea, the warning, and Save.
   * Posts SET_THEME_CREATIVE_DIRECTION on Save; the reply (THEME_CREATIVE_DIRECTION_RESULT)
   * is handled by applyThemeCreativeDirectionResult. Saving re-grounds any board
   * regenerated/retried from now on — it never touches already-generated art.
   * @param {string} themeId
   * @param {string|undefined} currentDirection the plan's current creative_direction (THEME_IMAGE_REVIEW payload)
   * @param {boolean} busy true while a previous Save for this theme is in flight
   * @param {boolean} descriptionsStale true when the saved item descriptions were generated under a
   *   different creative direction than the current one (THEME_IMAGE_REVIEW payload)
   * @param {string|undefined} descriptionsDirection the direction the current descriptions were generated under
   * @param {{value: string, dirty: boolean}|null} draft an unsaved edit captured (captureThemeReviewUiState)
   *   from the textarea before this render's rebuild — restored here instead of the payload value so a
   *   THEME_IMAGE_REVIEW push arriving mid-edit never discards what the user typed
   */
  function buildThemeReviewCreativeDirectionSection(themeId, currentDirection, busy, descriptionsStale, descriptionsDirection, draft, locked) {
    const section = document.createElement("div");
    section.className = "theme-review-names-descriptions theme-review-creative-direction-panel";

    const heading = document.createElement("h3");
    heading.className = "theme-review-creative-direction-heading";
    heading.textContent = "Creative direction";
    section.appendChild(heading);

    const textarea = document.createElement("textarea");
    textarea.className = "theme-review-creative-direction-input";
    textarea.rows = 4;
    textarea.value = draft?.dirty ? draft.value : (currentDirection || "");
    textarea.dataset.original = currentDirection || "";
    textarea.disabled = busy;
    section.appendChild(textarea);

    const warning = document.createElement("div");
    warning.className = "theme-review-feedback-hint theme-review-custom-warning";
    warning.textContent = "Rewrites the creative direction for the whole theme. This re-grounds any board you regenerate or retry from now on — it does NOT change art you've already generated until you regenerate it. Re-derive descriptions after changing it so new images follow the new direction.";
    section.appendChild(warning);

    const statusEl = document.createElement("div");
    statusEl.className = "theme-review-names-descriptions-status theme-review-creative-direction-status";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "skill-btn theme-review-creative-direction-save";
    saveBtn.textContent = busy ? "Saving…" : "Save creative direction";
    saveBtn.disabled = busy;

    const markDirty = () => {
      const isDirty = textarea.value !== textarea.dataset.original;
      saveBtn.classList.toggle("theme-review-creative-direction-save-dirty", isDirty);
    };
    textarea.addEventListener("input", markDirty);
    markDirty();

    if (descriptionsStale) {
      const staleNotice = document.createElement("div");
      staleNotice.className = "theme-review-notice theme-desc-stale-notice";
      const staleText = document.createElement("span");
      staleText.textContent = "Descriptions were generated under a previous creative direction. Images will follow the old descriptions until you re-derive them.";
      staleNotice.appendChild(staleText);
      const rederiveBtn = document.createElement("button");
      rederiveBtn.type = "button";
      rederiveBtn.className = "skill-btn theme-review-rederive-descriptions";
      rederiveBtn.textContent = "Re-derive descriptions";
      rederiveBtn.title = locked ? "Account locked" : "Saves your creative-direction edit first";
      rederiveBtn.disabled = Boolean(locked);
      rederiveBtn.addEventListener("click", () => {
        rederiveBtn.disabled = true;
        rederiveBtn.textContent = "Re-deriving…";
        rederiveError.hidden = true;
        rederiveError.textContent = "";
        saveCreativeDirectionIfDirtyThenSend(() => {
          vscode.postMessage({
            type: "REGENERATE_THEME_DESCRIPTIONS",
            payload: { theme_id: themeId },
          });
        });
      });
      staleNotice.appendChild(rederiveBtn);
      const rederiveError = document.createElement("div");
      rederiveError.className = "theme-review-error theme-desc-rederive-error";
      rederiveError.hidden = true;
      staleNotice.appendChild(rederiveError);
      if (descriptionsDirection) {
        const showPrevBtn = document.createElement("button");
        showPrevBtn.type = "button";
        showPrevBtn.className = "theme-review-show-previous-direction";
        showPrevBtn.textContent = "Show previous direction";
        const prevText = document.createElement("div");
        prevText.className = "theme-review-feedback-hint theme-desc-previous-direction";
        prevText.textContent = descriptionsDirection;
        prevText.hidden = true;
        showPrevBtn.addEventListener("click", () => {
          prevText.hidden = !prevText.hidden;
          showPrevBtn.textContent = prevText.hidden ? "Show previous direction" : "Hide previous direction";
        });
        staleNotice.appendChild(showPrevBtn);
        staleNotice.appendChild(prevText);
      }
      section.appendChild(staleNotice);
    }

    saveBtn.addEventListener("click", () => {
      const value = textarea.value.trim();
      if (!value) {
        statusEl.textContent = "Creative direction cannot be empty.";
        statusEl.classList.add("theme-review-error");
        return;
      }
      themeReviewCreativeDirectionBusy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      saveBtn.classList.remove("theme-review-creative-direction-save-dirty");
      textarea.disabled = true;
      statusEl.textContent = "";
      statusEl.classList.remove("theme-review-error");
      vscode.postMessage({
        type: "SET_THEME_CREATIVE_DIRECTION",
        payload: { theme_id: themeId, creative_direction: value },
      });
    });
    section.appendChild(saveBtn);
    section.appendChild(statusEl);
    return section;
  }

  /** Handles a THEME_CREATIVE_DIRECTION_RESULT reply: re-enables the editor and
   * shows a brief saved/failed confirmation. There is exactly one Creative
   * Direction section per theme (the dedicated panel at the top of the theme
   * review, above every board card), so this simply finds it by class rather
   * than matching a per-item id like the names/descriptions handlers above. */
  function applyThemeCreativeDirectionResult(payload) {
    themeReviewCreativeDirectionBusy = false;
    if (!themeImageReviewList) return;
    const textarea = themeImageReviewList.querySelector(".theme-review-creative-direction-input");
    if (!textarea) return;
    const saveBtn = themeImageReviewList.querySelector(".theme-review-creative-direction-save");
    const statusEl = themeImageReviewList.querySelector(".theme-review-creative-direction-status");
    textarea.disabled = false;
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save creative direction";
    }
    if (statusEl) {
      if (payload.ok) {
        if (payload.creative_direction !== undefined) {
          textarea.value = payload.creative_direction;
          textarea.dataset.original = payload.creative_direction;
        }
        statusEl.textContent = "Creative direction saved ✓";
        statusEl.classList.remove("theme-review-error");
      } else {
        statusEl.textContent = "Save failed: " + (payload.error || "Unknown error.");
        statusEl.classList.add("theme-review-error");
      }
    }
  }

  /** Handles a THEME_DESCRIPTIONS_REGENERATE_RESULT reply. On success there is
   * nothing to do here — the host already re-posted THEME_IMAGE_REVIEW (with
   * descriptionsStale cleared) before this reply, which rebuilt the stale
   * notice away. On failure, re-enable the "Re-derive descriptions" button,
   * restore its label, and show the error inline in the stale notice. */
  function applyThemeDescriptionsRegenerateResult(payload) {
    if (!themeImageReviewList || payload.ok) return;
    const rederiveBtn = themeImageReviewList.querySelector(".theme-review-rederive-descriptions");
    if (rederiveBtn) {
      rederiveBtn.disabled = false;
      rederiveBtn.textContent = "Re-derive descriptions";
    }
    const rederiveError = themeImageReviewList.querySelector(".theme-desc-rederive-error");
    if (rederiveError) {
      rederiveError.textContent = "Re-derive failed: " + (payload.error || "Unknown error.");
      rederiveError.hidden = false;
    }
  }

  /** Re-enables every name/description input plus the shared Apply button for
   * one merged editor once ALL pending SET_THEME_ITEM_NAMES/
   * SET_THEME_ITEM_DESCRIPTIONS replies for that board have settled. Called
   * from applyThemeItemNamesResult/applyThemeItemDescriptionsResult instead of
   * each handler only touching its own field kind, since the two share a
   * single Apply button that must not re-enable until BOTH are done. */
  function finalizeThemeReviewNamesDescriptions(card) {
    if (!card) return;
    const applyBtn = card.querySelector(".theme-review-names-descriptions-apply");
    for (const input of card.querySelectorAll(".theme-review-names-input")) input.disabled = false;
    for (const input of card.querySelectorAll(".theme-review-descriptions-input")) input.disabled = false;
    if (applyBtn) {
      applyBtn.textContent = "Apply";
      applyBtn.disabled = true;
    }
  }

  /** Handles a THEME_ITEM_DESCRIPTIONS_RESULT reply. Mirrors
   * applyThemeItemNamesResult: the host posts a fresh THEME_IMAGE_REVIEW (full
   * card rebuild reflecting the resynced prompt/rows — see
   * resyncDescriptionReviewItems in themeService.ts) immediately before this
   * message, so this only needs to patch the description fields plus status
   * text. The merged editor's single Apply button/inputs only get re-enabled
   * (via finalizeThemeReviewNamesDescriptions) once themeReviewNamesDescriptionsPending
   * shows no more outstanding names/descriptions replies for this board —
   * SET_THEME_ITEM_NAMES may still be in flight from the same Apply click. */
  function applyThemeItemDescriptionsResult(payload) {
    const boardId = payload.board_id || "";
    const pending = themeReviewNamesDescriptionsPending.get(boardId);
    if (pending) pending.delete("descriptions");
    const stillPending = Boolean(pending && pending.size);
    if (!stillPending) {
      themeReviewNamesDescriptionsPending.delete(boardId);
      themeReviewBusyItems.delete(boardId);
    }
    if (!themeImageReviewList) return;
    const cards = themeImageReviewList.querySelectorAll("[data-item-id]");
    for (const card of cards) {
      if (card.getAttribute("data-item-id") !== boardId) continue;
      const statusEl = card.querySelector(".theme-review-names-descriptions-status");
      const inputs = card.querySelectorAll(".theme-review-descriptions-input");
      const appliedById = new Map((payload.applied || []).map((change) => [change.id, change.description]));
      const rejectedById = new Map((payload.rejected || []).map((rejection) => [rejection.id, rejection.reason]));
      for (const input of inputs) {
        const rowId = input.getAttribute("data-row-id");
        if (rowId && appliedById.has(rowId)) {
          const nextDescription = appliedById.get(rowId);
          input.value = nextDescription;
          input.dataset.original = nextDescription;
        } else if (rowId && rejectedById.has(rowId)) {
          input.value = input.dataset.original;
        }
      }
      if (!stillPending) finalizeThemeReviewNamesDescriptions(card);
      if (statusEl) {
        if (payload.error) {
          statusEl.textContent = "Save failed: " + payload.error;
          statusEl.classList.add("theme-review-error");
        } else if (rejectedById.size) {
          const reasons = Array.from(rejectedById.values()).join(" ");
          statusEl.textContent = appliedById.size
            ? (appliedById.size + " description(s) saved; " + rejectedById.size + " rejected: " + reasons)
            : (reasons || "Descriptions were not saved.");
          statusEl.classList.toggle("theme-review-error", !appliedById.size);
        } else if (appliedById.size) {
          statusEl.textContent = "Descriptions saved ✓";
          statusEl.classList.remove("theme-review-error");
        }
      }
    }
  }

  /** Handles a THEME_ITEM_NAMES_RESULT reply. The host posts a fresh
   * THEME_IMAGE_REVIEW (full card rebuild, reflecting the resynced prompt/rows —
   * see resyncRenamedReviewItems in themeService.ts) immediately before this
   * message, so this only needs to patch the name fields plus status text —
   * labels are positional (see themeReviewNameRows) and never go stale. See
   * applyThemeItemDescriptionsResult for why the shared Apply button/inputs
   * only re-enable once themeReviewNamesDescriptionsPending is empty for this
   * board (a merged Apply click can have a SET_THEME_ITEM_DESCRIPTIONS reply
   * still outstanding). */
  function applyThemeItemNamesResult(payload) {
    const boardId = payload.board_id || "";
    const pending = themeReviewNamesDescriptionsPending.get(boardId);
    if (pending) pending.delete("names");
    const stillPending = Boolean(pending && pending.size);
    if (!stillPending) {
      themeReviewNamesDescriptionsPending.delete(boardId);
      themeReviewBusyItems.delete(boardId);
    }
    if (!themeImageReviewList) return;
    const cards = themeImageReviewList.querySelectorAll("[data-item-id]");
    for (const card of cards) {
      if (card.getAttribute("data-item-id") !== boardId) continue;
      const statusEl = card.querySelector(".theme-review-names-descriptions-status");
      const inputs = card.querySelectorAll(".theme-review-names-input");
      const appliedById = new Map((payload.applied || []).map((change) => [change.id, change.name]));
      const rejectedById = new Map((payload.rejected || []).map((rejection) => [rejection.id, rejection.reason]));
      for (const input of inputs) {
        const rowId = input.getAttribute("data-row-id");
        if (rowId && appliedById.has(rowId)) {
          const nextName = appliedById.get(rowId);
          input.value = nextName;
          input.dataset.original = nextName;
        } else if (rowId && rejectedById.has(rowId)) {
          input.value = input.dataset.original;
        }
      }
      if (!stillPending) finalizeThemeReviewNamesDescriptions(card);
      if (statusEl) {
        if (payload.error) {
          statusEl.textContent = "Save failed: " + payload.error;
          statusEl.classList.add("theme-review-error");
        } else if (rejectedById.size) {
          // Surface the server's per-row reason (e.g. 'Unknown rival "x".') instead of
          // a generic message, so a future id/kind mismatch is diagnosable from the UI.
          const reasons = Array.from(rejectedById.values()).join(" ");
          statusEl.textContent = appliedById.size
            ? (appliedById.size + " name(s) saved; " + rejectedById.size + " rejected: " + reasons)
            : (reasons || "Names were not saved.");
          statusEl.classList.toggle("theme-review-error", !appliedById.size);
        } else if (appliedById.size) {
          statusEl.textContent = "Names saved ✓";
          statusEl.classList.remove("theme-review-error");
        }
      }
    }
  }

  // Tracks the single open review-board right-click menu so a second right-click
  // (or any dismissal) always tears down the previous one first.
  let themeReviewContextMenuEl = null;
  let themeReviewContextMenuCleanup = null;

  function closeThemeReviewContextMenu() {
    if (themeReviewContextMenuCleanup) {
      try { themeReviewContextMenuCleanup(); } catch (_e) { /* ignore */ }
      themeReviewContextMenuCleanup = null;
    }
    if (themeReviewContextMenuEl && themeReviewContextMenuEl.parentNode) {
      themeReviewContextMenuEl.parentNode.removeChild(themeReviewContextMenuEl);
    }
    themeReviewContextMenuEl = null;
  }

  /**
   * Minimal one-item ("Open file location") right-click menu for a review board
   * card. Positioned at the cursor, dismissed on outside click, Escape, scroll,
   * or resize. Clicking the item posts REVEAL_THEME_IMAGE for the given board so
   * the host reveals its saved image file in the OS explorer. Fully guarded —
   * only opens for a card that carries an item id.
   * @param {number} clientX
   * @param {number} clientY
   * @param {string} itemId
   */
  function openThemeReviewContextMenu(clientX, clientY, itemId) {
    if (!itemId || !reviewThemeId) return;
    closeThemeReviewContextMenu();
    const menu = document.createElement("div");
    menu.className = "theme-review-context-menu";
    menu.style.cssText = "position:fixed;z-index:9999;min-width:150px;padding:4px;"
      + "background:var(--vscode-menu-background,#252526);"
      + "color:var(--vscode-menu-foreground,#ccc);"
      + "border:1px solid var(--vscode-menu-border,rgba(255,255,255,0.15));"
      + "border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,0.4);font-size:12px;";
    const openItem = document.createElement("button");
    openItem.type = "button";
    openItem.textContent = "Open file location";
    openItem.style.cssText = "display:block;width:100%;text-align:left;padding:5px 10px;"
      + "background:transparent;border:none;color:inherit;cursor:pointer;border-radius:3px;font-size:12px;";
    openItem.addEventListener("mouseenter", () => {
      openItem.style.background = "var(--vscode-menu-selectionBackground,rgba(255,255,255,0.12))";
    });
    openItem.addEventListener("mouseleave", () => { openItem.style.background = "transparent"; });
    openItem.addEventListener("click", () => {
      closeThemeReviewContextMenu();
      vscode.postMessage({
        type: "REVEAL_THEME_IMAGE",
        payload: { theme_id: reviewThemeId, item_id: itemId },
      });
    });
    menu.appendChild(openItem);
    document.body.appendChild(menu);
    themeReviewContextMenuEl = menu;

    // Clamp within the viewport so the menu never overflows off-screen.
    const rect = menu.getBoundingClientRect();
    const left = Math.min(clientX, Math.max(0, window.innerWidth - rect.width - 4));
    const top = Math.min(clientY, Math.max(0, window.innerHeight - rect.height - 4));
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    const onOutside = (event) => { if (!menu.contains(event.target)) closeThemeReviewContextMenu(); };
    const onKey = (event) => { if (event.key === "Escape") closeThemeReviewContextMenu(); };
    // Defer the outside-click binding a tick so the originating right-click's
    // trailing events don't immediately dismiss the fresh menu.
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside, true);
      document.addEventListener("contextmenu", onOutside, true);
    }, 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", closeThemeReviewContextMenu, true);
    window.addEventListener("resize", closeThemeReviewContextMenu, true);
    themeReviewContextMenuCleanup = () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("contextmenu", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", closeThemeReviewContextMenu, true);
      window.removeEventListener("resize", closeThemeReviewContextMenu, true);
    };
  }

  // p43-t2/p43-t3: last THEME_IMAGE_REVIEW payload, kept so a later
  // THEME_SERVICE_STATUS push (fresh credits/pricing, no new review data)
  // can re-render the same cards with an updated cost line without waiting
  // on the host to re-send THEME_IMAGE_REVIEW. Read by 060's message
  // listener. `themeServiceStatus` itself is 010-modals-badges-rebirth.js's
  // module state (shared IIFE scope, built before this file).
  let lastThemeImageReviewPayload = null;

  const THEME_ATTEMPT_ERROR_TEXT = {
    not_signed_in: "Sign in from the Theme Builder to generate",
    insufficient_credits: "Not enough credits",
    unavailable: "Theme Service unavailable — no credits were charged",
    unreachable: "Theme Service unavailable — no credits were charged",
    rate_limited: "Too many requests, try again shortly",
    content_blocked: "This prompt was blocked by content screening. No credit was spent.",
    account_locked: "Your account is locked for repeated content-policy violations. Generation is disabled. Contact us through Submit Feedback to request an unlock.",
  };

  function openThemeBuilderFromReview() {
    // p75: builder-first flow — mirror the Theme Builder tab click handler
    // (openThemeBuilderPlanEditorTab, 010-modals-badges-rebirth.js) instead
    // of opening the sign-in shell modal.
    themeBuilderPlanEditorOpen = true;
    openThemeBuilderPlanEditorTab();
    vscode.postMessage({ type: "OPEN_THEME_BUILDER" });
  }

  /**
   * Above-the-controls "this attempt costs N credits" line (p43-t2). N comes
   * from the last known THEME_SERVICE_STATUS pricing.attemptCostByBoardType
   * for this item's board kind, falling back to "1" (marked as an estimate
   * via the title attribute) when pricing hasn't arrived yet. M is the
   * theme-level payload.creditsSpent; B is the last known signed-in balance,
   * omitted entirely when not signed in.
   * @param {any} item
   * @param {any} payload
   */
  function buildThemeAttemptCostLine(item, payload) {
    const line = document.createElement("div");
    line.className = "theme-attempt-cost";
    const status = typeof themeServiceStatus !== "undefined" ? themeServiceStatus : null;
    const pricing = status && status.pricing;
    const byBoard = pricing && pricing.attemptCostByBoardType;
    const knownCost = byBoard && typeof byBoard[item.boardType] === "number" ? byBoard[item.boardType] : undefined;
    const costText = typeof knownCost === "number" ? String(knownCost) : "1";
    if (typeof knownCost !== "number") line.title = "estimate";
    const spent = typeof payload.creditsSpent === "number" ? payload.creditsSpent : 0;
    let text = `This attempt costs ${costText} credits · Spent on this theme so far: ${spent} credits`;
    if (status && status.signedIn && typeof status.credits === "number") {
      text += ` · Balance ${status.credits} credits`;
    }
    line.textContent = text;
    return line;
  }

  /**
   * Per-item refund/error notice shown above Generate/Retry (p43-t3). Each
   * state gets its own class and plain-text message; the not_signed_in and
   * insufficient_credits states also get a button that opens the Theme
   * Builder shell (openThemeBuilderFromReview). Returns null when the item
   * has nothing to report.
   * @param {any} item
   */
  function buildThemeAttemptStatusNotice(item) {
    // provider_failed without an explicit refund flag is still treated as a
    // refund — the backend always refunds a provider failure, it just may
    // not have set lastAttemptRefunded on this payload.
    if (item.lastAttemptRefunded || item.error_kind === "provider_failed") {
      const notice = document.createElement("div");
      notice.className = "theme-attempt-notice theme-attempt-refunded";
      const n = typeof item.attemptCost === "number" ? item.attemptCost : 1;
      notice.textContent = `Attempt failed, ${n} credit(s) refunded`;
      return notice;
    }
    if (item.error_kind === "not_signed_in" || item.error_kind === "insufficient_credits") {
      const notice = document.createElement("div");
      notice.className = "theme-attempt-notice theme-attempt-"
        + (item.error_kind === "not_signed_in" ? "signin" : "credits");
      notice.textContent = THEME_ATTEMPT_ERROR_TEXT[item.error_kind];
      const btn = document.createElement("button");
      btn.className = "skill-btn theme-attempt-action";
      btn.type = "button";
      btn.textContent = item.error_kind === "not_signed_in" ? "Sign in" : "Buy credits";
      btn.addEventListener("click", () => openThemeBuilderFromReview());
      notice.appendChild(btn);
      return notice;
    }
    if (item.error_kind === "unavailable" || item.error_kind === "unreachable") {
      const notice = document.createElement("div");
      notice.className = "theme-attempt-notice theme-attempt-unavailable";
      notice.textContent = THEME_ATTEMPT_ERROR_TEXT[item.error_kind];
      return notice;
    }
    if (item.error_kind === "rate_limited") {
      const notice = document.createElement("div");
      notice.className = "theme-attempt-notice theme-attempt-ratelimited";
      notice.textContent = THEME_ATTEMPT_ERROR_TEXT.rate_limited;
      return notice;
    }
    if (item.error_kind === "content_blocked") {
      const notice = document.createElement("div");
      notice.className = "theme-attempt-notice theme-attempt-contentblocked";
      notice.appendChild(document.createTextNode(THEME_ATTEMPT_ERROR_TEXT.content_blocked + " "));
      const link = document.createElement("a");
      link.className = "muted tsp-link";
      link.href = "README.md#acceptable-use";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Acceptable use";
      notice.appendChild(link);
      return notice;
    }
    if (item.error_kind === "account_locked") {
      const notice = document.createElement("div");
      notice.className = "theme-attempt-notice theme-attempt-accountlocked";
      notice.textContent = THEME_ATTEMPT_ERROR_TEXT.account_locked;
      return notice;
    }
    return null;
  }

  function renderThemeImageReview(payload) {
    if (!themeImageReview || !themeImageReviewList) return;
    lastThemeImageReviewPayload = payload;
    // Clear/hide any stale health-check results from a previous manual click
    // so they don't linger over a new generation/review render — the health
    // panel is re-populated only by an explicit RUN_THEME_HEALTH_CHECK.
    if (themeHealthResults) {
      themeHealthResults.hidden = true;
      themeHealthResults.textContent = "";
    }
    // Host updates can arrive while the user is editing a different card. Keep
    // those local drafts and the review position instead of treating every
    // update as a brand-new panel.
    const reviewUiState = captureThemeReviewUiState();
    // p80-t3: THEME_IMAGE_REVIEW carries generation_status/generation_resumable
    // (host contract) — an active or resumable AI run should land on the ai
    // screen rather than the manual board grid's default.
    if (themeBuilderScreen === "start") {
      themeBuilderScreen = (payload.generation_status === "active" || payload.generation_resumable === true)
        ? "ai"
        : "manual";
    }
    // p80-t1: renderThemeBuilderScreen is the single authority for whether
    // #theme-image-review (and every Start/AI-only element) is shown — an
    // unconditional removeAttribute("hidden") here bypassed it whenever a
    // review payload arrived (e.g. THEME_REVIEW_READY, 060-theme-image-
    // review.js) before themeBuilderScreen had been advanced off "start",
    // leaving the board grid visible alongside the Start screen's name
    // field/choice row and the AI-only credits/sign-in elements.
    renderThemeBuilderScreen();
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

    // Dedicated Creative Direction section: a single, always-visible panel at
    // the TOP of the review, above every board card. Rendered exactly once per
    // render pass regardless of item count/kind (even with zero items or no
    // environment board) since the list is fully rebuilt from scratch above —
    // prepending it fresh here can never duplicate it.
    const items = Array.isArray(payload.items) ? payload.items : [];
    const reviewAccountLocked = items.some((item) => item.error_kind === "account_locked");
    themeImageReviewList.appendChild(
      buildThemeReviewCreativeDirectionSection(
        reviewThemeId,
        payload.creative_direction,
        themeReviewCreativeDirectionBusy,
        Boolean(payload.descriptionsStale),
        payload.descriptionsDirection,
        reviewUiState.creativeDirectionDraft,
        reviewAccountLocked,
      ),
    );

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
    // p80-t1: "Resume N generations" is a paid batch action, so it must only
    // offer to continue an AI generation run that was actually started and
    // then paused/stopped — not merely because boards are unfinished. A
    // manually built theme's boards are unfinished from the moment they're
    // created (revision 0, no image_src, no generation_error) with no
    // generation ever having run, so `unfinished` alone can't gate this.
    // p80-t3: the host now reports generation_resumable directly on the
    // THEME_IMAGE_REVIEW payload — use it instead of inferring from
    // per-item image_src/generation_error, which fired after a single
    // manual upload with no generation ever having run. Missing means false.
    const hasInterruptedGenerationRun = payload.generation_resumable === true;
    if (themeReviewResumeGeneration) {
      themeReviewResumeGeneration.hidden = Boolean(payload.generation_active) || unfinished === 0 || !hasInterruptedGenerationRun;
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
      // Right-click a board card → minimal "Open file location" menu that reveals
      // this board's saved image file in the OS explorer (see openThemeReviewContextMenu).
      if (item.id) {
        card.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openThemeReviewContextMenu(event.clientX, event.clientY, item.id);
        });
      }

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
      } else if (item.generation_error) {
        preview.textContent = "Generation blocked";
      } else {
        // Not-yet-generated board: render a clearly-labeled placeholder so it
        // reads as "this board hasn't been generated" rather than a broken image.
        preview.classList.add("theme-review-preview--placeholder-board");
        const placeholderBoard = THEME_REVIEW_BOARD_BY_KIND[item.kind]
          || item.kind.replace(/_/g, " ");
        const placeholderBox = document.createElement("div");
        placeholderBox.style.cssText = "display:flex;flex-direction:column;align-items:center;"
          + "justify-content:center;gap:4px;width:100%;height:100%;min-height:96px;box-sizing:border-box;"
          + "padding:8px;text-align:center;background:rgba(255,0,255,0.14);border:2px dashed #ff33ff;color:#ff33ff;";
        const placeholderKind = document.createElement("div");
        placeholderKind.style.cssText = "font-weight:700;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;";
        placeholderKind.textContent = `${placeholderBoard} board — not generated`;
        const placeholderLabel = document.createElement("div");
        placeholderLabel.style.cssText = "font-size:11px;opacity:0.85;";
        placeholderLabel.textContent = item.label;
        placeholderBox.appendChild(placeholderKind);
        placeholderBox.appendChild(placeholderLabel);
        preview.appendChild(placeholderBox);
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
        characterNameInput.disabled = false;
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
        // p79-t3 fix: RENAME_THEME_CHARACTER (below) is the immediate-persist
        // action; this keeps currentThemePlan.characters[i] live so Save
        // theme/autosave carry the typed name even before that click.
        characterNameInput.addEventListener("input", () => {
          applyThemeReviewFieldToPlan("character", item.id, "name", characterNameInput.value);
        });
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
        || themeReviewBusyItems.has(item.id);
      acceptBtn.addEventListener("click", () => {
        acceptBtn.disabled = true;
        if (isCurrentReviewGate) disableThemeRetryButtons();
        acceptBtn.textContent = "Keeping...";
        vscode.postMessage({
          type: 'SET_THEME_IMAGE_REVIEW_STATUS',
          payload: { theme_id: reviewThemeId, item_id: item.id, status: 'accepted' },
        });
      });
      decisionRow.appendChild(acceptBtn);
      if (item.kind === "character_atlas") {
        const normalizeBtn = document.createElement("button");
        normalizeBtn.className = "skill-btn theme-review-normalize";
        normalizeBtn.type = "button";
        normalizeBtn.dataset.idleText = "Normalize size";
        normalizeBtn.textContent = "Normalize size";
        normalizeBtn.disabled = !item.image_src;
        normalizeBtn.title = "Regenerate this character, then fit every frame to the shared production scale. Saves your creative-direction edit first.";
        if (themeReviewBusyItems.get(item.id) === "normalize") {
          normalizeBtn.disabled = true;
          normalizeBtn.textContent = "Regenerating...";
        }
        normalizeBtn.addEventListener("click", () => {
          normalizeBtn.disabled = true;
          normalizeBtn.textContent = "Regenerating...";
          acceptBtn.disabled = true;
          themeReviewBusyItems.set(item.id, "normalize");
          saveCreativeDirectionIfDirtyThenSend(() => {
            vscode.postMessage({
              type: 'NORMALIZE_THEME_CHARACTER',
              payload: {
                theme_id: reviewThemeId,
                item_id: item.id,
                image_provider: selectedThemeImageProvider(),
              },
            });
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
      uploadBtn.disabled = false;
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

      const savedDraft = reviewUiState.drafts.get(item.id);
      // The one-shot notes textarea (mode 'augment'/'custom') is retired — the
      // per-item visual description (namesDescriptionsSection below) is now the
      // single steering surface for retries. A blank Retry always rebuilds the
      // structured prompt fresh from the current plan ('retry' mode), which
      // consumes whatever visual description is currently saved. This applies
      // uniformly, including for blocked items: to recover from a block, edit
      // the description above (e.g. to neutral, non-graphic wording) then Retry.
      const attemptCostLine = buildThemeAttemptCostLine(item, payload);
      const attemptStatusNotice = buildThemeAttemptStatusNotice(item);

      const retryGuidanceHint = document.createElement("div");
      retryGuidanceHint.className = "theme-review-names-descriptions-hint";
      retryGuidanceHint.textContent = "To steer the retry, edit the visual description above, then Retry. Blank retry = fresh reroll.";
      // Object/decor/rival board rows are always drawn from the manifest's
      // buildable_objects / decor_objects / roster_rivals display names, and
      // per-item visual descriptions (0.0.265) replace the manual "retry with
      // notes" loop for steering appearance — this merged editor (0.0.266
      // split it into two sections; re-merged here into one) is the only way
      // to rename rows, and edit + regenerate descriptions here instead of
      // typing free-text notes into the feedback box below every time.
      const namesDescriptionsSection = buildThemeReviewNamesDescriptionsSection(
        item,
        savedDraft,
        themeReviewBusyItems.get(item.id) === "names_descriptions",
        false,
        Boolean(payload.descriptionsStale),
      );
      const frameGridSection = buildThemeReviewFrameGrid(
        item,
        false,
      );
      const retryRow = document.createElement("div");
      retryRow.className = "theme-review-retry-row";
      // Single retry action — no mode dropdown, no notes channel. Always sends
      // mode 'retry': the host rebuilds the structured prompt fresh from the
      // current plan (selectThemeImageRetryPrompt), which consumes whatever
      // visual description is currently saved for this item — that description
      // (namesDescriptionsSection above) is the only steering surface now,
      // including for blocked items (edit the description to neutral wording,
      // then Retry). 'augment'/'custom' modes are retired from this UI; the
      // host still accepts them on the wire for compat, this screen just never
      // sends them.
      const retryBtn = document.createElement("button");
      retryBtn.className = "skill-btn theme-review-retry";
      const retryIdleText = item.image_src || item.generation_error ? "Retry image" : "Generate image";
      retryBtn.dataset.idleText = retryIdleText;
      const retryBusy = themeReviewBusyItems.get(item.id) === "retry";
      retryBtn.textContent = retryBusy || item.id === activeGenerationItemId
        ? "Generating..."
        : retryIdleText;
      // The host serializes theme writes per theme_id (runExclusivePerTheme in
      // themeService.ts), so issuing a retry for an item that is not the
      // current review gate while generation is active is safe — it queues
      // behind the in-flight write rather than racing it. Only this item's
      // own busy state disables the button now.
      const itemLocked = item.error_kind === "account_locked";
      const retryBtnBaseDisabled = retryBusy || itemLocked;
      retryBtn.disabled = retryBtnBaseDisabled;
      retryBtn.title = itemLocked
        ? "Account locked"
        : (!item.image_src && !payload.generation_active
          ? "Generate this unfinished image using the current visual description."
          : "Generate a replacement using the current visual description.")
          + " Saves your creative-direction edit first.";
      retryBtn.addEventListener("click", () => {
        // p77-t1: a fresh per-board "Generate with AI" (no image/error yet —
        // the manual-draft board grid state) gates on sign-in the same way
        // as the main "Generate with AI" button, via the pending-intent
        // mechanism, so it resumes THIS board once sign-in completes instead
        // of only surfacing a not_signed_in error after a round trip.
        const isFreshGenerate = !(item.image_src || item.generation_error);
        const signedIn = typeof themeServiceStatus !== "undefined" && themeServiceStatus && themeServiceStatus.signedIn;
        if (isFreshGenerate && !signedIn) {
          themeGeneratePendingIntent = true;
          themePendingIntentResume = () => retryBtn.click();
          openThemeBuilderShellModal();
          renderThemeServicePanel(themeServiceStatus);
          return;
        }
        retryBtn.disabled = true;
        retryBtn.textContent = "Generating...";
        themeReviewBusyItems.set(item.id, "retry");
        themeReviewRetryWarnings.delete(item.id);
        retryWarning.textContent = "";
        retryWarning.hidden = true;
        // Per-frame regeneration (feedback #18): forward whichever frame_keys
        // indices are currently selected in the picker above. Empty/absent
        // when nothing is selected — the host then does an ordinary
        // full-board replace, unchanged from before this feature existed.
        const selectedSlots = themeReviewSelectedFrameSlots.get(item.id);
        const slots = selectedSlots && selectedSlots.size ? Array.from(selectedSlots) : undefined;
        saveCreativeDirectionIfDirtyThenSend(() => {
          vscode.postMessage({
            type: 'RETRY_THEME_IMAGE',
            payload: {
              theme_id: reviewThemeId,
              item_id: item.id,
              mode: "retry",
              image_provider: selectedThemeImageProvider(),
              character_name: characterNameInput ? characterNameInput.value.trim() : undefined,
              ...(slots ? { slots } : {}),
            },
          });
        });
        // Clear the selection now that it has been sent — the next render
        // (once the retry resolves) will reflect the regenerated board fresh,
        // and a stale selection referring to the OLD frame_keys indices would
        // be misleading to leave checked.
        if (selectedSlots) selectedSlots.clear();
      });
      // Re-slice re-runs slicing on the saved raw atlas with no image-API cost.
      // Only available when the theme saved its original atlas (older themes did not).
      let resliceBtn = null;
      if (item.has_raw_atlas) {
        resliceBtn = document.createElement("button");
        resliceBtn.className = "skill-btn theme-review-reslice";
        resliceBtn.type = "button";
        resliceBtn.dataset.idleText = "Re-slice";
        const resliceBusy = themeReviewBusyItems.get(item.id) === "reslice";
        resliceBtn.textContent = resliceBusy ? "Re-slicing…" : "Re-slice";
        resliceBtn.disabled = themeReviewBusyItems.has(item.id);
        resliceBtn.title = "Re-slice this board from its saved original image — applies the latest slicing fixes without regenerating (no image-generation cost).";
        resliceBtn.addEventListener("click", () => {
          resliceBtn.disabled = true;
          resliceBtn.textContent = "Re-slicing…";
          themeReviewBusyItems.set(item.id, "reslice");
          vscode.postMessage({
            type: 'RESLICE_THEME_IMAGE',
            payload: { theme_id: reviewThemeId, item_id: item.id },
          });
        });
      }
      const retryStatus = document.createElement("div");
      retryStatus.className = "theme-review-retry-status";
      const retryWarning = document.createElement("div");
      retryWarning.className = "theme-review-retry-warning";
      const persistedRetryWarning = themeReviewRetryWarnings.get(item.id) || "";
      retryWarning.textContent = persistedRetryWarning;
      retryWarning.hidden = !persistedRetryWarning;
      retryRow.appendChild(retryBtn);
      if (resliceBtn) retryRow.appendChild(resliceBtn);

      body.appendChild(heading);
      body.appendChild(meta);
      if (generationError) body.appendChild(generationError);
      if (nameRow) body.appendChild(nameRow);
      if (namesDescriptionsSection) body.appendChild(namesDescriptionsSection);
      if (frameGridSection) body.appendChild(frameGridSection);
      body.appendChild(decisionRow);
      body.appendChild(attemptCostLine);
      if (attemptStatusNotice) body.appendChild(attemptStatusNotice);
      body.appendChild(retryGuidanceHint);
      body.appendChild(retryRow);
      body.appendChild(retryStatus);
      body.appendChild(retryWarning);
      card.appendChild(preview);
      card.appendChild(body);
      themeImageReviewList.appendChild(card);
    }
    if (themesScrollEl) themesScrollEl.scrollTop = reviewUiState.scrollTop;
  }

