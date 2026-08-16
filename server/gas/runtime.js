'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createSpreadsheetStore } = require('./spreadsheet');
const { createUtilities } = require('./utilities');
const { createMailApp } = require('./mail');
const { createCalendarApp } = require('./calendar');
const {
  createLockService,
  createCacheService,
  createPropertiesService,
  createDriveApp,
  createLogger,
  createSession,
  createScriptApp,
  createHtmlService
} = require('./services');

function createRuntime(options) {
  const {
    dbPath,
    baseUrl,
    timezone,
    ownerEmail,
    driveDir,
    projectRoot
  } = options;

  const store = createSpreadsheetStore(dbPath);
  const Logger = createLogger();
  const triggerRegistry = [];

  const Utilities = createUtilities({ timezone, driveDir, logger: Logger });
  const MailApp = createMailApp(Logger);
  const CalendarApp = createCalendarApp(Logger);
  const LockService = createLockService();
  const CacheService = createCacheService(store.stmts);
  const PropertiesService = createPropertiesService(store.stmts);
  const DriveApp = createDriveApp(driveDir, baseUrl, Logger);
  const Session = createSession(timezone, ownerEmail);
  const ScriptApp = createScriptApp(baseUrl, triggerRegistry);
  const HtmlService = createHtmlService();

  const SpreadsheetApp = {
    openById() { return store.spreadsheet; },
    getActiveSpreadsheet() { return store.spreadsheet; },
    flush() { store.spreadsheet.flush(); }
  };

  const sandbox = {
    console,
    // GAS globals
    CONFIG: undefined, // set by Code.gs
    SpreadsheetApp,
    LockService,
    MailApp,
    CalendarApp,
    CacheService,
    PropertiesService,
    Utilities,
    Session,
    ScriptApp,
    DriveApp,
    Logger,
    HtmlService,
    // Standard JS
    Object, Array, String, Number, Boolean, Date, Math, JSON, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    setTimeout, clearTimeout,
    undefined
  };

  const builtinKeys = new Set(Object.keys(sandbox));

  // Allow Code.gs to declare globals with `var` / `function`
  vm.createContext(sandbox);

  // Durable vs ephemeral storage (Vercel /tmp is not shared across isolates).
  sandbox.Persistence_ = {
    type: function () { return store.backend.type; },
    isDurable: function () { return store.isDurable(); },
    isEphemeral: function () { return !store.isDurable(); }
  };

  const codePath = path.join(projectRoot, 'Code.gs');
  const altPath = path.join(__dirname, '..', '..', 'Code.gs');
  const resolved = fs.existsSync(codePath) ? codePath
    : (fs.existsSync(altPath) ? altPath : codePath);
  if (!fs.existsSync(resolved)) {
    throw new Error('Code.gs missing. Tried: ' + codePath + ' and ' + altPath);
  }
  const code = fs.readFileSync(resolved, 'utf8');

  // Override CONFIG owner email/password from env after load if present
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });

  if (sandbox.CONFIG) {
    if (ownerEmail) sandbox.CONFIG.ADMIN_OWNER_EMAIL = ownerEmail;
    if (process.env.ADMIN_DEFAULT_PASSWORD) {
      sandbox.CONFIG.ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD;
    }
    if (process.env.GOOGLE_PARTICIPANT_CALENDAR_ID) {
      sandbox.CONFIG.PARTICIPANT_CALENDAR_EMAIL = process.env.GOOGLE_PARTICIPANT_CALENDAR_ID;
    }
  }

  // Stateless signed admin sessions (required on Vercel — CacheService is not
  // shared across serverless isolates, so UUID tokens looked "logged out"
  // immediately after login).
  patchAdminSessions_(sandbox);

  // Collect public API functions defined by Code.gs (no trailing underscore)
  const api = {};
  for (const key of Object.keys(sandbox)) {
    if (builtinKeys.has(key)) continue;
    if (typeof sandbox[key] !== 'function') continue;
    if (key.endsWith('_')) continue;
    if (key === 'doGet' || key === 'include') continue;
    api[key] = sandbox[key];
  }

  return {
    sandbox,
    api,
    store,
    MailApp,
    CalendarApp,
    triggerRegistry,
    call(name, args) {
      if (typeof store.beginRequest === 'function') store.beginRequest();
      if (typeof sandbox[name] !== 'function') {
        throw new Error('Unknown server function: ' + name);
      }
      return sandbox[name].apply(null, args || []);
    }
  };
}

function patchAdminSessions_(sandbox) {
  const crypto = require('crypto');
  const secret = process.env.SESSION_SECRET ||
    process.env.ADMIN_DEFAULT_PASSWORD ||
    'experiment-scheduler-session-v1';
  const ttlSeconds = (sandbox.CONFIG && sandbox.CONFIG.ADMIN_SESSION_TTL_SECONDS) || 1800;

  function b64url(buf) {
    return Buffer.from(buf).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function signSession(session) {
    const body = {
      email: session.email,
      name: session.name,
      role: session.role,
      exp: Date.now() + ttlSeconds * 1000
    };
    const payload = b64url(JSON.stringify(body));
    const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    return 's.' + payload + '.' + sig;
  }

  function verifySignedToken(token) {
    if (!token || String(token).indexOf('s.') !== 0) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const sig = parts[2];
    const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
    if (sig !== expected) return null;
    try {
      const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const body = JSON.parse(json);
      if (!body || !body.exp || Date.now() > body.exp) return null;
      return { email: body.email, name: body.name, role: body.role };
    } catch (e) {
      return null;
    }
  }

  const originalRequire = sandbox.requireAdminAuth_;
  sandbox.requireAdminAuth_ = function (token) {
    const signed = verifySignedToken(token);
    if (signed) return signed;
    return originalRequire(token);
  };

  const originalLogin = sandbox.adminLogin;
  sandbox.adminLogin = function (email, password) {
    const result = originalLogin(email, password);
    if (result && result.success && result.email) {
      result.token = signSession({
        email: result.email,
        name: result.name,
        role: result.role
      });
    }
    return result;
  };

  const originalLogout = sandbox.adminLogout;
  sandbox.adminLogout = function (token) {
    if (verifySignedToken(token)) return { success: true };
    return originalLogout(token);
  };
}

module.exports = { createRuntime };
