#!/usr/bin/env node
// scripts/probe-epic-mcp.mjs
//
// Reproducible probe for the UEFN/Epic "Verse MCP" server exposed via
// Project Settings -> Python Editor Scripting + UEFN MCP Toolsets.
//
// Speaks MCP "streamable HTTP": POST initialize, capture the session id,
// POST notifications/initialized, then tools/list, list_toolsets, and
// describe_toolset per toolset. Prints a per-toolset tool count table and
// a grand total.
//
// CRITICAL protocol details (each cost a failed attempt to discover):
//   - The server may reply with either `application/json` or
//     `text/event-stream`. For SSE, the body is a sequence of `data: ...`
//     lines; concatenate those lines' payloads and parse the result as one
//     JSON document.
//   - Regardless of content-type, the JSON body is PRETTY-PRINTED across
//     many lines. Never scan line-by-line for a leading '{' to find a
//     JSON message -- parse the ENTIRE body as one JSON value.
//   - The Mcp-Session-Id the server assigns arrives as a RESPONSE HEADER
//     on the `initialize` call (not in the JSON body). It must be echoed
//     as a request header (`Mcp-Session-Id`) on every subsequent request
//     in the session, including notifications/initialized.
//   - `list_toolsets` returns human-readable text, not JSON. Toolset names
//     are dotted `Namespace.ToolsetName` and appear as bullet lines. A
//     naive "any bullet is a toolset" regex scrapes prose fragments from
//     the surrounding description text and yields dozens of fake
//     zero-tool toolsets. Only lines matching
//       /^-\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*:/
//     are real toolset names.
//   - `describe_toolset` returns a JSON STRING (as the tool result text)
//     containing a `tools` array. Parse that JSON string -- do not regex
//     the text for tool names. Its input parameter is named
//     `toolset_name` (not `toolset`); calling it with the wrong key name
//     fails with the plain-text tool error "Missing required parameter:
//     toolset_name" delivered via result.isError, not a JSON-RPC error.
//   - IMPORTANT for anyone extending this script to call real tools:
//     `call_tool` takes the SHORT tool name (e.g. "FindEntities"), never
//     the fully-qualified "Namespace.ToolsetName.FindEntities" form -- the
//     fully-qualified form returns an "Unknown tool" error.
//
// Node ESM, node:http only -- no new dependencies (project rule).

import http from 'node:http';
import { URL } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:8000/mcp';
const ENABLE_HINT =
  'Enable it in UEFN via Project Settings -> Python Editor Scripting + UEFN MCP Toolsets, ' +
  'then relaunch UEFN with the project open.';

function parseArgs(argv) {
  let url = DEFAULT_URL;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') {
      url = argv[++i];
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    } else if (arg === '--json') {
      json = true;
    }
  }
  return { url, json };
}

function fail(message) {
  process.stderr.write('probe-epic-mcp: ' + message + '\n');
  process.exit(1);
}

/**
 * Extract the JSON payload from a raw HTTP response body, honoring both
 * `application/json` (parse the whole body as one JSON value -- it may be
 * pretty-printed across many lines) and `text/event-stream` (concatenate
 * every `data: ` line's payload, then parse that as one JSON value).
 */
function extractJsonBody(contentType, rawBody) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();

  if (type === 'text/event-stream') {
    const dataLines = rawBody
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());
    if (dataLines.length === 0) {
      throw new Error('SSE response contained no data: lines');
    }
    return JSON.parse(dataLines.join(''));
  }

  // application/json (or anything else): parse the whole body at once.
  // Never scan line-by-line for a leading '{' -- the server pretty-prints
  // JSON across multiple lines and that approach finds nothing.
  return JSON.parse(rawBody);
}

/**
 * Issue one JSON-RPC request against the MCP streamable-HTTP endpoint.
 * Returns { json, headers }. `sessionId` (if set) is echoed as the
 * Mcp-Session-Id request header.
 */
function rpcRequest(targetUrl, sessionId, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                'HTTP ' + res.statusCode + ' from ' + targetUrl.href + ': ' + rawBody.slice(0, 500)
              )
            );
            return;
          }
          // Notifications (no id in payload) may receive an empty 202 body.
          if (!rawBody.trim()) {
            resolve({ json: null, headers: res.headers });
            return;
          }
          try {
            const json = extractJsonBody(res.headers['content-type'], rawBody);
            resolve({ json, headers: res.headers });
          } catch (err) {
            reject(
              new Error('Failed to parse response body from ' + targetUrl.href + ': ' + err.message)
            );
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(
        new Error(
          'Could not reach MCP server at ' + targetUrl.href + ' (' + (err.code || err.message) + '). ' +
            ENABLE_HINT
        )
      );
    });

    req.write(body);
    req.end();
  });
}

function nextId(state) {
  state.id += 1;
  return state.id;
}

/**
 * Call an MCP tool by name (SHORT name only -- call_tool rejects the
 * fully-qualified "Namespace.ToolsetName.Tool" form with "Unknown tool")
 * and return the parsed result. Most tool results arrive as
 * result.content[0].text, sometimes itself a JSON string.
 */
