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

const AUTH_PREFIXES = ['/api/auth', '/api/users'];

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

  if (isExpensive(pathname)) {
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

export default {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    const pathname = incomingUrl.pathname;

    if (request.method === 'OPTIONS') {
      return withSecurityHeaders(preflightResponse(request));
    }

    const limited = await enforceRateLimit(request, env, pathname);
    if (limited) return withSecurityHeaders(limited);

    const originUrl = new URL(pathname + incomingUrl.search, env.ORIGIN_URL);
    const headers = new Headers(request.headers);
    headers.set('x-orion-edge', 'cloudflare');

    if (env.ORIGIN_EDGE_SECRET) {
      headers.set('x-orion-edge-secret', env.ORIGIN_EDGE_SECRET);
    }

    // Do not let clients choose the upstream host or spoof edge-only metadata.
    headers.delete('host');
    headers.delete('x-forwarded-host');

    const ttl = cacheTtlFor(request, pathname);
    const upstreamRequest = new Request(originUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
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

    if (ttl > 0) {
      secured.headers.delete('set-cookie');
      secured.headers.set('cache-control', `public, max-age=0, s-maxage=${ttl}`);
    } else {
      secured.headers.set('cache-control', 'no-store');
    }

    return secured;
  }
};
