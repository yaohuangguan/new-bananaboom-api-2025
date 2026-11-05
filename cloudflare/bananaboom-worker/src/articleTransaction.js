import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';

// Every logical user mutation has a stable key; retrying it must never
// create, edit, delete or emit an outbox event for the second time.
export class IdempotencyKeyError extends Error {
  constructor() {
    super('A valid X-Idempotency-Key is required for article writes');
    this.name = 'IdempotencyKeyError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('This X-Idempotency-Key was already used for a different article operation');
    this.name = 'IdempotencyConflictError';
  }
}

export function requireMutationKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    throw new IdempotencyKeyError();
  }
  return key;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function mutationFingerprint({ action, targetId = '', input = {} }) {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ action, targetId, input })))
    .digest('hex');
}

function readReceipt(receipt, fingerprint) {
  if (receipt.fingerprint !== fingerprint) throw new IdempotencyConflictError();
  if (!receipt.completedAt) {
    // A properly committed transaction never exposes a pending receipt.
    throw new Error('Incomplete transaction receipt');
  }
  return receipt.result;
}

function isAmbiguousCommit(error) {
  return error?.code === 11000 ||
    error?.hasErrorLabel?.('UnknownTransactionCommitResult') ||
    error?.hasErrorLabel?.('TransientTransactionError');
}

// Guaranteed atomic: business mutation + audit + notification + response receipt.
// An aborted transaction does not leave a changed article or an orphaned event.
// Writes require a MongoDB replica set/sharded transaction-capable deployment.
export async function performArticleTransaction({
  client, db, operatorId, idempotencyKey, action, targetId = '', input = {},
  ip = '', mutate, now = () => new Date()
}) {
  requireMutationKey(idempotencyKey);
  if (!ObjectId.isValid(operatorId) || String(operatorId).length !== 24) {
    throw new Error('Invalid operation actor');
  }
  const receiptId = operatorId + ':' + idempotencyKey;
  const fingerprint = mutationFingerprint({ action, targetId, input });
  const receipts = db.collection('post_write_receipts');
  const existing = await receipts.findOne({ _id: receiptId });
  if (existing) return readReceipt(existing, fingerprint);

  try {
    return await client.withSession(async (session) => session.withTransaction(async () => {
      const previous = await receipts.findOne({ _id: receiptId }, { session });
      if (previous) return readReceipt(previous, fingerprint);

      const createdAt = now();
      await receipts.insertOne({
        _id: receiptId,
        operator: new ObjectId(operatorId),
        fingerprint,
        action,
        createdAt
      }, { session });

      const { result, event } = await mutate({ session, db });
      const plainResult = JSON.parse(JSON.stringify(result ?? null));

      if (event) {
        const actor = await db.collection('users').findOne(
          { _id: new ObjectId(operatorId) },
          { session, projection: { displayName: 1, name: 1 } }
        );
        const operatorName = actor?.displayName || actor?.name || operatorId;
        const audit = await db.collection('audit_logs').insertOne({
          operator: new ObjectId(operatorId),
          action,
          target: event.target,
          ip: String(ip || '').slice(0, 128),
          createdDate: createdAt
        }, { session });

        await db.collection('post_write_outbox').insertOne({
          auditLogId: audit.insertedId,
          postId: new ObjectId(event.postId),
          operator: new ObjectId(operatorId),
          operatorName,
          action,
          target: event.target,
          createdAt,
          attempts: 0,
          dispatchedAt: null
        }, { session });
      }

      await receipts.updateOne({ _id: receiptId }, {
        $set: { result: plainResult, completedAt: now() }
      }, { session });
      return plainResult;
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
      maxCommitTimeMS: 10000
    }));
  } catch (error) {
    // If MongoDB acknowledged the commit but the reply was lost, reading the
    // majority-committed receipt recovers the original outcome safely.
    // For a concurrent identical request, Mongo may report duplicate _id;
    // the committed receipt (if present) wins, otherwise caller retries same key.
    if (isAmbiguousCommit(error)) {
      const completed = await receipts.findOne({ _id: receiptId }, {
        readConcern: { level: 'majority' }
      });
      if (completed) return readReceipt(completed, fingerprint);
    }
    throw error;
  }
}
