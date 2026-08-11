'use strict';

const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const express = require('express');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createRuntime } = require('./gas/runtime');
const { renderTemplate } = require('./pages');

function requireEnv(name) {
  if (!process.env[name]) {
    console.error('Missing required environment variable: ' + name);
    console.error('Copy .env.example to .env and fill in SMTP + Google Calendar settings.');
    process.exit(1);
  }
}

['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'GOOGLE_SERVICE_ACCOUNT_FILE'].forEach(requireEnv);

const projectRoot = path.join(__dirname, '..');
const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const port = parseInt(process.env.PORT || '3000', 10);
const timezone = process.env.SCRIPT_TIMEZONE || 'Europe/Berlin';
const ownerEmail = process.env.ADMIN_OWNER_EMAIL || 'altersstudie@lin-magdeburg.de';
const dbPath = path.resolve(process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'scheduler.sqlite'));
const driveDir = path.join(projectRoot, 'data', 'drive');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(driveDir, { recursive: true });

console.log('Loading Apps Script runtime (Code.gs)…');
const runtime = createRuntime({
  dbPath,
  baseUrl,
  timezone,
  ownerEmail,
  driveDir,
  projectRoot
});

// Seed spreadsheet on first boot if Admins sheet missing/empty
try {
  const admins = runtime.store.spreadsheet.getSheetByName('Admins');
  if (!admins) {
    console.log('Seeding empty database via initializeSpreadsheet()…');
    runtime.call('initializeSpreadsheet', []);
  } else {
    // Ensure soft-delete columns / roles etc. stay healthy
    runtime.call('initializeSpreadsheet', []);
  }
} catch (err) {
  console.error('initializeSpreadsheet failed:', err);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', function (_req, res) {
  res.json({ ok: true });
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

// Legacy Apps Script query routes
app.get('/exec', function (req, res) {
  const page = String(req.query.page || '').toLowerCase();
  const action = String(req.query.action || '').toLowerCase();
  const admin = String(req.query.admin || '').toLowerCase();
  if (action === 'manage' || page === 'manage') return res.redirect('/manage');
  if (page === 'admin' || admin === 'true') return res.redirect('/admin');
  return res.redirect('/book');
});

app.post('/api/run', function (req, res) {
  const functionName = req.body && req.body.functionName;
  const args = (req.body && req.body.args) || [];
  if (!functionName || typeof functionName !== 'string') {
    return res.status(400).json({ error: 'functionName is required' });
  }
  // Never expose private helpers or non-Code.gs symbols
  if (functionName.endsWith('_')) {
    return res.status(403).json({ error: 'Private function' });
  }
  if (!Object.prototype.hasOwnProperty.call(runtime.api, functionName)) {
    return res.status(404).json({ error: 'Unknown function: ' + functionName });
  }
  try {
    const result = runtime.call(functionName, args);
    // JSON-serialize Dates for the browser
    res.json({ result: JSON.parse(JSON.stringify(result, function (_k, v) {
      if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
      return v;
    })) });
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
  res.json({ functions: Object.keys(runtime.api).sort() });
});

// Daily reminders at 07:00 in SCRIPT_TIMEZONE
cron.schedule('0 7 * * *', function () {
  try {
    if (typeof runtime.sandbox.checkAndSendReminders_ === 'function') {
      runtime.sandbox.checkAndSendReminders_();
    }
  } catch (err) {
    console.error('Reminder job failed:', err);
  }
}, { timezone });

app.listen(port, function () {
  console.log('Experiment Scheduler running at ' + baseUrl);
  console.log('  Book:   ' + baseUrl + '/book');
  console.log('  Manage: ' + baseUrl + '/manage');
  console.log('  Admin:  ' + baseUrl + '/admin');
  console.log('Main admin email: ' + ownerEmail + ' (default password from env / Code.gs seed)');
});
