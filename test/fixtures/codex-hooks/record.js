const fs = require('fs');
const path = require('path');
let data = '';
process.stdin.on('data', d => data += d);
process.stdin.on('end', () => {
  const event = process.argv[2] || 'UNKNOWN';
  const out = path.join(__dirname, 'raw-hooks.jsonl');
  let parsed;
  try { parsed = JSON.parse(data); } catch(e) { parsed = { _unparsed: data }; }
  const line = JSON.stringify({ event_arg: event, codex_version: '0.153.0', captured_at: new Date().toISOString(), payload: parsed }) + '\n';
  fs.appendFileSync(out, line);
  process.exit(0);
});
