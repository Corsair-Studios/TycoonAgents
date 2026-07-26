// Trashbyrd's UEFN Power Tools — MCP server (stdio transport) fronting the UEFN Python bridge.
// Rebuild via `npm run bundle:uefn`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Bridge directory — honor env var or fall back to OS temp dir (matching Python's tempfile.gettempdir())
const BRIDGE_DIR = process.env.UEFN_BRIDGE_DIR ?? path.join(os.tmpdir(), "uefn_bridge");

// Session-token compat matrix (cheap partial IPC isolation, not full auth —
// the shared temp dir is still world-readable; this only stops
// *unintentional* cross-session command delivery, e.g. a leftover MCP
// server from a previous session talking to a freshly restarted bridge):
//
//   new server x new bridge  -> isolated. Server reads the token the bridge
//                                published in heartbeat.json and echoes it
//                                on every command; bridge rejects anything
//                                that doesn't match.
//   new server x old bridge  -> tokenless. heartbeat.json has no `token`
//                                field, so the server omits `token` from
//                                commands; old bridge ignores unknown
//                                command fields either way, so this is
//                                identical to pre-token behavior.
//   old server x new bridge  -> commands rejected. An un-upgraded server
//                                never sends a token, so the bridge treats
//                                every command as a mismatch and drops it
//                                (logged once). Requires upgrading the
//                                server to interoperate.
//   old server x old bridge  -> unchanged, tokenless.
const HEARTBEAT_PATH = path.join(BRIDGE_DIR, "heartbeat.json");

async function readBridgeToken(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(HEARTBEAT_PATH, "utf8");
    const heartbeat = JSON.parse(raw) as { token?: unknown };
    return typeof heartbeat.token === "string" ? heartbeat.token : undefined;
  } catch {
    // heartbeat.json missing/unreadable/stale — bridge not started yet, or
    // an old bridge build that never wrote a token. Either way, fall back
    // to a tokenless command (see compat matrix above).
    return undefined;
  }
}

// Serialize all requests — Python only handles one command.json at a time
let requestChain: Promise<unknown> = Promise.resolve();
let counter = 0;

// Default poll-timeout budget for every bridge call. A handful of tools do
// real, unavoidably slow work (e.g. uefn_moderation_scan's full asset-
// registry sweep on a large project) and pass a larger `timeoutMs` at their
// call site below — this default is unchanged for every other tool.
const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

async function callBridge(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_BRIDGE_TIMEOUT_MS
): Promise<unknown> {
  // Queue behind any in-flight request
  const result = requestChain.then(() => _callBridgeNow(method, params, timeoutMs));
  // Keep the chain alive even if this call errors
  requestChain = result.catch(() => undefined);
  return result;
}

async function _callBridgeNow(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_BRIDGE_TIMEOUT_MS
): Promise<unknown> {
  const id = `${Date.now()}_${++counter}`;
  const commandPath = path.join(BRIDGE_DIR, "command.json");
  const commandTmpPath = path.join(BRIDGE_DIR, `command_${id}.tmp`);
  const responsePath = path.join(BRIDGE_DIR, `response_${id}.json`);

  const token = await readBridgeToken();
  const payload = JSON.stringify(token ? { id, method, params, token } : { id, method, params });

  // Atomic write: write to .tmp then rename (mirrors Python's os.replace)
  await fs.mkdir(BRIDGE_DIR, { recursive: true });
  await fs.writeFile(commandTmpPath, payload, "utf8");
  await fs.rename(commandTmpPath, commandPath);

  // Poll for response every 200ms, timeout at `timeoutMs` (default 30s;
  // callers doing known-slow work pass a larger budget — see call sites).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const raw = await fs.readFile(responsePath, "utf8");
      // Delete response file before parsing to avoid re-processing
      await fs.unlink(responsePath).catch(() => undefined);
      const response = JSON.parse(raw) as {
        id: string;
        result: unknown;
        error: string | null;
        timestamp: string;
      };
      if (response.error) {
        throw new BridgeError(response.error);
      }
      return response.result;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      // File not yet written — keep polling
    }
  }

  throw new TimeoutError(
    `Bridge timeout after ${Math.round(timeoutMs / 1000)}s waiting for ` +
      `response_${id}.json (method: ${method})`
  );
}

class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// Helper: build MCP tool result
function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Helper: call bridge and wrap result/error uniformly
async function bridgeTool(method: string, params: Record<string, unknown>) {
  try {
    const result = await callBridge(method, params);
    return ok(result);
  } catch (e) {
    if (e instanceof BridgeError) return err(`Bridge error: ${e.message}`);
    if (e instanceof TimeoutError) return err(`Bridge error: ${e.message}`);
    return err(`Bridge error: ${String(e)}`);
  }
}

// Helper: strip undefined fields from params
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// ── Moderation wordlists (SERVER-SIDE ONLY, BY DESIGN) ──────────────────────
//
// media/uefn-bridge/moderation_scanner.py is staged into the user's UEFN
// project at Content/Python/ and IS checked into Unreal Revision Control
// (the project's ignore rules cover *.json/*.md/*.jsonl/*.cjs/*.mjs but NOT
// *.py) — a Python file full of literal franchise/brand names shipped into
// a Fortnite project would itself be an IP-moderation flag risk, tripping
// the very system it's meant to predict. These wordlists therefore live
// here instead, in the extension-side MCP server, which is never staged
// into a project. `uefn_moderation_scan` below computes `first_pass_hints`
// over the raw surfaces the bridge collects, using these lists.

// Cheap, deterministic first-pass hints only. Fortnite's documented
// "Authenticity" rule (Rule 1.13) bans content whose primary purpose is
// artificial engagement/reward farming rather than genuine gameplay. This
// is a literal-token seed for a FIRST PASS — the calling LLM makes the
// real call (context, intent, and false positives like "capture the flag"
// containing no banned substrings, or "battle pass" used as flavor text in
// an unrelated sense, are exactly what the LLM phase resolves).
const AUTHENTICITY_BANNED_TERMS: string[] = [
  // --- AFK / idle farming bait ---
  "afk", "afk farm", "afk xp", "afk grind", "afk map", "afk pool",

  // --- XP / progression farming bait ---
  "xp farm", "xp grind", "xp glitch", "coin farm", "coin slide",
  "coin drop", "coin grind",

  // --- Real/in-game currency and monetary reward bait ---
  "v-bucks", "vbucks", "free v-bucks", "free vbucks", "battle pass",
  "free battle pass", "win real money", "real money", "cash prize",
  "free robux", "free skin", "free skins", "free rewards",

  // --- Generic "free reward" / scam-adjacent bait tokens ---
  "click here", "subscribe to win", "redeem code", "code redeem",
  "giveaway",
];

