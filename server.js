// Feed Sponge backend: serves the page and talks to Gemini.
//   POST /api/chunk  - a few frames of a screen recording (sent live while it plays) -> posts found in them
//   POST /api/recap  - the posts read so far -> scroller persona + a quiz about what was actually on screen
// Frames are processed in memory only. Nothing is written to disk or logged.
import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { GoogleGenAI } from "@google/genai";
import { phoneUrl } from "./phone-url.js";
import { describeGeminiError } from "./gemini-errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const USE_VERTEX = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";

let ai = null;
if (USE_VERTEX && process.env.GOOGLE_API_KEY) {
  // Vertex AI with an API key from the console's "Get API key" page (no gcloud needed)
  ai = new GoogleGenAI({ vertexai: true, apiKey: process.env.GOOGLE_API_KEY });
} else if (USE_VERTEX) {
  ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || "global",
  });
} else if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}
// No credentials means a clear CONFIG error, never invented posts. Fake labels only with MOCK=true.
const MOCK = process.env.MOCK === "true";
const MODE = MOCK ? "mock" : !ai ? "unconfigured" : USE_VERTEX ? "vertex" : "gemini-api";
const CONFIG_ERROR = { error: "Gemini isn't set up on the server. Add credentials to .env (see README) and restart.", code: "CONFIG" };

const TOPICS = [
  "Money", "Career", "Tech", "Science", "Health", "Fitness", "Language", "History", "News", "Cooking",
  "Food", "Travel", "Fashion", "Beauty", "Music", "Dance", "Sports", "Gaming", "Pets", "Memes",
  "Relationships", "Messages", "Shopping", "Clickbait", "Outrage", "Other",
];
const KINDS = ["info", "fun", "bait", "rage"];
const APPS = ["TikTok", "Instagram", "YouTube", "X", "Reddit", "Xiaohongshu", "Snapchat", "Facebook", "LinkedIn", "Slack", "Messages", "Browser", "Other"];
// The phone page's "Join the leaderboard" saves counts into the Informer app's database through this server
// (server-to-server, so phones never need Informer access). Empty INFORMER_APP_URL turns the leaderboard off.
// INFORMER_APP_KEY: an App API key from the Informer app's Access → API keys page (the app's routes need a signed-in caller).
const INFORMER_APP_KEY = String(process.env.INFORMER_APP_KEY || "").trim();
const INFORMER_APP_URL = String(process.env.INFORMER_APP_URL ?? "https://wl333-feed-sponge.go.informer-apps.com").replace(/\/+$/, "");

/* ---------- schemas ---------- */
const POST = {
  type: "object",
  properties: {
    start_frame: { type: "integer" },
    end_frame: { type: "integer" },
    continues_previous: { type: "boolean" },
    title: { type: "string" },
    app: { type: "string", enum: APPS },
    topic: { type: "string", enum: TOPICS },
    kind: { type: "string", enum: KINDS },
    takeaway: { type: "string" },
    details: { type: "array", items: { type: "string" } },
  },
  required: ["start_frame", "end_frame", "continues_previous", "title", "app", "topic", "kind", "takeaway", "details"],
};
const CHUNK_SCHEMA = { type: "object", properties: { posts: { type: "array", items: POST } }, required: ["posts"] };
const RECAP_SCHEMA = {
  type: "object",
  properties: {
    profile: {
      type: "object",
      properties: { persona_name: { type: "string" }, persona_line: { type: "string" }, algorithm_thinks: { type: "string" } },
      required: ["persona_name", "persona_line", "algorithm_thinks"],
    },
    quiz: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source_type: { type: "string", enum: ["recall", "interest"] },
          topic: { type: "string" },
          fact: { type: "string" },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer_index: { type: "integer" },
          explanation: { type: "string" },
          post_index: { type: "integer" },
        },
        required: ["source_type", "topic", "fact", "question", "options", "answer_index", "explanation", "post_index"],
      },
    },
  },
  required: ["profile", "quiz"],
};

