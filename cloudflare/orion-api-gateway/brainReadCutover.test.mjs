import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const token='ov_'+'A'.repeat(43);
const bearer='Bearer '+token;
const run='https://api.samyao.me';
const requests=[];
const limited={limit:async()=>({success:true})};
function env(core,readCutover='0') {
  return {
    ORIGIN_URL:'https://legacy.example.invalid',
    BRAIN_READ_CUTOVER:readCutover,
    GENERAL_LIMITER:limited,
    AUTH_LIMITER:limited,
    WRITE_LIMITER:limited,
    EXPENSIVE_LIMITER:limited,
    BANANABOOM_CORE:core
  };
}
const request=(path,{method='POST',canary=false,auth=bearer,body={},origin='https://samyao.me'}={})=>
  new Request(run+path,{
    method,
    headers:{
      ...(auth?{authorization:auth}:{}),
      origin,
      ...(canary?{'x-orion-brain-read-canary':'1'}:{}),
      ...(method==='POST'?{'content-type':'application/json'}:{})
    },
    ...(method==='POST'?{body:JSON.stringify(body)}:{})
  });
function coreResponse(status=200,body={items:[],nextCursor:null}) {
  return {
    fetch:async req=>{
      requests.push(req);
      return Response.json(body,{status});
    }
  };
}

test('without Brain cutover or canary existing REST search remains on Cloud Run',async()=>{
  const original=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'})};
  requests.length=0;
  try {
    const response=await gateway.fetch(request('/api/brain/sync/v1/search'),env(coreResponse()));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{from:'legacy'});
    assert.equal(legacy,1);
    assert.equal(requests.length,0);
  } finally { globalThis.fetch=original; }
});

test('Brain canary is bearer-only, strips cookies and internal headers',async()=>{
  const original=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;throw new Error('Must never fall back')};
  requests.length=0;
  try {
    const source=request('/api/brain/sync/v1/search',{canary:true,body:{query:'nz'}});
    source.headers.set('cookie','orion_session=never-forward');
    source.headers.set('x-orion-edge-secret','spoofed');
    const response=await gateway.fetch(source,env(coreResponse()));
    assert.equal(response.status,200);
    assert.equal(response.headers.get('x-bananaboom-origin'),'worker');
    assert.equal(response.headers.get('access-control-allow-origin'),'https://samyao.me');
    assert.deepEqual(await response.json(),{items:[],nextCursor:null});
    assert.equal(requests.length,1);
    const req=requests[0];
    assert.equal(req.headers.get('authorization'),bearer);
    assert.equal(req.headers.get('x-orion-brain-read-canary'),null);
    assert.equal(req.headers.get('x-orion-edge-secret'),null);
    assert.equal(req.headers.get('cookie'),null);
    assert.equal((await req.json()).query,'nz');
    assert.equal(legacy,0);
  } finally { globalThis.fetch=original; }
});

test('invalid Brain token never reaches either backend during explicit canary',async()=>{
  const original=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({})};
  requests.length=0;
  try {
    const result=await gateway.fetch(
      request('/api/brain/sync/v1/search',{canary:true,auth:'Bearer forged'}),
      env(coreResponse()));
    assert.equal(result.status,401);
    assert.equal((await result.json()).message,'CONNECTION_AUTH_REQUIRED');
    assert.equal(legacy,0);
    assert.equal(requests.length,0);
    const mcp=await gateway.fetch(
      request('/api/brain/sync/mcp',{canary:true,auth:''}),env(coreResponse()));
    assert.equal(mcp.status,401);
    assert.match(mcp.headers.get('www-authenticate')||'',/oauth-protected-resource/);
  } finally {globalThis.fetch=original;}
});

test('MCP is canary-only even when REST Brain cutover enabled',async()=>{
  const original=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'})};
  requests.length=0;
  try {
    const r=await gateway.fetch(request('/api/brain/sync/mcp'),env(coreResponse(), '1'));
    assert.equal(r.status,200);
    assert.equal(legacy,1);
    assert.equal(requests.length,0);
    const canary=await gateway.fetch(
      request('/api/brain/sync/mcp',{canary:true,body:{jsonrpc:'2.0',method:'tools/list',id:2}}),
      env(coreResponse(200,{jsonrpc:'2.0',id:2,result:{tools:[]}}),'1'));
    assert.equal(canary.status,200);
    assert.equal(requests.length,1);
    assert.equal(requests[0].headers.get('authorization'),bearer);
    assert.equal(requests[0].headers.get('x-orion-brain-read-canary'),null);
    assert.equal((await canary.json()).result.tools.length,0);
  } finally { globalThis.fetch=original; }
});

test('exact allowlist only: /sync writes never reach read-only Worker',async()=>{
  const original=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'})};
  requests.length=0;
  try {
    const a=await gateway.fetch(request('/api/brain/sync/v1/sync',{canary:true}),
      env(coreResponse(), '1'));
    assert.equal(a.status,200);
    assert.equal(legacy,1);
    assert.equal(requests.length,0);
    const b=await gateway.fetch(request('/api/brain/sync/v1/memories/invalid',{
      method:'GET',canary:true
    }),env(coreResponse(), '1'));
    assert.equal(b.status,200);
    assert.equal(legacy,2);
    assert.equal(requests.length,0);
  } finally {globalThis.fetch=original;}
});

test('invalid Worker result fails closed without legacy retry',async()=>{
  const original=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;throw new Error('Legacy should not run')};
  requests.length=0;
  try {
    const result=await gateway.fetch(
      request('/api/brain/sync/v1/search',{canary:true}),
      env(coreResponse(503,{message:'unsafe details'})));
    assert.equal(result.status,503);
    assert.equal((await result.json()).message,'KNOWLEDGE_SYNC_FAILED');
    assert.equal(legacy,0);
    const get=await gateway.fetch(
      request('/api/brain/sync/v1/memories/507f1f77bcf86cd799439011',{
        method:'GET',canary:true
      }), env(coreResponse(200,{_id:'507f1f77bcf86cd799439011',statement:'x'})));
    assert.equal(get.status,200);
    assert.equal(get.headers.get('x-bananaboom-origin'),'worker');
  } finally {globalThis.fetch=original;}
});
