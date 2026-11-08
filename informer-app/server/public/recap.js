// POST /api/public/recap — the posts read so far → scroller persona + a quiz: recall questions about what was on
// screen, plus fun-fact questions (checked with Google Search) about the topics they kept watching.
import { askRecap, cleanRecap, statusOf, retryAfterOf, clip } from "../_lib/feed.js";

export const config = { timeout: 60000 };

export async function POST(bag) {
  const list = Array.isArray(bag.request.body?.posts) ? bag.request.body.posts.slice(0, 80) : [];
  if (!list.length) return { status: 400, body: { error: "No posts to recap." } };
  const posts = list.map((p) => ({
    title: clip(p.title, 120), topic: clip(p.topic, 30), kind: clip(p.kind, 10), takeaway: clip(p.takeaway, 300),
    details: (Array.isArray(p.details) ? p.details : []).slice(0, 5).map((d) => clip(d, 200)),
  }));
  try {
    const { data, search, engine } = await askRecap(bag, posts);
    bag.log?.info?.(`[recap] ${posts.length} posts → ${data?.quiz?.length || 0} questions via ${engine}`);
    return cleanRecap(data, posts.length, search);
  } catch (e) {
    const st = statusOf(e);
    return { status: st === 429 ? 429 : 502, body: { error: "AI couldn't write the recap. " + clip(e?.message, 160), code: st || "error", retryAfter: retryAfterOf(e) } };
  }
}
