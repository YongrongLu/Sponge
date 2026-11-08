// POST /api/public/chunk — a few frames of a screen recording (sent while it plays) → the posts found in them.
// Body: { frames: [base64 JPEG], times: [seconds], context: { frame: base64 JPEG, title } | null }
import { askAI, chunkPrompt, CHUNK_SCHEMA, cleanPosts, isB64, statusOf, retryAfterOf, clip } from "../_lib/feed.js";

export const config = { timeout: 60000 };

export async function POST(bag) {
  const { request, log } = bag;
  const { frames, times, context: ctx } = request.body || {};
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 12 || !frames.every(isB64))
    return { status: 400, body: { error: "Send 1-12 base64 JPEG frames." } };
  const n = frames.length;
  const hasCtx = !!(ctx && isB64(ctx.frame));
  const images = [];
  if (hasCtx) images.push({ label: "CONTEXT", data: ctx.frame });
  frames.forEach((data, i) => {
    const t = Array.isArray(times) && Number.isFinite(times[i]) ? ` (t=${times[i]}s)` : "";
    images.push({ label: `Frame ${i}${t}`, data });
  });
  const t0 = Date.now();
  try {
    const { data, engine } = await askAI(bag, { prompt: chunkPrompt(n, hasCtx, clip(ctx?.title, 120)), images, schema: CHUNK_SCHEMA });
    const posts = cleanPosts(data?.posts, n);
    log?.info?.(`[chunk] ${n} frames → ${posts.length} posts via ${engine} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { posts, engine };
  } catch (e) {
    const st = statusOf(e);
    log?.warn?.("[chunk] failed", { status: st, message: clip(e?.message, 300) });
    return {
      status: st === 429 ? 429 : 502,
      body: { error: (st === 429 ? "AI is rate-limited (429). " : "AI couldn't read these frames. ") + clip(e?.message, 160), code: st || "error", retryAfter: retryAfterOf(e) },
    };
  }
}