async function callTool(targetUrl, sessionId, state, shortName, args) {
  const { json } = await rpcRequest(targetUrl, sessionId, {
    jsonrpc: '2.0',
    id: nextId(state),
    method: 'tools/call',
    params: { name: shortName, arguments: args || {} },
  });
  if (!json || json.error) {
    const msg = json && json.error ? json.error.message : 'empty response';
    throw new Error('call_tool(' + shortName + ') failed: ' + msg);
  }
  const content = json.result && json.result.content;
  const text =
    Array.isArray(content) && content.length > 0 && typeof content[0].text === 'string'
      ? content[0].text
      : null;
  // The MCP tool call itself can succeed at the JSON-RPC level while the
  // tool logic fails; that failure is reported via result.isError with a
  // plain-text (non-JSON) message in content[0].text, not a JSON-RPC error.
  if (json.result && json.result.isError) {
    throw new Error('call_tool(' + shortName + ') reported an error: ' + (text || 'unknown error'));
  }
  if (text !== null) {
    return text;
  }
  return json.result;
}

/**
 * Parse list_toolsets' human-readable output for dotted toolset names.
 * Only lines of the form "- Namespace.ToolsetName: description..." count;
 * a bare bullet-line regex also matches prose fragments in the
 * surrounding description text and produces fake zero-tool toolsets.
 */
function parseToolsetNames(listToolsetsText) {
  const pattern = /^-\s+([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*:/;
  const names = [];
  for (const line of listToolsetsText.split(/\r?\n/)) {
    const match = pattern.exec(line.trim());
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * describe_toolset's result text is a JSON STRING containing a `tools`
 * array (not prose to regex). Parse it and return the array (or [] if
 * absent/malformed shape).
 */
function parseDescribeToolset(describeText) {
  const parsed = JSON.parse(describeText);
  if (Array.isArray(parsed.tools)) {
    return parsed.tools;
  }
  return [];
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const urlArg = parsedArgs.url;
  const jsonOutput = parsedArgs.json;

  let targetUrl;
  try {
    targetUrl = new URL(urlArg);
  } catch (err) {
    fail('invalid --url "' + urlArg + '": ' + err.message);
    return;
  }

  const state = { id: 0 };
  let sessionId = null;

  try {
    // 1. initialize -- capture Mcp-Session-Id from the RESPONSE HEADER.
    const initResult = await rpcRequest(targetUrl, null, {
      jsonrpc: '2.0',
      id: nextId(state),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'probe-epic-mcp', version: '1.0.0' },
      },
    });
    if (!initResult.json || initResult.json.error) {
      const msg =
        initResult.json && initResult.json.error
          ? initResult.json.error.message
          : 'no result';
      throw new Error('initialize failed: ' + msg);
    }
    sessionId = initResult.headers['mcp-session-id'];
    if (!sessionId) {
      throw new Error('initialize response did not include an Mcp-Session-Id header');
    }

    // 2. notifications/initialized -- required handshake completion.
    await rpcRequest(targetUrl, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // 3. tools/list -- sanity check the session is live.
    await rpcRequest(targetUrl, sessionId, {
      jsonrpc: '2.0',
      id: nextId(state),
      method: 'tools/list',
    });

    // 4. list_toolsets, then describe_toolset per toolset.
    const listToolsetsText = await callTool(targetUrl, sessionId, state, 'list_toolsets');
    const toolsetNames = parseToolsetNames(listToolsetsText);
    if (toolsetNames.length === 0) {
      throw new Error(
        'list_toolsets returned no dotted Namespace.ToolsetName entries -- parser or server response shape changed'
      );
    }

    const rows = [];
    let grandTotal = 0;
    for (const name of toolsetNames) {
      const describeText = await callTool(targetUrl, sessionId, state, 'describe_toolset', {
        toolset_name: name,
      });
      const tools = parseDescribeToolset(describeText);
      rows.push({ toolset: name, toolCount: tools.length });
      grandTotal += tools.length;
    }

    if (jsonOutput) {
      process.stdout.write(
        JSON.stringify({ url: targetUrl.href, toolsets: rows, grandTotal }, null, 2) + '\n'
      );
    } else {
      const nameWidth = Math.max(8, ...rows.map((r) => r.toolset.length));
      process.stdout.write('MCP server: ' + targetUrl.href + '\n\n');
      process.stdout.write('Toolset'.padEnd(nameWidth) + '  Tools\n');
      process.stdout.write('-'.repeat(nameWidth) + '  -----\n');
      for (const row of rows) {
        process.stdout.write(row.toolset.padEnd(nameWidth) + '  ' + row.toolCount + '\n');
      }
      process.stdout.write('-'.repeat(nameWidth) + '  -----\n');
      process.stdout.write('TOTAL'.padEnd(nameWidth) + '  ' + grandTotal + '\n');
    }

    if (grandTotal === 0) {
      throw new Error('describe_toolset reported zero tools across every toolset');
    }
  } catch (err) {
    fail(err.message + '\nURL tried: ' + targetUrl.href + '\n' + ENABLE_HINT);
  }
}

main();
