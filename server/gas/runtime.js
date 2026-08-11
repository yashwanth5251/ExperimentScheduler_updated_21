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
      if (typeof sandbox[name] !== 'function') {
        throw new Error('Unknown server function: ' + name);
      }
      return sandbox[name].apply(null, args || []);
    }
  };
}

module.exports = { createRuntime };
