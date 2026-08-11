'use strict';

/**
 * Static path references so Vercel's file tracer (NFT) packs these into the lambda.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  'Code.gs',
  'Index.html',
  'JavaScript.html',
  'Styles.html',
  'Admin.html',
  'AdminJavaScript.html',
  'AdminStyles.html',
  'Manage.html',
  'ManageJavaScript.html',
  'ManageStyles.html'
];

const present = [];
for (let i = 0; i < files.length; i++) {
  const p = path.join(root, files[i]);
  if (fs.existsSync(p)) {
    // Touch so tracers see the dependency
    fs.statSync(p);
    present.push(p);
  }
}

module.exports = { root, present };
