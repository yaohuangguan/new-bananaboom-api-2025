import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const path='/api/brain/sync/openapi.json';
const address='https://api.samyao.me'+path;
const limiter={limit:async()=>({success:true})};
const makeEnv=(core,flag='0')=>({
  ORIGIN_URL:'https://legacy.invalid',BANANABOOM_CORE:core,
  BRAIN_METADATA_CUTOVER:'1',BRAIN_OPENAPI_CUTOVER:flag,
  GENERAL_LIMITER:limiter,WRITE_LIMITER:limiter,
  AUTH_LIMITER:limiter,EXPENSIVE_LIMITER:limiter
});

test('OpenAPI default off despite OAuth discovery being on',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({via:'legacy'})};
  try{
    const result=await gateway.fetch(new Request(address),
      makeEnv({fetch:async()=>{core++;return Response.json({via:'core'})}}));
    assert.equal(result.status,200);
    assert.equal((await result.json()).via,'legacy');
    assert.equal(legacy,1);assert.equal(core,0);
  }finally{globalThis.fetch=old}
});

test('Canary only sends sanitized GET and exact spec response',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;throw Error('must not use legacy')};
  try{
    const request=new Request(address,{headers:{
      'x-orion-brain-metadata-canary':'1',
      authorization:'Bearer do-not-forward',
      cookie:'session=do-not-forward',
      'x-auth-token':'do-not-forward',
      'x-google-auth':'do-not-forward',
      'x-orion-edge-secret':'spoofed'
    }});
    const reply=await gateway.fetch(request,makeEnv({
      fetch:async forwarded=>{
        core++;
        assert.equal(forwarded.method,'GET');
        for(const header of ['authorization','cookie','x-auth-token',
          'x-google-auth','x-orion-edge-secret','x-orion-brain-metadata-canary'])
          assert.equal(forwarded.headers.get(header),null);
        return Response.json({version:'synthetic-openapi'});
      }
    }));
    assert.equal(reply.status,200);
    assert.equal(reply.headers.get('x-bananaboom-origin'),'worker');
    assert.equal((await reply.json()).version,'synthetic-openapi');
    assert.equal(legacy,0);assert.equal(core,1);
  }finally{globalThis.fetch=old}
});

test('OpenAPI flag on shifts only safe path, not MCP POST or OAuth token',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({via:'legacy'})};
  try{
    const worker={fetch:async()=>{core++;return Response.json({via:'core'})}};
    const switched=await gateway.fetch(new Request(address),makeEnv(worker,'1'));
    assert.equal((await switched.json()).via,'core');
    const withQuery=await gateway.fetch(new Request(address+'?bad=x'),
      makeEnv(worker,'1'));
    assert.equal((await withQuery.json()).via,'legacy');
    const sensitive=await gateway.fetch(new Request(
      'https://api.samyao.me/api/brain/sync/mcp',
      {method:'POST',headers:{'content-type':'application/json'},
        body:'{}'}
    ),makeEnv(worker,'1'));
    assert.equal((await sensitive.json()).via,'legacy');
    assert.equal(core,1);assert.equal(legacy,2);
  }finally{globalThis.fetch=old}
});

test('OpenAPI Core outage retries safe immutable GET on Cloud Run',async()=>{
  const old=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({via:'legacy'})};
  try{
    for(const worker of [
      undefined,
      {fetch:async()=>Response.json({error:'internal'},{status:503})},
      {fetch:async()=>{throw Error('offline')}}
    ]){
      const reply=await gateway.fetch(new Request(address),
        makeEnv(worker,'1'));
      assert.equal((await reply.json()).via,'legacy');
    }
    assert.equal(legacy,3);
  }finally{globalThis.fetch=old}
});
