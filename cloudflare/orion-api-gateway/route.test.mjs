import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRouteToCoreWorker, isWorkerLikeMutation, isRetiredSecretEndpoint } from './src/index.js';

test('only explicit public read routes use the Worker', () => {
  for (const path of ['/api/homepage', '/api/homepage/likes', '/api/homepage/projects', '/api/homepage/logs', '/api/projects', '/api/menu', '/api/posts', '/api/tags']) {
    assert.equal(shouldRouteToCoreWorker('GET', path), true);
    assert.equal(shouldRouteToCoreWorker('HEAD', path), false);
    assert.equal(shouldRouteToCoreWorker('POST', path), false);
    assert.equal(shouldRouteToCoreWorker('DELETE', path), false);
  }

  for (const path of ['/api/homepage/likes/id/add', '/api/posts/private/posts', '/api/posts/likes/123', '/api/projects/123', '/api/auth', '/api/users', '/api/homepage/private']) {
    assert.equal(shouldRouteToCoreWorker('GET', path), false);
  }
});

test('authenticated or invalid list requests remain on original Cloud Run', () => {
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=private'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=all'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=public&type=private'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/tags', '?type=public'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts', '?page=2&limit=3&q=React'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts', '?page=-1'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts', '?limit=500'), false);
  assert.equal(shouldRouteToCoreWorker('POST', '/api/projects'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/507f1f77bcf86cd799439011'), true);
});

test('post detail routes through Worker for legacy session auth and anonymous readers', () => {
  const detail = '/api/posts/507f1f77bcf86cd799439011';
  assert.equal(shouldRouteToCoreWorker('GET', detail), true);
  assert.equal(shouldRouteToCoreWorker('HEAD', detail), false);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ cookie: 'orion_session=token' })), true);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ cookie: 'other=one; orion_session=token' })), true);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ authorization: 'Bearer token' })), true);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ 'x-auth-token': 'token' })), true);
  assert.equal(shouldRouteToCoreWorker('GET', detail, '', new Headers({ 'x-google-auth': '{}' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/private/posts'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/507f1f77bcf86cd799439011/stuff'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/not-a-valid-id'), false);
});

test('anonymous likes GET is Worker-only, not writes or credentialed reads', () => {
  const path = '/api/posts/likes/507f1f77bcf86cd799439011';
  assert.equal(shouldRouteToCoreWorker('GET', path), true);
  assert.equal(shouldRouteToCoreWorker('POST', path), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({ cookie: 'orion_session=a' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({ authorization: 'Bearer a' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path + '/add'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/posts/likes/nope'), false);
});

test('private post Worker canary is explicit and requires a legacy JWT carrier', () => {
  const path = '/api/posts/private/posts';
  const canary = 'x-orion-private-worker-canary';
  assert.equal(shouldRouteToCoreWorker('GET', path), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({ [canary]: '1' })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    [canary]: '1', authorization: 'Bearer dummy'
  })), true);
  assert.equal(shouldRouteToCoreWorker('GET', path, '?page=2', new Headers({
    [canary]: '1', cookie: 'orion_session=token'
  })), true);
  assert.equal(shouldRouteToCoreWorker('POST', path, '', new Headers({
    [canary]: '1', authorization: 'Bearer dummy'
  })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    [canary]: '1', authorization: 'Bearer dummy', 'x-google-auth': '{}'
  })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    [canary]: 'wrong', authorization: 'Bearer dummy'
  })), false);
});

test('public menu list is Worker-only; category duplicates and other menu endpoints remain on Cloud Run', () => {
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu', '?category=dinner'), true);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu', '?category=a&category=b'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu/draw'), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/menu/history'), false);
  assert.equal(shouldRouteToCoreWorker('POST', '/api/menu'), false);
});

