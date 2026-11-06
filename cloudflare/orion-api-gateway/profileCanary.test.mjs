import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway, {isAuthenticatedProfileCandidate} from './src/index.js';

const paths=['/api/users/profile','/api/users/ai-status'];
const signed=new Headers({cookie:'other=unrelated; orion_session=fake-jwt'});
const canary=new Headers({cookie:'orion_session=fake-jwt','x-orion-profile-canary':'1'});

test('profile allowlist never routes guest, Google-only, writes or arbitrary routes',()=>{
 for(const path of paths){
  assert.equal(isAuthenticatedProfileCandidate('GET',path,'',signed,false),false);
  assert.equal(isAuthenticatedProfileCandidate('GET',path,'',signed,true),true);
  assert.equal(isAuthenticatedProfileCandidate('GET',path,'',canary,false),true);
  assert.equal(isAuthenticatedProfileCandidate('GET',path,'',new Headers(),true),false);
  assert.equal(isAuthenticatedProfileCandidate('GET',path,'?id=other',canary,true),false);
  assert.equal(isAuthenticatedProfileCandidate('POST',path,'',canary,true),false);
  assert.equal(isAuthenticatedProfileCandidate('GET',path,'',new Headers({
    authorization:'Bearer fake','x-google-auth':'google'
  }),true),false);
 }
 assert.equal(isAuthenticatedProfileCandidate('GET','/api/users/other','',canary,true),false);
});

test('authenticated canary forwards to Core without leaking canary header to Cloud Run',async()=>{
 const originalFetch=globalThis.fetch;
 let legacy=0,core=0;
 globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'});};
 const env={
  ORIGIN_URL:'https://upstream.example',PROFILE_READ_CUTOVER:'0',
  GENERAL_LIMITER:{limit:async()=>({success:true})},
  AUTH_LIMITER:{limit:async()=>({success:true})},
  BANANABOOM_CORE:{fetch:async(req)=>{
    core++;
    assert.equal(req.headers.get('x-orion-profile-canary'),null);
    assert.equal(req.headers.get('cookie'),'orion_session=fake-jwt');
    return Response.json({from:'worker'});
  }}
 };
 try {
   const r=await gateway.fetch(new Request('https://api.samyao.me/api/users/profile',{
    headers:canary
   }),env);
   assert.equal(r.status,200);
   assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
   assert.equal((await r.json()).from,'worker');
   assert.equal(core,1);
   assert.equal(legacy,0);
 }finally{globalThis.fetch=originalFetch}
});
