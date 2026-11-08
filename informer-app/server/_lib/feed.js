// Shared logic for Feed Sponge routes: prompts, JSON schemas, output cleaning, and the AI engine.
//
// AI engine (env AI_ENGINE): "auto" (default) | "informer" | "gemini"
//   auto     → use Informer's managed AI (models/<slug>/_object) when it has passed a vision check,
//              otherwise Gemini through the app-owned `gemini` integration.
//   informer → Informer AI only.   gemini → Gemini only.
// The vision check sends a small image that reads "SPONGE47" and asks the model to read it back.
// The result is cached in fs_settings for 6 hours, so a model that silently ignores images is never
// trusted to describe a feed (it would invent posts).
import { PROBE_CODE, PROBE_JPEG } from "./probe.js";

export const TOPICS = [
  "Money", "Career", "Tech", "Science", "Health", "Fitness", "Language", "History", "News", "Cooking",
  "Food", "Travel", "Fashion", "Beauty", "Music", "Dance", "Sports", "Gaming", "Pets", "Memes",
  "Relationships", "Messages", "Shopping", "Clickbait", "Outrage", "Other",
];
export const KINDS = ["info", "fun", "bait", "rage"];
export const APPS = ["TikTok", "Instagram", "YouTube", "X", "Reddit", "Xiaohongshu", "Snapchat", "Facebook", "LinkedIn", "Slack", "Messages", "Browser", "Other"];
export const LEARN_TOPICS = ["Money", "Career", "Tech", "Science", "Health", "Fitness", "Language", "History", "News", "Cooking"];

export const BADGES = {
  first_squeeze: { img: "assets/badges/first_squeeze.webp", emoji: "🧽", label: "First Squeeze", rule: "Squeezed a feed for the first time" },
  fact_finder: { img: "assets/badges/fact_finder.webp", emoji: "🔎", label: "Fact Finder", rule: "3+ useful posts in one scroll" },
  squeezed_dry: { img: "assets/badges/squeezed_dry.webp", emoji: "💧", label: "Squeezed Dry", rule: "Every quiz question right (3+)" },
  full_jar: { img: "assets/badges/full_jar.webp", emoji: "🍯", label: "1st Full Jar", rule: "10 quiz answers right in total" },
  curious_sponge: { img: "assets/badges/curious_sponge.webp", emoji: "🧠", label: "Curious Sponge", rule: "Right answers in 5 different topics" },
  streak_sponge: { img: "assets/badges/streak_sponge.webp", emoji: "🔥", label: "Streak Sponge", rule: "Finished a quiz 3 days in a row" },
  rage_resistant: { img: "assets/badges/rage_resistant.webp", emoji: "🧘", label: "Rage Resistant", rule: "8+ posts and zero rage bait" },
  brain_food: { img: "assets/badges/brain_food.webp", emoji: "🥦", label: "Brain Food", rule: "Feed health 70+" },
  doom_survivor: { img: "assets/badges/doom_survivor.webp", emoji: "🫠", label: "Doom Survivor", rule: "Feed health under 15" },
};
export const JAR_GOAL = 10;

