import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
import { BrainMemory, BrainSource, BrainDocument, BrainRevision } from '../models/brain.js';
import { BrainSyncReceipt, BrainCredential, BrainConnection } from '../models/brainSync.js';
import { syncSchema as legacySyncSchema } from '../services/brain/sync.js';
import { syncBrainKnowledge, brainSyncSchema } from '../cloudflare/bananaboom-worker/src/brainVaultWrite.js';
import { getBrainPrivateObject } from '../cloudflare/bananaboom-worker/src/brainPrivateStorage.js';
import { readBrainMemory, searchBrainMemories, BRAIN_API_RESOURCE, BRAIN_MCP_RESOURCE } from '../cloudflare/bananaboom-worker/src/brainRead.js';
import { createHash } from 'node:crypto';
const {MongoClient,ObjectId}=mongodb;

assert.equal(BrainMemory.collection.name,'brainmemories');
assert.equal(BrainSource.collection.name,'brainsources');
assert.equal(BrainDocument.collection.name,'braindocuments');
assert.equal(BrainRevision.collection.name,'brainrevisions');
assert.equal(BrainCredential.collection.name,'braincredentials');
assert.equal(BrainConnection.collection.name,'brainconnections');
assert.equal(BrainSyncReceipt.collection.name,'brainsyncreceipts');

const schemaSamples=[
  {requestId:'test-request-alpha-01',statement:'  Date unknown & user stated  ',
   type:'preference',tags:['test'],sensitivity:'restricted'},
  {requestId:'test-request-beta-02',statement:'知识测试',eventAt:null,note:'unverified'},
  {requestId:'test-request-gamma-03',statement:'A'}];
for (const input of schemaSamples) {
  const old=legacySyncSchema.parse(input);
  const now=brainSyncSchema.parse(input);
  assert.deepEqual(now,old,'input normalization/hash parity required');
}
console.log('PASS legacy vs Worker sync schema/collection parity');

