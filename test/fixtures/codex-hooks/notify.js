const fs = require('fs');
const path = require('path');
const data = process.argv.slice(2).join(' ');
fs.appendFileSync(path.join(__dirname, 'raw-notify.jsonl'), JSON.stringify({argv: process.argv.slice(2), captured_at: new Date().toISOString()}) + '\n');
