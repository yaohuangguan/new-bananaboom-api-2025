import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  BRAIN_API_RESOURCE, BRAIN_MCP_RESOURCE, BrainReadError,
  verifyBrainReadConnection, brainAccessScopes, brainSearchFilter,
  searchBrainMemories, readBrainMemory, validateBrainSearch
} from '../src/brainRead.js';

const owner = new ObjectId();
const foreign = new ObjectId();
const connectionId = new ObjectId();
const token='ov_'+'A'.repeat(43);
const credentialHash=createHash('sha256').update(token).digest('hex');
const future=()=>new Date(Date.now()+86400000);
const old=()=>new Date(Date.now()-86400000);
const id1=new ObjectId('507f1f77bcf86cd799439011');
const id2=new ObjectId('507f1f77bcf86cd799439012');
const id3=new ObjectId('507f1f77bcf86cd799439013');
const sample=[
  {_id:id1,ownerId:owner,statement:'Hello world',revision:1,
   type:'fact',reviewStatus:'candidate',deletedAt:null,
   searchGrams:['g10'],normalizedText:'hello world',
   privateObjectKey:'should never escape'},
  {_id:id2,ownerId:owner,statement:'Next value',revision:2,
   type:'decision',reviewStatus:'confirmed',deletedAt:null},
  {_id:id3,ownerId:owner,statement:'Later value',revision:3,
   type:'fact',reviewStatus:'candidate',deletedAt:null}
];

function fakeDb({
  credentialExpiry=future(),connectionExpiry=future(),
  resource=BRAIN_API_RESOURCE, revoked=false, rolePermissions=['BRAIN:USE'],
  userExists=true, scopes=['memory:read','memory:write'],
  credentialScopes=['memory:read','memory:write'], memoryRows=sample,
  includeRecord=true
}={}) {
  const observed=[];
  const db={collection(name){
    if(name==='braincredentials')return {findOne:async(filter)=>{
      observed.push(['credential',filter]);
      assert.equal(filter.hash,credentialHash);
      assert.equal(filter.kind,'access');
      return credentialExpiry > new Date() ? {
        connectionId,scopes:credentialScopes,expiresAt:credentialExpiry
      }:null;
    }};
    if(name==='brainconnections')return {
      findOne:async(filter)=>{
        observed.push(['connection',filter]);
        assert.ok(filter._id.equals(connectionId));
        return revoked || connectionExpiry <= new Date() ? null : {
          _id:connectionId,ownerId:owner,expiresAt:connectionExpiry,
          revokedAt:null,resource,scopes,provider:'chatgpt'
        };
      },
      updateOne:async(filter,update)=>{
        observed.push(['update',filter,update]);
        assert.equal(filter.ownerId.toString(),owner.toString());
        assert.equal(update.$set.lastUsedAt instanceof Date,true);
      }
    };
    if(name==='users')return {findOne:async(filter)=>{
      observed.push(['user',filter]);
      assert.ok(filter._id.equals(owner));
      return userExists?{_id:owner,role:'user',extraPermissions:[]} : null;
    }};
    if(name==='roles')return {findOne:async(filter)=>{
      assert.equal(filter.name,'user');
      return {permissions:rolePermissions};
    }};
    if(name==='brainmemories')return {
      findOne:async(filter)=>{
        observed.push(['memory',filter]);
        assert.ok(filter.ownerId.equals(owner));
        assert.equal(filter.deletedAt,null);
        if(!includeRecord || !filter._id.equals(id1))return null;
        return memoryRows[0];
      },
      find:(filter,options)=>{
        observed.push(['find',filter,options]);
        assert.ok(filter.ownerId.equals(owner));
        assert.equal(filter.deletedAt,null);
        assert.deepEqual(filter.reviewStatus,{$ne:'rejected'});
        assert.equal(options.maxTimeMS,5000);
        return {
          sort:(order)=>{
            assert.deepEqual(order,{_id:1});
            return {limit:(count)=>({
              toArray:async()=>memoryRows.slice(0,count)
            })};
          }
        };
      }
    };
    throw new Error('Unexpected collection '+name);
  }};
  return {db,observed};
}

test('vault token uses hashed persisted credential and live permission, never caller ownerId',async()=>{
  const {db,observed}=fakeDb();
  const verified=await verifyBrainReadConnection(db,token,BRAIN_API_RESOURCE);
  assert.equal(verified.ownerId.toString(),owner.toString());
  assert.deepEqual(verified.scopes,['memory:read','memory:write']);
  assert.ok(observed.some(([kind])=>kind==='update'));
});

