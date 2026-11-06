import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

test('browser can read Worker origin header on authenticated profile canary', async () => {
  const previousFetch = globalThis.fetch;
  let calledOrigin = 0;
  globalThis.fetch = async () => {
    calledOrigin++;
    return Response.json({ source: 'legacy' });
  };
  const env = {
    ORIGIN_URL: 'https://legacy.invalid',
    PROFILE_READ_CUTOVER: '0',
    GENERAL_LIMITER: { limit: async () => ({success:true}) },
    AUTH_LIMITER: { limit: async () => ({success:true}) },
    BANANABOOM_CORE: { fetch: async () => Response.json({source:'worker'}) }
  };
  try {
    const response = await gateway.fetch(
      new Request('https://api.samyao.me/api/users/profile', {
        headers: {
          origin: 'https://samyao.me',
          cookie: 'orion_session=fake-token',
          'x-orion-profile-canary': '1'
        }
      }),
      env
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-bananaboom-origin'), 'worker');
    assert.equal(response.headers.get('access-control-expose-headers'), 'x-bananaboom-origin');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://samyao.me');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.equal((await response.json()).source, 'worker');
    assert.equal(calledOrigin, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
