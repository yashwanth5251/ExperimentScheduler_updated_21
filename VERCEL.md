# Vercel deployment

This app runs on Vercel as a single serverless Express function (`api/index.js`).
All Book / Manage / Admin panels and the full `Code.gs` API surface are preserved.

## Why Redis is required on Vercel

Vercel functions have an ephemeral filesystem. Without Redis, bookings/slots reset on cold starts.
Use **Upstash Redis** (free) or **Vercel KV** so nothing is lost.

## Deploy steps

1. Push this repo to GitHub (already: `ExperimentScheduler_updated_21`).
2. Import the repo at [vercel.com/new](https://vercel.com/new).
3. Add a Redis store:
   - Vercel dashboard → Storage → Create → Upstash Redis (or KV), **connect to this project**  
     (sets `KV_REST_API_URL` / `KV_REST_API_TOKEN` or Upstash equivalents automatically),  
   - **or** manually set:
     - `UPSTASH_REDIS_REST_URL`
     - `UPSTASH_REDIS_REST_TOKEN`
4. Set environment variables:

| Variable | Value |
|----------|--------|
| `ALLOW_INSECURE_DEMO` | `1` (UI works; emails/calendar logged only) **or** unset and configure SMTP + Google below |
| `ALLOW_EPHEMERAL_DATA` | only if you intentionally skip Redis (**new admins/bookings will not persist** — not recommended) |
| `ADMIN_OWNER_EMAIL` | `altersstudie@lin-magdeburg.de` |
| `ADMIN_DEFAULT_PASSWORD` | `123456` |
| `SCRIPT_TIMEZONE` | `Europe/Berlin` |
| `BASE_URL` | your production URL, e.g. `https://your-app.vercel.app` |
| `CRON_SECRET` | any long random string (optional; protects cron) |

**Without Redis/KV**, `/health` reports `"persistence":"file"`. Creating admins may briefly look successful on one serverless instance, then disappear — login will fail. Always connect Redis before managing accounts.

For full email + calendar (no demo mode), also set:

| Variable | Value |
|----------|--------|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | your SMTP |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | full service-account JSON as one line |
| `GOOGLE_DEFAULT_CALENDAR_ID` | owner calendar id/email |
| `GOOGLE_PARTICIPANT_CALENDAR_ID` | participant calendar id/email |

5. Deploy. Framework preset: **Other**. Build command: leave empty (or `npm install --omit=optional`). Output: n/a.
6. Open:
   - `https://YOUR-APP.vercel.app/book`
   - `https://YOUR-APP.vercel.app/admin` — `altersstudie@lin-magdeburg.de` / `123456`

## Local

```bash
cp .env.example .env
npm install --omit=optional
npm start
```

## Notes

- Daily reminders: Vercel Cron hits `/api/cron/reminders` at 07:00 UTC schedule in `vercel.json` (adjust as needed).
- PDF generation uses PDFKit on Vercel (Puppeteer is optional/local only).
- Function timeout is 60s; runtime is cached on warm instances.
