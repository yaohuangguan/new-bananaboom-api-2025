import { redactPublicPostResponse } from './publicPostPrivacy.js';
import { serveResumePdf } from './resumePdf.js';

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
  '/api/tags',
  '/api/photos',
  '/api/resumes',
  '/api/resumes/list'
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

// Human chat, Socket.IO and legacy Stripe checkout are intentionally retired.
// AI conversation history under /api/chat/ai remains a supported endpoint.
export function isRetiredOrionFeature(path) {
  return path === '/socket.io' || path.startsWith('/socket.io/') ||
    path === '/api/payments' || path.startsWith('/api/payments/') ||
    path === '/api/chat/public' || path.startsWith('/api/chat/public/') ||
    path === '/api/chat/private' || path.startsWith('/api/chat/private/');
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

export function isAuthenticatedProfileCandidate(method, path, search = '', headers = {}, cutover = false) {
  if (method !== 'GET' || !['/api/users/profile', '/api/users/ai-status'].includes(path) ||
      search) return false;
  const get = (key) => typeof headers?.get === 'function'
    ? headers.get(key) : headers?.[key] || headers?.[key.toLowerCase()] || null;
  const session = Boolean(get('x-auth-token') ||
    get('authorization')?.startsWith('Bearer ') ||
    /(?:^|;)\s*orion_session=/.test(get('cookie') || ''));
  if (!session || get('x-google-auth')) return false;
  return cutover || get('x-orion-profile-canary') === '1';
}

export function isTodoListReadCandidate(method, path, search = '', headers = {}, cutover = false) {
  if (method !== 'GET' || path !== '/api/todos') return false;
  const get = (key) => typeof headers?.get === 'function'
    ? headers.get(key) : headers?.[key] || headers?.[key.toLowerCase()] || null;
  const session = get('x-auth-token') ||
    get('authorization')?.startsWith('Bearer ') ||
    /(?:^|;)\s*orion_session=/.test(get('cookie') || '');
  if (!session || get('x-google-auth')) return false;
  const allowed = new Set(['page', 'limit', 'type', 'keyword', 'isActive']);
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) return false;
  }
  const numeric = [['page', 1000], ['limit', 100]];
  for (const [name, max] of numeric) {
    const value = params.get(name);
    if (value !== null && (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > max)) return false;
  }
  if (params.has('type') && !['wish', 'routine'].includes(params.get('type'))) return false;
  if (params.has('isActive') && !['true', 'false'].includes(params.get('isActive'))) return false;
  if (params.has('keyword') && (params.get('keyword').length > 100 ||
    params.get('keyword').includes('\0'))) return false;
  return Boolean(cutover || get('x-orion-todo-read-canary') === '1');
}

export function isFootprintReadCandidate(method, path, search = '', headers = {}, cutover = false) {
  if (method !== 'GET' || path !== '/api/footprints') return false;
  const get = (key) => typeof headers?.get === 'function'
    ? headers.get(key) : headers?.[key] || headers?.[key.toLowerCase()] || null;
  const signed = get('x-auth-token') ||
    get('authorization')?.startsWith('Bearer ') ||
    /(?:^|;)\s*orion_session=/.test(get('cookie') || '');
  if (!signed || get('x-google-auth')) return false;
  const query = new URLSearchParams(search);
  if ([...query.keys()].some(key => key !== 'status') ||
      query.getAll('status').length > 1) return false;
  if (query.has('status') && !['visited', 'planned'].includes(query.get('status'))) {
    return false;
  }
  return Boolean(cutover || get('x-orion-footprint-read-canary') === '1');
}

