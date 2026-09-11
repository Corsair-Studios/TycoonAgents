/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Entry point for the opencode provider (plan p5-t3). Importing this module
// registers the OpenCode record->NormalizedEvent[] mapper into
// src/core's mappingRegistry, the same way ../claude-code/index.ts registers
// its own — any host that wants opencode events flowing must import from
// here before the first record arrives.

import type { Provider } from "../../core/provider";
import type { EventSink } from "../../core/events";
import { registerMapper, tryMapRecord, DEFAULT_PROVIDER_ID } from "../../core/mappingRegistry";
import { mapOpenCodeRecord } from "./mapOpenCodeRecord";
import { ActivityFileTailer } from "../shared/activityTail";
import { isProjectPluginInstalled } from "./discovery";

registerMapper("opencode", mapOpenCodeRecord);

export { mapOpenCodeRecord } from "./mapOpenCodeRecord";
export { resolveOpenCode, isProjectPluginInstalled } from "./discovery";
export type { ResolveOpenCodeOptions, ResolveOpenCodeResult } from "./discovery";

export interface OpenCodeProviderOptions {
  /**
   * Path to the JSONL activity file the OpenCode plugin appends to. Same
   * file format (and, in a mixed setup, potentially the same physical file)
   * as ClaudeCodeProvider's activityFile — see
   * hooks/tycoon-opencode-plugin.ts's header comment.
   */
  activityFile: string;
  /** Poll interval in ms (default 250, matches ClaudeCodeProvider). */
  pollIntervalMs?: number;
  /**
   * Project directory to check for .opencode/plugin/tycoon-opencode-plugin
   * when warning about a missing plugin install. Defaults to
   * process.cwd().
   */
  projectDir?: string;
  /** Injectable for tests; defaults to console.warn. */
  log?: (message: string) => void;
}

/**
 * Tails the same activity.jsonl the ClaudeCodeProvider tails and emits
 * normalized events for any line carrying provider:"opencode" (via the
 * registered opencode mapper) as well as any claude-code-shaped line that
 * happens to share the file, by dispatching every parsed record through
 * mappingRegistry.tryMapRecord (which reads the record's own `provider`
 * field) rather than assuming a single mapper for the whole file.
 */
export class OpenCodeProvider implements Provider {
  public readonly id = "opencode";
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tailer: ActivityFileTailer;
  private readonly log: (message: string) => void;
  private readonly options: OpenCodeProviderOptions;

  constructor(optionsOrActivityFile: OpenCodeProviderOptions | string) {
    // Accepts a bare activityFile string too, for callers (e.g.
    // src/host/vscode/providerFactory.ts, out of scope for this change)
    // still using the pre-p5-t3 stub's single-string constructor shape.
    const options: OpenCodeProviderOptions =
      typeof optionsOrActivityFile === "string" ? { activityFile: optionsOrActivityFile } : optionsOrActivityFile;
    this.options = options;
    this.tailer = new ActivityFileTailer({ filePath: options.activityFile });
    this.log = options.log ?? ((message: string) => console.warn(message));
  }

  public start(emit: EventSink): void {
    const projectDir = this.options.projectDir ?? process.cwd();
    if (!isProjectPluginInstalled(projectDir)) {
      this.log(
        "[tycoon] opencode provider selected, but .opencode/plugin/tycoon-opencode-plugin " +
          "was not found in " +
          projectDir +
          " — OpenCode activity will not be captured until the plugin is installed.",
      );
    }
    const interval = this.options.pollIntervalMs ?? 250;
    this.timer = setInterval(() => {
      void this.drain(emit);
    }, interval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async drain(emit: EventSink): Promise<void> {
    await this.tailer.drain((line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      // Two providers can tail the same physical activity.jsonl (see the
      // options.activityFile doc comment above). Without this check, every
      // line — including ones written by a DIFFERENT provider's hook — got
      // dispatched through tryMapRecord and re-emitted here too, so a
      // concurrent claude-code+opencode (or opencode+codex) run double
      // counted every record. Only handle lines whose own `provider` field
      // (defaulting to DEFAULT_PROVIDER_ID when absent, matching
      // mappingRegistry's resolution) names this provider.
      const recordProviderId =
        record && typeof record === "object" && typeof (record as { provider?: unknown }).provider === "string"
          ? (record as { provider: string }).provider
          : DEFAULT_PROVIDER_ID;
      if (recordProviderId !== this.id) return;
      const events = tryMapRecord(record);
      if (!events) return;
      for (const event of events) emit(event);
    });
  }
}
