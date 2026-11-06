import { BSON } from 'mongodb';
const { EJSON } = BSON;

const CHUNK_MAX_BYTES = 512 * 1024;
const MAX_BACKUP_BYTES = 60 * 1024 * 1024;
const MAX_DOCUMENTS = 50000;
const MAX_RUNTIME_MS = 40000;
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
  const known = {
    'No database collections to back up': 'empty-database',
    'Case-insensitive collection names collide': 'collection-name-collision',
    'Backup exceeded runtime limit': 'runtime-limit',
    'Backup exceeded document limit': 'document-limit',
    'Document too large for safe export': 'single-document-limit',
    'Backup exceeded size limit': 'total-size-limit',
    'Private backup R2 binding missing': 'missing-r2-binding'
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
  maxTotalBytes = MAX_BACKUP_BYTES,
  maxDocuments = MAX_DOCUMENTS
}) {
  if (!bucket || typeof bucket.put !== 'function') {
    throw new Error('Private backup R2 binding missing');
  }
  const started = Date.now();
  const snapshotAt = now().toISOString();
  const prefix = 'db-backups/' + snapshotAt.replace(/[:]/g, '-') + '-' + randomId().slice(0, 8);
  const list = await db.listCollections({}, { nameOnly: false }).toArray()
    .catch((error) => {
      logBackupDiagnostic('collection-catalog', error);
      throw error;
    });
  const collections = list.map((v) => v.name)
    .filter(safeCollection).sort();
  const metadata = new Map(list.map((v) => [v.name, v]));
  if (new Set(collections.map((v) => v.toLowerCase())).size !== collections.length) {
    throw new Error('Case-insensitive collection names collide');
  }
  if (collections.length === 0) throw new Error('No database collections to back up');

  // MongoDB forbids listIndexes inside a transaction. Capture the collection
  // catalog before the first snapshot read; document data remains read
  // consistently in the transaction that follows.
  const indexesByCollection = new Map(await Promise.all(collections.map(async (name) => {
    const collection = db.collection(name);
    return [name, collection.listIndexes ? await collection.listIndexes().toArray() : []];
  })).catch((error) => {
    logBackupDiagnostic('index-catalog', error);
    throw error;
  }));


  const uploaded = [];
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

  let stage = 'snapshot';
  try {
    await client.withSession(async (session) => {
      await session.withTransaction(async () => {
        for (const name of collections) {
          const collection = db.collection(name);
          const rawIndexes = indexesByCollection.get(name) || [];
          const col = {
            name, count: 0, parts: [],
            options: metadata.get(name)?.options || {},
            indexes: rawIndexes.filter((idx) => idx.name !== '_id_')
              .map(({ name: indexName, key, ...options }) => {
                // MongoDB controls index version/ns; preserve the options
                // needed to rebuild uniqueness, TTLs and partial indexes.
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
            const index = col.parts.length;
            const key = prefix + '/' + name.toLowerCase() + '/' + String(index).padStart(5, '0') + '.ndjson';
            const bytes = encoder.encode(buffer.join(''));
            const hash = await sha256(bytes);
            await bucket.put(key, bytes, {
              httpMetadata: { contentType: 'application/x-ndjson' },
              customMetadata: { sha256: hash, encoding: 'MongoDB Extended JSON (canonical)' }
            });
            uploaded.push(key);
            col.parts.push({ key, bytes: bytes.byteLength, sha256: hash });
            buffer = [];
            buffered = 0;
          };
          const cursor = collection.find({}, {
            session, batchSize: 100
          }).sort({ _id: 1 });
          for await (const doc of cursor) {
            if (Date.now() - started > maxRuntimeMs) throw new Error('Backup exceeded runtime limit');
            if (++totalDocuments > maxDocuments) throw new Error('Backup exceeded document limit');
            const line = EJSON.stringify(doc, { relaxed: false }) + '\n';
            const length = encoder.encode(line).byteLength;
            if (length > CHUNK_MAX_BYTES) throw new Error('Document too large for safe export');
            if (totalBytes + length > maxTotalBytes) throw new Error('Backup exceeded size limit');
            if (buffered + length > CHUNK_MAX_BYTES) await flush();
            buffer.push(line);
            buffered += length;
            totalBytes += length;
            col.count++;
          }
          await flush();
        }
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
        maxCommitTimeMS: 10000
      });
    });
    manifest.totals = {
      documents: totalDocuments,
      bytes: totalBytes,
      parts: uploaded.length
    };
    validateBackupManifest(manifest);
    stage = 'manifest';
    const manifestKey = prefix + '/manifest.json';
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    await bucket.put(manifestKey, manifestBytes, {
      httpMetadata: { contentType: 'application/json' }
    });
    return {
      success: true,
      folder: prefix,
      manifestKey,
      totalFiles: uploaded.length + 1,
      collections: manifest.collections.length,
      documents: totalDocuments,
      bytes: totalBytes
    };
  } catch (error) {
    logBackupDiagnostic(stage, error, totalDocuments, totalBytes,
      uploaded.length, Date.now() - started);
    // Incomplete backups never have a committed manifest. Remove any
    // accidentally uploaded chunks to avoid retention bloat and ambiguity.
    try { await Promise.all(uploaded.map((key) => bucket.delete(key))); } catch {}
    throw error;
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