export function isFootprintDetailCandidate(method, path, search = '', headers = {}, cutover = false) {
  if (method !== 'GET' || !/^\/api\/footprints\/[a-f0-9]{24}$/i.test(path) || search) return false;
  const get = (name) => typeof headers?.get === 'function'
    ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
  const signed = get('x-auth-token') ||
    get('authorization')?.startsWith('Bearer ') ||
    /(?:^|;)\s*orion_session=/.test(get('cookie') || '');
  if (!signed || get('x-google-auth')) return false;
  return Boolean(cutover || get('x-orion-footprint-detail-canary') === '1');
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
  // Only public comment GETs, never comment writes or admin endpoints.
  if (/^\/api\/comments\/[a-f0-9]{24}$/i.test(path) ||
      /^\/api\/comments\/reply\/[a-f0-9]{24}$/i.test(path)) {
    const get = (name) => typeof headers?.get === 'function'
      ? headers.get(name) : headers?.[name] || headers?.[name.toLowerCase()] || null;
    return !search && !get('x-auth-token') && !get('x-google-auth') &&
      !get('authorization') &&
      !/(?:^|;)\s*orion_session=/.test(get('cookie') || '');
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
  if (path === '/api/resumes' || path === '/api/resumes/list') {
    const users = query.getAll('user');
    return [...query.keys()].every((key) => key === 'user') &&
      users.length <= 1 && (users.length === 0 || users[0].length <= 180);
  }
  if (path === '/api/photos') return !search;
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
  '/api/projects/import-github',
  '/api/resumes/export-pdf'
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

function footprintDetailFailure(request, status = 503) {
  // A failed owner-validation check must NEVER fall back to the legacy
  // Cloud Run by-ID endpoint; that would bypass the ownership control.
  const response = withSecurityHeaders(new Response(JSON.stringify({
    message: status === 401 ? 'Signed-in session required for footprint detail' :
      'Footprint detail temporarily unavailable'
  }), {
    status, headers: {
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

    // Anonymous profile probes require no MongoDB lookup. The legacy
    // middleware responds with precisely this 401 whenever no real auth
    // carrier exists. Do not forward unrelated analytics/GAESA cookies.
    if (request.method === 'GET' && pathname === '/api/users/profile' &&
        !request.headers.get('x-auth-token') &&
        !request.headers.get('x-google-auth') &&
        !request.headers.get('authorization') &&
        !/(?:^|;)\s*orion_session=/.test(request.headers.get('cookie') || '')) {
      const response = withSecurityHeaders(new Response(JSON.stringify({
        success: false,
        message: 'Unauthorized: Please login first',
        message_cn: '请先登录'
      }), {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-bananaboom-origin': 'worker'
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

    if (pathname === '/api/resumes/export-pdf' &&
        (env.PDF_BROWSER_CUTOVER === '1' ||
         request.headers.get('x-orion-pdf-canary') === '1')) {
      const pdf = await serveResumePdf(request, env);
      const secured = withSecurityHeaders(pdf);
      const origin = corsOrigin(request);
      if (origin) {
        secured.headers.set('access-control-allow-origin', origin);
        secured.headers.set('access-control-allow-credentials', 'true');
        secured.headers.append('vary', 'Origin');
      }
      return secured;
    }

    const backupMigration = pathname === '/api/backup/database' &&
      request.method === 'POST' &&
      (env.BACKUP_R2_CUTOVER === '1' ||
       request.headers.get('x-orion-backup-canary') === '1');
    if (backupMigration) {
      // No Cloud Run fallback after a backup starts. The first operation could
      // have already uploaded a complete snapshot to private R2.
      const fail = () => withSecurityHeaders(new Response(JSON.stringify({
        message: 'Backup outcome unknown. Check the private R2 manifest.'
      }), { status: 503, headers: {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'
      } }));
      let result;
      try {
        if (!env.BANANABOOM_CORE) return fail();
        const headers = new Headers(request.headers);
        for (const key of ['host', 'x-forwarded-host', 'x-orion-edge-secret',
          'x-orion-backup-canary']) headers.delete(key);
        result = await env.BANANABOOM_CORE.fetch(new Request(request.url, {
          method: 'POST',
          headers,
          // No client-supplied body is ever necessary for a full database backup.
          redirect: 'manual'
        }));
      } catch (error) {
        console.error('database-backup-binding-failed', error?.name || 'Error');
        result = fail();
      }
      const response = withSecurityHeaders(result);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-bananaboom-origin', 'worker');
      const origin = corsOrigin(request);
      if (origin) {
        response.headers.set('access-control-allow-origin', origin);
        response.headers.set('access-control-allow-credentials', 'true');
        response.headers.append('vary', 'Origin');
      }
      return response;
    }

    if (isRetiredOrionFeature(pathname)) {
      const response = withSecurityHeaders(new Response(JSON.stringify({
        message: 'This legacy chat or billing endpoint has been retired.'
      }), {
        status: 410,
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
    const profileRead = isAuthenticatedProfileCandidate(
      request.method, pathname, incomingUrl.search, request.headers,
      String(env.PROFILE_READ_CUTOVER || '0') === '1');
    const todoRead = isTodoListReadCandidate(
      request.method, pathname, incomingUrl.search, request.headers,
      String(env.TODO_READ_CUTOVER || '0') === '1');
    const footprintRead = isFootprintReadCandidate(
      request.method, pathname, incomingUrl.search, request.headers,
      String(env.FOOTPRINT_READ_CUTOVER || '0') === '1');
    const footprintDetailCutover = String(env.FOOTPRINT_DETAIL_CUTOVER || '0') === '1';
    const footprintDetailRead = isFootprintDetailCandidate(
      request.method, pathname, incomingUrl.search, request.headers, footprintDetailCutover);
    if (footprintDetailCutover && ['GET', 'HEAD'].includes(request.method) &&
        pathname.startsWith('/api/footprints/') && !footprintDetailRead) {
      // Reject legacy Google-only, invalid, or absent credentials rather
      // than let an alternate URL/auth form bypass the owner scope.
      return footprintDetailFailure(request, 401);
    }
    const routeToCore = likeWrite || articleWrite || profileRead || todoRead || footprintRead || footprintDetailRead
      ? true : pathname === '/api/posts/private/posts'
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
        workerHeaders.delete('x-orion-profile-canary');
        workerHeaders.delete('x-orion-todo-read-canary');
        workerHeaders.delete('x-orion-footprint-read-canary');
        workerHeaders.delete('x-orion-footprint-detail-canary');
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
          // Browser profile verification requires the origin marker to be
          // readable from samyao.me (a separate origin from api.samyao.me).
          secured.headers.set('access-control-expose-headers', 'x-bananaboom-origin');
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
        if (footprintDetailRead) {
          console.error('Footprint detail owner validation failed; no Cloud Run fallback');
          return footprintDetailFailure(request);
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
        if (footprintDetailRead) {
          console.error('Footprint detail Core error; no Cloud Run fallback', error?.name || 'Error');
          return footprintDetailFailure(request);
        }
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

    if (footprintDetailRead) return footprintDetailFailure(request); // Fail closed without core.
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
    headers.delete('x-orion-profile-canary');
    headers.delete('x-orion-footprint-read-canary');
    headers.delete('x-orion-footprint-detail-canary');
    headers.delete('x-orion-pdf-canary');

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
