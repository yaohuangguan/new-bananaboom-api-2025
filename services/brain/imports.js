import mongoose from 'mongoose';
import multer from 'multer';
import { BrainSource, BrainDocument, BrainAsset, BrainImportJob, BrainMemory, BrainRevision } from '../../models/brain.js';
import { parseImport } from './adapters.js';
import { getPrivate, putPrivate } from './storage.js';
import { fail, objectId, publicRow, sha, searchFields, limitOf } from './core.js';
import { scanLegacy } from './legacy.js';
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 5, fieldSize: 2048 } }).single('file');
const providers = ['chatgpt', 'claude', 'manual', 'other', 'orion-legacy'];
async function analyze(ownerId, plan, session) {
  let added = 0, duplicates = 0, conflicts = 0, absent = 0;
  const seen = new Set();
  for (const d of plan.documents) {
    const key = d.stableKey + ':' + d.contentSha256;
    if (seen.has(key)) { duplicates++; continue; } seen.add(key);
    const same = await BrainDocument.exists({ ownerId, stableKey: d.stableKey, contentSha256: d.contentSha256 }).session(session || null);
    if (same) duplicates++; else {
      added++;
      if (await BrainDocument.exists({ ownerId, stableKey: d.stableKey }).session(session || null)) conflicts++;
    }
  }
  // Only compare conversations actually included in this export, never infer deletion.
  const conversations = [...new Set(plan.documents.map(d => d.externalConversationId).filter(Boolean))];
  if (conversations.length) {
    const old = await BrainDocument.find({ ownerId, externalConversationId: { $in: conversations } }).select('stableKey').session(session || null).lean();
    const incoming = new Set(plan.documents.map(d => d.stableKey));
    absent = new Set(old.filter(d => !incoming.has(d.stableKey)).map(d => d.stableKey)).size;
  }
  return { documents: plan.documents.length, added, duplicates, conflicts, absentFromIncludedConversations: absent, missingAssets: plan.missing.length, assets: plan.assets.length };
}
export async function previewImport(ownerId, bytes, filename, provider) {
  if (!providers.includes(provider)) fail('INVALID_PROVIDER');
  if (await BrainImportJob.countDocuments({ ownerId, state: { $in: ['preview', 'unsupported'] } }) >= 20) fail('PENDING_JOB_QUOTA', 429);
  if (await BrainImportJob.countDocuments({ ownerId, startedAt: { $gte: new Date(Date.now() - 86400000) } }) >= 50) fail('DAILY_JOB_QUOTA', 429);
  const reservation = await BrainImportJob.aggregate([{ $match: { ownerId: new mongoose.Types.ObjectId(ownerId) } }, { $group: { _id: null, total: { $sum: '$counts.originalBytes' } } }]);
  if ((reservation[0]?.total || 0) + bytes.length > 1024 * 1024 * 1024) fail('OWNER_STORAGE_QUOTA', 413);
  const plan = await parseImport(bytes, filename, provider);
  const counts = { ...await analyze(ownerId, plan), originalBytes: bytes.length };
  const privateObjectKey = await putPrivate(ownerId, bytes);
  return publicRow((await BrainImportJob.create({ ownerId, provider, sourceSha256: sha(bytes), state: plan.supported ? 'preview' : 'unsupported',
    privateObjectKey, originalFilename: filename, counts, preview: { warnings: plan.warnings, missingAssets: plan.missing.slice(0, 100), formatVersion: plan.formatVersion, note: 'No existing records are deleted or overwritten. Unknown structures remain in original package.' },
    expiresAt: new Date(Date.now() + 7 * 86400000) })).toObject());
}
export async function commitImport(ownerId, jobId) {
  const job = await BrainImportJob.findOne({ _id: objectId(jobId), ownerId, kind: 'import' }).lean();
  if (!job) fail('NOT_FOUND', 404);
  if (job.state === 'complete') return publicRow(job);
  if (!['preview', 'unsupported'].includes(job.state)) fail('JOB_NOT_READY', 409);
  const bytes = await getPrivate(ownerId, job.privateObjectKey);
  const plan = await parseImport(bytes, job.originalFilename, job.provider);
  const storedAssets = [];
  for (const a of plan.assets) storedAssets.push({ ...a, privateObjectKey: await putPrivate(ownerId, a.bytes) });
  try { return await mongoose.connection.transaction(async session => {
    const current = await BrainImportJob.findOne({ _id: job._id, ownerId }).session(session).lean();
    if (current.state === 'complete') return publicRow(current);
    const counts = { ...await analyze(ownerId, plan, session), originalBytes: bytes.length };
    let source = await BrainSource.findOne({ ownerId, provider: job.provider, originalSha256: job.sourceSha256 }).session(session).lean();
    if (!source) {
      const [created] = await BrainSource.create([{ ownerId, provider: job.provider, sourceType: job.provider === 'manual' ? 'manual-import' : 'official-export',
        originalFilename: job.originalFilename, originalSha256: job.sourceSha256, privateObjectKey: job.privateObjectKey, formatVersion: plan.formatVersion,
        status: plan.supported ? 'ready' : 'unsupported', metadata: { warnings: plan.warnings, counts, missingAssets: plan.missing, evidence: job.provider === 'manual' ? 'AI summary possible; not independently verified' : 'Original export retained' } }], { session });
      source = created.toObject();
      const assetIds = new Map();
      for (const a of storedAssets) {
        const [asset] = await BrainAsset.create([{ ownerId, sourceId: source._id, privateObjectKey: a.privateObjectKey, sha256: a.sha256, size: a.size, mimeType: a.mimeType, originalName: a.name, availability: 'available' }], { session });
        assetIds.set(a.name, asset._id);
      }
      for (const ref of plan.missing) {
        const [asset] = await BrainAsset.create([{ ownerId, sourceId: source._id, size: 0, originalName: ref, availability: 'missing' }], { session });
        assetIds.set('missing:' + ref, asset._id);
      }
      const documentIds = [];
      for (const d of plan.documents) {
        const existing = await BrainDocument.findOne({ ownerId, stableKey: d.stableKey, contentSha256: d.contentSha256 }).session(session).lean();
        if (existing) { documentIds.push(existing._id); continue; }
        const conflicts = await BrainDocument.find({ ownerId, stableKey: d.stableKey }).select('_id').session(session).lean();
        const { assetNames, ...data } = d;
        const [doc] = await BrainDocument.create([{ ...data, ownerId, sourceId: source._id, assetIds: assetNames.map(n => assetIds.get(n)).filter(Boolean),
          metadata: { ...data.metadata, conflictOf: conflicts.map(c => String(c._id)) }, ...searchFields(data.rawText) }], { session });
        documentIds.push(doc._id);
        if (['manual', 'other'].includes(job.provider) && d.rawText.trim() && d.rawText.length <= 20000) {
          const [memory] = await BrainMemory.create([{ ownerId, sourceId: source._id, statement: d.rawText, reviewStatus: 'candidate',
            sourceAnchors: [{ documentId: doc._id, quote: d.rawText }], ...searchFields(d.rawText) }], { session });
          await BrainRevision.create([{ ownerId, actorId: ownerId, memoryId: memory._id, action: 'import-candidate', after: memory.toObject(), revisionNumber: 1, reason: 'Unverified imported text; human review required' }], { session });
        }
      }
      await BrainSource.updateOne({ _id: source._id, ownerId }, { $set: { 'metadata.documentIds': documentIds } }, { session });
    }
    const finished = await BrainImportJob.findOneAndUpdate({ _id: job._id, ownerId }, { $set: { state: 'complete', counts, finishedAt: new Date(), cursor: String(plan.documents.length) } }, { new: true, session }).lean();
    return publicRow(finished);
  }); } catch (e) {
    await BrainImportJob.updateOne({ _id: job._id, ownerId, state: { $ne: 'complete' } }, { $set: { errorSummary: 'COMMIT_INTERRUPTED_SAFE_TO_RETRY', cursor: '0' } });
    throw e;
  }
}
export function attachImports(router) {
  router.post('/imports', upload, async (req, res) => {
    if (!req.file) fail('FILE_REQUIRED');
    const provider = req.body.provider;
    if (provider === 'orion-legacy') fail('USE_OWNER_SCOPED_LEGACY_PREVIEW');
    res.status(201).json(await previewImport(req.brainOwner, req.file.buffer, req.file.originalname, provider));
  });
  router.post('/legacy/preview', async (req, res) => {
    if (process.env.BRAIN_ALLOW_LEGACY_SCAN !== '1') fail('LEGACY_SCAN_REQUIRES_APPROVED_DATASET', 403);
    const archive = await scanLegacy(req.brainOwner);
    res.status(201).json(await previewImport(req.brainOwner, Buffer.from(JSON.stringify(archive)), 'orion-legacy.json', 'orion-legacy'));
  });
  router.get('/imports/:id', async (req, res) => res.json(publicRow(await BrainImportJob.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner, kind: 'import' }).lean())));
  router.post('/imports/:id/commit', async (req, res) => res.json(await commitImport(req.brainOwner, req.params.id)));
  router.get('/sources/:id/original', async (req, res) => {
    const source = await BrainSource.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner }).lean();
    if (!source?.privateObjectKey) fail('NOT_FOUND', 404);
    return sendBytes(req, res, await getPrivate(req.brainOwner, source.privateObjectKey), source.originalFilename || 'original.bin');
  });
  router.get('/sources/:id/assets', async (req, res) => {
    if (!await BrainSource.exists({ _id: objectId(req.params.id), ownerId: req.brainOwner })) fail('NOT_FOUND', 404);
    const filter = { sourceId: req.params.id, ownerId: req.brainOwner };
    if (req.query.cursor) filter._id = { $gt: objectId(req.query.cursor) };
    const limit = limitOf(req.query.limit), rows = await BrainAsset.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
    res.json({ items: rows.slice(0, limit).map(publicRow), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null });
  });
  router.get('/assets/:id', async (req, res) => {
    const asset = await BrainAsset.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner }).lean();
    if (!asset || asset.availability !== 'available') fail('NOT_FOUND', 404);
    return sendBytes(req, res, await getPrivate(req.brainOwner, asset.privateObjectKey), asset.originalName);
  });
}
export function sendBytes(req, res, bytes, name) {
  const filename = (name || 'download.bin').split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'download.bin';
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + filename + '"', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Accept-Ranges': 'bytes' });
  const range = req.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2]) || bytes.length === 0) return res.status(416).set('Content-Range', 'bytes */' + bytes.length).end();
    const start = m[1] ? Number(m[1]) : Math.max(0, bytes.length - Number(m[2]));
    const end = m[1] ? m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1 : bytes.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes.length || end < start) return res.status(416).set('Content-Range', 'bytes */' + bytes.length).end();
    return res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + bytes.length).send(bytes.subarray(start, end + 1));
  }
  return res.send(bytes);
}