test('diagnostic header identifies private-canary fallback only, without exposing credentials', async () => {
  const { default: gateway } = await import('./src/index.js');
  const originalFetch = globalThis.fetch;
  const request = new Request('https://api.samyao.me/api/posts/private/posts', {
    headers: {
      cookie: 'orion_session=safe-test-cookie',
      origin: 'https://samyao.me',
      'x-orion-private-worker-canary': '1'
    }
  });
  const env = {
    ORIGIN_URL: 'https://upstream.example',
    GENERAL_LIMITER: { limit: async () => ({ success: true }) },
    BANANABOOM_CORE: {
      fetch: async () => new Response('unavailable', {
        status: 503, headers: { 'x-orion-private-worker-stage': 'auth' }
      })
    }
  };
  let forwarded;
  globalThis.fetch = async (req) => {
    forwarded = req;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const reply = await gateway.fetch(request, env);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('x-orion-private-canary-result'), 'fallback-auth');
    assert.match(reply.headers.get('access-control-expose-headers'), /x-orion-private-canary-result/);
    assert.equal(forwarded.headers.get('cookie'), 'orion_session=safe-test-cookie');
    assert.equal(forwarded.headers.has('x-orion-private-worker-canary'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private rollout is sampled only for signed-in eligible requests and can be instantly disabled', async () => {
  const { shouldRoutePrivateRead } = await import('./src/index.js');
  const path = '/api/posts/private/posts';
  const cookie = new Headers({ cookie: 'other=1; orion_session=real-jwt' });
  assert.equal(shouldRoutePrivateRead('GET', path, '?page=1&limit=5', cookie, 10, 0.01), true);
  assert.equal(shouldRoutePrivateRead('GET', path, '?page=1&limit=5', cookie, 10, 0.99), false);
  assert.equal(shouldRoutePrivateRead('GET', path, '?page=1&limit=5', cookie, 0, 0), false);
  assert.equal(shouldRoutePrivateRead('GET', path, '?page=1&limit=5', new Headers({
    cookie: 'orion_session=real-jwt', 'x-orion-private-worker-canary': '1'
  }), 0, 1), true);
  assert.equal(shouldRoutePrivateRead('GET', path, '', new Headers(), 100, 0), false);
  assert.equal(shouldRoutePrivateRead('POST', path, '', cookie, 100, 0), false);
  assert.equal(shouldRoutePrivateRead('GET', path, '', new Headers({ 'x-google-auth': 'token', cookie: 'orion_session=x' }), 100, 0), false);
  assert.equal(shouldRoutePrivateRead('GET', path, '?limit=51', cookie, 100, 0), false);
  assert.equal(shouldRoutePrivateRead('GET', path, '?page=0', cookie, 100, 0), false);
  assert.equal(shouldRoutePrivateRead('GET', path, '?q=a&q=b', cookie, 100, 0), false);
  assert.equal(shouldRoutePrivateRead('GET', '/api/posts', '', cookie, 100, 0), false);
});

test('private rollout Worker errors continue to use Cloud Run fallback', async () => {
  const { default: gateway } = await import('./src/index.js');
  const origFetch = globalThis.fetch;
  const env = {
    ORIGIN_URL: 'https://upstream.example',
    PRIVATE_POST_READ_ROLLOUT_PERCENT: '100',
    GENERAL_LIMITER: { limit: async () => ({ success: true }) },
    BANANABOOM_CORE: { fetch: async () => new Response('unavailable', { status: 503 }) }
  };
  let received = false;
  globalThis.fetch = async (request) => {
    received = true;
    assert.match(request.url, /upstream\.example\/api\/posts\/private\/posts/);
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const response = await gateway.fetch(new Request(
      'https://api.samyao.me/api/posts/private/posts', {
        headers: { cookie: 'orion_session=test-cookie' }
      }
    ), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('x-bananaboom-origin'), false);
    assert.equal(received, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('only exact blog-like mutations are routed to Worker', async () => {
  const { isWorkerLikeMutation } = await import('./src/index.js');
  const p = '/api/posts/likes/507f1f77bcf86cd799439011';
  assert.equal(isWorkerLikeMutation('POST', p + '/add'), true);
  assert.equal(isWorkerLikeMutation('POST', p + '/remove'), true);
  assert.equal(isWorkerLikeMutation('GET', p + '/add'), false);
  assert.equal(isWorkerLikeMutation('DELETE', p + '/add'), false);
  assert.equal(isWorkerLikeMutation('POST', p + '/reset'), false);
  assert.equal(isWorkerLikeMutation('POST', '/api/posts/likes/not-valid/add'), false);
  assert.equal(isWorkerLikeMutation('POST', '/api/posts/507f1f77bcf86cd799439011'), false);
  assert.equal(isWorkerLikeMutation('POST', '/api/posts'), false);
});

test('blog-like POST goes to Worker once and never calls Cloud Run after ambiguous 5xx', async () => {
  const { default: gateway } = await import('./src/index.js');
  const path = '/api/posts/likes/507f1f77bcf86cd799439011/add';
  const originalFetch = globalThis.fetch;
  let upstream = 0, called = 0;
  globalThis.fetch = async () => { upstream++; return new Response('legacy'); };
  const env = {
    ORIGIN_URL: 'https://upstream.example',
    GENERAL_LIMITER: { limit: async () => ({ success: true }) },
    LIKE_LIMITER: { limit: async () => ({ success: true }) },
    BANANABOOM_CORE: {
      fetch: async (request) => {
        called++;
        assert.equal(request.method, 'POST');
        return new Response('unknown', { status: 503 });
      }
    }
  };
  try {
    const reply = await gateway.fetch(new Request('https://api.samyao.me' + path, {
      method: 'POST',
      headers: { origin: 'https://samyao.me' }
    }), env);
    assert.equal(reply.status, 503);
    assert.equal(reply.headers.get('access-control-allow-origin'), 'https://samyao.me');
    assert.equal(reply.headers.get('x-bananaboom-origin'), null);
    assert.equal(called, 1);
    assert.equal(upstream, 0, 'Cloud Run must never replay a possibly committed mutation');

    env.BANANABOOM_CORE.fetch = async () => { throw Error('network interrupted'); };
    const failed = await gateway.fetch(new Request('https://api.samyao.me' + path, {
      method: 'POST',
      headers: { origin: 'https://samyao.me' }
    }), env);
    assert.equal(failed.status, 503);
    assert.equal(upstream, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('blog like limit preserves 30/IP/min bucket and 429 response', async () => {
  const { default: gateway } = await import('./src/index.js');
  const env = {
    GENERAL_LIMITER: { limit: async () => { throw Error('wrong bucket'); } },
    LIKE_LIMITER: { limit: async ({ key }) => {
      assert.match(key, /:likes$/);
      return { success: false };
    } }
  };
  const reply = await gateway.fetch(new Request(
    'https://api.samyao.me/api/posts/likes/507f1f77bcf86cd799439011/add', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '192.0.2.1' }
    }
  ), env);
  assert.equal(reply.status, 429);
  assert.match((await reply.json()).message, /手速太快/);
});

test('blog CRUD must stay on Cloud Run until audit notifications and Bark delivery are migrated', () => {
  const id = '507f1f77bcf86cd799439011';
  for (const [method, path] of [
    ['POST', '/api/posts'],
    ['PUT', '/api/posts/' + id],
    ['DELETE', '/api/posts/' + id],
    ['PATCH', '/api/posts/' + id]
  ]) {
    assert.equal(shouldRouteToCoreWorker(method, path), false);
    assert.equal(isWorkerLikeMutation(method, path), false);
  }
  assert.equal(isWorkerLikeMutation('POST', '/api/posts/likes/' + id + '/add'), true);
});

test('worker audit feed is only eligible for valid legacy session carriers and safe cursors', () => {
  const path = '/api/audit/worker-events';
  const cookie = new Headers({ cookie: 'orion_session=signed-session' });
  assert.equal(shouldRouteToCoreWorker('GET', path, '', cookie), true);
  assert.equal(shouldRouteToCoreWorker('GET', path, '?after=507f1f77bcf86cd799439011', cookie), true);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers()), false);
  assert.equal(shouldRouteToCoreWorker('POST', path, '', cookie), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '', new Headers({
    cookie: 'orion_session=signed-session', 'x-google-auth': 'google-legacy'
  })), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '?after=invalid', cookie), false);
  assert.equal(shouldRouteToCoreWorker('GET', path, '?after=507f1f77bcf86cd799439011&after=507f1f77bcf86cd799439012', cookie), false);
  assert.equal(shouldRouteToCoreWorker('GET', '/api/audit', '', cookie), false);
});


test('retired public shared-secret endpoints are blocked at Gateway before Cloud Run', async () => {
  const { default: gateway } = await import('./src/index.js');
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; return new Response('legacy endpoint'); };
  const env = {
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
    GENERAL_LIMITER: { limit: async () => ({ success: true }) },
  };
  try {
    for (const path of ['/api/users/reset-by-secret', '/api/auth/verify-secret']) {
      assert.equal(isRetiredSecretEndpoint('POST', path), true);
      const response = await gateway.fetch(new Request('https://api.samyao.me' + path, {
        method: 'POST',
        headers: { origin: 'https://samyao.me', 'content-type': 'application/json' },
        body: '{}'
      }), env);
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('x-orion-edge'), 'cloudflare');
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://samyao.me');
      assert.match((await response.json()).message, /retired/i);
    }
    assert.equal(upstreamCalls, 0);
    assert.equal(isRetiredSecretEndpoint('POST', '/api/auth/send-otp'), false);
    assert.equal(isRetiredSecretEndpoint('POST', '/api/users/reset-password'), false);
    assert.equal(isRetiredSecretEndpoint('GET', '/api/users/reset-by-secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('article mutations require stable idempotency key and legacy session, exclude Google identity', async () => {
  const { isArticleWrite, routeArticleWrite } = await import('./src/index.js');
  const postId = '507f1f77bcf86cd799439011';
  const headers = new Headers({
    cookie: 'orion_session=signed-session',
    'x-idempotency-key': '12345678-1234-4000-8000-123456789abc'
  });
  assert.equal(isArticleWrite('POST', '/api/posts', headers), true);
  assert.equal(isArticleWrite('PUT', '/api/posts/' + postId, headers), true);
  assert.equal(isArticleWrite('DELETE', '/api/posts/' + postId, headers), true);
  assert.equal(isArticleWrite('POST', '/api/posts/likes/' + postId + '/add', headers), false);
  assert.equal(isArticleWrite('GET', '/api/posts/' + postId, headers), false);
  assert.equal(isArticleWrite('POST', '/api/posts', new Headers()), false);
  assert.equal(isArticleWrite('POST', '/api/posts', new Headers({cookie:'orion_session=token'})), false);
  assert.equal(isArticleWrite('POST', '/api/posts', new Headers({
    ...Object.fromEntries(headers), 'x-google-auth': '{}'
  })), false);
  assert.equal(routeArticleWrite('POST', '/api/posts', headers, false), false);
  assert.equal(routeArticleWrite('POST', '/api/posts', headers, true), true);
  headers.set('x-orion-article-write-canary', '1');
  assert.equal(routeArticleWrite('POST', '/api/posts', headers, false), true);
});

test('article CREATE forwards JSON body only once to Core and returns CORS Worker marker', async () => {
  const { default: gateway } = await import('./src/index.js');
  const originalFetch = globalThis.fetch;
  let cloudrun = 0;
  let core = 0;
  globalThis.fetch = async () => { cloudrun++; return new Response('legacy'); };
  const env = {
    ORIGIN_URL: 'https://upstream.example',
    ARTICLE_WRITE_CUTOVER: '1',
    GENERAL_LIMITER: { limit: async () => ({ success:true }) },
    WRITE_LIMITER: { limit: async () => ({ success:true }) },
    BANANABOOM_CORE: { fetch: async (request) => {
      core++;
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('x-idempotency-key'), '12345678-1234-4000-8000-123456789abc');
      assert.equal(request.headers.has('x-orion-article-write-canary'), false);
      assert.deepEqual(await request.json(), { name:'Test', info:'Summary', author:'Author' });
      return new Response(JSON.stringify({success:true,data:{_id:'new'}}),{
        status:201,headers:{'content-type':'application/json'}
      });
    }}
  };
  try {
    const res = await gateway.fetch(new Request('https://api.samyao.me/api/posts',{
      method:'POST', headers:{
        'content-type':'application/json','origin':'https://samyao.me',
        'cookie':'orion_session=signed-session',
        'x-idempotency-key':'12345678-1234-4000-8000-123456789abc',
        'x-orion-article-write-canary':'1'
      },
      body:JSON.stringify({name:'Test',info:'Summary',author:'Author'})
    }),env);
    assert.equal(res.status,201);
    assert.equal(res.headers.get('x-bananaboom-origin'),'worker');
    assert.equal(res.headers.get('access-control-allow-origin'),'https://samyao.me');
    assert.equal((await res.json()).success,true);
    assert.equal(core,1);
    assert.equal(cloudrun,0);
  } finally { globalThis.fetch = originalFetch; }
});

test('article mutation ambiguous 5xx, thrown error and missing binding NEVER replay on Cloud Run', async () => {
  const { default: gateway } = await import('./src/index.js');
  const originalFetch = globalThis.fetch;
  let cloudrun = 0;
  globalThis.fetch = async () => { cloudrun++; return new Response('legacy'); };
  const env = {
    ORIGIN_URL:'https://upstream.example',
    ARTICLE_WRITE_CUTOVER:'1',
    GENERAL_LIMITER: { limit: async () => ({ success:true }) },
    WRITE_LIMITER: { limit: async () => ({ success:true }) },
    BANANABOOM_CORE: { fetch: async () => new Response('db unknown',{status:503}) }
  };
  const make = () => new Request(
    'https://api.samyao.me/api/posts/507f1f77bcf86cd799439011',{
      method:'DELETE',headers:{
        cookie:'orion_session=token',
        'x-idempotency-key':'12345678-1234-4000-8000-123456789abc'
      }
    }
  );
  try {
    let r = await gateway.fetch(make(),env);
    assert.equal(r.status,503);
    assert.match((await r.json()).error,/same X-Idempotency-Key/);
    assert.equal(cloudrun,0);
    env.BANANABOOM_CORE.fetch = async () => { throw Error('connection interrupted'); };
    r = await gateway.fetch(make(),env);
    assert.equal(r.status,503);
    assert.equal(cloudrun,0);
    delete env.BANANABOOM_CORE;
    r = await gateway.fetch(make(),env);
    assert.equal(r.status,503);
    assert.equal(cloudrun,0);
  } finally { globalThis.fetch = originalFetch; }
});