const replica=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});
const uri=replica.getUri();
if(!/^(mongodb:\/\/|mongodb\+srv:\/\/)(127\.0\.0\.1|localhost)/.test(uri)) {
  await replica.stop();
  throw new Error('Refuse any non-local MongoDB URI');
}
const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
try {
  await client.connect();
  const db=client.db('orion_brain_sync_worker_isolated_'+Date.now());
  const owner=new ObjectId();
  const other=new ObjectId();
  const connId=new ObjectId();
  const foreignConnId=new ObjectId();
  const apiToken='ov_'+'A'.repeat(43);
  const foreignToken='ov_'+'B'.repeat(43);
  const secret='synthetic private encryption key with enough length for testing 2026';
  const future=new Date(Date.now()+86400000);
  const hash=token=>createHash('sha256').update(token).digest('hex');

  await db.collection('users').insertMany([
    {_id:owner,role:'owner',extraPermissions:[]},
    {_id:other,role:'owner',extraPermissions:[]}
  ]);
  await db.collection('roles').insertOne({name:'owner',permissions:['BRAIN:USE']});
  await db.collection('brainconnections').insertMany([
    {_id:connId,ownerId:owner,kind:'api-key',provider:'chatgpt',label:'synthetic GPT',
     resource:BRAIN_API_RESOURCE,scopes:['memory:read','memory:write'],expiresAt:future,revokedAt:null},
    {_id:foreignConnId,ownerId:other,kind:'api-key',provider:'claude',label:'synthetic Claude',
     resource:BRAIN_API_RESOURCE,scopes:['memory:read','memory:write'],expiresAt:future,revokedAt:null}
  ]);
  await db.collection('braincredentials').insertMany([
    {hash:hash(apiToken),connectionId:connId,kind:'access',scopes:['memory:read','memory:write'],expiresAt:future},
    {hash:hash(foreignToken),connectionId:foreignConnId,kind:'access',scopes:['memory:read','memory:write'],expiresAt:future}
  ]);
  await db.collection('brainsyncreceipts').createIndex({
    ownerId:1,connectionId:1,requestId:1
  },{unique:true});
  await db.collection('brainsources').createIndex({
    ownerId:1,provider:1,originalSha256:1
  },{unique:true});
  await db.collection('braindocuments').createIndex({
    ownerId:1,stableKey:1,contentSha256:1
  },{unique:true});
  await db.collection('brainrevisions').createIndex({
    ownerId:1,memoryId:1,revisionNumber:1
  },{unique:true});

  const objects=new Map();
  const bucket={
    async get(key) {
      const bytes=objects.get(key);
      if(!bytes) return null;
      return {size:bytes.length,
        arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    },
    async put(key,bytes) {
      const data=Buffer.from(bytes);
      assert.ok(data.subarray(0,8).equals(Buffer.from('ORIONV1\n')));
      assert.equal(data.includes(Buffer.from('Synthetic preference')),false);
      objects.set(key,data);
    }
  };
  const config={client,db,bucket,secret};
  const packet={requestId:'synced-first-00001',statement:' Synthetic preference, unverified ',
    type:'preference',tags:['design'],sensitivity:'restricted',eventAt:null};

  const first=await syncBrainKnowledge(config,apiToken,packet);
  assert.equal(first.created,true);
  assert.equal(first.memory.statement,'Synthetic preference, unverified');
  assert.equal(first.memory.type,'preference');
  assert.equal(first.memory.sensitivity,'restricted');
  assert.equal(first.memory.revision,1);
  assert.equal(first.memory.reviewStatus,'candidate');

  const receipt=await db.collection('brainsyncreceipts').findOne({ownerId:owner,connectionId:connId});
  assert.ok(receipt);
  assert.equal(receipt.payloadHash,hash(JSON.stringify(legacySyncSchema.parse(packet))));
  const source=await db.collection('brainsources').findOne({ownerId:owner});
  const original=await getBrainPrivateObject({bucket,secret},String(owner),source.privateObjectKey);
  const payload=JSON.parse(original.toString('utf8'));
  assert.equal(payload.statement,first.memory.statement);
  assert.equal(payload.connectionId,String(connId));
  assert.equal(payload.format,'orion-sync-1');
  assert.equal(source.metadata.documentIds.length,1);
  const doc=await db.collection('braindocuments').findOne({ownerId:owner});
  assert.equal(doc.rawText,first.memory.statement);
  assert.equal(doc.rawJsonRef,'original#/statement');
  const revisions=await db.collection('brainrevisions').find({ownerId:owner}).toArray();
  assert.equal(revisions.length,1);
  assert.equal(revisions[0].revisionNumber,1);
  assert.equal(revisions[0].action,'create');

  const retried=await syncBrainKnowledge(config,apiToken,packet);
  assert.deepEqual(retried,first);
  assert.equal(await db.collection('brainmemories').countDocuments({ownerId:owner}),1);
  assert.equal(await db.collection('braindocuments').countDocuments({ownerId:owner}),1);
  assert.equal(objects.size,1);
  await assert.rejects(syncBrainKnowledge(config,apiToken,{...packet,statement:'changed'}),
    e=>e.message==='IDEMPOTENCY_CONFLICT' && e.status===409);
  await assert.rejects(readBrainMemory(db,foreignToken,first.memory._id),
    e=>e.status===404);
  await assert.rejects(syncBrainKnowledge(config,foreignToken,{...packet,
    requestId:'try-cross-owner-01',memoryId:first.memory._id,expectedRevision:1}),
    e=>e.status===404);
  const correction={
    requestId:'synced-update-00002',statement:'Corrected synthetic preference',
    memoryId:first.memory._id,expectedRevision:1,eventAt:'2026-11-07',
    note:'Explicitly corrected by owner'
  };
  const updated=await syncBrainKnowledge(config,apiToken,correction);
  assert.equal(updated.created,false);
  assert.equal(updated.memory._id,first.memory._id);
  assert.equal(updated.memory.revision,2);
  assert.equal(updated.memory.statement,'Corrected synthetic preference');
  assert.equal(updated.memory.type,'preference');
  assert.equal(updated.memory.sensitivity,'restricted');
  assert.deepEqual(updated.memory.tags,['design']);
  assert.equal(updated.memory.reviewStatus,'candidate');
  assert.notEqual(updated.memory.sourceId,first.memory.sourceId);
  assert.equal(await db.collection('brainsources').countDocuments({ownerId:owner}),2);
  assert.equal(await db.collection('brainrevisions').countDocuments({ownerId:owner}),2);
  assert.equal(objects.size,2);
  const queried=await searchBrainMemories(db,apiToken,{query:'corrected'});
  assert.equal(queried.items.length,1);
  assert.equal(queried.items[0]._id,first.memory._id);
  await assert.rejects(syncBrainKnowledge(config,apiToken,{
    ...correction,requestId:'stale-update-00003'
  }),e=>e.message==='REVISION_CONFLICT' && e.status===409);
  await assert.rejects(syncBrainKnowledge(config,apiToken,{
    ...correction,requestId:'missing-version-04',expectedRevision:undefined
  }),e=>e.message==='EXPECTED_REVISION_REQUIRED' && e.status===400);
  await assert.rejects(syncBrainKnowledge(config,apiToken,{
    ...correction,requestId:'owner-forgery-05',ownerId:String(other)
  }),e=>e.message==='INVALID_SYNC_INPUT' && e.status===400);
  const apiKeyWrite=await db.collection('brainconnections').findOne({_id:connId});
  assert.ok(apiKeyWrite.lastWriteAt instanceof Date);

  // Two exact duplicate submissions at the same time must commit only one
  // source/document/memory/revision/receipt, using the same receipt result.
  const parallel={requestId:'simultaneous-save-0001',
    statement:'Synthetic concurrent memory save',type:'fact'};
  const simultaneous=await Promise.all([
    syncBrainKnowledge(config,apiToken,parallel),
    syncBrainKnowledge(config,apiToken,parallel)
  ]);
  assert.deepEqual(simultaneous[0],simultaneous[1]);
  assert.equal(await db.collection('brainmemories').countDocuments({ownerId:owner}),2);
  assert.equal(await db.collection('brainsyncreceipts').countDocuments({ownerId:owner}),3);
  assert.equal(await db.collection('brainrevisions').countDocuments({ownerId:owner}),3);
  assert.equal(objects.size,3);

  await db.collection('roles').updateOne({name:'owner'},{$set:{permissions:[]}});
  await assert.rejects(syncBrainKnowledge(config,apiToken,{
    requestId:'permission-revoked-01',statement:'deny'
  }),e=>e.status===403);
  await db.collection('roles').updateOne({name:'owner'},{$set:{permissions:['BRAIN:USE']}});
  await db.collection('brainconnections').updateOne({_id:connId},{$set:{revokedAt:new Date()}});
  await assert.rejects(syncBrainKnowledge(config,apiToken,{
    requestId:'connection-revoked-01',statement:'deny'
  }),e=>e.status===401);
  await db.dropDatabase();
  console.log('PASS: isolated native MongoDB transaction + exact legacy encrypted object + receipt idempotency + revision + foreign-owner denial + permissions');
  console.log('TEST_REVISION_RECORDS',3,'PRIVATE_ENCRYPTED_OBJECTS',objects.size,'NO_PRODUCTION_WRITE');
}finally {
  await client.close();
  await replica.stop();
}
