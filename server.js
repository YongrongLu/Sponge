// Feed Sponge backend: serves the page and talks to Gemini.
//   POST /api/chunk  - a few frames of a screen recording (sent live while it plays) -> posts found in them
//   POST /api/recap  - the posts read so far -> scroller persona + a quiz about what was actually on screen
// Frames are processed in memory only. Nothing is written to disk or logged.
import "dotenv/config";
import express from "express";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { describeGeminiError } from "./gemini-errors.js";
import { phoneUrl } from "./phone-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const USE_VERTEX = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";

let ai = null;
if (USE_VERTEX && process.env.GOOGLE_API_KEY) {
  // Vertex AI with an API key from the console's "Get API key" page (no gcloud needed)
  ai = new GoogleGenAI({ vertexai: true, apiKey: process.env.GOOGLE_API_KEY });
} else if (USE_VERTEX && process.env.GOOGLE_CLOUD_PROJECT) {
  ai = new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || "global",
  });
} else if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}
const MOCK = process.env.MOCK === "true";
const MODE = MOCK ? "mock" : !ai ? "unconfigured" : USE_VERTEX ? "vertex" : "gemini-api";

const TOPICS = [
  "Money", "Career", "Tech", "Science", "Health", "Fitness", "Language", "History", "News", "Cooking",
  "Food", "Travel", "Fashion", "Beauty", "Music", "Dance", "Sports", "Gaming", "Pets", "Memes",
  "Relationships", "Messages", "Shopping", "Clickbait", "Outrage", "Other",
];
const KINDS = ["info", "fun", "bait", "rage"];

/* ---------- schemas ---------- */
const POST = {
  type: "object",
  properties: {
    start_frame: { type: "integer" },
    end_frame: { type: "integer" },
    continues_previous: { type: "boolean" },
    title: { type: "string" },
    topic: { type: "string", enum: TOPICS },
    kind: { type: "string", enum: KINDS },
    takeaway: { type: "string" },
    details: { type: "array", items: { type: "string" } },
  },
  required: ["start_frame", "end_frame", "continues_previous", "title", "topic", "kind", "takeaway", "details"],
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
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer_index: { type: "integer" },
          explanation: { type: "string" },
          post_index: { type: "integer" },
        },
        required: ["question", "options", "answer_index", "explanation", "post_index"],
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
- topic: the single best fit from the allowed list.
- kind: "info" if it teaches something concrete a viewer could repeat; "fun" for entertainment; "bait" for engagement farming (cliffhangers, "part 2", giveaways, comment bait); "rage" for content designed to provoke outrage.
- takeaway: for "info" posts, one plain sentence the viewer could remember and repeat. Otherwise "".
- details: up to 3 specific, checkable facts readable on screen (names, numbers, findings, definitions, conclusions) that a quiz could ask about. Empty if nothing is readable.
Use only what is visible in the frames. Never add outside facts. Reply with JSON only.`;

const recapPrompt = (posts) => `Here are the posts someone scrolled past, in order, as JSON:
${JSON.stringify(posts.map((p, i) => ({ index: i, ...p })))}

1. profile (for a fun recap screen):
- persona_name: a playful 2-5 word archetype for this scroller.
- persona_line: one playful, kind sentence about their feed.
- algorithm_thinks: finish "The algorithm thinks you are someone who..." in under 20 words, from the topics only. No health, religion, sexuality, politics or other sensitive traits.

2. quiz: up to 5 multiple-choice questions testing whether they remember the SUBSTANCE of what they scrolled past.
- Prefer "info" posts with concrete details: findings, numbers, definitions, names, conclusions.
- Every question must be answerable from the details/takeaway given above, never from outside knowledge.
- Name the source naturally in the question, e.g. "In the cybersecurity paper you scrolled past, what ...?"
- Never ask about timing or order ("what did you see 3 posts ago").
- 4 options, exactly one correct, plausible distractors of similar length and style.
- explanation: one sentence pointing to the detail that answers it.
- post_index: the index of the source post.
- If fewer posts have usable details, write fewer questions (0 is fine).
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
let MEDIA_RES = process.env.MEDIA_RESOLUTION && process.env.MEDIA_RESOLUTION !== "off" ? process.env.MEDIA_RESOLUTION : null;
const isB64 = (f) => typeof f === "string" && f.length < 2_000_000 && /^[A-Za-z0-9+/=]+$/.test(f);
const str = (v, n) => String(v ?? "").slice(0, n);

