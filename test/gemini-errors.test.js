import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGeminiError } from '../gemini-errors.js';

test('daily Gemini quota is reported as a daily limit with the full retry delay', () => {
  const error = { status: 429, message: JSON.stringify({ error: {
    code: 429,
    message: 'Generate content requests per day limit exceeded on Free Tier. Please retry in 12h30m0s.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45000s' },
    ],
  } }) };
  assert.deepEqual(describeGeminiError(error), {
    status: 429, code: 429, quotaType: 'daily', retryAfter: 45000,
    message: 'Generate content requests per day limit exceeded on Free Tier. Please retry in 12h30m0s.',
  });
});

test('permission errors keep their actual HTTP status', () => {
  const error = { status: 403, message: JSON.stringify({ error: { code: 403, message: 'Permission denied.' } }) };
  assert.deepEqual(describeGeminiError(error), {
    status: 403, code: 403, quotaType: null, retryAfter: null, message: 'Permission denied.',
  });
});
