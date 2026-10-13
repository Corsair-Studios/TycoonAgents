// ---------------------------------------------------------------------------
// Managed relay agents (Claude Code harness).
//
// On Claude Code a Task subagent always runs on Claude, so a routing slot that
// names another provider only takes effect when the agent file itself forwards
// the work to that provider's MCP bridge. This module converts an ordinary
// `.claude/agents/<id>.md` into such a relay and back, losslessly:
//
//   - frontmatter: `model:` becomes the `haiku` wrapper alias; the previous
//     value is stored under `tycoon_relay_original_model`; `tycoon_relay`
//     names the bridge server;
//   - body: a generated `## Relay (managed by TycoonAgents)` section between
//     RELAY_SECTION_BEGIN/END, followed by the agent's ORIGINAL body verbatim
//     between RELAY_ORIGINAL_BEGIN/END.
//
// Pure string functions with no imports so scripts/apply-routing-profile.mjs,
// the VS Code host and the standalone host all share one implementation.
// ---------------------------------------------------------------------------

export const RELAY_KEY = "tycoon_relay";
export const RELAY_ORIGINAL_MODEL_KEY = "tycoon_relay_original_model";
export const RELAY_ORIGINAL_TOOLS_KEY = "tycoon_relay_original_tools";
export const RELAY_HASH_KEY = "tycoon_relay_hash";
export const RELAY_NO_ORIGINAL_MODEL = "(none)";
/** Prefix of the stdout line scripts/apply-routing-profile.mjs prints for a notice the host shows the user. */
export const RELAY_NOTICE_PREFIX = "TYCOON-RELAY-NOTICE:";
export const RELAY_SECTION_BEGIN = "<!-- tycoon:relay:begin -->";
export const RELAY_SECTION_END = "<!-- tycoon:relay:end -->";
export const RELAY_ORIGINAL_BEGIN = "<!-- tycoon:relay-original:begin -->";
export const RELAY_ORIGINAL_END = "<!-- tycoon:relay-original:end -->";
export const RELAY_WRAPPER_MODEL = "haiku";
export const RELAY_HEADING = "## Relay (managed by TycoonAgents)";
export const RELAY_ORIGINAL_HEADING = "## Role instructions to forward to the provider";

/** The routing backend facts a relay needs. */
export interface RelayBackendInput {
  vendor: string;
  transport: string;
  mcpServer?: string;
  tools?: string[];
  model: string;
  endpointEnv?: string;
  apiKeyEnv?: string;
}

export interface RelayTarget {
  agentId: string;
  server: string;
  tool: string;
  vendor: string;
  /** Slot model as saved (e.g. "openai/gpt-6.1-sol"). */
  slotModel: string;
  /** workspace: the provider edits files itself. text-only: the relay applies the proposed edits. */
  kind: "workspace" | "text-only";
  endpointEnv?: string;
  apiKeyEnv?: string;
}

interface ServerInfo {
  kind: "workspace" | "text-only";
  tool: string;
}

// `codex` is registered read-only, so Codex proposes changes and the relay applies them. `codex-write`
// is the opt-in sibling registered with the workspace-write sandbox: Codex edits files itself.
const KNOWN_SERVERS: Record<string, ServerInfo> = {
  codex: { kind: "text-only", tool: "codex" },
  "codex-write": { kind: "workspace", tool: "codex" },
  "claude-cli": { kind: "workspace", tool: "claude" },
  gemini: { kind: "text-only", tool: "ask-gemini" },
  "openai-compatible": { kind: "text-only", tool: "chat" },
};

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** True when the agent file carries the `tycoon_relay` frontmatter key. */
export function agentMarkdownIsRelayManaged(content: string): boolean {
  const m = FM_RE.exec(stripBom(content));
  if (!m) return false;
  return m[1].split(/\r?\n/).some((l) => new RegExp(`^${RELAY_KEY}\\s*:`).test(l));
}

/** True for a hand-written relay/bridge body (those already forward to a provider). */
export function agentMarkdownLooksLikeBridgeAgent(content: string): boolean {
  return /wrapper-class:\s*relay/.test(content);
}

