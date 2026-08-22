# Chef Social render worker

A long-running container that pulls render jobs from the app, cuts the videos with
native ffmpeg (5–10x faster than the in-browser build), uploads the results, and
posts them back. Customers can close the tab while it runs.

## How the handoff works

```
app  ──POST /api/public/render/claim──────────▶  worker gets one job + payload
worker ─POST /api/public/render/heartbeat────▶  every 30s: progress + lease renewal
worker ─POST /api/public/render-callback─────▶  finished cuts (or a failure)
app  ──email + browser notification──────────▶  "your videos are ready"
```

Every call is authenticated with the `x-worker-secret` header
(`RENDER_WORKER_SECRET`). Jobs carry a lease: if a worker dies, the job is handed
to the next worker automatically, up to `max_attempts` (3).

## Environment

App side (set as project secrets):

| Name | Purpose |
| --- | --- |
| `RENDER_WORKER_SECRET` | shared secret for the three endpoints above |
| `RENDER_WORKER_URL` | full URL of this worker, e.g. `https://chefsocial-worker.onrender.com` |
| `RENDER_QUEUE_ENABLED` | `1` switches the app from browser rendering to server rendering |
| `RESEND_API_KEY` / `RETENTION_EMAIL_FROM` | the "your videos are ready" email |
| `APP_URL` | used to build the callback URL and email links |

Worker side:

| Name | Purpose |
| --- | --- |
| `APP_URL` | e.g. `https://cravecut-video-magic.lovable.app` |
| `RENDER_WORKER_SECRET` | same value as above |
| `WORKER_ID` | any stable name, e.g. `fly-worker-1` |
| `PORT` | Render sets this automatically; the worker opens a small health server on it |
| _(no Supabase keys needed)_ | finished mp4s are uploaded back through the app at `/api/public/render/upload` |

## Running it

Locally (needs `ffmpeg` and `ffprobe` on PATH, plus the kit fonts in `FONT_DIR`):

```bash
cd worker && npm install && node index.mjs
```

With Docker (fonts and ffmpeg included):

```bash
cd worker && docker build -t chefsocial-worker .
docker run --rm --env-file .env chefsocial-worker
```

## Deploying on Render

This worker **must** run in a Docker container because it needs native `ffmpeg`.
Do **not** use Render's "Node" runtime — it has no video tooling.

1. Push this folder to a GitHub repo.
2. In Render, click **New → Web Service**.
3. Connect your GitHub account and select the repo.
4. Render should auto-detect the `Dockerfile`. If it asks for a language, pick **Docker**.
5. Choose an instance type with at least **2 vCPU / 4 GB RAM** (video rendering needs memory and disk).
6. Add these environment variables:
   - `APP_URL` = `https://cravecut-video-magic.lovable.app`
   - `RENDER_WORKER_SECRET` = the same secret stored in the app
   - `WORKER_ID` = any stable name, e.g. `render-worker-1`
   - `RESEND_API_KEY` = your Resend key (optional, for email alerts)
7. Click **Create Web Service**. Render will build the Docker image and start the worker.
8. Copy the live service URL and paste it into the app as `RENDER_WORKER_URL`.

## What the worker does per job

1. `POST /api/public/render/plan { action: "job" }` — signed clip URLs, brand
   details and the per-video sound choice.
2. Downloads every clip once, probes it with `ffprobe`, and scans it with
   `blackdetect`/`freezedetect` so dark or frozen shots lose to live ones.
3. `{ action: "concepts" }` then `{ action: "cut" }` — the same AI planners the
   browser editor uses, so a server render matches a browser render.
4. Per video: trim → scale/crop to 1080x1920 → 30fps → grade → `drawtext`
   overlays and end card → concat → optional licensed music mux.
5. Uploads the mp4, music mix and poster to the `outputs` bucket and posts them
   to `/api/public/render-callback`, which emails and pushes the owner.

Font kits map to files in `FONT_DIR`: Playfair Display (luxury/editorial), Bebas
Neue (bold), Caveat (handwritten), Plus Jakarta Sans (clean).
