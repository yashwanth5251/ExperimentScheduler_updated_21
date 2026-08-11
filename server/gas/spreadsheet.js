'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
  return JSON.stringify(grid.map((row) => row.map(serializeCell)));
}

function deserializeGrid(raw) {
  const grid = JSON.parse(raw || '[]');
  return grid.map((row) => row.map(deserializeCell));
}

function createSpreadsheetStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sheets (
      name TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS props (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);

  const stmts = {
    getSheet: db.prepare('SELECT data FROM sheets WHERE name = ?'),
    upsertSheet: db.prepare('INSERT INTO sheets(name, data) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data'),
    deleteSheet: db.prepare('DELETE FROM sheets WHERE name = ?'),
    listSheets: db.prepare('SELECT name FROM sheets ORDER BY name'),
    getProp: db.prepare('SELECT value FROM props WHERE key = ?'),
    setProp: db.prepare('INSERT INTO props(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    deleteProp: db.prepare('DELETE FROM props WHERE key = ?'),
    getCache: db.prepare('SELECT value, expires FROM cache WHERE key = ?'),
    setCache: db.prepare('INSERT INTO cache(key, value, expires) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires'),
    deleteCache: db.prepare('DELETE FROM cache WHERE key = ?'),
    deleteExpiredCache: db.prepare('DELETE FROM cache WHERE expires > 0 AND expires < ?')
  };

  const memory = new Map();

  function loadSheet(name) {
    if (memory.has(name)) return memory.get(name);
    const row = stmts.getSheet.get(name);
    const grid = row ? deserializeGrid(row.data) : null;
    if (grid) memory.set(name, grid);
    return grid;
  }

  function saveSheet(name, grid) {
    memory.set(name, grid);
    stmts.upsertSheet.run(name, serializeGrid(grid));
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
    // Apps Script Sheet.getRange(row, column, numRows, numColumns) — 1-based
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
          if (Object.prototype.toString.call(v) === '[object Date]') {
            return v.toISOString();
          }
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
      setValue(value) {
        return range.setValues([[value]]);
      },
      getValue() {
        return range.getValues()[0][0];
      },
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
          const has = row.some((c) => c !== '' && c !== null && c !== undefined);
          if (has) last = r + 1;
        }
        return last;
      },
      getLastColumn() {
        const g = loadSheet(name) || [];
        let last = 0;
        for (let r = 0; r < g.length; r++) {
          const row = g[r] || [];
          for (let c = 0; c < row.length; c++) {
            if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
              last = Math.max(last, c + 1);
            }
          }
        }
        return last;
      },
      getMaxRows() {
        const g = loadSheet(name) || [];
        return Math.max(g.length, 1000);
      },
      getRange(a, b, c, d) {
        if (typeof a === 'string') {
          throw new Error('A1 notation getRange is not used by this app: ' + a);
        }
        if (c === undefined) {
          return createRange(name, a, b, 1, 1);
        }
        // (row, column, numRows, numColumns)
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
        // Ensure header row exists
        if (g.length === 0) g.push(Array(width).fill(''));
        while (g.length < last) {
          g.push(Array(width).fill(''));
        }
        const newRow = Array(width).fill('');
        for (let i = 0; i < rowValues.length; i++) {
          newRow[i] = rowValues[i] === undefined || rowValues[i] === null ? '' : rowValues[i];
        }
        if (last === 0) {
          g[0] = newRow;
        } else {
          g.push(newRow);
        }
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

  const spreadsheet = {
    getId() { return 'local-sqlite'; },
    getSheetByName(sheetName) {
      const g = loadSheet(sheetName);
      if (!g) return null;
      return createSheet(sheetName, g);
    },
    insertSheet(sheetName) {
      if (loadSheet(sheetName)) {
        throw new Error('Sheet already exists: ' + sheetName);
      }
      return createSheet(sheetName, [[]]);
    },
    getSheets() {
      return stmts.listSheets.all().map((r) => createSheet(r.name, loadSheet(r.name)));
    },
    deleteSheet(sheet) {
      const n = typeof sheet === 'string' ? sheet : sheet.getName();
      memory.delete(n);
      stmts.deleteSheet.run(n);
    },
    flush() { /* sync already */ }
  };

  return {
    db,
    stmts,
    spreadsheet,
    createSheet,
    loadSheet,
    saveSheet,
    memory
  };
}

module.exports = { createSpreadsheetStore, serializeCell, deserializeCell };
