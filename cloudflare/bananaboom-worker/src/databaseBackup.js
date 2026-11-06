import { BSON } from 'mongodb';
const { EJSON } = BSON;

const CHUNK_MAX_BYTES = 2 * 1024 * 1024;
// MongoDB BSON documents max out at 16 MiB. Canonical EJSON can be larger
// than the original BSON; keep a bounded 16 MiB exported-document safeguard.
const MAX_SINGLE_DOCUMENT_BYTES = 16 * 1024 * 1024;
// Keep a safety margin under the Cloudflare isolate memory budget.
const MAX_STAGED_BYTES = 48 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
const MAX_DOCUMENTS = 50000;
const MAX_RUNTIME_MS = 120000;
const MAX_SNAPSHOT_MS = 50000;
const encoder = new TextEncoder();

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function safeCollection(name) {
  return /^[a-zA-Z0-9_.-]{1,120}$/.test(name) && !name.startsWith('system.');
}


// Only a whitelisted reason code, never raw MongoDB/R2 error messages.
export function classifyBackupFailure(error) {
  const message = String(error?.message || '');
  if (/^OrionExportedDocumentTooLarge:\d{1,12}$/.test(message)) {
    return 'single-document-limit';
  }
  const known = {
    'No database collections to back up': 'empty-database',
    'Case-insensitive collection names collide': 'collection-name-collision',
    'Backup exceeded runtime limit': 'runtime-limit',
    'Backup exceeded document limit': 'document-limit',
    'Document too large for safe export': 'single-document-limit',
    'Backup exceeded size limit': 'total-size-limit',
    'Private backup R2 binding missing': 'missing-r2-binding',
    'Backup exceeded memory staging limit': 'memory-staging-limit',
    'Backup exceeded snapshot time limit': 'snapshot-runtime-limit'
  };
  if (Object.hasOwn(known, message)) return known[message];
  if (/transaction|snapshot|writeconflict/i.test(message)) return 'mongodb-transaction';
  if (/r2|bucket|upload|object storage/i.test(message)) return 'r2-operation';
  if (/timed out|timeout|deadline/i.test(message)) return 'timeout';
  if (/not authorized|permission|unauthorized/i.test(message)) return 'database-permissions';
  const codeName = String(error?.codeName || '');
  if (/^[A-Za-z0-9_]{1,64}$/.test(codeName)) return 'mongodb-' + codeName;
  return 'unknown-error';
}

function logBackupDiagnostic(stage, error, docs = 0, bytes = 0, parts = 0, elapsedMs = 0) {
  console.error('db-backup-diagnostic', stage, classifyBackupFailure(error),
    {docs, bytes, parts, elapsedMs});
}

// Encodes only a stage, whitelisted failure reason and aggregate counters.
// This crosses the Durable Object RPC boundary without exposing raw errors.
export function parseBackupDiagnostic(error) {
  const m = String(error?.message || '').match(
    /ORION_BACKUP_DIAG\|(snapshot|r2-chunks|manifest)\|([A-Za-z0-9_-]{1,80})\|(\d{1,8})\|(\d{1,12})\|(\d{1,8})\|(\d{1,8})(?:\|(\d{1,12}))?/
  );
  return m ? {
    stage:m[1], reason:m[2],
    documents:Number(m[3]), bytes:Number(m[4]),
    parts:Number(m[5]), elapsedMs:Number(m[6]),
    exportedDocumentBytes:Number(m[7] || 0)
  } : null;
}

export function validateBackupManifest(manifest) {
  if (!manifest || manifest.format !== 'orion-mongo-ejson-ndjson-v1' ||
    !manifest.complete || !Array.isArray(manifest.collections) ||
    typeof manifest.snapshotAt !== 'string') {
    throw new Error('Invalid or incomplete Orion backup manifest');
  }
  const keys = new Set();
  for (const col of manifest.collections) {
    if (!safeCollection(col.name) || !Array.isArray(col.parts) ||
      !Number.isSafeInteger(col.count) || col.count < 0) {
      throw new Error('Invalid collection in Orion backup manifest');
    }
    if (col.options != null && typeof col.options !== 'object') {
      throw new Error('Invalid collection options');
    }
    if (col.indexes != null && (!Array.isArray(col.indexes) ||
      col.indexes.some((idx) => !idx?.key || typeof idx.key !== 'object' ||
        typeof idx.name !== 'string'))) {
      throw new Error('Invalid collection indexes');
    }
    for (const part of col.parts) {
      if (!/^db-backups\/[0-9TZ._-]+-[a-f0-9]{8}\/[a-z0-9_.-]+\/[0-9]{5}\.ndjson$/.test(part.key) ||
        !/^[a-f0-9]{64}$/.test(part.sha256) ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 0 ||
        keys.has(part.key)) throw new Error('Invalid backup object reference');
      keys.add(part.key);
    }
  }
  return true;
}

