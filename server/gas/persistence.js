'use strict';

const fs = require('fs');
const path = require('path');
const { syncFetchJson } = require('./syncHttp');

/**
 * Persistence backends for the Apps Script spreadsheet shim.
 * - file: local / Render disk
 * - redis: Upstash or Vercel KV REST (required for durable data on Vercel)
 */

function createFileBackend(dbDir) {
  const sheetsDir = path.join(dbDir, 'sheets');
  fs.mkdirSync(sheetsDir, { recursive: true });
  const propsPath = path.join(dbDir, 'props.json');
  const cachePath = path.join(dbDir, 'cache.json');

  function readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  function sheetFile(name) {
    return path.join(sheetsDir, encodeURIComponent(name) + '.json');
  }

  return {
    type: 'file',
    listSheets() {
      if (!fs.existsSync(sheetsDir)) return [];
      return fs.readdirSync(sheetsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => decodeURIComponent(f.replace(/\.json$/, '')))
        .sort();
    },
    loadSheet(name) {
      const file = sheetFile(name);
      if (!fs.existsSync(file)) return null;
      return readJson(file, null);
    },
    saveSheet(name, serializedGrid) {
      writeJson(sheetFile(name), serializedGrid);
    },
    deleteSheet(name) {
      const file = sheetFile(name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
    getProps() { return readJson(propsPath, {}); },
    setProps(props) { writeJson(propsPath, props); },
    getCache() { return readJson(cachePath, {}); },
    setCache(cache) { writeJson(cachePath, cache); }
  };
}

function createRedisBackend(url, token) {
  const prefix = process.env.REDIS_KEY_PREFIX || 'expsched:';
  const base = url.replace(/\/$/, '');

  function command(args) {
    // Upstash / Vercel KV REST: POST body is JSON array command
    const data = syncFetchJson(base, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: args
    });
    return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : data;
  }

  function key(k) { return prefix + k; }

  return {
    type: 'redis',
    listSheets() {
      const keys = command(['KEYS', key('sheet:*')]) || [];
      return keys.map((k) => decodeURIComponent(String(k).slice(key('sheet:').length))).sort();
    },
    loadSheet(name) {
      const raw = command(['GET', key('sheet:' + encodeURIComponent(name))]);
      if (raw == null) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    saveSheet(name, serializedGrid) {
      command(['SET', key('sheet:' + encodeURIComponent(name)), JSON.stringify(serializedGrid)]);
    },
    deleteSheet(name) {
      command(['DEL', key('sheet:' + encodeURIComponent(name))]);
    },
    getProps() {
      const raw = command(['GET', key('props')]);
      if (raw == null) return {};
      return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    },
    setProps(props) {
      command(['SET', key('props'), JSON.stringify(props)]);
    },
    getCache() {
      const raw = command(['GET', key('cache')]);
      if (raw == null) return {};
      return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    },
    setCache(cache) {
      command(['SET', key('cache'), JSON.stringify(cache)]);
    }
  };
}

function resolveBackend(dbPath) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    return createRedisBackend(redisUrl, redisToken);
  }

  const isVercel = !!(process.env.VERCEL || process.env.NOW_REGION);
  if (isVercel && String(process.env.ALLOW_EPHEMERAL_DATA || '') !== '1') {
    console.warn(
      '[persistence] Vercel detected without Upstash/Vercel KV. ' +
      'Data will be ephemeral unless UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set. ' +
      'Set ALLOW_EPHEMERAL_DATA=1 to silence this warning.'
    );
  }

  const dbDir = dbPath.endsWith('.sqlite') || dbPath.endsWith('.db')
    ? path.join(path.dirname(dbPath), path.basename(dbPath, path.extname(dbPath)) + '_store')
    : dbPath;
  return createFileBackend(dbDir);
}

module.exports = { resolveBackend, createFileBackend, createRedisBackend };
