/*
 * TycoonAgents - https://x.com/thetrashbyrd
 * Releases: https://github.com/Corsair-Studios/TycoonAgents/releases
 * Attribution header - optional; end users may remove it.
 *
 * Classifier for Bash / PowerShell command strings that run ANOTHER vendor's
 * LLM CLI (codex exec, gemini -p, opencode run, ollama run). Used on the
 * Claude Code harness so a hand-written agent that shells out to a foreign
 * model shows up as a foreign-LLM call (light-blue row, MCP count).
 *
 * hooks/tycoon-claude-hook.cjs keeps an inline copy (it is a zero-dependency
 * .cjs that must work without out/); test/foreignCli.test.ts asserts both give
 * identical results. Keep the two in lockstep.
 *
 * Contract: prefer false negatives. The executable must sit in command
 * position, so `echo codex exec`, `grep codex`, `which codex` never match.
 * `claude -p` is the same vendor and never matches. Pure, no I/O.
 */

export interface ForeignCliCall {
  /** Vendor id of the model behind the CLI: "openai" | "google" | "local" | a provider id | "opencode". */
  vendor: string;
  /** CLI that was invoked: "codex" | "gemini" | "opencode" | "ollama". */
  cli: string;
  /** Model passed on the command line, or null when the CLI picks its own. */
  model: string | null;
}

const HELP_FLAGS = new Set(["--help", "-h", "--version", "-V", "-v", "help", "/?"]);
const WRAPPERS = new Set(["env", "command", "time", "nohup", "sudo", "exec"]);
const SHELLS = new Set(["bash", "sh", "zsh", "cmd", "powershell", "pwsh"]);
const SHELL_CMD_FLAGS = new Set(["-c", "/c", "/k", "-command", "-c"]);
const GEMINI_SUBCOMMANDS = new Set(["mcp", "extensions", "extension", "hooks", "skills", "config", "update", "login", "help"]);
const GEMINI_VALUE_FLAGS = new Set([
  "-m", "--model", "-o", "--output-format", "--approval-mode", "-e", "--extensions", "--include-directories",
  "-r", "--resume", "--allowed-tools", "--allowed-mcp-server-names", "-i", "--prompt-interactive", "--checkpointing",
]);

/** Split a command line into argv-style segments on ; && || | & and newlines (outside quotes). */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let cur: string[] = [];
  let tok = "";
  let has = false;
  let quote: string | null = null;
  const pushTok = () => { if (has) cur.push(tok); tok = ""; has = false; };
  const pushSeg = () => { pushTok(); if (cur.length > 0) segments.push(cur); cur = []; };
  const heredocs: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && command[i + 1] === '"') { tok += '"'; i++; continue; }
      if (ch === quote) { quote = null; continue; }
      tok += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { pushTok(); continue; }
    if (ch === "\n") {
      pushSeg();
      // Skip the body of any heredoc started on the line that just ended.
      for (const term of heredocs.splice(0)) {
        let pos = i + 1;
        while (pos < command.length) {
          let eol = command.indexOf("\n", pos);
          if (eol < 0) eol = command.length;
          const line = command.slice(pos, eol).trim();
          pos = eol + 1;
          if (line === term) break;
        }
        i = Math.min(pos, command.length) - 1;
      }
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") { pushSeg(); continue; }
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      let j = i + 2;
      if (command[j] === "-") j++;
      while (command[j] === " " || command[j] === "\t") j++;
      let word = "";
      const q = command[j];
      if (q === '"' || q === "'") {
        const close = command.indexOf(q, j + 1);
        if (close > j) { word = command.slice(j + 1, close); j = close + 1; }
      } else {
        const m = /^[^\s;|&<>()]+/.exec(command.slice(j));
        if (m) { word = m[0]; j += word.length; }
      }
      pushTok();
      if (word !== "") heredocs.push(word);
      i = j - 1;
      continue;
    }
    // PowerShell here-string: @' ... '@ or @" ... "@ (the opener ends its line).
    if (ch === "@" && !has && (command[i + 1] === "'" || command[i + 1] === '"') && /^\r?\n/.test(command.slice(i + 2, i + 4))) {
      const end = command.indexOf("\n" + command[i + 1] + "@", i + 2);
      has = true;
      i = end < 0 ? command.length : end + 2;
      continue;
    }
    tok += ch;
    has = true;
  }
  pushSeg();
  return segments;
}

