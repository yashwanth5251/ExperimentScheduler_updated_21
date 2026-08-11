'use strict';

const nodemailer = require('nodemailer');

function isDemoMode() {
  return String(process.env.ALLOW_INSECURE_DEMO || '').toLowerCase() === 'true' ||
    String(process.env.ALLOW_INSECURE_DEMO || '') === '1';
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing required env var: ' + name);
  return v;
}

function createMailApp(logger) {
  const demo = isDemoMode() || !process.env.SMTP_HOST;

  if (!demo) {
    requireEnv('SMTP_HOST');
    requireEnv('SMTP_PORT');
    requireEnv('SMTP_USER');
    requireEnv('SMTP_PASS');
    requireEnv('SMTP_FROM');
  } else if (logger) {
    logger.log('MailApp running in DEMO mode — emails are logged, not sent.');
  }

  const transporter = demo ? null : nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  function normalizeArgs(a, b, c) {
    if (typeof a === 'object' && a !== null && !Array.isArray(a)) {
      return {
        to: a.to,
        subject: a.subject,
        body: a.body || a.text || '',
        html: a.html,
        cc: a.cc,
        bcc: a.bcc,
        replyTo: a.replyTo,
        name: a.name
      };
    }
    return { to: a, subject: b, body: c || '' };
  }

  return {
    sendEmail(a, b, c) {
      const msg = normalizeArgs(a, b, c);
      const to = Array.isArray(msg.to) ? msg.to.join(',') : String(msg.to || '');
      const mail = {
        from: process.env.SMTP_FROM || 'demo@localhost',
        to,
        subject: msg.subject || '',
        text: msg.body || '',
        html: msg.html,
        cc: msg.cc,
        bcc: msg.bcc,
        replyTo: msg.replyTo
      };

      if (demo || !transporter) {
        if (logger) {
          logger.log('[DEMO EMAIL] to=' + mail.to + ' subject=' + mail.subject);
        }
        return;
      }

      const { execFileSync } = require('child_process');
      const path = require('path');
      const fs = require('fs');
      const os = require('os');
      const tmp = path.join(os.tmpdir(), 'mail_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.json');
      fs.writeFileSync(tmp, JSON.stringify({
        smtp: {
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT, 10),
          secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        mail
      }));
      try {
        execFileSync(process.execPath, [path.join(__dirname, 'sendMailSync.js'), tmp], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000
        });
      } catch (err) {
        if (logger) logger.log('MailApp.sendEmail failed: ' + err);
        throw new Error('Failed to send email: ' + (err.stderr ? err.stderr.toString() : err.message));
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      }
    },
    verify() {
      if (!transporter) return Promise.resolve(true);
      return transporter.verify();
    }
  };
}

module.exports = { createMailApp };
