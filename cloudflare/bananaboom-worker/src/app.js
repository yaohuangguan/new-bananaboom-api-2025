import openmesh from 'openmesh-node';
import { jsonBody } from 'openmesh-node/plugins';
import { repository as mongoRepository } from './db.js';
import { hydrateR2References } from '../../../utils/r2Reference.js';
import { authenticateLegacyRequest, canReadPrivatePosts, extractLegacyToken, hasPermission } from './auth.js';
import { normalizePostInput, redactPostWriteError } from './postWrites.js';

// Match legacy JSON serialization before applying its response hydration middleware.
// Otherwise recursively traversing BSON ObjectId/Date would erase their values.
const asLegacyJson = (value) => hydrateR2References(JSON.parse(JSON.stringify(value)));

// Only explicitly migrated public read paths. All other routes remain on Cloud Run.
async function runtimeJwtSecret() {
  const { env } = await import('cloudflare:workers');
  return { legacy: env.SECRET_JWT, next: env.ORION_JWT_NEXT_SECRET };
}

function listOptions(query) {
  const first = (value) => Array.isArray(value) ? value[0] : value;
  const parsedNumber = (value, fallback, max) => {
    const n = parseInt(first(value), 10);
    return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  return {
    page: parsedNumber(query.page, 1, 1000),
    limit: parsedNumber(query.limit, 10, 50),
    q: first(query.q) || undefined,
    tag: first(query.tag) || undefined
  };
}

export function createApp(repository = mongoRepository, options = {}) {
  const secretProvider = options.secretProvider || runtimeJwtSecret;
  const app = openmesh({ service: 'bananaboom-core' });
  app.use(jsonBody({ limit: 2 * 1024 * 1024 }));
  app.get('/health', () => 'OK');
  app.get('/', () => 'API Server is running...');
  app.get('/api/homepage', async () => asLegacyJson(await repository.homepages()));
  app.get('/api/homepage/likes', async () => asLegacyJson(await repository.likes()));
  app.get('/api/homepage/projects', (ctx) => {
    ctx.set('Cache-Control', 'public, max-age=3600');
    return repository.projects().then(asLegacyJson);
  });
  app.get('/api/homepage/logs', (ctx) => {
    ctx.set('Cache-Control', 'public, max-age=3600');
    return repository.logs().then(asLegacyJson);
  });
  app.get('/api/projects', async () => asLegacyJson(await repository.publicProjects()));
  app.get('/api/menu', async (ctx) => {
    const category = ctx.query.category;
    if ((Array.isArray(category)) || (typeof category === 'string' && category.length > 100)) {
      ctx.status = 400;
      return { error: 'Invalid category' };
    }
    try {
      return asLegacyJson(await repository.publicMenu({ category: category || undefined }));
    } catch (error) {
      console.error('menu-read-error-safe', error?.name || 'UnknownError',
        String(error?.message || '').replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[redacted-database-uri]').slice(0, 140));
      ctx.status = 503;
      return { error: 'Menu temporarily unavailable' };
    }
  });

  app.get('/api/tags', async () => asLegacyJson(await repository.publicTags()));
  app.get('/api/posts', async (ctx) => {
    const first = (value) => Array.isArray(value) ? value[0] : value;
    const parsedNumber = (value, fallback) => {
      const n = parseInt(first(value), 10);
      return Number.isSafeInteger(n) && n > 0 ? n : fallback;
    };
    const page = Math.min(parsedNumber(ctx.query.page, 1), 1000);
    const limit = Math.min(parsedNumber(ctx.query.limit, 10), 50);
    const q = first(ctx.query.q);
    const tag = first(ctx.query.tag);
    if ((q && q.length > 100) || (tag && tag.length > 100)) {
      ctx.status = 400;
      return { error: 'Search query is too long' };
    }
    return asLegacyJson(await repository.publicPosts({
      page,
      limit,
      q: q || undefined,
      tag: tag || undefined
    }));
  });
  app.get('/api/posts/likes/:id', async (ctx) => {
    const id = ctx.params.id;
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      ctx.status = 404;
      return { message: 'Post not found' };
    }
    ctx.set('Cache-Control', 'no-store');
    return asLegacyJson(await repository.publicPostLikes(id));
  });

  // Only the exact add/remove paths are ever exposed through the Gateway.
  // On failure the Gateway MUST NOT replay the mutation on Cloud Run.
  for (const direction of ['add', 'remove']) {
    app.post('/api/posts/likes/:id/' + direction, async (ctx) => {
      const id = ctx.params.id;
      if (!/^[a-f0-9]{24}$/i.test(id)) {
        ctx.status = 404;
        return { message: 'Post not found' };
      }
      ctx.set('Cache-Control', 'no-store');
      try {
        return asLegacyJson(await repository.changePostLikes(id, direction));
      } catch (error) {
        console.error('post-like-mutation-error', error?.name || 'UnknownError');
        ctx.status = 503;
        return { error: 'Like operation status unknown; refresh the count before retrying' };
      }
    });
  }

  // Public details are readable without a session. Private details are
  // intentionally indistinguishable from missing posts without live RBAC.
  app.get('/api/posts/:id', async (ctx) => {
    const notFound = () => {
      ctx.status = 404;
      return { message: 'Post not found' };
    };
    const id = ctx.params.id;
    if (!/^[a-f0-9]{24}$/i.test(id)) return notFound();
    ctx.set('Cache-Control', 'no-store');

    const token = extractLegacyToken(ctx.headers);
    let auth = { kind: 'guest' };
    if (token) {
      try {
        auth = await authenticateLegacyRequest(ctx.headers, repository, await secretProvider());
      } catch (error) {
        console.error('post-detail-auth-failure', error?.name || 'UnknownError');
        ctx.status = 503; // Gateway falls back to authenticated Cloud Run.
        return { error: 'Article detail temporarily unavailable' };
      }
      if (auth.kind === 'invalid') {
        ctx.status = 401;
        return {
          msg: auth.code === 'AUTH_EXPIRED' ? 'Token expired' : 'Token invalid',
          code: auth.code
        };
      }
    }

    try {
      const publicPost = await repository.publicPostById(id);
      if (publicPost) return asLegacyJson(publicPost);
      if (auth.kind !== 'authenticated' || !canReadPrivatePosts(auth.user)) {
        return notFound();
      }
      const privatePost = await repository.privatePostById(id);
      return privatePost ? asLegacyJson(privatePost) : notFound();
    } catch (error) {
      console.error('post-detail-query-failure', error?.name || 'UnknownError');
      ctx.status = 503;
      return { error: 'Article detail temporarily unavailable' };
    }
  });

  // These methods are staged *only* in the private Core Worker. The Gateway
  // does NOT forward article CRUD: audit Socket.IO and Bark dispatch must be
  // complete and production-verified before accepting public mutations.
  const trustedWriteOrigins = new Set([
    'https://samyao.me',
    'https://www.samyao.me',
    'https://ps6.space',
    'https://www.ps6.space',
    'http://localhost:5173'
  ]);
  const writeAuth = async (ctx) => {
    if (!extractLegacyToken(ctx.headers)) {
      return { ok: false, status: 401, body: { message: 'Unauthorized' } };
    }
    const fromCookie = !ctx.headers['x-auth-token'] &&
      !(ctx.headers.authorization || '').startsWith('Bearer ');
    if (fromCookie && !trustedWriteOrigins.has(ctx.headers.origin)) {
      // Browser session cookies must not authorize cross-origin forged writes.
      return { ok: false, status: 403, body: { message: 'ORIGIN_REJECTED' } };
    }
    const auth = await authenticateLegacyRequest(ctx.headers, repository, await secretProvider());
    if (auth.kind === 'invalid') {
      return { ok: false, status: 401, body: { code: auth.code, message: 'Unauthorized' } };
    }
    if (auth.kind !== 'authenticated') {
      return { ok: false, status: 401, body: { message: 'Session expired or revoked' } };
    }
    if (!hasPermission(auth.user, 'BLOG:MANAGE')) {
      return { ok: false, status: 403, body: { code: 'PERMISSION_DENIED', required: 'BLOG:MANAGE' } };
    }
    return { ok: true, user: auth.user };
  };
  const respondWrite = async (ctx, action) => {
    ctx.set('Cache-Control', 'no-store');
    let authorized;
    try {
      authorized = await writeAuth(ctx);
    } catch (error) {
      console.error('post-crud-auth-failed', error?.name || 'UnknownError');
      ctx.status = 503;
      return { error: 'Authentication temporarily unavailable' };
    }
    if (!authorized.ok) {
      ctx.status = authorized.status;
      return authorized.body;
    }
    try {
      return await action(authorized.user);
    } catch (error) {
      const safe = redactPostWriteError(error);
      if (safe.status >= 500) console.error('post-crud-write-failed', error?.name || 'UnknownError');
      ctx.status = safe.status;
      return safe.body;
    }
  };
  const sourceIp = (ctx) => String(ctx.headers['cf-connecting-ip'] || '').slice(0, 128);
  app.post('/api/posts', async (ctx) => respondWrite(ctx, async (user) => {
    const input = normalizePostInput(ctx.requestBody, { create: true });
    const data = await repository.createArticle(input, user.id, sourceIp(ctx));
    ctx.status = 201;
    return { success: true, data: asLegacyJson(data) };
  }));
  app.put('/api/posts/:id', async (ctx) => respondWrite(ctx, async (user) => {
    const id = ctx.params.id;
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      ctx.status = 404;
      return { msg: '文章不存在' };
    }
    const input = normalizePostInput(ctx.requestBody);
    const data = await repository.updateArticle(id, input, user.id, sourceIp(ctx));
    if (!data) {
      ctx.status = 404;
      return { msg: '文章不存在' };
    }
    return { success: true, data: asLegacyJson(data) };
  }));
  app.delete('/api/posts/:id', async (ctx) => respondWrite(ctx, async (user) => {
    const id = ctx.params.id;
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      ctx.status = 404;
      return { message: 'Post not found' };
    }
    if (user.role !== 'super_admin') {
      ctx.status = 403;
      return { code: 'PERMISSION_DENIED', required: 'super_admin' };
    }
    const post = await repository.getArticleForDeletion(id);
    if (!post) {
      ctx.status = 404;
      return { message: 'Post not found' };
    }
    const deleted = await repository.deleteArticle(id, user.id, sourceIp(ctx), post.isPrivate);
    if (!deleted) {
      ctx.status = 404;
      return { message: 'Post not found' };
    }
    const options = listOptions(ctx.query);
    return asLegacyJson(post.isPrivate
      ? await repository.privatePosts(options)
      : await repository.publicPosts(options));
  }));

  // Worker CRUD outbox notifications are admin-only, even when the user
  // knows an event cursor. The Gateway forwards only legacy JWT carriers.
  app.get('/api/audit/worker-events', async (ctx) => {
    ctx.set('Cache-Control', 'private, no-store');
    const after = ctx.query.after;
    if (Array.isArray(after) || (after && !/^[a-f0-9]{24}$/i.test(after))) {
      ctx.status = 400;
      return { error: 'Invalid event cursor' };
    }
    if (!extractLegacyToken(ctx.headers)) {
      ctx.status = 401;
      return { message: 'Unauthorized' };
    }
    let auth;
    try {
      auth = await authenticateLegacyRequest(ctx.headers, repository, await secretProvider());
    } catch (error) {
      console.error('post-events-auth-failed', error?.name || 'UnknownError');
      ctx.status = 503;
      return { error: 'Notification feed temporarily unavailable' };
    }
    if (auth.kind !== 'authenticated') {
      ctx.status = 401;
      return { message: 'Unauthorized' };
    }
    if (!hasPermission(auth.user, 'SYSTEM_LOGS:USE')) {
      ctx.status = 403;
      return { message: 'Permission denied' };
    }
    try {
      const events = await repository.pollPostWriteEvents(after || null, 30);
      return { events, cursor: events.length ? events.at(-1).id : after || null };
    } catch (error) {
      console.error('post-events-query-failed', error?.name || 'UnknownError');
      ctx.status = 503;
      return { error: 'Notification feed temporarily unavailable' };
    }
  });

  // Authenticated private read is deliberately NOT in the Gateway allowlist.
  // Until real-user parity is checked, the existing Cloud Run endpoint remains live.
  app.get('/api/posts/private/posts', async (ctx) => {
    ctx.set('Cache-Control', 'no-store');
    if (!extractLegacyToken(ctx.headers)) {
      ctx.status = 401;
      return {
        success: false,
        message: 'Unauthorized: Please login first',
        message_cn: '请先登录'
      };
    }
    let auth;
    try {
      auth = await authenticateLegacyRequest(ctx.headers, repository, await secretProvider());
    } catch (error) {
      // Do not log credential values, MongoDB query details, or document contents.
      console.error('private-read-canary-auth-failure', error?.name || 'UnknownError');
      ctx.set('x-orion-private-worker-stage', 'auth');
      ctx.status = 503; // The Gateway can safely use the existing Cloud Run fallback.
      return { error: 'Private read temporarily unavailable' };
    }
    if (auth.kind === 'invalid') {
      ctx.status = 401;
      return { msg: auth.code === 'AUTH_EXPIRED' ? 'Token expired' : 'Token invalid', code: auth.code };
    }
    if (auth.kind !== 'authenticated') {
      ctx.status = 401;
      return {
        success: false,
        message: 'Unauthorized: Please login first',
        message_cn: '请先登录'
      };
    }
    if (!canReadPrivatePosts(auth.user)) {
      ctx.status = 403;
      return {
        success: false,
        message: 'Access Denied: You do not have permission',
        message_cn: '权限不足：您没有操作该功能的权限',
        code: 'PERMISSION_DENIED',
        required: 'PRIVATE_POST:READ'
      };
    }
    const parameters = listOptions(ctx.query);
    if ((parameters.q?.length || 0) > 100 || (parameters.tag?.length || 0) > 100) {
      ctx.status = 400;
      return { error: 'Search query is too long' };
    }
    try {
      return asLegacyJson(await repository.privatePosts(parameters));
    } catch (error) {
      console.error('private-read-canary-query-failure', error?.name || 'UnknownError');
      ctx.set('x-orion-private-worker-stage', 'query');
      ctx.status = 503;
      return { error: 'Private read temporarily unavailable' };
    }
  });

  return app;
}
