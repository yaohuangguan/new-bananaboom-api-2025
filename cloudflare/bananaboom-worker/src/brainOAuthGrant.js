import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BRAIN_MCP_RESOURCE } from './brainRead.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date();
const future=ms=>new Date(Date.now()+ms);
const SCOPES=new Set(['memory:read','memory:write']);

export class BrainOAuthGrantError extends Error {
  constructor(code='invalid_request',status=400) {
    super(code);this.name='BrainOAuthGrantError';this.status=status;
  }
}
const fail=(code='invalid_request',status=400)=>{
  throw new BrainOAuthGrantError(code,status);
};
function publicClientId(value) {
  if(typeof value!=='string' || !value || value.length>200) fail('invalid_client',401);
  return value;
}
function oauthSecret() {return 'ov_'+randomBytes(32).toString('base64url');}
function validToken(value) {
  return typeof value==='string' && /^ov_[a-zA-Z0-9_-]{43}$/.test(value);
}
function resourceOf(resource) {
  if(resource!==undefined && resource!==BRAIN_MCP_RESOURCE) fail('invalid_target');
  return BRAIN_MCP_RESOURCE;
}
function requestedScopes(scope,allowed) {
  if(scope===undefined || scope==='') return allowed;
  if(typeof scope!=='string' || scope.length>80) fail('invalid_scope');
  const wanted=scope.split(' ').filter(Boolean);
  if(!wanted.length || wanted.length>2 ||
     new Set(wanted).size!==wanted.length ||
     wanted.some(s=>!SCOPES.has(s)||!allowed.includes(s))) fail('invalid_scope');
  return wanted;
}

export function parseOAuthTokenGrant(raw) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw) ||
     Object.keys(raw).some(k=>![
      'grant_type','client_id','refresh_token','code','code_verifier',
      'redirect_uri','resource','scope'
     ].includes(k))) fail('invalid_request');
  const clientId=publicClientId(raw.client_id);
  const resource=resourceOf(raw.resource);
  if(raw.grant_type==='refresh_token') {
    if(!validToken(raw.refresh_token) || raw.code || raw.code_verifier ||
       raw.redirect_uri) fail('invalid_request');
    return {kind:'refresh',clientId,resource,token:raw.refresh_token,
      scope:raw.scope};
  }
  if(raw.grant_type==='authorization_code') {
    if(!validToken(raw.code) ||
       typeof raw.redirect_uri!=='string' || raw.redirect_uri.length>2000 ||
       typeof raw.code_verifier!=='string' ||
       !/^[A-Za-z0-9._~-]{43,128}$/.test(raw.code_verifier) ||
       raw.refresh_token || raw.scope) fail('invalid_request');
    return {kind:'code',clientId,resource,token:raw.code,
      redirectUri:raw.redirect_uri,verifier:raw.code_verifier};
  }
  fail('unsupported_grant_type');
}

async function liveOwner(db,ownerId,session) {
  const owner=await db.collection('users').findOne(
    {_id:ownerId},{session,projection:{role:1,extraPermissions:1}}
  );
  if(!owner) fail('invalid_grant');
  const role=await db.collection('roles').findOne(
    {name:owner.role},{session,projection:{permissions:1}}
  );
  const permissions=[...(role?.permissions||[]),...(owner.extraPermissions||[])];
  if(!permissions.includes('*') && !permissions.includes('BRAIN:USE')) fail('invalid_grant');
}
async function issueTokens(db,session,connection,scopes) {
  const accessExpiry=new Date(Math.min(Date.now()+3600000,+connection.expiresAt));
  const refreshExpiry=new Date(Math.min(Date.now()+30*86400000,+connection.expiresAt));
  if(accessExpiry<=now() || refreshExpiry<=now()) fail('invalid_grant');
  const access=oauthSecret(), refresh=oauthSecret();
  await db.collection('braincredentials').insertMany([
    {hash:sha(access),connectionId:connection._id,kind:'access',
      scopes,expiresAt:accessExpiry},
    {hash:sha(refresh),connectionId:connection._id,kind:'refresh',
      scopes,expiresAt:refreshExpiry}
  ],{session});
  return {
    access_token:access,refresh_token:refresh,
    token_type:'Bearer',
    expires_in:Math.max(0,Math.floor((+accessExpiry-Date.now())/1000)),
    scope:scopes.join(' ')
  };
}
function verifyPkce(verifier,challenge) {
  if(typeof challenge!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    fail('invalid_grant');
  }
  const generated=createHash('sha256').update(verifier).digest('base64url');
  const a=Buffer.from(generated,'utf8'), b=Buffer.from(challenge,'utf8');
  if(a.length!==b.length || !timingSafeEqual(a,b)) fail('invalid_grant');
}

/**
 * Compatible with existing OAuth PKCE/refresh credentials. Only hashes live
 * in MongoDB. A refresh token is consumed exactly once in the same MongoDB
 * transaction that writes the access/refresh replacement pair.
 */
export async function exchangeBrainOAuthToken(client,db,input) {
  if(!client || !db) throw new Error('MISSING_DATABASE');
  const grant=parseOAuthTokenGrant(input);
  const oauthClient=await db.collection('brainoauthclients').findOne({
    clientId:grant.clientId,expiresAt:{$gt:now()}
  },{projection:{metadata:1}});
  if(!oauthClient || oauthClient.metadata?.token_endpoint_auth_method!=='none') {
    fail('invalid_client',401);
  }
  const session=client.startSession();
  try {
    let response;
    await session.withTransaction(async()=>{
      const table=grant.kind==='refresh'
        ? db.collection('braincredentials')
        : db.collection('brainauthorizationcodes');
      const selector=grant.kind==='refresh'
        ? {hash:sha(grant.token),kind:'refresh',expiresAt:{$gt:now()}}
        : {hash:sha(grant.token),clientId:grant.clientId,expiresAt:{$gt:now()}};
      const selected=await table.findOneAndDelete(selector,{session});
      if(!selected) fail('invalid_grant');
      if(grant.kind==='code') {
        if(selected.params?.redirectUri!==grant.redirectUri ||
           !oauthClient.metadata.redirect_uris?.includes(grant.redirectUri) ||
           selected.params?.codeChallengeMethod && selected.params.codeChallengeMethod!=='S256') {
          fail('invalid_grant');
        }
        verifyPkce(grant.verifier,selected.params.codeChallenge);
      }
      const connection=await db.collection('brainconnections').findOne({
        _id:selected.connectionId,
        clientId:grant.clientId,
        kind:'oauth',
        resource:grant.resource,
        revokedAt:null,
        expiresAt:{$gt:now()}
      },{session});
      if(!connection) fail('invalid_grant');
      await liveOwner(db,connection.ownerId,session);
      const allowedScopes=Array.isArray(selected.scopes)
        ? selected.scopes : selected.params?.scopes;
      if(!Array.isArray(allowedScopes) ||
         !allowedScopes.length ||
         allowedScopes.some(s=>!SCOPES.has(s)||!connection.scopes?.includes(s))) {
        fail('invalid_scope');
      }
      const scopes=grant.kind==='refresh'
        ? requestedScopes(grant.scope,allowedScopes)
        : allowedScopes;
      response=await issueTokens(db,session,connection,scopes);
    },{
      readConcern:{level:'snapshot'},
      writeConcern:{w:'majority'},
      maxCommitTimeMS:25000
    });
    return response;
  }finally {await session.endSession();}
}
