import test from 'node:test';
import assert from 'node:assert/strict';
import uploadHandler from '../api/eta-upload.js';

function response() {
  const result = { headers: {} };
  return {
    result,
    api: {
      setHeader(key, value) { result.headers[key] = value; },
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    },
  };
}

test('manual ETA import is same-origin only and requires configured shared storage', async () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let target = response();
    await uploadHandler({ method: 'POST', headers: { host: 'hyopu.example', origin: 'https://other.example', 'content-type': 'application/json' } }, target.api);
    assert.equal(target.result.status, 403);

    target = response();
    await uploadHandler({ method: 'POST', headers: { host: 'hyopu.example', origin: 'https://hyopu.example', 'content-type': 'application/json' } }, target.api);
    assert.equal(target.result.status, 503);
    assert.equal(target.result.headers['Cache-Control'], 'no-store');
  } finally {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  }
});
