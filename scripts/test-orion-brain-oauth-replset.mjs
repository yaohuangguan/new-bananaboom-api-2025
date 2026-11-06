import assert from 'node:assert/strict';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
import {createHash,randomBytes} from 'node:crypto';
import {BrainOAuthClient,BrainAuthorizationCode,BrainCredential,BrainConnection} from '../models/brainSync.js';
import {exchangeBrainOAuthToken} from '../cloudflare/bananaboom-worker/src/brainOAuthGrant.js';
import {brainAccessScopes,BRAIN_MCP_RESOURCE,BRAIN_API_RESOURCE} from '../cloudflare/bananaboom-worker/src/brainRead.js';

const {MongoClient,ObjectId}=mongodb;
const hash=s=>createHash('sha256').update(s).digest('hex');
assert.equal(BrainOAuthClient.collection.name,'brainoauthclients');
assert.equal(BrainAuthorizationCode.collection.name,'brainauthorizationcodes');
assert.equal(BrainCredential.collection.name,'braincredentials');
assert.equal(BrainConnection.collection.name,'brainconnections');

const repl=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});
const uri=repl.getUri();
if(!/^(mongodb:\/\/|mongodb\+srv:\/\/)(localhost|127\.0\.0\.1)/.test(uri)) {
  await repl.stop();throw new Error('Refusing non-local database');
}
const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
try{
  await client.connect();
  const db=client.db('orion_brain_oauth_test_'+Date.now());
  const owner=new ObjectId();
  const conn=new ObjectId();
  const clientId='synthetic-oauth-client-v1';
  const redirectUri='https://chatgpt.com/oauth/callback';
  const future=new Date(Date.now()+90*86400000);
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const code='ov_'+randomBytes(32).toString('base64url');
  const codeHash=hash(code);
  await db.collection('users').insertOne({_id:owner,role:'owner',extraPermissions:[]});
  await db.collection('roles').insertOne({name:'owner',permissions:['BRAIN:USE']});
  await db.collection('brainoauthclients').insertOne({
    clientId,
    metadata:{
      client_id:clientId,
      token_endpoint_auth_method:'none',
      redirect_uris:[redirectUri],
      grant_types:['authorization_code','refresh_token']
    },expiresAt:future
  });
  await db.collection('brainconnections').insertOne({
    _id:conn,clientId,ownerId:owner,kind:'oauth',label:'synthetic ChatGPT',
    provider:'chatgpt',resource:BRAIN_MCP_RESOURCE,
    scopes:['memory:read','memory:write'],
    revokedAt:null,expiresAt:future
  });
  await db.collection('brainauthorizationcodes').insertOne({
    hash:codeHash,clientId,connectionId:conn,expiresAt:new Date(Date.now()+600000),
    params:{redirectUri,codeChallenge:challenge,codeChallengeMethod:'S256',
      scopes:['memory:read','memory:write']}
  });
  await db.collection('braincredentials').createIndex({hash:1},{unique:true});
  await db.collection('brainauthorizationcodes').createIndex({hash:1},{unique:true});
  const request={
    grant_type:'authorization_code',
    client_id:clientId,code,code_verifier:verifier,
    redirect_uri:redirectUri,resource:BRAIN_MCP_RESOURCE
  };
  await assert.rejects(exchangeBrainOAuthToken(client,db,{
    ...request,code_verifier:randomBytes(32).toString('base64url')
  }),e=>e.message==='invalid_grant'&&e.status===400);
  assert.equal(await db.collection('brainauthorizationcodes').countDocuments({hash:codeHash}),1);
  const initial=await exchangeBrainOAuthToken(client,db,request);
  assert.match(initial.access_token,/^ov_[A-Za-z0-9_-]{43}$/);
  assert.match(initial.refresh_token,/^ov_[A-Za-z0-9_-]{43}$/);
  assert.equal(initial.token_type,'Bearer');
  assert.equal(initial.scope,'memory:read memory:write');
  assert.equal(initial.expires_in>0&&initial.expires_in<=3600,true);
  assert.equal(await db.collection('brainauthorizationcodes').countDocuments({hash:codeHash}),0);
  const access=await db.collection('braincredentials').findOne({hash:hash(initial.access_token)});
  const refresh=await db.collection('braincredentials').findOne({hash:hash(initial.refresh_token)});
  assert.equal(access.kind,'access');
  assert.equal(refresh.kind,'refresh');
  assert.equal(access.connectionId.toString(),conn.toString());
  assert.deepEqual(await brainAccessScopes(db,initial.access_token,BRAIN_MCP_RESOURCE),
    ['memory:read','memory:write']);
  assert.equal(await db.collection('braincredentials').countDocuments({
    hash:initial.access_token
  }),0,'no raw tokens persisted');
  await assert.rejects(exchangeBrainOAuthToken(client,db,request),
    e=>e.message==='invalid_grant');

  const rotation={
    grant_type:'refresh_token',client_id:clientId,
    refresh_token:initial.refresh_token,
    resource:BRAIN_MCP_RESOURCE,scope:'memory:read'
  };
  const next=await exchangeBrainOAuthToken(client,db,rotation);
  assert.notEqual(next.refresh_token,initial.refresh_token);
  assert.notEqual(next.access_token,initial.access_token);
  assert.equal(next.scope,'memory:read');
  assert.deepEqual(await brainAccessScopes(db,next.access_token,BRAIN_MCP_RESOURCE),
    ['memory:read']);
  assert.equal(await db.collection('braincredentials').countDocuments({
    hash:hash(initial.refresh_token)
  }),0);
  await assert.rejects(exchangeBrainOAuthToken(client,db,rotation),
    e=>e.message==='invalid_grant');
  await assert.rejects(exchangeBrainOAuthToken(client,db,{
    grant_type:'refresh_token',client_id:clientId,
    refresh_token:next.refresh_token,scope:'memory:read memory:write'
  }),e=>e.message==='invalid_scope');
  // Scope escalation attempt must roll back token consumption.
  assert.equal(await db.collection('braincredentials').countDocuments({
    hash:hash(next.refresh_token)
  }),1);

  const again=await exchangeBrainOAuthToken(client,db,{
    grant_type:'refresh_token',client_id:clientId,
    refresh_token:next.refresh_token,scope:'memory:read'
  });
  assert.equal(again.scope,'memory:read');
  await assert.rejects(brainAccessScopes(db,again.access_token,BRAIN_API_RESOURCE),
    e=>e.status===401);
  await db.collection('roles').updateOne({name:'owner'},{$set:{permissions:[]}});
  await assert.rejects(exchangeBrainOAuthToken(client,db,{
    grant_type:'refresh_token',client_id:clientId,refresh_token:again.refresh_token
  }),e=>e.message==='invalid_grant');
  assert.equal(await db.collection('braincredentials').countDocuments({
    hash:hash(again.refresh_token)
  }),1,'revoked permission must not consume refresh in failed transaction');

  await db.dropDatabase();
  console.log('PASS: isolated MongoDB original PKCE grant, wrong-verifier rollback, one-use code, existing hashed credential shape, atomic refresh rotation, scope downgrade, replay denial, live owner permission');
  console.log('NO_PRODUCTION_CREDENTIAL_OR_DATABASE_USED');
}finally {await client.close();await repl.stop();}