// SMALL, NON-EXHAUSTIVE seed list of common third-party franchises/brands.
// This exists ONLY as a cheap first-pass hint — real IP/trademark judgment
// (fair use, licensed collab, coincidental name, transformative parody,
// etc.) is delegated to the calling LLM. Do NOT extend this into an
// authoritative IP database; it is not one and is not meant to become one.
const IP_BRAND_SEED_TERMS: string[] = [
  "star wars", "marvel", "disney", "lego", "pokemon", "pokémon",
  "ninja turtles", "teenage mutant ninja turtles", "cobra", "g.i. joe",
  "dc comics", "batman", "spider-man", "harry potter", "nintendo",
  "mario", "zelda", "minecraft", "roblox", "naruto", "dragon ball",
  "attack on titan", "demon slayer", "hello kitty", "sanrio",
];

// Exact media TITLES (film/TV/game/book/comic) of major franchises. Epic's
// documented brand rules prohibit franchise TITLES in island title,
// description, thumbnail, promotional imagery, videos, and in-island
// transactions EVEN WHEN the underlying character/IP itself is authorized
// for use. NON-EXHAUSTIVE SEED LIST — real franchise/title judgment is the
// calling LLM's job, not this list's. Dual-use trap: some terms are BOTH a
// character designation AND the exact title of a series/film, so a hit here
// is a "check this" nudge, not proof of a violation — a documented creator
// report describes "The Mandalorian" as simultaneously a character name and
// the exact title of a TV series, a case the public rules don't clearly
// resolve.
const MEDIA_TITLE_SEED_TERMS: string[] = [
  "the mandalorian", // dual-use: also a common character/role designation
  "the last jedi", "the rise of skywalker", "the force awakens",
  "revenge of the sith", "attack of the clones", "the phantom menace",
  "a new hope", "the empire strikes back", "return of the jedi",
  "rogue one", "the book of boba fett", "obi-wan kenobi", "andor",
  "the clone wars", "rebels", "ahsoka",
  "the avengers", "guardians of the galaxy", "spider-man: no way home",
  "batman begins", "the dark knight", "teenage mutant ninja turtles",
  "the walking dead", "stranger things",
];

// Wording that implies OFFICIAL ENDORSEMENT by a rights holder beyond an
// authorized program's actual terms — a documented Rule 1.7 risk pattern
// (e.g. "Official Star Wars roguelike", "Lucasfilm-approved", claims a
// brand "brought to you" the island). NON-EXHAUSTIVE SEED LIST.
const ENDORSEMENT_PHRASES: string[] = [
  "official star wars", "officially licensed", "officially endorsed",
  "approved by", "endorsed by", "lucasfilm-approved", "disney-approved",
  "marvel-approved", "epic-approved", "the definitive", "brought to you by",
  "disney's new", "in partnership with disney", "created by disney",
  "created by lucasfilm",
];

// Text that reads like a manually-entered brand/legal DISCLAIMER. Some
// publishing flows (e.g. Star Wars) supply the required disclaimer
// AUTOMATICALLY — a creator manually typing an equivalent into the
// description was a documented suspected trigger for a Rule 1.7 metadata
// rejection. This does not mean disclaimers are bad; it means disclaimer-
// shaped text found in the creator's OWN description (rather than injected
// by the publishing flow itself) is worth a second look. NON-EXHAUSTIVE
// SEED LIST.
const DISCLAIMER_PATTERNS: string[] = [
  "not affiliated with", "not endorsed by", "all rights reserved to",
  "trademarks are the property of", "is a trademark of", "© disney",
  "© lucasfilm", "used with permission", "all rights belong to",
];

// Section 1.12 "Keep It on the Island" is a DISTINCT rule from 1.7 (IP) and
// 1.13 (authenticity) above — no external links, invite links, social
// handles, or scannable codes anywhere on the island or its metadata,
// full stop. Unlike 1.7 there is no licensing nuance to weigh, so this is
// kept as its own wordlist rather than folded into AUTHENTICITY_BANNED_TERMS
// (which already covers unrelated reward-bait phrasing like "click here").
// NON-EXHAUSTIVE SEED LIST — literal token first pass only; real judgment
// (e.g. "our server" used in an unrelated sense) is the calling LLM's job.
const EXTERNAL_LINK_SEED_TERMS: string[] = [
  // --- Social/communication platforms by name ---
  "discord", "twitter", "x.com", "youtube", "youtu.be", "tiktok", "twitch",
  "instagram", "facebook", "reddit", "patreon", "ko-fi", "kofi", "paypal",
  "cashapp", "cash app", "venmo", "telegram", "whatsapp", "snapchat",
  "steam", "epic games store",

  // --- Link shorteners ---
  "linktree", "bit.ly", "tinyurl", "t.co", "shorturl",

  // --- Generic call-to-action link phrasing ---
  "join our", "follow us", "subscribe", "our server", "link in bio",
  "scan this", "scan the code", "qr code",
];

interface ModerationHint {
  term: string;
  source: string;
  file: string;
  ref: string;
  text: string;
}