/**
 * The relay target for a slot's backend, or null when the backend is not a
 * bridge a relay can call (anthropic, native transport, or no usable tool).
 */
export function relayTargetFor(agentId: string, backend: RelayBackendInput | null | undefined): RelayTarget | null {
  if (!backend || typeof backend.vendor !== "string" || backend.vendor === "" || backend.vendor.toLowerCase() === "anthropic") return null;
  let server = backend.mcpServer;
  if (!server && backend.transport === "openai-compatible") server = "openai-compatible";
  if (!server || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(server)) return null;
  if (backend.transport !== "mcp" && backend.transport !== "openai-compatible") return null;
  const known = KNOWN_SERVERS[server];
  const tools = Array.isArray(backend.tools) ? backend.tools.filter((t) => /^[A-Za-z0-9_-]+$/.test(t)) : [];
  let tool: string | undefined;
  if (known) tool = tools.length === 0 || tools.includes(known.tool) ? known.tool : tools[0];
  else tool = tools[0];
  if (!tool) return null;
  const target: RelayTarget = {
    agentId,
    server,
    tool,
    vendor: backend.vendor,
    slotModel: backend.model,
    kind: known ? known.kind : "text-only",
  };
  if (backend.endpointEnv) target.endpointEnv = backend.endpointEnv;
  if (backend.apiKeyEnv) target.apiKeyEnv = backend.apiKeyEnv;
  return target;
}

/** Model id as the bridge tool expects it: vendor prefix dropped, except for the generic OpenAI-compatible endpoint. */
function providerModelArg(t: RelayTarget): string {
  const m = t.slotModel;
  if (t.server === "openai-compatible") return m;
  const prefix = `${t.vendor}/`;
  if (m.toLowerCase().startsWith(prefix.toLowerCase())) return m.slice(prefix.length);
  const slash = m.indexOf("/");
  return slash > 0 ? m.slice(slash + 1) : m;
}

