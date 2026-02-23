# Auto Art

## Responsibilities

- Python (`generate_art.py`) is responsible for image generation only.
- MongoDB writes are owned by Node (`server.js` via `Artwork.create`).

## Pages

- `GET /` serves the landing page: `public/landing.html`
- `GET /app` serves the purchase/display page: `public/app.html`

## Generation Modes

- Local development:
  - Set `AUTO_GENERATE=true` to enable an in-process checker.
  - Optional: set `AUTO_GENERATE_INTERVAL_SEC=60` (default is `60`).
  - On startup, the server immediately checks whether an active `for_sale` artwork exists and generates one if needed.
  - Manual trigger in local: use `POST /dev/generate-now` with `x-dev-key: <DEV_SECRET>`.
- Production (Render):
  - Keep in-process auto-generation disabled by default.
  - Set `AUTO_GENERATE=false` (or leave unset).
  - `POST /cron/run` is production-only (`NODE_ENV === "production"`).
  - Use an external cron job to `POST /cron/run` with header `x-cron-key: <CRON_SECRET>`.

## Render Production Setup

- Python dependencies:
  - `npm install` runs `postinstall`, which runs `pip install -r requirements.txt`.
  - This installs `Pillow` required by `generate_art.py`.
- Required environment variables on Render:
  - `NODE_ENV=production`
  - `MONGODB_URI`
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `FRONTEND_URL`
  - `CRON_SECRET`
  - `AUTO_GENERATE=false` (recommended)
  - Optional: `PYTHON_CMD=python3`
- Cron (every 3 hours):
  - Endpoint: `POST https://<your-service>.onrender.com/cron/run`
  - Header: `x-cron-key: <CRON_SECRET>`
  - If you use Render Cron Job (`bash scripts/run_cron.sh`), set these env vars on the cron service:
    - `APP_URL=https://<your-service>.onrender.com` (推奨。`WEB_SERVICE_URL` でも可)
    - `CRON_KEY=<CRON_SECRET>` (or `CRON_SECRET`)

## Dev Force Generate Endpoint

- Route: `POST /dev/generate-now`
- Availability: non-production only (`NODE_ENV !== "production"`)
- Auth header: `x-dev-key: <DEV_SECRET>`
- Purpose: force generation immediately for local testing.

## Notes

- After changing `.env`, you must restart the server process for new values to take effect.
- If `.env` was already tracked, run `git rm --cached .env` to stop tracking it.
- Use `GET /health` to confirm you are connected to the correct app and environment.

## PowerShell Quick Checks

```powershell
# 1) Confirm which app/environment is running on :3000
Invoke-RestMethod -Method Get http://localhost:3000/health

# 2) Dev-only force generation (NODE_ENV != production)
$headers = @{ "x-dev-key" = "YOUR_DEV_SECRET" }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/dev/generate-now -Headers $headers
```
