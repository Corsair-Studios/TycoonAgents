/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs/promises";
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

// Cap a single drain tick's read so a huge backlog can't allocate one giant
// buffer; any leftover bytes are picked up on subsequent ticks.
const MAX_READ_BYTES = 4 * 1024 * 1024; // 4MB

/** Tails the activity JSONL file and emits normalized events. Host-agnostic. */
export class ClaudeCodeProvider implements Provider {
  public readonly id = "claude-code";
  private timer: ReturnType<typeof setInterval> | undefined;
  private offset = 0;
  // Guards against overlapping ticks: the poll interval fires on a fixed
  // cadence regardless of how long the previous tick's async fs work takes,
  // so a slow disk (or a huge backlog spanning many ticks) could otherwise
  // start a second drain() while the first is still awaiting I/O. Both
  // would race on `this.offset`. Skip a tick outright if one is in flight;
  // the next timer fire will pick up where the in-flight one left off.
  private draining = false;

  constructor(private readonly options: ClaudeCodeProviderOptions) {}

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
    if (this.draining) return; // previous tick's async work is still in flight
    this.draining = true;
    try {
      let stat;
      try {
        stat = await fs.stat(this.options.activityFile);
      } catch {
        return; // file doesn't exist (yet)
      }
      const size = stat.size;
      if (size < this.offset) this.offset = 0; // file truncated/rotated
      if (size <= this.offset) return;
      const length = Math.min(size - this.offset, MAX_READ_BYTES);
      const handle = await fs.open(this.options.activityFile, "r");
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
      } finally {
        await handle.close();
      }

      // Only advance past the last confirmed newline; a trailing partial
      // line (writer flushed mid-record, or we hit the read cap) is left
      // unconsumed so the next tick re-reads and completes it. Search the
      // raw buffer for 0x0A before decoding so offsets stay byte-accurate
      // across multi-byte UTF-8 sequences.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline === -1) return; // no complete line yet this tick

      const complete = buffer.subarray(0, lastNewline);
      this.offset += lastNewline + 1;

      for (const line of complete.toString("utf8").split("\n")) {
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
    } finally {
      this.draining = false;
    }
  }
}
