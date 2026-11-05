import { DurableObject } from 'cloudflare:workers';
import { MongoClient } from 'mongodb';
import { withProjectDefaults } from './projectDefaults.js';

/**
 * A single Durable Object owns the MongoDB connection.
 * The public Worker can never obtain the client or submit an arbitrary query.
 * RPC methods are limited to public read-only endpoints with fixed queries.
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

  async publicProjects() {
    const rows = await this.#read('projects', {
      filter: { isVisible: true },
      sort: { order: -1, createdAt: -1 }
    });
    return rows.map(withProjectDefaults);
  }

  async publicTags() {
    await this.client.connect();
    const tags = await this.client.db().collection('posts').aggregate([
      { $match: { isPrivate: false } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $project: { _id: 0, name: '$_id', count: 1 } }
    ]).toArray();
    return JSON.parse(JSON.stringify(tags));
  }

  async publicPosts({ page, limit, q, tag }) {
    await this.client.connect();
    const db = this.client.db();
    const query = { isPrivate: false };
    if (q) query.$or = [
      { name: { $regex: q, $options: 'i' } },
      { content: { $regex: q, $options: 'i' } }
    ];
    if (tag) query.tags = tag;
    const [posts, total] = await Promise.all([
      db.collection('posts').find(query)
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      db.collection('posts').countDocuments(query)
    ]);
    const userIds = posts.filter((post) => post.user).map((post) => post.user);
    const users = userIds.length
      ? await db.collection('users').find(
          { _id: { $in: userIds } },
          { projection: { password: 0, barkUrl: 0 } }
        ).toArray()
      : [];
    const byId = new Map(users.map((user) => [String(user._id), user]));
    for (const post of posts) {
      if (post.user) post.user = byId.get(String(post.user)) ?? null;
    }
    return JSON.parse(JSON.stringify({
      data: posts,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalPosts: total,
        perPage: limit
      }
    }));
  }

}