/* ---------- prompts ---------- */
const chunkPrompt = (n, hasCtx, prevTitle) => `You are watching a phone screen recording of someone scrolling, a few seconds at a time. Below are the next ${n} frames, one per second, labelled Frame 0 to Frame ${n - 1}.${
  hasCtx ? `\nThe image labelled CONTEXT is the last frame of the previous batch. It belonged to the post titled "${prevTitle || "unknown"}". Use it only to tell whether the new frames continue that same post.` : ""
}

Group the new frames into posts. A new post starts when the user swipes or scrolls to different content: a new video, a new post, a different chat, paper, or app. Skip frames that show only system UI (Control Center, home screen, lock screen, recording indicator).

For each post:
- start_frame, end_frame: indices of the NEW frames it covers.
- continues_previous: true only if it is the same content as the CONTEXT post (then still fill the other fields).
- title: what is on screen, concrete, under 10 words (e.g. "Paper on LLM prompt-injection attacks").
- app: the app it is shown in, from the allowed list ("Other" if unsure).
- topic: the single best fit from the allowed list.
- kind: "info" if it teaches something concrete a viewer could repeat; "fun" for entertainment; "bait" for engagement farming (cliffhangers, "part 2", giveaways, comment bait); "rage" for content designed to provoke outrage.
- takeaway: for "info" posts, one plain sentence the viewer could remember and repeat. Otherwise "".
- details: up to 3 specific, checkable facts readable on screen (names, numbers, findings, definitions, conclusions) that a quiz could ask about. Empty if nothing is readable.
Use only what is visible in the frames. Never add outside facts. Reply with JSON only.`;

const recapPrompt = (posts, ground = false) => `Here are the posts someone scrolled past, in order, as JSON:
${JSON.stringify(posts.map((p, i) => ({ index: i, ...p })))}

1. profile (for a fun recap screen):
- persona_name: a playful 2-5 word archetype for this scroller.
- persona_line: one playful, kind sentence about their feed.
- algorithm_thinks: finish "The algorithm thinks you are someone who..." in under 20 words, from the topics only. No health, religion, sexuality, politics or other sensitive traits.

2. quiz: 3 to 5 multiple-choice questions, of two kinds.
a) source_type "recall": did they remember the SUBSTANCE of an "info" post they scrolled past?
- Must be answerable from that post's details/takeaway above, never from outside knowledge.
- Name the source naturally, e.g. "In the cybersecurity paper you scrolled past, what ...?"
- topic: the post's subject in 1-3 words. fact: the detail it tests, one sentence.
b) source_type "interest": most feeds are entertainment with nothing to remember, so turn what they kept watching into one surprising, true fact.
- Find the specific subject behind the fun posts from their titles (e.g. "cats", "basketball", "makeup", "home renovation"), most-watched first, one question per subject. Treat clickbait or outrage posts as an interest only through their harmless underlying subject.
- topic: that subject in 1-3 words, lowercase.
- fact: one well-established fact about it, the kind found in an encyclopedia or a science museum. Nothing disputed, no medical or health advice, no politics, nothing about real people's private lives.${ground ? "\n- Check the fact with Google Search first; if you cannot confirm it, pick a different fact." : ""}
- question: stands on its own and mentions the interest, e.g. "You watched a lot of cats. Why do cats purr?"
- post_index: the post that best shows that interest.
Order: recall questions first (at most 3, from the most concrete info posts), then interest questions until there are 5. With no usable info posts, write only interest questions.
For every question: 4 options, exactly one correct, plausible distractors of similar length and style, beginner-friendly, no trick questions. Never ask about timing or order ("what did you see 3 posts ago"). explanation: under 30 words.
Reply with JSON only.`;

/* ---------- helpers ---------- */
const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clientKey = (req) => str(req.get("x-sponge-session") || req.ip, 64);
// Optional: MEDIA_RESOLUTION=MEDIA_RESOLUTION_HIGH sharpens small text, but some models/regions reject it. Off by default.
// Fun-fact quiz questions are checked with Grounding with Google Search (GROUNDING=off to disable).
// If the model rejects search + JSON schema together (400), it is switched off for this run and the call is retried without it.
let GROUND = String(process.env.GROUNDING || "on").toLowerCase() !== "off";
let MEDIA_RES = process.env.MEDIA_RESOLUTION && process.env.MEDIA_RESOLUTION !== "off" ? process.env.MEDIA_RESOLUTION : null;
const isB64 = (f) => typeof f === "string" && f.length < 2_000_000 && /^[A-Za-z0-9+/=]+$/.test(f);
const str = (v, n) => String(v ?? "").slice(0, n);

