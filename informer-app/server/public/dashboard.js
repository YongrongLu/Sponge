// GET /api/public/dashboard — everything the Dashboard tab draws, from the app's own Postgres tables.
// Virtual users are seeded by migrations/002; real people join as they squeeze their feeds.
import { BADGES } from "../_lib/feed.js";

export async function GET({ query }) {
  const [kpi] = await query(`
    SELECT
      COALESCE(ROUND(AVG(health) FILTER (WHERE created_at > now() - interval '1 day')), 0)::int AS health_today,
      COALESCE(ROUND(AVG(health) FILTER (WHERE created_at BETWEEN now() - interval '30 days' AND now() - interval '23 days')), 0)::int AS health_month_ago,
      COALESCE(SUM(posts) FILTER (WHERE created_at > now() - interval '7 days'), 0)::int AS posts_7d,
      COALESCE(ROUND(100.0 * SUM(quiz_right) FILTER (WHERE created_at > now() - interval '7 days')
        / NULLIF(SUM(quiz_total) FILTER (WHERE created_at > now() - interval '7 days'), 0)), 0)::int AS quiz_7d,
      COUNT(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days')::int AS active_7d
    FROM fs_sessions`);
  const [k2] = await query("SELECT COUNT(*) FILTER (WHERE correct)::int AS drops_7d FROM fs_quiz_answers WHERE created_at > now() - interval '7 days'");
  kpi.drops_7d = k2.drops_7d;
  const daily = await query(`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
           COALESCE(ROUND(AVG(s.health)), NULL)::int AS health,
           COALESCE(ROUND(100.0 * SUM(s.info) / NULLIF(SUM(s.posts), 0)), NULL)::int AS info_pct,
           COUNT(s.id)::int AS sessions
    FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d
    LEFT JOIN fs_sessions s ON date_trunc('day', s.created_at) = d
    GROUP BY d ORDER BY d`);
  const apps = await query(`
    SELECT a.app, SUM(a.posts)::int AS posts, SUM(a.junk)::int AS junk,
           ROUND(100.0 * SUM(a.junk) / NULLIF(SUM(a.posts), 0))::int AS junk_pct
    FROM fs_session_apps a JOIN fs_sessions s ON s.id = a.session_id
    WHERE s.created_at > now() - interval '30 days' AND a.app <> 'Other'
    GROUP BY a.app HAVING SUM(a.posts) >= 5 ORDER BY junk_pct DESC LIMIT 8`);
  const quiz = await query(`
    SELECT to_char(w, 'Mon DD') AS week,
           COALESCE(ROUND(100.0 * SUM(s.quiz_right) / NULLIF(SUM(s.quiz_total), 0)), NULL)::int AS accuracy
    FROM generate_series(date_trunc('week', now()) - interval '4 weeks', date_trunc('week', now()), interval '1 week') w
    LEFT JOIN fs_sessions s ON date_trunc('week', s.created_at) = w
    GROUP BY w ORDER BY w`);
  // What everyone scrolls (30 days): posts per topic and how much of it taught something
  const topics = await query(`
    SELECT t.topic, SUM(t.posts)::int AS posts, ROUND(100.0 * SUM(t.info) / NULLIF(SUM(t.posts), 0))::int AS info_pct
    FROM fs_session_topics t JOIN fs_sessions s ON s.id = t.session_id
    WHERE s.created_at > now() - interval '30 days' AND t.topic NOT IN ('Other')
    GROUP BY t.topic ORDER BY posts DESC LIMIT 10`);
  // Knowledge absorbed, week by week: % right on recall questions vs fun-fact questions
  const absorb = await query(`
    SELECT to_char(w, 'Mon DD') AS week,
           ROUND(100.0 * COUNT(*) FILTER (WHERE a.correct AND a.source_type = 'recall') / NULLIF(COUNT(*) FILTER (WHERE a.source_type = 'recall'), 0))::int AS recall,
           ROUND(100.0 * COUNT(*) FILTER (WHERE a.correct AND a.source_type = 'interest') / NULLIF(COUNT(*) FILTER (WHERE a.source_type = 'interest'), 0))::int AS interest,
           COUNT(*) FILTER (WHERE a.correct)::int AS drops
    FROM generate_series(date_trunc('week', now()) - interval '4 weeks', date_trunc('week', now()), interval '1 week') w
    LEFT JOIN fs_quiz_answers a ON date_trunc('week', a.created_at) = w
    GROUP BY w ORDER BY w`);
  // Fun-fact topics people learned the most about (30 days)
  const curious = await query(`
    SELECT topic, COUNT(*) FILTER (WHERE correct)::int AS learned
    FROM fs_quiz_answers WHERE source_type = 'interest' AND created_at > now() - interval '30 days'
    GROUP BY topic ORDER BY learned DESC LIMIT 6`);
  const leaderboard = await query(`
    WITH recent AS (
      SELECT user_id, ROUND(AVG(health))::int AS health, COUNT(*)::int AS sessions, MAX(created_at) AS last_at
      FROM fs_sessions WHERE created_at > now() - interval '7 days' GROUP BY user_id
    ), days AS (
      SELECT DISTINCT user_id, (created_at AT TIME ZONE 'UTC')::date AS d FROM fs_sessions WHERE created_at > now() - interval '40 days'
    ), streaks AS (
      SELECT user_id, COUNT(*)::int AS streak FROM (
        SELECT user_id, d, (CURRENT_DATE - d) - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY d DESC) - 1) AS grp FROM days
      ) t WHERE grp = 0 GROUP BY user_id
    )
    SELECT u.id, u.display_name AS name, u.is_virtual, r.health, r.sessions, r.last_at,
           COALESCE(st.streak, 0) AS streak,
           COALESCE((SELECT array_agg(b.badge ORDER BY b.earned_at) FROM fs_badges b WHERE b.user_id = u.id), '{}') AS badges
    FROM recent r JOIN fs_users u ON u.id = r.user_id LEFT JOIN streaks st ON st.user_id = u.id
    ORDER BY r.health DESC, r.last_at DESC LIMIT 12`);
  const badgeRows = await query(`
    SELECT b.badge, COUNT(*)::int AS holders,
           (array_agg(u.display_name ORDER BY b.earned_at DESC))[1:3] AS recent
    FROM fs_badges b JOIN fs_users u ON u.id = b.user_id GROUP BY b.badge`);
  const live = await query(`
    SELECT u.display_name AS name, s.health, s.posts, s.created_at
    FROM fs_sessions s JOIN fs_users u ON u.id = s.user_id
    WHERE NOT u.is_virtual ORDER BY s.created_at DESC LIMIT 6`);
  const byBadge = Object.fromEntries(badgeRows.map((r) => [r.badge, r]));
  return {
    kpi, daily, apps, quiz, topics, absorb, curious, leaderboard, live,
    badges: Object.entries(BADGES).map(([id, b]) => ({ id, ...b, holders: byBadge[id]?.holders || 0, recent: byBadge[id]?.recent || [] })),
  };
}
