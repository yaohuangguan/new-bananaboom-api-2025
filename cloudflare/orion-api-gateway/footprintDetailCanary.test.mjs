import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway, { isFootprintDetailCandidate } from './src/index.js';

const id='507f1f77bcf86cd799439011';
const other='507f191e810c19729de860ea';
const path='/api/footprints/'+id;
const signed=new Headers({cookie:'orion_session=signed'});
const canary=new Headers({cookie:'orion_session=signed','x-orion-footprint-detail-canary':'1'});

function env(core, cutover='0') {
  return {
    ORIGIN_URL:'https://legacy.example',FOOTPRINT_DETAIL_CUTOVER:cutover,
    GENERAL_LIMITER:{limit:async()=>({success:true})},
    BANANABOOM_CORE:core
  };
}

test('only exact authenticated detail GET is routed; never Google-only, writes or filters',()=>{
  assert.equal(isFootprintDetailCandidate('GET',path,'',signed,true),true);
  assert.equal(isFootprintDetailCandidate('GET',path,'',canary,false),true);
  assert.equal(isFootprintDetailCandidate('GET',path,'',signed,false),false);
  for(const [method,url,search,headers] of [
    ['GET',path,'',new Headers()],
    ['GET',path,'',new Headers({cookie:'unrelated=1'})],
    ['GET',path,'?foo=bar',canary],
    ['POST',path,'',canary],
    ['PUT',path,'',canary],
    ['DELETE',path,'',canary],
    ['HEAD',path,'',canary],
    ['GET','/api/footprints/bad-id','',canary],
    ['GET','/api/footprints','',canary],
    ['GET',path,'',new Headers({cookie:'orion_session=signed','x-google-auth':'fake'})]
  ])assert.equal(isFootprintDetailCandidate(method,url,search,headers,true),false);
});

test('Core 404 for foreign detail never calls vulnerable legacy origin',async()=>{
  const old=globalThis.fetch; let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({private:'leak'});};
  try{
    const r=await gateway.fetch(new Request('https://api.samyao.me'+path,{headers:canary}),
      env({fetch:async(req)=>{
        core++;
        assert.equal(req.headers.get('x-orion-footprint-detail-canary'),null);
        return Response.json({msg:'Not Found'},{status:404});
      }}));
    assert.equal(r.status,404);
    assert.equal((await r.json()).msg,'Not Found');
    assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
    assert.equal(core,1);
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old;}
});

test('Core read failure, missing binding and network exceptions all fail closed',async()=>{
  const old=globalThis.fetch;let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({private:'leak'});};
  try{
    const failures=[
      env({fetch:async()=>Response.json({error:'boom'},{status:503})}),
      env({fetch:async()=>{throw new Error('disconnected');}}),
      env(undefined)
    ];
    for(const config of failures){
      const r=await gateway.fetch(new Request('https://api.samyao.me'+path,{headers:canary}),config);
      assert.equal(r.status,503);
      assert.equal(r.headers.get('cache-control'),'no-store');
    }
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old;}
});

test('global cutover blocks Google-only, anonymous and alternate paths instead of forwarding',async()=>{
  const old=globalThis.fetch;let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({private:'leak'});};
  try{
    for(const request of [
      new Request('https://api.samyao.me'+path),
      new Request('https://api.samyao.me'+path,{headers:{'x-google-auth':'fake'}}),
      new Request('https://api.samyao.me/api/footprints/%35' + id.slice(1),{headers:signed}),
      new Request('https://api.samyao.me'+path,{method:'HEAD',headers:signed})
    ]){
      const r=await gateway.fetch(request,env({fetch:async()=>{core++;return Response.json({private:'leak'});}},'1'));
      assert.equal(r.status,401);
    }
    assert.equal(core,0);
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old;}
});

test('global cutover passes valid signed detail response through owner-check Worker',async()=>{
  const old=globalThis.fetch;let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({private:'leak'});};
  try {
    const r=await gateway.fetch(new Request('https://api.samyao.me/api/footprints/'+other,{headers:signed}),
      env({fetch:async()=>Response.json({_id:other,content:'Owner'})},'1'));
    assert.equal(r.status,200);
    assert.equal((await r.json()).content,'Owner');
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old;}
});
