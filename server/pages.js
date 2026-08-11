'use strict';

const fs = require('fs');
const path = require('path');

const SHIM = `
<script>
(function () {
  function createRunner() {
    var success = null;
    var failure = null;
    var proxy = null;
    var runner = {
      withSuccessHandler: function (fn) { success = fn; return proxy; },
      withFailureHandler: function (fn) { failure = fn; return proxy; }
    };
    proxy = new Proxy(runner, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler' || prop === 'withFailureHandler') {
          return target[prop];
        }
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') {
          return undefined;
        }
        return function () {
          var args = Array.prototype.slice.call(arguments);
          return fetch('/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ functionName: String(prop), args: args })
          }).then(function (res) {
            return res.json().then(function (body) {
              if (!res.ok || body.error) {
                var err = new Error((body && body.error) || res.statusText || 'Server error');
                if (failure) failure(err);
                else throw err;
                return;
              }
              if (success) success(body.result);
              return body.result;
            });
          }).catch(function (err) {
            if (failure) failure(err);
            else console.error(err);
          });
        };
      }
    });
    return proxy;
  }
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  Object.defineProperty(window.google.script, 'run', {
    get: function () { return createRunner(); },
    configurable: true
  });
})();
</script>
`;

function includeFile(projectRoot, filename) {
  const candidates = [
    path.join(projectRoot, filename + '.html'),
    path.join(projectRoot, filename)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('Include not found: ' + filename);
}

function renderTemplate(projectRoot, templateName) {
  let html = includeFile(projectRoot, templateName);
  html = html.replace(/<\?!=\s*include\(['"]([^'"]+)['"]\);\s*\?>/g, function (_, name) {
    return includeFile(projectRoot, name);
  });
  // Inject google.script.run shim before </body> or at end
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, SHIM + '\n</body>');
  } else {
    html += SHIM;
  }
  return html;
}

module.exports = { renderTemplate, includeFile };
