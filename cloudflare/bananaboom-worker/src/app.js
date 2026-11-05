import openmesh from 'openmesh-node';
import { repository as mongoRepository } from './db.js';
import { hydrateR2References } from '../../../utils/r2Reference.js';
import { authenticateLegacyRequest, canReadPrivatePosts, extractLegacyToken } from './auth.js';

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

  // The Gateway routes here only if no legacy login credential was supplied.
  // The database query itself requires isPrivate=false, regardless of route.
  app.get('/api/posts/:id', async (ctx) => {
    const id = ctx.params.id;
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      ctx.status = 404;
      return { message: 'Post not found' };
    }
    const post = await repository.publicPostById(id);
    if (!post) {
      ctx.status = 404;
      return { message: 'Post not found' };
    }
    ctx.set('Cache-Control', 'no-store');
    return asLegacyJson(post);
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
