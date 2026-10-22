import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { tables } from '../../models/brain.js';
import { getPrivate } from './storage.js';
import { sha, fail, objectId, searchFields } from './core.js';
import { safeJson } from './adapters.js';
import { makeZip, readZip, ZIP_LIMITS } from './zip.js';
export const portable = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, val) =>
      ['privateObjectKey', 'normalizedText', 'searchGrams'].includes(key) ? undefined : val
    )
  );
const canonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
export const equivalent = (a, b) => canonical(portable(a)) === canonical(portable(b));
export async function exportArchive(ownerId) {
  const rows = await mongoose.connection.transaction(async (session) => {
    const data = {};
    let estimatedBytes = 0;
    for (const [name, Model] of Object.entries(tables)) {
      const budget = await Model.aggregate([
        { $match: { ownerId: new mongoose.Types.ObjectId(ownerId) } },
        { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } }, rows: { $sum: 1 } } }
      ]).session(session);
      estimatedBytes += budget[0]?.bytes || 0;
      if (estimatedBytes > 64 * 1024 * 1024 || budget[0]?.rows > 10000) fail('EXPORT_ROW_OR_MEMORY_QUOTA', 413);
      data[name] = await Model.find({ ownerId }).sort({ _id: 1 }).limit(10001).session(session).lean();
      if (data[name].length > 10000) fail('EXPORT_ROW_QUOTA', 413);
    }
    return data;
  });
  const files = new Map(),
    counts = {};
  for (const row of rows.sources)
    if (row.privateObjectKey) {
      const bytes = await getPrivate(ownerId, row.privateObjectKey);
      if (sha(bytes) !== row.originalSha256) fail('ORIGINAL_HASH_MISMATCH', 500);
      row.originalPath = 'originals/' + row.originalSha256;
      files.set(row.originalPath, bytes);
    }
  for (const row of rows.assets)
    if (row.availability === 'available') {
      const bytes = await getPrivate(ownerId, row.privateObjectKey);
      if (sha(bytes) !== row.sha256 || bytes.length !== row.size) fail('ASSET_HASH_MISMATCH', 500);
      row.archivePath = 'assets/' + row.sha256;
      files.set(row.archivePath, bytes);
    }
  for (const [name, group] of Object.entries(rows)) {
    counts[name] = group.length;
    files.set(
      name + '.jsonl',
      Buffer.from(group.map((r) => canonical(portable(r))).join('\n') + (group.length ? '\n' : ''))
    );
  }
  for (const name of ['README.md', 'brain-vault.mjs', 'crypto.mjs', 'archive.py'])
    files.set(
      name === 'README.md' ? 'README.md' : 'offline-recovery/' + name,
      await fs.readFile(new URL('../../tools/brain-vault/' + name, import.meta.url))
    );
  const hashes = Object.fromEntries([...files].map(([n, b]) => [n, sha(b)]));
  files.set(
    'manifest.json',
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          owner: ownerId,
          exportedAt: new Date().toISOString(),
          counts,
          hashes,
          missingAssets: rows.assets.filter((a) => a.availability !== 'available').length,
          limits: ZIP_LIMITS
        },
        null,
        2
      )
    )
  );
  files.set('checksums.sha256', Buffer.from([...files].map(([n, b]) => sha(b) + '  ' + n).join('\n') + '\n'));
  if (
    files.size > ZIP_LIMITS.entries ||
    [...files.values()].some((b) => b.length > ZIP_LIMITS.entryBytes) ||
    [...files.values()].reduce((n, b) => n + b.length, 0) > ZIP_LIMITS.bytes
  )
    fail('EXPORT_ARCHIVE_QUOTA', 413);
  return { bytes: await makeZip(files), counts };
}
export async function verifyArchive(bytes) {
  const files = await readZip(bytes);
  if (!files.has('manifest.json') || !files.has('checksums.sha256')) fail('MANIFEST_REQUIRED');
  const manifest = safeJson(files.get('manifest.json'));
  if (manifest.schemaVersion !== 1 || !manifest.hashes || !manifest.counts) fail('UNSUPPORTED_ARCHIVE_SCHEMA');
  objectId(manifest.owner);
  const payload = [...files.keys()].filter((n) => !['manifest.json', 'checksums.sha256'].includes(n));
  if (
    payload.length !== Object.keys(manifest.hashes).length ||
    payload.some((n) => manifest.hashes[n] !== sha(files.get(n)))
  )
    fail('ARCHIVE_HASH_MISMATCH');
  const lines = files.get('checksums.sha256').toString('utf8').trim().split('\n'),
    checked = new Set();
  for (const line of lines) {
    const m = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!m || checked.has(m[2]) || m[2] === 'checksums.sha256' || !files.has(m[2]) || sha(files.get(m[2])) !== m[1])
      fail('ARCHIVE_CHECKSUM_MISMATCH');
    checked.add(m[2]);
  }
  if (checked.size !== files.size - 1) fail('ARCHIVE_CHECKSUM_INVENTORY');
  const rows = {},
    ids = {};
  for (const name of Object.keys(tables)) {
    if (!files.has(name + '.jsonl')) fail('ARCHIVE_TABLE_REQUIRED');
    const data = new TextDecoder('utf-8', { fatal: true }).decode(files.get(name + '.jsonl'));
    rows[name] = data
      .split('\n')
      .filter(Boolean)
      .map((line) => safeJson(Buffer.from(line)));
    if (rows[name].length !== manifest.counts[name] || rows[name].length > 10000) fail('ARCHIVE_COUNT_MISMATCH');
    ids[name] = new Set();
    for (const row of rows[name]) {
      objectId(row._id);
      if (row.ownerId !== manifest.owner || ids[name].has(row._id) || Object.hasOwn(row, 'privateObjectKey'))
        fail('ARCHIVE_OWNER_OR_ID');
      ids[name].add(row._id);
    }
  }
  for (const s of rows.sources)
    if (
      s.originalPath !== 'originals/' + s.originalSha256 ||
      !files.has(s.originalPath) ||
      sha(files.get(s.originalPath)) !== s.originalSha256
    )
      fail('ARCHIVE_ORIGINAL_HASH');
  for (const a of rows.assets) {
    if (!ids.sources.has(a.sourceId)) fail('ARCHIVE_ASSET_SOURCE');
    if (
      a.availability === 'available' &&
      (a.archivePath !== 'assets/' + a.sha256 ||
        !files.has(a.archivePath) ||
        sha(files.get(a.archivePath)) !== a.sha256 ||
        files.get(a.archivePath).length !== a.size)
    )
      fail('ARCHIVE_ASSET_HASH');
  }
  const docs = new Map(rows.documents.map((d) => [d._id, d]));
  for (const d of rows.documents)
    if (
      !ids.sources.has(d.sourceId) ||
      typeof d.rawText !== 'string' ||
      d.rawText.length > 128000 ||
      (d.assetIds || []).some((a) => !ids.assets.has(a))
    )
      fail('ARCHIVE_DOCUMENT_REFERENCE');
  const revisionsByMemory = new Map();
  for (const revision of rows.revisions) {
    if (!revisionsByMemory.has(revision.memoryId)) revisionsByMemory.set(revision.memoryId, []);
    revisionsByMemory.get(revision.memoryId).push(revision);
  }
  for (const m of rows.memories) {
    if (!ids.sources.has(m.sourceId) || (m.supersedesId && !ids.memories.has(m.supersedesId)))
      fail('ARCHIVE_MEMORY_REFERENCE');
    for (const a of m.sourceAnchors || []) {
      const d = docs.get(a.documentId);
      if (!d || (a.quote !== undefined && (typeof a.quote !== 'string' || !d.rawText.includes(a.quote))))
        fail('ARCHIVE_ANCHOR');
      if (
        a.start !== undefined &&
        (!Number.isInteger(a.start) ||
          !Number.isInteger(a.end) ||
          a.start < 0 ||
          a.end > d.rawText.length ||
          a.start >= a.end ||
          (a.quote !== undefined && d.rawText.slice(a.start, a.end) !== a.quote))
      )
        fail('ARCHIVE_ANCHOR_RANGE');
    }
    const revisions = (revisionsByMemory.get(m._id) || []).sort((a, b) => a.revisionNumber - b.revisionNumber);
    if (revisions.length !== m.revision || !equivalent(revisions.at(-1)?.after, m)) fail('ARCHIVE_REVISION_CHAIN');
    for (let i = 0; i < revisions.length; i++) {
      const r = revisions[i];
      if (
        r.revisionNumber !== i + 1 ||
        r.actorId !== manifest.owner ||
        r.after?.ownerId !== manifest.owner ||
        r.after?._id !== m._id ||
        (i > 0 && !equivalent(r.before, revisions[i - 1].after))
      )
        fail('ARCHIVE_REVISION_CHAIN');
    }
  }
  if (rows.revisions.some((r) => !ids.memories.has(r.memoryId))) fail('ARCHIVE_REVISION_REFERENCE');
  for (const [name, Model] of Object.entries(tables))
    for (const row of rows[name]) {
      if (name === 'memories' && (!Number.isInteger(row.revision) || row.revision < 1)) fail('ARCHIVE_REVISION_NUMBER');
      await new Model(runtimeRow(name, row, manifest.owner, new Map())).validate();
    }
  return { manifest, files, rows };
}
export function runtimeRow(name, row, ownerId, keys) {
  const data = { ...row, ownerId };
  delete data.originalPath;
  delete data.archivePath;
  if (name === 'sources' && row.originalPath) data.privateObjectKey = keys.get(row.originalPath);
  if (name === 'assets' && row.archivePath) data.privateObjectKey = keys.get(row.archivePath);
  if (name === 'documents') Object.assign(data, searchFields(row.rawText));
  if (name === 'memories') Object.assign(data, searchFields(row.statement));
  return data;
}
