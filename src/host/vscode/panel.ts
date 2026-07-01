/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Runtime } from "./runtime";
import {
  shortFromModelId,
  modelIdFromShort,
  setFrontmatterModel,
  setKeywordPattern,
} from "./agentConfig";
import { loadAgentRoster } from "../../providers/claude-code/agentRoster";
import { mergeMcpServer, hasMcpServer, removeMcpServer } from "./mcpCatalog";
import { buildAgentMarkdown } from "./packCatalog";
import { detectUefnProject } from "./uefnDetect";
import { buildContextBudget } from "./contextBudget";
import { detectEngineSetups } from "./engineDetect";
import { nativeWindowsUserDataPath } from "./revealUri";
import {
  approveAllThemeImages,
  deleteTheme,
  ensureThemeReviewImages,
  exportThemeArchive,
  getThemeImageReview,
  importThemeArchive,
  listThemes,
  loadTheme,
  loadLatestTheme,
  normalizeThemeCharacterAtlas,
  planTheme,
  readThemeArchive,
  renameThemeCharacter,
  replaceThemeBackground,
  retryThemeImage,
  resumeThemeGeneration,
  saveThemeTuning,
  updateThemeImageReviewStatus,
  uploadThemeImage,
  generateTheme as generateThemeService,
} from "../../extension/themeService";
import type { ThemePlan } from "../../extension/themePlan";
import type { ThemeImageReviewWaitOptions } from "../../extension/themeService";
import {
  getConfiguredThemeImageProvider,
  getThemeImageConfigurationStatus,
  resolveThemeImageSettings,
  saveThemeImageSettings,
} from "../../extension/themeImageSettings";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { mergeTycoonHooks } from "./hookInstall";
export { mergeTycoonHooks } from "./hookInstall";
import { diagnose, DoctorFinding, findForeignHooks, repairSettings } from "./hookDoctor";

/** Singleton webview panel that renders the TycoonAgents visualization. */
export class TycoonPanel {
  public static currentPanel: TycoonPanel | undefined;
  private static readonly viewType = "tycoonagents";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _runtime: Runtime;
  private readonly _globalStorageUri: vscode.Uri;
  private readonly _secrets: vscode.SecretStorage;
  private _disposables: vscode.Disposable[] = [];
  private _runtimeDisposable: { dispose(): void } | undefined;
  private _enginePollInterval: NodeJS.Timeout | undefined;
  private _themeGenerationActive = false;
  private _themeGenerationAbortController: AbortController | undefined;
  private _themeGenerationGateRetryActive = false;
  private _themePauseForReview = true;
  private _themeGenerationReviewGate: {
    themeId: string;
    itemId: string;
    requiresReplacement: boolean;
    generatedReplacementReady: boolean;
    replacement?: Awaited<ReturnType<typeof retryThemeImage>>;
    accept(): void;
    cancel(): void;
  } | undefined;

  public static createOrShow(
    extensionUri: vscode.Uri,
    runtime: Runtime,
    globalStorageUri: vscode.Uri,
    secrets: vscode.SecretStorage,
  ): TycoonPanel {
    // Dock beside the editor (ViewColumn.Two) so we never cover the active
    // Claude Code session in column One.
    const column = vscode.ViewColumn.Two;

    if (TycoonPanel.currentPanel) {
      TycoonPanel.currentPanel._panel.reveal(column, /* preserveFocus */ true);
      return TycoonPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      TycoonPanel.viewType,
      "TycoonAgents",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        // Keep the webview alive when hidden so state/animation don't reset.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media"), globalStorageUri],
      }
    );

    TycoonPanel.currentPanel = new TycoonPanel(panel, extensionUri, runtime, globalStorageUri, secrets);
    return TycoonPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    runtime: Runtime,
    globalStorageUri: vscode.Uri,
    secrets: vscode.SecretStorage,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._runtime = runtime;
    this._globalStorageUri = globalStorageUri;
    this._secrets = secrets;

    this._update();

    // Subscribe to runtime state changes
    this._runtimeDisposable = runtime.onChange((state) => {
      void this._panel.webview.postMessage({ type: "state", state: this._applyTimeAdjustments(state) });
    });

