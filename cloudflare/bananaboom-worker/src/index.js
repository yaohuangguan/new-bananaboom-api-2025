import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app.js';
import { repository } from './db.js';
import { handleBrainMcpRequest } from './brainMcp.js';
import { handleBrainOAuthToken } from './brainOAuthHttp.js';

const app = createApp();
await app.ready();
export { MongoDBConnection } from './MongoDBConnection.js';

// Preserve the Node HTTP bridge while enabling a Cloudflare-native Cron Trigger.
// No scheduled task can be initiated by an external HTTP request.
const nodeHandler = httpServerHandler(createServer(app.callback()));
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/token') {
      return handleBrainOAuthToken(request,repository);
    }
    // Official MCP SDK Web Standards transport; no Express/Node HTTP
    // bridge or new session IDs are needed in the read-only canary.
    if (new URL(request.url).pathname === '/api/brain/sync/mcp') {
      const origins=String(env.BRAIN_ALLOWED_ORIGINS || '').split(',').map(x=>x.trim()).filter(Boolean);
      return handleBrainMcpRequest(request,repository,{
        allowedOrigins:origins,
        enableWriteCanary:env.BRAIN_MCP_WRITE_CANARY === '1' &&
          request.headers.get('x-orion-brain-write-canary') === '1'
      });
    }
    return nodeHandler.fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    // A destination can come from the already configured sam super_admin
    // profile; no extra global Bark secret is required.
    const id = env.MONGODB_CONNECTION.idFromName('bananaboom-mongo');
    const result = await env.MONGODB_CONNECTION.get(id, { locationHint: 'enam' })
      .dispatchBarkOutbox();
    if (result.claimed) console.log('post-outbox-dispatched', result.sent, 'of', result.claimed);
    // Legacy GCP Todo Scheduler is PAUSED: opt-in only, no overdue replay.
    if (env.TODO_REMINDERS_ENABLED === '1') {
      const todo = await env.MONGODB_CONNECTION.get(id, { locationHint: 'enam' })
        .dispatchTodoReminders();
      if (todo.claimed) console.log('todo-reminders', todo.completed, 'of', todo.claimed);
    }
  }
};
