import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import {
  requireMutationKey, mutationFingerprint, performArticleTransaction,
  IdempotencyKeyError, IdempotencyConflictError
} from '../src/articleTransaction.js';
import { redactPostWriteError } from '../src/postWrites.js';

test('receipt key validation and canonical payload hash reject key collisions', () => {
  assert.equal(requireMutationKey('12345678-1234-4abc-8888-123456789aaa'),
    '12345678-1234-4abc-8888-123456789aaa');
  assert.throws(() => requireMutationKey('123'), IdempotencyKeyError);
  assert.throws(() => requireMutationKey('a'.repeat(129)), IdempotencyKeyError);
  assert.throws(() => requireMutationKey('key with spaces 123456'), IdempotencyKeyError);
  const first = mutationFingerprint({ action: 'CREATE_POST', input: {
    a: { k: 1, b: 2 }, z: [1, 2]
  } });
  assert.equal(first, mutationFingerprint({ action: 'CREATE_POST',
    input: { z: [1, 2], a: { b: 2, k: 1 } }
  }));
  assert.notEqual(first, mutationFingerprint({ action: 'UPDATE_POST',
    input: { z: [1, 2], a: { b: 2, k: 1 } }
  }));
  assert.notEqual(first, mutationFingerprint({ action: 'CREATE_POST',
    input: { z: [1, 3], a: { b: 2, k: 1 } }
  }));
  assert.equal(redactPostWriteError(new IdempotencyConflictError()).status, 409);
  assert.equal(redactPostWriteError(new IdempotencyKeyError()).status, 428);
});

test('transaction receipt recovers acknowledged write and hides conflicting requests', async () => {
  const id = new ObjectId().toHexString();
  const key = randomUUID();
  const doc = { _id: id + ':' + key, fingerprint: mutationFingerprint({
    action: 'CREATE_POST', input: { name: 'First' }
  }), result: { _id: 'test-post' }, completedAt: new Date() };
  const db = { collection: () => ({ findOne: async () => doc }) };
  const client = { withSession: () => {
    throw new Error('Committed receipt must not start another transaction');
  } };
  assert.deepEqual(await performArticleTransaction({
    client, db, operatorId: id, idempotencyKey: key,
    action: 'CREATE_POST', input: { name: 'First' },
    mutate: () => { throw new Error('must not replay'); }
  }), { _id: 'test-post' });
  await assert.rejects(performArticleTransaction({
    client, db, operatorId: id, idempotencyKey: key,
    action: 'CREATE_POST', input: { name: 'Different' },
    mutate: () => {}
  }), IdempotencyConflictError);
});

test('MongoDB replica set: commit, replay, conflict, update, delete, and audit rollback in isolated database', {
  skip: !process.env.MONGO_URI
}, async () => {
  const client = new MongoClient(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 8000
  });
  const dbName = 'orion_atomic_proof_' + randomUUID().replaceAll('-', '');
  const db = client.db(dbName);
  const actor = new ObjectId();
  const createKey = randomUUID();
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'requires transactional MongoDB');
    await db.collection('users').insertOne({ _id: actor, displayName: 'Test operator' });
    const input = { name: 'Transactional proof', info: 'Temporary' };
    const create = () => performArticleTransaction({
      client, db, operatorId: actor.toHexString(),
      idempotencyKey: createKey, action: 'CREATE_POST', input,
      mutate: async ({ session }) => {
        const post = { _id: new ObjectId(), ...input, updatedAt: new Date() };
        await db.collection('posts').insertOne(post, { session });
        return {
          result: post,
          event: { target: post.name, postId: post._id.toHexString() }
        };
      }
    });

    const first = await create();
    const second = await create();
    assert.deepEqual(second, first);
    assert.equal(await db.collection('posts').countDocuments(), 1);
    assert.equal(await db.collection('audit_logs').countDocuments(), 1);
    assert.equal(await db.collection('post_write_outbox').countDocuments(), 1);
    assert.equal(await db.collection('post_write_receipts').countDocuments(), 1);

    await assert.rejects(performArticleTransaction({
      client, db, operatorId: actor.toHexString(),
      idempotencyKey: createKey, action: 'CREATE_POST',
      input: { name: 'Hijacked payload' }, mutate: async () => { throw Error('do not call'); }
    }), IdempotencyConflictError);
    const id = new ObjectId(first._id);
    const updateKey = randomUUID();
    const updated = () => performArticleTransaction({
      client, db, operatorId: actor.toHexString(),
      idempotencyKey: updateKey, action: 'UPDATE_POST', targetId: first._id,
      input: { name: 'Updated' },
      mutate: async ({ session }) => {
        const res = await db.collection('posts').findOneAndUpdate(
          { _id: id }, { $set: { name: 'Updated', updatedAt: new Date() } },
          { session, includeResultMetadata: true, returnDocument: 'after' }
        );
        const post = res.value;
        return { result: post, event: { target: post.name, postId: id.toHexString() } };
      }
    });
    const updateFirst = await updated();
    assert.deepEqual(await updated(), updateFirst);
    assert.equal(await db.collection('audit_logs').countDocuments(), 2);

    const deleteKey = randomUUID();
    const remove = () => performArticleTransaction({
      client, db, operatorId: actor.toHexString(),
      idempotencyKey: deleteKey, action: 'DELETE_POST', targetId: first._id,
      mutate: async ({ session }) => {
        const res = await db.collection('posts').findOneAndDelete({ _id: id },
          { session, includeResultMetadata: true });
        const post = res.value;
        return {
          result: post ? { id: String(post._id), name: post.name } : null,
          event: post ? { target: post.name, postId: id.toHexString() } : null
        };
      }
    });
    const deleteFirst = await remove();
    assert.deepEqual(await remove(), deleteFirst);
    assert.equal(await db.collection('posts').countDocuments(), 0);
    assert.equal(await db.collection('audit_logs').countDocuments(), 3);
    assert.equal(await db.collection('post_write_outbox').countDocuments(), 3);
    assert.equal(await db.collection('post_write_receipts').countDocuments(), 3);

    // Force the outbox insert to fail inside the transaction; verify no
    // business post, audit or receipt was left behind.
    await db.command({
      collMod: 'post_write_outbox',
      validator: { $jsonSchema: {
        bsonType: 'object', required: ['purposelyAbsentRollbackGuard']
      } },
      validationLevel: 'strict',
      validationAction: 'error'
    });
    await assert.rejects(performArticleTransaction({
      client, db, operatorId: actor.toHexString(),
      idempotencyKey: randomUUID(), action: 'CREATE_POST',
      input: { name: 'Rollback' },
      mutate: async ({ session }) => {
        const post = { _id: new ObjectId(), name: 'Rollback' };
        await db.collection('posts').insertOne(post, { session });
        return { result: post, event: {
          target: 'Updated', postId: post._id.toHexString()
        } };
      }
    }));
    assert.equal(await db.collection('posts').countDocuments(), 0);
    assert.equal(await db.collection('audit_logs').countDocuments(), 3);
    assert.equal(await db.collection('post_write_outbox').countDocuments(), 3);
    assert.equal(await db.collection('post_write_receipts').countDocuments(), 3);
  } finally {
    try { await db.dropDatabase(); } finally { await client.close(); }
  }
});
