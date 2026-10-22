import mongoose from 'mongoose';
import { BrainSource, BrainDocument, BrainMemory, BrainRevision, BrainImportJob } from '../../models/brain.js';
import { fail, objectId, searchFields, sha } from './core.js';
import { putPrivate } from './storage.js';
const categories = { instructions: 'instruction', identity: 'identity', career: 'career', projects: 'project', preferences: 'preference' };
export function parseKnowledge(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) fail('KNOWLEDGE_FILE_TOO_LARGE', 413);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_UTF8'); }
  if (text.length > 128000) fail('KNOWLEDGE_FILE_TOO_LARGE', 413);
  const entries = [];
  let category = 'other', active;
  const finish = () => {
    if (!active) return;
    while (active.end > active.start && /\s/.test(text[active.end - 1])) active.end--;
    const quote = text.slice(active.start, active.end);
    const statement = quote.replace(/^\[(?:\d{4}-\d{2}-\d{2}|unknown)\]\s*-\s*/, '');
    if (!statement || statement.length > 20000) fail('INVALID_KNOWLEDGE_ENTRY');
    entries.push({ ...active, quote, statement });
    active = null;
  };
  let offset = 0;
  for (const part of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const line = part.replace(/[\r\n]+$/, '');
    const heading = /^#{1,3}\s+(?:\d+\.\s*)?(.+?)\s*$/.exec(line);
    const entry = /^\[(\d{4}-\d{2}-\d{2}|unknown)\]\s*-\s*/.exec(line);
    if (heading) { finish(); category = categories[heading[1].toLowerCase()] || 'other'; }
    else if (entry) {
      finish();
      const date = entry[1] === 'unknown' ? null : entry[1];
      if (date && (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) fail('INVALID_KNOWLEDGE_DATE');
      active = { start: offset, end: offset + line.length, type: category, date };
    } else if (active) active.end = offset + line.length;
    else if (line.trim()) fail('UNRECOGNIZED_KNOWLEDGE_TEXT');
    offset += part.length;
  }
  finish();
  if (!entries.length || entries.length > 1000) fail('KNOWLEDGE_ENTRY_LIMIT');
  return { text, entries, sha256: sha(bytes), categories: entries.reduce((out, e) => ({ ...out, [e.type]: (out[e.type] || 0) + 1 }), {}) };
}
export async function previewKnowledge(ownerId, bytes) {
  objectId(ownerId);
  const parsed = parseKnowledge(bytes);
  const existing = await BrainSource.findOne({ ownerId, provider: 'manual', originalSha256: parsed.sha256 }).select('_id metadata').lean();
  return { format: 'knowledge-markdown-1', sha256: parsed.sha256, entries: parsed.entries.length, categories: parsed.categories,
    unknownDates: parsed.entries.filter(e => !e.date).length, existing: Boolean(existing), sourceId: existing ? String(existing._id) : null };
}
export async function importKnowledge(ownerId, bytes, filename = 'knowledge.md') {
  objectId(ownerId);
  const parsed = parseKnowledge(bytes), preview = await previewKnowledge(ownerId, bytes);
  if (preview.existing) return { ...preview, created: 0, duplicate: true };
  const privateObjectKey = await putPrivate(ownerId, bytes);
  return mongoose.connection.transaction(async session => {
    const existing = await BrainSource.findOne({ ownerId, provider: 'manual', originalSha256: parsed.sha256 }).session(session).lean();
    if (existing) return { ...preview, created: 0, duplicate: true, sourceId: String(existing._id) };
    const [source] = await BrainSource.create([{ ownerId, provider: 'manual', sourceType: 'knowledge-markdown',
      originalFilename: filename.slice(0, 200), originalSha256: parsed.sha256, privateObjectKey,
      formatVersion: 'knowledge-markdown-1', status: 'ready',
      metadata: { userProvided: true, independentlyVerified: false, entryCount: parsed.entries.length, categories: parsed.categories }
    }], { session });
    const [doc] = await BrainDocument.create([{ ownerId, sourceId: source._id, stableKey: 'knowledge:' + parsed.sha256,
      rawText: parsed.text, rawJsonRef: 'original#text', contentSha256: sha(parsed.text), order: 0,
      metadata: { userProvided: true, independentlyVerified: false }, ...searchFields(parsed.text)
    }], { session });
    const memories = await BrainMemory.create(parsed.entries.map(e => ({
      ownerId, sourceId: source._id, statement: e.statement, verbatim: e.quote, type: e.type,
      eventAt: e.date ? new Date(e.date + 'T00:00:00.000Z') : null, reviewStatus: 'candidate',
      sensitivity: /出生日期|住址|地址记录|家庭财务|储蓄|联系电话|手机号/.test(e.statement) ? 'restricted' : 'normal',
      tags: ['imported', e.type], sourceAnchors: [{ documentId: doc._id, quote: e.quote, start: e.start, end: e.end }],
      ...searchFields(e.statement)
    })), { session, ordered: true });
    await BrainRevision.create(memories.map(m => ({ ownerId, actorId: ownerId, memoryId: m._id, action: 'import-knowledge',
      after: m.toObject(), revisionNumber: 1, reason: 'User-provided dated knowledge; original retained; not independently verified'
    })), { session, ordered: true });
    await BrainSource.updateOne({ _id: source._id, ownerId }, { $set: { 'metadata.documentIds': [doc._id] } }, { session });
    await BrainImportJob.create([{ ownerId, kind: 'import', provider: 'manual', sourceSha256: parsed.sha256,
      privateObjectKey, originalFilename: filename.slice(0, 200), state: 'complete',
      counts: { documents: 1, memories: memories.length, originalBytes: bytes.length }, finishedAt: new Date(),
      preview: { format: 'knowledge-markdown-1', sourceId: String(source._id), categories: parsed.categories }
    }], { session });
    return { ...preview, sourceId: String(source._id), documentId: String(doc._id), created: memories.length, duplicate: false };
  });
}
