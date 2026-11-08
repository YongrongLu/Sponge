// GET /api/public/health — tells the page which AI engine is configured.
export async function GET({ env = {} }) {
  const mode = String(env.AI_ENGINE || "auto").toLowerCase();
  const model = mode === "gemini" ? `Gemini · ${env.GEMINI_MODEL || "gemini-3.5-flash"}` : mode === "informer" ? "Informer AI" : "Informer AI + Gemini";
  return { mode: "informer", model };
}
