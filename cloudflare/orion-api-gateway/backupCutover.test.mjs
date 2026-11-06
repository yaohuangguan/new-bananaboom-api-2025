import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

test('legacy backup remains Cloud Run with cutover=0; explicit canary stays Worker',async()=>{
 const old=globalThis.fetch;
 let upstream=0, core=0;
 globalThis.fetch=async()=>{upstream++;return new Response('[DONE] legacy',{status:200})};
 const env={
  ORIGIN_URL:'https://upstream.example',BACKUP_R2_CUTOVER:'0',
  GENERAL_LIMITER:{limit:async()=>({success:true})},
  EXPENSIVE_LIMITER:{limit:async()=>({success:true})},
  BANANABOOM_CORE:{fetch:async(req)=>{
    core++;
    assert.equal(req.headers.get('x-orion-backup-canary'),null);
    assert.equal(req.method,'POST');
    return new Response('[LOG] new\n[DONE] {}\n',{status:200});
  }}
 };
 try{
  let r=await gateway.fetch(new Request('https://api.samyao.me/api/backup/database',{
   method:'POST',headers:{origin:'https://samyao.me'}
  }),env);
  assert.equal(r.status,200);
  assert.equal(core,0);
  assert.equal(upstream,1);
  r=await gateway.fetch(new Request('https://api.samyao.me/api/backup/database',{
   method:'POST',headers:{
    origin:'https://samyao.me',authorization:'Bearer test',
    'x-orion-backup-canary':'1'
   }
  }),env);
  assert.equal(r.status,200);
  assert.equal(core,1);
  assert.equal(upstream,1);
  assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
  assert.equal(r.headers.get('access-control-allow-origin'),'https://samyao.me');
 }finally{globalThis.fetch=old}
});

test('backup Worker 503 or missing binding is never double-backed up in Cloud Run',async()=>{
 const old=globalThis.fetch;let upstream=0;
 globalThis.fetch=async()=>{upstream++;return new Response('unsafe double-backup')};
 const env={
  ORIGIN_URL:'https://upstream.example',BACKUP_R2_CUTOVER:'1',
  GENERAL_LIMITER:{limit:async()=>({success:true})},
  EXPENSIVE_LIMITER:{limit:async()=>({success:true})},
  BANANABOOM_CORE:{fetch:async()=>{throw Error('R2 timeout')}}
 };
 try{
  const make=()=>new Request('https://api.samyao.me/api/backup/database',{
   method:'POST',headers:{authorization:'Bearer test'}
  });
  assert.equal((await gateway.fetch(make(),env)).status,503);
  delete env.BANANABOOM_CORE;
  assert.equal((await gateway.fetch(make(),env)).status,503);
  assert.equal(upstream,0);
 }finally{globalThis.fetch=old}
});
