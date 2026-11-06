import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';

const url='https://api.samyao.me/api/users/signin';
const form=JSON.stringify({email:'sam@example.invalid',password:'[never-logged]'});
function env(core,flag='0'){
  return {
    ORIGIN_URL:'https://old.example',
    PASSWORD_AUTH_CUTOVER:flag,
    GENERAL_LIMITER:{limit:async()=>({success:true})},
    AUTH_LIMITER:{limit:async()=>({success:true})},
    WRITE_LIMITER:{limit:async()=>({success:true})},
    BANANABOOM_CORE:core
  };
}
const req=(path=url,canary=false,headers={})=>new Request(path,{
  method:'POST',headers:{
    'content-type':'application/json',
    origin:'https://samyao.me',
    ...(canary?{'x-orion-password-worker-canary':'1'}:{}),
    ...headers
  },
  body:form
});

test('password migration without flag or canary preserves Cloud Run route',async()=>{
  const previous=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    const result=await gateway.fetch(req(),env({fetch:async()=>{core++;return Response.json({})}},'0'));
    assert.equal(result.status,200);
    assert.equal((await result.json()).origin,'legacy');
    assert.equal(legacy,1);
    assert.equal(core,0);
  }finally{globalThis.fetch=previous}
});

test('explicit canary sends password only once to Core and preserves cookie',async()=>{
  const previous=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;throw new Error('unexpected legacy replay')};
  try{
    const result=await gateway.fetch(req(url,true),env({
      fetch:async(request)=>{
        core++;
        assert.equal(request.headers.get('x-orion-password-worker-canary'),null);
        assert.equal(request.headers.get('x-orion-edge-secret'),null);
        assert.equal((await request.json()).password,'[never-logged]');
        return new Response(JSON.stringify({token:'test-token',user:{role:'user'}}),{
          status:200,headers:{
            'content-type':'application/json',
            'set-cookie':'orion_session=test-token; Path=/; HttpOnly; Secure; SameSite=Lax'
          }
        });
      }
    }));
    assert.equal(result.status,200);
    assert.equal(result.headers.get('x-bananaboom-origin'),'worker');
    assert.equal(result.headers.get('access-control-allow-credentials'),'true');
    assert.match(result.headers.get('set-cookie')||'',/HttpOnly/);
    assert.equal(core,1);
    assert.equal(legacy,0);
  }finally{globalThis.fetch=previous}
});

test('auth failure must never replay a login to legacy origin',async()=>{
  const previous=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    for(const impl of [
      {fetch:async()=>new Response('failed',{status:503})},
      {fetch:async()=>{throw new Error('service binding failure')}},
      null
    ]){
      const result=await gateway.fetch(req(url,true),env(impl));
      assert.equal(result.status,503);
      assert.equal(result.headers.get('access-control-allow-origin'),'https://samyao.me');
      assert.equal(result.headers.get('access-control-allow-credentials'),'true');
      assert.equal((await result.json()).message.includes('unknown'),true);
      assert.equal(legacy,0);
    }
  }finally{globalThis.fetch=previous}
});

test('Google-auth carrier never goes to password-only Worker',async()=>{
  const previous=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    const result=await gateway.fetch(req(url,true,{'x-google-auth':'{}'}),env({
      fetch:async()=>{core++;return Response.json({})}
    },'1'));
    assert.equal(result.status,200);
    assert.equal(core,0);
    assert.equal(legacy,1);
  }finally{globalThis.fetch=previous}
});
