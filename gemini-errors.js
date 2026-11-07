export function describeGeminiError(error) {
  let payload;
  try { payload = JSON.parse(String(error?.message || '')); } catch { payload = null; }
  const detail = payload?.error || {};
  const code = Number(error?.status || detail.code) || 'network';
  const status = [400, 401, 403, 429].includes(code) ? code : 502;
  const message = detail.message || String(error?.message || 'Gemini request failed');
  const quota = (detail.details || []).find((item) => item['@type']?.endsWith('.QuotaFailure'));
  const daily = code === 429 && (
    quota?.violations?.some((item) => /PerDay|per.day/i.test(`${item.quotaId} ${item.description}`)) ||
    /requests per day limit exceeded/i.test(message)
  );
  const retry = (detail.details || []).find((item) => item['@type']?.endsWith('.RetryInfo'));
  const retryAfter = retry?.retryDelay && /^\d+s$/.test(retry.retryDelay)
    ? Number.parseInt(retry.retryDelay, 10) : null;
  return { status, code, quotaType: daily ? 'daily' : code === 429 ? 'rate' : null, retryAfter, message };
}
