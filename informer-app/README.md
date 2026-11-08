# Feed Sponge — Informer App

Screen-record your scroll, see what you actually learned, and watch your feed health improve.
This folder is the Informer Apps version of Feed Sponge (for **Best Use of Informer Apps**).

| Page | What it is |
|---|---|
| `index.html` | Big screen: the sponge, live Gemini/Informer AI reading, quiz, Wrapped, **📊 Dashboard**, **📱 Audience QR** |
| `m.html` | Audience phone page (the QR opens it): guided screen recording → upload → results → quiz → **join the leaderboard** |

## What lives in Informer

| Informer feature | Used for |
|---|---|
| **App workspace (Postgres) + migrations** | `fs_users`, `fs_sessions`, `fs_session_apps`, `fs_session_topics`, `fs_quiz_answers` (topic + right/wrong only), `fs_badges`. `002-seed-virtual-users.sql` adds 24 virtual users × 30 days so the dashboard shows the product after launch (timestamps are relative to deploy time) |
| **Server routes** (`server/public/*`) | `chunk` (read frames), `recap` (persona + quiz), `sessions` (save a scroll, award badges), `dashboard` (all charts), `health` |
| **Public serving** (`public: true`) | Audience phones open `m.html` without an Informer login |
| **Informer AI** (`models/*/_object`) | Recaps and quizzes; frame reading too once it passes a vision check |
| **App-owned integration + secret** (`integrations: gemini`, `$env.GEMINI_API_KEY`) | Reads frames when Informer AI can't see images |

Frames are extracted **in the browser** (1/sec, max 70) and only small JPEG batches go to the server. Only counts are stored (useful / fun / bait / rage per app) — never frames, titles or takeaways.

### How the AI engine is chosen (`server/_lib/feed.js`)
`AI_ENGINE=auto` (default): before trusting Informer AI with a feed, the server sends it a small image that reads **SPONGE47** and asks it to read it back. Pass → Informer AI reads frames. Fail → Gemini reads frames (a model that can't see images would otherwise invent posts). The result is cached for 6 hours in `fs_settings`. Recaps (text only) always try Informer AI first. Force one engine with `AI_ENGINE=informer` or `AI_ENGINE=gemini`.

## Deploy

**You need:** your Informer server URL and an admin account (Team Admin or above). Public pages need **Informer 2026.2.0+** — open `https://<server>/api/about` to check; on older servers the phone page needs an Informer login.

1. Put the connection in `.env` (git-ignored). Either a username and password:
   ```
   INFORMER_URL=https://<server>
   INFORMER_USER=admin
   INFORMER_PASS='<password>'
   ```
   or an API token from **Administration → API Tokens** (must be more than Read Only): `INFORMER_API_KEY=...` instead of the user and password.
2. Deploy (Node.js 20.19+ or 22.12+):
   ```bash
   npm install
   npm run deploy
   ```
   The app id is already in `package.json`, so `npx informer-init` isn't needed. Deploy runs the migrations (schema + 24 virtual users), registers the server routes and prints the app URL (`https://<server>/api/apps/<owner>:<slug>/view`). Running it again updates the same app.
3. In Informer, set the app's environment values (the deploy creates them as empty placeholders): `GEMINI_API_KEY` (from aistudio.google.com), `GEMINI_MODEL` (`gemini-3.5-flash`), `AI_ENGINE` (`auto`), `GROUNDING` (`on`).
4. Open the printed URL, click **📊 Dashboard**, then **📱 Audience QR**.

`npm run dev` runs it locally against your live Informer server (hot reload, real routes and data).

## Quiz, badges and the dashboard
- Quiz questions are 🐟 **recall** (about a post on screen) or 🧠 **fun fact** (a true fact about a topic they watched for fun, checked with Google Search). Each answer is stored as topic + right/wrong.
- Phones keep a random `client_key`, so the same person's streak, jar total and topics add up across scrolls.
- Badges: 🧽 First Squeeze · 🔎 Fact Finder · 💧 Squeezed Dry (perfect quiz, 3+) · 🍯 1st Full Jar (10 right answers in total) · 🧠 Curious Sponge (right answers in 5 topics) · 🔥 Streak Sponge (quiz 3 days in a row) · 🧘 Rage Resistant · 🥦 Brain Food · 🫠 Doom Survivor.
- Dashboard: feed health per day, junk by app, **what everyone scrolls** (posts by topic, gold = taught something), **knowledge absorbed week by week** (recall vs fun-fact accuracy, most-learned fun-fact topics), leaderboard, badge wall.

## Debugging
- Press **D** on the big screen for the AI debug log (latency, posts per batch, raw errors).
- The app's **Logs** tab shows `[chunk] 3 frames → 2 posts via gemini in 2.1s` or the failure with its status. 429 = rate limit (the page slows down and merges frames automatically).

## Pitch notes (Best Use of Informer Apps)
- One `npm run deploy` ships the UI, the database schema + seed, the server routes, the Gemini integration and its secret slot.
- The dashboard is real SQL over the app's own workspace: daily information-diet health, junk share by app, quiz recall by week, a friends leaderboard and a badge wall. Audience members appear on it live, marked **LIVE**.
- Privacy by design: the video never leaves the phone; only label counts are stored.
- Next on Informer: an **agent** that sends each user a weekly "feed nutrition" digest, **channels** to push leaderboard updates instead of polling, and **Informer GO** as the phone app.

## Sponge character (asset pack v1)
- Files live in `public/assets/sponge/` (animated idle/reaction WebP per mood, decorations, effect symbols, pre-composed looks) and `public/assets/music/feed-sponge-loop.m4a` (background loop).
- **Mood:** 7 levels, Puddle → Wilted → Grumpy → Neutral → Happy → Excited → 100% Happy. Starts Wilted. A useful post lifts it about one level (a run of useful posts climbs faster), entertainment lifts it a little, clickbait/rage drops it about one level. With no new post for 3 s it sinks one level every 6 s, down to Wilted.
- **Look:** chosen automatically from the date — Christmas (Dec 1–26, antlers on Dec 24–25), Valentine's (Feb 7–14), Halloween (Oct 15–31), Thanksgiving (10 days before → day after), the sponge's birthday (`SPONGE_BIRTHDAY`, currently `11-08`), otherwise Spring / Summer / Fall / Winter. For testing, add `?look=christmas` (or any look name) to the URL.
- Easter egg: poke the little sponge on top of the stats 5 times.