test('rejected, expired and revoked access cannot fetch owner knowledge',async()=>{
  for(const change of [
    {credentialExpiry:old()},
    {connectionExpiry:old()},
    {revoked:true},
    {resource:BRAIN_MCP_RESOURCE}
  ]){
    await assert.rejects(readBrainMemory(fakeDb(change).db,token,String(id1)),
      error=>error instanceof BrainReadError && error.status===401);
  }
  for(const change of [
    {userExists:false},
    {rolePermissions:[]}
  ]){
    await assert.rejects(brainAccessScopes(fakeDb(change).db,token,BRAIN_API_RESOURCE),
      error=>error instanceof BrainReadError && error.status===403);
  }
  for(const key of ['ov_short','Bearer '+token,'ov_'+'X'.repeat(44)]){
    await assert.rejects(brainAccessScopes(fakeDb().db,key,BRAIN_API_RESOURCE),
      error=>error instanceof BrainReadError && error.status===401);
  }
});

test('read scope is required even for owners with valid nonread credentials',async()=>{
  const source=fakeDb({scopes:['memory:write'],credentialScopes:['memory:write']});
  await assert.rejects(readBrainMemory(source.db,token,String(id1)),
    error=>error.message==='INSUFFICIENT_SCOPE' && error.status===403);
  await assert.rejects(searchBrainMemories(source.db,token,{}),
    error=>error.message==='INSUFFICIENT_SCOPE' && error.status===403);
});

test('resource audience isolates REST API keys from MCP OAuth credentials',async()=>{
  assert.deepEqual(await brainAccessScopes(fakeDb({resource:BRAIN_MCP_RESOURCE}).db,
    token,BRAIN_MCP_RESOURCE),['memory:read','memory:write']);
  await assert.rejects(brainAccessScopes(fakeDb({resource:BRAIN_API_RESOURCE}).db,
    token,BRAIN_MCP_RESOURCE),
    error=>error.message==='INVALID_CONNECTION_TOKEN');
});

test('search scopes by owner, excludes private indexes and supports cursor',async()=>{
  const {db,observed}=fakeDb();
  const found=await searchBrainMemories(db,token,{query:'HELLO',limit:2,type:'fact'});
  assert.equal(found.items.length,2);
  assert.equal(found.items[0]._id,String(id1));
  assert.equal(found.items[0].privateObjectKey,undefined);
  assert.equal(found.items[0].searchGrams,undefined);
  assert.equal(found.items[0].normalizedText,undefined);
  assert.equal(found.nextCursor,String(id2));
  const [,filter]=observed.find(([kind])=>kind==='find');
  assert.equal(filter.type,'fact');
  assert.equal(filter.normalizedText.$regex,'hello');
  assert.ok(Array.isArray(filter.searchGrams.$all));
  const cursor=await searchBrainMemories(db,token,{cursor:String(id1),limit:2});
  const [,nextFilter]=observed.filter(([kind])=>kind==='find').at(-1);
  assert.ok(nextFilter._id.$gt.equals(id1));
  assert.equal(cursor.items.length,2);
});

test('individual memory read is owner scoped and strips private index fields',async()=>{
  const found=await readBrainMemory(fakeDb().db,token,String(id1));
  assert.equal(found.statement,'Hello world');
  assert.equal(found.privateObjectKey,undefined);
  await assert.rejects(readBrainMemory(fakeDb({includeRecord:false}).db,token,String(id1)),
    error=>error.status===404 && error.message==='NOT_FOUND');
});

test('search normalization and regex escaping mirror existing legacy gram filters',()=>{
  const special=brainSearchFilter('A.*B');
  assert.equal(special.normalizedText.$regex,'a\\.\\*b');
  assert.deepEqual(brainSearchFilter(''),{});
  const chinese=brainSearchFilter('知识');
  assert.equal(chinese.normalizedText.$regex,'知识');
  assert.ok(chinese.searchGrams.$all.length>0);
  assert.deepEqual(validateBrainSearch({}),{query:'',type:undefined,limit:20,cursor:undefined});
  for(const bad of [
    {limit:51},{type:'super_admin'},{query:'x'.repeat(201)},
    {ownerId:String(foreign)},{cursor:'nope'}
  ])assert.throws(()=>validateBrainSearch(bad),
    error=>error instanceof BrainReadError && error.status===400);
});
