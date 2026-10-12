/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 */
import * as fs from "fs";
import * as path from "path";


// Minimal line scanner for Codex's config.toml, shared by the hook and
// dispatcher installers. It is not a TOML parser: it only tracks what the
// installers need to edit the file without eating foreign content, namely
// multi-line strings ("""/'''), the bracket depth of an open value (arrays and
// inline tables) and which lines are real table headers.

export interface TomlTableHeader {
  /** Dotted name with whitespace and quotes around keys removed, e.g. `mcp_servers.tycoon`. */
  name: string;
  /** True for `[[array.of.tables]]`. */
  array: boolean;
}

export interface TomlLine {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the line content (before any `\r\n`). */
  end: number;
  /** Offset of the next line (just past the line ending). */
  next: number;
  /** True when the line continues a multi-line string, array or inline table. */
  cont: boolean;
  /** Present when the line is a real table header. */
  header?: TomlTableHeader;
}

/** The file's line ending: CRLF when it uses it anywhere, else LF. */
export function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Parse a table header from a line's content (`[a.b]`, `[[a.b]]`, with
 * optional whitespace, quoted keys and a trailing comment). Undefined if the
 * line is not a header.
 */
export function parseTableHeader(content: string): TomlTableHeader | undefined {
  let i = 0;
  const skipWs = (): void => {
    while (i < content.length && (content[i] === " " || content[i] === "\t")) i++;
  };
  skipWs();
  if (content[i] !== "[") return undefined;
  i++;
  const array = content[i] === "[";
  if (array) i++;
  const parts: string[] = [];
  for (;;) {
    skipWs();
    const ch = content[i];
    if (ch === '"' || ch === "'") {
      const close = content.indexOf(ch, i + 1);
      if (close === -1) return undefined;
      parts.push(content.slice(i + 1, close));
      i = close + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(content.slice(i));
      if (!m) return undefined;
      parts.push(m[0]);
      i += m[0].length;
    }
    skipWs();
    if (content[i] === ".") {
      i++;
      continue;
    }
    if (content[i] !== "]") return undefined;
    i++;
    if (array) {
      if (content[i] !== "]") return undefined;
      i++;
    }
    break;
  }
  skipWs();
  if (i < content.length && content[i] !== "#") return undefined;
  return { name: parts.join("."), array };
}

/** Walk `text` line by line, tracking multi-line strings and open arrays/inline tables. */
export function scanTomlLines(text: string): TomlLine[] {
  const lines: TomlLine[] = [];
  let mlDelim: string | undefined;
  let depth = 0;
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const next = nl === -1 ? text.length : nl + 1;
    let end = nl === -1 ? text.length : nl;
    if (end > pos && text[end - 1] === "\r") end--;
    const content = text.slice(pos, end);
    const cont = mlDelim !== undefined || depth > 0;
    const line: TomlLine = { start: pos, end, next, cont };
    if (!cont) {
      const header = parseTableHeader(content);
      if (header) {
        line.header = header;
        lines.push(line);
        pos = next;
        continue;
      }
    }
    let j = 0;
    while (j < content.length) {
      if (mlDelim !== undefined) {
        const close = content.indexOf(mlDelim, j);
        if (close === -1) {
          j = content.length;
        } else if (mlDelim === '"""') {
          // Count preceding backslashes so an escaped quote does not close the string.
          let b = 0;
          while (close - 1 - b >= 0 && content[close - 1 - b] === "\\") b++;
          if (b % 2 === 1) {
            j = close + 1;
          } else {
            mlDelim = undefined;
            j = close + 3;
          }
        } else {
          mlDelim = undefined;
          j = close + 3;
        }
        continue;
      }
      const ch = content[j];
      if (ch === "#") break;
      if (ch === '"' || ch === "'") {
        const triple = ch.repeat(3);
        if (content.startsWith(triple, j)) {
          mlDelim = triple;
          j += 3;
          continue;
        }
        j++;
        while (j < content.length && content[j] !== ch) j += ch === '"' && content[j] === "\\" ? 2 : 1;
        j++;
        continue;
      }
      if (ch === "[" || ch === "{") depth++;
      else if ((ch === "]" || ch === "}") && depth > 0) depth--;
      j++;
    }
    lines.push(line);
    pos = next;
  }
  return lines;
}

/**
 * Collapse a run of blank lines around `idx` to a single blank line, touching
 * nothing else in the file (a global replace would alter multi-line strings).
 */
export function collapseBlankRunAt(text: string, idx: number, eol: string): string {
  let a = idx;
  let b = idx;
  while (a > 0 && (text[a - 1] === "\n" || text[a - 1] === "\r")) a--;
  while (b < text.length && (text[b] === "\n" || text[b] === "\r")) b++;
  const run = text.slice(a, b);
  if ((run.match(/\n/g) ?? []).length <= 2) return text;
  return text.slice(0, a) + eol + eol + text.slice(b);
}

/** Write via a temp file in the same directory, then rename; the temp file is removed on failure. */
export function writeFileAtomic(filePath: string, text: string): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}
