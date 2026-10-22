import mongoose from 'mongoose';
import { z } from 'zod';
import { BrainMemory, BrainSource, BrainDocument } from '../../models/brain.js';
import { BrainConnection, BrainSyncReceipt } from '../../models/brainSync.js';
import { fail, pageRows, publicRow, objectId, sha, searchFields, writeMemory } from './core.js';
import { putPrivate } from './storage.js';
import { needScope } from './connections.js';
export const searchSchema = z.object({
  query: z.string().max(200).default(''), type: z.enum(['instruction','identity','career','project','preference','decision','fact','other']).optional(),
  limit: z.number().int().min(1).max(50).default(20), cursor: z.string().regex(/^[a-f0-9]{24}$/i).optional()
}).strict();
export const syncSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9:_-]+$/).describe('Unique ID for this exact change. Reuse unchanged on retry; use a new ID for another change.'),
  statement: z.string().trim().min(1).max(20000).describe('Durable user-provided knowledge; preserve uncertainty. Never infer facts or include passwords or secrets.'),
  type: z.enum(['instruction','identity','career','project','preference','decision','fact','other']).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  eventAt: z.string().refine(v => Number.isFinite(Date.parse(v)), 'Invalid date').nullable().optional(),
  memoryId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  expectedRevision: z.number().int().min(1).optional().describe('Required with memoryId. Read the record first and send its current revision.'),
  sensitivity: z.enum(['normal','sensitive','restricted']).default('normal'),
  note: z.string().max(500).optional()
}).strict();
function parse(schema, input) {
  const p = schema.safeParse(input);
  if (!p.success) fail('INVALID_SYNC_INPUT');
  return p.data;
}
export async function searchKnowledge(connection, input) {
  needScope(connection, 'memory:read');
  const query = parse(searchSchema, input);
  return pageRows(BrainMemory, String(connection.ownerId), query, { deletedAt: null, reviewStatus: { $ne: 'rejected' } });
}
export async function readKnowledge(connection, id) {
  needScope(connection, 'memory:read');
  const row = await BrainMemory.findOne({ _id: objectId(id), ownerId: connection.ownerId, deletedAt: null }).lean();
  return publicRow(row);
}
export async function syncKnowledge(connection, input) {
  needScope(connection, 'memory:write');
  const data = parse(syncSchema, input), ownerId = String(connection.ownerId);
  if (data.memoryId && !data.expectedRevision) fail('EXPECTED_REVISION_REQUIRED');
  if (!data.memoryId && data.expectedRevision) fail('MEMORY_ID_REQUIRED');
  const payloadHash = sha(JSON.stringify(data));
  const filter = { ownerId, connectionId: connection._id, requestId: data.requestId };
  const cached = await BrainSyncReceipt.findOne(filter).lean();
  if (cached) {
    if (cached.payloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT', 409);
    return cached.result;
  }
  const bytes = Buffer.from(JSON.stringify({ format: 'orion-sync-1', connectionId: String(connection._id), provider: connection.provider, ...data }));
  const privateObjectKey = await putPrivate(ownerId, bytes);
  const operation = async session => {
    const previous = await BrainSyncReceipt.findOne(filter).session(session).lean();
    if (previous) {
      if (previous.payloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT', 409);
      return previous.result;
    }
    const stillActive = await BrainConnection.exists({ _id: connection._id, ownerId, revokedAt: null, expiresAt: { $gt: new Date() } }).session(session);
    if (!stillActive) fail('INVALID_CONNECTION_TOKEN', 401);
    let sensitivity = data.sensitivity;
    if (data.memoryId) {
      const old = await BrainMemory.findOne({ _id: data.memoryId, ownerId, deletedAt: null }).session(session).lean();
      if (!old) fail('NOT_FOUND', 404);
      if (old.revision !== data.expectedRevision) fail('REVISION_CONFLICT', 409);
      const levels = ['normal', 'sensitive', 'restricted'];
      sensitivity = levels[Math.max(levels.indexOf(old.sensitivity), levels.indexOf(sensitivity))];
    }
    const [source] = await BrainSource.create([{ ownerId, provider: connection.provider, sourceType: 'api-sync',
      originalFilename: 'knowledge-sync.json', originalSha256: sha(bytes), privateObjectKey, status: 'ready', formatVersion: 'orion-sync-1',
      metadata: { connectionId: String(connection._id), clientName: connection.label, aiGenerated: true, independentlyVerified: false }
    }], { session });
    const [document] = await BrainDocument.create([{ ownerId, sourceId: source._id,
      stableKey: 'sync:' + connection._id + ':' + data.requestId, rawText: data.statement, rawJsonRef: 'original#/statement',
      contentSha256: sha(data.statement), rawTimestamp: data.eventAt || null,
      metadata: { aiGenerated: true, connectionId: String(connection._id) }, ...searchFields(data.statement)
    }], { session });
    const result = await writeMemory(ownerId, {
      statement: data.statement, type: data.type ?? (data.memoryId ? undefined : 'fact'), tags: data.tags, eventAt: data.eventAt, sensitivity,
      reviewStatus: 'candidate', sourceAnchors: [{ documentId: String(document._id), quote: data.statement }],
      ...(data.memoryId ? { expectedRevision: data.expectedRevision } : {}),
      reason: 'AI sync via ' + connection.label + (data.note ? ': ' + data.note : '')
    }, data.memoryId, { session });
    await BrainSource.updateOne({ _id: source._id, ownerId }, { $set: { 'metadata.documentIds': [document._id] } }, { session });
    const response = JSON.parse(JSON.stringify({ memory: result, created: !data.memoryId, requestId: data.requestId }));
    await BrainSyncReceipt.create([{ ...filter, payloadHash, result: response }], { session });
    await BrainConnection.updateOne({ _id: connection._id, ownerId }, { $set: { lastWriteAt: new Date() } }, { session });
    return response;
  };
  try { return await mongoose.connection.transaction(operation); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const winner = await BrainSyncReceipt.findOne(filter).lean();
    if (!winner || winner.payloadHash !== payloadHash) fail('IDEMPOTENCY_CONFLICT', 409);
    return winner.result;
  }
}
