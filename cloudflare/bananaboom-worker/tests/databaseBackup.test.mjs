import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createDatabaseBackup, restoreBackupToEmptyDatabase, validateBackupManifest, classifyBackupFailure, parseBackupDiagnostic } from '../src/databaseBackup.js';

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
  }), /document-limit/);
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


test('all R2 side effects occur after transaction succeeds, with manifest uploaded last', async () => {
  let transactionActive = false;
  let transactionAttempts = 0;
  const source = fakeSource({
    posts: [{_id:new ObjectId(), title:'A'}],
    users: [{_id:new ObjectId(), email:'safe@example.invalid'}]
  });
  source.client.withSession = async (fn) => fn({
    withTransaction: async (run) => {
      transactionActive = true;
      transactionAttempts++;
      try {
        // Driver's first callback can be retried after transient error.
        await run();
        return await run();
      } finally {
        transactionActive = false;
      }
    }
  });
  const b = bucket(), puts = [];
  const originalPut = b.put;
  b.put = async (key, bytes, options) => {
    assert.equal(transactionActive, false, 'R2 must not run inside Mongo snapshot');
    puts.push(key);
    return originalPut(key, bytes, options);
  };
  const snapshot = await createDatabaseBackup({...source, bucket:b});
  assert.equal(transactionAttempts, 1);
  assert.equal(snapshot.documents, 2, 'transaction retry must not double count');
  assert.equal(snapshot.collections, 2);
  assert.equal(puts.length, 3);
  assert.equal(puts.at(-1), snapshot.manifestKey);
  const manifest = JSON.parse(new TextDecoder().decode(b.map.get(snapshot.manifestKey)));
  assert.equal(manifest.totals.documents, 2);
  assert.equal(manifest.totals.parts, 2);
});

test('staging memory cap fails before any R2 PUT, without partial backup', async () => {
  const b = bucket();
  await assert.rejects(createDatabaseBackup({
    ...fakeSource({ users: [{_id:new ObjectId(), name:'large-memory-record'}] }),
    bucket:b, maxStagedBytes:1
  }), /memory-staging-limit/);
  assert.equal(b.map.size, 0);
});

test('failed concurrent chunk upload waits for all in-flight writes then cleans them up', async () => {
  const b = bucket();
  const originalPut = b.put;
  b.put = async (key, bytes, options) => {
    if (key.includes('/users/')) throw new Error('simulated upload interruption');
    return originalPut(key, bytes, options);
  };
  await assert.rejects(createDatabaseBackup({
    ...fakeSource({
      users:[{_id:new ObjectId(),name:'Sam'}],
      posts:[{_id:new ObjectId(),title:'Private'}]
    }), bucket:b
  }), /r2-operation/);
  assert.equal(b.map.size,0,'no chunks or false-complete manifest should remain');
});

test('ambiguous manifest upload is removed before already uploaded chunks', async () => {
  const b=bucket();
  const originalPut=b.put;
  const deletes=[];
  const originalDelete=b.delete;
  b.delete=async (key) => {
    deletes.push(key);
    return originalDelete(key);
  };
  b.put=async (key,bytes,options) => {
    await originalPut(key,bytes,options);
    if (key.endsWith('/manifest.json')) throw new Error('response lost after manifest write');
  };
  await assert.rejects(createDatabaseBackup({
    ...fakeSource({posts:[{_id:new ObjectId(),title:'A'}]}),
    bucket:b
  }), /unknown-error/);
  assert.equal(b.map.size,0);
  assert.ok(deletes[0].endsWith('/manifest.json'),'remove completion marker before chunks');
});


test('snapshot and R2 upload obey separate 50s and 120s budgets', async () => {
  let elapsed = 0;
  const source = fakeSource({users:[{_id:new ObjectId(),name:'safe'}]});
  source.client.withSession = async (fn) => fn({
    withTransaction: async (run) => {
      const outcome=await run();
      elapsed=45000;
      return outcome;
    }
  });
  const b=bucket();
  const put=b.put;
  b.put=async (key,bytes,options) => {
    assert.equal(elapsed>=45000,true);
    elapsed=65000;
    return put(key,bytes,options);
  };
  const result=await createDatabaseBackup({
    ...source,bucket:b,clock:()=>elapsed,
    maxSnapshotMs:50000,maxRuntimeMs:120000
  });
  assert.equal(result.success,true);
  assert.ok(b.map.has(result.manifestKey));
});

test('safe backup failure message transmits only recognized stage and counters',async()=>{
  const source=fakeSource({users:[{_id:new ObjectId(),name:'secret'}]});
  let elapsed=0;
  source.client.withSession=async(fn)=>fn({
    withTransaction:async(run)=>{
      elapsed=60000;
      return run();
    }
  });
  const b=bucket();
  await assert.rejects(createDatabaseBackup({
    ...source,bucket:b,clock:()=>elapsed,maxSnapshotMs:50000,maxRuntimeMs:120000
  }),error=>{
    const safe=parseBackupDiagnostic(error);
    assert.equal(safe?.stage,'snapshot');
    assert.equal(safe?.reason,'snapshot-runtime-limit');
    assert.equal(safe?.documents,0);
    assert.equal(String(error.message).includes('secret'),false);
    return true;
  });
  assert.equal(b.map.size,0);
  assert.equal(parseBackupDiagnostic(new Error('password=hidden')),null);
});


test('a >2 MiB canonical EJSON document forms a valid single oversized part',async()=>{
  const large='Z'.repeat(2200*1024);
  const b=bucket();
  const result=await createDatabaseBackup({
    ...fakeSource({brain:[{_id:new ObjectId(),content:large}]}),bucket:b
  });
  assert.equal(result.success,true);
  assert.equal(result.documents,1);
  const m=JSON.parse(new TextDecoder().decode(b.map.get(result.manifestKey)));
  assert.equal(m.collections[0].parts.length,1);
  assert.ok(m.collections[0].parts[0].bytes>2*1024*1024);
  const dest=target();
  const restored=await restoreBackupToEmptyDatabase({
    bucket:b,manifestKey:result.manifestKey,targetDb:dest.db
  });
  assert.equal(restored.restored,1);
  assert.equal(dest.rows.get('brain')[0].content,large);
});

test('oversized EJSON documents fail safely with numeric-only size diagnostic',async()=>{
  const b=bucket();
  await assert.rejects(createDatabaseBackup({
    ...fakeSource({notes:[{_id:new ObjectId(),content:'secret private note'}]}),
    bucket:b,maxSingleDocumentBytes:64
  }),error=>{
    const info=parseBackupDiagnostic(error);
    assert.equal(info?.stage,'snapshot');
    assert.equal(info?.reason,'single-document-limit');
    assert.ok(info.exportedDocumentBytes>64);
    assert.equal(String(error.message).includes('secret'),false);
    return true;
  });
  assert.equal(b.map.size,0);
});


test('document byte count survives Mongo transaction Error reconstruction',async()=>{
  const source=fakeSource({notes:[{_id:new ObjectId(),content:'confidential'}]});
  source.client.withSession=async(fn)=>fn({
    withTransaction:async(run)=>{
      try{return await run();}catch(error){throw new Error(error.message);}
    }
  });
  await assert.rejects(createDatabaseBackup({
    ...source,bucket:bucket(),maxSingleDocumentBytes:32
  }),error=>{
    const diag=parseBackupDiagnostic(error);
    assert.equal(diag?.reason,'single-document-limit');
    assert.ok(diag?.exportedDocumentBytes>32);
    assert.equal(error.message.includes('confidential'),false);
    return true;
  });
});
