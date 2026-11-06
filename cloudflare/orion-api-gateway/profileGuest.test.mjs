import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const makeEnv = () => ({
  ORIGIN_URL: 'https://legacy.example',
  GENERAL_LIMITER: { limit: async () => ({ success: true }) },
  AUTH_LIMITER: { limit: async () => ({ success: true }) },
  EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) }
});

test('anonymous profile probes return old 401 JSON without Cloud Run', async () => {
  const originalFetch = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async () => { upstream++; return Response.json({name: 'unexpected'}); };
  try {
    const url = 'https://api.samyao.me/api/users/profile';
    for (const headers of [{}, {cookie: 'GAESA=unrelated'}, {origin: 'https://samyao.me'}]) {
      const r = await gateway.fetch(new Request(url, {headers}), makeEnv());
      assert.equal(r.status, 401);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-bananaboom-origin'), 'worker');
      assert.deepEqual(await r.json(), {
        success: false,
        message: 'Unauthorized: Please login first',
        message_cn: '请先登录'
      });
      if (headers.origin) {
        assert.equal(r.headers.get('access-control-allow-origin'), headers.origin);
        assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
      }
    }
    assert.equal(upstream, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('authenticated profile requests remain on legacy auth', async () => {
  const originalFetch = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async () => { upstream++; return Response.json({backend:'cloudrun'}); };
  try {
    for (const headers of [
      { authorization:'Bearer fake' },
      { 'x-auth-token':'fake' },
      { cookie:'other=1; orion_session=fake' },
      { 'x-google-auth':'fake' }
    ]) {
      const r = await gateway.fetch(new Request('https://api.samyao.me/api/users/profile',{headers}), makeEnv());
      assert.equal(r.status,200);
      assert.equal((await r.json()).backend,'cloudrun');
    }
    assert.equal(upstream,4);
  } finally { globalThis.fetch = originalFetch; }
});