// One Gemini call with retries: 429 / 5xx / network / malformed JSON are retried up to 3 times with backoff.
// Logs timing and error codes only (never frame content).
async function ask(parts, schema, tag, opts = {}) {
  const t0 = Date.now();
  let lastErr, groundThis = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const config = { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2 };
      if (MEDIA_RES && tag === "chunk") config.mediaResolution = MEDIA_RES;
      const grounded = !!(opts.ground && GROUND && groundThis);
      if (grounded) config.tools = [{ googleSearch: {} }];
      const r = await ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }], config });
      const text = r.text || "";
      let data;
      try { data = JSON.parse(text); }
      catch { const m = text.match(/\{[\s\S]*\}/); try { data = m && JSON.parse(m[0]); } catch {} }
      if (!data || typeof data !== "object" || !(schema.required || []).every((k) => k in data)) throw Object.assign(new Error("Gemini returned no usable JSON"), { status: "BAD_JSON" });
      const gm = r.candidates?.[0]?.groundingMetadata;
      console.log(`[${tag}] ok in ${((Date.now() - t0) / 1000).toFixed(1)}s${attempt > 1 ? ` (attempt ${attempt})` : ""}${grounded ? ` · search queries: ${gm?.webSearchQueries?.length || 0}` : ""}`);
      return { data, search: grounded ? gm?.searchEntryPoint?.renderedContent || null : null };
    } catch (e) {
      lastErr = e;
      const st = e?.status;
      console.error(`[${tag}] attempt ${attempt} failed: ${st || "network"} ${str(e?.message, 220)}`);
      // Known issue on some Gemini 3.x Flash models: with search on, the JSON can come back cut off. Retry once without search.
      if (st === "BAD_JSON" && opts.ground && groundThis) { groundThis = false; console.error(`[${tag}] grounded reply was not valid JSON; retrying without search`); attempt--; continue; }
      if (st === 400 && opts.ground && GROUND) { GROUND = false; console.error(`[${tag}] 400 with Google Search grounding on; retrying without it (now off)`); attempt--; continue; }
      if (st === 400 && MEDIA_RES && tag === "chunk") { MEDIA_RES = null; console.error("[chunk] 400 with mediaResolution on; retrying without it (now off)"); attempt--; continue; }
      // 429 is NOT retried here: the browser slows down and merges frames instead of hammering the quota.
      const retryable = !st || st === "BAD_JSON" || (typeof st === "number" && st >= 500);
      if (!retryable || attempt === 3) break;
      await sleep(st === 429 ? 2000 * attempt : 700 * attempt);
    }
  }
  throw lastErr;
}
const errStatus = (e) => describeGeminiError(e).status;
const retryAfter = (e) => { const m = String(e?.message || "").match(/retry(?:Delay|\s+in)?\D{0,6}(\d+(?:\.\d+)?)\s*s/i); return m ? Math.min(60, Math.ceil(+m[1])) : null; };

function cleanPosts(list, n) {
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      const s = Math.max(0, Math.min(n - 1, parseInt(p.start_frame, 10) || 0));
      const e = Math.max(s, Math.min(n - 1, parseInt(p.end_frame, 10) || s));
      const kind = KINDS.includes(p.kind) ? p.kind : "fun";
      return {
        start_frame: s,
        end_frame: e,
        continues_previous: !!p.continues_previous,
        title: str(p.title || "Untitled post", 120),
        app: APPS.includes(p.app) ? p.app : "Other",
        topic: TOPICS.includes(p.topic) ? p.topic : "Other",
        kind,
        takeaway: kind === "info" ? str(p.takeaway, 300) : "",
        details: (Array.isArray(p.details) ? p.details : []).slice(0, 3).map((d) => str(d, 200)).filter(Boolean),
      };
    })
    .sort((a, b) => a.start_frame - b.start_frame);
}