export async function createDatabaseBackup({
  client, db, bucket,
  now = () => new Date(),
  randomId = () => crypto.randomUUID(),
  maxRuntimeMs = MAX_RUNTIME_MS,
  maxSnapshotMs = MAX_SNAPSHOT_MS,
  clock = () => Date.now(),
  maxTotalBytes = MAX_BACKUP_BYTES,
  maxStagedBytes = MAX_STAGED_BYTES,
  maxSingleDocumentBytes = MAX_SINGLE_DOCUMENT_BYTES,
  maxDocuments = MAX_DOCUMENTS
}) {
  if (!bucket || typeof bucket.put !== 'function') {
    throw new Error('Private backup R2 binding missing');
  }
  const started = clock();
  const snapshotAt = now().toISOString();
  const prefix = 'db-backups/' + snapshotAt.replace(/[:]/g, '-') + '-' + randomId().slice(0, 8);
  const deadline = (inSnapshot = false) => {
    const elapsed = clock() - started;
    if (inSnapshot && elapsed > maxSnapshotMs) {
      throw new Error('Backup exceeded snapshot time limit');
    }
    if (elapsed > maxRuntimeMs) {
      throw new Error('Backup exceeded runtime limit');
    }
  };
  const list = await db.listCollections({}, { nameOnly: false }).toArray()
    .catch((error) => {
      logBackupDiagnostic('collection-catalog', error);
      throw error;
    });
  const collections = list.map((v) => v.name).filter(safeCollection).sort();
  const metadata = new Map(list.map((v) => [v.name, v]));
  if (new Set(collections.map((v) => v.toLowerCase())).size !== collections.length) {
    throw new Error('Case-insensitive collection names collide');
  }
  if (collections.length === 0) throw new Error('No database collections to back up');

  // MongoDB prohibits listIndexes inside transactions. Catalog/index metadata
  // is captured before the first snapshot read; schema must be quiescent.
  const indexesByCollection = new Map(await Promise.all(collections.map(async (name) => {
    const collection = db.collection(name);
    return [name, collection.listIndexes ? await collection.listIndexes().toArray() : []];
  })).catch((error) => {
    logBackupDiagnostic('index-catalog', error);
    throw error;
  }));

  let stage = 'snapshot';
  let snapshot;
  let manifestKey;
  const uploaded = [];
  try {
    // MongoDB can automatically retry withTransaction. Keep every attempt
    // local; do not make any R2 PUT inside the transaction callback.
    snapshot = await client.withSession(async (session) => session.withTransaction(async () => {
      const staged = [];
      let totalBytes = 0;
      let totalDocuments = 0;
      const manifest = {
        format: 'orion-mongo-ejson-ndjson-v1',
        complete: true,
        database: db.databaseName,
        snapshotAt,
        collections: [],
        totals: { documents: 0, bytes: 0, parts: 0 }
      };
      for (const name of collections) {
        deadline(true);
        const collection = db.collection(name);
        const rawIndexes = indexesByCollection.get(name) || [];
        const col = {
          name, count: 0, parts: [],
          options: metadata.get(name)?.options || {},
          indexes: rawIndexes.filter((idx) => idx.name !== '_id_')
            .map(({ name: indexName, key, ...options }) => {
              const kept = {};
              for (const prop of [
                'unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression',
                'collation', 'weights', 'default_language', 'language_override',
                'wildcardProjection', 'hidden'
              ]) if (options[prop] !== undefined) kept[prop] = options[prop];
              return { name: indexName, key, ...kept };
            })
        };
        manifest.collections.push(col);
        let buffer = [];
        let buffered = 0;
        const flush = async () => {
          if (!buffer.length) return;
          const key = prefix + '/' + name.toLowerCase() + '/' +
            String(col.parts.length).padStart(5, '0') + '.ndjson';
          const bytes = encoder.encode(buffer.join(''));
          const hash = await sha256(bytes);
          staged.push({ key, bytes, hash });
          col.parts.push({ key, bytes: bytes.byteLength, sha256: hash });
          buffer = [];
          buffered = 0;
        };
        const cursor = collection.find({}, { session, batchSize: 100 }).sort({ _id: 1 });
        for await (const doc of cursor) {
          deadline(true);
          if (++totalDocuments > maxDocuments) throw new Error('Backup exceeded document limit');
          const line = EJSON.stringify(doc, { relaxed: false }) + '\n';
          const length = encoder.encode(line).byteLength;
          if (length > maxSingleDocumentBytes) {
            // The Durable Object tail logs this locally, before any error
            // serialization can strip the numeric exported size. No content,
            // collection name, document ID or credential is logged.
            console.warn('orion-backup-ejson-size', length, maxSingleDocumentBytes);
            // The numeric encoded size survives MongoDB transaction rethrows
            // even when custom Error object properties are discarded.
            throw new Error('OrionExportedDocumentTooLarge:' + length);
          }
          if (totalBytes + length > maxTotalBytes) throw new Error('Backup exceeded size limit');
          if (totalBytes + length > maxStagedBytes) {
            throw new Error('Backup exceeded memory staging limit');
          }
          if (buffered + length > CHUNK_MAX_BYTES) await flush();
          buffer.push(line);
          buffered += length;
          totalBytes += length;
          col.count++;
        }
        await flush();
      }
      manifest.totals = {
        documents: totalDocuments,
        bytes: totalBytes,
        parts: staged.length
      };
      validateBackupManifest(manifest);
      return { manifest, staged, totalDocuments, totalBytes };
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
      maxCommitTimeMS: 10000
    }));

    // Commit must succeed before any R2 transfer.
    stage = 'r2-chunks';
    for (let i = 0; i < snapshot.staged.length; i += UPLOAD_CONCURRENCY) {
      deadline();
      const batch = snapshot.staged.slice(i, i + UPLOAD_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (part) => {
        await bucket.put(part.key, part.bytes, {
          httpMetadata: { contentType: 'application/x-ndjson' },
          customMetadata: {
            sha256: part.hash, encoding: 'MongoDB Extended JSON (canonical)'
          }
        });
        uploaded.push(part.key);
      }));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      deadline();
    }

    // Publish a completed manifest only after all chunk PUTs are successful.
    stage = 'manifest';
    deadline();
    manifestKey = prefix + '/manifest.json';
    await bucket.put(manifestKey, encoder.encode(JSON.stringify(snapshot.manifest)), {
      httpMetadata: { contentType: 'application/json' }
    });
    return {
      success: true,
      folder: prefix,
      manifestKey,
      totalFiles: uploaded.length + 1,
      collections: snapshot.manifest.collections.length,
      documents: snapshot.totalDocuments,
      bytes: snapshot.totalBytes
    };
  } catch (error) {
    logBackupDiagnostic(stage, error,
      snapshot?.totalDocuments || 0, snapshot?.totalBytes || 0,
      uploaded.length, clock() - started);
    // An ambiguous manifest PUT might have written successfully. Remove its
    // marker first; if that fails, retain the chunks so marker never dangles.
    let markerRemoved = true;
    if (manifestKey) {
      try { await bucket.delete(manifestKey); }
      catch { markerRemoved = false; }
    }
    if (markerRemoved) {
      await Promise.allSettled(uploaded.map((key) => bucket.delete(key)));
    }
    const reason = classifyBackupFailure(error);
    const elapsed = Math.max(0, Math.round(clock() - started));
    throw new Error([
      'ORION_BACKUP_DIAG', stage, reason,
      snapshot?.totalDocuments || 0,
      snapshot?.totalBytes || 0,
      uploaded.length, elapsed,
      Number(String(error?.message || '').match(
        /^OrionExportedDocumentTooLarge:(\d{1,12})$/
      )?.[1] || 0)
    ].join('|'));
  }
}

