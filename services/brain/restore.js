import mongoose from 'mongoose';
import { tables, BrainImportJob } from '../../models/brain.js';
import { exportArchive, verifyArchive, runtimeRow, equivalent } from './archive.js';
import { seal, unseal, encrypted } from './crypto.mjs';
import { putPrivate, getPrivate } from './storage.js';
import { fail, objectId, publicRow, sha, runBrainTask, limitOf } from './core.js';
import { sendBytes } from './imports.js';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
async function jobQuota(ownerId) {
  if (
    (await BrainImportJob.countDocuments({
      ownerId,
      kind: { $in: ['restore', 'export'] },
      startedAt: { $gte: new Date(Date.now() - 3600000) }
    })) >= 10
  )
    fail('BACKUP_JOB_QUOTA', 429);
}
export async function createExport(ownerId, options) {
  if (
    !options ||
    (options.unencrypted !== true &&
      (typeof options.passphrase !== 'string' || options.passphrase.length < 12 || options.passphrase.length > 1024))
  )
    fail('PASSPHRASE_REQUIRED_OR_EXPLICIT_PLAINTEXT');
  await jobQuota(ownerId);
  const job = await BrainImportJob.create({
    ownerId,
    kind: 'export',
    state: 'building',
    preview: { encrypted: options.unencrypted !== true }
  });
  try {
    const archive = await exportArchive(ownerId);
    // Verify our own artifact before presenting it as a successful backup.
    await verifyArchive(archive.bytes);
    const bytes = options.unencrypted === true ? archive.bytes : await seal(archive.bytes, options.passphrase);
    const privateObjectKey = await putPrivate(ownerId, bytes);
    return publicRow(
      await BrainImportJob.findOneAndUpdate(
        { _id: job._id, ownerId },
        {
          $set: {
            state: 'complete',
            counts: archive.counts,
            sourceSha256: sha(bytes),
            privateObjectKey,
            finishedAt: new Date()
          }
        },
        { new: true }
      ).lean()
    );
  } catch (error) {
    await BrainImportJob.updateOne(
      { _id: job._id, ownerId },
      { $set: { state: 'failed', errorSummary: 'EXPORT_FAILED_NO_DOWNLOAD', finishedAt: new Date() } }
    );
    throw error;
  }
}
async function restoreCounts(ownerId, archive, session) {
  const counts = { added: 0, identical: 0, conflicts: 0 };
  for (const [name, Model] of Object.entries(tables))
    for (const row of archive.rows[name]) {
      const existing = await Model.findOne({ _id: row._id, ownerId })
        .session(session || null)
        .lean();
      if (!existing) counts.added++;
      else if (equivalent(existing, runtimeRow(name, row, ownerId, new Map()))) counts.identical++;
      else counts.conflicts++;
    }
  return counts;
}
export async function previewRestore(ownerId, bytes, passphrase) {
  await jobQuota(ownerId);
  let plain;
  try {
    plain = encrypted(bytes) ? await unseal(bytes, passphrase) : bytes;
  } catch {
    fail('DECRYPT_FAILED');
  }
  const archive = await verifyArchive(plain);
  if (archive.manifest.owner !== ownerId) fail('ARCHIVE_OWNER_MISMATCH', 403);
  const counts = await restoreCounts(ownerId, archive);
  const privateObjectKey = await putPrivate(ownerId, plain);
  return publicRow(
    (
      await BrainImportJob.create({
        ownerId,
        kind: 'restore',
        state: 'preview',
        privateObjectKey,
        sourceSha256: sha(plain),
        counts,
        preview: {
          archiveCounts: archive.manifest.counts,
          missingAssets: archive.manifest.missingAssets,
          policy: 'Add identical or new records only. Any conflict blocks the entire restore. Never overwrite.'
        }
      })
    ).toObject()
  );
}
export async function commitRestore(ownerId, jobId) {
  const job = await BrainImportJob.findOne({ _id: objectId(jobId), ownerId, kind: 'restore' }).lean();
  if (!job) fail('NOT_FOUND', 404);
  if (job.state === 'complete') return publicRow(job);
  if (job.state !== 'preview') fail('RESTORE_NOT_READY', 409);
  const archive = await verifyArchive(await getPrivate(ownerId, job.privateObjectKey));
  if (archive.manifest.owner !== ownerId) fail('ARCHIVE_OWNER_MISMATCH', 403);
  const keys = new Map();
  for (const row of archive.rows.sources)
    if (row.originalPath && !keys.has(row.originalPath))
      keys.set(row.originalPath, await putPrivate(ownerId, archive.files.get(row.originalPath)));
  for (const row of archive.rows.assets)
    if (row.archivePath && !keys.has(row.archivePath))
      keys.set(row.archivePath, await putPrivate(ownerId, archive.files.get(row.archivePath)));
  try {
    return await mongoose.connection.transaction(async (session) => {
      const current = await BrainImportJob.findOne({ _id: job._id, ownerId }).session(session).lean();
      if (current.state === 'complete') return publicRow(current);
      const counts = await restoreCounts(ownerId, archive, session);
      if (counts.conflicts) fail('RESTORE_CONFLICTS_NO_OVERWRITE', 409);
      for (const [name, Model] of Object.entries(tables))
        for (const row of archive.rows[name]) {
          if (!(await Model.exists({ _id: row._id, ownerId }).session(session)))
            await Model.create([runtimeRow(name, row, ownerId, keys)], { session, timestamps: false });
        }
      return publicRow(
        await BrainImportJob.findOneAndUpdate(
          { _id: job._id, ownerId },
          { $set: { state: 'complete', counts, finishedAt: new Date() } },
          { session, new: true }
        ).lean()
      );
    });
  } catch (e) {
    if (e.code === 11000) fail('RESTORE_ID_COLLISION_NO_OVERWRITE', 409);
    throw e;
  }
}
export function attachBackup(router) {
  const heavy = rateLimit({
    windowMs: 3600000,
    limit: 20,
    skip: (req) => ['GET', 'HEAD'].includes(req.method),
    keyGenerator: (req) => req.brainOwner,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  });
  const restoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 128 * 1024 * 1024, files: 1, fields: 3, fieldSize: 2048 }
  }).single('file');
  router.use(['/exports', '/restore'], heavy);
  router.post('/exports', async (req, res) =>
    res.status(201).json(await runBrainTask(req.brainOwner, () => createExport(req.brainOwner, req.body)))
  );
  router.get('/exports', async (req, res) => {
    const filter = { ownerId: req.brainOwner, kind: 'export' };
    if (req.query.cursor) filter._id = { $lt: objectId(req.query.cursor) };
    const limit = limitOf(req.query.limit);
    const rows = await BrainImportJob.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    res.json({
      items: rows.slice(0, limit).map(publicRow),
      nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null
    });
  });
  router.get('/exports/:id', async (req, res) =>
    res.json(
      publicRow(
        await BrainImportJob.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner, kind: 'export' }).lean()
      )
    )
  );
  router.get('/exports/:id/download', async (req, res) => {
    const job = await BrainImportJob.findOne({
      _id: objectId(req.params.id),
      ownerId: req.brainOwner,
      kind: 'export',
      state: 'complete'
    }).lean();
    if (!job) fail('NOT_FOUND', 404);
    return sendBytes(
      req,
      res,
      await getPrivate(req.brainOwner, job.privateObjectKey),
      'orion-vault.' + (job.preview.encrypted ? 'orion' : 'zip')
    );
  });
  router.get('/recovery-tools/:name', async (req, res) => {
    if (!['brain-vault.mjs', 'crypto.mjs', 'archive.py', 'README.md'].includes(req.params.name)) fail('NOT_FOUND', 404);
    const fs = await import('node:fs/promises');
    return sendBytes(
      req,
      res,
      await fs.readFile(new URL('../../tools/brain-vault/' + req.params.name, import.meta.url)),
      req.params.name
    );
  });
  router.post('/restore/preview', restoreUpload, async (req, res) => {
    if (!req.file) fail('FILE_REQUIRED');
    res
      .status(201)
      .json(
        await runBrainTask(req.brainOwner, () => previewRestore(req.brainOwner, req.file.buffer, req.body.passphrase))
      );
  });
  router.get('/restore/:id', async (req, res) =>
    res.json(
      publicRow(
        await BrainImportJob.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner, kind: 'restore' }).lean()
      )
    )
  );
  router.post('/restore/commit', async (req, res) =>
    res.json(await runBrainTask(req.brainOwner, () => commitRestore(req.brainOwner, req.body.jobId)))
  );
}