/* ---------- mock data (no Google calls) ---------- */
const MOCK_POSTS = [
  ["[mock] Cat knocks glasses off counter", "Pets", "fun", "", []],
  ["[mock] Paper on prompt-injection attacks", "Tech", "info", "Indirect prompt injection hides instructions inside content an AI agent reads.", ["Attack hides instructions in web pages or emails the agent reads", "Tested on 4 agent frameworks; all were vulnerable", "Mitigation proposed: separate trusted and untrusted input channels"]],
  ["[mock] Attic find cliffhanger, part 7", "Clickbait", "bait", "", []],
  ["[mock] Why checking accounts lose money", "Money", "info", "Idle cash in checking loses value to inflation.", ["High-yield savings accounts paid about 4% vs near 0% for checking"]],
  ["[mock] City council outrage clip", "Outrage", "rage", "", []],
];
let mockI = 0;

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// PUBLIC_URL: the address phones should open (your Cloud Run URL). Falls back to whatever host the page was loaded from.
app.get("/api/health", (req, res) => res.json({ mode: MODE, model: MOCK ? null : MODEL, leaderboard: !!INFORMER_APP_URL, publicUrl: phoneUrl({ protocol: req.protocol, host: req.get("host") }, os.networkInterfaces(), process.env.PUBLIC_URL || "") }));
app.get("/m", (_req, res) => res.sendFile(path.join(__dirname, "public", "m.html")));

app.post("/api/chunk", async (req, res) => {
  if (limited("c:" + clientKey(req), 120)) return res.status(429).json({ error: "Too many requests. Slow down for a minute." });
  const { frames, times, context } = req.body || {};
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 12 || !frames.every(isB64))
    return res.status(400).json({ error: "Send 1-12 base64 JPEG frames." });
  const n = frames.length;

  if (MOCK) {
    await new Promise((r) => setTimeout(r, 600));
    if (Math.random() < +(process.env.MOCK_429 || 0)) return res.status(429).json({ error: "Gemini is rate-limited (429). mock", code: 429, retryAfter: 2 });
    const [title, topic, kind, takeaway, details] = MOCK_POSTS[mockI++ % MOCK_POSTS.length];
    return res.json({ posts: cleanPosts([{ start_frame: 0, end_frame: n - 1, continues_previous: false, title, app: "TikTok", topic, kind, takeaway, details }], n) });
  }
  if (!ai) return res.status(503).json(CONFIG_ERROR);

  const hasCtx = context && isB64(context.frame);
  const parts = [{ text: chunkPrompt(n, hasCtx, str(context?.title, 120)) }];
  if (hasCtx) parts.push({ text: "CONTEXT" }, { inlineData: { mimeType: "image/jpeg", data: context.frame } });
  frames.forEach((data, i) => {
    const t = Array.isArray(times) && Number.isFinite(times[i]) ? ` (t=${times[i]}s)` : "";
    parts.push({ text: `Frame ${i}${t}` }, { inlineData: { mimeType: "image/jpeg", data } });
  });
  try {
    const { data } = await ask(parts, CHUNK_SCHEMA, "chunk");
    res.json({ posts: cleanPosts(data?.posts, n) });
  } catch (e) {
    const d = describeGeminiError(e);
    const why = d.quotaType === "daily" ? "Gemini's daily quota is used up (429). " : d.code === 429 ? "Gemini is rate-limited (429). " : "Gemini couldn't read these frames. ";
    res.status(d.status).json({ error: why + str(d.message, 160), code: d.code, quotaType: d.quotaType, retryAfter: d.retryAfter ?? retryAfter(e) });
  }
});

