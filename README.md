# Feed Sponge

Soak up your doomscroll, wring out what was worth knowing.

Load a phone screen recording. The page samples one frame per second, Gemini splits it into posts and labels each one (topic, useful / fun / clickbait / rage, takeaway), and the posts fly into the sponge as the video plays. Hold **Space** to squeeze: useful posts drip into the jar, the rest squirts out.

Tabs: Sponge · Skill Map · Goldfish Quiz · Screen Time · Weekly Report · Wrapped.

## Pages
- `/` original vivid UI · `/storybook.html` storybook UI (final) · `/m` audience phone page (opened from the QR code)

## Audience mode (QR)
1. For a local demo, connect the computer and phone to the same Wi-Fi, run `npm start`, and open `/storybook.html` on the computer. The QR code automatically uses the computer's Wi-Fi address. Some guest or campus networks block connections between devices; if the phone cannot open the link, use Cloud Run below.
   For access from any network, deploy to Cloud Run and optionally set `PUBLIC_URL=https://<your-service>.run.app`.
2. On the big screen, click **📱 Audience QR**. People scan, screen-record ~60 s with their phone's built-in recorder, then pick the video.
3. The phone extracts frames itself (≈640 px, 1/sec, max 70) and sends small batches, so the video never uploads. Results + quiz show on their phone.
4. "One-tap recording (beta)" appears only where the browser supports screen capture (iOS 27+ Safari). Test on a real iPhone: if it stops when you switch to TikTok, stick with the built-in recorder.

## Debugging "can't read" problems
- Press **D** on the big screen for the Gemini debug log (latency, posts per batch, raw errors).
- The terminal prints `[chunk] ok in 2.1s` or `[chunk] attempt 1 failed: 429 ...` for every call. 429 = quota/rate limit; 400 = bad request (often the model name); 403/401 = auth.
- Failed batches are retried with backoff where appropriate; daily quota exhaustion stops the analysis with an explicit error.
- `MEDIA_RESOLUTION=MEDIA_RESOLUTION_HIGH` (optional) sharpens small text; if the model answers 400 it is switched off automatically. `GEMINI_MODEL=...` switches model.

## Run locally

```bash
npm install
cp .env.example .env        # then fill it in (see below)
npm start                   # http://localhost:8080
```

No credentials yet? `npm run mock` runs the full flow with fake labels.

### Credentials (pick one)

**A. Vertex AI, billed to your Google Cloud credits**
```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable aiplatform.googleapis.com
gcloud auth application-default login --project YOUR_PROJECT_ID
```
Then in `.env`: `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID`, `GOOGLE_CLOUD_LOCATION=global`.

**B. Gemini API key** from https://aistudio.google.com: set `GEMINI_API_KEY` in `.env` and remove the Vertex lines.

## Deploy to Cloud Run (a public URL for judges)

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com aiplatform.googleapis.com
PROJECT=$(gcloud config get-value project)
PNUM=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:${PNUM}-compute@developer.gserviceaccount.com" --role="roles/aiplatform.user"

gcloud run deploy feed-sponge --source . --region us-central1 --allow-unauthenticated \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=global,GEMINI_MODEL=gemini-3.5-flash
```
On Cloud Run, Vertex auth uses the service account, so no key is shipped.

## Recording tips
- iPhone: Control Center → Screen Recording. Scroll 30–90 s; pause ~2 s on each post.
- If the page says it can't decode the file, convert to MP4 (H.264), e.g. QuickTime → File → Export As → 1080p.
- Up to 90 frames are sent per recording (1 per second; longer videos are sampled more sparsely).

## Privacy (pitch line)
Frames are sent to Gemini and processed in memory only: nothing is stored or logged on our server, and the original video never leaves the browser. Per-IP rate limits apply to `/api/chunk` and `/api/recap`.

## Tuning
- `GEMINI_MODEL` switches model (default `gemini-3.8-flash`; this project's deployed configuration uses `gemini-3.5-flash`).
- If Gemini is unreachable, the page reports the error; it does not invent labels.
