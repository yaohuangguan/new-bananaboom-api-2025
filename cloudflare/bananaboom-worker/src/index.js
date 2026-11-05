import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app.js';

const app = createApp();
await app.ready();
export { MongoDBConnection } from './MongoDBConnection.js';

// Preserve the Node HTTP bridge while enabling a Cloudflare-native Cron Trigger.
// No scheduled task can be initiated by an external HTTP request.
const nodeHandler = httpServerHandler(createServer(app.callback()));
export default {
  fetch(request, env, ctx) {
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
