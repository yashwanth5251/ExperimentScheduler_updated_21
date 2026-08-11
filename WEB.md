# Local web app (Node.js)

This folder now also runs as a standalone website. Original Apps Script files (`Code.gs` + HTML) are kept; a Node compatibility layer provides Sheets/Mail/Calendar/Locks.

## Quick start

1. `cp .env.example .env` and fill in **SMTP_*** and **GOOGLE_SERVICE_ACCOUNT_FILE** (required).
2. Place your Google service-account JSON under `credentials/` and share the default + participant calendars with that account (“Make changes to events”). Set `GOOGLE_CALENDAR_IMPERSONATE` if you use domain-wide delegation.
3. `npm install`
4. `npm start`
5. Open:
   - Booking: http://localhost:3000/book
   - Manage: http://localhost:3000/manage
   - Admin: http://localhost:3000/admin

Default Main Admin (seeded into empty SQLite DB): email from `ADMIN_OWNER_EMAIL` / password `123456` (or `ADMIN_DEFAULT_PASSWORD`).

Business logic remains in `Code.gs` (unchanged). Client pages call the same function names via a `google.script.run` → `/api/run` shim.
