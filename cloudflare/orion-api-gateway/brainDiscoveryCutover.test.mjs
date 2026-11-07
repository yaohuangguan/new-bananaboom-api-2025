import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const base='https://api.samyao.me';
const paths=[
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/api/brain/sync/mcp'
];
const limiter={limit:async()=>({success:true})};
const env=(core,flag='0')=>({
  BRAIN_METADATA_CUTOVER:flag,
  ORIGIN_URL:'https://legacy.invalid',
  BANANABOOM_CORE:core,
  GENERAL_LIMITER:limiter,WRITE_LIMITER:limiter,
  AUTH_LIMITER:limiter,EXPENSIVE_LIMITER:limiter
});
test('Public discovery canary routes to private Core with no credential forwarding',async()=>{
  const orig=globalThis.fetch;
  let legacy=0,worker=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({server:'legacy'})};
  try{
    for(const path of paths){
      const result=await gateway.fetch(new Request(base+path,{
        headers:{
          'x-orion-brain-metadata-canary':'1',
          authorization:'Bearer opaque-user-credential',
          'x-orion-edge-secret':'spoofed',
          cookie:'session=do-not-send',
          origin:'https://samyao.me'
        }
      }),env({fetch:async r=>{
        worker++;
        for(const header of ['authorization','cookie','x-orion-edge-secret',
          'x-orion-brain-metadata-canary'
        ])assert.equal(r.headers.get(header),null);
        assert.equal(r.method,'GET');
        return Response.json({server:'worker',path:new URL(r.url).pathname});
      }}));
      assert.equal(result.status,200);
      assert.equal(result.headers.get('x-bananaboom-origin'),'worker');
      const body=await result.json();
      assert.equal(body.path,path);
      assert.equal(body.server,'worker');
    }
    assert.equal(legacy,0);assert.equal(worker,2);
  }finally{globalThis.fetch=orig}
});

test('Default discovery still Cloud Run with flag 0; flag 1 routes both docs',async()=>{
  const orig=globalThis.fetch;
  let legacy=0,worker=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({via:'legacy'})};
  try{
    const stub={fetch:async()=>{worker++;return Response.json({via:'worker'})}};
    const old=await gateway.fetch(new Request(base+paths[0]),env(stub));
    assert.equal((await old.json()).via,'legacy');
    for(const path of paths){
      const active=await gateway.fetch(new Request(base+path),env(stub,'1'));
      assert.equal((await active.json()).via,'worker');
    }
    assert.equal(worker,2);assert.equal(legacy,1);
  }finally{globalThis.fetch=orig}
});

test('Discovery Worker failure can safely fall back to unchanged read-only legacy SDK',async()=>{
  const orig=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({via:'legacy'})};
  try{
    for(const core of [
      undefined,
      {fetch:async()=>Response.json({error:'not ready'},{status:503})},
      {fetch:async()=>{throw Error('Worker not ready')}}
    ]){
      const result=await gateway.fetch(new Request(base+paths[0]),env(core,'1'));
      assert.equal((await result.json()).via,'legacy');
    }
    assert.equal(legacy,3);
  }finally{globalThis.fetch=orig}
});

test('Non-discovery OAuth sensitive POSTs are never routed by metadata cutover',async()=>{
  const orig=globalThis.fetch;
  let old=0,worker=0;
  globalThis.fetch=async()=>{old++;return Response.json({via:'legacy'})};
  try {
    const stub={fetch:async()=>{worker++;return Response.json({via:'worker'})}};
    const r=await gateway.fetch(new Request(base+'/token',{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:'grant_type=refresh_token'
    }),env(stub,'1'));
    assert.equal((await r.json()).via,'legacy');
    const other=await gateway.fetch(new Request(base+'/.well-known/oauth-protected-resource'),env(stub,'1'));
    assert.equal((await other.json()).via,'legacy');
    assert.equal(worker,0);assert.equal(old,2);
  }finally{globalThis.fetch=orig}
});
