'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Sync helper invoked by Utilities.newBlob(...).getAs('application/pdf').
 * Usage: node htmlToPdfSync.js input.html output.pdf
 */
async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  const html = fs.readFileSync(input, 'utf8');
  let pdf;
  try {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      pdf = await page.pdf({ format: 'A4', printBackground: true });
    } finally {
      await browser.close();
    }
  } catch (err) {
    const PDFDocument = require('pdfkit');
    pdf = await new Promise((resolve, reject) => {
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
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pdf);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
