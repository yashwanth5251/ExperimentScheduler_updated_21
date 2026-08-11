'use strict';

/**
 * Manual seed helper — same as startup initializeSpreadsheet().
 * Usage: npm run seed
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createRuntime } = require('./gas/runtime');

const projectRoot = path.join(__dirname, '..');
const runtime = createRuntime({
  dbPath: path.resolve(process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'scheduler.sqlite')),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  timezone: process.env.SCRIPT_TIMEZONE || 'Europe/Berlin',
  ownerEmail: process.env.ADMIN_OWNER_EMAIL || 'altersstudie@lin-magdeburg.de',
  driveDir: path.join(projectRoot, 'data', 'drive'),
  projectRoot
});

runtime.call('initializeSpreadsheet', []);
console.log('Database seeded / refreshed via initializeSpreadsheet().');
