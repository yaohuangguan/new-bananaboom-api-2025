import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const url='https://api.samyao.me/token';
const limiter={limit:async()=>({success:true})};
const secretForm='grant_type=refresh_token&client_id=synth-client&refresh_token=ov_'+
  'A'.repeat(43);
function env(core,flag='0') {
  return {
    ORIGIN_URL:'https://legacy.example.invalid',
    BRAIN_OAUTH_TOKEN_CANARY:flag,
    GENERAL_LIMITER:limiter,
    AUTH_LIMITER:limiter,
    EXPENSIVE_LIMITER:limiter,
    WRITE_LIMITER:limiter,
    BANANABOOM_CORE:core
  };
}
function req(withCanary=true){
  return new Request(url,{method:'POST',
    headers:{
      origin:'https://samyao.me',
      'content-type':'application/x-www-form-urlencoded',
      ...(withCanary?{'x-orion-brain-oauth-canary':'1'}:{})
    },
    body:secretForm
  });
}

test('Default /token requests still reach legacy even when caller supplies canary',async()=>{
  let legacy=0,core=0;
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    let r=await gateway.fetch(req(),env({fetch:async()=>{core++;return Response.json({})}},'0'));
    assert.equal(r.status,200);
    assert.equal((await r.json()).origin,'legacy');
    r=await gateway.fetch(req(false),env({fetch:async()=>{core++;return Response.json({})}},'1'));
    assert.equal(r.status,200);
    assert.equal((await r.json()).origin,'legacy');
    assert.equal(core,0);assert.equal(legacy,2);
  }finally {globalThis.fetch=previous}
});

test('Opt-in /token grant forwards once without cookie or spoofed secret',async()=>{
  const previous=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;throw new Error('should not replay OAuth token')};
  try{
    const original=req();
    original.headers.set('cookie','orion_session=fake-secret');
    original.headers.set('x-orion-edge-secret','spoofed');
    const output={access_token:'ov_'+'C'.repeat(43),token_type:'Bearer'};
    const r=await gateway.fetch(original,env({
      fetch:async forwarded=>{
        core++;
        assert.equal(forwarded.headers.get('cookie'),null);
        assert.equal(forwarded.headers.get('x-orion-edge-secret'),null);
        assert.equal(forwarded.headers.get('x-orion-brain-oauth-canary'),null);
        assert.equal(forwarded.headers.get('content-type'),'application/x-www-form-urlencoded');
        assert.equal(await forwarded.text(),secretForm);
        return Response.json(output);
      }
    },'1'));
    assert.equal(r.status,200);
    assert.deepEqual(await r.json(),output);
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
    assert.equal(legacy,0);assert.equal(core,1);
  }finally {globalThis.fetch=previous}
});

test('Any Worker failure never replays consumed OAuth refresh token on Cloud Run',async()=>{
  const previous=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    for(const core of [
      null,
      {fetch:async()=>Response.json({error:'secret internal'},{status:503})},
      {fetch:async()=>{throw new Error('test simulated network loss')}}
    ]){
      const r=await gateway.fetch(req(),env(core,'1'));
      assert.equal(r.status,503);
      assert.deepEqual(await r.json(),{error:'temporarily_unavailable'});
      assert.equal(r.headers.get('cache-control'),'no-store');
    }
    assert.equal(legacy,0);
  }finally {globalThis.fetch=previous}
});

test('OAuth grant validation errors are returned as-is without retry',async()=>{
  const previous=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;throw new Error('unexpected legacy')};
  try{
    const r=await gateway.fetch(req(),env({
      fetch:async()=>Response.json({error:'invalid_grant'},{status:400})
    },'1'));
    assert.equal(r.status,400);
    assert.deepEqual(await r.json(),{error:'invalid_grant'});
    assert.equal(legacy,0);
  }finally {globalThis.fetch=previous}
});
