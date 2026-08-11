'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function createLockService() {
  let locked = false;
  let owner = null;

  function makeLock() {
    return {
      tryLock(timeoutMs) {
        const start = Date.now();
        const timeout = timeoutMs == null ? 10000 : timeoutMs;
        while (Date.now() - start < timeout) {
          if (!locked) {
            locked = true;
            owner = this;
            return true;
          }
          // brief spin
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 5);
        }
        return false;
      },
      waitLock(timeoutMs) {
        if (!this.tryLock(timeoutMs)) {
          throw new Error('Could not obtain lock within timeout');
        }
      },
      releaseLock() {
        if (owner === this || locked) {
          locked = false;
          owner = null;
        }
      },
      hasLock() {
        return owner === this && locked;
      }
    };
  }

  return {
    getScriptLock() { return makeLock(); },
    getDocumentLock() { return makeLock(); },
    getUserLock() { return makeLock(); }
  };
}

function createCacheService(stmts) {
  function makeCache() {
    return {
      get(key) {
        stmts.deleteExpiredCache.run(Date.now());
        const row = stmts.getCache.get(key);
        if (!row) return null;
        if (row.expires > 0 && row.expires < Date.now()) {
          stmts.deleteCache.run(key);
          return null;
        }
        return row.value;
      },
      put(key, value, expirationInSeconds) {
        const ttl = expirationInSeconds == null ? 600 : expirationInSeconds;
        const expires = ttl > 0 ? Date.now() + ttl * 1000 : 0;
        stmts.setCache.run(key, String(value), expires);
      },
      remove(key) {
        stmts.deleteCache.run(key);
      },
      getAll(keys) {
        const out = {};
        (keys || []).forEach((k) => {
          const v = this.get(k);
          if (v !== null) out[k] = v;
        });
        return out;
      },
      putAll(values, expirationInSeconds) {
        Object.keys(values || {}).forEach((k) => this.put(k, values[k], expirationInSeconds));
      },
      removeAll(keys) {
        (keys || []).forEach((k) => this.remove(k));
      }
    };
  }
  return {
    getScriptCache() { return makeCache(); },
    getUserCache() { return makeCache(); },
    getDocumentCache() { return makeCache(); }
  };
}

function createPropertiesService(stmts) {
  function makeProps() {
    return {
      getProperty(key) {
        const row = stmts.getProp.get(key);
        return row ? row.value : null;
      },
      setProperty(key, value) {
        stmts.setProp.run(key, String(value));
        return this;
      },
      deleteProperty(key) {
        stmts.deleteProp.run(key);
        return this;
      },
      getProperties() {
        // not heavily used; return empty unless needed
        return {};
      },
      setProperties(props) {
        Object.keys(props || {}).forEach((k) => this.setProperty(k, props[k]));
        return this;
      }
    };
  }
  return {
    getScriptProperties() { return makeProps(); },
    getUserProperties() { return makeProps(); },
    getDocumentProperties() { return makeProps(); }
  };
}

function createDriveApp(driveDir, baseUrl, logger) {
  fs.mkdirSync(driveDir, { recursive: true });
  return {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT' },
    createFile(blob) {
      const id = uuidv4();
      const name = (blob.getName && blob.getName()) || (id + '.bin');
      const safe = name.replace(/[^\w.\-]+/g, '_');
      const filePath = path.join(driveDir, id + '__' + safe);
      const bytes = blob.getBytes ? Buffer.from(blob.getBytes()) : Buffer.from([]);
      fs.writeFileSync(filePath, bytes);
      const file = {
        getId() { return id; },
        getName() { return safe; },
        getUrl() { return baseUrl.replace(/\/$/, '') + '/files/' + id; },
        setSharing() { return file; }
      };
      // index for lookup
      fs.writeFileSync(path.join(driveDir, id + '.meta.json'), JSON.stringify({ id, path: filePath, name: safe }));
      return file;
    }
  };
}

function createLogger() {
  return {
    log(msg) {
      console.log('[GAS]', msg);
    }
  };
}

function createSession(timezone, ownerEmail) {
  return {
    getScriptTimeZone() { return timezone; },
    getActiveUser() {
      return {
        getEmail() { return ownerEmail || ''; }
      };
    },
    getEffectiveUser() {
      return {
        getEmail() { return ownerEmail || ''; }
      };
    }
  };
}

function createScriptApp(baseUrl, triggerRegistry) {
  return {
    getService() {
      return {
        getUrl() { return baseUrl.replace(/\/$/, ''); }
      };
    },
    newTrigger(handlerName) {
      const builder = {
        timeBased() {
          return {
            everyDays() {
              return {
                atHour() {
                  return {
                    create() {
                      triggerRegistry.push({ handlerName, type: 'daily' });
                      return { getHandlerFunction() { return handlerName; } };
                    }
                  };
                }
              };
            }
          };
        }
      };
      return builder;
    },
    getProjectTriggers() {
      return triggerRegistry.map((t) => ({
        getHandlerFunction() { return t.handlerName; }
      }));
    },
    deleteTrigger(trigger) {
      const name = trigger.getHandlerFunction();
      for (let i = triggerRegistry.length - 1; i >= 0; i--) {
        if (triggerRegistry[i].handlerName === name) triggerRegistry.splice(i, 1);
      }
    }
  };
}

function createHtmlService() {
  // Not used by Express path; stubs for completeness if Code.gs calls them.
  return {
    createTemplateFromFile() {
      return {
        evaluate() {
          return {
            setTitle() { return this; },
            setXFrameOptionsMode() { return this; }
          };
        }
      };
    },
    createHtmlOutputFromFile() {
      return { getContent() { return ''; } };
    },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
  };
}

module.exports = {
  createLockService,
  createCacheService,
  createPropertiesService,
  createDriveApp,
  createLogger,
  createSession,
  createScriptApp,
  createHtmlService
};