interface TextSurface {
  text: string;
  source: string;
  file: string;
  ref: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Obvious literal matches only — no fuzzy/semantic matching; that nuance is
// the connected LLM's job. Never throws.
function matchModerationTerms(surfaces: TextSurface[], terms: string[]): ModerationHint[] {
  const hits: ModerationHint[] = [];
  const loweredTerms = terms.map((t) => t.toLowerCase());
  for (const { text, source, file, ref } of surfaces) {
    if (!text) continue;
    const low = text.toLowerCase();
    for (const term of loweredTerms) {
      if (low.includes(term)) {
        hits.push({ term, source, file, ref, text: text.slice(0, 200) });
      }
    }
  }
  return hits;
}

// Gathers every text-bearing surface the bridge returns (text_metadata,
// verse_surfaces text, asset_surfaces display names/paths,
// hlod_or_imported_assets, image_metadata field values, audio_surfaces).
// Defensive throughout: any field may be missing or the wrong shape —
// never throws, just skips what it can't read.
function collectModerationTextSurfaces(payload: Record<string, unknown>): TextSurface[] {
  const surfaces: TextSurface[] = [];

  const collectAssetLike = (arr: unknown, sourcePrefix: string) => {
    for (const raw of asArray(arr)) {
      const a = asRecord(raw);
      if (!a) continue;
      const file = asStr(a.package_name);
      const ref = asStr(a.object_path);
      const displayName = asStr(a.display_name);
      if (displayName) surfaces.push({ text: displayName, source: `${sourcePrefix}_display_name`, file, ref });
      const packagePath = asStr(a.package_path);
      if (packagePath) surfaces.push({ text: packagePath, source: `${sourcePrefix}_package_path`, file, ref });
    }
  };

  collectAssetLike(payload.asset_surfaces, "asset");
  collectAssetLike(payload.hlod_or_imported_assets, "hlod_or_imported");

  for (const raw of asArray(payload.verse_surfaces)) {
    const v = asRecord(raw);
    if (!v) continue;
    const text = asStr(v.text);
    if (text) surfaces.push({ text, source: `verse_${asStr(v.kind)}`, file: asStr(v.file), ref: String(v.line ?? "") });
  }

  const textMetadata = asRecord(payload.text_metadata);
  if (textMetadata) {
    for (const raw of asArray(textMetadata.fields)) {
      const f = asRecord(raw);
      if (!f) continue;
      const value = asStr(f.value);
      if (value) surfaces.push({ text: value, source: "text_metadata", file: asStr(f.file), ref: asStr(f.key) });
    }
  }

  for (const raw of asArray(payload.image_metadata)) {
    const img = asRecord(raw);
    if (!img) continue;
    const file = asStr(img.file);
    const fields = asRecord(img.fields);
    if (!fields) continue;
    for (const [key, val] of Object.entries(fields)) {
      if (typeof val === "string" && val) {
        surfaces.push({ text: val, source: "image_metadata", file, ref: key });
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item) surfaces.push({ text: item, source: "image_metadata", file, ref: key });
        }
      }
    }
  }

  const audioSurfaces = asRecord(payload.audio_surfaces);
  if (audioSurfaces) {
    for (const raw of asArray(audioSurfaces.audio)) {
      const a = asRecord(raw);
      if (!a) continue;
      const displayName = asStr(a.display_name);
      if (displayName) {
        surfaces.push({ text: displayName, source: "audio_display_name", file: asStr(a.package_name), ref: asStr(a.package_path) });
      }
    }
  }

  return surfaces;
}

function isAllowlisted(term: string, allowlistLower: string[]): boolean {
  return allowlistLower.some((entry) => entry && (term.includes(entry) || entry.includes(term)));
}

// Computes first_pass_hints server-side (see wordlist comment above) and
// attaches it to the bridge's moderation_scan payload before it reaches the
// LLM. Never throws — the bridge payload may be a string or an object, and
// any field within it may be missing; on any failure this returns the raw
// payload untouched rather than blocking the tool response.
function attachModerationHints(rawPayload: unknown, allowlist: string[] | undefined): unknown {
  try {
    let payload: unknown = rawPayload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return rawPayload; // not JSON — leave untouched
      }
    }
    const record = asRecord(payload);
    if (!record) return rawPayload;

    const surfaces = collectModerationTextSurfaces(record);
    const authenticityHits = matchModerationTerms(surfaces, AUTHENTICITY_BANNED_TERMS);
    const ipHits = matchModerationTerms(surfaces, IP_BRAND_SEED_TERMS);
    const mediaTitleHits = matchModerationTerms(surfaces, MEDIA_TITLE_SEED_TERMS);
    const endorsementHits = matchModerationTerms(surfaces, ENDORSEMENT_PHRASES);
    const disclaimerHits = matchModerationTerms(surfaces, DISCLAIMER_PATTERNS);
    const externalLinkHits = matchModerationTerms(surfaces, EXTERNAL_LINK_SEED_TERMS);

    // Python's structural external_link_risks detector (url/www/domain/
    // invite-path/scannable-code-token/handle scanning) — may be absent on
    // an older staged Python copy, so read defensively and never throw.
    const externalLinkRisksRaw = asRecord(record.external_link_risks);
    const externalLinkStructuralCount =
      externalLinkRisksRaw && typeof externalLinkRisksRaw.total_count === "number"
        ? externalLinkRisksRaw.total_count
        : 0;
    const hasExternalLinkFinding = externalLinkHits.length > 0 || externalLinkStructuralCount > 0;

    const allowlistLower = (allowlist ?? []).filter((s) => typeof s === "string").map((s) => s.toLowerCase());
    const expectedLicensed: ModerationHint[] = [];
    const investigate: ModerationHint[] = [];
    for (const hit of ipHits) {
      if (isAllowlisted(hit.term, allowlistLower)) expectedLicensed.push(hit);
      else investigate.push(hit);
    }

    // Cheap direct signal for the KNOWN-RISK residual-cause case: no other
    // wordlist hits fired, but there IS licensed IP present. Doesn't mean
    // the LLM's independent judgment found nothing else — just that the
    // wordlist first pass didn't — but it's a useful nudge either way.
    // Defensive: booleans-of-array-emptiness can't throw, but keep this
    // inside the outer try/catch regardless.
    const noOtherFindingsCandidate =
      investigate.length === 0 &&
      authenticityHits.length === 0 &&
      !hasExternalLinkFinding &&
      expectedLicensed.length > 0;

    return {
      ...record,
      first_pass_hints: {
        authenticity_hits: authenticityHits,
        ip_seed_hits: ipHits,
        media_title_hits: mediaTitleHits,
        endorsement_hits: endorsementHits,
        disclaimer_hits: disclaimerHits,
        external_link_hits: externalLinkHits,
        external_link_structural_count: externalLinkStructuralCount,
        expected_licensed: expectedLicensed,
        investigate,
        no_other_findings_candidate: noOtherFindingsCandidate,
      },
    };
  } catch {
    return rawPayload;
  }
}

