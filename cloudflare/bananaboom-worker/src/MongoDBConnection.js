import { DurableObject } from 'cloudflare:workers';
import { MongoClient, ObjectId } from 'mongodb';
import { withProjectDefaults } from './projectDefaults.js';
import { deliverBarkOutbox } from './postOutbox.js';

/**
 * A single Durable Object owns the MongoDB connection.
 * The public Worker can never obtain the client or submit an arbitrary query.
 * RPC methods are limited to public read-only endpoints with fixed queries.
 */
export class MongoDBConnection extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.barkUrl = env.BARK_URL;
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

  async pollPostWriteEvents(after, max = 30) {
    // The OpenMesh handler MUST verify the current SYSTEM_LOGS:USE permission.
    // No HTTP route exposes this Durable Object RPC directly.
    await this.client.connect();
    const cutoff = after
      ? new ObjectId(after)
      : ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 10);
    const db = this.client.db();
    const events = await db.collection('post_write_outbox').find({
      _id: { $gt: cutoff }
    }, {
      projection: {
        _id: 1, auditLogId: 1, operator: 1, operatorName: 1,
        action: 1, target: 1, createdAt: 1
      }
    }).sort({ _id: 1 }).limit(Math.min(50, Math.max(1, max))).toArray();
    const operators = [...new Set(events.map((event) => String(event.operator)))];
    const names = new Map();
    if (operators.length > 0) {
      const users = await db.collection('users').find({
        _id: { $in: operators.map((id) => new ObjectId(id)) }
      }, { projection: { displayName: 1, name: 1 } }).toArray();
      for (const u of users) names.set(String(u._id), u.displayName || u.name || String(u._id));
    }
    return events.map((event) => {
      const operatorId = String(event.operator);
      const operatorName = event.operatorName || names.get(operatorId) || operatorId;
      return {
        id: String(event._id),
        timestamp: event.createdAt?.toISOString() || new Date().toISOString(),
        message: `[${operatorName}] 执行了 [${event.action}] - ${event.target || ''}`,
        log: {
          _id: String(event.auditLogId),
          action: event.action,
          target: event.target || '',
          createdDate: event.createdAt?.toISOString() || new Date().toISOString(),
          operator: { _id: operatorId, displayName: operatorName }
        }
      };
    });
  }

  async dispatchBarkOutbox() {
    // This is invoked ONLY by the private Worker scheduled handler, not HTTP.
    if (!this.barkUrl) return { claimed: 0, sent: 0, deferred: 'bark-not-configured' };
    await this.client.connect();
    return deliverBarkOutbox(this.client.db().collection('post_write_outbox'), {
      barkUrl: this.barkUrl
    });
  }

  async #auditPostWrite(operatorId, action, target, ip, postId) {
    // Legacy AuditLog's collection name and TTL field are preserved.
    // Best-effort audit is deliberately separate from the user write, matching
    // the old logOperation() contract which never changes a successful response.
    try {
      const db = this.client.db();
      const createdDate = new Date();
      const author = await db.collection('users').findOne(
        { _id: new ObjectId(operatorId) }, { projection: { displayName: 1, name: 1 } }
      );
      const operatorName = author?.displayName || author?.name || operatorId;
      const result = await db.collection('audit_logs').insertOne({
        operator: new ObjectId(operatorId),
        action,
        target,
        ip: String(ip || '').slice(0, 128),
        createdDate
      });
      // Durable notification outbox: Socket.IO / Bark fan-out is not yet
      // migrated; do NOT enable CRUD traffic before dispatch is implemented.
      await db.collection('post_write_outbox').insertOne({
        auditLogId: result.insertedId,
        postId: new ObjectId(postId),
        operator: new ObjectId(operatorId),
        operatorName,
        action,
        target,
        createdAt: createdDate,
        attempts: 0,
        dispatchedAt: null
      });
    } catch (error) {
      console.error('post-audit-write-failed', error?.name || 'UnknownError');
    }
  }

  async createArticle(input, operatorId, ip) {
    await this.client.connect();
    const db = this.client.db();
    const now = new Date();
    const result = {
      ...input,
      user: new ObjectId(operatorId),
      likes: 0,
      comments: [],
      tags: input.tags || [],
      isPrivate: input.isPrivate ?? false,
      createdAt: now,
      updatedAt: now,
      __v: 0
    };
    const inserted = await db.collection('posts').insertOne(result);
    result._id = inserted.insertedId;
    await this.#auditPostWrite(operatorId, 'CREATE_POST', result.name, ip, String(result._id));
    return JSON.parse(JSON.stringify(result));
  }

  async updateArticle(id, input, operatorId, ip) {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    await this.client.connect();
    const db = this.client.db();
    // Mongoose's timestamps:true on findByIdAndUpdate always refreshes updatedAt.
    const updated = await db.collection('posts').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after', includeResultMetadata: true }
    );
    const result = updated?.value;
    if (!result) return null;
    await this.#auditPostWrite(operatorId, 'UPDATE_POST', result.name, ip, id);
    return JSON.parse(JSON.stringify(result));
  }

  async getArticleForDeletion(id) {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    await this.client.connect();
    const post = await this.client.db().collection('posts').findOne(
      { _id: new ObjectId(id) },
      { projection: { _id: 1, name: 1, isPrivate: 1 } }
    );
    return post ? JSON.parse(JSON.stringify(post)) : null;
  }

  async deleteArticle(id, operatorId, ip, expectedPrivate) {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    await this.client.connect();
    const db = this.client.db();
    const post = await db.collection('posts').findOneAndDelete({
      _id: new ObjectId(id),
      isPrivate: expectedPrivate ? true : { $ne: true }
    });
    if (!post) return null;
    await this.#auditPostWrite(operatorId, 'DELETE_POST', post.name, ip, id);
    return JSON.parse(JSON.stringify({ _id: post._id, isPrivate: !!post.isPrivate, name: post.name }));
  }

  async changePostLikes(id, direction) {
    // Match legacy Mongoose updates: atomic $inc and no updatedAt modification.
    // An absent post returns null; likes cannot be decremented below zero.
    if (!/^[a-f0-9]{24}$/i.test(id) || !['add', 'remove'].includes(direction)) {
      return null;
    }
    await this.client.connect();
    const posts = this.client.db().collection('posts');
    const objectId = new ObjectId(id);
    const filter = direction === 'remove'
      ? { _id: objectId, likes: { $gt: 0 } }
      : { _id: objectId };
    await posts.updateOne(filter, { $inc: { likes: direction === 'add' ? 1 : -1 } });
    const post = await posts.findOne({ _id: objectId }, { projection: { likes: 1 } });
    return post ? JSON.parse(JSON.stringify(post)) : null;
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

  async privatePostById(id) {
    // Called only AFTER the OpenMesh route has checked the live session and
    // PRIVATE_POST:READ permission. Always constrain the DB query to private.
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    await this.client.connect();
    const db = this.client.db();
    const post = await db.collection('posts').findOne({
      _id: new ObjectId(id),
      isPrivate: true
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