// One Gemini call with retries: 5xx / network / malformed JSON are retried up to 3 times with backoff.
// Logs timing and error codes only (never frame content).
async function ask(parts, schema, tag) {
  const t0 = Date.now();
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const config = { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2 };
      if (MEDIA_RES && tag === "chunk") config.mediaResolution = MEDIA_RES;
      const r = await ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }], config });
      const text = r.text || "";
      let data;
      try { data = JSON.parse(text); }
      catch { const m = text.match(/\{[\s\S]*\}/); if (!m) throw Object.assign(new Error("Gemini returned no JSON"), { status: "BAD_JSON" }); data = JSON.parse(m[0]); }
      console.log(`[${tag}] ok in ${((Date.now() - t0) / 1000).toFixed(1)}s${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return data;
    } catch (e) {
      lastErr = e;
      const st = e?.status;
      console.error(`[${tag}] attempt ${attempt} failed: ${st || "network"} ${str(e?.message, 220)}`);
      if (st === 400 && MEDIA_RES && tag === "chunk") { MEDIA_RES = null; console.error("[chunk] 400 with mediaResolution on; retrying without it (now off)"); attempt--; continue; }
      // 429 is NOT retried here: the browser slows down and merges frames instead of hammering the quota.
      const retryable = !st || st === "BAD_JSON" || (typeof st === "number" && st >= 500);
      if (!retryable || attempt === 3) break;
      await sleep(700 * attempt);
    }
  }
  throw lastErr;
}

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

// PUBLIC_URL overrides local discovery, for example with a Cloud Run URL.
app.get("/api/health", (req, res) => res.json({ mode: MODE, model: MOCK || !ai ? null : MODEL, publicUrl: phoneUrl({ protocol: req.protocol, host: req.get("host") }, os.networkInterfaces(), process.env.PUBLIC_URL) }));
app.get("/m", (_req, res) => res.sendFile(path.join(__dirname, "public", "m.html")));

app.post("/api/chunk", async (req, res) => {
  if (limited("c:" + clientKey(req), 120)) return res.status(429).json({ error: "Too many requests. Slow down for a minute." });
  const { frames, times, context } = req.body || {};
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 12 || !frames.every(isB64))
    return res.status(400).json({ error: "Send 1-12 base64 JPEG frames." });
  const n = frames.length;

  if (!ai && !MOCK) return res.status(503).json({ error: "Gemini credentials are not configured.", code: "CONFIG" });

  if (MOCK) {
    await new Promise((r) => setTimeout(r, 600));
    if (Math.random() < +(process.env.MOCK_429 || 0)) return res.status(429).json({ error: "Gemini is rate-limited (429). mock", code: 429, retryAfter: 2 });
    const [title, topic, kind, takeaway, details] = MOCK_POSTS[mockI++ % MOCK_POSTS.length];
    return res.json({ posts: cleanPosts([{ start_frame: 0, end_frame: n - 1, continues_previous: false, title, topic, kind, takeaway, details }], n) });
  }

  const hasCtx = context && isB64(context.frame);
  const parts = [{ text: chunkPrompt(n, hasCtx, str(context?.title, 120)) }];
  if (hasCtx) parts.push({ text: "CONTEXT" }, { inlineData: { mimeType: "image/jpeg", data: context.frame } });
  frames.forEach((data, i) => {
    const t = Array.isArray(times) && Number.isFinite(times[i]) ? ` (t=${times[i]}s)` : "";
    parts.push({ text: `Frame ${i}${t}` }, { inlineData: { mimeType: "image/jpeg", data } });
  });
  try {
    const data = await ask(parts, CHUNK_SCHEMA, "chunk");
    res.json({ posts: cleanPosts(data?.posts, n) });
  } catch (e) {
    const issue = describeGeminiError(e);
    res.status(issue.status).json({ error: str(issue.message, 300), code: issue.code, quotaType: issue.quotaType, retryAfter: issue.retryAfter });
  }
});

app.post("/api/recap", async (req, res) => {
  if (limited("r:" + clientKey(req), 12)) return res.status(429).json({ error: "Too many requests. Wait a minute." });
  const list = Array.isArray(req.body?.posts) ? req.body.posts.slice(0, 80) : [];
  if (!list.length) return res.status(400).json({ error: "No posts to recap." });
  if (!ai && !MOCK) return res.status(503).json({ error: "Gemini credentials are not configured.", code: "CONFIG" });
  const posts = list.map((p) => ({
    title: str(p.title, 120),
    topic: str(p.topic, 30),
    kind: str(p.kind, 10),
    takeaway: str(p.takeaway, 300),
    details: (Array.isArray(p.details) ? p.details : []).slice(0, 5).map((d) => str(d, 200)),
  }));

  let data;
  if (MOCK) {
    const i = posts.findIndex((p) => p.details.length);
    data = {
      profile: { persona_name: "[mock] The Part 2 Hostage", persona_line: "Mock mode: connect Gemini to see your real persona.", algorithm_thinks: "is testing this app without Gemini" },
      quiz: i < 0 ? [] : [{ question: `[mock] In "${posts[i].title}", which of these was shown?`, options: [posts[i].details[0], "Nothing about it", "A cooking tip", "A dance tutorial"], answer_index: 0, explanation: posts[i].details[0], post_index: i }],
    };
  } else {
    try {
      data = await ask([{ text: recapPrompt(posts) }], RECAP_SCHEMA, "recap");
    } catch (e) {
      const issue = describeGeminiError(e);
      return res.status(issue.status).json({ error: str(issue.message, 300), code: issue.code, quotaType: issue.quotaType, retryAfter: issue.retryAfter });
    }
  }
  const pr = data?.profile || {};
  const quiz = (Array.isArray(data?.quiz) ? data.quiz : [])
    .filter((q) => Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < q.options.length)
    .slice(0, 5)
    .map((q) => ({
      question: str(q.question, 300),
      options: q.options.slice(0, 4).map((o) => str(o, 160)),
      answer_index: Math.min(q.answer_index, 3),
      explanation: str(q.explanation, 300),
      post_index: Math.max(0, Math.min(posts.length - 1, parseInt(q.post_index, 10) || 0)),
    }));
  res.json({
    profile: { persona_name: str(pr.persona_name || "The Feed Drifter", 60), persona_line: str(pr.persona_line, 200), algorithm_thinks: str(pr.algorithm_thinks, 200) },
    quiz,
  });
});

app.listen(PORT, () => console.log(`Feed Sponge on http://localhost:${PORT}  (mode: ${MODE}${MOCK ? "" : ", model: " + MODEL})`));
