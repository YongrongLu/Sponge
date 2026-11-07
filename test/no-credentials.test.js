import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('missing credentials return a configuration error instead of invented posts', async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'feed-sponge-test-'));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, '');
  const env = { ...process.env, PORT: String(port), DOTENV_CONFIG_PATH: envFile,
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '', GOOGLE_GENAI_USE_VERTEXAI: '', MOCK: '' };
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/health`); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.equal(ready, true, 'test server started');
    const response = await fetch(`http://127.0.0.1:${port}/api/chunk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: ['AA=='], times: [0] }),
    });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.code, 'CONFIG');
    assert.equal(data.posts, undefined);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
