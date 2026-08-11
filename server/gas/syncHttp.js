'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Synchronous JSON HTTP helper for serverless (Vercel has no curl guarantee).
 * Spawns a short-lived node process that uses fetch, then returns parsed JSON.
 */
function syncFetchJson(url, options) {
  options = options || {};
  const payload = {
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body === undefined ? null : options.body
  };
  const inFile = path.join(os.tmpdir(), 'synchttp_in_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.json');
  const outFile = path.join(os.tmpdir(), 'synchttp_out_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(inFile, JSON.stringify(payload));
  const helper = path.join(__dirname, 'syncHttpWorker.js');
  const result = spawnSync(process.execPath, [helper, inFile, outFile], {
    encoding: 'utf8',
    timeout: 30000,
    env: process.env
  });
  try {
    if (result.status !== 0) {
      const errText = (result.stderr || result.stdout || '').toString();
      throw new Error(errText || 'syncFetchJson failed');
    }
    const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (!out.ok) throw new Error(out.error || 'HTTP error');
    return out.data;
  } finally {
    try { fs.unlinkSync(inFile); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
  }
}

module.exports = { syncFetchJson };
