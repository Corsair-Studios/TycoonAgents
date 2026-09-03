/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */

import * as fs from "fs/promises";

// Cap a single drain tick's read so a huge backlog can't allocate one giant
// buffer; any leftover bytes are picked up on subsequent ticks.
const MAX_READ_BYTES = 4 * 1024 * 1024; // 4MB

export interface ActivityFileTailerOptions {
  /** Path to the JSONL activity file to tail. */
  filePath: string;
  /** Override the per-tick read cap (bytes). Defaults to 4MB. */
  maxReadBytes?: number;
}

/**
 * Shared byte-offset JSONL tailer, extracted from ClaudeCodeProvider so
 * other providers (e.g. opencode) can tail the same activity.jsonl format
 * without duplicating the offset/newline-boundary/truncation logic.
 * Behavior is unchanged from the original ClaudeCodeProvider.drain: only
 * complete (newline-terminated) lines are consumed, a shrunk file resets
 * the offset to 0, and transient FS errors are swallowed so polling
 * continues on the next tick.
 */
export class ActivityFileTailer {
  private _offset = 0;
  // Guards against overlapping ticks: the poll interval fires on a fixed
  // cadence regardless of how long the previous tick's async fs work takes,
  // so a slow disk (or a huge backlog spanning many ticks) could otherwise
  // start a second drain() while the first is still awaiting I/O. Both
  // would race on `this._offset`. Skip a tick outright if one is in flight;
  // the next timer fire will pick up where the in-flight one left off.
  private draining = false;
  private readonly maxReadBytes: number;

  constructor(private readonly options: ActivityFileTailerOptions) {
    this.maxReadBytes = options.maxReadBytes ?? MAX_READ_BYTES;
  }

  /**
   * Read whatever complete new lines are available and invoke onLine for
   * each (trimmed, non-empty). Skips the tick if a previous drain is still
   * in flight, and swallows transient FS errors.
   */
  /** Current byte offset into the tailed file. Exposed for tests. */
  public get offset(): number {
    return this._offset;
  }

  public async drain(onLine: (line: string) => void): Promise<void> {
    if (this.draining) return; // previous tick's async work is still in flight
    this.draining = true;
    try {
      let stat;
      try {
        stat = await fs.stat(this.options.filePath);
      } catch {
        return; // file doesn't exist (yet)
      }
      const size = stat.size;
      if (size < this._offset) this._offset = 0; // file truncated/rotated
      if (size <= this._offset) return;
      const length = Math.min(size - this._offset, this.maxReadBytes);
      const handle = await fs.open(this.options.filePath, "r");
      let buffer: Buffer;
      try {
        buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this._offset);
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
      this._offset += lastNewline + 1;

      for (const line of complete.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onLine(trimmed);
      }
    } catch {
      // ignore transient FS errors; keep polling
    } finally {
      this.draining = false;
    }
  }
}