    // Start the engine-status poller (fires immediately, then every 10 s).
    this._pollEngineStatus();
    this._enginePollInterval = setInterval(() => this._pollEngineStatus(), 10000);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message: {
        type: string;
        id?: string;
        model?: string;
        pattern?: string;
        thirdParty?: boolean;
        disclosures?: Array<{
          label?: string;
          vendor?: string;
          package?: string;
          homepage?: string;
          network?: boolean;
          dataNote?: string;
        }>;
      }) => {
        if (message.type === "ready") {
          void this._panel.webview.postMessage({ type: "state", state: this._applyTimeAdjustments(runtime.getState()) });
          // Auto-load the latest theme so the main panel shows the real
          // characters + environment on open (mirrors the Theater view).
          void (async () => {
            const t = await loadLatestTheme(this._globalStorageUri);
            if (t) {
              void this._panel.webview.postMessage({ type: "THEME_INITIALIZED", payload: { manifest: t.manifest, frames: t.frames, is_editor_mode: false } });
            }
          })();
        } else if (message.type === "SAVE_STAGE_TUNING") {
          const p = (message as any).payload;
          const ok = await saveThemeTuning(this._globalStorageUri, p);
          void this._panel.webview.postMessage({ type: "STAGE_TUNING_SAVED", payload: { ok, theme_id: p?.theme_id } });
        } else if (message.type === "REPLACE_BACKGROUND") {
          const themeId = (message as any).payload?.theme_id;
          if (!themeId) {
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: false } });
            return;
          }
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "Use as background",
            filters: { Images: ["png", "jpg", "jpeg", "webp"] },
          });
          if (!picked || picked.length === 0) {
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: false, cancelled: true } });
            return;
          }
          const bytes = await vscode.workspace.fs.readFile(picked[0]);
          const updated = await replaceThemeBackground(this._globalStorageUri, themeId, bytes);
          if (updated) {
            void this._panel.webview.postMessage({
              type: "THEME_INITIALIZED",
              payload: { manifest: updated.manifest, frames: updated.frames, is_editor_mode: false },
            });
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: true } });
          } else {
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: false } });
          }
        } else if (message.type === "UPLOAD_THEME_IMAGE") {
          const { theme_id, item_id } = (message as any).payload ?? {};
          if (!theme_id || !item_id) {
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: false } });
            return;
          }
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { Images: ["png", "jpg", "jpeg", "webp"] },
          });
          if (!picked || picked.length === 0) {
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: false, cancelled: true } });
            return;
          }
          const bytes = await vscode.workspace.fs.readFile(picked[0]);
          const result = await uploadThemeImage(this._globalStorageUri, theme_id, item_id, bytes);
          if (result) {
            await this._postThemeImageReview(theme_id);
            void this._panel.webview.postMessage({
              type: "THEME_INITIALIZED",
              payload: { manifest: result.manifest, frames: result.frames, is_editor_mode: true },
            });
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: true } });
          } else {
            void this._panel.webview.postMessage({ type: "BACKGROUND_REPLACE_RESULT", payload: { ok: false } });
          }
        } else if (message.type === "getSkills") {
          this._handleGetSkills();
        } else if (message.type === "installSkill") {
          if (message.id !== undefined) {
            this._handleInstallSkill(message.id);
          }
        } else if (message.type === "removeSkill") {
          if (message.id !== undefined) {
            await this._handleRemoveSkill(message.id);
          }
        } else if (message.type === "getMcp") {
          this._handleGetMcp();
        } else if (message.type === "installMcp") {
          if (message.id !== undefined) {
            await this._handleInstallMcp(message.id, message.thirdParty === true);
          }
        } else if (message.type === "removeMcp") {
          if (message.id !== undefined) {
            await this._handleRemoveMcp(message.id);
          }
        } else if (message.type === "checkInstall") {
          this._handleCheckInstall();
        } else if (message.type === "installHooks") {
          this._handleInstallHooks();
        } else if (message.type === "getSettings") {
          this._handleGetSettings();
        } else if (message.type === "setAgentModel") {
          if (message.id !== undefined && message.model !== undefined) {
            this._handleSetAgentModel(message.id, message.model);
          }
        } else if (message.type === "setAgentKeywords") {
          if (message.id !== undefined && message.pattern !== undefined) {
            this._handleSetAgentKeywords(message.id, message.pattern);
          }
        } else if (message.type === "removeAgent") {
          if (message.id !== undefined) {
            await this._handleRemoveAgent(message.id);
          }
        } else if (message.type === "repairHook") {
          this._handleInstallHooks();
          this._handleGetSettings();
        } else if (message.type === "resetMetrics") {
          void this._handleResetMetrics();
        } else if (message.type === "getPacks") {
          this._handleGetPacks();
        } else if (message.type === "installPack") {
          if (message.id !== undefined) {
            await this._handleInstallPack(message.id, message.thirdParty === true, message.disclosures);
          }
        } else if (message.type === "removePack") {
          if (message.id !== undefined) {
            await this._handleRemovePack(message.id);
          }
        } else if (message.type === "copyNudge") {
          const text = String((message as any).text ?? "");
          if (text !== "") {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage("Delegation tip copied to clipboard.");
          }
        } else if (message.type === "copyPrompt") {
          const t = String((message as any).text ?? "");
          if (t) {
            await vscode.env.clipboard.writeText(t);
            vscode.window.showInformationMessage("Prompt copied — paste it into Claude Code to run it.");
          }
        } else if (message.type === "getEngineStatus") {
          this._pollEngineStatus();
        } else if (message.type === "setupUefnProject") {
          this._handleSetupUefnProject();
        } else if (message.type === "runDoctor") {
          this._handleRunDoctor();
        } else if (message.type === "applyDoctorFix") {
          void this._handleApplyDoctorFix((message as any).removeForeign === true);
        } else if (message.type === "designDocAction") {
          await this._handleDesignDocAction((message as any).mode);
        } else if (message.type === "GET_THEME_IMAGE_SETTINGS") {
          const providers = await getThemeImageConfigurationStatus(this._secrets);
          void this._panel.webview.postMessage({
            type: "THEME_IMAGE_SETTINGS",
            payload: { provider: await getConfiguredThemeImageProvider(this._secrets), providers },
          });
        } else if (message.type === "SAVE_THEME_IMAGE_SETTINGS") {
          const payload = (message as any).payload as { provider?: string; api_key?: string } | undefined;
          try {
            const provider = await saveThemeImageSettings(
              this._secrets,
              payload?.provider,
              payload?.api_key,
            );
            const providers = await getThemeImageConfigurationStatus(this._secrets);
            void this._panel.webview.postMessage({
              type: "THEME_IMAGE_SETTINGS",
              payload: { provider, providers, saved: true },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: "THEME_IMAGE_SETTINGS",
              payload: { error: String(err) },
            });
          }
        } else if (message.type === "LIST_THEMES") {
          const themes = await listThemes(this._globalStorageUri);
          void this._panel.webview.postMessage({ type: "THEMES_LIST", payload: { themes } });
        } else if (message.type === "EXPORT_THEME") {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          try {
            if (this._themeGenerationActive) {
              throw new Error("Stop the active theme generation before exporting a theme.");
            }
            const theme = (await listThemes(this._globalStorageUri))
              .find((candidate) => candidate.theme_id === themeId);
            if (!theme) throw new Error("Theme not found.");
            if (!theme.export_ready) {
              throw new Error(`Approve all theme images before exporting (${theme.accepted}/${theme.total} approved).`);
            }

            const destination = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(os.homedir(), `${themeId}.zip`)),
              filters: { "Theme archives": ["zip"] },
              saveLabel: "Export theme",
              title: `Export ${theme.display_name}`,
            });
            if (!destination) {
              void this._panel.webview.postMessage({
                type: "THEME_EXPORT_RESULT",
                payload: { theme_id: themeId, cancelled: true },
              });
              return;
            }

            await vscode.workspace.fs.writeFile(destination, await exportThemeArchive(this._globalStorageUri, themeId));
            void this._panel.webview.postMessage({
              type: "THEME_EXPORT_RESULT",
              payload: { theme_id: themeId, display_name: theme.display_name },
            });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: "THEME_EXPORT_RESULT",
              payload: { theme_id: themeId, error: errorMessage(err) },
            });
          }
        } else if (message.type === "IMPORT_THEME") {
          try {
            if (this._themeGenerationActive) {
              throw new Error("Stop the active theme generation before importing a theme.");
            }
            const picked = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              filters: { "Theme archives": ["zip"] },
              openLabel: "Import theme",
              title: "Import a TycoonAgents theme",
            });
            if (!picked?.[0]) {
              void this._panel.webview.postMessage({ type: "THEME_IMPORT_RESULT", payload: { cancelled: true } });
              return;
            }

            const archive = readThemeArchive(await vscode.workspace.fs.readFile(picked[0]));
            const existing = (await listThemes(this._globalStorageUri))
              .find((candidate) => candidate.theme_id === archive.themeId);
            let replace = false;
            if (existing) {
              const answer = await vscode.window.showWarningMessage(
                `A theme named "${existing.display_name}" already uses ID "${archive.themeId}". Replace it?`,
                {
                  modal: true,
                  detail: "The imported theme will replace the existing theme and its saved images.",
                },
                "Replace",
              );
              if (answer !== "Replace") {
                void this._panel.webview.postMessage({ type: "THEME_IMPORT_RESULT", payload: { cancelled: true } });
                return;
              }
              replace = true;
            }

            const imported = await importThemeArchive(this._globalStorageUri, archive, replace);
            const themes = await listThemes(this._globalStorageUri);
            void this._panel.webview.postMessage({ type: "THEMES_LIST", payload: { themes } });
            void this._panel.webview.postMessage({ type: "THEME_IMPORT_RESULT", payload: imported });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: "THEME_IMPORT_RESULT",
              payload: { error: errorMessage(err) },
            });
          }
        } else if (message.type === "DELETE_THEME") {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          let deletedThemeId: string | undefined;
          let deleteError: string | undefined;
          try {
            if (this._themeGenerationActive) {
              throw new Error("Stop the active theme generation before deleting a theme.");
            }

            const savedThemes = await listThemes(this._globalStorageUri);
            const theme = savedThemes.find((candidate) => candidate.theme_id === themeId);
            if (!theme) throw new Error("Theme not found.");

            // VS Code webviews cannot reliably display window.confirm. Keep
            // the destructive gate in the extension host so the user always
            // gets a native modal before anything is removed from disk.
            const answer = await vscode.window.showWarningMessage(
              `Are you sure you want to delete "${theme.display_name}"?`,
              {
                modal: true,
                detail: "This permanently removes the theme and all of its saved images from this computer. This cannot be undone.",
              },
              "Delete",
            );
            if (answer !== "Delete") {
              void this._panel.webview.postMessage({
                type: "THEMES_LIST",
                payload: { themes: savedThemes },
              });
              return;
            }

            await deleteTheme(this._globalStorageUri, themeId);
            deletedThemeId = themeId;
          } catch (err) {
            deleteError = String(err);
          }
          const themes = await listThemes(this._globalStorageUri);
          void this._panel.webview.postMessage({
            type: "THEMES_LIST",
            payload: {
              themes,
              deleted_theme_id: deletedThemeId,
              delete_error: deleteError,
            },
          });
        } else if (message.type === "SELECT_THEME") {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const t = await loadTheme(this._globalStorageUri, payload?.theme_id ?? "");
          if (t) {
            void this._panel.webview.postMessage({ type: "THEME_INITIALIZED", payload: { manifest: t.manifest, frames: t.frames, is_editor_mode: false } });
          } else {
            void this._panel.webview.postMessage({ type: "THEME_GENERATION_ERROR", payload: { message: "Theme not found." } });
          }
        } else if (message.type === "OPEN_THEME_IMAGES") {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId)) {
            void vscode.window.showErrorMessage("TycoonAgents: Invalid theme ID.");
          } else {
            let reviewImages;
            try {
              reviewImages = await ensureThemeReviewImages(this._globalStorageUri, themeId);
            } catch (err) {
              console.error("TycoonAgents: Could not prepare generated images:", err);
              void vscode.window.showErrorMessage("TycoonAgents could not prepare the generated images folder.");
              return;
            }

            if (reviewImages.imageUris.length === 0) {
              void vscode.window.showInformationMessage(
                "No review images are available yet. If generation is still running, try again after its first image completes.",
              );
              return;
            }

            try {
              // Reveal a real image so Explorer opens its containing folder.
              // On desktop Windows, normalize vscode-userdata explicitly to
              // avoid handing the custom URI scheme to the OS protocol picker.
              const imageUri = reviewImages.imageUris[0];
              const nativePath = nativeWindowsUserDataPath(imageUri.scheme, imageUri.path);
              const revealUri = nativePath ? vscode.Uri.file(nativePath) : imageUri;
              await vscode.commands.executeCommand("revealFileInOS", revealUri);
            } catch (err) {
              console.error("TycoonAgents: Could not reveal generated images:", err);
              const displayPath = reviewImages.directoryUri.scheme === "file"
                ? reviewImages.directoryUri.fsPath
                : reviewImages.directoryUri.toString(true);
              void vscode.window.showErrorMessage(
                `TycoonAgents could not open the folder. Images are saved at: ${displayPath}`,
              );
            }
          }
        } else if (message.type === "GET_THEME_IMAGE_REVIEW") {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          if (/^[a-z0-9_]+$/.test(themeId)) {
            await this._postThemeImageReview(themeId);
          }
        } else if (message.type === "SET_THEME_IMAGE_REVIEW_STATUS") {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
            status?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          const status = payload?.status;
          if (/^[a-z0-9_]+$/.test(themeId)
              && /^[a-z0-9_-]+$/.test(itemId)
              && (status === "accepted" || status === "rejected" || status === "pending")) {
            const gate = this._themeGenerationReviewGate;
            const isCurrentGate = gate?.themeId === themeId && gate.itemId === itemId;
            if (isCurrentGate && this._themeGenerationGateRetryActive) {
              void this._panel.webview.postMessage({
                type: "THEME_IMAGE_RETRY_STATE",
                payload: { item_id: itemId, busy: true, message: "Wait for the replacement to finish before keeping it." },
              });
              return;
            }
            const document = await updateThemeImageReviewStatus(this._globalStorageUri, themeId, itemId, status);
            if (document && status === "accepted" && isCurrentGate) gate.accept();
            await this._postThemeImageReview(themeId);
          }
        } else if (message.type === "APPROVE_ALL_THEME_IMAGES") {
          const payload = (message as any).payload as { theme_id?: string } | undefined;
          const themeId = payload?.theme_id ?? "";
          try {
            if (this._themeGenerationActive) {
              throw new Error("Wait for theme generation to finish before approving all images.");
            }
            await approveAllThemeImages(this._globalStorageUri, themeId);
            await this._postThemeImageReview(themeId);
            const themes = await listThemes(this._globalStorageUri);
            void this._panel.webview.postMessage({ type: "THEMES_LIST", payload: { themes } });
          } catch (err) {
            void this._panel.webview.postMessage({
              type: "THEME_APPROVE_ALL_RESULT",
              payload: { theme_id: themeId, error: errorMessage(err) },
            });
          }
        } else if (message.type === "RENAME_THEME_CHARACTER") {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
            name?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          const activeGate = this._themeGenerationReviewGate;
          const renamingActiveGate = this._themeGenerationActive
            && activeGate?.themeId === themeId
            && activeGate.itemId === itemId;
          if (this._themeGenerationActive && !renamingActiveGate) {
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_RENAME_STATE",
              payload: { item_id: itemId, error: "Only the character currently waiting for review can be renamed." },
            });
            return;
          }
          if (renamingActiveGate && this._themeGenerationGateRetryActive) return;
          if (renamingActiveGate) this._themeGenerationGateRetryActive = true;
          try {
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_RENAME_STATE",
              payload: { item_id: itemId, busy: true, message: "Saving character name..." },
            });
            const result = await renameThemeCharacter(
              this._globalStorageUri,
              themeId,
              itemId,
              payload?.name ?? "",
            );
            if (renamingActiveGate
                && this._themeGenerationReviewGate?.themeId === themeId
                && this._themeGenerationReviewGate.itemId === itemId) {
              this._themeGenerationReviewGate.replacement = result;
            }
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_RENAME_STATE",
              payload: { item_id: itemId, busy: false, message: "Character name saved." },
            });
            if (!renamingActiveGate) {
              void this._panel.webview.postMessage({
                type: "THEME_INITIALIZED",
                payload: { manifest: result.manifest, frames: result.frames, is_editor_mode: true },
              });
            }
          } catch (err) {
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_RENAME_STATE",
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          } finally {
            if (renamingActiveGate) this._themeGenerationGateRetryActive = false;
          }
        } else if (message.type === "NORMALIZE_THEME_CHARACTER") {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
            image_provider?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          const activeGate = this._themeGenerationReviewGate;
          const normalizingDuringActiveGeneration = this._themeGenerationActive
            && activeGate?.themeId === themeId
            && activeGate.itemId === itemId;
          if (this._themeGenerationActive && !normalizingDuringActiveGeneration) {
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_NORMALIZE_STATE",
              payload: {
                item_id: itemId,
                error: "Only the character currently waiting for review can be normalized.",
              },
            });
            return;
          }
          if (normalizingDuringActiveGeneration && this._themeGenerationGateRetryActive) return;
          if (normalizingDuringActiveGeneration) this._themeGenerationGateRetryActive = true;
          try {
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) throw new Error("The selected image provider has no saved API key.");
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_NORMALIZE_STATE",
              payload: { item_id: itemId, busy: true, message: "Regenerating at the standard character scale..." },
            });
            const result = await normalizeThemeCharacterAtlas(
              this._globalStorageUri,
              themeId,
              itemId,
              {
                provider: imageSettings.provider,
                apiKey: imageSettings.apiKey,
                signal: normalizingDuringActiveGeneration ? this._themeGenerationAbortController?.signal : undefined,
              },
              (message) => void this._panel.webview.postMessage({
                type: "THEME_CHARACTER_NORMALIZE_STATE",
                payload: { item_id: itemId, busy: true, message },
              }),
            );
            if (normalizingDuringActiveGeneration
                && this._themeGenerationReviewGate?.themeId === themeId
                && this._themeGenerationReviewGate.itemId === itemId) {
              this._themeGenerationReviewGate.replacement = result;
              this._themeGenerationReviewGate.generatedReplacementReady = true;
            }
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_NORMALIZE_STATE",
              payload: { item_id: itemId, busy: false, message: "Regenerated and normalized character ready for review." },
            });
            if (!normalizingDuringActiveGeneration) {
              void this._panel.webview.postMessage({
                type: "THEME_INITIALIZED",
                payload: { manifest: result.manifest, frames: result.frames, is_editor_mode: true },
              });
            }
          } catch (err) {
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: "THEME_CHARACTER_NORMALIZE_STATE",
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          } finally {
            if (normalizingDuringActiveGeneration) this._themeGenerationGateRetryActive = false;
          }
        } else if (message.type === "RETRY_THEME_IMAGE") {
          const payload = (message as any).payload as {
            theme_id?: string;
            item_id?: string;
            feedback?: string;
            mode?: string;
            image_provider?: string;
            character_name?: string;
          } | undefined;
          const themeId = payload?.theme_id ?? "";
          const itemId = payload?.item_id ?? "";
          if (!/^[a-z0-9_]+$/.test(themeId) || !/^[a-z0-9_-]+$/.test(itemId)) return;
          const activeGate = this._themeGenerationReviewGate;
          const retryingDuringActiveGeneration = this._themeGenerationActive
            && activeGate?.themeId === themeId
            && activeGate.itemId === itemId;
          if (this._themeGenerationActive && !retryingDuringActiveGeneration) {
            void this._panel.webview.postMessage({
              type: "THEME_IMAGE_RETRY_STATE",
              payload: {
                item_id: itemId,
                error: "Wait until this image reaches the review step before generating a replacement.",
              },
            });
            return;
          }
          if (retryingDuringActiveGeneration && this._themeGenerationGateRetryActive) return;
          if (retryingDuringActiveGeneration) this._themeGenerationGateRetryActive = true;
          try {
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) throw new Error("The selected image provider has no saved API key.");
            void this._panel.webview.postMessage({
              type: "THEME_IMAGE_RETRY_STATE",
              payload: { item_id: itemId, busy: true, message: "Generating replacement..." },
            });
            if (payload?.character_name?.trim()) {
              const renamed = await renameThemeCharacter(
                this._globalStorageUri,
                themeId,
                itemId,
                payload.character_name,
              );
              if (retryingDuringActiveGeneration
                  && this._themeGenerationReviewGate?.themeId === themeId) {
                this._themeGenerationReviewGate.replacement = renamed;
              }
            }
            const result = await retryThemeImage(
              this._globalStorageUri,
              themeId,
              itemId,
              payload?.feedback ?? "",
              payload?.mode === "replace"
                ? "replace"
                : payload?.mode === "retry"
                  ? "retry"
                  : "augment",
              {
                provider: imageSettings.provider,
                apiKey: imageSettings.apiKey,
                signal: retryingDuringActiveGeneration ? this._themeGenerationAbortController?.signal : undefined,
              },
              (message) => void this._panel.webview.postMessage({
                type: "THEME_IMAGE_RETRY_STATE",
                payload: { item_id: itemId, busy: true, message },
              }),
            );
            if (retryingDuringActiveGeneration
                && this._themeGenerationReviewGate?.themeId === themeId) {
              this._themeGenerationReviewGate.replacement = result;
              if (this._themeGenerationReviewGate.itemId === itemId) {
                this._themeGenerationReviewGate.generatedReplacementReady = true;
              }
            }
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: "THEME_IMAGE_RETRY_STATE",
              payload: { item_id: itemId, busy: false, message: "Replacement ready for review." },
            });
            if (!retryingDuringActiveGeneration) {
              void this._panel.webview.postMessage({
                type: "THEME_INITIALIZED",
                payload: { manifest: result.manifest, frames: result.frames, is_editor_mode: true },
              });
            }
          } catch (err) {
            await this._postThemeImageReview(themeId);
            void this._panel.webview.postMessage({
              type: "THEME_IMAGE_RETRY_STATE",
              payload: { item_id: itemId, busy: false, error: errorMessage(err) },
            });
          } finally {
            if (retryingDuringActiveGeneration) {
              this._themeGenerationGateRetryActive = false;
              if (!this._themePauseForReview
                  && this._themeGenerationReviewGate?.themeId === themeId) {
                this._themeGenerationReviewGate.accept();
              }
            }
          }
        } else if (message.type === "PLAN_THEME") {
          const payload = (message as any).payload as { prompt?: string; image_provider?: string } | undefined;
          try {
            if (this._themeGenerationActive) throw new Error("Wait for the current theme generation to finish before planning another theme.");
            const prompt = payload?.prompt?.trim() ?? "";
            if (!prompt) throw new Error("Enter a theme name or description first.");
            const imageSettings = await resolveThemeImageSettings(this._secrets, payload?.image_provider);
            if (!imageSettings.apiKey) {
              const label = imageSettings.provider === "openai" ? "OpenAI" : "Google Gemini";
              throw new Error(`No ${label} API key found. Add and save one above the theme prompt.`);
            }
            const plan = await planTheme(prompt, {
              provider: imageSettings.provider,
              apiKey: imageSettings.apiKey,
            });
            void this._panel.webview.postMessage({ type: "THEME_PLAN_READY", payload: { plan } });
          } catch (err) {
            void this._panel.webview.postMessage({ type: "THEME_PLAN_ERROR", payload: { message: String(err) } });
          }
        } else if (message.type === "SET_THEME_PAUSE_FOR_REVIEW") {
          const payload = (message as any).payload as { pause_for_review?: boolean } | undefined;
          if (typeof payload?.pause_for_review !== "boolean") return;
          this._themePauseForReview = payload.pause_for_review;
          if (!this._themePauseForReview
              && this._themeGenerationReviewGate
              && !this._themeGenerationGateRetryActive) {
            this._themeGenerationReviewGate.accept();
          }
        } else if (message.type === "CANCEL_THEME_GENERATION") {
          const controller = this._themeGenerationAbortController;
          if (this._themeGenerationActive && controller && !controller.signal.aborted) {
            controller.abort();
            void this._panel.webview.postMessage({
              type: "THEME_GENERATION_PROGRESS",
              payload: { message: "Stopping generation..." },
            });
          }
        } else if (message.type === "GENERATE_THEME") {
          const payload = (message as any).payload as {
            plan?: ThemePlan;
            resume_theme_id?: string;
            image_provider?: string;
            pause_for_review?: boolean;
          } | undefined;
          if (this._themeGenerationActive) {
            void this._panel.webview.postMessage({
              type: "THEME_GENERATION_ERROR",
              payload: { message: "A theme generation is already running." },
            });
            return;
          }
          let generatedThemeId = "";
          const abortController = new AbortController();
          this._themeGenerationAbortController = abortController;
          this._themeGenerationActive = true;
          try {
            const resumeThemeId = payload?.resume_theme_id ?? "";
            const plan = payload?.plan;
            if (!plan && !resumeThemeId) {
              throw new Error("Create and review the theme plan before generating images.");
            }
            if (resumeThemeId) generatedThemeId = resumeThemeId;
            this._themePauseForReview = payload?.pause_for_review !== false;
            const imageSettings = await resolveThemeImageSettings(
              this._secrets,
              payload?.image_provider,
            );
            if (!imageSettings.apiKey) {
              const label = imageSettings.provider === "openai" ? "OpenAI" : "Google Gemini";
              throw new Error(`No ${label} API key found. Add and save one above the theme prompt.`);
            }
            const onProgress = (msg: string) => void this._panel.webview.postMessage({
              type: "THEME_GENERATION_PROGRESS",
              payload: { message: msg },
            });
            const onReviewReady = (themeId: string) => {
              generatedThemeId = themeId;
              void this._panel.webview.postMessage({ type: "THEME_REVIEW_READY", payload: { theme_id: themeId } });
            };
            const imageOptions = {
              provider: imageSettings.provider,
              apiKey: imageSettings.apiKey,
              signal: abortController.signal,
            };
            const waitForReview = async (themeId: string, itemId: string, reviewOptions?: ThemeImageReviewWaitOptions) => (
              this._themePauseForReview || reviewOptions?.requiresReplacement
                ? this._waitForThemeImageAcceptance(
                    themeId,
                    itemId,
                    abortController.signal,
                    reviewOptions,
                  )
                : undefined
            );
            const r = resumeThemeId
              ? await resumeThemeGeneration(
                  this._globalStorageUri,
                  resumeThemeId,
                  onProgress,
                  () => abortController.signal.aborted,
                  onReviewReady,
                  imageOptions,
                  waitForReview,
                )
              : await generateThemeService(
                  this._globalStorageUri,
                  plan!,
                  onProgress,
                  () => abortController.signal.aborted,
                  onReviewReady,
                  imageOptions,
                  waitForReview,
                );
            void this._panel.webview.postMessage({ type: "THEME_INITIALIZED", payload: { manifest: r.manifest, frames: r.frames, is_editor_mode: true } });
          } catch (err) {
            if (abortController.signal.aborted) {
              void this._panel.webview.postMessage({
                type: "THEME_GENERATION_CANCELLED",
                payload: {
                  theme_id: generatedThemeId,
                  message: "Generation stopped. Completed images were retained; resume whenever you're ready.",
                },
              });
            } else {
              void this._panel.webview.postMessage({ type: "THEME_GENERATION_ERROR", payload: { message: String(err) } });
            }
          } finally {
            this._themeGenerationActive = false;
            this._themeGenerationGateRetryActive = false;
            if (this._themeGenerationAbortController === abortController) {
              this._themeGenerationAbortController = undefined;
            }
            if (generatedThemeId) await this._postThemeImageReview(generatedThemeId);
          }
        }
      },
      null,
      this._disposables
    );

    // Clean up on panel dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  private async _postThemeImageReview(themeId: string): Promise<void> {
    try {
      const review = await getThemeImageReview(this._globalStorageUri, themeId);
      const items = review.entries.map(({ item, imageUri, generated }) => ({
        ...item,
        generated,
        image_src: imageUri
          ? this._panel.webview.asWebviewUri(
              imageUri.with({ query: `revision=${item.revision}&updated=${encodeURIComponent(item.updated_at)}` }),
            ).toString()
          : "",
      }));
      void this._panel.webview.postMessage({
        type: "THEME_IMAGE_REVIEW",
        payload: {
          theme_id: review.theme_id,
          display_name: review.display_name,
          generation_active: this._themeGenerationActive,
          pause_for_review: this._themePauseForReview,
          waiting_for_review_item_id: this._themeGenerationReviewGate?.themeId === themeId
            ? this._themeGenerationReviewGate.itemId
            : undefined,
          items,
        },
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: "THEME_IMAGE_REVIEW",
        payload: { theme_id: themeId, items: [], error: String(err) },
      });
    }
  }

  private _waitForThemeImageAcceptance(
    themeId: string,
    itemId: string,
    signal: AbortSignal,
    options?: ThemeImageReviewWaitOptions,
  ): Promise<Awaited<ReturnType<typeof retryThemeImage>> | undefined> {
    this._themeGenerationReviewGate?.cancel();
    if (signal.aborted) return Promise.reject(new Error("Generation cancelled by user"));

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (this._themeGenerationReviewGate === gate) this._themeGenerationReviewGate = undefined;
        return true;
      };
      const accept = () => {
        if (gate.requiresReplacement && !gate.generatedReplacementReady) return;
        if (cleanup()) resolve(gate.replacement);
      };
      const cancel = () => {
        if (cleanup()) reject(new Error("Generation cancelled by user"));
      };
      const gate = {
        themeId,
        itemId,
        requiresReplacement: Boolean(options?.requiresReplacement),
        generatedReplacementReady: false,
        accept,
        cancel,
      } as {
        themeId: string;
        itemId: string;
        requiresReplacement: boolean;
        generatedReplacementReady: boolean;
        replacement?: Awaited<ReturnType<typeof retryThemeImage>>;
        accept(): void;
        cancel(): void;
      };
      this._themeGenerationReviewGate = gate;
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  private _handleGetSkills(): void {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const projectRoot =
      process.env["CLAUDE_PROJECT_DIR"] ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      "";
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
        mcpNote?: string;
        thirdParty?: boolean;
        source?: string;
      }>;
      const skills = catalog.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        mcpNote: entry.mcpNote,
        thirdParty: entry.thirdParty,
        source: entry.source,
        installed:
          projectRoot !== "" &&
          fs.existsSync(path.join(projectRoot, ".claude", "skills", entry.id)),
      }));
      void this._panel.webview.postMessage({ type: "skills", skills });
    } catch (e) {
      void this._panel.webview.postMessage({ type: "skills", skills: [], error: String(e) });
    }
  }

  private _handleInstallSkill(id: string): void {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const projectRoot =
      process.env["CLAUDE_PROJECT_DIR"] ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      "";

    let catalog: Array<{ id: string; name: string; description: string }>;
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
      }>;
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: String(e),
      });
      return;
    }

    const known = catalog.some((entry) => entry.id === id);
    if (!known) {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: "Unknown skill",
      });
      return;
    }

    if (projectRoot === "") {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: "No workspace folder open",
      });
      return;
    }

    const target = path.join(projectRoot, ".claude", "skills", id);
    if (fs.existsSync(target)) {
      void this._panel.webview.postMessage({ type: "skillInstalled", id, ok: true, alreadyExisted: true });
      return;
    }

    try {
      const src = path.join(this._extensionUri.fsPath, "media", "skills", id);
      fs.mkdirSync(path.join(projectRoot, ".claude", "skills"), { recursive: true });
      fs.cpSync(src, target, { recursive: true });
      void this._panel.webview.postMessage({ type: "skillInstalled", id, ok: true, alreadyExisted: false });
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "skillInstalled",
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  /**
   * Remove an installed skill from the project's `.claude/skills/<id>`.
   * Mirrors `_handleInstallSkill`: validates the id against the bundled
   * catalog, then gates the destructive delete behind a native modal (VS Code
   * webviews cannot reliably show window.confirm). Refreshes the webview's
   * skills list on success. Responds with `{ type:"skillRemoved", id, ok }`.
   */
  private async _handleRemoveSkill(id: string): Promise<void> {
    const catalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
    const root = this._projectRoot();

    let catalog: Array<{ id: string; name: string; description: string }>;
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Array<{
        id: string;
        name: string;
        description: string;
      }>;
    } catch (e) {
      void this._panel.webview.postMessage({ type: "skillRemoved", id, ok: false, error: String(e) });
      return;
    }

    const entry = catalog.find((c) => c.id === id);
    if (entry === undefined) {
      void this._panel.webview.postMessage({ type: "skillRemoved", id, ok: false, error: "Unknown skill" });
      return;
    }

    if (root === "") {
      void this._panel.webview.postMessage({ type: "skillRemoved", id, ok: false, error: "No workspace folder open" });
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Remove the '${entry.name}' skill?`,
      { modal: true, detail: `This deletes .claude/skills/${id} from your project.` },
      "Remove"
    );
    if (answer !== "Remove") {
      void this._panel.webview.postMessage({ type: "skillRemoved", id, ok: false, cancelled: true });
      return;
    }

    try {
      const target = path.join(root, ".claude", "skills", id);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      void this._panel.webview.postMessage({ type: "skillRemoved", id, ok: true });
      this._handleGetSkills();
    } catch (e) {
      void this._panel.webview.postMessage({ type: "skillRemoved", id, ok: false, error: String(e) });
    }
  }

  /** Load and parse the bundled MCP catalog. Throws on read/parse failure. */
  private _loadMcpCatalog(): Array<{
    id: string;
    name: string;
    description: string;
    requiresEnv?: boolean;
    note?: string;
    docsUrl?: string;
    thirdParty?: boolean;
    vendor?: string;
    package?: string;
    homepage?: string;
    network?: string;
    dataNote?: string;
    config: unknown;
  }> {
    const catalogPath = path.join(
      this._extensionUri.fsPath,
      "media",
      "mcp",
      "catalog.json"
    );
    return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  }

  /** Tolerantly read+parse a project's .mcp.json, defaulting to {}. */
  private _readMcpConfig(mcpPath: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* missing/invalid => default {} */
    }
    return {};
  }

  /** Post the MCP server catalog with per-entry installed status. */
  private _handleGetMcp(): void {
    let catalog;
    try {
      catalog = this._loadMcpCatalog();
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "mcp",
        servers: [],
        error: String(e),
      });
      return;
    }

    const root = this._projectRoot();
    const parsed =
      root === "" ? {} : this._readMcpConfig(path.join(root, ".mcp.json"));

    const servers = catalog.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      installed: hasMcpServer(parsed, e.id),
      requiresEnv: e.requiresEnv,
      note: e.note,
      docsUrl: e.docsUrl,
      thirdParty: e.thirdParty,
      vendor: e.vendor,
      package: e.package,
      homepage: e.homepage,
      network: e.network,
      dataNote: e.dataNote,
    }));
    void this._panel.webview.postMessage({ type: "mcp", servers });
  }

  /** Build the modal-confirm body for a third-party MCP server install. */
  private _buildMcpConfirmMessage(entry: {
    name: string;
    vendor?: string;
    package?: string;
    network?: string;
    dataNote?: string;
    homepage?: string;
  }): string {
    const lines: string[] = [];
    lines.push(`Install ${entry.name || "this server"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine.");
    if (entry.vendor) lines.push(`Vendor: ${entry.vendor}`);
    if (entry.package) lines.push(`Runs: ${entry.package}`);
    if (entry.network) {
      lines.push(`Sends data externally: ${entry.dataNote || "contacts an external service."}`);
    } else if (entry.dataNote) {
      lines.push(`Local only: ${entry.dataNote}`);
    }
    if (entry.homepage) lines.push(`Source: ${entry.homepage}`);
    lines.push("");
    lines.push("Check your organization's policy before continuing.");
    return lines.join("\n");
  }

  /** Merge a catalog MCP server's config into the project's .mcp.json. */
  private async _handleInstallMcp(id: string, _thirdParty = false): Promise<void> {
    try {
      let catalog;
      try {
        catalog = this._loadMcpCatalog();
      } catch (e) {
        void this._panel.webview.postMessage({
          type: "mcpInstalled",
          id,
          ok: false,
          error: String(e),
        });
        return;
      }

      const entry = catalog.find((e) => e.id === id);
      if (entry === undefined) {
        void this._panel.webview.postMessage({
          type: "mcpInstalled",
          id,
          ok: false,
          error: "Unknown server",
        });
        return;
      }

      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({
          type: "mcpInstalled",
          id,
          ok: false,
          error: "No workspace folder open",
        });
        return;
      }

      // Host-side confirmation gate for genuinely third-party servers. The
      // authoritative source is the catalog entry's thirdParty flag (not the
      // webview payload). window.confirm is unreliable in VS Code webviews, so
      // we prompt here with a native modal â€” same pattern as pack install.
      if (entry.thirdParty) {
        const answer = await vscode.window.showWarningMessage(
          this._buildMcpConfirmMessage(entry),
          { modal: true },
          "Install"
        );
        if (answer !== "Install") {
          void this._panel.webview.postMessage({
            type: "mcpInstalled",
            id,
            ok: false,
            cancelled: true,
          });
          return;
        }
      }

      const mcpPath = path.join(root, ".mcp.json");
      const existing = this._readMcpConfig(mcpPath);

      if (hasMcpServer(existing, id)) {
        void this._panel.webview.postMessage({
          type: "mcpInstalled",
          id,
          ok: true,
          alreadyExisted: true,
        });
        return;
      }

      const merged = mergeMcpServer(existing, id, this._resolveConfigTokens(entry.config));
      fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
      void this._panel.webview.postMessage({
        type: "mcpInstalled",
        id,
        ok: true,
        alreadyExisted: false,
      });
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "mcpInstalled",
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  /**
   * Remove an MCP server from the project's `.mcp.json`. Mirrors
   * `_handleInstallMcp`: validates the id against the bundled catalog, gates
   * the change behind a native modal, then reads `.mcp.json` tolerantly,
   * deletes `mcpServers[id]` via the pure `removeMcpServer` helper, and writes
   * the file back (retaining the `{ mcpServers: {} }` shape when empty).
   * Responds with `{ type:"mcpRemoved", id, ok }`.
   */
  private async _handleRemoveMcp(id: string): Promise<void> {
    try {
      let catalog;
      try {
        catalog = this._loadMcpCatalog();
      } catch (e) {
        void this._panel.webview.postMessage({ type: "mcpRemoved", id, ok: false, error: String(e) });
        return;
      }

      const entry = catalog.find((e) => e.id === id);
      if (entry === undefined) {
        void this._panel.webview.postMessage({ type: "mcpRemoved", id, ok: false, error: "Unknown server" });
        return;
      }

      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: "mcpRemoved", id, ok: false, error: "No workspace folder open" });
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Remove the '${entry.name}' MCP server?`,
        { modal: true, detail: `This removes "${id}" from .mcp.json in your project.` },
        "Remove"
      );
      if (answer !== "Remove") {
        void this._panel.webview.postMessage({ type: "mcpRemoved", id, ok: false, cancelled: true });
        return;
      }

      const mcpPath = path.join(root, ".mcp.json");
      const existing = this._readMcpConfig(mcpPath);
      const updated = removeMcpServer(existing, id);
      fs.writeFileSync(mcpPath, JSON.stringify(updated, null, 2));
      void this._panel.webview.postMessage({ type: "mcpRemoved", id, ok: true });
      this._handleGetMcp();
    } catch (e) {
      void this._panel.webview.postMessage({ type: "mcpRemoved", id, ok: false, error: String(e) });
    }
  }

  /**
   * Build the third-party disclosure list for a pack from the MCP catalog.
   * Only genuinely third-party MCP servers (thirdParty: true) are disclosed â€”
   * bundled/local servers (e.g. uefn-bridge) must NOT trigger the confirm gate.
   * Shared by _handleGetPacks (display) and _handleInstallPack (host confirm).
   */
  private _buildPackDisclosures(pack: any, mcpCatalog: any[]): any[] {
    const disclosures: any[] = [];
    if (pack && pack.mcp) {
      const m = mcpCatalog.find((x) => x.id === pack.mcp);
      if (m && m.thirdParty) {
        disclosures.push({ label: m.name, vendor: m.vendor, package: m.package, homepage: m.homepage, network: m.network, dataNote: m.dataNote });
      }
    }
    return disclosures;
  }

  private _handleGetPacks(): void {
    try {
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      let mcpCatalog: any[] = [];
      try { mcpCatalog = this._loadMcpCatalog(); } catch { mcpCatalog = []; }
      // Load the skills catalog once to resolve display names for bundled skills.
      let skillNames: Record<string, string> = {};
      try {
        const skillsCatalogPath = path.join(this._extensionUri.fsPath, "media", "skills", "catalog.json");
        const skillsCatalog: any[] = JSON.parse(fs.readFileSync(skillsCatalogPath, "utf8"));
        for (const s of skillsCatalog) {
          if (s && typeof s.id === "string") { skillNames[s.id] = typeof s.name === "string" ? s.name : s.id; }
        }
      } catch { skillNames = {}; }
      const root = this._projectRoot();
      const mcpConfig = root === "" ? {} : this._readMcpConfig(path.join(root, ".mcp.json"));
      const skillInstalled = (id: string): boolean =>
        root !== "" && fs.existsSync(path.join(root, ".claude", "skills", id));
      const result = packs.map((pack: any) => {
        const disclosures = this._buildPackDisclosures(pack, mcpCatalog);
        const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
        const skills = packSkills.map((id: string) => ({
          id,
          name: skillNames[id] ?? id,
          installed: skillInstalled(id),
        }));
        return {
          id: pack.id,
          name: pack.name,
          description: pack.description,
          has: { skill: packSkills.length > 0, mcp: !!pack.mcp, agent: true },
          installed: {
            skill: packSkills.length > 0 && packSkills.every((id: string) => skillInstalled(id)),
            mcp: pack.mcp ? hasMcpServer(mcpConfig, pack.mcp) : false,
            agent: (() => {
              const packAgents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
              return root !== "" && packAgents.length > 0 && packAgents.every((a: any) => fs.existsSync(path.join(root, ".claude", "agents", `${a.id}.md`)));
            })(),
          },
          skills,
          thirdParty: disclosures.length > 0,
          disclosures,
        };
      });
      this._panel.webview.postMessage({ type: "packs", packs: result });
    } catch (e) {
      this._panel.webview.postMessage({ type: "packs", packs: [], error: String(e) });
    }
  }

  /** Build the modal-confirm body listing a pack's third-party sources. */
  private _buildPackConfirmMessage(packName: string, disclosures: any[]): string {
    const networked = disclosures.filter((d) => d && d.network);
    const lines: string[] = [];
    lines.push(`Install ${packName || "this pack"}?`);
    lines.push("");
    lines.push("This installs third-party software that runs on your machine:");
    for (const d of disclosures) {
      const who = [d.label, d.vendor].filter(Boolean).join(" Â· ");
      lines.push(`â€¢ ${who}${d.package ? ` â€” runs ${d.package}` : ""}`);
      if (d.network) {
        lines.push(`    Sends data externally: ${d.dataNote || "contacts an external service."}`);
      } else if (d.dataNote) {
        lines.push(`    Local only: ${d.dataNote}`);
      }
      if (d.homepage) lines.push(`    Source: ${d.homepage}`);
    }
    lines.push("");
    lines.push(networked.length
      ? "One or more components send data to external services. Check your organization's policy before continuing."
      : "Check your organization's policy before continuing.");
    return lines.join("\n");
  }

  private async _handleInstallPack(
    id: string,
    thirdParty = false,
    passedDisclosures?: any[]
  ): Promise<void> {
    try {
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      const pack = packs.find((p: any) => p.id === id);
      if (!pack) {
        this._panel.webview.postMessage({ type: "packInstalled", id, ok: false, error: "Unknown pack" });
        return;
      }
      const root = this._projectRoot();
      if (root === "") {
        this._panel.webview.postMessage({ type: "packInstalled", id, ok: false, error: "No workspace folder open" });
        return;
      }

      // Host-side confirmation gate for third-party packs. window.confirm is
      // unreliable inside VS Code webviews (can silently return false), so we
      // confirm here with a native modal â€” same pattern as the Hook Doctor's
      // foreign-hook removal. Recompute disclosures authoritatively rather than
      // trusting the webview payload (defense-in-depth); fall back to passed
      // values if the catalog can't be loaded.
      let mcpCatalog: any[] = [];
      try { mcpCatalog = this._loadMcpCatalog(); } catch { mcpCatalog = []; }
      const disclosures = mcpCatalog.length > 0
        ? this._buildPackDisclosures(pack, mcpCatalog)
        : (Array.isArray(passedDisclosures) ? passedDisclosures : []);
      const needsConfirm = (thirdParty || disclosures.length > 0) && disclosures.length > 0;
      if (needsConfirm) {
        const answer = await vscode.window.showWarningMessage(
          this._buildPackConfirmMessage(pack.name, disclosures),
          { modal: true },
          "Install"
        );
        if (answer !== "Install") {
          // User dismissed the modal â€” clear the webview's "installingâ€¦" state.
          this._panel.webview.postMessage({ type: "packInstalled", id, ok: false, cancelled: true });
          return;
        }
      }

      const results: Record<string, any> = {};
      const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
      if (packSkills.length > 0) {
        const skillResults: Array<{ id: string; status: "installed" | "exists" }> = [];
        for (const skillId of packSkills) {
          const target = path.join(root, ".claude", "skills", skillId);
          if (fs.existsSync(target)) {
            skillResults.push({ id: skillId, status: "exists" });
          } else {
            const src = path.join(this._extensionUri.fsPath, "media", "skills", skillId);
            fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
            fs.cpSync(src, target, { recursive: true });
            skillResults.push({ id: skillId, status: "installed" });
          }
        }
        results.skills = skillResults;
      }
      if (pack.mcp) {
        // Reuse the catalog loaded above; reload if the earlier (tolerant) load failed.
        const catalog = mcpCatalog.length > 0 ? mcpCatalog : this._loadMcpCatalog();
        const entry = catalog.find((x: any) => x.id === pack.mcp);
        if (entry === undefined) {
          throw new Error(`MCP catalog entry not found for id: ${pack.mcp}`);
        }
        const mcpPath = path.join(root, ".mcp.json");
        const existing = this._readMcpConfig(mcpPath);
        if (hasMcpServer(existing, pack.mcp)) {
          results.mcp = "exists";
        } else {
          const merged = mergeMcpServer(existing, pack.mcp, this._resolveConfigTokens(entry.config));
          fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2));
          results.mcp = "installed";
        }
      }
      const agents = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
      const agentResults: Array<{ id: string; status: "installed" | "exists" }> = [];
      let cfg = this._readKeywordsConfig(root);
      for (const a of agents) {
        const agentPath = path.join(root, ".claude", "agents", `${a.id}.md`);
        if (fs.existsSync(agentPath)) {
          agentResults.push({ id: a.id, status: "exists" });
        } else {
          fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
          fs.writeFileSync(agentPath, buildAgentMarkdown(a));
          agentResults.push({ id: a.id, status: "installed" });
        }
        cfg = setKeywordPattern(cfg, a.id, a.keywords);
        this._runtime.ingest({ type: "WorkerRegistered", at: Date.now(), workerId: a.id, name: a.name, model: a.model, description: a.role });
      }
      results.agents = agentResults;
      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
      fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
      this._panel.webview.postMessage({ type: "packInstalled", id, ok: true, results });
    } catch (e) {
      this._panel.webview.postMessage({ type: "packInstalled", id, ok: false, error: String(e) });
    }
  }

  /**
   * Remove an installed pack: its skills, MCP server, and agent files.
   * Mirrors `_handleInstallPack` but in reverse. Skills and the MCP server are
   * SHARED components — before deleting one, we check whether ANOTHER pack in
   * the catalog also lists that same id and still has any of its components
   * installed; if so we SKIP the delete so we don't break that pack. Agents are
   * pack-specific and are always removed (file + agent-keywords.json entry).
   * Gated behind a native modal. Responds with
   * `{ type:"packRemoved", id, ok, results:{skills, mcp, agents} }`.
   */
  private async _handleRemovePack(id: string): Promise<void> {
    try {
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      const pack = packs.find((p: any) => p.id === id);
      if (!pack) {
        this._panel.webview.postMessage({ type: "packRemoved", id, ok: false, error: "Unknown pack" });
        return;
      }
      const root = this._projectRoot();
      if (root === "") {
        this._panel.webview.postMessage({ type: "packRemoved", id, ok: false, error: "No workspace folder open" });
        return;
      }

      const packSkills: string[] = Array.isArray(pack.skills) ? pack.skills : [];
      const packAgents: any[] = Array.isArray(pack.agents) ? pack.agents : (pack.agent ? [pack.agent] : []);
      const packMcp: string | undefined = pack.mcp || undefined;

      // Build the confirmation summary.
      const parts: string[] = [];
      parts.push(`${packSkills.length} ${packSkills.length === 1 ? "skill" : "skills"}`);
      if (packMcp) parts.push("1 MCP server");
      parts.push(`${packAgents.length} ${packAgents.length === 1 ? "agent" : "agents"}`);
      const answer = await vscode.window.showWarningMessage(
        `Remove '${pack.name}'?`,
        { modal: true, detail: `This removes ${parts.join(", ")} from your project.` },
        "Remove"
      );
      if (answer !== "Remove") {
        this._panel.webview.postMessage({ type: "packRemoved", id, ok: false, cancelled: true });
        return;
      }

      // Shared-component guard: is `componentId` (a skill or MCP id) still
      // claimed by ANOTHER pack that is at least partially installed? Such a
      // pack "still installed" if any of its skills/mcp/agents exist on disk.
      const skillOnDisk = (sid: string): boolean =>
        fs.existsSync(path.join(root, ".claude", "skills", sid));
      const agentOnDisk = (aid: string): boolean =>
        fs.existsSync(path.join(root, ".claude", "agents", `${aid}.md`));
      const mcpConfigNow = (): Record<string, unknown> => this._readMcpConfig(path.join(root, ".mcp.json"));
      const packStillInstalled = (p: any): boolean => {
        const sk: string[] = Array.isArray(p.skills) ? p.skills : [];
        const ag: any[] = Array.isArray(p.agents) ? p.agents : (p.agent ? [p.agent] : []);
        if (sk.some((s) => skillOnDisk(s))) return true;
        if (p.mcp && hasMcpServer(mcpConfigNow(), p.mcp)) return true;
        if (ag.some((a) => agentOnDisk(a.id))) return true;
        return false;
      };
      const sharedByOtherPack = (predicate: (p: any) => boolean): boolean =>
        packs.some((p: any) => p.id !== id && predicate(p) && packStillInstalled(p));

      const results: Record<string, any> = {};

      // Skills.
      const skillResults: Array<{ id: string; status: "removed" | "kept-shared" | "absent" }> = [];
      for (const skillId of packSkills) {
        const target = path.join(root, ".claude", "skills", skillId);
        if (!fs.existsSync(target)) {
          skillResults.push({ id: skillId, status: "absent" });
          continue;
        }
        const shared = sharedByOtherPack((p) => Array.isArray(p.skills) && p.skills.includes(skillId));
        if (shared) {
          skillResults.push({ id: skillId, status: "kept-shared" });
        } else {
          fs.rmSync(target, { recursive: true, force: true });
          skillResults.push({ id: skillId, status: "removed" });
        }
      }
      results.skills = skillResults;

      // MCP server.
      if (packMcp) {
        const mcpPath = path.join(root, ".mcp.json");
        const existing = this._readMcpConfig(mcpPath);
        if (!hasMcpServer(existing, packMcp)) {
          results.mcp = "absent";
        } else if (sharedByOtherPack((p) => p.mcp === packMcp)) {
          results.mcp = "kept-shared";
        } else {
          const updated = removeMcpServer(existing, packMcp);
          fs.writeFileSync(mcpPath, JSON.stringify(updated, null, 2));
          results.mcp = "removed";
        }
      }

      // Agents (pack-specific — always removed).
      const agentResults: Array<{ id: string; status: "removed" | "absent" }> = [];
      let cfg = this._readKeywordsConfig(root);
      for (const a of packAgents) {
        const agentPath = path.join(root, ".claude", "agents", `${a.id}.md`);
        if (fs.existsSync(agentPath)) {
          fs.unlinkSync(agentPath);
          agentResults.push({ id: a.id, status: "removed" });
        } else {
          agentResults.push({ id: a.id, status: "absent" });
        }
        if (cfg && typeof cfg.agents === "object" && cfg.agents !== null && a.id in cfg.agents) {
          const nextAgents = { ...cfg.agents };
          delete nextAgents[a.id];
          cfg = { ...cfg, agents: nextAgents };
        }
      }
      results.agents = agentResults;
      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      try {
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
      } catch {
        /* best-effort: keywords file is non-critical for removal */
      }

      this._panel.webview.postMessage({ type: "packRemoved", id, ok: true, results });
      // Refresh installed state the same way install paths do.
      this._handleGetPacks();
      this._handleGetSkills();
      this._handleGetMcp();
    } catch (e) {
      this._panel.webview.postMessage({ type: "packRemoved", id, ok: false, error: String(e) });
    }
  }

  private _handleSetupUefnProject(): void {
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: "uefnSetupDone", ok: false, error: "No workspace folder open" });
        return;
      }
      // Install the uefn pack (reuses _handleInstallPack logic via _installPackById).
      // We call _handleInstallPack directly; it posts packInstalled â€” but we also need
      // to handle the bridge staging and post uefnSetupDone. So we factor pack install
      // inline here to capture the result synchronously.
      const packsPath = path.join(this._extensionUri.fsPath, "media", "packs", "catalog.json");
      const packs: any[] = JSON.parse(fs.readFileSync(packsPath, "utf8"));
      const pack = packs.find((p: any) => p.id === "uefn");
      if (!pack) {
        void this._panel.webview.postMessage({ type: "uefnSetupDone", ok: false, error: "UEFN pack not found in catalog" });
        return;
      }
      // Reuse the existing pack-install logic by calling _handleInstallPack("uefn").
      // That method posts its own packInstalled message; we additionally stage the bridge
      // and post uefnSetupDone separately. UEFN is not third-party, so no confirm modal
      // is shown and the install body runs synchronously; we don't await it here.
      void this._handleInstallPack("uefn");

      // Stage the Python bridge + Power Tools suite into every location UEFN
      // may load Python from. CRUCIAL: UEFN loads the bridge from the Fortnite
      // ENGINE install's FortniteGame/Content/Python — that copy wins on
      // sys.path over the project's own Content/Python — so staging only the
      // project folder has NO effect on the running tools. Stage into BOTH the
      // project (harmless / future-proof) and every discovered Fortnite engine
      // Python dir. Engine writes may fail without admin; that is non-fatal and
      // reported per-location.
      const bridgeDir = path.join(this._extensionUri.fsPath, "media", "uefn-bridge");

      const targets: Array<{ label: string; dir: string }> = [
        { label: "project", dir: path.join(root, "Content", "Python") },
      ];
      for (const engineDir of this._findFortnitePythonDirs()) {
        targets.push({ label: "engine", dir: engineDir });
      }

      const locations: Array<{
        label: string; dir: string;
        staged: number; updated: number; unchanged: number; error?: string;
      }> = [];
      let totalWritten = 0;
      let engineFound = false;
      for (const t of targets) {
        if (t.label === "engine") engineFound = true;
        try {
          const r = this._stageBridgeTo(bridgeDir, t.dir);
          locations.push({ label: t.label, dir: t.dir, ...r });
          totalWritten += r.staged + r.updated;
        } catch (e) {
          locations.push({ label: t.label, dir: t.dir, staged: 0, updated: 0, unchanged: 0, error: String(e) });
        }
      }
      const bridgeStatus: "staged" | "exists" = totalWritten > 0 ? "staged" : "exists";

      void this._panel.webview.postMessage({
        type: "uefnSetupDone",
        ok: true,
        results: { pack: "uefn", bridge: bridgeStatus, engineFound, locations },
      });
    } catch (e) {
      void this._panel.webview.postMessage({ type: "uefnSetupDone", ok: false, error: String(e) });
    }
  }

  /**
   * Copy every bridge file from `bridgeDir` into `pyDest`, except the Node MCP
   * server (`uefn-server.mjs`), which does not belong in UEFN's Content/Python.
   * A file is written only when absent or when its content differs, so tool
   * updates land without needlessly rewriting unchanged files. Creates pyDest.
   */
  private _stageBridgeTo(
    bridgeDir: string,
    pyDest: string
  ): { staged: number; updated: number; unchanged: number } {
    fs.mkdirSync(pyDest, { recursive: true });
    let staged = 0;
    let updated = 0;
    let unchanged = 0;
    for (const name of fs.readdirSync(bridgeDir)) {
      if (name === "uefn-server.mjs") continue;
      const srcPath = path.join(bridgeDir, name);
      if (!fs.statSync(srcPath).isFile()) continue;
      const destPath = path.join(pyDest, name);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        staged++;
      } else if (!fs.readFileSync(srcPath).equals(fs.readFileSync(destPath))) {
        fs.copyFileSync(srcPath, destPath);
        updated++;
      } else {
        unchanged++;
      }
    }
    return { staged, updated, unchanged };
  }

  /**
   * Discover the Fortnite engine `FortniteGame/Content/Python` director(ies)
   * that UEFN actually loads bridge modules from. Resolves the install via the
   * Epic Games Launcher manifests (authoritative), falling back to common
   * default install locations across drives. Returns only paths whose parent
   * `FortniteGame/Content` exists (the Python subdir is created on stage).
   */
  private _findFortnitePythonDirs(): string[] {
    const found = new Set<string>();
    const addFromInstall = (installLoc: string): void => {
      if (!installLoc) return;
      const contentBase = path.join(installLoc, "FortniteGame", "Content");
      try {
        if (fs.existsSync(contentBase)) {
          found.add(path.join(contentBase, "Python"));
        }
      } catch {
        /* ignore inaccessible path */
      }
    };

    // 1) Epic Games Launcher manifests list every installed app's location.
    try {
      const programData = process.env.ProgramData || "C:\\ProgramData";
      const manifestsDir = path.join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
      if (fs.existsSync(manifestsDir)) {
        for (const f of fs.readdirSync(manifestsDir)) {
          if (!f.toLowerCase().endsWith(".item")) continue;
          try {
            const m = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), "utf8"));
            const label = String(m.DisplayName || m.AppName || m.MandatoryAppFolderName || "");
            const loc = String(m.InstallLocation || "");
            if (loc && /fortnite/i.test(`${label} ${loc}`)) {
              addFromInstall(loc);
            }
          } catch {
            /* skip malformed manifest */
          }
        }
      }
    } catch {
      /* manifests unavailable — fall through to defaults */
    }

    // 2) Fallback: common default install locations.
    if (found.size === 0) {
      for (const drive of ["C:", "D:", "E:", "F:"]) {
        addFromInstall(path.join(`${drive}\\`, "Program Files", "Epic Games", "Fortnite"));
      }
    }

    return [...found];
  }

  private async _handleDesignDocAction(mode: string): Promise<void> {
    const root = this._projectRoot();
    if (!root) {
      vscode.window.showWarningMessage("No project root — open a folder first.");
      return;
    }
    const src = path.join(this._extensionUri.fsPath, "media", "skills", "design-doc");
    const dest = path.join(root, ".claude", "skills", "design-doc");
    try {
      fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    } catch (e) {
      vscode.window.showErrorMessage("Failed to install design-doc skill: " + String(e));
      void this._panel.webview.postMessage({ type: "designDocDone", mode, ok: false, error: String(e) });
      return;
    }
    const prompt = mode === "review"
      ? "Use the design-doc skill (.claude/skills/design-doc) to review the design document(s) in ./design-docs/. Convert each .docx to text with the skill's converter (design-doc-cli.mjs docx2md), read them, summarize what the project is meant to be, flag mismatches with what's currently built, and recommend which TycoonAgents packs/agents to install."
      : "Use the design-doc skill (.claude/skills/design-doc) to analyze this project and generate a design document — a Game Design Document (GDD) if this is a game, otherwise a Product Requirements Document (PRD). Save it as a .docx in ./design-docs/ using the skill's bundled converter (design-doc-cli.mjs md2docx). Base it on what's actually built so I can review and correct it.";
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(
      "Design-doc skill installed and the " + (mode === "review" ? "review" : "generate") + " prompt was copied to your clipboard — paste it into Claude Code to run it."
    );
    void this._panel.webview.postMessage({ type: "designDocDone", mode, ok: true });
  }

  /**
   * Deep-clone `config` and replace every occurrence of the literal token
   * `${EXTENSION_DIR}` in any string value (recursively through objects/arrays)
   * with the extension's real install path (`this._extensionUri.fsPath`).
   * Called at install time so catalog entries with bundled servers resolve correctly.
   */
  private _resolveConfigTokens(config: unknown): unknown {
    const token = "${EXTENSION_DIR}";
    const replacement = this._extensionUri.fsPath;
    const resolve = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value.split(token).join(replacement);
      }
      if (Array.isArray(value)) {
        return value.map(resolve);
      }
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = resolve(v);
        }
        return out;
      }
      return value;
    };
    return resolve(config);
  }

  /**
   * Apply persisted time adjustments from `.claude/tycoon/time-adjustments.json`.
   * Returns a shallow-cloned state with `activeMs` offsets applied to matching agents.
   * Tolerant: missing file, invalid JSON, or non-object => no adjustment.
   */
  private _applyTimeAdjustments(state: any): any {
    try {
      const root = this._projectRoot();
      if (root === "") {
        return state;
      }
      const adjPath = path.join(root, ".claude", "tycoon", "time-adjustments.json");
      let adjustments: Record<string, number> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(adjPath, "utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          adjustments = parsed as Record<string, number>;
        }
      } catch {
        /* missing or invalid => no adjustments */
      }
      if (Object.keys(adjustments).length === 0) {
        return state;
      }

      const applyToMetrics = (metrics: any): any => {
        if (!Array.isArray(metrics)) {
          return metrics;
        }
        return metrics.map((metric: any) => {
          if (metric === null || typeof metric !== "object") {
            return metric;
          }
          const id: unknown = metric.id;
          if (typeof id !== "string" || !(id in adjustments)) {
            return metric;
          }
          const deltaMs = adjustments[id];
          if (typeof deltaMs !== "number") {
            return metric;
          }
          return { ...metric, activeMs: Math.max(0, (metric.activeMs ?? 0) + deltaMs) };
        });
      };

      const cloned: any = { ...state };
      if (Array.isArray(cloned.agentMetrics)) {
        cloned.agentMetrics = applyToMetrics(cloned.agentMetrics);
      }
      if (Array.isArray(cloned._agentMetricsInternal)) {
        cloned._agentMetricsInternal = applyToMetrics(cloned._agentMetricsInternal);
      }
      return cloned;
    } catch {
      return state;
    }
  }

  /** Resolve the project root, matching extension.ts. */
  private _projectRoot(): string {
    return (
      process.env["CLAUDE_PROJECT_DIR"] ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      ""
    );
  }

  /** True if any hook command in the given settings file references our hook. */
  private _settingsReferencesHook(settingsPath: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      return false; // missing file or parse error => not found
    }
    const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
    if (hooks === undefined || hooks === null || typeof hooks !== "object") {
      return false;
    }
    for (const eventKey of Object.keys(hooks)) {
      const entries = (hooks as Record<string, unknown>)[eventKey];
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const entry of entries) {
        const inner = (entry as { hooks?: unknown } | null)?.hooks;
        if (!Array.isArray(inner)) {
          continue;
        }
        for (const h of inner) {
          const cmd = (h as { command?: unknown } | null)?.command;
          if (typeof cmd === "string" && cmd.includes("tycoon-claude-hook.cjs")) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private _handleCheckInstall(): void {
    const root = this._projectRoot();
    const installed =
      root !== "" &&
      (this._settingsReferencesHook(
        path.join(root, ".claude", "settings.local.json")
      ) ||
        this._settingsReferencesHook(
          path.join(root, ".claude", "settings.json")
        ));
    const uefn = root !== "" ? detectUefnProject(root) : { detected: false, signals: [], uefnInstalled: false };
    void this._panel.webview.postMessage({ type: "installState", installed, uefnDetected: uefn.detected, uefnSignals: uefn.signals });
  }

  private _handleInstallHooks(): void {
    void this._panel.webview.postMessage({ type: "installState", busy: true });
    try {
      const root = this._projectRoot();
      if (root === "") {
        throw new Error("No workspace folder open");
      }

      // 1. Ensure .claude/tycoon exists.
      const tycoonDir = path.join(root, ".claude", "tycoon");
      fs.mkdirSync(tycoonDir, { recursive: true });

      // 2. Copy the bundled hook into the project.
      const src = vscode.Uri.joinPath(
        this._extensionUri,
        "hooks",
        "tycoon-claude-hook.cjs"
      ).fsPath;
      const dest = path.join(tycoonDir, "tycoon-claude-hook.cjs");
      fs.copyFileSync(src, dest);

      // 3. Relative hook command (Claude Code runs hooks with cwd = project root).
      const hookCommand = this._buildHookCommand();

      // 4. Read existing settings.local.json (default {} if missing/empty/invalid).
      const settingsPath = path.join(root, ".claude", "settings.local.json");
      let existing: Record<string, unknown> = {};
      try {
        const raw = fs.readFileSync(settingsPath, "utf8").trim();
        if (raw !== "") {
          const parsed = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object") {
            existing = parsed as Record<string, unknown>;
          }
        }
      } catch {
        /* missing/invalid => default {} */
      }

      // 5. Merge our hooks (pure helper).
      const merged = mergeTycoonHooks(existing, hookCommand);

      // 6. Write merged settings.
      fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

      // 7. Success.
      void this._panel.webview.postMessage({ type: "installState", installed: true });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: "installState",
        installed: false,
        error: String(err),
      });
    }
  }

  /** Read the agent-keywords config (tolerant), returning a default on failure. */
  private _readKeywordsConfig(root: string): Record<string, any> {
    const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(keywordsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, any>;
      }
    } catch {
      /* missing/invalid => default */
    }
    return { fallback_agent: "primary-agent", agents: {} };
  }

  /** True if either project settings file references our hook. */
  private _hookInstalled(root: string): boolean {
    return (
      root !== "" &&
      (this._settingsReferencesHook(
        path.join(root, ".claude", "settings.local.json")
      ) ||
        this._settingsReferencesHook(
          path.join(root, ".claude", "settings.json")
        ))
    );
  }

  /** Post the current settings snapshot (hook + per-agent model/keywords). */
  private _handleGetSettings(): void {
    const root = this._projectRoot();
    const agentsDir = path.join(root, ".claude", "agents");

    const keywordsConfig = this._readKeywordsConfig(root);
    const keywordAgents =
      keywordsConfig &&
      typeof keywordsConfig.agents === "object" &&
      keywordsConfig.agents !== null
        ? keywordsConfig.agents
        : {};

    const agents = loadAgentRoster(agentsDir).map((agent) => {
      const entry = keywordAgents[agent.id];
      const keywords =
        entry && typeof entry.pattern === "string" ? entry.pattern : "";
      return {
        id: agent.id,
        name: agent.name,
        model: shortFromModelId(agent.model) ?? null,
        isOrchestrator: agent.id === "orchestrator",
        keywords,
      };
    });

    let lastActivityAt: number | null = null;
    try {
      lastActivityAt = fs.statSync(
        path.join(root, ".claude", "tycoon", "activity.jsonl")
      ).mtimeMs;
    } catch {
      lastActivityAt = null;
    }

    // Build delegationHealth from orchestrator metric
    const state = this._runtime.getState();
    const orchMetric = Array.isArray(state.agentMetrics)
      ? state.agentMetrics.find((m: any) => m.id === "orchestrator")
      : undefined;
    const directSearches: number = orchMetric?.directSearches ?? 0;
    const directReads: number = orchMetric?.directReads ?? 0;
    const directEdits: number = orchMetric?.directEdits ?? 0;
    const delegations: number = orchMetric?.delegations ?? 0;
    const warnThreshold: number =
      vscode.workspace.getConfiguration("tycoonagents").get<number>("delegationWarnThreshold", 5);

    // Run hook diagnostic to compute hookHealth for the settings panel
    const { findings } = this._diagnoseHooks();
    const issueCount = findings.filter((f) => f.severity !== "ok").length;
    const hookHealth = { healthy: issueCount === 0, issueCount };

    // Build context budget (CLAUDE.md + agent .md files)
    let contextBudget;
    try {
      let claudeMdContent: string | null = null;
      try {
        claudeMdContent = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
      } catch {
        claudeMdContent = null;
      }
      const agentEntries: Array<{ name: string; content: string }> = [];
      try {
        const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
        for (const fname of agentFiles) {
          try {
            const content = fs.readFileSync(path.join(agentsDir, fname), "utf8");
            agentEntries.push({ name: fname, content });
          } catch {
            /* skip unreadable */
          }
        }
      } catch {
        /* agentsDir missing => empty */
      }
      contextBudget = buildContextBudget(claudeMdContent, agentEntries);
    } catch {
      contextBudget = buildContextBudget(null, []);
    }

    void this._panel.webview.postMessage({
      type: "settings",
      payload: {
        hook: { installed: this._hookInstalled(root), lastActivityAt },
        agents,
        delegationHealth: { directSearches, directReads, directEdits, delegations, warnThreshold },
        hookHealth,
        contextBudget,
      },
    });
  }

  /** Write the chosen model into an agent's markdown frontmatter. */
  private _handleSetAgentModel(id: string, model: string): void {
    const fullId = modelIdFromShort(model);
    if (fullId === undefined) {
      void this._panel.webview.postMessage({
        type: "settingsUpdated",
        ok: false,
        id,
        field: "model",
        error: "unknown model",
      });
      return;
    }
    try {
      const root = this._projectRoot();
      const filePath = path.join(root, ".claude", "agents", `${id}.md`);
      const content = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, setFrontmatterModel(content, fullId));
      void this._panel.webview.postMessage({
        type: "settingsUpdated",
        ok: true,
        id,
        field: "model",
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: "settingsUpdated",
        ok: false,
        id,
        field: "model",
        error: String(err),
      });
    }
  }

  /**
   * Remove a single agent: delete its `.claude/agents/<id>.md` file and its
   * `agent-keywords.json` routing entry, gated behind a native modal confirm.
   * The orchestrator/coordinator is the core session-model agent and cannot be
   * removed. Refreshes the settings/roster on success so the webview re-renders
   * without the removed agent. Mirrors the agent-removal + confirm pattern in
   * `_handleRemovePack`.
   */
  private async _handleRemoveAgent(id: string): Promise<void> {
    // The orchestrator is the core session-model agent — never removable.
    if (id === "orchestrator") {
      void this._panel.webview.postMessage({
        type: "agentRemoved",
        id,
        ok: false,
        error: "core agent cannot be removed",
      });
      return;
    }
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({
          type: "agentRemoved",
          id,
          ok: false,
          error: "No workspace folder open",
        });
        return;
      }

      // Resolve a friendly display name for the confirmation dialog.
      const agentsDir = path.join(root, ".claude", "agents");
      const rosterEntry = loadAgentRoster(agentsDir).find((a) => a.id === id);
      const displayName = rosterEntry?.name ?? id;

      const answer = await vscode.window.showWarningMessage(
        `Remove the '${displayName}' agent?`,
        {
          modal: true,
          detail: `This deletes .claude/agents/${id}.md and its keyword routing.`,
        },
        "Remove"
      );
      if (answer !== "Remove") {
        void this._panel.webview.postMessage({
          type: "agentRemoved",
          id,
          ok: false,
          cancelled: true,
        });
        return;
      }

      // Delete the agent markdown file (guard existence).
      const agentPath = path.join(agentsDir, `${id}.md`);
      if (fs.existsSync(agentPath)) {
        fs.unlinkSync(agentPath);
      }

      // Remove the agent's routing entry from agent-keywords.json — reuse the
      // exact keyword-removal logic from _handleRemovePack.
      let cfg = this._readKeywordsConfig(root);
      if (cfg && typeof cfg.agents === "object" && cfg.agents !== null && id in cfg.agents) {
        const nextAgents = { ...cfg.agents };
        delete nextAgents[id];
        cfg = { ...cfg, agents: nextAgents };
      }
      const keywordsPath = path.join(root, ".claude", "tycoon", "agent-keywords.json");
      try {
        fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
        fs.writeFileSync(keywordsPath, JSON.stringify(cfg, null, 2));
      } catch {
        /* best-effort: keywords file is non-critical for removal */
      }

      this._panel.webview.postMessage({ type: "agentRemoved", id, ok: true });
      // Refresh the settings/roster the same way setAgentModel-driven changes do.
      this._handleGetSettings();
    } catch (e) {
      void this._panel.webview.postMessage({
        type: "agentRemoved",
        id,
        ok: false,
        error: String(e),
      });
    }
  }

  /** Write the routing pattern for an agent into agent-keywords.json. */
  private _handleSetAgentKeywords(id: string, pattern: string): void {
    try {
      const root = this._projectRoot();
      const keywordsPath = path.join(
        root,
        ".claude",
        "tycoon",
        "agent-keywords.json"
      );
      const config = this._readKeywordsConfig(root);
      const updated = setKeywordPattern(config, id, pattern);
      fs.mkdirSync(path.dirname(keywordsPath), { recursive: true });
      fs.writeFileSync(keywordsPath, JSON.stringify(updated, null, 2));
      void this._panel.webview.postMessage({
        type: "settingsUpdated",
        ok: true,
        id,
        field: "keywords",
      });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: "settingsUpdated",
        ok: false,
        id,
        field: "keywords",
        error: String(err),
      });
    }
  }

  /** Truncate the activity log, reset runtime state, and re-seed the roster. */
  private async _handleResetMetrics(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      "Reset all session metrics? This cannot be undone.",
      { modal: true },
      "Reset"
    );
    if (answer !== "Reset") {
      void this._panel.webview.postMessage({ type: "metricsReset", ok: false, cancelled: true });
      return;
    }
    try {
      const root = this._projectRoot();
      const activityPath = path.join(
        root,
        ".claude",
        "tycoon",
        "activity.jsonl"
      );
      fs.writeFileSync(activityPath, "");

      this._runtime.reset();

      // Re-seed the full installed-agent roster (mirrors extension.ts).
      const agentsDir = path.join(root, ".claude", "agents");
      for (const agent of loadAgentRoster(agentsDir)) {
        const displayName =
          agent.id === "search-retrieval"
            ? agent.name.replace(/ Agent$/, "")
            : agent.name;
        this._runtime.ingest({
          type: "WorkerRegistered",
          at: Date.now(),
          workerId: agent.id,
          name: displayName,
          ...(agent.model !== undefined ? { model: agent.model } : {}),
          ...(agent.description !== undefined
            ? { description: agent.description }
            : {}),
        });
      }

      void this._panel.webview.postMessage({ type: "metricsReset", ok: true });
    } catch (err) {
      void this._panel.webview.postMessage({
        type: "metricsReset",
        ok: false,
        error: String(err),
      });
    }
  }

  private _buildHookCommand(): string {
    return `node ".claude/tycoon/tycoon-claude-hook.cjs"`;
  }

  private _readSettingsTolerant(settingsPath: string): any | null {
    try {
      const raw = fs.readFileSync(settingsPath, "utf8").trim();
      if (raw !== "") {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === "object") {
          return parsed;
        }
      }
    } catch {
      /* missing/invalid => null */
    }
    return null;
  }

  private _diagnoseHooks(): { findings: DoctorFinding[]; foreign: string[] } {
    const root = this._projectRoot();
    if (root === "") {
      return { findings: [], foreign: [] };
    }
    const localSettings = this._readSettingsTolerant(path.join(root, ".claude", "settings.local.json"));
    const sharedSettings = this._readSettingsTolerant(path.join(root, ".claude", "settings.json"));
    const currentHookCommand = this._buildHookCommand();
    const hookScriptPath = path.join(root, ".claude", "tycoon", "tycoon-claude-hook.cjs");
    const hookScriptExists = fs.existsSync(hookScriptPath);
    const findings = diagnose({ localSettings, sharedSettings, currentHookCommand, hookScriptExists });
    const foreign = findForeignHooks(localSettings, sharedSettings);
    return { findings, foreign };
  }

  private _handleRunDoctor(): void {
    const root = this._projectRoot();
    if (root === "") {
      void this._panel.webview.postMessage({ type: "doctorReport", findings: [], foreign: [], error: "No workspace folder open" });
      return;
    }
    const { findings, foreign } = this._diagnoseHooks();
    void this._panel.webview.postMessage({ type: "doctorReport", findings, foreign });
  }

  private async _handleApplyDoctorFix(removeForeign: boolean): Promise<void> {
    try {
      const root = this._projectRoot();
      if (root === "") {
        void this._panel.webview.postMessage({ type: "doctorFixDone", ok: false, error: "No workspace folder open" });
        return;
      }
      const currentHookCommand = this._buildHookCommand();
      const localSettings = this._readSettingsTolerant(path.join(root, ".claude", "settings.local.json"));
      const sharedSettings = this._readSettingsTolerant(path.join(root, ".claude", "settings.json"));
      const foreignCommands = findForeignHooks(localSettings, sharedSettings);
      if (removeForeign) {
        const answer = await vscode.window.showWarningMessage(
          "The following hook commands will be permanently removed:\n\n" + foreignCommands.join("\n"),
          { modal: true },
          "Remove"
        );
        if (answer !== "Remove") {
          return;
        }
      }
      const { settings, changes } = repairSettings(localSettings, currentHookCommand, { removeForeign, foreignCommands: removeForeign ? foreignCommands : undefined });
      fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify(settings, null, 2));
      const hookScriptExists = fs.existsSync(path.join(root, ".claude", "tycoon", "tycoon-claude-hook.cjs"));
      const findings = diagnose({ localSettings: settings, sharedSettings, currentHookCommand, hookScriptExists });
      const foreign = findForeignHooks(settings, sharedSettings);
      void this._panel.webview.postMessage({ type: "doctorFixDone", ok: true, changes, findings, foreign });
    } catch (err) {
      void this._panel.webview.postMessage({ type: "doctorFixDone", ok: false, error: String(err) });
    }
  }

  /**
   * Compute status chips for connected engine bridges (e.g. UEFN).
   * Returns [] if no engines are configured, so the webview shows nothing.
   * Designed to be extended: add more engine descriptors to the returned array.
   */
  private _computeEngineStatus(): Array<{ id: string; label: string; state: "connected" | "offline" | "ready" | "setup"; detail: string }> {
    const root = this._projectRoot();
    if (root === "") {
      return [];
    }
    const mcpPath = path.join(root, ".mcp.json");
    let mcpConfig: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        mcpConfig = parsed as Record<string, unknown>;
      }
    } catch {
      return detectEngineSetups(root);
    }

    const servers = (mcpConfig["mcpServers"] ?? mcpConfig) as Record<string, unknown>;
    const bridgeEntry = servers["uefn-bridge"] as Record<string, unknown> | undefined;
    if (!bridgeEntry) {
      return detectEngineSetups(root);
    }

    // Resolve the bridge directory from env config or default temp location.
    let bridgeDir: string;
    try {
      const envBlock = bridgeEntry["env"] as Record<string, unknown> | undefined;
      const configured = envBlock?.["UEFN_BRIDGE_DIR"];
      bridgeDir =
        typeof configured === "string" && configured !== ""
          ? configured
          : path.join(os.tmpdir(), "uefn_bridge");
    } catch {
      bridgeDir = path.join(os.tmpdir(), "uefn_bridge");
    }

    let chipState: "connected" | "offline" = "offline";
    let detail =
      "UEFN bridge installed but not responding â€” open your UEFN project and start the Python bridge (Content/Python).";
    try {
      const heartbeatPath = path.join(bridgeDir, "heartbeat.json");
      const stat = fs.statSync(heartbeatPath);
      if (Date.now() - stat.mtimeMs < 15000) {
        chipState = "connected";
        detail = "UEFN bridge connected â€” agents can use the uefn_* MCP tools.";
      }
    } catch {
      /* file missing or unreadable => offline */
    }

    return [{ id: "uefn", label: "UEFN", state: chipState, detail }, ...detectEngineSetups(root)];
  }

  /** Poll engine status and push a `engineStatus` message to the webview. */
  private _pollEngineStatus(): void {
    const chips = this._computeEngineStatus();
    void this._panel.webview.postMessage({ type: "engineStatus", chips });
  }

  public dispose(): void {
    TycoonPanel.currentPanel = undefined;
    this._themeGenerationAbortController?.abort();
    this._themeGenerationAbortController = undefined;
    if (this._enginePollInterval !== undefined) {
      clearInterval(this._enginePollInterval);
      this._enginePollInterval = undefined;
    }
    this._runtimeDisposable?.dispose();
    this._panel.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }

  private _update(): void {
    const webview = this._panel.webview;
    this._panel.title = "TycoonAgents";
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    let version = "";
    try {
      const pkgRaw = fs.readFileSync(
        path.join(this._extensionUri.fsPath, "package.json"),
        "utf8"
      );
      version = JSON.parse(pkgRaw).version || "";
    } catch {
      /* version stays empty if package.json can't be read */
    }

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "style.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
    );

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" nonce="${nonce}" />
  <title>TycoonAgents</title>
</head>
<body>
  <!-- Canvas kept in DOM so existing render loop does not crash; hidden via CSS -->
  <canvas id="stage"></canvas>

  <!-- App shell: stage on top, resize handle, metrics panel on bottom -->
  <div id="app">

    <!-- Stage area: placeholder for future characters / background -->
    <div id="stage-area">
      <!-- Hamburger menu: scaffold for future panel controls -->
      <button id="menu-btn" aria-label="Open menu" aria-expanded="false" aria-haspopup="true">&#9776;</button>
      <div id="menu-popover" role="menu" hidden>
        <button class="menu-item" role="menuitem" id="menu-catalog">Skills / MCP / Packs</button>
        <button class="menu-item" role="menuitem" id="menu-settings">Settings</button>
        <button class="menu-item" role="menuitem" id="menu-themes">Themes</button>
        <button class="menu-item" role="menuitem" id="menu-about">About</button>
        ${version ? `<div class="menu-version" role="presentation">v${version}</div>` : ""}
      </div>
    </div>

    <!-- Resize handle: drag to split stage vs metrics panel -->
    <div id="resize-handle" role="separator" aria-label="Drag to resize panels">
      <span class="resize-grip"></span>
    </div>

    <!-- Metrics panel -->
    <div id="metrics-panel">
      <div id="metrics-header">
        <span class="header-dot"></span>
        <span class="header-title">Tycoon Agents &mdash; Agent Metrics</span>
      </div>
      <div id="metrics-body">
        <div id="metrics-empty">No agents yet &mdash; start a session to see activity.</div>
        <table id="metrics-table" style="display:none">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Tokens/min</th>
              <th class="col-tasks">Tasks</th>
              <th class="col-mcp">MCP</th>
              <th class="col-time">Time</th>
              <th class="col-tokens">Tokens</th>
            </tr>
          </thead>
          <tbody id="metrics-tbody"></tbody>
        </table>
      </div>
    </div>

  </div><!-- /#app -->

  <!-- Setup / onboarding overlay (styled + toggled by media/main.js) -->
  <div id="setup-view">
    <div id="setup-card">
      <h1>TycoonAgents</h1>
      <p id="setup-status">Checking installation&hellip;</p>
      <button id="install-hooks-btn" hidden>Install hooks</button>
      <p id="setup-error" hidden></p>
      <div id="setup-config" hidden><!-- Phase 2: agent model settings --></div>
      <button id="setup-back-btn" hidden>Back</button>
    </div>
  </div>

  <!-- Skills modal overlay -->
  <div id="skills-modal" role="dialog" aria-modal="true" aria-label="Catalog" hidden>
    <div id="skills-backdrop"></div>
    <div id="skills-dialog">
      <button id="skills-modal-close" aria-label="Close dialog">&times;</button>
      <div class="catalog-tabs" role="tablist">
        <button id="tab-packs" class="catalog-tab" role="tab" aria-selected="false">Packs</button>
        <button id="tab-skills" class="catalog-tab catalog-tab--active" role="tab" aria-selected="true">Skills</button>
        <button id="tab-mcp" class="catalog-tab" role="tab" aria-selected="false">MCP servers</button>
      </div>
      <div id="packs-list" role="tabpanel" hidden></div>
      <div id="skills-list" role="tabpanel"></div>
      <div id="mcp-list" role="tabpanel" hidden></div>
    </div>
  </div>

  <!-- About modal overlay -->
  <div id="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title" hidden>
    <div id="about-backdrop"></div>
    <div id="about-dialog">
      <button id="modal-close" aria-label="Close dialog">&times;</button>
      <h2 id="about-modal-title">TycoonAgents</h2>
      <p>Created by Scott McClellan</p>
      <p>
        <a href="https://x.com/thetrashbyrd" target="_blank" rel="noopener noreferrer">@thetrashbyrd</a>
      </p>
      <p>
        <a href="https://github.com/Corsair-Studios/TycoonAgents" target="_blank" rel="noopener noreferrer">GitHub repository</a>
      </p>
    </div>
  </div>

  <!-- Themes modal overlay -->
  <div id="themes-modal" role="dialog" aria-modal="true" aria-label="Themes" hidden>
    <div id="themes-backdrop"></div>
    <div id="themes-dialog">
      <button id="themes-modal-close" aria-label="Close dialog">&times;</button>
      <div id="theme-picker-list" role="tabpanel">
        <h2 style="margin: 0 0 16px;">Themes</h2>
        <div id="theme-picker-grid" style="display: flex; flex-direction: column; gap: 8px;"></div>
        <div id="theme-picker-status" class="theme-picker-status" role="status" aria-live="polite"></div>
        <div class="theme-picker-actions">
          <button id="theme-import-btn" class="skill-btn">Import .zip</button>
          <button id="tab-theme-builder" class="skill-btn theme-builder-launch">Theme Builder</button>
        </div>
      </div>
      <div id="theme-builder-panel" role="tabpanel" hidden>
        <button id="tab-theme-picker" class="skill-btn" style="margin-bottom: 16px;">&larr; Back to themes</button>
        <div id="theme-image-settings" class="theme-image-settings">
          <div class="theme-image-settings-row">
            <label for="theme-image-provider">Image provider</label>
            <select id="theme-image-provider">
              <option value="openai">OpenAI (GPT Image 2)</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>
          <div class="theme-image-settings-row theme-api-key-row">
            <label for="theme-api-key-input" id="theme-api-key-label">Google Gemini API key</label>
            <input
              type="password"
              id="theme-api-key-input"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste a key to save securely"
            />
            <button id="theme-api-key-save" class="skill-btn">Save</button>
          </div>
          <div id="theme-api-key-status" class="theme-api-key-status" role="status"></div>
        </div>
        <label class="theme-generation-approval-toggle theme-generation-approval-toggle--top" for="theme-pause-for-review">
          <input id="theme-pause-for-review" type="checkbox" checked />
          <span>
            Pause after each image for approval
            <small>Change this any time. Turning it off resumes a paused generation.</small>
          </span>
        </label>
        <p class="theme-generation-approval-warning" style="margin: 6px 0 0; padding: 8px 10px; border-left: 3px solid #d9a441; background: rgba(217, 164, 65, 0.12); border-radius: 4px; font-size: 12px; line-height: 1.4;">
          &#9888; AI image generation isn't perfect &mdash; expect to regenerate some images and do a little manual cleanup (use Retry, Upload, or edit the prompt).
        </p>
        <div id="theme-prompt-container" class="theme-prompt-container">
          <input type="text" id="theme-prompt-input" placeholder="Name or describe a new theme" />
          <button id="theme-generate-btn" class="skill-btn">Plan theme</button>
        </div>
        <section id="theme-plan-editor" class="theme-plan-editor" hidden>
          <div class="theme-plan-header">
            <div>
              <h3>Review the theme plan</h3>
              <p>AI filled every slot. Edit anything you want before image generation begins.</p>
            </div>
            <span class="theme-plan-count">25 reviewable images</span>
          </div>
          <label class="theme-plan-field theme-plan-field--primary">
            <span>Theme name</span>
            <input id="theme-plan-name" type="text" />
          </label>
          <label class="theme-plan-field">
            <span>Creative direction</span>
            <textarea id="theme-plan-direction" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Characters <span>16 individual sprite boards</span></legend>
            <div id="theme-plan-characters" class="theme-plan-slot-grid theme-plan-slot-grid--characters"></div>
          </fieldset>
          <label class="theme-plan-field">
            <span>Environment <small>1 image</small></span>
            <textarea id="theme-plan-environment" rows="3"></textarea>
          </label>
          <fieldset class="theme-plan-group">
            <legend>Enemies <span>3 individual sprite boards</span></legend>
            <div id="theme-plan-enemies" class="theme-plan-slot-grid"></div>
          </fieldset>
          <label class="theme-plan-field">
            <span>Objects <small>13 animated objects, comma separated · 3 sprite sheets</small></span>
            <textarea id="theme-plan-objects" rows="3"></textarea>
          </label>
          <label class="theme-plan-field">
            <span>Expressions <small>16 expressions, comma separated · 1 sprite sheet</small></span>
            <textarea id="theme-plan-expressions" rows="3"></textarea>
          </label>
          <label class="theme-plan-field">
            <span>Achievement badges <small>20 designs, comma separated · 1 sprite sheet</small></span>
            <textarea id="theme-plan-achievements" rows="3"></textarea>
          </label>
          <div class="theme-plan-footer">
            <div id="theme-plan-validation" class="theme-plan-validation" role="status"></div>
            <button id="theme-start-generation-btn" class="skill-btn">Generate images</button>
          </div>
        </section>
        <div id="theme-build-status" style="margin-bottom: 12px; font-style: italic; min-height: 20px; color: var(--vscode-descriptionForeground);"></div>
        <div id="theme-build-actions" hidden style="margin-bottom: 12px;">
          <button id="theme-review-images-btn" class="skill-btn">Review generated images</button>
        </div>
        <section id="theme-image-review" class="theme-image-review" hidden>
          <div class="theme-image-review-header">
            <div>
              <h3 id="theme-image-review-title">Generated images</h3>
              <div id="theme-image-review-summary" class="theme-image-review-summary"></div>
            </div>
            <div class="theme-image-review-header-actions">
              <button id="theme-review-resume-generation" class="skill-btn" hidden>Resume generation</button>
              <button id="theme-review-stop-generation" class="skill-btn" hidden>Stop generation</button>
              <button id="theme-approve-all" class="skill-btn">Approve all</button>
              <button id="theme-open-images-folder" class="skill-btn">Open folder</button>
            </div>
          </div>
          <div id="theme-image-review-list" class="theme-image-review-list"></div>
        </section>
        <div id="theme-builder-root"></div>
      </div>
    </div>
  </div>

  <div id="theme-image-lightbox" role="dialog" aria-modal="true" aria-labelledby="theme-image-lightbox-title" hidden>
    <div id="theme-image-lightbox-backdrop"></div>
    <div id="theme-image-lightbox-dialog">
      <div class="theme-image-lightbox-header">
        <h3 id="theme-image-lightbox-title">Full-size image</h3>
        <button id="theme-image-lightbox-close" aria-label="Close full-size image">&times;</button>
      </div>
      <div class="theme-image-lightbox-viewport">
        <img id="theme-image-lightbox-image" alt="" />
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'theme-builder.js'))}"></script>
</body>
</html>`;
  }
}
