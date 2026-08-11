'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

async function main() {
  const inFile = process.argv[2];
  const outFile = process.argv[3];
  const req = JSON.parse(fs.readFileSync(inFile, 'utf8'));

  const impersonate = process.env.GOOGLE_CALENDAR_IMPERSONATE || undefined;
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const clientOptions = impersonate ? { subject: impersonate } : undefined;
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes,
      clientOptions
    });
  } else {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    auth = new google.auth.GoogleAuth({
      keyFile: path.resolve(keyFile),
      scopes,
      clientOptions
    });
  }
  const authClient = await auth.getClient();
  const calendar = google.calendar({ version: 'v3', auth: authClient });

  let result = null;
  switch (req.op) {
    case 'create': {
      const res = await calendar.events.insert({
        calendarId: req.calendarId,
        requestBody: req.requestBody,
        sendUpdates: req.sendUpdates || 'none'
      });
      result = res.data;
      break;
    }
    case 'patch': {
      const res = await calendar.events.patch({
        calendarId: req.calendarId,
        eventId: req.eventId,
        requestBody: req.requestBody
      });
      result = res.data;
      break;
    }
    case 'delete': {
      await calendar.events.delete({
        calendarId: req.calendarId,
        eventId: req.eventId,
        sendUpdates: req.sendUpdates || 'all'
      });
      result = true;
      break;
    }
    case 'get': {
      const res = await calendar.events.get({
        calendarId: req.calendarId,
        eventId: req.eventId
      });
      result = res.data;
      break;
    }
    case 'list': {
      const res = await calendar.events.list({
        calendarId: req.calendarId,
        timeMin: req.timeMin,
        timeMax: req.timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500
      });
      result = { items: res.data.items || [] };
      break;
    }
    case 'getCal': {
      const res = await calendar.calendars.get({ calendarId: req.calendarId });
      result = res.data;
      break;
    }
    default:
      throw new Error('Unknown calendar op: ' + req.op);
  }

  fs.writeFileSync(outFile, JSON.stringify({ ok: true, result }));
}

main().catch((err) => {
  try {
    fs.writeFileSync(process.argv[3], JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
  } catch (e) {
    console.error(err);
  }
  process.exit(1);
});
