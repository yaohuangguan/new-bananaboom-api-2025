import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
import {
  restoreBackupToEmptyDatabase,
  validateBackupManifest
} from '../cloudflare/bananaboom-worker/src/databaseBackup.js';

const { MongoClient } = mongodb;
const workerDir = fileURLToPath(new URL('../cloudflare/bananaboom-worker/', import.meta.url));
const wrangler = path.join(workerDir, 'node_modules/wrangler/bin/wrangler.js');
const bucketName = 'orion-private-db-backups';
const manifestKey = process.argv[2];
const onlyManifest = process.argv.includes('--manifest-only');
if (!/^db-backups\/[0-9TZ._-]+-[a-f0-9]{8}\/manifest\.json$/.test(manifestKey || '')) {
  throw new Error('Invalid manifest key; no remote access performed');
}

// Fetch via Wrangler's already authenticated read-only R2 CLI. Never save
// private production objects as files or print object contents.
async function remoteObject(key) {
  if (!key.startsWith('db-backups/') || key.includes('..')) {
    throw new Error('Unsafe private R2 key');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      wrangler, 'r2', 'object', 'get', bucketName + '/' + key,
      '--remote', '--pipe'
    ], { cwd: workerDir, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, FORCE_COLOR: '0'
    } });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 45000);
    child.stdout.on('data', (buf) => {
      size += buf.byteLength;
      if (size > 50 * 1024 * 1024) child.kill();
      else chunks.push(buf);
    });
    // Never print stderr or raw output: errors could contain private data.
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Private R2 CLI failed to start'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || size > 50 * 1024 * 1024) {
        reject(new Error('Private R2 read failed or hit byte/time limit'));
      } else resolve(Buffer.concat(chunks));
    });
  });
}

function bucketObject(data) {
  return {
    text: async () => data.toString('utf8'),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  };
}

let phase = 'manifest';
async function main() {
  const rawManifest = await remoteObject(manifestKey);
  let manifest;
  try {
    manifest = JSON.parse(rawManifest.toString('utf8'));
    validateBackupManifest(manifest);
  } catch {
    throw new Error('Manifest retrieval or format failed');
  }
  const prefix = manifestKey.slice(0, -'manifest.json'.length);
  const parts = manifest.collections.flatMap((col) => col.parts);
  assert.equal(parts.length, manifest.totals.parts);
  for (const part of parts) assert.ok(part.key.startsWith(prefix));
  console.log('Private manifest verified: collections=' +
    manifest.collections.length + ', documents=' + manifest.totals.documents +
    ', parts=' + parts.length + ', bytes=' + manifest.totals.bytes);
  if (onlyManifest) return;

  phase = 'sha256-fetch';
  const cache = new Map([[manifestKey, rawManifest]]);
  for (let i = 0; i < parts.length; i += 3) {
    await Promise.all(parts.slice(i, i + 3).map(async (part) => {
      const buf = await remoteObject(part.key);
      if (buf.byteLength !== part.bytes ||
          createHash('sha256').update(buf).digest('hex') !== part.sha256) {
        throw new Error('Private backup SHA-256 or byte count mismatch');
      }
      cache.set(part.key, buf);
    }));
  }
  assert.equal(cache.size, parts.length + 1);
  console.log('PASS: every private R2 part verified by bytes + SHA-256');

  phase = 'isolated-restore';
  let replica, client;
  try {
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' }
    });
    const uri = replica.getUri();
    if (!uri.includes('127.0.0.1') && !uri.includes('localhost')) {
      throw new Error('Isolated local Mongo URI guard failed');
    }
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const target = client.db('orion_restore_test_' + Date.now());
    const inMemoryBucket = {
      get: async (key) => cache.has(key) ? bucketObject(cache.get(key)) : null
    };
    const restored = await restoreBackupToEmptyDatabase({
      bucket: inMemoryBucket, manifestKey, targetDb: target
    });
    assert.equal(restored.restored, manifest.totals.documents);
    assert.equal(restored.collections, manifest.collections.length);
    assert.equal(restored.parts, manifest.totals.parts);
    let indexCount = 0;
    for (const col of manifest.collections) {
      assert.equal(await target.collection(col.name).countDocuments({}), col.count);
      const indexes = await target.collection(col.name).listIndexes().toArray();
      for (const expected of (col.indexes || [])) {
        assert.ok(indexes.some((idx) => idx.name === expected.name));
        indexCount++;
      }
    }
    console.log('PASS: isolated local restore; documents=' + restored.restored +
      ', collections=' + restored.collections + ', parts=' + restored.parts +
      ', secondaryIndexes=' + indexCount);
    await target.dropDatabase();
  } finally {
    if (client) await client.close();
    if (replica) await replica.stop();
    cache.clear();
  }
}

main().catch((error) => {
  // Only print a fixed stage and error type, never raw document contents.
  console.error('Private R2 verification FAILED at ' + phase + ' (' +
    (error?.name === 'AssertionError' ? 'assertion' : 'operation') + ')');
  process.exitCode = 1;
});
