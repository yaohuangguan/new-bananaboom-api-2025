import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createDatabaseBackup, restoreBackupToEmptyDatabase, validateBackupManifest, classifyBackupFailure } from '../src/databaseBackup.js';

function bucket() {
  const map = new Map();
  return {
    map,
    async put(key, bytes) {
      map.set(key, new Uint8Array(bytes));
    },
    async get(key) {
      const bytes = map.get(key);
      return bytes ? {
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      } : null;
    },
    async delete(key) { map.delete(key); }
  };
}

function fakeSource(values) {
  const names = Object.keys(values);
  const db = {
    databaseName: 'orion_backup_test',
    listCollections: () => ({
      toArray: async () => names.map((name) => ({ name }))
    }),
    collection: (name) => ({
      listIndexes: () => ({toArray: async () => [{name:'_id_', key:{_id:1}}]}),
      find: () => ({
        sort: () => ({
          async *[Symbol.asyncIterator]() {
            for (const doc of values[name]) yield doc;
          }
        })
      })
    })
  };
  const client = {
    withSession: async (fn) => fn({
      withTransaction: async (f) => f()
    })
  };
  return { db, client };
}

function target() {
  const rows = new Map();
  const db = {
    databaseName: 'orion_restore_test_isolated',
    listCollections: () => ({
      toArray: async () => [...rows.keys()].map((name) => ({name}))
    }),
    createCollection: async (name) => { rows.set(name, []); },
    collection: (name) => ({
      createIndexes: async () => [],
      insertMany: async (documents) => {
        if (!rows.has(name)) rows.set(name, []);
        rows.get(name).push(...documents);
      }
    })
  };
  return { db, rows };
}

test('full EJSON dump and isolated restore retain BSON, collection counts, checksums', async () => {
  const id = new ObjectId();
  const sample = {
    users: [{ _id: id, name: 'sam', createdAt: new Date('2025-02-01T01:02:03Z') }],
    posts: [{ _id: new ObjectId(), tags: ['记录', 'test'], user: id }],
    empty_collection: []
  };
  const b = bucket(), source = fakeSource(sample);
  const result = await createDatabaseBackup({
    ...source, bucket: b,
    now: () => new Date('2026-11-06T01:00:00.000Z'),
    randomId: () => '01234567-aaaa-4444-8888-123456789000'
  });
  assert.equal(result.success, true);
  assert.equal(result.documents, 2);
  assert.equal(result.collections, 3);
  assert.ok(b.map.has(result.manifestKey));
  const manifest = JSON.parse(new TextDecoder().decode(b.map.get(result.manifestKey)));
  assert.equal(validateBackupManifest(manifest), true);
  const isolated = target();
  const restored = await restoreBackupToEmptyDatabase({
    bucket: b, manifestKey: result.manifestKey, targetDb: isolated.db
  });
  assert.deepEqual(restored, { restored: 2, collections: 3, parts: 2 });
  assert.ok(isolated.rows.get('users')[0]._id.equals(id));
  assert.ok(isolated.rows.get('users')[0].createdAt instanceof Date);
  assert.deepEqual(isolated.rows.get('posts')[0].tags, ['记录','test']);
  assert.equal(isolated.rows.get('empty_collection').length, 0);
});

test('corrupted parts never restore; non-isolated database forbidden', async () => {
  const b = bucket(), source = fakeSource({ users: [{ _id: new ObjectId() }] });
  const summary = await createDatabaseBackup({ ...source, bucket: b });
  await assert.rejects(restoreBackupToEmptyDatabase({
    bucket: b, manifestKey: summary.manifestKey,
    targetDb: {...target().db, databaseName: 'production'}
  }), /isolated/);
  const manifest = JSON.parse(new TextDecoder().decode(b.map.get(summary.manifestKey)));
  const chunk = manifest.collections[0].parts[0].key;
  b.map.set(chunk, new TextEncoder().encode('corrupted data'));
  await assert.rejects(restoreBackupToEmptyDatabase({
    bucket: b, manifestKey: summary.manifestKey, targetDb: target().db
  }), /Corrupted backup part/);
});

test('backup guard aborts oversized exports without committing manifest or leaving chunks', async () => {
  const b = bucket(), source = fakeSource({ posts: [
    { _id: new ObjectId(), name: 'one' },
    { _id: new ObjectId(), name: 'two' }
  ] });
  await assert.rejects(createDatabaseBackup({
    ...source, bucket: b, maxDocuments: 1
  }), /document limit/);
  assert.equal(b.map.size, 0);
});

test('no empty or unsafe database names and invalid manifests', async () => {
  assert.throws(() => validateBackupManifest({complete:false}), /Invalid/);
  await assert.rejects(createDatabaseBackup({
    ...fakeSource({}), bucket: bucket()
  }), /No database collections/);
  await assert.rejects(createDatabaseBackup({
    ...fakeSource({ users:[], USERS:[] }), bucket: bucket()
  }), /collide/);
});


test('catalog queries must run outside transaction while document reads stay inside', async () => {
  let inTransaction = false, readsInTransaction = 0;
  const source = fakeSource({
    users: [{ _id: new ObjectId(), email: 'sample@invalid.test' }]
  });
  const originalCollection = source.db.collection;
  source.db.collection = (name) => {
    const col = originalCollection(name);
    return {
      ...col,
      listIndexes: () => ({
        toArray: async () => {
          assert.equal(inTransaction, false, 'MongoDB forbids listIndexes in transactions');
          return [
            {name:'_id_', key:{_id:1}},
            {name:'email_1', key:{email:1}, unique:true}
          ];
        }
      }),
      find: () => ({
        sort: () => ({
          async *[Symbol.asyncIterator]() {
            assert.equal(inTransaction, true, 'data read must use consistent transaction');
            readsInTransaction++;
            yield { _id: new ObjectId(), email: 'sample@invalid.test' };
          }
        })
      })
    };
  };
  source.client.withSession = async (fn) => fn({
    withTransaction: async (run) => {
      inTransaction = true;
      try { return await run(); } finally { inTransaction = false; }
    }
  });
  const b = bucket();
  const summary = await createDatabaseBackup({...source, bucket:b});
  assert.equal(summary.success, true);
  assert.equal(readsInTransaction, 1);
  const manifest = JSON.parse(new TextDecoder().decode(b.map.get(summary.manifestKey)));
  assert.deepEqual(manifest.collections[0].indexes, [
    {name:'email_1', key:{email:1}, unique:true}
  ]);
});


test('failure codes cannot echo secret-bearing raw messages', () => {
  assert.equal(classifyBackupFailure(new Error('Backup exceeded runtime limit')), 'runtime-limit');
  assert.equal(classifyBackupFailure(new Error('Backup exceeded document limit')), 'document-limit');
  assert.equal(classifyBackupFailure(new Error('Backup exceeded size limit')), 'total-size-limit');
  assert.equal(classifyBackupFailure(new Error('password=secret private note')), 'unknown-error');
  assert.equal(classifyBackupFailure({codeName:'OperationNotSupportedInTransaction'}),
    'mongodb-OperationNotSupportedInTransaction');
});