// Quiz answers from the page: [{ source_type, topic, correct }] → cleaned, at most 10.
export function cleanAnswers(list) {
  return (Array.isArray(list) ? list : []).slice(0, 10).map((a) => ({
    source_type: a?.source_type === "interest" ? "interest" : "recall",
    topic: str(String(a?.topic || "other").toLowerCase().replace(/[^\p{L}\p{N} &'-]/gu, "").trim(), 40) || "other",
    correct: !!a?.correct,
  }));
}

// Store a session's quiz answers once, then award the quiz badges. Returns { badges: [ids that apply now], jar }.
export async function saveQuiz(query, sessionId, userId, answers) {
  const have = await query("SELECT COUNT(*)::int AS n FROM fs_quiz_answers WHERE session_id = $1", [sessionId]);
  if (!have[0].n) for (const a of answers)
    await query("INSERT INTO fs_quiz_answers (session_id, user_id, source_type, topic, correct) VALUES ($1,$2,$3,$4,$5)", [sessionId, userId, a.source_type, a.topic, a.correct]);
  const [t] = await query(`
    SELECT COUNT(*) FILTER (WHERE correct)::int AS right_total,
           COUNT(DISTINCT topic) FILTER (WHERE correct)::int AS topics_right
    FROM fs_quiz_answers WHERE user_id = $1`, [userId]);
  const [st] = await query(`
    WITH days AS (SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM fs_quiz_answers WHERE user_id = $1)
    SELECT COUNT(*)::int AS streak FROM (
      SELECT d, (CURRENT_DATE - d) - (ROW_NUMBER() OVER (ORDER BY d DESC) - 1) AS grp FROM days
    ) x WHERE grp = 0`, [userId]);
  const right = answers.filter((a) => a.correct).length;
  const ids = [];
  if (answers.length >= 3 && right === answers.length) ids.push("squeezed_dry");
  if (t.right_total >= JAR_GOAL) ids.push("full_jar");
  if (t.topics_right >= 5) ids.push("curious_sponge");
  if (st.streak >= 3) ids.push("streak_sponge");
  for (const id of ids) await query("INSERT INTO fs_badges (user_id, badge) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, id]);
  return { badges: ids, jar: { right: t.right_total, goal: JAR_GOAL }, topics_right: t.topics_right, streak: st.streak };
}

// Feed health 0-100: useful posts count fully, entertainment partly, bait barely, rage not at all.
export function healthScore(c) {
  const n = c.info + c.fun + c.bait + c.rage;
  if (!n) return 0;
  return Math.max(0, Math.min(100, Math.round((100 * (c.info + 0.45 * c.fun + 0.1 * c.bait)) / n)));
}

const str = (v, n) => String(v ?? "").slice(0, n);
export const clip = str;

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
export const CHUNK_SCHEMA = { type: "object", properties: { posts: { type: "array", items: POST } }, required: ["posts"] };
export const RECAP_SCHEMA = {
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
export const chunkPrompt = (n, hasCtx, prevTitle) => `You are watching a phone screen recording of someone scrolling, a few seconds at a time. Below are the next ${n} frames, one per second, labelled Frame 0 to Frame ${n - 1}.${
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

export const recapPrompt = (posts, ground = false) => `Here are the posts someone scrolled past, in order, as JSON:
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

/* ---------- cleaning ---------- */
export function cleanPosts(list, n) {
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      const s = Math.max(0, Math.min(n - 1, parseInt(p.start_frame, 10) || 0));
      const e = Math.max(s, Math.min(n - 1, parseInt(p.end_frame, 10) || s));
      const kind = KINDS.includes(p.kind) ? p.kind : "fun";
      return {
        start_frame: s,
        end_frame: e,
        continues_previous: p.continues_previous === true || p.continues_previous === "true",
        title: str(p.title || "Untitled post", 120),
        app: APPS.includes(p.app) ? p.app : "Other",
        topic: TOPICS.includes(p.topic) ? p.topic : "Other",
        kind,
        takeaway: kind === "info" ? str(p.takeaway, 300) : "",
        details: (Array.isArray(p.details) ? p.details : typeof p.details === "string" && p.details ? [p.details] : [])
          .slice(0, 3).map((d) => str(d, 200)).filter(Boolean),
      };
    })
    .sort((a, b) => a.start_frame - b.start_frame);
}

export function cleanRecap(data, nPosts, search = null) {
  const pr = data?.profile || {};
  const quiz = (Array.isArray(data?.quiz) ? data.quiz : [])
    .filter((q) => Array.isArray(q.options) && q.options.length >= 2)
    .map((q) => ({ ...q, answer_index: parseInt(q.answer_index, 10) }))
    .filter((q) => q.answer_index >= 0 && q.answer_index < Math.min(4, q.options.length))
    .slice(0, 5)
    .map((q) => ({
      source_type: q.source_type === "interest" ? "interest" : "recall",
      topic: str(q.topic, 40),
      fact: str(q.fact, 300),
      question: str(q.question, 300),
      options: q.options.slice(0, 4).map((o) => str(o, 160)),
      answer_index: q.answer_index,
      explanation: str(q.explanation, 300),
      post_index: Math.max(0, Math.min(nPosts - 1, parseInt(q.post_index, 10) || 0)),
    }));
  return {
    profile: { persona_name: str(pr.persona_name || "The Feed Drifter", 60), persona_line: str(pr.persona_line, 200), algorithm_thinks: str(pr.algorithm_thinks, 200) },
    quiz,
    search, // Google Search suggestions (must be shown when grounding was used)
  };
}

/* ---------- AI engine ---------- */
export const statusOf = (e) => e?.output?.statusCode ?? e?.status ?? e?.response?.status ?? null;
export function retryAfterOf(e) {
  const m = String(e?.message || "").match(/retry(?:Delay|\s+in)?\D{0,6}(\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.min(60, Math.ceil(+m[1])) : null;
}
function parseJSON(text) {
  if (text && typeof text === "object") return text;
  const t = String(text || "");
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw Object.assign(new Error("Model returned no JSON"), { status: 502 });
  return JSON.parse(m[0]);
}

// images: [{ label, data /* base64 JPEG, no data: prefix */ }]
async function viaInformer(fetch, env, prompt, images, schema) {
  const model = env.INFORMER_MODEL || "go_everyday";
  const parts = [{ type: "text", text: prompt }];
  for (const im of images) {
    if (im.label) parts.push({ type: "text", text: im.label });
    parts.push({ type: "file", mediaType: "image/jpeg", url: `data:image/jpeg;base64,${im.data}` });
  }
  const res = await fetch(`models/${model}/_object`, { method: "POST", body: { messages: [{ role: "user", parts }], schema, outputSize: "large" } });
  if (res.status !== 200) throw Object.assign(new Error(`Informer AI _object failed (${res.status}) ${str(JSON.stringify(res.body), 200)}`), { status: res.status });
  return parseJSON(res.body);
}

// ground: add Grounding with Google Search (fun-fact questions). Returns { data, search } where search is the
// Search Suggestions HTML Google asks apps to show next to grounded answers.
async function viaGemini(context, env, prompt, images, schema, ground = false) {
  if (!context?.gemini) throw Object.assign(new Error("Gemini integration is not set up"), { status: 503 });
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  const parts = [{ text: prompt }];
  for (const im of images) {
    if (im.label) parts.push({ text: im.label });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: im.data } });
  }
  const body = await context.gemini.request({
    method: "POST",
    url: `v1beta/models/${model}:generateContent`,
    data: { contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2 }, ...(ground ? { tools: [{ google_search: {} }] } : {}) },
  });
  const text = (body?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw Object.assign(new Error(`Gemini returned no text (${str(body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason, 40)})`), { status: 502 });
  const data = parseJSON(text);
  if (!data || typeof data !== "object" || !(schema.required || []).every((k) => k in data)) throw Object.assign(new Error("Gemini returned incomplete JSON"), { status: 502, badJson: true });
  return ground ? { data, search: body?.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent || null } : data;
}

async function informerCanSee(bag) {
  const { query, fetch, env, log } = bag;
  try {
    const rows = await query("SELECT value, updated_at FROM fs_settings WHERE key = 'informer_vision'");
    if (rows[0] && Date.now() - new Date(rows[0].updated_at).getTime() < 6 * 3600e3) return rows[0].value === "yes";
  } catch {}
  let ok = false;
  try {
    const out = await viaInformer(fetch, env, "Read the code written in the image. Reply with JSON {\"code\": \"<the code>\"}.", [{ data: PROBE_JPEG }],
      { type: "object", properties: { code: { type: "string" } }, required: ["code"] });
    ok = String(out?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === PROBE_CODE;
  } catch (e) {
    log?.warn?.("Informer AI vision check failed", { status: statusOf(e), message: str(e?.message, 200) });
  }
  try {
    await query(
      "INSERT INTO fs_settings (key, value, updated_at) VALUES ('informer_vision', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [ok ? "yes" : "no"]
    );
  } catch {}
  log?.info?.(`Informer AI vision check: ${ok ? "passed" : "failed, using Gemini"}`);
  return ok;
}

// Returns { data, engine }. Throws with .status on failure (429 is passed through so the page can slow down).
export async function askAI(bag, { prompt, images = [], schema, vision = true }) {
  const { fetch, context, env = {}, log } = bag;
  const mode = String(env.AI_ENGINE || "auto").toLowerCase();
  if (mode === "gemini") return { data: await viaGemini(context, env, prompt, images, schema), engine: "gemini" };
  if (mode === "informer") return { data: await viaInformer(fetch, env, prompt, images, schema), engine: "informer" };
  // auto
  const useInformer = !vision || !images.length ? true : await informerCanSee(bag);
  if (useInformer) {
    try { return { data: await viaInformer(fetch, env, prompt, images, schema), engine: "informer" }; }
    catch (e) {
      if (!context?.gemini) throw e;
      log?.warn?.("Informer AI failed, falling back to Gemini", { status: statusOf(e), message: str(e?.message, 200) });
    }
  }
  return { data: await viaGemini(context, env, prompt, images, schema), engine: "gemini" };
}

// Recap + quiz. Fun-fact questions are checked with Google Search when the Gemini integration is set up
// (GROUNDING=off to disable, AI_ENGINE=informer to keep everything on Informer AI). Falls back to askAI.
export async function askRecap(bag, posts) {
  const { context, env = {}, log } = bag;
  const mode = String(env.AI_ENGINE || "auto").toLowerCase();
  if (context?.gemini && mode !== "informer" && String(env.GROUNDING || "on").toLowerCase() !== "off") {
    try {
      const { data, search } = await viaGemini(context, env, recapPrompt(posts, true), [], RECAP_SCHEMA, true);
      return { data, search, engine: "gemini+search" };
    } catch (e) {
      if (statusOf(e) === 429) throw e;
      log?.warn?.("Grounded recap failed, retrying without search", { status: statusOf(e), message: str(e?.message, 200) });
    }
  }
  const { data, engine } = await askAI(bag, { prompt: recapPrompt(posts, false), schema: RECAP_SCHEMA, vision: false });
  return { data, search: null, engine };
}

export const isB64 = (f) => typeof f === "string" && f.length < 2_000_000 && /^[A-Za-z0-9+/=]+$/.test(f);
