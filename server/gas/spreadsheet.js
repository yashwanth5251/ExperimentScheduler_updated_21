'use strict';

const { resolveBackend } = require('./persistence');

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

function createSpreadsheetStore(dbPath) {
  const backend = resolveBackend(dbPath);
  const memory = new Map();

  function loadSheet(name) {
    if (memory.has(name)) return memory.get(name);
    const raw = backend.loadSheet(name);
    if (!raw) return null;
    const grid = deserializeGrid(raw);
    memory.set(name, grid);
    return grid;
  }

  function saveSheet(name, grid) {
    memory.set(name, grid);
    backend.saveSheet(name, serializeGrid(grid));
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
        const props = backend.getProps();
        return Object.prototype.hasOwnProperty.call(props, key) ? { value: props[key] } : undefined;
      }
    },
    setProp: {
      run(key, value) {
        const props = backend.getProps();
        props[key] = value;
        backend.setProps(props);
      }
    },
    deleteProp: {
      run(key) {
        const props = backend.getProps();
        delete props[key];
        backend.setProps(props);
      }
    },
    getCache: {
      get(key) {
        const cache = backend.getCache();
        const row = cache[key];
        return row ? { value: row.value, expires: row.expires } : undefined;
      }
    },
    setCache: {
      run(key, value, expires) {
        const cache = backend.getCache();
        cache[key] = { value, expires };
        backend.setCache(cache);
      }
    },
    deleteCache: {
      run(key) {
        const cache = backend.getCache();
        delete cache[key];
        backend.setCache(cache);
      }
    },
    deleteExpiredCache: {
      run(now) {
        const cache = backend.getCache();
        let changed = false;
        Object.keys(cache).forEach((k) => {
          if (cache[k].expires > 0 && cache[k].expires < now) {
            delete cache[k];
            changed = true;
          }
        });
        if (changed) backend.setCache(cache);
      }
    }
  };

  const spreadsheet = {
    getId() { return 'vercel-compatible-store'; },
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
      return backend.listSheets().map((n) => createSheet(n, loadSheet(n)));
    },
    deleteSheet(sheet) {
      const n = typeof sheet === 'string' ? sheet : sheet.getName();
      memory.delete(n);
      backend.deleteSheet(n);
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
    backend
  };
}

module.exports = { createSpreadsheetStore, serializeCell, deserializeCell };
