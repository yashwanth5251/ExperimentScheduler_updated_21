# Deploy

## Vercel (supported)

See **[VERCEL.md](./VERCEL.md)** for the full guide.

Summary:
1. Import the GitHub repo into Vercel.
2. Connect **Upstash Redis / Vercel KV** (so bookings survive cold starts).
3. Set `ALLOW_INSECURE_DEMO=1` for a working demo, or configure SMTP + `GOOGLE_SERVICE_ACCOUNT_JSON` for full email/calendar.
4. Deploy → open `/book` and `/admin`.

All participant + admin functionality from `Code.gs` is kept; the app runs as one Express serverless function.

## Render (alternative)

See `render.yaml` and [Render deploy](https://render.com/deploy?repo=https://github.com/yashwanth5251/ExperimentScheduler_updated_21) if you prefer a long-running Node process.
