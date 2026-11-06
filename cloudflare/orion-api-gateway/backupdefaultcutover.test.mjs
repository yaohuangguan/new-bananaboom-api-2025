import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

test('production default backup cutover uses Worker without canary or Cloud Run replay', async () => {
  const previousFetch = globalThis.fetch;
  let upstream = 0, core = 0;
  globalThis.fetch = async () => {
    upstream++;
    return Response.json({ unsafe: 'unexpected legacy origin call' });
  };
  const env = {
    ORIGIN_URL: 'https://legacy.invalid',
    BACKUP_R2_CUTOVER: '1',
    GENERAL_LIMITER: { limit: async () => ({ success: true }) },
    EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    BANANABOOM_CORE: {
      fetch: async (req) => {
        core++;
        assert.equal(req.method, 'POST');
        assert.equal(req.headers.get('origin'), 'https://samyao.me');
        assert.equal(req.headers.get('cookie'), 'orion_session=valid-jwt-carrier');
        assert.equal(req.headers.get('x-orion-backup-canary'), null);
        assert.equal(req.headers.get('x-orion-edge-secret'), null);
        return new Response('[LOG] private R2\n[DONE] {"success":true}\n', {
          status: 200, headers: {'content-type':'text/plain'}
        });
      }
    }
  };
  try {
    const result = await gateway.fetch(new Request(
      'https://api.samyao.me/api/backup/database', {
        method: 'POST',
        headers: {
          origin: 'https://samyao.me',
          cookie: 'orion_session=valid-jwt-carrier'
        }
      }
    ), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-bananaboom-origin'), 'worker');
    assert.equal(result.headers.get('access-control-allow-origin'), 'https://samyao.me');
    assert.equal(result.headers.get('access-control-allow-credentials'), 'true');
    assert.ok((await result.text()).includes('[DONE]'));
    assert.equal(core, 1);
    assert.equal(upstream, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