// FIX 2: a buried instruction loses to a finished-looking answer — models
// act far more reliably on data returned IN a tool result than on text in a
// schema description. Appends a terminal field as the LAST serialized key
// so it's the final thing read after uefn_moderation_scan. Never throws;
// degrades to a no-op on any shape this can't safely extend.
const MODERATION_NEXT_REQUIRED_ACTION =
  "You are not finished. Call uefn_moderation_report with your completed analysis so it renders in the creator's in-editor Power Tools window. The creator cannot see your chat reply in UEFN.";

function appendModerationNextRequiredAction(result: unknown): unknown {
  try {
    const record = asRecord(result);
    if (!record) return result;
    return { ...record, next_required_action: MODERATION_NEXT_REQUIRED_ACTION };
  } catch {
    return result;
  }
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "trashbyrd-uefn",
  version: "1.0.0",
  description: "Trashbyrd's Power Tools — UEFN Bridge",
});

// ── Tools ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "uefn_status",
  { description: "Check UEFN bridge connectivity.", inputSchema: {} },
  async () => bridgeTool("status", {})
);

server.registerTool(
  "uefn_list_devices",
  { description: "List all Creative devices in the level.", inputSchema: {} },
  async () => bridgeTool("list_devices", {})
);

server.registerTool(
  "uefn_get_property",
  {
    description: "Read a property from an actor.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to query"),
      property_name: z.string().describe("Name of the property to read"),
    },
  },
  async (args) => bridgeTool("get_property", compact({ actor_label: args.actor_label, property_name: args.property_name }))
);

server.registerTool(
  "uefn_set_property",
  {
    description: "Set a property on an actor.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to update"),
      property_name: z.string().describe("Name of the property to set"),
      value: z.string().describe("Value to assign"),
    },
  },
  async (args) => bridgeTool("set_property", compact({ actor_label: args.actor_label, property_name: args.property_name, value: args.value }))
);

server.registerTool(
  "uefn_select_actor",
  {
    description: "Select an actor in the UEFN viewport.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to select"),
    },
  },
  async (args) => bridgeTool("select_actor", compact({ actor_label: args.actor_label }))
);

server.registerTool(
  "uefn_run_audit",
  { description: "Run a full device audit.", inputSchema: {} },
  async () => bridgeTool("run_audit", {})
);

server.registerTool(
  "uefn_get_level_info",
  { description: "Get metadata about the current UEFN level.", inputSchema: {} },
  async () => bridgeTool("get_level_info", {})
);

server.registerTool(
  "uefn_batch_set",
  {
    description: "Set a property on a filtered set of actors.",
    inputSchema: {
      property_name: z.string().describe("Property to set on matched actors"),
      value: z.string().describe("Value to assign"),
      filter_type: z.string().optional().describe("Filter type (e.g. 'class', 'label')"),
      filter_value: z.string().optional().describe("Filter value to match against"),
      dry_run: z.boolean().optional().describe("If true, preview changes without applying"),
    },
  },
  async (args) =>
    bridgeTool("batch_set", compact({ filter_type: args.filter_type, filter_value: args.filter_value, property_name: args.property_name, value: args.value, dry_run: args.dry_run }))
);

server.registerTool(
  "uefn_batch_get",
  {
    description: "Read a property from a filtered set of actors.",
    inputSchema: {
      property_name: z.string().describe("Property to read from matched actors"),
      filter_type: z.string().optional().describe("Filter type (e.g. 'class', 'label')"),
      filter_value: z.string().optional().describe("Filter value to match against"),
    },
  },
  async (args) =>
    bridgeTool("batch_get", compact({ filter_type: args.filter_type, filter_value: args.filter_value, property_name: args.property_name }))
);

server.registerTool(
  "uefn_texture_find",
  {
    description: "Find texture references in the project.",
    inputSchema: {
      texture_name: z.string().describe("Texture name to search for"),
      match_mode: z.string().optional().describe("Match mode: 'exact', 'contains', etc."),
      project_only: z.boolean().optional().describe("Restrict search to project assets only"),
    },
  },
  async (args) =>
    bridgeTool("texture_find", compact({ texture_name: args.texture_name, match_mode: args.match_mode, project_only: args.project_only }))
);

