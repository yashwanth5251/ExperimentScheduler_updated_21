'use strict';

const fs = require('fs');
const path = require('path');

const META_TYPE = '__type';
const META_VALUE = '__value';

function serializeCell(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return { [META_TYPE]: 'Date', [META_VALUE]: value.toISOString() };
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

function deserializeCell(value) {
  if (value && typeof value === 'object' && value[META_TYPE] === 'Date') {
    return new Date(value[META_VALUE]);
  }
  return value === undefined || value === null ? '' : value;
}

function serializeGrid(grid) {
  return grid.map((row) => row.map(serializeCell));
}

function deserializeGrid(grid) {
  return (grid || []).map((row) => row.map(deserializeCell));
}

/**
 * Pure-JS sheet store (JSON files). No native modules — Vercel-compatible.
 * Layout under dbDir:
 *   sheets/<name>.json  — 2D grid
 *   props.json
 *   cache.json
 */
function createSpreadsheetStore(dbPath) {
  // dbPath may be a .sqlite path from older config; use its directory + basename stem
  const dbDir = dbPath.endsWith('.sqlite') || dbPath.endsWith('.db')
    ? path.join(path.dirname(dbPath), path.basename(dbPath, path.extname(dbPath)) + '_store')
    : dbPath;
  const sheetsDir = path.join(dbDir, 'sheets');
  fs.mkdirSync(sheetsDir, { recursive: true });

  const propsPath = path.join(dbDir, 'props.json');
  const cachePath = path.join(dbDir, 'cache.json');

  function readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  const memory = new Map();

  function sheetFile(name) {
    return path.join(sheetsDir, encodeURIComponent(name) + '.json');
  }

  function loadSheet(name) {
    if (memory.has(name)) return memory.get(name);
    const file = sheetFile(name);
    if (!fs.existsSync(file)) return null;
    const grid = deserializeGrid(readJson(file, []));
    memory.set(name, grid);
    return grid;
  }

  function saveSheet(name, grid) {
    memory.set(name, grid);
    writeJson(sheetFile(name), serializeGrid(grid));
  }

  function listSheetNames() {
    if (!fs.existsSync(sheetsDir)) return [];
    return fs.readdirSync(sheetsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => decodeURIComponent(f.replace(/\.json$/, '')))
      .sort();
  }

  function ensureCols(grid, cols) {
    while (grid.length === 0) grid.push([]);
    for (let r = 0; r < grid.length; r++) {
      while (grid[r].length < cols) grid[r].push('');
    }
  }

  function ensureRows(grid, rows) {
    while (grid.length < rows) {
      const width = grid[0] ? grid[0].length : 0;
      grid.push(Array(width).fill(''));
    }
  }

  function createRange(sheetName, startRow, startCol, numRows, numCols) {
    const range = {
      getValues() {
        const grid = loadSheet(sheetName) || [[]];
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const row = [];
          const src = grid[startRow - 1 + r] || [];
          for (let c = 0; c < numCols; c++) {
            const v = src[startCol - 1 + c];
            row.push(v === undefined || v === null ? '' : v);
          }
          out.push(row);
        }
        return out;
      },
      getDisplayValues() {
        return range.getValues().map((row) => row.map((v) => {
          if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
          return v === null || v === undefined ? '' : String(v);
        }));
      },
      setValues(values) {
        const grid = loadSheet(sheetName) || [[]];
        ensureRows(grid, startRow - 1 + numRows);
        ensureCols(grid, startCol - 1 + numCols);
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const cell = values[r] && values[r][c];
            grid[startRow - 1 + r][startCol - 1 + c] = cell === undefined || cell === null ? '' : cell;
          }
        }
        saveSheet(sheetName, grid);
        return range;
      },
      setValue(value) { return range.setValues([[value]]); },
      getValue() { return range.getValues()[0][0]; },
      setFontWeight() { return range; },
      setNumberFormat() { return range; },
      insertCheckboxes() { return range; },
      clear() {
        const empty = Array.from({ length: numRows }, () => Array(numCols).fill(''));
        return range.setValues(empty);
      }
    };
    return range;
  }

  function createSheet(name, initialGrid) {
    const grid = initialGrid || [[]];
    saveSheet(name, grid);

    const sheet = {
      getName() { return name; },
      getLastRow() {
        const g = loadSheet(name) || [];
        let last = 0;
        for (let r = 0; r < g.length; r++) {
          const row = g[r] || [];
          if (row.some((c) => c !== '' && c !== null && c !== undefined)) last = r + 1;
        }
        return last;
      },
      getLastColumn() {
        const g = loadSheet(name) || [];
        let last = 0;
        for (let r = 0; r < g.length; r++) {
          const row = g[r] || [];
          for (let c = 0; c < row.length; c++) {
            if (row[c] !== '' && row[c] !== null && row[c] !== undefined) last = Math.max(last, c + 1);
          }
        }
        return last;
      },
      getMaxRows() {
        const g = loadSheet(name) || [];
        return Math.max(g.length, 1000);
      },
      getRange(a, b, c, d) {
        if (typeof a === 'string') throw new Error('A1 notation getRange is not used by this app: ' + a);
        if (c === undefined) return createRange(name, a, b, 1, 1);
        return createRange(name, a, b, c, d);
      },
      getDataRange() {
        const lastRow = Math.max(sheet.getLastRow(), 1);
        const lastCol = Math.max(sheet.getLastColumn(), 1);
        return createRange(name, 1, 1, lastRow, lastCol);
      },
      appendRow(rowValues) {
        const g = loadSheet(name) || [[]];
        const last = sheet.getLastRow();
        const width = Math.max(g[0] ? g[0].length : 0, rowValues.length);
        ensureCols(g, width);
        if (g.length === 0) g.push(Array(width).fill(''));
        while (g.length < last) g.push(Array(width).fill(''));
        const newRow = Array(width).fill('');
        for (let i = 0; i < rowValues.length; i++) {
          newRow[i] = rowValues[i] === undefined || rowValues[i] === null ? '' : rowValues[i];
        }
        if (last === 0) g[0] = newRow;
        else g.push(newRow);
        saveSheet(name, g);
        return sheet;
      },
      deleteRow(rowNumber) {
        const g = loadSheet(name) || [];
        if (rowNumber < 1 || rowNumber > g.length) return sheet;
        g.splice(rowNumber - 1, 1);
        if (g.length === 0) g.push([]);
        saveSheet(name, g);
        return sheet;
      },
      insertRows(afterPosition, numRows) {
        const g = loadSheet(name) || [[]];
        const width = g[0] ? g[0].length : 0;
        const rows = Array.from({ length: numRows || 1 }, () => Array(width).fill(''));
        g.splice(afterPosition, 0, ...rows);
        saveSheet(name, g);
        return sheet;
      },
      setFrozenRows() { return sheet; },
      clear() {
        saveSheet(name, [[]]);
        return sheet;
      }
    };
    return sheet;
  }

  const stmts = {
    getProp: {
      get(key) {
        const props = readJson(propsPath, {});
        return Object.prototype.hasOwnProperty.call(props, key) ? { value: props[key] } : undefined;
      }
    },
    setProp: {
      run(key, value) {
        const props = readJson(propsPath, {});
        props[key] = value;
        writeJson(propsPath, props);
      }
    },
    deleteProp: {
      run(key) {
        const props = readJson(propsPath, {});
        delete props[key];
        writeJson(propsPath, props);
      }
    },
    getCache: {
      get(key) {
        const cache = readJson(cachePath, {});
        const row = cache[key];
        return row ? { value: row.value, expires: row.expires } : undefined;
      }
    },
    setCache: {
      run(key, value, expires) {
        const cache = readJson(cachePath, {});
        cache[key] = { value, expires };
        writeJson(cachePath, cache);
      }
    },
    deleteCache: {
      run(key) {
        const cache = readJson(cachePath, {});
        delete cache[key];
        writeJson(cachePath, cache);
      }
    },
    deleteExpiredCache: {
      run(now) {
        const cache = readJson(cachePath, {});
        let changed = false;
        Object.keys(cache).forEach((k) => {
          if (cache[k].expires > 0 && cache[k].expires < now) {
            delete cache[k];
            changed = true;
          }
        });
        if (changed) writeJson(cachePath, cache);
      }
    }
  };

  const spreadsheet = {
    getId() { return 'local-json'; },
    getSheetByName(sheetName) {
      const g = loadSheet(sheetName);
      if (!g) return null;
      return createSheet(sheetName, g);
    },
    insertSheet(sheetName) {
      if (loadSheet(sheetName)) throw new Error('Sheet already exists: ' + sheetName);
      return createSheet(sheetName, [[]]);
    },
    getSheets() {
      return listSheetNames().map((n) => createSheet(n, loadSheet(n)));
    },
    deleteSheet(sheet) {
      const n = typeof sheet === 'string' ? sheet : sheet.getName();
      memory.delete(n);
      const file = sheetFile(n);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
    flush() { /* sync already */ }
  };

  return {
    db: null,
    stmts,
    spreadsheet,
    createSheet,
    loadSheet,
    saveSheet,
    memory,
    dbDir
  };
}

module.exports = { createSpreadsheetStore, serializeCell, deserializeCell };
