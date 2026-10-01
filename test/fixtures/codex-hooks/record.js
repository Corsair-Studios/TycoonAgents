const fs = require('fs');
const path = require('path');
let data = '';
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const event = process.argv[2] || 'UNKNOWN';
  const out = path.join(__dirname, 'raw-hooks.jsonl');
  let parsed;
  try { parsed = JSON.parse(data); } catch(e) { parsed = { _unparsed: data }; }
  const line = JSON.stringify({ event_arg: event, codex_version: '0.153.0', captured_at: new Date().toISOString(), payload: parsed }) + '\n';
  fs.appendFileSync(out, line);
  process.exit(0);
}
// Never hang: a TTY stdin has no data to wait for, and a pipe that stays open
// without sending gets ~2s before we write what we have and exit.
if (process.stdin.isTTY) {
  finish();
} else {
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 2000);
}
