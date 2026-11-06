import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
import { createHash } from 'node:crypto';
import { BrainMemory } from '../models/brain.js';
import { BrainCredential, BrainConnection } from '../models/brainSync.js';
import { searchFilter as legacySearchFilter } from '../services/brain/core.js';
import assert from 'node:assert/strict';
import {
  BRAIN_API_RESOURCE, BRAIN_MCP_RESOURCE,
  verifyBrainReadConnection, brainSearchFilter,
  readBrainMemory, searchBrainMemories
} from '../cloudflare/bananaboom-worker/src/brainRead.js';

const {MongoClient,ObjectId}=mongodb;
assert.equal(BrainMemory.collection.name,'brainmemories');
assert.equal(BrainConnection.collection.name,'brainconnections');
assert.equal(BrainCredential.collection.name,'braincredentials');
for(const word of ['', 'a', '知识', 'AI', 'A.*B', '你好世界', 'very long text']) {
  assert.deepEqual(brainSearchFilter(word),legacySearchFilter(word));
}
const replica=await MongoMemoryReplSet.create({
  replSet:{count:1,storageEngine:'wiredTiger'}
});
const uri=replica.getUri();
if (!uri.includes('127.0.0.1') && !uri.includes('localhost')) {
  await replica.stop();
  throw new Error('Only ephemeral localhost MongoDB is allowed');
}
const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
try {
  await client.connect();
  const db=client.db('orion_brain_worker_test_'+Date.now());
  const owner=new ObjectId();
  const other=new ObjectId();
  const connId=new ObjectId();
  const token='ov_'+'L'.repeat(43);
  const hash=createHash('sha256').update(token).digest('hex');
  const future=new Date(Date.now()+86400000);
  const memoryId=new ObjectId();
  const foreignMemoryId=new ObjectId();
  await db.collection('users').insertMany([
    {_id:owner,role:'user',extraPermissions:[]},
    {_id:other,role:'user',extraPermissions:[]}
  ]);
  await db.collection('roles').insertOne({
    name:'user',permissions:['BRAIN:USE']
  });
  await db.collection('brainconnections').insertOne({
    _id:connId,ownerId:owner,kind:'api-key',resource:BRAIN_API_RESOURCE,
    provider:'chatgpt',scopes:['memory:read','memory:write'],
    expiresAt:future,revokedAt:null
  });
  await db.collection('braincredentials').insertOne({
    hash,connectionId:connId,kind:'access',
    scopes:['memory:read'],expiresAt:future
  });
  await db.collection('brainmemories').insertMany([
    {_id:memoryId,ownerId:owner,statement:'Verified original note',
      type:'fact',revision:2,deletedAt:null,reviewStatus:'candidate',
      normalizedText:'verified original note',
      searchGrams:brainSearchFilter('Verified').searchGrams.$all,
      privateObjectKey:'never-expose-storage-key'},
    {_id:foreignMemoryId,ownerId:other,statement:'Different owner private note',
      type:'fact',revision:1,deletedAt:null,reviewStatus:'candidate'}
  ]);

  const authorization=await verifyBrainReadConnection(db,token,BRAIN_API_RESOURCE);
  assert.equal(String(authorization.ownerId),String(owner));
  assert.deepEqual(authorization.scopes,['memory:read']);
  const results=await searchBrainMemories(db,token,{
    query:'Verified',type:'fact',limit:20
  });
  assert.equal(results.items.length,1);
  assert.equal(String(results.items[0]._id),String(memoryId));
  assert.equal(results.items[0].privateObjectKey,undefined);
  assert.equal(results.items[0].normalizedText,undefined);
  const individual=await readBrainMemory(db,token,String(memoryId));
  assert.equal(individual.revision,2);
  await assert.rejects(readBrainMemory(db,token,String(foreignMemoryId)),
    error=>error.status===404);
  await assert.rejects(readBrainMemory(db,token,String(memoryId),BRAIN_MCP_RESOURCE),
    error=>error.status===401);
  const updated=await db.collection('brainconnections').findOne({_id:connId});
  assert.ok(updated.lastUsedAt instanceof Date);

  await db.collection('roles').updateOne({name:'user'},{$set:{permissions:[]}});
  await assert.rejects(readBrainMemory(db,token,String(memoryId)),
    error=>error.status===403);
  await db.collection('roles').updateOne({name:'user'},{$set:{permissions:['BRAIN:USE']}});
  await db.collection('brainconnections').updateOne({_id:connId},{$set:{revokedAt:new Date()}});
  await assert.rejects(readBrainMemory(db,token,String(memoryId)),
    error=>error.status===401);

  await db.dropDatabase();
  console.log('PASS: actual isolated MongoDB Brain vault auth, owner-scoped search/read, token-resource, live permission and revocation');
} finally {
  await client.close();
  await replica.stop();
}
