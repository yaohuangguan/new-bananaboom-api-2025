import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { BrainSource, BrainDocument, BrainMemory, BrainRevision } from '../../models/brain.js';
export function fail(code, status = 400) { const e = new Error(code); e.status = status; throw e; }
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail('INVALID_ID');
  return value;
}
export const normalize = text => text.normalize('NFKC').toLowerCase();
export function searchFields(text) {
  const normalizedText = normalize(text);
  const chars = Array.from(normalizedText);
  const searchGrams = [...new Set(chars.flatMap((c, i) => i + 1 < chars.length ? [c, c + chars[i + 1]] : [c]))];
  return { normalizedText, searchGrams };
}
export function searchFilter(query) {
  if (!query) return {};
  if (typeof query !== 'string' || query.length > 200) fail('INVALID_QUERY');
  const text = normalize(query);
  const chars = Array.from(text);
  const grams = chars.length > 1 ? chars.slice(0, 8).map((c, i) => chars[i + 1] ? c + chars[i + 1] : c) : chars;
  return { searchGrams: { $all: grams }, normalizedText: { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } };
}
export const publicRow = row => {
  if (!row) fail('NOT_FOUND', 404);
  const { privateObjectKey: _key, normalizedText: _normalized, searchGrams: _grams, ...safe } = row;
  return safe;
};
export function limitOf(value = 30) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) fail('INVALID_LIMIT');
  return n;
}
export function memoryInput(input, patch = false) {
  const allowed = ['type', 'statement', 'verbatim', 'sourceAnchors', 'eventAt', 'observedAt', 'validFrom', 'validTo', 'supersedesId', 'reviewStatus', 'sensitivity', 'tags', 'entityKeys', 'reason', 'expectedRevision', 'archived'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) fail('INVALID_FIELDS');
  const out = {};
  for (const key of allowed.filter(k => !['reason', 'expectedRevision', 'archived'].includes(k))) {
    if (Object.hasOwn(input, key)) out[key] = input[key];
  }
  if (!patch || Object.hasOwn(out, 'statement')) {
    if (typeof out.statement !== 'string' || !out.statement.trim() || out.statement.length > 20000) fail('INVALID_STATEMENT');
  }
  for (const key of ['eventAt', 'observedAt', 'validFrom', 'validTo']) {
    if (out[key] !== undefined && out[key] !== null && (typeof out[key] !== 'string' || !Number.isFinite(Date.parse(out[key])))) fail('INVALID_DATE');
  }
  for (const key of ['tags', 'entityKeys']) {
    if (out[key] !== undefined && (!Array.isArray(out[key]) || out[key].length > 50 || out[key].some(s => typeof s !== 'string' || s.length > 100))) fail('INVALID_TAGS');
  }
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 1000)) fail('INVALID_REASON');
  if (input.archived !== undefined && typeof input.archived !== 'boolean') fail('INVALID_ARCHIVED');
  if (out.verbatim !== undefined && (typeof out.verbatim !== 'string' || out.verbatim.length > 20000)) fail('INVALID_VERBATIM');
  return out;
}
async function validateEvidence(ownerId, data, session) {
  if (data.supersedesId && !await BrainMemory.exists({ _id: objectId(data.supersedesId), ownerId }).session(session)) fail('INVALID_SUPERSEDES');
  if (data.sourceAnchors !== undefined) {
    if (!Array.isArray(data.sourceAnchors) || data.sourceAnchors.length > 50) fail('INVALID_ANCHORS');
    for (const a of data.sourceAnchors) {
      if (!a || Object.keys(a).some(k => !['documentId', 'quote', 'start', 'end'].includes(k))) fail('INVALID_ANCHOR');
      const doc = await BrainDocument.findOne({ _id: objectId(a.documentId), ownerId }).session(session).lean();
      if (!doc) fail('INVALID_EVIDENCE');
      if (a.quote !== undefined && (typeof a.quote !== 'string' || !a.quote.length || !doc.rawText.includes(a.quote))) fail('QUOTE_NOT_IN_SOURCE');
      if (a.start !== undefined || a.end !== undefined) {
        if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end <= a.start || a.end > doc.rawText.length) fail('INVALID_RANGE');
        if (a.quote !== undefined && doc.rawText.slice(a.start, a.end) !== a.quote) fail('QUOTE_RANGE_MISMATCH');
      }
    }
  }
}
export async function writeMemory(ownerId, input, memoryId) {
  const data = memoryInput(input, Boolean(memoryId));
  if (memoryId && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) fail('EXPECTED_REVISION_REQUIRED');
  return mongoose.connection.transaction(async session => {
    await validateEvidence(ownerId, data, session);
    if (!memoryId) {
      const sourceId = new mongoose.Types.ObjectId();
      const documentId = new mongoose.Types.ObjectId();
      await BrainSource.create([{ _id: sourceId, ownerId, provider: 'manual', sourceType: 'manual', originalSha256: sha(data.statement + randomUUID()), status: 'ready', metadata: { origin: 'user-entered' } }], { session });
      await BrainDocument.create([{ _id: documentId, ownerId, sourceId, stableKey: 'manual:' + sourceId, rawText: data.statement, contentSha256: sha(data.statement), ...searchFields(data.statement) }], { session });
      const [created] = await BrainMemory.create([{ ...data, ownerId, sourceId, sourceAnchors: data.sourceAnchors?.length ? data.sourceAnchors : [{ documentId, quote: data.statement }], ...searchFields(data.statement) }], { session });
      const after = created.toObject();
      await BrainRevision.create([{ ownerId, actorId: ownerId, memoryId: created._id, action: 'create', after, revisionNumber: 1, reason: input.reason }], { session });
      return publicRow(after);
    }
    const before = await BrainMemory.findOne({ _id: objectId(memoryId), ownerId }).session(session).lean();
    if (!before) fail('NOT_FOUND', 404);
    if (before.revision !== input.expectedRevision) fail('REVISION_CONFLICT', 409);
    const change = { ...data, revision: before.revision + 1 };
    if (data.statement !== undefined) Object.assign(change, searchFields(data.statement));
    if (input.archived !== undefined) change.deletedAt = input.archived ? new Date() : null;
    const after = await BrainMemory.findOneAndUpdate({ _id: before._id, ownerId, revision: before.revision }, { $set: change }, { new: true, runValidators: true, session }).lean();
    if (!after) fail('REVISION_CONFLICT', 409);
    await BrainRevision.create([{ ownerId, actorId: ownerId, memoryId: before._id, action: input.archived === true ? 'archive' : input.archived === false ? 'unarchive' : 'update', before, after, revisionNumber: after.revision, reason: input.reason }], { session });
    return publicRow(after);
  });
}
export async function pageRows(Model, ownerId, query = {}, extra = {}) {
  const filter = { ...extra, ownerId, ...searchFilter(query.query) };
  for (const k of ['type', 'reviewStatus']) if (query[k]) {
    if (typeof query[k] !== 'string' || query[k].length > 30) fail('INVALID_FILTER');
    filter[k] = query[k];
  }
  if (query.source) filter.sourceId = objectId(query.source);
  if (query.from || query.to) {
    filter.eventAt = {};
    for (const [input, op] of [['from', '$gte'], ['to', '$lte']]) if (query[input]) {
      if (typeof query[input] !== 'string' || !Number.isFinite(Date.parse(query[input]))) fail('INVALID_DATE');
      filter.eventAt[op] = new Date(query[input]);
    }
  }
  if (query.cursor) filter._id = { $gt: objectId(query.cursor) };
  const limit = limitOf(query.limit);
  const rows = await Model.find(filter).sort({ _id: 1 }).limit(limit + 1).maxTimeMS(5000).lean();
  return { items: rows.slice(0, limit).map(publicRow), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null };
}
