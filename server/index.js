'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

// Load .env only when present (local). Never crash if missing on Vercel.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) { /* ignore */ }

const isVercel = !!(process.env.VERCEL || process.env.NOW_REGION);
const isRender = !!process.env.RENDER;

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER &&
    process.env.SMTP_PASS && process.env.SMTP_FROM);
}

function googleConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
}

// Auto-enable demo mode on Vercel/Render when secrets are missing — prevents boot crash.
const demoMode = String(process.env.ALLOW_INSECURE_DEMO || '').toLowerCase() === 'true' ||
  String(process.env.ALLOW_INSECURE_DEMO || '') === '1' ||
  ((isVercel || isRender) && (!smtpConfigured() || !googleConfigured()));

if (demoMode) {
  process.env.ALLOW_INSECURE_DEMO = '1';
}

function ensureGoogleCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const dest = path.join(
        (isVercel || isRender) ? '/tmp' : path.join(__dirname, '..', 'credentials'),
        'google-service-account.json'
      );
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      fs.writeFileSync(dest, JSON.stringify(parsed, null, 2));
      process.env.GOOGLE_SERVICE_ACCOUNT_FILE = dest;
    } catch (err) {
      console.error('Failed to materialize Google credentials:', err);
      process.env.ALLOW_INSECURE_DEMO = '1';
    }
  }
}

ensureGoogleCredentials();

function resolveProjectRoot() {
  const candidates = [
    path.join(__dirname, '..'),
    process.cwd(),
    path.join(process.cwd(), '..'),
    '/var/task',
    path.join(__dirname, '..', '..')
  ];
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, 'Code.gs'))) return root;
  }
  // Fall back — runtime will throw a clearer error
  return path.join(__dirname, '..');
}

const projectRoot = resolveProjectRoot();
const detectedHost = process.env.BASE_URL
  || process.env.RENDER_EXTERNAL_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? ('https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL) : null)
  || (process.env.VERCEL_URL ? ('https://' + process.env.VERCEL_URL) : null)
  || 'http://localhost:3000';
const baseUrl = String(detectedHost).replace(/\/$/, '');
const timezone = process.env.SCRIPT_TIMEZONE || 'Europe/Berlin';
const ownerEmail = process.env.ADMIN_OWNER_EMAIL || 'altersstudie@lin-magdeburg.de';

const dataRoot = (isVercel || process.env.USE_TMP_DATA === '1')
  ? '/tmp/experiment-scheduler'
  : path.join(projectRoot, 'data');
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataRoot, 'scheduler.sqlite');
const driveDir = path.join(dataRoot, 'drive');

try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(driveDir, { recursive: true });
} catch (err) {
  console.error('mkdir data dirs failed:', err);
}

const g = globalThis;
if (!g.__experimentScheduler) g.__experimentScheduler = {};

function getRuntime() {
  if (g.__experimentScheduler.runtime) return g.__experimentScheduler.runtime;

  if (!fs.existsSync(path.join(projectRoot, 'Code.gs'))) {
    throw new Error(
      'Code.gs not found at projectRoot=' + projectRoot +
      '. cwd=' + process.cwd() + ' __dirname=' + __dirname +
      '. Ensure vercel.json includeFiles packs Code.gs.'
    );
  }

  const { createRuntime } = require('./gas/runtime');
  console.log('Loading Apps Script runtime (Code.gs) from', projectRoot);
  const runtime = createRuntime({
    dbPath,
    baseUrl: process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : baseUrl,
    timezone,
    ownerEmail,
    driveDir,
    projectRoot
  });
  runtime.call('initializeSpreadsheet', []);
  g.__experimentScheduler.runtime = runtime;
  return runtime;
}