server.registerTool(
  "uefn_texture_summary",
  {
    description: "Get a grouped texture usage summary.",
    inputSchema: {
      texture_name: z.string().describe("Texture name to summarize"),
      match_mode: z.string().optional().describe("Match mode: 'exact', 'contains', etc."),
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) =>
    bridgeTool("texture_summary", compact({ texture_name: args.texture_name, match_mode: args.match_mode, project_only: args.project_only }))
);

server.registerTool(
  "uefn_texture_on_actor",
  {
    description: "List textures referenced by an actor.",
    inputSchema: {
      actor_label: z.string().describe("Label of the actor to inspect"),
    },
  },
  async (args) => bridgeTool("texture_on_actor", compact({ actor_label: args.actor_label }))
);

server.registerTool(
  "uefn_material_browse",
  {
    description: "Browse project materials.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("material_browse", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_material_unused",
  {
    description: "Find unused materials in the project.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("material_unused", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_niagara_browse",
  {
    description: "Browse Niagara particle systems.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("niagara_browse", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_niagara_usage",
  {
    description: "Show Niagara particle system usage across the level.",
    inputSchema: {},
  },
  async () => bridgeTool("niagara_usage", {})
);

server.registerTool(
  "uefn_dependency_scan",
  {
    description: "Scan asset dependencies.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("dependency_scan", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_health_scan",
  {
    description: "Run a health scan on the project.",
    inputSchema: {},
  },
  async () => bridgeTool("health_scan", {})
);

server.registerTool(
  "uefn_asset_sweep",
  {
    description: "Sweep and report on project assets.",
    inputSchema: {
      project_only: z.boolean().optional().describe("Restrict to project assets only"),
    },
  },
  async (args) => bridgeTool("asset_sweep", compact({ project_only: args.project_only }))
);

server.registerTool(
  "uefn_list_assets",
  {
    description:
      "List assets under a content-browser path via the Unreal Asset Registry (read-only, metadata only — no asset loads).",
    inputSchema: {
      path: z.string().describe("Content-browser path to list, e.g. /Game/Athena/Items or /YourProject/..."),
      recursive: z.boolean().optional().describe("Include assets in subfolders (default true)"),
      class_filter: z.string().optional().describe("Case-insensitive substring filter on the asset's class name"),
      limit: z.number().int().optional().describe("Maximum assets to return (default 500, max 2000)"),
    },
  },
  async (args) =>
    bridgeTool(
      "list_assets",
      compact({
        path: args.path,
        recursive: args.recursive,
        class_filter: args.class_filter,
        limit: args.limit,
      })
    )
);

server.registerTool(
  "uefn_inspect_asset",
  {
    description:
      "EXPERIMENTAL: load a single asset by path and reflect its editor-property values via Python (read-only — loads but never saves or modifies). Use to probe whether an opaque asset type exposes data to editor Python that isn't otherwise reachable from Verse or export. Output shape depends on undocumented per-class Python exposure and may vary across asset types or engine versions.",
    inputSchema: {
      asset_path: z
        .string()
        .describe(
          "Full object or package path, e.g. /YourProject/NPCCharDef_X or /YourProject/NPCCharDef_X.NPCCharDef_X"
        ),
      max_depth: z.number().int().optional().describe("Struct/array expansion depth (default 2, max 4)"),
    },
  },
  async (args) =>
    bridgeTool(
      "inspect_asset",
      compact({
        asset_path: args.asset_path,
        max_depth: args.max_depth,
      })
    )
);

server.registerTool(
  "uefn_moderation_scan",
  {
    description: `REMINDER — after you finish your analysis you MUST call \`uefn_moderation_report\` (see FINAL STEP below and the terminal \`next_required_action\` field in this tool's result); skipping it means the creator sees nothing in the UEFN editor even though your chat reply looks complete.

Predict what Fortnite/UEFN island moderation may flag BEFORE submission, so a creator can fix issues pre-emptively. This mirrors Epic's documented review pipeline, IN ORDER: (1) an automated pre-check that runs on publish against the island's title, thumbnail, and lobby background — Rule 1.13 "Keep It Authentic" plus a near-duplicate title/thumbnail check; (2) a METADATA & ASSET review covering island name, description, loading-screen text, thumbnail, lobby background, promotional screenshots, trailers, AND the underlying assets — a violation found at this stage SHORT-CIRCUITS the process, so the in-island gameplay review never even happens; (3) only if metadata/assets pass, an in-island gameplay review. Collector-only tool (no runtime AI in the shipped bridge) — this call returns raw structured evidence; YOU (the calling LLM) must do all the judgment and produce the report described below.

TRANSPORT SAMPLING: on a large project the full result would be tens of MB, too large for this bridge to transport, so every returned LIST here is a representative SAMPLE (highest-risk entries — HLOD/external-actor assets, text_metadata Unicode hits — are prioritized to survive the sample first). Every COUNT field (total_registry_assets, project_asset_count, shared_game_mount_asset_count, unicode_risks.total_count, etc.) is exact and NEVER sampled. Base scale/severity judgments on the counts, and check the \`*_omitted_count\` fields and the \`notes\` array before assuming a short list means "nothing else found" — it may only mean the rest was sampled away for transport, not that it doesn't exist.

SCOPE: only the creator's OWN project is in scope for findings — never Epic-owned shared/engine content. Draw every reportable finding from PROJECT-mount assets (\`project_asset_count\`, \`import_provenance\`, project-scoped \`asset_surfaces\`/\`hlod_or_imported_assets\` entries). \`shared_game_mount_asset_count\` and engine counts exist ONLY to let you reconcile totals (project + shared + engine ≈ total_registry_assets) — never report a shared-mount or engine asset as something the creator authored or should fix. If the payload carries a project-scope warning (e.g. an unresolved/unconfirmed project mount), say so plainly and do not imply a scoped, clean result — an unresolved scope is a caveat on your ENTIRE report, not something to silently drop.

THE SINGLE HIGHEST-VALUE SIGNAL is \`import_provenance\`: assets whose original AssetImportData source path is classified \`external_user_dir\` (Downloads/Desktop/Temp) or \`outside_project\` were imported from OUTSIDE the editor — i.e. the content was downloaded from the open internet rather than authored in-editor. A real rejected island's offending asset carried exactly this: an AssetImportData RelativeFilename pointing into the creator's browser Downloads folder, for a file literally named with a platform QR indicator. This is the strongest single predictor of BOTH Rule 1.7 (unauthorized third-party content) and Rule 1.12 (external-link material) risk in the entire payload — higher-value than asset names alone. Enumerate every \`external_user_dir\`/\`outside_project\` item INDIVIDUALLY in your report, not summarized as a count — each needs its own per-asset judgment. Importing from Downloads is NOT itself a violation (legitimate personal art gets imported the same way); frame it correctly as a PROVENANCE FLAG that the content likely originated off-platform and therefore warrants explicit review for both 1.7 and 1.12, not as proof of a violation. \`file_md5\` lets you identify the same downloaded file re-imported under a different asset name — call this out if you see a repeat. Source paths are typically a user-profile downloads or desktop directory and embed the creator's OS username — reference the asset name/path in your report, not the raw source path, so you don't gratuitously echo it.

CORRECTED PRIORITY — \`hlod_or_imported_assets\` is NOT the top signal and a large count there is NORMAL, EXPECTED, and NOT itself a finding: HLOD proxies are engine-generated per streaming cell, so a real project can show tens of thousands of entries that are pure generated noise (one real scan returned 48,412 HLOD entries with exactly one legible name after sampling). Do not report HLOD volume as a risk. HLOD only matters as a CARRIER — a generated proxy can bake in a name or texture inherited from an offending SOURCE asset — so when an HLOD entry does look suspicious, trace it back to the human-authored source (cross-check \`import_provenance\` and \`asset_surfaces\`) and treat THAT source as the actual analysis target, not the proxy itself. If present, \`hlod_generated_count\` is the exact engine-generated count, kept separate from anything that actually warrants a human look.

RULE CATEGORIES to evaluate every surface against:
- Section 1.7 "Respect IP Ownership" — third-party brands/franchises, Epic-owned IP used without authorization, key art, logos, product names, recognizable character names, in names/descriptions/text/asset paths/Verse strings.
- Section 1.13 "Keep It Authentic" — banned reward-bait tokens (AFK, XP farm, coin farm, coin slide, V-Bucks, Battle Pass, real-money or reward bait language); island metadata (name/description/thumbnail) must accurately represent actual gameplay; community-confirmed additional red flags: arrow graphics or before/after stat comparison graphics in thumbnails, and real photographs of real people anywhere in metadata/promo imagery.
- Section 1.12 "Keep It on the Island" — do not include external links ANYWHERE on the island or in its metadata: URLs, invite links (Discord/social), social handles, or QR/scannable codes. This is a BLOCKER, not a WARN — unlike 1.7 there is no licensing nuance or legitimate exception; it is an unambiguous, documented, automatically-detectable violation. It fires on ASSET INTERNAL NAMES exactly like 1.7 does — a texture named e.g. \`discord_QR\` is a hit even if never placed in the level, and Epic will name neither the asset nor the rule clearly. CRITICAL LIMITATION: the collector cannot decode image pixels, so a QR code baked into a texture with an innocuous filename is INVISIBLE to \`external_link_risks\`/\`first_pass_hints.external_link_hits\`. An empty result from either is NOT evidence of no external links — you MUST (a) visually inspect any provided \`image_paths\` for QR codes, URLs, or social handles if you have vision capability, and (b) directly ASK the creator whether any billboard, poster, decal, or texture displays a QR code, URL, or social handle before reporting 1.12 as clean.

\`allowlist\` (franchises/brands the CALLER is licensed for) changes how you REPORT a hit, not whether you report it: split IP hits into "expected licensed IP (still may be matched by Epic's automated system — report anyway)" versus "unexpected IP token — investigate, not covered by any stated license". Make explicit in your output that the allowlist reflects the creator's legal RIGHTS, not immunity from Epic's automated matcher.

\`image_paths\`: the collector deliberately does NOT do pixel/perceptual analysis (no image libraries — stdlib-only bridge). If you have vision capability, visually inspect these image files yourself for logos, third-party brand marks, Epic key art, real photos of people, and arrow/before-after stat graphics in thumbnails — this tool cannot do that part for you. \`image_paths\` may also include JPEG thumbnails BYTE-EXTRACTED directly from suspect \`.uasset\` files (UE embeds one; capped at 40) — this is the one place the scan moves from "the name looks suspicious" to "I can see what it actually is." ACTUALLY LOOK at each one and state plainly, per image, whether it shows a QR code, URL, social handle, logo, or a recognizable third-party character — don't just note that thumbnails were provided.

\`import_provenance\` — see "THE SINGLE HIGHEST-VALUE SIGNAL" above. \`{total_imported_assets, items[], by_classification, note}\`, each item \`{object_path, display_name, source_path, classification, file_md5, timestamp}\` (classification: external_user_dir | outside_project | in_project | unknown). Read defensively — this key may be absent entirely on an older staged Python copy; treat its absence as "not available," never as "nothing was imported."

\`image_metadata\`: embedded PNG text chunks / JPEG EXIF-IPTC fields (Author, Copyright, Title, Software, etc.). This is a BONUS check beyond anything Epic is known to scan — a third-party copyright or author string here is a strong signal the image was imported from elsewhere and is worth a closer look.

\`unicode_risks\` — TREAT AS HIGH PRIORITY. \`{available, items[], total_count, omitted_count, notes}\`, each item \`{surface, field_or_file, char, codepoint ("U+XXXX"), name, kind, context_snippet}\`. A structural, brand-neutral detector (no wordlist) that flags emoji, pictographs, ZWJ sequences, variation selectors, symbol-category characters, and unusual non-ASCII punctuation across EVERY text surface (text metadata field values, Verse strings/labels, asset display names, audio names) — it flags ANY such character, so use judgment about which are decorative versus meaningful before reporting. This directly matches a reproduced creator finding: an ordinary emoji in metadata caused a Rule 1.7 flag, and removing that one emoji caused a DIFFERENT emoji to get flagged next. If the rejection notice named the description/metadata, recommend stripping ALL emoji, decorative Unicode, trademark/registered symbols, styled bullets, and unusual punctuation as the FIRST controlled diagnostic pass — it is cheap, reversible, and matches the documented case exactly. Report the specific codepoints and the surface they were found in so the creator can remove them precisely.

\`redirectors\`: ObjectRedirector assets found in the project — deleted or renamed content that is still reachable through the redirector. Renaming or deleting a flagged asset does NOT clear the underlying match if a redirector still points to it. Recommend "Fix Up Redirectors" and auditing soft references, HLODs, Sequencer, Niagara, and any generated/derived data that may still reference the original package.

\`external_actor_assets\`: packages found under \`__ExternalActors__\` / \`__ExternalObjects__\` (generated actor/object packages, a byproduct of HLOD and world-partition generation). This exact class of generated asset was specifically implicated in repeated creator sanctions even on accounts with an active, valid brand tag for the licensed IP involved. As with HLOD (see CORRECTED PRIORITY above), the volume here is not itself a finding — treat a hit as worth tracing back to its human-authored source (cross-check \`import_provenance\`), with the same weight you'd give a flagged source asset.

\`text_field_lengths\`: per-field character counts for text metadata fields. The tool deliberately does NOT hardcode a platform character limit (limits change without notice). Note explicitly in your report that the text ACTUALLY SUBMITTED is the authoritative evidence for a length-related rejection, and that its length should be checked against the CURRENT publishing-portal limit — a longer planning/draft description in this field may differ from what was actually submitted.

\`image_provenance\`: per image \`{file, has_provenance_fields, fields_present[]}\` — flags when an image carries embedded authoring-tool, creator, or copyright metadata fields. Presence of these fields is a signal the image may have come from an external tool or download rather than an in-editor capture. Combine this with the existing guidance that promotional images should be ORIGINAL captures from the editor, replay, or island — downloaded renders and externally-rendered extracted models are a risk even when the character is authorized.

\`external_link_risks\` — TREAT AS BLOCKER-TIER, HIGH PRIORITY. \`{total_count, items[], by_surface, note}\`, each item \`{surface, location, text, kind}\` (kind: url|www|domain|invite_path|scannable_code_token|handle). A structural, brand-neutral detector for Rule 1.12 evidence across every text surface (asset names/paths, Verse strings, text metadata, image metadata, audio names) — this is a real, distinct rule from 1.7/1.13, not a subset of either. Combine with \`first_pass_hints.external_link_hits\` (the wordlist first pass over platform names like discord/twitter/tiktok/twitch and CTA phrasing like "join our"/"scan the code"/"qr code") and \`first_pass_hints.external_link_structural_count\` (the count from this field, folded in for convenience). Remember the vision limitation above: this field can be empty while a QR code still exists baked into image pixels, so treat an empty result as inconclusive, not clean, and ask the creator directly.

\`first_pass_hints\` (authenticity_hits / ip_seed_hits / media_title_hits / endorsement_hits / disclaimer_hits / external_link_hits): cheap, non-exhaustive literal wordlist matches only, meant to prioritize what to look at first. \`media_title_hits\` flags exact franchise film/TV/game/book/comic titles found in any text surface (a real Rule 1.7 category even when the underlying character is authorized — see failure mode #2 below); \`endorsement_hits\` flags wording implying official endorsement/approval (#9 below); \`disclaimer_hits\` flags disclaimer-shaped text in the creator's own description, which is a documented trigger when the publishing flow already supplies the required disclaimer automatically (#3 below). They are NOT a verdict — you must independently judge every surface (asset_surfaces, hlod_or_imported_assets, verse_surfaces, text_metadata, image_metadata) for IP and authenticity issues the wordlists wouldn't catch, and must also be willing to dismiss a wordlist hit that's clearly a false positive (e.g. "battle pass" as unrelated flavor text). \`first_pass_hints.no_other_findings_candidate\` is a boolean nudge (true when the wordlist first pass found licensed IP in \`expected_licensed\` but nothing in \`authenticity_hits\`, \`investigate\`, \`external_link_hits\`, or \`external_link_structural_count\`) — it is only a hint toward the KNOWN-RISK case below, never a substitute for your own independent review of every surface. An external-link finding of any kind means this is false: a 1.12 hit is itself another finding, so KNOWN-RISK ("licensed IP is the only candidate cause") does not apply when one is present.

REPORT FORMAT: group every finding by severity — BLOCKER (would very likely short-circuit metadata/asset review), WARN (real risk, judgment call), KNOWN-RISK (see below), INFO (worth knowing, low risk).

KNOWN-RISK — licensed IP as the residual cause: emit this whenever licensed/allowlisted IP surfaces are present (\`expected_licensed\` non-empty, or your own review of \`asset_surfaces\`/\`hlod_or_imported_assets\` finds licensed models), and ESPECIALLY when the scan otherwise comes back clean of BLOCKER/WARN findings — \`first_pass_hints.no_other_findings_candidate: true\` is a hint toward this case. When nothing else was found, state plainly that the licensed IP assets are the most likely trigger. This is NOT a rule violation and NOT something the creator did wrong — it is a documented false-positive pattern in Epic's automated matcher, which has flagged Epic's own officially-provided licensed assets (e.g. a Star Wars AT-AT, a Star Wars lightsaber workbench) on accounts with an active, valid brand tag for that IP, with appeals rejected. Never phrase this as fault, and never tell the creator to remove content they are licensed to use. Model suggested wording (adapt, don't force verbatim): "No other violations found. Your licensed IP assets are the most likely trigger — Epic's automated matcher has flagged officially-provided licensed assets before, even with an active brand tag. This is a known false-positive pattern, not something you did wrong." Include these actionable next steps with every KNOWN-RISK finding: (1) inspect/rebuild the HLODs that CONTAIN THE SPECIFIC LICENSED MODELS you identified — HLOD \`.uasset\` files were the actual flagged targets in the documented cases, not the source assets themselves; this is about tracing a specific known source into its generated proxies, not treating HLOD volume itself as evidence (see CORRECTED PRIORITY above — the bulk of HLOD entries on any project is normal generated noise); (2) read the full REJECTION EMAIL, not just the in-app banner — the email has been confirmed to sometimes name the exact offending file (seen for copyrighted-audio rejections) when the in-app notice doesn't; (3) if appealing, explicitly cite the active brand tag / licensed-program participation; (4) list the specific licensed asset paths from \`expected_licensed\` and \`import_provenance\` so the creator has the exact strings Epic's matcher sees, since Epic won't disclose them.

For every finding (any severity) give: the exact surface (file path / asset or package path / metadata field), the offending token or the reason it was flagged, which rule it maps to (1.7 or 1.13, or "automated pre-check"), and a concrete suggested fix or next step. Close the report with this caveat, stated plainly: this tool PREDICTS risk and cannot guarantee approval — Epic's moderation system is opaque, changes without notice, and has been documented flagging even its own officially licensed content.

KNOWN RULE 1.7 FAILURE MODES — documented creator-reported patterns, distinct from the wordlists above. Check every surface against ALL of these even when no wordlist term matched; several are asset- or workflow-level, not text matches:
1. Emoji / decorative Unicode in metadata — a reproduced creator finding: ordinary emoji (including check/cross symbols) on in-island text were flagged under 1.7, and removing one emoji caused a DIFFERENT emoji to get flagged next. Treat emoji, decorative Unicode, trademark symbols (™ ® ©), styled bullets, and unusual punctuation anywhere in title/description/loading-screen text as a real risk and a high-value first thing to strip out and retest. Data for this: \`unicode_risks\`.
2. Exact media titles — film/TV/game/book/comic TITLES are prohibited in island title, description, thumbnail, promo imagery, videos, and in-island transactions, EVEN when the underlying character itself is authorized. Watch for dual-use terms that are simultaneously a character designation and a series title (e.g. "The Mandalorian") — flag these as plausible-but-unproven, not certain.
3. Manually entered disclaimers — some publishing flows add the required brand disclaimer automatically; a creator manually typing an equivalent into the description was a documented suspected trigger. Flag disclaimer-shaped text (e.g. "not affiliated with", "is a trademark of") found in the creator's own description.
4. HLOD and External Actor generated assets — officially-provided licensed assets have produced 1.7 findings ONLY AFTER being included in HLOD generation, and one creator reported roughly twenty sanctions tied to generated HLOD external-actor assets despite an active brand tag, with appeals denied. IMPORTANT: this is about a KNOWN licensed/flagged source getting baked into a generated proxy, not about HLOD count as a signal on its own — a large \`hlod_or_imported_assets\`/\`hlod_generated_count\` total is normal and expected (see CORRECTED PRIORITY above) and must not be reported as a finding by itself. Audit HLOD/generated/external-actor packages only once you've identified a specific source worth tracing (via \`import_provenance\` or a wordlist/vision hit), even when the rejection notice names the description. Data for this: \`hlod_or_imported_assets\`, \`hlod_generated_count\`, \`external_actor_assets\`, and \`import_provenance\`.
5. Renaming does not clear a match — a renamed imported asset kept getting flagged. Moderation may inspect visible asset content, the ORIGINAL import metadata, references to the original package, brand configuration, derived data, or prior moderation history, not just the current file name. Recommend "Fix Up Redirectors" and auditing soft references, HLODs, Sequencer, and Niagara. Data for this: \`redirectors\`.
6. Deleted content reachable via redirectors/soft references — deleting or replacing an asset (notably audio) can leave it still reachable through a redirector or soft reference; a licensed replacement audio track still produced a finding in one report. Data for this: \`redirectors\`.
7. Promotional renders not captured in-editor — reusing an existing online/official promotional render, rather than an original capture from the UEFN editor, replay, or island, is a documented cause. Promotional images should be ORIGINAL captures; downloaded transparent renders, key art, and externally-rendered extracted models are a risk even when the character is authorized. Data for this: \`image_provenance\`.
8. Replace ALL image fields together — replacing a single thumbnail repeatedly still failed in one report. Recommend replacing both A/B thumbnails, the lobby background, promotional screenshots, AND any trailer carrying the same imagery together, then generating a NEW private version and a NEW public release — not editing the same release in place.
9. Logos and partner branding — an asset being supplied by Epic does not authorize every promotional use, scale, placement, or logo treatment. Official or similarly-styled logos and affiliate/parent entity names are prohibited even under an officially licensed program.
10. Licensed-program participation does not bypass moderation — a partner-program island was still removed under 1.7 despite the creator believing they complied with the brand rules; the license is limited and conditional, not blanket immunity.
11. Audio license scope — a commercial/subscription music license may permit video use but not grant interactive-game distribution or the sublicensing rights the platform requires. Attribution is not permission — check whether the license actually covers interactive distribution.
12. Description length — a longer planning/draft description may exceed the live description character limit. The text ACTUALLY submitted and displayed in the release, not a longer draft document, is the authoritative evidence when diagnosing a rejection. Data for this: \`text_field_lengths\`.

CONTROLLED RESUBMISSION — when advising next steps after a rejection, recommend a DISCIPLINED retry, not blind resubmission: change ONE category at a time, starting with whichever category the rejection notice actually named; preserve the exact text/assets that were submitted as evidence; after a correction, generate a NEW private version and a NEW public release rather than editing in place; document each attempt with screenshots of the description, disclaimer, promotional media, and moderation result. State explicitly that repeated Rule 1.7 enforcement has been reported to escalate to temporary loss of publishing/monetization privileges, so blind repeated resubmission is itself a risk, not a safe way to iterate. When appealing, recommend requesting identification of the exact phrase, file, package path, or promotional asset associated with the finding — Epic's notices frequently do not name it.

FINAL STEP — after you finish writing the report above, call \`uefn_moderation_report\` (do not skip this) with the full formatted report text as \`report\`, a one-line overall verdict as \`summary\`, and a count of findings per severity as \`severity_counts\` (BLOCKER / WARN / KNOWN_RISK / INFO). This posts your finished analysis back into the UEFN editor so it renders inside the Power Tools "IP / Moderation Scan" window — the creator reads your results there without switching apps or scrolling this chat.`,
    inputSchema: {
      project_dir: z.string().optional().describe("Path to the UEFN project to scan; defaults to the live/resolved project root"),
      allowlist: z
        .array(z.string())
        .optional()
        .describe(
          "Franchises/brands the creator is LICENSED to use. Does not exempt matches from being reported — only changes how they're categorized (expected licensed IP vs. unexpected IP token)."
        ),
    },
  },
  async (args) => {
    try {
      // A full asset-registry sweep on a large project (hundreds of
      // thousands to low millions of assets) genuinely takes longer than
      // the default 30s bridge budget — give this specific tool a much
      // larger allowance rather than raising the default for every tool.
      const raw = await callBridge(
        "moderation_scan",
        compact({
          project_dir: args.project_dir,
          allowlist: args.allowlist,
        }),
        180_000
      );
      return ok(appendModerationNextRequiredAction(attachModerationHints(raw, args.allowlist)));
    } catch (e) {
      if (e instanceof BridgeError) return err(`Bridge error: ${e.message}`);
      if (e instanceof TimeoutError) return err(`Bridge error: ${e.message}`);
      return err(`Bridge error: ${String(e)}`);
    }
  }
);

server.registerTool(
  "uefn_moderation_report",
  {
    description:
      "This is the ONLY delivery mechanism for a moderation analysis — if you skip this call, the creator sees NOTHING in the UEFN editor, no matter how complete your chat reply looks. Post the calling LLM's FINISHED moderation analysis back into the UEFN editor so it renders inside the Power Tools \"IP / Moderation Scan\" window — the creator reads the results there without switching apps. Call this AFTER completing the analysis from `uefn_moderation_scan`, not before: pass the full formatted report text (the same BLOCKER/WARN/KNOWN-RISK/INFO write-up you produced), a one-line overall summary/verdict, and a count of findings per severity. The bridge writes this to disk and stamps its own timestamp; nothing here is displayed until this tool is called.",
    inputSchema: {
      report: z.string().describe("Full formatted moderation report text (the complete analysis, grouped by severity)"),
      summary: z.string().optional().describe("One-line overall verdict, e.g. '2 WARN, 1 KNOWN-RISK — review licensed-asset HLODs before publish'"),
      severity_counts: z
        .object({
          BLOCKER: z.number().int().optional(),
          WARN: z.number().int().optional(),
          KNOWN_RISK: z.number().int().optional(),
          INFO: z.number().int().optional(),
        })
        .optional()
        .describe("Count of findings per severity in the report"),
    },
  },
  async (args) =>
    bridgeTool(
      "moderation_report_save",
      compact({
        report: args.report,
        summary: args.summary,
        severity_counts: args.severity_counts,
      })
    )
);

// ── Start ─────────────────────────────────────────────────────────────────────

console.error(`[trashbyrd-uefn] Starting MCP server. Bridge dir: ${BRIDGE_DIR}`);

const transport = new StdioServerTransport();
await server.connect(transport);
