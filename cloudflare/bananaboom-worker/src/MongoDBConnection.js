import { DurableObject } from 'cloudflare:workers';
import { MongoClient, ObjectId } from 'mongodb';
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

  async authorizeSession(token) {
    // MongoDB TTL is eventually consistent. Reject sessions older than 30 days
    // even if the background TTL cleanup has not removed them yet.
    await this.client.connect();
    const db = this.client.db();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const session = await db.collection('sessions').findOne({
      key: `auth:${token}`,
      createdAt: { $gt: cutoff }
    }, { projection: { value: 1 } });
    if (!session || typeof session.value !== 'string' || !/^[a-f0-9]{24}$/i.test(session.value)) {
      return null;
    }
    const user = await db.collection('users').findOne(
      { _id: new ObjectId(session.value) },
      { projection: { role: 1, extraPermissions: 1 } }
    );
    if (!user) return null;
    const role = await db.collection('roles').findOne(
      { name: user.role || 'user' }, { projection: { permissions: 1 } }
    );
    return {
      id: String(user._id),
      role: user.role || 'user',
      permissions: [...new Set([
        ...(Array.isArray(role?.permissions) ? role.permissions : []),
        ...(Array.isArray(user.extraPermissions) ? user.extraPermissions : [])
      ])]
    };
  }

  async publicPostLikes(id) {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    await this.client.connect();
    const post = await this.client.db().collection('posts').findOne(
      { _id: new ObjectId(id), isPrivate: false },
      { projection: { likes: 1 } }
    );
    if (!post) return null;
    return JSON.parse(JSON.stringify(post));
  }

  async publicPostById(id) {
    // A public detail response must never fetch a private post by ID.
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    await this.client.connect();
    const db = this.client.db();
    const post = await db.collection('posts').findOne({
      _id: new ObjectId(id),
      isPrivate: false
    });
    if (!post) return null;
    if (post.user) {
      const user = await db.collection('users').findOne(
        { _id: post.user },
        { projection: { _id: 1, displayName: 1, photoURL: 1 } }
      );
      post.user = user || null;
    }
    return JSON.parse(JSON.stringify(post));
  }

  async privatePosts(options) {
    // This method is accessible only through the internal Durable Object
    // binding. The OpenMesh route must verify JWT, session, and live RBAC.
    await this.client.connect();
    const db = this.client.db();
    const query = { isPrivate: true };
    if (options.q) query.$or = [
      { name: { $regex: options.q, $options: 'i' } },
      { content: { $regex: options.q, $options: 'i' } }
    ];
    if (options.tag) query.tags = options.tag;
    const [posts, total] = await Promise.all([
      db.collection('posts').find(query).sort({ createdAt: -1 })
        .skip((options.page - 1) * options.limit).limit(options.limit).toArray(),
      db.collection('posts').countDocuments(query)
    ]);
    const ids = posts.filter((post) => post.user).map((post) => post.user);
    const users = ids.length
      ? await db.collection('users').find(
          { _id: { $in: ids } },
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
        currentPage: options.page,
        totalPages: Math.ceil(total / options.limit),
        totalPosts: total,
        perPage: options.limit
      }
    }));
  }

  publicMenu({ category } = {}) {
    const filter = { isActive: true };
    if (category) filter.category = category;
    return this.#read('menus', { filter, sort: { createdAt: -1 } });
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
          { projection: { _id: 1, displayName: 1, photoURL: 1 } }
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
