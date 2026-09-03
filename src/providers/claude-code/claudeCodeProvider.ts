/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import type { Provider } from "../../core/provider";
import type { EventSink } from "../../core/events";
import type { HookRecord } from "./hookRecord";
import { mapHookRecord } from "./mapHookRecord";
import { ActivityFileTailer } from "../shared/activityTail";

export interface ClaudeCodeProviderOptions {
  /** Path to the JSONL activity file the hook script appends to. */
  activityFile: string;
  /** Poll interval in ms (default 250). */
  pollIntervalMs?: number;
}

/** Tails the activity JSONL file and emits normalized events. Host-agnostic. */
export class ClaudeCodeProvider implements Provider {
  public readonly id = "claude-code";
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tailer: ActivityFileTailer;

  constructor(private readonly options: ClaudeCodeProviderOptions) {
    this.tailer = new ActivityFileTailer({ filePath: options.activityFile });
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

  /** Current byte offset into the tailed activity file. Exposed for tests. */
  private get offset(): number {
    return this.tailer.offset;
  }

  private async drain(emit: EventSink): Promise<void> {
    await this.tailer.drain((line) => {
      let record: HookRecord;
      try {
        record = JSON.parse(line) as HookRecord;
      } catch {
        return;
      }
      for (const event of mapHookRecord(record)) emit(event);
    });
  }
}