/** The generated relay section (without the surrounding section markers), LF-separated. */
export function buildRelayBody(t: RelayTarget): string {
  const toolName = `mcp__${t.server}__${t.tool}`;
  const model = providerModelArg(t);
  const lines: string[] = [];
  lines.push(RELAY_HEADING);
  lines.push(`<!-- wrapper-class: relay - forwards the brief to ${t.vendor} (${t.slotModel}) through the \`${t.server}\` MCP server; does no independent work -->`);
  lines.push("");
  lines.push(`This agent runs on ${t.vendor} (\`${t.slotModel}\`) through the \`${t.server}\` MCP server, not on Claude. You are only the relay. Do not do the task yourself and do not answer from your own knowledge.`);
  lines.push("");
  lines.push("### Calling the provider");
  lines.push(`1. If the \`mcp__tycoon__delegate\` tool is in this session's tool list, make exactly ONE call to it with \`specialist: "${t.agentId}"\` and \`task\` set to the brief described below. Never set \`_tycoon\`. Its result is final: report it and make NO further model calls (no direct tool call, no retry, no second delegate).`);
  lines.push(`2. Otherwise call \`${toolName}\` exactly once. Arguments:`);
  if (t.server === "codex" || t.server === "codex-write") {
    lines.push("   - `prompt`: the brief described below.");
    lines.push(`   - \`model\`: \`"${model}"\``);
    lines.push("   - `cwd`: the project directory (the absolute path of your current working directory).");
    lines.push("   - Do NOT pass `sandbox`, `approval-policy`, `config` or any other argument. The sandbox and approval settings registered for the Codex server apply as they are; a call must never loosen them.");
  } else if (t.server === "claude-cli") {
    lines.push("   - `prompt`: the brief described below.");
    lines.push(`   - \`model\`: \`"${model}"\``);
    lines.push("   - `cwd`: the project directory (the absolute path of your current working directory).");
    lines.push("   - Do NOT pass `allowed_tools` or any other permission-widening argument. The server's registered permission mode applies.");
  } else if (t.server === "gemini") {
    lines.push("   - `prompt`: the brief described below, with the contents of every file it needs included.");
    lines.push(`   - \`model\`: \`"${model}"\``);
    lines.push("   - `changeMode: true` when the task asks for code changes, so the reply is structured edit suggestions. Do NOT pass `sandbox`.");
  } else if (t.server === "openai-compatible") {
    lines.push("   - `prompt`: the brief described below, with the contents of every file it needs included.");
    lines.push(`   - \`model\`: \`"${model}"\``);
    if (t.endpointEnv) lines.push(`   - \`endpointEnv\`: \`"${t.endpointEnv}"\` (an env var NAME, never a URL)`);
    if (t.apiKeyEnv) lines.push(`   - \`apiKeyEnv\`: \`"${t.apiKeyEnv}"\` (an env var NAME, never a key)`);
  } else {
    lines.push("   - `prompt`: the brief described below, with the contents of every file it needs included.");
    lines.push(`   - \`model\`: \`"${model}"\` when the tool accepts a model argument.`);
  }
  lines.push("");
  lines.push("The brief is the text of the section \"" + RELAY_ORIGINAL_HEADING.replace(/^## /, "") + "\" below, verbatim, followed by the task you were given, verbatim. Do not summarize, reword or add to either. The provider sees only this text, never this conversation.");
  if (t.kind === "text-only") {
    lines.push("");
    lines.push("Because this provider cannot edit files here, end the brief with this instruction: \"Do not modify any files. Return the exact changes: a unified diff, or for a small file the file path and its full new content. Return analysis only if the task asks for no changes.\"");
  }
  lines.push("");
  lines.push("### Applying the result");
  if (t.kind === "workspace") {
    lines.push("The provider makes any file changes itself (this server was registered with write access for this project). Do not repeat its edits and do not edit files yourself. If it reports that it could not write, report that and stop; never retry with a wider sandbox or looser approval.");
  } else {
    lines.push("The provider returns text only and cannot touch files here. Read the files the task names with Read and include them in the brief. When the reply contains proposed changes, apply them yourself with Edit and Write exactly as proposed, with no extra reasoning, no improvements and no additions. If a patch does not apply, report which file and hunk failed and stop; do not improvise a fix. If the reply is analysis or review text, return it as is.");
  }
  lines.push("");
  lines.push("### When the provider fails");
  lines.push(`If the tool is not available in this session, returns \`isError:true\`, or returns a bridge envelope \`{tycoonBridge:1,status,...}\` whose \`status\` is \`provider_error\`, \`timeout\` or \`empty\`, the provider did not do the work. Report \`provider-unavailable\` with the raw error text (and which tool was missing), then stop. Never do the task yourself as a substitute, and never call a different tool or model.`);
  lines.push("");
  lines.push("### Reporting");
  lines.push("Return the provider's result in this project's report format: the outcome first (what changed with file:line, the verification result, open issues), under 250 words, plain prose. Add nothing of your own beyond a one-line note when the provider failed or its output was truncated.");
  return lines.join("\n");
}

function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function buildRelaySection(t: RelayTarget, eol: string): string {
  return withEol(`${RELAY_SECTION_BEGIN}\n${buildRelayBody(t)}\n${RELAY_SECTION_END}`, eol);
}

/** 53-bit string hash (cyrb53): detects edits to the generated text, not a security control. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** The relay-owned text of a body: everything except the preserved original. */
function relayShell(rest: string): string {
  const b = rest.indexOf(RELAY_ORIGINAL_BEGIN);
  const e = rest.lastIndexOf(RELAY_ORIGINAL_END);
  if (b < 0 || e < b) return rest;
  return rest.slice(0, b + RELAY_ORIGINAL_BEGIN.length) + rest.slice(e);
}

const keyRe = (k: string): RegExp => new RegExp(`^${k}\\s*:`);
const ALL_KEYS = [RELAY_KEY, RELAY_ORIGINAL_MODEL_KEY, RELAY_ORIGINAL_TOOLS_KEY, RELAY_HASH_KEY];

function lineValue(lines: string[], key: string): string | undefined {
  const l = lines.find((x) => keyRe(key).test(x));
  return l === undefined ? undefined : /:\s*(.*?)\s*$/.exec(l)![1];
}

/** Tool names the relay needs on top of the agent's own `tools:` allowlist. */
function relayToolNames(t: RelayTarget): string[] {
  const names = [`mcp__${t.server}__${t.tool}`, "mcp__tycoon__delegate"];
  if (t.kind === "text-only") names.push("Read", "Edit", "Write");
  return names;
}

function appendTools(originalValue: string, add: string[]): string {
  const v = originalValue.trim();
  const bracket = /^\[(.*)\]$/.exec(v);
  const items = (bracket ? bracket[1] : v).split(",").map((x) => x.trim()).filter(Boolean);
  const bare = (x: string): string => x.replace(/^["']|["']$/g, "");
  for (const a of add) if (!items.some((i) => bare(i) === a)) items.push(a);
  return bracket ? `[${items.join(", ")}]` : items.join(", ");
}

interface RelayFmState {
  server: string;
  originalModel?: string;
  /** Raw value of the agent's own inline `tools:` line, when it had one. */
  originalTools?: string;
  target: RelayTarget;
  hash: string;
}

/** Write the relay keys (and the widened `tools:` line) into a frontmatter whose `model:` is already the wrapper. */
function writeRelayFrontmatter(fmLines: string[], st: RelayFmState): string[] {
  const out = fmLines.filter((l) => !ALL_KEYS.some((k) => keyRe(k).test(l)));
  if (st.originalTools !== undefined) {
    const idx = out.findIndex((l) => /^tools\s*:/.test(l));
    const widened = `tools: ${appendTools(st.originalTools, relayToolNames(st.target))}`;
    if (idx >= 0) out[idx] = widened;
    else out.push(widened);
  }
  const insert = [`${RELAY_KEY}: ${st.server}`, `${RELAY_ORIGINAL_MODEL_KEY}: ${st.originalModel ?? RELAY_NO_ORIGINAL_MODEL}`];
  if (st.originalTools !== undefined) insert.push(`${RELAY_ORIGINAL_TOOLS_KEY}: ${st.originalTools}`);
  insert.push(`${RELAY_HASH_KEY}: ${st.hash}`);
  const modelIdx = out.findIndex((l) => /^model\s*:/.test(l));
  if (modelIdx >= 0) out.splice(modelIdx + 1, 0, ...insert);
  else out.push(...insert);
  return out;
}

function joinFile(eol: string, fmLines: string[], rest: string): string {
  return `---${eol}${fmLines.join(eol)}${eol}---${eol}${rest}`;
}

function assembleBody(target: RelayTarget, original: string, eol: string): string {
  return (
    eol +
    buildRelaySection(target, eol) + eol + eol +
    RELAY_ORIGINAL_HEADING + eol +
    RELAY_ORIGINAL_BEGIN + eol +
    original + eol +
    RELAY_ORIGINAL_END + eol
  );
}

/** Convert an ordinary agent file into a managed relay. Returns null when the file has no frontmatter. */
export function convertToRelay(content: string, target: RelayTarget): string | null {
  const bom = content.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const text = stripBom(content);
  const m = FM_RE.exec(text);
  if (!m) return null;
  const eol = detectEol(text);
  const fmLines = m[1].split(/\r?\n/);
  const rest = text.slice(m[0].length);
  const modelIdx = fmLines.findIndex((l) => /^model\s*:/.test(l));
  let originalModel: string | undefined;
  const next = [...fmLines];
  if (modelIdx >= 0) {
    originalModel = /^model\s*:\s*(.*?)\s*$/.exec(fmLines[modelIdx])![1];
    if (originalModel === "") originalModel = undefined;
    next[modelIdx] = `model: ${RELAY_WRAPPER_MODEL}`;
  } else {
    let at = 0;
    for (let i = 0; i < next.length; i++) if (/^(name|description)\s*:/.test(next[i])) at = i + 1;
    next.splice(at, 0, `model: ${RELAY_WRAPPER_MODEL}`);
  }
  const toolsLine = fmLines.find((l) => /^tools\s*:/.test(l));
  const toolsValue = toolsLine === undefined ? undefined : /^tools\s*:\s*(.*?)\s*$/.exec(toolsLine)![1];
  const body = assembleBody(target, rest, eol);
  const fm = writeRelayFrontmatter(next, {
    server: target.server,
    originalModel,
    originalTools: toolsValue !== undefined && toolsValue !== "" ? toolsValue : undefined,
    target,
    hash: hashText(relayShell(body)),
  });
  return bom + joinFile(eol, fm, body);
}

/** Regenerate only the relay section (and the relay keys) of an already-relayed file. */
export function regenerateRelay(content: string, target: RelayTarget): string | null {
  const bom = content.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const text = stripBom(content);
  const m = FM_RE.exec(text);
  if (!m || !agentMarkdownIsRelayManaged(text)) return null;
  const eol = detectEol(text);
  const rest = text.slice(m[0].length);
  const b = rest.indexOf(RELAY_SECTION_BEGIN);
  const eIdx = rest.indexOf(RELAY_SECTION_END);
  if (b < 0 || eIdx < b) return null;
  const nextRest = rest.slice(0, b) + buildRelaySection(target, eol) + rest.slice(eIdx + RELAY_SECTION_END.length);
  const fmLines = m[1].split(/\r?\n/);
  const originalModel = lineValue(fmLines, RELAY_ORIGINAL_MODEL_KEY);
  const fm = writeRelayFrontmatter(fmLines, {
    server: target.server,
    originalModel: originalModel === RELAY_NO_ORIGINAL_MODEL ? undefined : originalModel,
    originalTools: lineValue(fmLines, RELAY_ORIGINAL_TOOLS_KEY),
    target,
    hash: hashText(relayShell(nextRest)),
  });
  const result = bom + joinFile(eol, fm, nextRest);
  return result === content ? content : result;
}

/** A Claude alias (optionally `[1m]`) or a `claude-*` id: the only values Claude Code accepts as a top-level model. */
export function isClaudeModelValue(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, "").replace(/\[1m\]$/i, "");
  return ["sonnet", "opus", "haiku", "inherit", "fable", "opusplan"].includes(v) || /^claude-/.test(v);
}

export interface RelayRevertResult {
  /** The restored file, or null when it could not be restored. */
  content: string | null;
  /** True when the file differed from what conversion produced; the caller must save the pre-revert text first. */
  modified: boolean;
  /** Set when the stored original model was not valid and `fallbackModel` was used instead. */
  modelReplaced?: { from: string; to: string };
  problem?: string;
}

/** Restore the original body, model and tools exactly, removing every relay marker and key. */
export function revertRelayDetailed(content: string, fallbackModel = "sonnet"): RelayRevertResult {
  const bom = content.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const text = stripBom(content);
  const m = FM_RE.exec(text);
  if (!m || !agentMarkdownIsRelayManaged(text)) return { content: null, modified: false, problem: "no relay frontmatter" };
  const rest = text.slice(m[0].length);
  const bIdx = rest.indexOf(RELAY_ORIGINAL_BEGIN);
  const eIdx = rest.lastIndexOf(RELAY_ORIGINAL_END);
  if (bIdx < 0 || eIdx < bIdx) return { content: null, modified: false, problem: "the relay markers are missing" };
  const afterBegin = bIdx + RELAY_ORIGINAL_BEGIN.length;
  const nl = rest.startsWith("\r\n", afterBegin) ? "\r\n" : rest.startsWith("\n", afterBegin) ? "\n" : "";
  const bodyStart = afterBegin + nl.length;
  const bodyEnd = eIdx - nl.length;
  if (nl === "" || bodyEnd < bodyStart || rest.slice(bodyEnd, eIdx) !== nl) {
    return { content: null, modified: false, problem: "the relay markers are damaged" };
  }
  const original = rest.slice(bodyStart, bodyEnd);
  const eol = detectEol(text);
  let fmLines = m[1].split(/\r?\n/);
  const storedHash = lineValue(fmLines, RELAY_HASH_KEY);
  const modified = storedHash !== undefined && storedHash !== hashText(relayShell(rest));
  const originalModel = lineValue(fmLines, RELAY_ORIGINAL_MODEL_KEY);
  const originalTools = lineValue(fmLines, RELAY_ORIGINAL_TOOLS_KEY);
  fmLines = fmLines.filter((l) => !ALL_KEYS.some((k) => keyRe(k).test(l)));
  if (originalTools !== undefined) {
    const idx = fmLines.findIndex((l) => /^tools\s*:/.test(l));
    if (idx >= 0) fmLines[idx] = `tools: ${originalTools}`;
    else fmLines.push(`tools: ${originalTools}`);
  }
  const modelIdx = fmLines.findIndex((l) => /^model\s*:/.test(l));
  let modelReplaced: { from: string; to: string } | undefined;
  if (originalModel === undefined || originalModel === RELAY_NO_ORIGINAL_MODEL) {
    if (modelIdx >= 0) fmLines.splice(modelIdx, 1);
  } else {
    let restored = originalModel;
    if (!isClaudeModelValue(originalModel)) {
      modelReplaced = { from: originalModel, to: fallbackModel };
      restored = fallbackModel;
    }
    if (modelIdx >= 0) fmLines[modelIdx] = `model: ${restored}`;
    else fmLines.push(`model: ${restored}`);
  }
  return { content: bom + joinFile(eol, fmLines, original), modified, ...(modelReplaced ? { modelReplaced } : {}) };
}

/** Restore the original body and model exactly. Null when the file is not a parseable relay. */
export function revertRelay(content: string): string | null {
  return revertRelayDetailed(content).content;
}

export interface RelayWant {
  target: RelayTarget;
  /** True when the file is a hand-written bridge/relay agent that must never be converted. */
  skipConversion?: boolean;
}

export interface RelayReconcileResult {
  content: string;
  /** Pre-revert text to save as `<id>.md.relay-backup` before `content` replaces the file. */
  backup?: string;
  /** User-facing notes (a backup was made, markers are missing, a model was replaced). */
  notices: string[];
}

/**
 * The single entry point: reconcile a file with the wanted relay state.
 *  - `want` null: revert a relayed file (anything else is returned as is).
 *  - `want` set and the file is relayed: regenerate only the relay section.
 *  - `want` set and the file is ordinary: convert it (unless skipConversion).
 * Never throws. A relay whose markers are gone is returned unchanged with a notice.
 */
export function reconcileRelayDetailed(content: string, want: RelayWant | null, opts: { agentId?: string; fallbackModel?: string } = {}): RelayReconcileResult {
  const id = opts.agentId ?? "this agent";
  try {
    const relayed = agentMarkdownIsRelayManaged(content);
    if (!want) {
      if (!relayed) return { content, notices: [] };
      const r = revertRelayDetailed(content, opts.fallbackModel);
      if (r.content === null) {
        return { content, notices: [`${id} is still a relay: ${r.problem}. Its file was left unchanged; recreate the agent or restore the markers to revert it.`] };
      }
      const notices: string[] = [];
      if (r.modified) notices.push(`${id}.md was edited after it became a relay. The edited file was saved as ${id}.md.relay-backup before it was restored.`);
      if (r.modelReplaced) notices.push(`${id} had model "${r.modelReplaced.from}" recorded, which Claude Code does not accept; it now uses "${r.modelReplaced.to}".`);
      return { content: r.content, ...(r.modified ? { backup: content } : {}), notices };
    }
    if (relayed) return { content: regenerateRelay(content, want.target) ?? content, notices: [] };
    if (want.skipConversion || agentMarkdownLooksLikeBridgeAgent(stripBom(content))) return { content, notices: [] };
    return { content: convertToRelay(content, want.target) ?? content, notices: [] };
  } catch {
    return { content, notices: [] };
  }
}

/** String-only form of {@link reconcileRelayDetailed}. */
export function reconcileRelay(content: string, want: RelayWant | null): string {
  return reconcileRelayDetailed(content, want).content;
}
