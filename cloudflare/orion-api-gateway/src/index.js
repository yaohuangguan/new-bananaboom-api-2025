import { redactPublicPostResponse } from './publicPostPrivacy.js';

const ALLOWED_ORIGINS = new Set([
  'https://samyao.me',
  'https://www.samyao.me',
  'https://ps6.space',
  'https://www.ps6.space',
  'https://bananaboom-frontend.vercel.app',
  'http://localhost:5173'
]);

const ALLOWED_ORIGIN_SUFFIXES = [
  '.samyao.me',
  '.ps6.space',
  '.vercel.app',
  '.scf.usercontent.goog'
];

// Mutable Orion content is intentionally not edge-cached.
// Correctness after create/update/delete is more important than saving a small number
// of Cloud Run reads. Add routes here only when their staleness contract is explicit.
const MIGRATED_PUBLIC_READ_PATHS = new Set([
  '/api/homepage',
  '/api/homepage/likes',
  '/api/homepage/projects',
  '/api/homepage/logs',
  '/api/projects',
  '/api/menu',
  '/api/posts',
  '/api/tags'
]);

// Explicit path allowlist prevents private, write and admin routes from
// accidentally bypassing the legacy Cloud Run auth and permission checks.
export function isWorkerLikeMutation(method, path) {
  return method === 'POST' &&
    /^\/api\/posts\/likes\/[a-f\d]{24}\/(?:add|remove)$/i.test(path);
}

// No stochastic write sampling: the same idempotency key must always hit
// the same backend across retries. Deploy at 0, canary explicitly, then 100.
export function isArticleWrite(method, path, headers = {}) {
  const validMethodPath = method === 'POST'
    ? path === '/api/posts'
    : (method === 'PUT' || method === 'DELETE') &&
      /^\/api\/posts\/[a-f0-9]{24}$/i.test(path);
  if (!validMethodPath) return false;
  const get = (name) => typeof headers?.get === 'function'
    ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
  if (get('x-google-auth')) return false;
  const signedIn = get('x-auth-token') ||
    get('authorization')?.startsWith('Bearer ') ||
    /(?:^|;)\s*orion_session=/.test(get('cookie') || '');
  return Boolean(signedIn) && /^[A-Za-z0-9_-]{16,128}$/.test(get('x-idempotency-key') || '');
}

export function routeArticleWrite(method, path, headers, cutover = false) {
  if (!isArticleWrite(method, path, headers)) return false;
  const get = (name) => typeof headers?.get === 'function'
    ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
  return cutover || get('x-orion-article-write-canary') === '1';
}

// Retire publicly callable shared-secret recovery/verification before Cloud
// Run gets rebuilt; a valid VIP role is no longer an anonymous password.
export function isRetiredSecretEndpoint(method, path) {
  return method === 'POST' && (
    path === '/api/users/reset-by-secret' ||
    path === '/api/auth/verify-secret'
  );
}

function hasLegacyCredentials(headers) {
  const get = (name) => typeof headers?.get === 'function'
    ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
  if (get('x-auth-token') || get('authorization') || get('x-google-auth')) return true;
  return Boolean(get('cookie'));
}

function isPrivateReadEligible(path, search, headers) {
  if (path !== '/api/posts/private/posts') return false;
  const get = (name) => typeof headers?.get === 'function'
    ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
  const hasJwt = Boolean(get('x-auth-token') ||
    get('authorization')?.startsWith('Bearer ') ||
    /(?:^|;)\s*orion_session=/.test(get('cookie') || ''));
  if (!hasJwt || get('x-google-auth')) return false;
  const params = new URLSearchParams(search);
  for (const key of ['q', 'tag']) {
    if (params.getAll(key).length > 1 || (params.get(key)?.length || 0) > 100) return false;
  }
  for (const [key, limit] of [['page', 1000], ['limit', 50]]) {
    const values = params.getAll(key);
    if (values.length > 1) return false;
    if (values.length && (!/^\d+$/.test(values[0]) ||
      Number(values[0]) < 1 || Number(values[0]) > limit)) return false;
  }
  return true;
}

export function shouldRoutePrivateRead(method, path, search = '', headers = {}, rolloutPercent = 0, sample = Math.random()) {
  if (method !== 'GET' || !isPrivateReadEligible(path, search, headers)) return false;
  const get = (name) => typeof headers?.get === 'function'
    ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
  if (get('x-orion-private-worker-canary') === '1') return true;
  return Number.isFinite(rolloutPercent) && rolloutPercent > 0 &&
    sample < Math.min(100, rolloutPercent) / 100;
}

