import {createHash} from 'node:crypto';
import {ObjectId} from 'mongodb';
import {normalizePublicComments} from './commentReads.js';

const ID = /^[a-f0-9]{24}$/i;
const KEY = /^[A-Za-z0-9:_-]{8,128}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

export class CommentMutationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'CommentMutationError';
    this.status = status;
  }
}
const fail = (code, status = 400) => { throw new CommentMutationError(code, status); };

export function parseCommentMutation(raw) {
  if (!isObject(raw)) fail('INVALID_COMMENT_REQUEST');
  const {operation, id, key, body} = raw;
  if (!['create', 'reply'].includes(operation)) fail('INVALID_COMMENT_OPERATION');
  if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_COMMENT_ID');
  if (typeof key !== 'string' || !KEY.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED', 428);
  if (!isObject(body) || Object.keys(body).some(k => ![
    'content', 'comment', 'reply', 'targetUser'
  ].includes(k))) fail('INVALID_COMMENT_INPUT');
  const candidate = operation === 'reply' ? (body.reply || body.content)
    : (body.content || body.comment);
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 4000) {
    fail('INVALID_COMMENT_INPUT');
  }
  const targetUser = body.targetUser;
  if (operation === 'create' && targetUser !== undefined) fail('INVALID_COMMENT_INPUT');
  if (targetUser !== undefined && targetUser !== null &&
      (typeof targetUser !== 'string' || !ID.test(targetUser))) {
    fail('INVALID_COMMENT_INPUT');
  }
  return {operation, id: id.toLowerCase(), key, content: candidate,
    targetUser: targetUser == null ? null : targetUser.toLowerCase()};
}

// Authorization is independently checked inside the same transaction as
// the insert/update and receipt. An authenticated JWT alone is not sufficient.
async function currentOwner(db, session, caller, token) {
  if (!ID.test(caller?.id || '') || typeof token !== 'string' || !token) {
    fail('UNAUTHORIZED', 401);
  }
  const cutoff = new Date(Date.now() - 30 * 86400_000);
  const record = await db.collection('sessions').findOne({
    key: 'auth:' + token, createdAt: {$gt: cutoff}
  }, {session, projection: {value: 1}});
  if (record?.value !== caller.id) fail('UNAUTHORIZED', 401);
  const user = await db.collection('users').findOne(
    {_id: new ObjectId(caller.id)}, {session, projection: {
      _id: 1, displayName: 1, photoURL: 1, role: 1
    }}
  );
  if (!user) fail('UNAUTHORIZED', 401);
  return user;
}

async function normalizeInSession(db, session, comment) {
  const ids = new Set();
  if (comment.user && ID.test(String(comment.user))) ids.add(String(comment.user));
  for (const reply of comment.reply || []) {
    if (reply.user && ID.test(String(reply.user))) ids.add(String(reply.user));
  }
  const users = ids.size ? await db.collection('users').find({
    _id: {$in: [...ids].map(id => new ObjectId(id))}
  }, {session, projection: {_id: 1, displayName: 1, photoURL: 1, role: 1}}).toArray() : [];
  return json(normalizePublicComments([comment], users));
}

export async function mutateComment({client, db}, caller, token, raw) {
  const input = parseCommentMutation(raw);
  const receiptId = 'comment:' + hash([caller?.id, input.operation, input.key].join(':'));
  const contentHash = hash(JSON.stringify({
    operation: input.operation, id: input.id,
    content: input.content, targetUser: input.targetUser
  }));
  const receipts = db.collection('comment_mutation_receipts');
  const session = client.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      const owner = await currentOwner(db, session, caller, token);
      const previous = await receipts.findOne({_id: receiptId}, {session});
      if (previous) {
        if (previous.contentHash !== contentHash) fail('IDEMPOTENCY_CONFLICT', 409);
        response = previous.response;
        return;
      }
      const comments = db.collection('comments');
      const now = new Date();
      let record;
      if (input.operation === 'create') {
        record = {
          _id: new ObjectId(), user: owner._id, post: new ObjectId(input.id),
          content: input.content, reply: [], date: now, __v: 0
        };
        await comments.insertOne(record, {session});
      } else {
        const reply = {
          _id: new ObjectId(), user: owner._id,
          ...(input.targetUser ? {targetUser: new ObjectId(input.targetUser)} : {}),
          content: input.content, date: now
        };
        record = await comments.findOneAndUpdate(
          {_id: new ObjectId(input.id)},
          {$push: {reply}, $inc: {__v: 1}},
          {session, returnDocument: 'after'}
        );
        if (!record) fail('COMMENT_NOT_FOUND', 404);
      }

      const normalized = await normalizeInSession(db, session, record);
      response = input.operation === 'create' ? normalized[0] : normalized;
      await db.collection('audit_logs').insertOne({
        operator: owner._id,
        action: input.operation === 'create' ? 'CREATE_COMMENT' : 'REPLY_COMMENT',
        target: (input.operation === 'create' ? '文章ID: ' : '评论ID: ') + input.id,
        details: {operation: input.operation},
        createdDate: now
      }, {session});
      await receipts.insertOne({
        _id: receiptId, ownerId: owner._id, operation: input.operation,
        contentHash, response, createdAt: now
      }, {session});
    }, {
      readConcern: {level: 'snapshot'},
      writeConcern: {w: 'majority'},
      maxCommitTimeMS: 25000
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Parallel requests with identical keys may race; always recheck the
    // current session before returning the winning receipt.
    const recheck = client.startSession();
    try {
      await recheck.withTransaction(async () => {
        await currentOwner(db, recheck, caller, token);
        const winner = await receipts.findOne({_id: receiptId}, {session: recheck});
        if (!winner) throw error;
        if (winner.contentHash !== contentHash) fail('IDEMPOTENCY_CONFLICT', 409);
        response = winner.response;
      }, {readConcern: {level: 'snapshot'}});
    } finally { await recheck.endSession(); }
  } finally { await session.endSession(); }
  return response;
}
