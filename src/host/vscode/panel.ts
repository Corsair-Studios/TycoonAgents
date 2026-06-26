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
import { mergeMcpServer, hasMcpServer } from "./mcpCatalog";
import { buildAgentMarkdown } from "./packCatalog";
import { detectUefnProject } from "./uefnDetect";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
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
  private _disposables: vscode.Disposable[] = [];
  private _runtimeDisposable: { dispose(): void } | undefined;
  private _enginePollInterval: NodeJS.Timeout | undefined;

  public static createOrShow(extensionUri: vscode.Uri, runtime: Runtime): TycoonPanel {
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
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );

    TycoonPanel.currentPanel = new TycoonPanel(panel, extensionUri, runtime);
    return TycoonPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    runtime: Runtime
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._runtime = runtime;

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
        } else if (message.type === "getSkills") {
          this._handleGetSkills();
        } else if (message.type === "installSkill") {
          if (message.id !== undefined) {
            this._handleInstallSkill(message.id);
          }
        } else if (message.type === "getMcp") {
          this._handleGetMcp();
        } else if (message.type === "installMcp") {
          if (message.id !== undefined) {
            await this._handleInstallMcp(message.id, message.thirdParty === true);
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
        } else if (message.type === "copyNudge") {
          const text = String((message as any).text ?? "");
          if (text !== "") {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage("Delegation tip copied to clipboard.");
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
        }
      },
      null,
      this._disposables
    );

    // Clean up on panel dispose
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
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

      // Stage the Python bridge.
      const bridgeSrc = path.join(this._extensionUri.fsPath, "media", "uefn-bridge", "uefn_bridge.py");
      const bridgeDest = path.join(root, "Content", "Python", "uefn_bridge.py");
      let bridgeStatus: "staged" | "exists";
      if (fs.existsSync(bridgeDest)) {
        bridgeStatus = "exists";
      } else {
        fs.mkdirSync(path.dirname(bridgeDest), { recursive: true });
        fs.copyFileSync(bridgeSrc, bridgeDest);
        bridgeStatus = "staged";
      }

      void this._panel.webview.postMessage({
        type: "uefnSetupDone",
        ok: true,
        results: { pack: "uefn", bridge: bridgeStatus },
      });
    } catch (e) {
      void this._panel.webview.postMessage({ type: "uefnSetupDone", ok: false, error: String(e) });
    }
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

    void this._panel.webview.postMessage({
      type: "settings",
      payload: {
        hook: { installed: this._hookInstalled(root), lastActivityAt },
        agents,
        delegationHealth: { directSearches, directReads, directEdits, delegations, warnThreshold },
        hookHealth,
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
  private _computeEngineStatus(): Array<{ id: string; label: string; state: "connected" | "offline"; detail: string }> {
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
      return [];
    }

    const servers = (mcpConfig["mcpServers"] ?? mcpConfig) as Record<string, unknown>;
    const bridgeEntry = servers["uefn-bridge"] as Record<string, unknown> | undefined;
    if (!bridgeEntry) {
      return [];
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

    return [{ id: "uefn", label: "UEFN", state: chipState, detail }];
  }

  /** Poll engine status and push a `engineStatus` message to the webview. */
  private _pollEngineStatus(): void {
    const chips = this._computeEngineStatus();
    void this._panel.webview.postMessage({ type: "engineStatus", chips });
  }

  public dispose(): void {
    TycoonPanel.currentPanel = undefined;
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
        <button class="menu-item" role="menuitem" id="menu-theme-builder">Theme builder</button>
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

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
