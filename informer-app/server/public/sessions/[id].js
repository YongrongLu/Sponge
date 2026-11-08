// PATCH /api/public/sessions/:id — add the quiz answers once the person finishes the quiz, then award quiz badges.
// Body: { answers: [{ source_type, topic, correct }] }  (older pages may send only { quiz_right, quiz_total })
import { BADGES, cleanAnswers, saveQuiz } from "../../_lib/feed.js";

export async function PATCH({ request, transaction }) {
  const id = parseInt(request.params.id, 10);
  const answers = cleanAnswers(request.body?.answers);
  const right = answers.length ? answers.filter((a) => a.correct).length : Math.max(0, Math.min(10, parseInt(request.body?.quiz_right, 10) || 0));
  const total = answers.length || Math.max(right, Math.min(10, parseInt(request.body?.quiz_total, 10) || 0));
  return await transaction(async ({ query }) => {
    // Only sessions saved in the last hour can be updated, so old rows can't be rewritten by anyone with an id.
    const rows = await query(
      "UPDATE fs_sessions SET quiz_right = $2, quiz_total = $3 WHERE id = $1 AND created_at > now() - interval '1 hour' RETURNING user_id",
      [id, right, total]);
    if (!rows.length) return { status: 404, body: { error: "Session not found or too old to update." } };
    if (!answers.length) return { ok: true, badges: [] };
    const q = await saveQuiz(query, id, rows[0].user_id, answers);
    return { ok: true, badges: q.badges.map((b) => ({ id: b, ...BADGES[b] })), jar: q.jar };
  });
}
