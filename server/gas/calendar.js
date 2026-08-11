'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

function loadAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (!keyFile) {
    throw new Error('Missing required env var: GOOGLE_SERVICE_ACCOUNT_FILE');
  }
  const resolved = path.resolve(keyFile);
  if (!fs.existsSync(resolved)) {
    throw new Error('Google service account file not found: ' + resolved);
  }
  const impersonate = process.env.GOOGLE_CALENDAR_IMPERSONATE || undefined;
  return new google.auth.GoogleAuth({
    keyFile: resolved,
    scopes: ['https://www.googleapis.com/auth/calendar'],
    clientOptions: impersonate ? { subject: impersonate } : undefined
  });
}

function colorIdToEventColor(colorId) {
  // CalendarApp EventColor names map roughly to API colorIds 1-11
  return String(colorId || '');
}

function createCalendarEventWrapper(calendarApi, calendarId, eventResource, logger) {
  const event = {
    getId() {
      return eventResource.id || eventResource.iCalUID || '';
    },
    getDescription() {
      return eventResource.description || '';
    },
    setColor(colorId) {
      try {
        calendarApi.events.patch({
          calendarId,
          eventId: eventResource.id,
          requestBody: { colorId: colorIdToEventColor(colorId) }
        });
        eventResource.colorId = String(colorId);
      } catch (err) {
        if (logger) logger.log('setColor failed: ' + err);
      }
      return event;
    },
    deleteEvent() {
      try {
        calendarApi.events.delete({
          calendarId,
          eventId: eventResource.id,
          sendUpdates: 'all'
        });
      } catch (err) {
        if (logger) logger.log('deleteEvent failed: ' + err);
        throw err;
      }
    }
  };
  return event;
}

function syncCall(fn) {
  // Run async google API via child-less blocking: use deasync-style with Atomics + worker is complex.
  // Use execFileSync helper for calendar ops to keep Apps Script sync semantics.
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmpIn = path.join(os.tmpdir(), 'gcal_in_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.json');
  const tmpOut = path.join(os.tmpdir(), 'gcal_out_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(tmpIn, JSON.stringify(fn));
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'calendarSync.js'), tmpIn, tmpOut], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      env: process.env
    });
    const out = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
    if (!out.ok) throw new Error(out.error || 'Calendar API error');
    return out.result;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch (e) { /* ignore */ }
  }
}

function createCalendarApp(logger) {
  // Validate credentials exist at startup
  loadAuth();

  function getCalendar(calendarId) {
    const cal = {
      createEvent(title, start, end, options) {
        options = options || {};
        const guests = String(options.guests || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const result = syncCall({
          op: 'create',
          calendarId,
          requestBody: {
            summary: title,
            description: options.description || '',
            location: options.location || '',
            start: { dateTime: new Date(start).toISOString() },
            end: { dateTime: new Date(end).toISOString() },
            attendees: guests.map((email) => ({ email })),
            guestsCanModify: false
          },
          sendUpdates: options.sendInvites ? 'all' : 'none'
        });
        // Thin client for setColor/delete/getId — subsequent ops also go through syncCall
        return {
          getId() { return result.id || ''; },
          getDescription() { return result.description || ''; },
          setColor(colorId) {
            syncCall({
              op: 'patch',
              calendarId,
              eventId: result.id,
              requestBody: { colorId: String(colorId) }
            });
            return this;
          },
          deleteEvent() {
            syncCall({
              op: 'delete',
              calendarId,
              eventId: result.id,
              sendUpdates: 'all'
            });
          }
        };
      },
      getEventById(eventId) {
        if (!eventId) return null;
        try {
          const result = syncCall({
            op: 'get',
            calendarId,
            eventId
          });
          if (!result) return null;
          return {
            getId() { return result.id || eventId; },
            getDescription() { return result.description || ''; },
            setColor(colorId) {
              syncCall({
                op: 'patch',
                calendarId,
                eventId: result.id,
                requestBody: { colorId: String(colorId) }
              });
              return this;
            },
            deleteEvent() {
              syncCall({
                op: 'delete',
                calendarId,
                eventId: result.id,
                sendUpdates: 'all'
              });
            }
          };
        } catch (err) {
          if (logger) logger.log('getEventById failed: ' + err);
          return null;
        }
      },
      getEvents(from, to) {
        const result = syncCall({
          op: 'list',
          calendarId,
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString()
        });
        return (result.items || []).map((ev) => ({
          getId() { return ev.id || ''; },
          getDescription() { return ev.description || ''; },
          setColor(colorId) {
            syncCall({
              op: 'patch',
              calendarId,
              eventId: ev.id,
              requestBody: { colorId: String(colorId) }
            });
            return this;
          },
          deleteEvent() {
            syncCall({
              op: 'delete',
              calendarId,
              eventId: ev.id,
              sendUpdates: 'all'
            });
          }
        }));
      }
    };
    return cal;
  }

  return {
    getDefaultCalendar() {
      const id = process.env.GOOGLE_DEFAULT_CALENDAR_ID || 'primary';
      return getCalendar(id);
    },
    getCalendarById(id) {
      if (!id) return null;
      const mapped = process.env.GOOGLE_PARTICIPANT_CALENDAR_ID || id;
      try {
        // Probe access
        syncCall({ op: 'getCal', calendarId: mapped });
        return getCalendar(mapped);
      } catch (err) {
        if (logger) logger.log('getCalendarById failed: ' + err);
        return null;
      }
    },
    EventColor: {
      PALE_BLUE: '1',
      PALE_GREEN: '2',
      MAUVE: '3',
      PALE_RED: '4',
      YELLOW: '5',
      ORANGE: '6',
      CYAN: '7',
      GRAY: '8',
      BLUE: '9',
      GREEN: '10',
      RED: '11'
    }
  };
}

module.exports = { createCalendarApp, loadAuth };
