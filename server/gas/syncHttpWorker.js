'use strict';

const fs = require('fs');

async function main() {
  const inFile = process.argv[2];
  const outFile = process.argv[3];
  const req = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const init = {
    method: req.method || 'GET',
    headers: req.headers || {}
  };
  if (req.body !== null && req.body !== undefined) {
    init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }
  const res = await fetch(req.url, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    fs.writeFileSync(outFile, JSON.stringify({
      ok: false,
      error: 'HTTP ' + res.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data))
    }));
    process.exit(1);
  }
  fs.writeFileSync(outFile, JSON.stringify({ ok: true, data }));
}

main().catch((err) => {
  try {
    fs.writeFileSync(process.argv[3], JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
  } catch (e) { /* ignore */ }
  process.exit(1);
});