// Import deliberately takes an already-selected isolated target database.
// It never accepts a production connection URL or drops any database.
export async function restoreBackupToEmptyDatabase({ bucket, manifestKey, targetDb }) {
  if (!/^db-backups\/[0-9TZ._-]+-[a-f0-9]{8}\/manifest\.json$/.test(manifestKey)) {
    throw new Error('Invalid manifest path');
  }
  if (!targetDb?.databaseName?.startsWith('orion_restore_test_')) {
    throw new Error('Restoration requires an isolated orion_restore_test_ database');
  }
  const object = await bucket.get(manifestKey);
  if (!object) throw new Error('Backup manifest not found');
  const manifest = JSON.parse(await object.text());
  validateBackupManifest(manifest);
  for (const col of manifest.collections) {
    if (col.parts.some((p) => !p.key.startsWith(manifestKey.slice(0, -'manifest.json'.length)))) {
      throw new Error('Manifest contains foreign backup parts');
    }
  }

  const before = await targetDb.listCollections({}, { nameOnly: true }).toArray();
  if (before.length) throw new Error('Target database must be empty');

  let restored = 0, size = 0, parts = 0;
  for (const col of manifest.collections) {
    // Recreate collection validators/options and indexes, not just documents.
    await targetDb.createCollection(col.name, col.options || {});
    let count = 0;
    for (const part of col.parts) {
      if (!part.key.startsWith(manifestKey.slice(0, -'manifest.json'.length))) {
        throw new Error('Backup object escaped manifest prefix');
      }
      const chunk = await bucket.get(part.key);
      if (!chunk) throw new Error('Missing backup part');
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      if (bytes.byteLength !== part.bytes || await sha256(bytes) !== part.sha256) {
        throw new Error('Corrupted backup part');
      }
      const lines = new TextDecoder().decode(bytes).trimEnd().split('\n');
      const documents = lines.filter(Boolean).map((line) => EJSON.parse(line, { relaxed: false }));
      if (documents.length) await targetDb.collection(col.name).insertMany(documents, { ordered: true });
      count += documents.length;
      restored += documents.length;
      size += bytes.byteLength;
      parts++;
    }
    if (count !== col.count) throw new Error('Backup collection count mismatch');
    if (col.indexes?.length) await targetDb.collection(col.name).createIndexes(col.indexes);
  }
  if (restored !== manifest.totals.documents || size !== manifest.totals.bytes ||
    parts !== manifest.totals.parts) throw new Error('Backup aggregate mismatch');
  return { restored, collections: manifest.collections.length, parts };
}
