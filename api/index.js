'use strict';

/**
 * Vercel entry. Never throw during module evaluation — return a diagnostic
 * app if boot fails so FUNCTION_INVOCATION_FAILED becomes a readable 500.
 */
try {
  require('../server/forceInclude');
  module.exports = require('../server/index.js');
} catch (err) {
  console.error('[api/index] boot failure:', err);
  const express = require('express');
  const app = express();
  app.use(function (_req, res) {
    res.status(500).type('html').send(
      '<h1>FUNCTION_INVOCATION_FAILED (boot)</h1><pre>' +
      String(err && err.stack ? err.stack : err) +
      '</pre>'
    );
  });
  module.exports = app;
}