export function shouldRouteToCoreWorker(method, path, search = '', headers = {}) {
  if (method !== 'GET') return false;
  if (path === '/api/audit/worker-events') {
    const get = (name) => typeof headers?.get === 'function'
      ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
    const hasJwt = Boolean(get('x-auth-token') ||
      get('authorization')?.startsWith('Bearer ') ||
      /(?:^|;)\s*orion_session=/.test(get('cookie') || ''));
    const query = new URLSearchParams(search);
    const after = query.getAll('after');
    return hasJwt && !get('x-google-auth') &&
      after.length <= 1 && (!after.length || /^[a-f0-9]{24}$/i.test(after[0]));
  }
  if (path === '/api/posts/private/posts') {
    // No normal private routing without an explicit rollout decision.
    return shouldRoutePrivateRead(method, path, search, headers, 0);
  }
  if (/^\/api\/posts\/likes\/[a-f\d]{24}$/i.test(path)) {
    return !hasLegacyCredentials(headers);
  }
  if (/^\/api\/posts\/[a-f\d]{24}$/i.test(path)) {
    // The Worker now verifies live JWT/Session/RBAC for authenticated details.
    // Keep the separate legacy Google identity header on Cloud Run.
    const get = (name) => typeof headers?.get === 'function'
      ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
    return !get('x-google-auth') &&
      (!get('authorization') || get('authorization').startsWith('Bearer '));
  }
  if (!MIGRATED_PUBLIC_READ_PATHS.has(path)) return false;
  const query = new URLSearchParams(search);
  // Logged-in users can request private/all tags from the original authenticated
  // API. Never serve those queries from the public-only MongoDB RPC.
  if (path === '/api/menu') {
    const categories = query.getAll('category');
    return categories.length <= 1 && (categories.length === 0 || categories[0].length <= 100);
  }
  if (path === '/api/tags') {
    const types = query.getAll('type');
    return types.length <= 1 && (types.length === 0 || types[0] === 'public');
  }
  if (path === '/api/posts') {
    if (['q', 'tag'].some((key) => query.get(key)?.length > 100)) return false;
    for (const [key, max] of [['page', 1000], ['limit', 50]]) {
      const v = query.get(key);
      if (v !== null && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max)) return false;
    }
  }
  return true;
}

const PUBLIC_CACHE_RULES = [];

const EXPENSIVE_PREFIXES = [
  '/api/ai',
  '/api/drawing',
  '/api/voice2map',
  '/api/debater',
  '/api/rpg',
  '/api/reading',
  '/api/upload',
  '/api/backup',
  '/api/projects/import-github'
];

const AUTH_PREFIXES = ['/api/auth', '/api/users', '/authorize', '/token', '/register', '/revoke'];

const R2_BROWSER_READ_PATHS = new Set([
  '/api/upload/list',
  '/api/upload/r2/usage',
  '/api/upload/object'
]);

function isR2BrowserRead(request, pathname) {
  return ['GET', 'HEAD'].includes(request.method) && R2_BROWSER_READ_PATHS.has(pathname);
}


function corsOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;

  try {
    const hostname = new URL(origin).hostname;
    if (ALLOWED_ORIGIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return origin;
    }
  } catch {
    return null;
  }

  return null;
}

function preflightResponse(request) {
  const origin = corsOrigin(request);
  if (request.headers.get('origin') && !origin) {
    return new Response(null, { status: 403 });
  }

  const headers = new Headers({
    'access-control-allow-methods': 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    'access-control-allow-headers':
      request.headers.get('access-control-request-headers') ||
      'authorization,content-type,x-auth-token,x-google-auth,x-cloudflare-ai-token,x-cloudflare-account-id',
    'access-control-max-age': '86400',
    'cache-control': 'public, max-age=86400',
    vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method'
  });

  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
  }

  return new Response(null, { status: 204, headers });
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function hasPrivateContext(request) {
  return Boolean(
    request.headers.get('authorization') ||
      request.headers.get('x-auth-token') ||
      request.headers.get('x-google-auth') ||
      request.headers.get('cookie')
  );
}

