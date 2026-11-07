import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway,{isLegacyPhotoWritePath} from './src/index.js';

const base='https://api.samyao.me';
const id='507f1f77bcf86cd799439022';
const limiter={limit:async()=>({success:true})};
const env=worker=>({
  PHOTO_WRITE_AUTH_GUARD:'1',
  ORIGIN_URL:'https://legacy.invalid',
  BANANABOOM_CORE:worker,
  GENERAL_LIMITER:limiter,WRITE_LIMITER:limiter,
  AUTH_LIMITER:limiter,EXPENSIVE_LIMITER:limiter
});
function req(method,path='/api/photos',headers={}){
  return new Request(base+path,{
    method,
    headers:{
      origin:'https://samyao.me',
      'x-auth-token':'synthetic-signed-jwt',
      ...(method==='POST'||method==='PUT'?{
        'content-type':'application/json'
      }:{}),
      ...headers
    },
    ...(method==='POST'||method==='PUT'?{
      body:JSON.stringify({name:'Synthetic test only'})
    }:{})
  });
}
test('Legacy photo mutation guard matches ALL writes incl malformed path, never GET',()=>{
  for(const [method,path] of [
    ['POST','/api/photos'],['PUT','/api/photos/reorder'],
    ['PUT','/api/photos/'+id],['DELETE','/api/photos/'+id],
    ['POST','/api/photos/invalid'],['DELETE','/api/photos/special']
  ])assert.equal(isLegacyPhotoWritePath(method,path),true);
  for(const [method,path] of [
    ['GET','/api/photos'],['HEAD','/api/photos'],
    ['PUT','/api/photo'],['DELETE','/api/posts/'+id],
    ['POST','/api/photographs']
  ])assert.equal(isLegacyPhotoWritePath(method,path),false);
});

test('Valid Core preflight 204 forwards original write exactly once to unchanged Cloud Run',async()=>{
  const old=globalThis.fetch;
  let checked=0,legacy=0;
  globalThis.fetch=async r=>{
    legacy++;
    assert.equal(r.headers.get('x-auth-token'),'synthetic-signed-jwt');
    if(r.method!=='DELETE'){
      assert.deepEqual(await r.json(),{name:'Synthetic test only'});
    }
    return Response.json({via:'legacy',operation:r.method});
  };
  try{
    const core={fetch:async r=>{
      checked++;
      assert.equal(new URL(r.url).pathname,'/_internal/authorize-photos-write');
      assert.equal(r.method,'POST');
      assert.equal(r.headers.get('content-length'),null);
      assert.equal(r.headers.get('content-type'),null);
      assert.equal(r.headers.get('x-orion-edge-secret'),null);
      assert.equal(r.headers.get('x-auth-token'),'synthetic-signed-jwt');
      assert.equal(await r.text(),'');
      return new Response(null,{status:204});
    }};
    for(const [method,path] of [
      ['POST','/api/photos'],['PUT','/api/photos/reorder'],
      ['PUT','/api/photos/'+id],['DELETE','/api/photos/'+id]
    ]){
      const result=await gateway.fetch(req(method,path),env(core));
      assert.equal(result.status,200);
      assert.equal((await result.json()).via,'legacy');
    }
    assert.equal(checked,4);assert.equal(legacy,4);
  }finally{globalThis.fetch=old}
});

test('Preflight denies invalid, revoked or insufficient privileges before any legacy mutation',async()=>{
  const old=globalThis.fetch;
  let legacy=0,checks=0;
  globalThis.fetch=async()=>{legacy++;throw Error('MUST NOT HIT LEGACY')};
  try{
    const all=[
      [req('POST','/api/photos',{'x-auth-token':''}),401],
      [req('POST','/api/photos',{'x-auth-token':'','x-google-auth':'{}'}),401],
      [req('DELETE','/api/photos/'+id),401],
      [req('PUT','/api/photos/reorder'),403],
      [req('POST','/api/photos'),503]
    ];
    const statuses=[401,403,503];
    for(const status of statuses){
      let attempts=0;
      const stub={fetch:async()=>{checks++;attempts++;
        return Response.json({internal:'do-not-leak'},{status});
      }};
      const res=await gateway.fetch(
        req('POST','/api/photos'),env(stub)
      );
      assert.equal(res.status,status);
      assert.equal((await res.text()).includes('do-not-leak'),false);
      assert.equal(attempts,1);
    }
    for(const request of [all[0][0],all[1][0]]){
      const res=await gateway.fetch(request,env({
        fetch:async()=>{throw Error('Cannot invoke Core for absent user')}
      }));
      assert.equal(res.status,401);
    }
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old}
});

test('Missing Core or Core network exception fails closed, not Cloud Run',async()=>{
  const old=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;throw Error('Unprotected write')};
  try{
    for(const core of [
      undefined,
      {fetch:async()=>{throw Error('Core offline')}},
      {fetch:async()=>Response.json({error:'unavailable'},{status:503})}
    ]){
      const r=await gateway.fetch(req('DELETE','/api/photos/'+id),env(core));
      assert.equal(r.status,503);
    }
    assert.equal(legacy,0);
  }finally{globalThis.fetch=old}
});

test('Photo public reads never run administrative preflight',async()=>{
  const old=globalThis.fetch;
  let checked=0;
  globalThis.fetch=async()=>Response.json({via:'legacy'});
  try{
    const r=await gateway.fetch(new Request(base+'/api/photos'),
      env({fetch:async()=>{checked++;return Response.json([{url:'public'}])}}));
    assert.equal(r.status,200);
    assert.deepEqual(await r.json(),[{url:'public'}]);
    assert.equal(checked,1); // Normal public GET routes to Core, no _internal preflight
  }finally{globalThis.fetch=old}
});
