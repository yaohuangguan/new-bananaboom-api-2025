import { DurableObject } from 'cloudflare:workers';
import { MongoClient } from 'mongodb';

/**
 * A single Durable Object owns the MongoDB connection.
 * The public Worker can never obtain the client or submit an arbitrary query.
 * RPC methods are limited to the four existing public read-only endpoints.
 */
export class MongoDBConnection extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.client = new MongoClient(env.MONGO_URI, {
      maxPoolSize: 1,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      maxIdleTimeMS: 20000
    });
  }

  async #read(collection, options = {}) {
    await this.client.connect();
    let cursor = this.client.db().collection(collection).find(options.filter || {}, {
      projection: options.projection
    });
    if (options.sort) cursor = cursor.sort(options.sort);
    // RPC returns structured-clonable plain values; preserve BSON JSON semantics.
    return JSON.parse(JSON.stringify(await cursor.toArray()));
  }

  homepages() {
    return this.#read('homepages');
  }

  likes() {
    return this.#read('homepages', { projection: { likes: 1 } });
  }

  projects() {
    return this.#read('projects');
  }

  logs() {
    return this.#read('logs', { sort: { version: 1 } });
  }
}
