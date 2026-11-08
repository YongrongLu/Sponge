// POST /api/public/sessions — save one finished scroll (from a phone or the big screen) and award badges.
// Body: { nickname, client_key, seconds, posts: [{ kind, topic, app }], answers: [{ source_type, topic, correct }], persona, source }
// Only counts and labels are stored: no frames, titles, takeaways or question text.
// client_key is a random id the phone keeps, so the same person's streaks and jar total add up across scrolls.
import { KINDS, APPS, TOPICS, BADGES, healthScore, clip, cleanAnswers, saveQuiz } from "../../_lib/feed.js";

const int = (v, max) => Math.max(0, Math.min(max, parseInt(v, 10) || 0));

export async function POST({ request, transaction }) {
  const b = request.body || {};
  const posts = (Array.isArray(b.posts) ? b.posts : []).slice(0, 200);
  if (!posts.length) return { status: 400, body: { error: "No posts in this session." } };
  const c = { info: 0, fun: 0, bait: 0, rage: 0 };
  const apps = {}, topics = {};
  for (const p of posts) {
    const k = KINDS.includes(p.kind) ? p.kind : "fun";
    c[k]++;
    const a = APPS.includes(p.app) ? p.app : "Other";
    apps[a] = apps[a] || { posts: 0, junk: 0 };
    apps[a].posts++;
    if (k === "bait" || k === "rage") apps[a].junk++;
    const t = TOPICS.includes(p.topic) ? p.topic : "Other";
    topics[t] = topics[t] || { posts: 0, info: 0 };
    topics[t].posts++;
    if (k === "info") topics[t].info++;
  }
  const health = healthScore(c);
  const answers = cleanAnswers(b.answers);
  const nick = clip(String(b.nickname || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim(), 20) || "Anonymous sponge";
  const key = /^[a-z0-9]{16,40}$/.test(String(b.client_key || "")) ? b.client_key : null;
  const handle = nick.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) + "-" + Math.random().toString(36).slice(2, 6);
  const source = b.source === "stage" ? "stage" : "phone";

  return await transaction(async ({ query }) => {
    let user = key ? (await query("UPDATE fs_users SET display_name = $2 WHERE client_key = $1 AND NOT is_virtual RETURNING id", [key, nick]))[0] : null;
    if (!user) [user] = await query("INSERT INTO fs_users (handle, display_name, is_virtual, client_key) VALUES ($1, $2, false, $3) RETURNING id", [handle, nick, key]);
    const [s] = await query(
      `INSERT INTO fs_sessions (user_id, seconds, posts, info, fun, bait, rage, health, quiz_right, quiz_total, persona, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [user.id, int(b.seconds, 3600), posts.length, c.info, c.fun, c.bait, c.rage, health,
       answers.filter((a) => a.correct).length, answers.length, clip(b.persona, 60) || null, source]
    );
    for (const [app, v] of Object.entries(apps))
      await query("INSERT INTO fs_session_apps (session_id, app, posts, junk) VALUES ($1,$2,$3,$4)", [s.id, app, v.posts, v.junk]);
    for (const [topic, v] of Object.entries(topics))
      await query("INSERT INTO fs_session_topics (session_id, topic, posts, info) VALUES ($1,$2,$3,$4)", [s.id, topic, v.posts, v.info]);
    const earned = ["first_squeeze"];
    if (c.info >= 3) earned.push("fact_finder");
    if (c.rage === 0 && posts.length >= 8) earned.push("rage_resistant");
    if (health >= 70) earned.push("brain_food");
    if (health < 15) earned.push("doom_survivor");
    for (const id of earned) await query("INSERT INTO fs_badges (user_id, badge) VALUES ($1,$2) ON CONFLICT DO NOTHING", [user.id, id]);
    const quiz = answers.length ? await saveQuiz(query, s.id, user.id, answers) : null;
    if (quiz) earned.push(...quiz.badges);
    const [r] = await query(
      `SELECT 1 + COUNT(*)::int AS rank FROM (
         SELECT AVG(health) AS h FROM fs_sessions WHERE created_at > now() - interval '7 days' GROUP BY user_id
       ) t WHERE t.h > $1`, [health]);
    const [j] = await query("SELECT COUNT(*) FILTER (WHERE correct)::int AS n FROM fs_quiz_answers WHERE user_id = $1", [user.id]);
    return { id: s.id, user_id: user.id, health, rank: r.rank, badges: earned.map((id) => ({ id, ...BADGES[id] })), jar: { right: j.n, goal: 10 } };
  });
}
