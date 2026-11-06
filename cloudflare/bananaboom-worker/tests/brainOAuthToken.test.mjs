import {test} from 'node:test';
import assert from 'node:assert/strict';
import { handleBrainOAuthToken } from '../src/brainOAuthHttp.js';
import { parseOAuthTokenGrant } from '../src/brainOAuthGrant.js';

const url='https://api.samyao.me/token';
const grant={grant_type:'refresh_token',client_id:'synthetic-client',
  refresh_token:'ov_'+'A'.repeat(43)};
function req(body,options={}){
  return new Request(url,{
    method:'POST',
    headers:{
      'content-type':'application/x-www-form-urlencoded; charset=UTF-8',
      ...(options.origin?{origin:options.origin}:{})
    },
    body:typeof body==='string'?body:new URLSearchParams(body).toString()
  });
}
const newGrant={
  access_token:'ov_'+'C'.repeat(43),
  refresh_token:'ov_'+'D'.repeat(43),
  token_type:'Bearer',expires_in:3599,scope:'memory:read'
};

test('OAuth token handler keeps refresh credentials out of output logs',async()=>{
  const calls=[];
  const repo={brainOAuthTokenGrant:async input=>{
    calls.push(input);
    return {ok:true,data:newGrant};
  }};
  const response=await handleBrainOAuthToken(req(grant),repo);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('pragma'),'no-cache');
  assert.deepEqual(await response.json(),newGrant);
  assert.deepEqual(calls,[grant]);
});

test('OAuth token endpoint denies untrusted Origins, duplicate and malformed form fields',async()=>{
  let calls=0;
  const repo={brainOAuthTokenGrant:async()=>{calls++;return {ok:true,data:newGrant}}};
  const rejected=await handleBrainOAuthToken(req(grant,{origin:'https://attacker.example'}),repo);
  assert.equal(rejected.status,403);
  const repeated=await handleBrainOAuthToken(req(
    'grant_type=refresh_token&grant_type=authorization_code&client_id=x'),repo);
  assert.equal(repeated.status,400);
  const missing=await handleBrainOAuthToken(req({
    grant_type:'refresh_token'
  }),{
    brainOAuthTokenGrant:async input => {
      parseOAuthTokenGrant(input);
      throw new Error('invalid form unexpectedly accepted');
    }
  });
  assert.equal(missing.status,401);
  assert.deepEqual(await missing.json(),{error:'invalid_client'});
  assert.equal(calls,0);
});

test('OAuth grant and runtime errors are safe, no raw token leaked',async()=>{
  const invalid={brainOAuthTokenGrant:async()=>({ok:false,status:400,error:'invalid_grant'})};
  const rejected=await handleBrainOAuthToken(req(grant),invalid);
  assert.equal(rejected.status,400);
  assert.deepEqual(await rejected.json(),{error:'invalid_grant'});
  const runtime={brainOAuthTokenGrant:async()=>{throw new Error('fake payload '+grant.refresh_token)}};
  const original=console.error;
  const logs=[];
  console.error=(...args)=>logs.push(args);
  try {
    const unavailable=await handleBrainOAuthToken(req(grant),runtime);
    assert.equal(unavailable.status,503);
    assert.deepEqual(await unavailable.json(),{error:'temporarily_unavailable'});
    assert.equal(JSON.stringify(logs).includes(grant.refresh_token),false);
  }finally {console.error=original;}
});
