'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createRuntime } = require('./gas/runtime');
const { renderTemplate } = require('./pages');

const isVercel = !!(process.env.VERCEL || process.env.NOW_REGION);

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error('Missing required environment variable: ' + name);
  }
}

function ensureGoogleCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const dest = path.join(
      isVercel ? '/tmp' : path.join(__dirname, '..', 'credentials'),
      'google-service-account.json'
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      fs.writeFileSync(dest, JSON.stringify(parsed, null, 2));
    }
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE = dest;
    return;
  }
  requireEnv('GOOGLE_SERVICE_ACCOUNT_FILE');
}

['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].forEach(requireEnv);
ensureGoogleCredentials();

const projectRoot = path.join(__dirname, '..');
const detectedHost = process.env.VERCEL_URL
  ? ('https://' + process.env.VERCEL_URL)
  : (process.env.BASE_URL || 'http://localhost:3000');
const baseUrl = detectedHost.replace(/\/$/, '');
const timezone = process.env.SCRIPT_TIMEZONE || 'Europe/Berlin';
const ownerEmail = process.env.ADMIN_OWNER_EMAIL || 'altersstudie@lin-magdeburg.de';

const dataRoot = isVercel
  ? '/tmp/experiment-scheduler'
  : path.join(projectRoot, 'data');
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataRoot, 'scheduler.sqlite');
const driveDir = path.join(dataRoot, 'drive');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(driveDir, { recursive: true });

let runtime;
function getRuntime() {
  if (runtime) return runtime;
  console.log('Loading Apps Script runtime (Code.gs)…');
  runtime = createRuntime({
    dbPath,
    baseUrl: process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : baseUrl,
    timezone,
    ownerEmail,
    driveDir,
    projectRoot
  });
  try {
    runtime.call('initializeSpreadsheet', []);
  } catch (err) {
    console.error('initializeSpreadsheet failed:', err);
    throw err;
  }
  return runtime;
}

function createApp() {
  // Warm runtime at module load for local; on Vercel first request also warms
  getRuntime();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', function (_req, res) {
    res.json({ ok: true, vercel: isVercel });
  });

  app.get('/', function (req, res) {
    const page = String(req.query.page || '').toLowerCase();
    const action = String(req.query.action || '').toLowerCase();
    const admin = String(req.query.admin || '').toLowerCase();
    if (action === 'manage' || page === 'manage') return res.redirect('/manage');
    if (page === 'admin' || admin === 'true') return res.redirect('/admin');
    if (page === 'book') return res.redirect('/book');
    return res.redirect('/book');
  });

  app.get('/book', function (_req, res) {
    try {
      res.type('html').send(renderTemplate(projectRoot, 'Index'));
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  app.get('/manage', function (_req, res) {
    try {
      res.type('html').send(renderTemplate(projectRoot, 'Manage'));
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  app.get('/admin', function (_req, res) {
    try {
      res.type('html').send(renderTemplate(projectRoot, 'Admin'));
    } catch (err) {
      res.status(500).send(String(err));
    }
  });

  app.get('/exec', function (req, res) {
    const page = String(req.query.page || '').toLowerCase();
    const action = String(req.query.action || '').toLowerCase();
    const admin = String(req.query.admin || '').toLowerCase();
    if (action === 'manage' || page === 'manage') return res.redirect('/manage');
    if (page === 'admin' || admin === 'true') return res.redirect('/admin');
    return res.redirect('/book');
  });

  app.post('/api/run', function (req, res) {
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

  app.get('/files/:id', function (req, res) {
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

  app.get('/api/functions', function (_req, res) {
    res.json({ functions: Object.keys(getRuntime().api).sort() });
  });

  // Cron endpoint for Vercel Cron Jobs
  app.get('/api/cron/reminders', function (req, res) {
    const auth = req.headers.authorization || '';
    if (process.env.CRON_SECRET && auth !== 'Bearer ' + process.env.CRON_SECRET) {
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

  return app;
}

const app = createApp();

if (!isVercel && require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  // Local daily reminders
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
    console.log('  Book:   ' + baseUrl + '/book');
    console.log('  Manage: ' + baseUrl + '/manage');
    console.log('  Admin:  ' + baseUrl + '/admin');
  });
}

module.exports = app;
