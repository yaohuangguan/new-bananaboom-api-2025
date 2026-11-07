import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const url='https://api.samyao.me/api/brain/sync/v1/sync';
const token='Bearer ov_'+'A'.repeat(43);
const payload={requestId:'new-write-test-0001',statement:'Synthetic only'};
const limiter={limit:async()=>({success:true})};

function env(core,canaryFlag='0') {
  return {
    ORIGIN_URL:'https://legacy.example.invalid',
    BRAIN_READ_CUTOVER:'0',
    BRAIN_WRITE_CANARY:canaryFlag,
    GENERAL_LIMITER:limiter,WRITE_LIMITER:limiter,AUTH_LIMITER:limiter,
    EXPENSIVE_LIMITER:limiter,
    BANANABOOM_CORE:core
  };
}
function request(path=url,headers={},body=payload) {
  return new Request(path,{
    method:'POST',
    headers:{origin:'https://samyao.me',authorization:token,
      'content-type':'application/json',...headers},
    body:JSON.stringify(body)
  });
}
test('MCP sync / REST sync remain legacy by default even with caller write canary',async()=>{
  const prior=globalThis.fetch;
  let calls=0, coreCalls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({origin:'legacy'})};
  try {
    for(const path of [url,'https://api.samyao.me/api/brain/sync/mcp']) {
      const r=await gateway.fetch(request(path,{
        'x-orion-brain-write-canary':'1'
      }),env({fetch:async()=>{coreCalls++;return Response.json({origin:'worker'})}}));
      assert.equal(r.status,200);
      assert.equal((await r.json()).origin,'legacy');
    }
    assert.equal(calls,2);
    assert.equal(coreCalls,0);
  }finally{globalThis.fetch=prior}
});

test('normal sync stays Cloud Run even when write canary feature flag enabled',async()=>{
  const prior=globalThis.fetch;
  let old=0,core=0;
  globalThis.fetch=async()=>{old++;return Response.json({origin:'legacy'})};
  try {
    const r=await gateway.fetch(request(),env({
      fetch:async()=>{core++;return Response.json({origin:'worker'})}
    },'1'));
    assert.equal(r.status,200);
    assert.equal((await r.json()).origin,'legacy');
    assert.equal(old,1);
    assert.equal(core,0);
  }finally{globalThis.fetch=prior}
});

test('with server flag and write canary, sync runs only once in Core with Bearer',async()=>{
  const prior=globalThis.fetch;
  let old=0,core=0;
  globalThis.fetch=async()=>{old++;throw Error('unsafe legacy write replay')};
  try {
    const response=await gateway.fetch(request(url,{
      'x-orion-brain-write-canary':'1',
      cookie:'orion_session=sensitive',
      'x-orion-edge-secret':'spoofed'
    }),env({
      fetch:async(req)=>{
        core++;
        assert.equal(req.headers.get('authorization'),token);
        assert.equal(req.headers.get('cookie'),null);
        assert.equal(req.headers.get('x-orion-edge-secret'),null);
        assert.equal(req.headers.get('x-orion-brain-write-canary'),null);
        assert.deepEqual(await req.json(),payload);
        return Response.json({created:true,requestId:payload.requestId});
      }
    },'1'));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{created:true,requestId:payload.requestId});
    assert.equal(response.headers.get('x-bananaboom-origin'),'worker');
    assert.equal(core,1);
    assert.equal(old,0);
  }finally{globalThis.fetch=prior}
});

test('write canary fails closed on 503 or thrown service-binding failure',async()=>{
  const prior=globalThis.fetch;
  let old=0;
  globalThis.fetch=async()=>{old++;return Response.json({origin:'legacy'})};
  try {
    for(const core of [null,
      {fetch:async()=>Response.json({message:'private database detail'},{status:503})},
      {fetch:async()=>{throw Error('secret test error')}}
    ]){
      const r=await gateway.fetch(request(url,{'x-orion-brain-write-canary':'1'}),env(core,'1'));
      assert.equal(r.status,503);
      assert.equal((await r.json()).message,'KNOWLEDGE_SYNC_FAILED');
      assert.equal(r.headers.get('access-control-allow-origin'),'https://samyao.me');
    }
    assert.equal(old,0);
  }finally{globalThis.fetch=prior}
});

test('invalid Bearer and read-only header never invoke Core write',async()=>{
  const prior=globalThis.fetch;
  let old=0,core=0;
  globalThis.fetch=async()=>{old++;return Response.json({origin:'legacy'})};
  try {
    const coreStub={fetch:async()=>{core++;return Response.json({})}};
    const missing=await gateway.fetch(request(url,{
      'x-orion-brain-write-canary':'1',
      authorization:'Bearer forged-token'
    }),env(coreStub,'1'));
    assert.equal(missing.status,401);
    assert.equal(old,0);assert.equal(core,0);
    const readFlagOnly=await gateway.fetch(request(url,{
      'x-orion-brain-read-canary':'1'
    }),env(coreStub,'1'));
    assert.equal(readFlagOnly.status,200);
    assert.equal((await readFlagOnly.json()).origin,'legacy');
    assert.equal(old,1);assert.equal(core,0);
  }finally{globalThis.fetch=prior}
});

test('MCP write canary forwarded only by Gateway server-side opt-in',async()=>{
  const prior=globalThis.fetch;
  let old=0;
  globalThis.fetch=async()=>{old++;return Response.json({origin:'legacy'})};
  try {
    let received;
    const result=await gateway.fetch(request(
      'https://api.samyao.me/api/brain/sync/mcp',
      {'x-orion-brain-write-canary':'1','x-orion-brain-read-canary':'1'},
      {jsonrpc:'2.0',id:9,method:'tools/list'}
    ),env({fetch:async req=>{
      received=req.headers;
      return Response.json({jsonrpc:'2.0',id:9,result:{tools:[]}});
    }},'1'));
    assert.equal(result.status,200);
    assert.equal(received.get('x-orion-brain-read-canary'),null);
    assert.equal(received.get('x-orion-brain-write-canary'),'1');
    assert.equal(old,0);
  }finally{globalThis.fetch=prior}
});
