import openmesh from 'openmesh-node';
import { repository as mongoRepository } from './db.js';
import { hydrateR2References } from '../../../utils/r2Reference.js';

// Match legacy JSON serialization before applying its response hydration middleware.
// Otherwise recursively traversing BSON ObjectId/Date would erase their values.
const asLegacyJson = (value) => hydrateR2References(JSON.parse(JSON.stringify(value)));

// Only explicitly migrated public read paths. All other routes remain on Cloud Run.
export function createApp(repository = mongoRepository) {
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
  return app;
}