function exeName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

function optionValue(args: string[], short: string[], long: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (short.includes(a) || long.includes(a)) {
      const v = args[i + 1];
      return v !== undefined && v !== "" && !v.startsWith("-") ? v : null;
    }
    for (const l of long) if (a.startsWith(l + "=") && a.length > l.length + 1) return a.slice(l.length + 1);
  }
  return null;
}

/** `-c model="x"` / `--config model=x` overrides (Codex). */
function configModel(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-c" || args[i] === "--config") {
      const m = /^model\s*=\s*"?([^"\s]+)"?$/.exec(args[i + 1]!);
      if (m) return m[1]!;
    }
  }
  return null;
}

function vendorFromProvider(provider: string): string {
  const p = provider.toLowerCase();
  if (p === "openai" || p === "codex") return "openai";
  if (p === "google" || p === "gemini" || p === "google-vertex") return "google";
  if (p === "ollama" || p === "lmstudio" || p === "local") return "local";
  return p;
}

function classifyTokens(tokens: string[], depth: number): ForeignCliCall | null {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || WRAPPERS.has(exeName(t))) { i++; continue; }
    break;
  }
  if (i >= tokens.length) return null;
  const exe = exeName(tokens[i]!);
  const args = tokens.slice(i + 1);
  if (SHELLS.has(exe)) {
    if (depth >= 2) return null;
    for (let k = 0; k < args.length - 1; k++) {
      if (SHELL_CMD_FLAGS.has(args[k]!.toLowerCase())) return classifyForeignCli(args.slice(k + 1).join(" "), depth + 1);
    }
    return null;
  }
  if (args.some((a) => HELP_FLAGS.has(a))) return null;

  if (exe === "codex") {
    if (args[0] !== "exec" && args[0] !== "e") return null;
    const rest = args.slice(1);
    const model = optionValue(rest, ["-m"], ["--model"]) ?? configModel(rest);
    return { vendor: "openai", cli: "codex", model };
  }
  if (exe === "gemini") {
    const model = optionValue(args, ["-m"], ["--model"]);
    const hasPromptFlag = args.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt="));
    let positional = false;
    for (let k = 0; k < args.length && !positional; k++) {
      const a = args[k]!;
      if (GEMINI_VALUE_FLAGS.has(a)) { k++; continue; }
      if (a.startsWith("-")) continue;
      if (k === 0 && GEMINI_SUBCOMMANDS.has(a)) return null;
      positional = true;
    }
    if (!hasPromptFlag && !positional) return null;
    return { vendor: "google", cli: "gemini", model };
  }
  if (exe === "opencode") {
    if (args[0] !== "run") return null;
    const model = optionValue(args.slice(1), ["-m"], ["--model"]);
    const slash = model ? model.indexOf("/") : -1;
    const vendor = model && slash > 0 ? vendorFromProvider(model.slice(0, slash)) : "opencode";
    if (vendor === "anthropic") return null; // same vendor as the Claude Code harness
    return { vendor, cli: "opencode", model };
  }
  if (exe === "ollama") {
    if (args[0] !== "run") return null;
    const model = args.slice(1).find((a) => !a.startsWith("-")) ?? null;
    return { vendor: "local", cli: "ollama", model };
  }
  return null;
}

/**
 * Returns the first foreign-LLM CLI invocation found in a shell command, or
 * null. `depth` is internal (nested `bash -c "..."` unwrapping).
 */
export function classifyForeignCli(command: unknown, depth = 0): ForeignCliCall | null {
  if (typeof command !== "string" || command === "" || command.length > 20000) return null;
  for (const seg of splitSegments(command)) {
    const hit = classifyTokens(seg, depth);
    if (hit) return hit;
  }
  return null;
}
