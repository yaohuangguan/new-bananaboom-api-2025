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
  return app;
}
