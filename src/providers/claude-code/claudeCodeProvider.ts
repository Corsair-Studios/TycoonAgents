/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/TODO/TycoonAgents/releases   (TBD - repo not yet created)
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs";
import type { Provider } from "../../core/provider";
import type { EventSink } from "../../core/events";
import type { HookRecord } from "./hookRecord";
import { mapHookRecord } from "./mapHookRecord";

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
  private offset = 0;

  constructor(private readonly options: ClaudeCodeProviderOptions) {}

  public start(emit: EventSink): void {
    const interval = this.options.pollIntervalMs ?? 250;
    this.timer = setInterval(() => this.drain(emit), interval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private drain(emit: EventSink): void {
    try {
      if (!fs.existsSync(this.options.activityFile)) return;
      const size = fs.statSync(this.options.activityFile).size;
      if (size < this.offset) this.offset = 0; // file truncated/rotated
      if (size <= this.offset) return;
      const fd = fs.openSync(this.options.activityFile, "r");
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.offset);
      fs.closeSync(fd);
      this.offset = size;
      for (const line of buffer.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let record: HookRecord;
        try {
          record = JSON.parse(trimmed) as HookRecord;
        } catch {
          continue;
        }
        for (const event of mapHookRecord(record)) emit(event);
      }
    } catch {
      // ignore transient FS errors; keep polling
    }
  }
}
