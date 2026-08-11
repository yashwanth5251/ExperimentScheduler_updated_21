'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');

function createUtilities(options) {
  const { timezone, driveDir, logger } = options;

  function formatWithPattern(date, tz, pattern) {
    const d = Object.prototype.toString.call(date) === '[object Date]' ? date : new Date(date);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
      era: undefined
    }).formatToParts(d).reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const monthShort = monthNames.map((m) => m.slice(0, 3));
    const monthNum = parseInt(parts.month, 10);
    const hour24 = parts.hour === '24' ? '00' : parts.hour;

    return pattern
      .replace(/yyyy/g, parts.year)
      .replace(/MMMM/g, monthNames[monthNum - 1])
      .replace(/MMM/g, monthShort[monthNum - 1])
      .replace(/MM/g, parts.month)
      .replace(/dd/g, parts.day)
      .replace(/d(?!d)/g, String(parseInt(parts.day, 10)))
      .replace(/HH/g, hour24)
      .replace(/mm/g, parts.minute)
      .replace(/ss/g, parts.second)
      .replace(/EEE/g, parts.weekday)
      .replace(/HHmm/g, hour24 + parts.minute);
  }

  async function htmlToPdfBuffer(html) {
    try {
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        return Buffer.from(pdf);
      } finally {
        await browser.close();
      }
    } catch (err) {
      if (logger) logger.log('puppeteer PDF failed, falling back to PDFKit text: ' + err);
      return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        doc.fontSize(10).text(text || 'PDF');
        doc.end();
      });
    }
  }

  function createBlob(data, contentType, name) {
    let bytes;
    let type = contentType || 'application/octet-stream';
    let fileName = name || 'file';

    if (Buffer.isBuffer(data)) {
      bytes = data;
    } else if (typeof data === 'string') {
      bytes = Buffer.from(data, 'utf8');
    } else {
      bytes = Buffer.from(String(data), 'utf8');
    }

    const blob = {
      getBytes() { return Array.from(bytes); },
      getDataAsString() { return bytes.toString('utf8'); },
      getContentType() { return type; },
      getName() { return fileName; },
      setName(n) { fileName = n; return blob; },
      getAs(targetType) {
        if (targetType === 'application/pdf' && type.indexOf('html') !== -1) {
          // Sync bridge: Apps Script is sync; we pre-render via deasync-like busy wait using Atomics.
          // Prefer a cached sync conversion using child process execFileSync is heavy;
          // instead convert eagerly with a blocking subprocess of node -e is messy.
          // Use a temp sync file written by spawning node synchronously.
          const { execFileSync } = require('child_process');
          const tmpHtml = path.join(driveDir, '_tmp_' + uuidv4() + '.html');
          const tmpPdf = path.join(driveDir, '_tmp_' + uuidv4() + '.pdf');
          fs.mkdirSync(driveDir, { recursive: true });
          fs.writeFileSync(tmpHtml, bytes);
          try {
            const helper = path.join(__dirname, 'htmlToPdfSync.js');
            execFileSync(process.execPath, [helper, tmpHtml, tmpPdf], {
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 120000
            });
            const pdfBuf = fs.readFileSync(tmpPdf);
            return createBlob(pdfBuf, 'application/pdf', fileName.replace(/\.html$/i, '.pdf'));
          } finally {
            try { fs.unlinkSync(tmpHtml); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(tmpPdf); } catch (e) { /* ignore */ }
          }
        }
        return createBlob(bytes, targetType, fileName);
      }
    };
    return blob;
  }

  return {
    getUuid() { return uuidv4(); },
    formatDate(date, tz, pattern) {
      return formatWithPattern(date, tz, pattern);
    },
    computeDigest(algorithm, value) {
      const algo = algorithm === 'SHA_256' || algorithm === 2 ? 'sha256' : 'sha256';
      const hash = crypto.createHash(algo).update(String(value), 'utf8').digest();
      // Apps Script returns signed bytes (-128..127)
      return Array.from(hash).map((b) => (b > 127 ? b - 256 : b));
    },
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
    Charset: { UTF_8: 'UTF_8' },
    newBlob(data, contentType, name) {
      return createBlob(data, contentType, name);
    },
    base64Encode(bytes) {
      if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8').toString('base64');
      if (Buffer.isBuffer(bytes)) return bytes.toString('base64');
      return Buffer.from(bytes).toString('base64');
    },
    sleep(ms) {
      const sab = new SharedArrayBuffer(4);
      const ia = new Int32Array(sab);
      Atomics.wait(ia, 0, 0, ms);
    },
    htmlToPdfBuffer
  };
}

module.exports = { createUtilities };
