import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway,{isFootprintWritePath} from './src/index.js';

const base='https://api.samyao.me';
const id='507f1f77bcf86cd799439022';
const path='/api/footprints';
const limiter={limit:async()=>({success:true})};
const env=(worker,flag='0')=>({
  ORIGIN_URL:'https://legacy.invalid',
  BANANABOOM_CORE:worker,
  FOOTPRINT_WRITE_CANARY:flag,
  GENERAL_LIMITER:limiter,
  WRITE_LIMITER:limiter,
  AUTH_LIMITER:limiter,
  EXPENSIVE_LIMITER:limiter
});
const req=(method,route=path,extra={})=>new Request(base+route,{
  method,
  headers:{
    origin:'https://samyao.me',
    cookie:'orion_session=synthetic-jwt',
    'x-orion-footprint-write-canary':'1',
    'idempotency-key':'synthetic-foo-01',
    ...(method==='POST'||method==='PUT'?{'content-type':'application/json'}:{}),
    ...extra
  },
  ...(method==='POST'||method==='PUT'?
    {body:JSON.stringify(method==='POST'?{
      location:{name:'Synthetic',coordinates:[174.75,-36.8]}
    }:{content:'Updated synthetic'})}:{})
});

test('Only real legacy footprint mutation routes eligible',()=>{
  assert.equal(isFootprintWritePath('POST','/api/footprints'),true);
  assert.equal(isFootprintWritePath('PUT',path+'/'+id),true);
  assert.equal(isFootprintWritePath('DELETE',path+'/'+id),true);
  for(const [method,route] of [
    ['POST',path+'/'+id],['PUT',path],['GET',path],
    ['PUT',path+'/bad'],['DELETE',path+'/admin/rebuild'],
    ['POST','/api/todo'],['DELETE','/api/footprints']
  ])assert.equal(isFootprintWritePath(method,route),false);
});

test('Server flag OFF prevents user-supplied canary switching',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({via:'legacy'})};
  try{
    const result=await gateway.fetch(req('POST'),env({
      fetch:async()=>{core++;return Response.json({via:'worker'})}
    }));
    assert.equal(result.status,200);
    assert.equal((await result.json()).via,'legacy');
    assert.equal(legacy,1);assert.equal(core,0);
  }finally{globalThis.fetch=old}
});

test('Writes POST PUT DELETE invoke core once, preserve body and remove canary',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;throw Error('No Cloud Run mutation replay')};
  try{
    for(const [method,route] of [
      ['POST',path],['PUT',path+'/'+id],['DELETE',path+'/'+id]
    ]){
      const result=await gateway.fetch(req(method,route,{
        'x-orion-edge-secret':'spoofed'
      }),env({fetch:async request=>{
        core++;
        assert.equal(request.method,method);
        assert.equal(request.headers.get('x-orion-edge-secret'),null);
        assert.equal(request.headers.get('x-orion-footprint-write-canary'),null);
        assert.equal(request.headers.get('idempotency-key'),'synthetic-foo-01');
        assert.equal(request.headers.get('cookie'),'orion_session=synthetic-jwt');
        if(method!=='DELETE'){
          const payload=await request.json();
          assert.ok(method==='POST'?payload.location.name:payload.content);
        }
        return Response.json({msg:'ok'});
      }},'1'));
      assert.equal(result.status,200);
      assert.equal(result.headers.get('x-bananaboom-origin'),'worker');
      assert.equal((await result.json()).msg,'ok');
    }
    assert.equal(core,3);assert.equal(legacy,0);
  }finally{globalThis.fetch=old}
});

test('No core, 503, exceptions all fail closed without hitting Cloud Run',async()=>{
  const old=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;throw Error('Never replay')};
  try{
    for(const core of [
      undefined,
      {fetch:async()=>Response.json({secret:'sensitive'},{status:503})},
      {fetch:async()=>{throw Error('Mongo unavailable')}}
    ]){
      const result=await gateway.fetch(req('PUT',path+'/'+id),env(core,'1'));
      assert.equal(result.status,503);
      const output=await result.text();
      assert.equal(output.includes('sensitive'),false);
      assert.equal(output.includes('Mongo unavailable'),false);
    }
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old}
});

test('No session, Google-only or no idempotency key reject BEFORE core or Cloud Run',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({error:'legacy'})};
  try{
    const bound={fetch:async()=>{core++;return Response.json({msg:'should not run'})}};
    const cases=[
      [req('POST',path,{cookie:''}),401],
      [req('POST',path,{'x-google-auth':'google-only'}),401],
      [req('POST',path,{'idempotency-key':''}),428],
      [req('PUT',path+'/'+id,{'idempotency-key':'short'}),428]
    ];
    for(const [request,status] of cases){
      const result=await gateway.fetch(request,env(bound,'1'));
      assert.equal(result.status,status);
    }
    assert.equal(core,0);assert.equal(legacy,0);
  }finally{globalThis.fetch=old}
});
