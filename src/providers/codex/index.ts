/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

// Entry point for the codex provider (plan p22-t3). Importing this module
// registers the codex record->NormalizedEvent[] mapper into
// src/core's mappingRegistry, mirroring src/providers/opencode/index.ts.

import type { Provider } from "../../core/provider";
import type { EventSink } from "../../core/events";
import { registerMapper, tryMapRecord, DEFAULT_PROVIDER_ID } from "../../core/mappingRegistry";
import { mapCodexRecord } from "./mapCodexRecord";
import { ActivityFileTailer } from "../shared/activityTail";

registerMapper("codex", mapCodexRecord);

export { mapCodexRecord } from "./mapCodexRecord";

export interface CodexProviderOptions {
  /**
   * Path to the JSONL activity file hooks/tycoon-codex-hook.cjs appends to.
   * Same file (and format) tailed by ClaudeCodeProvider/OpenCodeProvider —
   * a project can have more than one provider's hook writing to the same
   * activity.jsonl, disambiguated at read time by each record's own
   * `provider` field.
   */
  activityFile: string;
  /** Poll interval in ms (default 250, matches the other providers). */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to console.warn. */
  log?: (message: string) => void;
}

/**
 * Tails activity.jsonl and emits normalized events for any line carrying
 * provider:"codex" (or any other provider whose mapper is registered — see
 * OpenCodeProvider's identical drain-via-tryMapRecord rationale) rather
 * than assuming every line in the file came from codex.
 */
export class CodexProvider implements Provider {
  public readonly id = "codex";
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tailer: ActivityFileTailer;
  private readonly log: (message: string) => void;
  private readonly options: CodexProviderOptions;

  constructor(optionsOrActivityFile: CodexProviderOptions | string) {
    const options: CodexProviderOptions =
      typeof optionsOrActivityFile === "string" ? { activityFile: optionsOrActivityFile } : optionsOrActivityFile;
    this.options = options;
    this.tailer = new ActivityFileTailer({ filePath: options.activityFile });
    this.log = options.log ?? ((message: string) => console.warn(message));
  }

  public start(emit: EventSink): void {
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
      // Mirrors OpenCodeProvider.drain's provider-tag filter: multiple
      // providers can tail the same physical activity.jsonl, so a line
      // whose own `provider` field (default DEFAULT_PROVIDER_ID, matching
      // mappingRegistry's resolution) doesn't name this provider must be
      // skipped, or a concurrent run double-emits every shared record.
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