app.post("/api/recap", async (req, res) => {
  if (limited("r:" + clientKey(req), 12)) return res.status(429).json({ error: "Too many requests. Wait a minute." });
  const list = Array.isArray(req.body?.posts) ? req.body.posts.slice(0, 80) : [];
  if (!list.length) return res.status(400).json({ error: "No posts to recap." });
  const posts = list.map((p) => ({
    title: str(p.title, 120),
    topic: str(p.topic, 30),
    kind: str(p.kind, 10),
    takeaway: str(p.takeaway, 300),
    details: (Array.isArray(p.details) ? p.details : []).slice(0, 5).map((d) => str(d, 200)),
  }));

  let data, search = null;
  if (MOCK) {
    const i = posts.findIndex((p) => p.details.length);
    data = {
      profile: { persona_name: "[mock] The Part 2 Hostage", persona_line: "Mock mode: connect Gemini to see your real persona.", algorithm_thinks: "is testing this app without Gemini" },
      quiz: [
        ...(i < 0 ? [] : [{ source_type: "recall", topic: posts[i].topic, fact: posts[i].details[0], question: `[mock] In "${posts[i].title}", which of these was shown?`, options: [posts[i].details[0], "Nothing about it", "A cooking tip", "A dance tutorial"], answer_index: 0, explanation: posts[i].details[0], post_index: i }]),
        { source_type: "interest", topic: "[mock] cats", fact: "[mock] fact placeholder", question: "[mock] Interest question placeholder: connect Gemini for a real fun fact.", options: ["[mock] A", "[mock] B", "[mock] C", "[mock] D"], answer_index: 0, explanation: "[mock] Mock mode has no real facts.", post_index: Math.max(0, posts.findIndex((p) => p.kind === "fun")) },
      ],
    };
  } else if (!ai) {
    return res.status(503).json(CONFIG_ERROR);
  } else {
    try {
      ({ data, search } = await ask([{ text: recapPrompt(posts, GROUND) }], RECAP_SCHEMA, "recap", { ground: true }));
    } catch (e) {
      const d = describeGeminiError(e);
      return res.status(d.status).json({ error: "Gemini couldn't write the recap. " + str(d.message, 160), code: d.code, quotaType: d.quotaType, retryAfter: d.retryAfter });
    }
  }
  const pr = data?.profile || {};
  const quiz = (Array.isArray(data?.quiz) ? data.quiz : [])
    .filter((q) => Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < q.options.length)
    .slice(0, 5)
    .map((q) => ({
      source_type: q.source_type === "interest" ? "interest" : "recall",
      topic: str(q.topic, 40),
      fact: str(q.fact, 300),
      question: str(q.question, 300),
      options: q.options.slice(0, 4).map((o) => str(o, 160)),
      answer_index: Math.min(q.answer_index, 3),
      explanation: str(q.explanation, 300),
      post_index: Math.max(0, Math.min(posts.length - 1, parseInt(q.post_index, 10) || 0)),
    }));
  res.json({
    profile: { persona_name: str(pr.persona_name || "The Feed Drifter", 60), persona_line: str(pr.persona_line, 200), algorithm_thinks: str(pr.algorithm_thinks, 200) },
    quiz,
    search, // Google Search suggestions (must be shown when grounding was used)
  });
});

/* ---------- leaderboard: forwarded to the Informer app (only counts, topics and right/wrong are sent) ---------- */
async function toInformer(req, res, method, path) {
  if (!INFORMER_APP_URL) return res.status(503).json({ error: "The leaderboard isn't connected (INFORMER_APP_URL is empty)." });
  if (!INFORMER_APP_KEY) return res.status(503).json({ error: "The leaderboard needs INFORMER_APP_KEY in .env (Informer app → Access → API keys)." });
  try {
    const r = await fetch(`${INFORMER_APP_URL}/api/public/${path}`, {
      method, headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${INFORMER_APP_KEY}` },
      body: JSON.stringify(req.body || {}), signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: `Informer answered ${r.status} without JSON` }; }
    if (r.status === 401 || r.status === 403) data = { error: `Informer refused the key (${r.status}). Check INFORMER_APP_KEY.` };
    console.log(`[leaderboard] ${method} ${path} → ${r.status}${r.ok ? "" : " " + str(text, 200)}`);
    res.status(r.status).json(data);
  } catch (e) {
    console.error(`[leaderboard] ${method} ${path} failed: ${str(e?.message, 160)}`);
    res.status(502).json({ error: "Couldn't reach the Informer leaderboard. " + str(e?.message, 120) });
  }
}
app.post("/api/sessions", (req, res) => {
  if (limited("s:" + clientKey(req), 10)) return res.status(429).json({ error: "Too many requests. Wait a minute." });
  toInformer(req, res, "POST", "sessions");
});
app.patch("/api/sessions/:id", (req, res) => {
  if (limited("s:" + clientKey(req), 10)) return res.status(429).json({ error: "Too many requests. Wait a minute." });
  toInformer(req, res, "PATCH", "sessions/" + (parseInt(req.params.id, 10) || 0));
});

app.listen(PORT, () => console.log(`Feed Sponge on http://localhost:${PORT}  (mode: ${MODE}${MOCK ? "" : ", model: " + MODEL})`));