function createApp() {
  const { renderTemplate } = require('./pages');

  if (!isVercel) {
    try { getRuntime(); } catch (err) {
      console.error('Startup initialize failed:', err);
      throw err;
    }
  }

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', function (_req, res) {
    const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL);
    res.json({
      ok: true,
      vercel: isVercel,
      persistence: hasRedis ? 'redis' : 'file',
      demoMode: String(process.env.ALLOW_INSECURE_DEMO || '') === '1',
      projectRoot,
      codeGs: fs.existsSync(path.join(projectRoot, 'Code.gs')),
      cwd: process.cwd()
    });
  });

  // Lazy-init runtime for pages/API (not for /health so health can diagnose missing files)
  function withRuntime(req, res, next) {
    try {
      getRuntime();
      next();
    } catch (err) {
      console.error('Runtime init failed:', err);
      res.status(500).type('html').send(
        '<h1>Server failed to start runtime</h1><pre>' +
        String(err && err.stack ? err.stack : err) +
        '</pre><p>projectRoot=' + projectRoot + '</p>'
      );
    }
  }

  app.get('/', withRuntime, function (req, res) {
    const page = String(req.query.page || '').toLowerCase();
    const action = String(req.query.action || '').toLowerCase();
    const admin = String(req.query.admin || '').toLowerCase();
    if (action === 'manage' || page === 'manage') return res.redirect('/manage');
    if (page === 'admin' || admin === 'true') return res.redirect('/admin');
    return res.redirect('/book');
  });

  app.get('/book', withRuntime, function (_req, res) {
    try {
      res.type('html').send(renderTemplate(projectRoot, 'Index'));
    } catch (err) {
      res.status(500).send(String(err && err.stack ? err.stack : err));
    }
  });

  app.get('/manage', withRuntime, function (_req, res) {
    try {
      res.type('html').send(renderTemplate(projectRoot, 'Manage'));
    } catch (err) {
      res.status(500).send(String(err && err.stack ? err.stack : err));
    }
  });

  app.get('/admin', withRuntime, function (_req, res) {
    try {
      res.type('html').send(renderTemplate(projectRoot, 'Admin'));
    } catch (err) {
      res.status(500).send(String(err && err.stack ? err.stack : err));
    }
  });

  app.get('/exec', withRuntime, function (req, res) {
    const page = String(req.query.page || '').toLowerCase();
    const action = String(req.query.action || '').toLowerCase();
    const admin = String(req.query.admin || '').toLowerCase();
    if (action === 'manage' || page === 'manage') return res.redirect('/manage');
    if (page === 'admin' || admin === 'true') return res.redirect('/admin');
    return res.redirect('/book');
  });

  app.post('/api/run', withRuntime, function (req, res) {
    const rt = getRuntime();
    const functionName = req.body && req.body.functionName;
    const args = (req.body && req.body.args) || [];
    if (!functionName || typeof functionName !== 'string') {
      return res.status(400).json({ error: 'functionName is required' });
    }
    if (functionName.endsWith('_')) {
      return res.status(403).json({ error: 'Private function' });
    }
    if (!Object.prototype.hasOwnProperty.call(rt.api, functionName)) {
      return res.status(404).json({ error: 'Unknown function: ' + functionName });
    }
    try {
      const result = rt.call(functionName, args);
      res.json({
        result: JSON.parse(JSON.stringify(result, function (_k, v) {
          if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
          return v;
        }))
      });
    } catch (err) {
      console.error('API error in', functionName, err);
      res.status(500).json({ error: err && err.message ? err.message : String(err) });
    }
  });

  app.get('/files/:id', withRuntime, function (req, res) {
    const id = req.params.id;
    const metaPath = path.join(driveDir, id + '.meta.json');
    if (!fs.existsSync(metaPath)) return res.status(404).send('Not found');
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      res.download(meta.path, meta.name);
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  app.get('/api/functions', withRuntime, function (_req, res) {
    res.json({ functions: Object.keys(getRuntime().api).sort() });
  });

  app.get('/api/cron/reminders', withRuntime, function (req, res) {
    const auth = req.headers.authorization || '';
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && auth !== 'Bearer ' + cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const rt = getRuntime();
      if (typeof rt.sandbox.checkAndSendReminders_ === 'function') {
        rt.sandbox.checkAndSendReminders_();
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.use(function (err, _req, res, _next) {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  });

  return app;
}

let app;
try {
  app = createApp();
} catch (err) {
  console.error('createApp failed:', err);
  app = express();
  app.get('*', function (_req, res) {
    res.status(500).type('html').send(
      '<h1>App failed to boot</h1><pre>' + String(err && err.stack ? err.stack : err) + '</pre>'
    );
  });
}

if (!isVercel && require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  try {
    const cron = require('node-cron');
    cron.schedule('0 7 * * *', function () {
      try {
        const rt = getRuntime();
        if (typeof rt.sandbox.checkAndSendReminders_ === 'function') {
          rt.sandbox.checkAndSendReminders_();
        }
      } catch (err) {
        console.error('Reminder job failed:', err);
      }
    }, { timezone });
  } catch (e) {
    console.warn('node-cron not available:', e.message);
  }

  app.listen(port, function () {
    console.log('Experiment Scheduler running at ' + baseUrl);
  });
}

module.exports = app;
