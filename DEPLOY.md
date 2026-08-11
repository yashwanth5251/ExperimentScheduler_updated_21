# Deploy

## Why not Vercel?

This app is a long-running Express server with on-disk data, SMTP, and Google Calendar.
Vercel’s serverless model does not fit well (ephemeral `/tmp`, cold starts, auth/CLI issues).

**Use Render instead** (free Node web service).

## One-click Render deploy

1. Open: https://render.com/deploy?repo=https://github.com/yashwanth5251/ExperimentScheduler_updated_21
2. Sign in with GitHub if asked.
3. Leave `ALLOW_INSECURE_DEMO=1` for a working UI without SMTP/Calendar credentials (emails/events are logged only).
4. Click **Apply** / **Create Web Service**.
5. After deploy finishes, open the `.onrender.com` URL:
   - `/book` — participant booking  
   - `/manage` — manage appointment  
   - `/admin` — admin portal (`altersstudie@lin-magdeburg.de` / `123456`)

Free Render services sleep after ~15 minutes idle; the first request after sleep can take 30–60s.

## Production SMTP + Calendar later

Unset `ALLOW_INSECURE_DEMO` and set `SMTP_*` plus `GOOGLE_SERVICE_ACCOUNT_JSON` (and calendar IDs) in the Render Environment tab.