function cacheTtlFor(request, pathname) {
  if (request.method !== 'GET' || hasPrivateContext(request)) return 0;

  const rule = PUBLIC_CACHE_RULES.find(({ prefix }) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}?`)
  );
  return rule?.ttl || 0;
}

function isExpensive(pathname) {
  return EXPENSIVE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function isAuth(pathname) {
  return AUTH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

async function enforceRateLimit(request, env, pathname) {
  if (request.method === 'OPTIONS') return null;

  const ip = clientIp(request);
  let limiter = env.GENERAL_LIMITER;
  let bucket = 'general';

  if (isWorkerLikeMutation(request.method, pathname)) {
    // Preserve the legacy 30/IP/min like limiter, separate from general writes.
    limiter = env.LIKE_LIMITER || env.WRITE_LIMITER || env.GENERAL_LIMITER;
    bucket = 'likes';
  } else if (isR2BrowserRead(request, pathname)) {
    // System Management's R2 browser can legitimately issue list/usage/range-preview
    // requests in quick succession. Keep these reads isolated from the 12/min
    // expensive mutation bucket while retaining per-IP protection.
    limiter = env.GENERAL_LIMITER;
    bucket = 'r2-browser-read';
  } else if (
    isExpensive(pathname) ||
    (!['GET', 'HEAD'].includes(request.method) &&
      /^\/api\/brain\/(?:imports|exports|restore|legacy\/preview)(?:\/|$)/.test(pathname))
  ) {
    limiter = env.EXPENSIVE_LIMITER;
    bucket = 'expensive';
  } else if (isAuth(pathname)) {
    limiter = env.AUTH_LIMITER;
    bucket = 'auth';
  } else if (!['GET', 'HEAD'].includes(request.method)) {
    limiter = env.WRITE_LIMITER;
    bucket = 'write';
  }

  const { success } = await limiter.limit({ key: `${ip}:${bucket}` });
  if (success) return null;

  if (bucket === 'likes') {
    return new Response(JSON.stringify({
      message: '❤️ 您的手速太快了，请休息一下再点赞吧！'
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': '60',
        'cache-control': 'no-store'
      }
    });
  }
  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      retryAfter: 60
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': '60',
        'cache-control': 'no-store'
      }
    }
  );
}

function withSecurityHeaders(response) {
  const next = new Response(response.body, response);
  next.headers.set('x-content-type-options', 'nosniff');
  next.headers.set('referrer-policy', 'same-origin');
  next.headers.set('strict-transport-security', 'max-age=31536000');
  next.headers.set('x-robots-tag', 'noindex, nofollow');
  next.headers.set('x-orion-edge', 'cloudflare');
  next.headers.delete('x-powered-by');
  return next;
}

function articleWriteFailure(request) {
  const response = withSecurityHeaders(new Response(JSON.stringify({
    error: 'Article operation result unknown. Retry only with the same X-Idempotency-Key.'
  }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  }));
  const origin = corsOrigin(request);
  if (origin) {
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('access-control-allow-credentials', 'true');
    response.headers.append('vary', 'Origin');
  }
  return response;
}

function likeWriteFailure(request) {
  // The Worker might have committed an increment before its connection failed.
  // Never retry or fall back to Cloud Run, or we can double-count the same click.
  const response = withSecurityHeaders(new Response(
    JSON.stringify({
      error: 'Like update result unknown. Refresh the displayed count before retrying.'
    }), {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    }
  ));
  const origin = corsOrigin(request);
  if (origin) {
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('access-control-allow-credentials', 'true');
    response.headers.append('vary', 'Origin');
  }
  return response;
}

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    const pathname = incomingUrl.pathname;

    if (request.method === 'OPTIONS') {
      return withSecurityHeaders(preflightResponse(request));
    }

    const limited = await enforceRateLimit(request, env, pathname);
    if (limited) return withSecurityHeaders(limited);

    if (isRetiredSecretEndpoint(request.method, pathname)) {
      const response = withSecurityHeaders(new Response(JSON.stringify({
        message: 'Shared admin passphrases are retired. Sign in with a verification code.'
      }), {
        status: 410,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        }
      }));
      const origin = corsOrigin(request);
      if (origin) {
        response.headers.set('access-control-allow-origin', origin);
        response.headers.set('access-control-allow-credentials', 'true');
        response.headers.append('vary', 'Origin');
      }
      return response;
    }

    const privateCanary = request.method === 'GET' &&
      pathname === '/api/posts/private/posts' &&
      request.headers.get('x-orion-private-worker-canary') === '1';
    let privateCanaryResult = 'not-routed';

    // Internal service binding: no public workers.dev hop, no shared origin secret.
    // Keep Cloud Run as a per-request fallback if the new database path fails.
    const rolloutPercent = Number(env.PRIVATE_POST_READ_ROLLOUT_PERCENT || 0);
    const likeWrite = isWorkerLikeMutation(request.method, pathname);
    const articleWrite = routeArticleWrite(request.method, pathname, request.headers,
      String(env.ARTICLE_WRITE_CUTOVER || '0') === '1');
    const routeToCore = likeWrite || articleWrite ? true : pathname === '/api/posts/private/posts'
      ? shouldRoutePrivateRead(request.method, pathname, incomingUrl.search, request.headers, rolloutPercent)
      : shouldRouteToCoreWorker(request.method, pathname, incomingUrl.search, request.headers);

    if (routeToCore && env.BANANABOOM_CORE) {
      try {
        const workerHeaders = new Headers(request.headers);
        workerHeaders.delete('host');
        workerHeaders.delete('x-forwarded-host');
        workerHeaders.delete('x-orion-edge-secret');
        workerHeaders.delete('x-orion-private-worker-canary');
        workerHeaders.delete('x-orion-article-write-canary');
        const body = articleWrite ? request.body : undefined;
        const workerRequest = new Request(request.url, {
          method: request.method,
          headers: workerHeaders,
          ...(body ? { body, duplex: 'half' } : {}),
          // Like updates remain bodyless.
          redirect: 'manual'
        });
        const workerResponse = await env.BANANABOOM_CORE.fetch(workerRequest);
        if (workerResponse.status < 500) {
          const secured = withSecurityHeaders(workerResponse);
          secured.headers.set('x-bananaboom-origin', 'worker');
          if (pathname === '/api/posts/private/posts') {
            secured.headers.set('access-control-expose-headers', 'x-orion-private-canary-result, x-bananaboom-origin');
          }
          if (privateCanary) {
            secured.headers.set('x-orion-private-canary-result', 'worker');
            secured.headers.set('access-control-expose-headers', 'x-orion-private-canary-result, x-bananaboom-origin');
          }
          secured.headers.set('cache-control', 'no-store');
          const allowedOrigin = corsOrigin(request);
          if (allowedOrigin) {
            secured.headers.set('access-control-allow-origin', allowedOrigin);
            secured.headers.set('access-control-allow-credentials', 'true');
            secured.headers.append('vary', 'Origin');
          }
          return redactPublicPostResponse(request, secured);
        }
        if (articleWrite) {
          console.error('BananaBoom article write returned 5xx; never retry via Cloud Run');
          return articleWriteFailure(request);
        }
        if (likeWrite) {
          console.error('BananaBoom like write returned 5xx; not replaying mutation');
          return likeWriteFailure(request);
        }
        if (privateCanary) {
          const stage = workerResponse.headers.get('x-orion-private-worker-stage');
          privateCanaryResult = stage === 'auth' ? 'fallback-auth' :
            stage === 'query' ? 'fallback-query' : 'fallback-5xx';
        }
        console.error('BananaBoom Worker read returned', workerResponse.status, 'falling back to Cloud Run');
      } catch (error) {
        if (articleWrite) {
          console.error('BananaBoom article write exception; not replaying', error?.name || 'UnknownError');
          return articleWriteFailure(request);
        }
        if (likeWrite) {
          console.error('BananaBoom like write threw; not replaying mutation', error?.name || 'UnknownError');
          return likeWriteFailure(request);
        }
        if (privateCanary) privateCanaryResult = 'fallback-exception';
        // Do not log credential-bearing request URLs or headers.
        console.error('BananaBoom Worker read failed; falling back to Cloud Run', error?.name || 'UnknownError');
      }
    }

    if (articleWrite) return articleWriteFailure(request); // No core binding -> never replay.
    const originUrl = new URL(pathname + incomingUrl.search, env.ORIGIN_URL);
    const headers = new Headers(request.headers);
    headers.set('x-orion-edge', 'cloudflare');

    if (env.ORIGIN_EDGE_SECRET) {
      headers.set('x-orion-edge-secret', env.ORIGIN_EDGE_SECRET);
    }

    // Do not let clients choose the upstream host or spoof edge-only metadata.
    headers.delete('host');
    headers.delete('x-forwarded-host');
    headers.delete('x-orion-private-worker-canary');
    headers.delete('x-orion-article-write-canary');

    const ttl = cacheTtlFor(request, pathname);
    const upstreamRequest = new Request(originUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      duplex: 'half'
    });

    const response = await fetch(
      upstreamRequest,
      ttl > 0
        ? {
            cf: {
              cacheEverything: true,
              cacheTtl: ttl,
              cacheKey: `${request.url}::origin=${request.headers.get('origin') || 'none'}`
            }
          }
        : undefined
    );

    const secured = withSecurityHeaders(response);
    if (privateCanary) {
      secured.headers.set('x-orion-private-canary-result', privateCanaryResult);
      secured.headers.set('access-control-expose-headers', 'x-orion-private-canary-result, x-bananaboom-origin');
    }

    if (ttl > 0) {
      secured.headers.delete('set-cookie');
      secured.headers.set('cache-control', `public, max-age=0, s-maxage=${ttl}`);
    } else {
      secured.headers.set('cache-control', 'no-store');
    }

    return redactPublicPostResponse(request, secured);
  }
};
