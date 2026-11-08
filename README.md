# Feed Sponge

Soak up your doomscroll, wring out what was worth knowing.

**Live demo:** [Big screen](https://feed-sponge-771463214342.us-central1.run.app/storybook.html) · [Phone page](https://feed-sponge-771463214342.us-central1.run.app/m) · [Concept demo](https://feed-sponge-771463214342.us-central1.run.app/concept.html) · [Informer App](https://wl333-feed-sponge.go.informer-apps.com/) (`informer-app/`)

Screen-record your scroll. Gemini reads one frame per second, splits it into posts and labels each one (useful / fun / clickbait / rage, topic, app, takeaway). The posts fly into a sponge that cheers up on useful posts and sulks on junk; hold to squeeze: useful takeaways drip into the jar, junk splats out. Then a Goldfish Quiz (what you actually saw + fun facts about what you kept watching), a scroller persona, badges and a live leaderboard.

## How it fits together
```
phone (QR) ──/m──► this server (Cloud Run) ──► Gemini on Vertex AI   (reading frames, recap, quiz, Google Search grounding)
                         │
                         └──/api/sessions──► Informer App "Feed Sponge" (Postgres: sessions, topics, quiz answers, badges)
                                                    └── 📊 Dashboard on the big screen
```
- The video never leaves the phone: frames are extracted in the browser and read in memory.
- Only counts, topics and right/wrong answers are saved (in Informer), and only if the person joins the leaderboard.

## Pages
- `/` original vivid UI · `/storybook.html` storybook UI (final) · `/m` audience phone page (opened from the QR code) · `/concept.html` simulated future features for the demo video

## Sponge character
New asset pack in `public/assets/sponge/`, music in `public/assets/music/`. Mood: Wilted at start; useful posts lift it, entertainment a little, clickbait/rage drop it; idle sinks back to Wilted. The look changes automatically with the date; test others with `?look=christmas`, `?look=halloween`, `?look=summer` … Birthday look date: `SPONGE_BIRTHDAY` in `storybook.html`.

## Audience mode (QR)
1. Deploy to Cloud Run (below) so phones can reach it. Add `PUBLIC_URL=https://<your-service>.run.app` to the env vars (optional; otherwise the page's own address is used).
2. On the big screen, click **📱 Audience QR**. People scan, screen-record ~60 s with their phone's built-in recorder, then pick the video.
3. The phone extracts frames itself (≈640 px, 1/sec, max 70) and sends small batches, so the video never uploads. Results + quiz show on their phone.
4. **Leaderboard + badges:** after their results, people can tap *Join the leaderboard*. This server forwards only counts, topics and right/wrong answers to the Informer app (`INFORMER_APP_URL`, default `https://wl333-feed-sponge.go.informer-apps.com`), which stores them, awards badges and shows them live on its **📊 Dashboard**. Gemini/Vertex calls stay on this server, so the Informer free tier isn't used for AI. It needs `INFORMER_APP_KEY` in `.env`: an App API key from the Informer app's **Access → API keys → New key** (sent as `Authorization: Bearer …`). Set `INFORMER_APP_URL=` (empty) to turn the leaderboard off.
4. "One-tap recording (beta)" appears only where the browser supports screen capture (iOS 27+ Safari). Test on a real iPhone: if it stops when you switch to TikTok, stick with the built-in recorder.

## Debugging "can't read" problems
- Press **D** on the big screen for the Gemini debug log (latency, posts per batch, raw errors).
- The terminal prints `[chunk] ok in 2.1s` or `[chunk] attempt 1 failed: 429 ...` for every call. 429 = quota/rate limit; 400 = bad request (often the model name); 403/401 = auth.
- Failed batches are retried automatically (3 tries server-side, 2 more client-side).
- **Quiz:** up to 5 questions. 🐟 *Recall* questions test what was on screen. 🧠 *Fun fact* questions turn what you kept watching for fun (cats, basketball, makeup…) into one true fact, checked with Grounding with Google Search; the Google search suggestions are shown under the score, as Google requires. `GROUNDING=off` turns search off. Search grounding is billed separately from tokens once the free allowance is used. If the model rejects search + JSON, or returns cut-off JSON with search on, the server retries without search automatically.
- **Concept demo for the video:** open `/concept.html` (press Play, or keys 1–6 for single scenes, H hides the controls before you record). Simulated screens only: floating sponge, Dynamic Island, warning, app lock, lock screen + widget, finish-a-task-to-squeeze.
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
gcloud auth application-default login
```
Then in `.env`: `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID`, `GOOGLE_CLOUD_LOCATION=global`.

**B. Gemini API key** from https://aistudio.google.com: set `GEMINI_API_KEY` in `.env` and remove the Vertex lines.

## Deploy to Cloud Run (a public URL for judges and audience phones)

```bash
bash deploy-cloudrun.sh
```
The script reads `GOOGLE_CLOUD_PROJECT`, `GEMINI_MODEL`, `INFORMER_APP_URL` and `INFORMER_APP_KEY` from `.env`, enables Cloud Run / Cloud Build / Vertex AI, gives the Cloud Run service account the Vertex AI User role, deploys, and sets `PUBLIC_URL` so the Audience QR points at the public address. If an org policy blocks public (allUsers) access, it redeploys with `--no-invoker-iam-check` instead. Vertex auth uses the service account, so no Google key is shipped. Run it again after any code change.

## Recording tips
- iPhone: Control Center → Screen Recording. Scroll 30–90 s; pause ~2 s on each post.
- If the page says it can't decode the file, convert to MP4 (H.264), e.g. QuickTime → File → Export As → 1080p.
- Up to 90 frames are sent per recording (1 per second; longer videos are sampled more sparsely).

## Privacy (pitch line)
Frames are sent to Gemini and processed in memory only: nothing is stored or logged on our server, and the original video never leaves the browser. Per-IP rate limit on `/api/analyze`.

## Tuning
- `GEMINI_MODEL` switches model (default `gemini-3.8-flash`).
- If Gemini is unreachable, the page falls back to local swipe detection with sample labels (thresholds `SWIPE`, `SETTLE`, `CHANGE` in `public/index.html`).
