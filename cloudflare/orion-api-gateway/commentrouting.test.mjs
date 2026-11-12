import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway from './src/index.js';
const post='507f1f77bcf86cd799439022';
const limiter={limit:async()=>({success:true})};
const make=(path, headers={}, method='POST')=>new Request('https://api.samyao.me'+path,{
  method,headers:{origin:'https://samyao.me','x-auth-token':'synthetic-session',
    'idempotency-key':'synthetic-comment-key','content-type':'application/json',...headers},
  ...(method==='POST'?{body:JSON.stringify({comment:'Synthetic comment'})}:{})
});
function environment(canary='1', cutover='0') {
  return {ORIGIN_URL:'https://legacy.invalid',COMMENT_WRITE_CANARY:canary,
    COMMENT_WRITE_CUTOVER:cutover,GENERAL_LIMITER:limiter,WRITE_LIMITER:limiter,
    AUTH_LIMITER:limiter,EXPENSIVE_LIMITER:limiter,
    BANANABOOM_CORE:{fetch:async()=>Response.json({via:'worker'})}};
}
async function withLegacy(run) {
  const previous=globalThis.fetch;
  let count=0;
  globalThis.fetch=async()=>{count++;return Response.json({via:'legacy'})};
  try {await run(()=>count)} finally {globalThis.fetch=previous}
}
test('A pinned Worker operation fails closed when its server gate is disabled',async()=>{
  await withLegacy(async count=>{
    const r=await gateway.fetch(make('/api/comments/'+post,
      {'x-orion-comment-write-route':'worker'}),environment('0','0'));
    assert.equal(r.status,503);assert.equal(count(),0);
  });
});
test('A legacy operation and old clients never switch on global cutover',async()=>{
  await withLegacy(async count=>{
    for(const headers of [{},{'x-orion-comment-write-route':'legacy'},
      {'x-orion-comment-write-route':'legacy','x-orion-comment-write-canary':'1'}]){
      const r=await gateway.fetch(make('/api/comments/'+post,headers),environment('1','1'));
      assert.equal((await r.json()).via,'legacy');
    }
    assert.equal(count(),3);
  });
});
test('Pending Worker operations remain on Worker during a default-route rollback',async()=>{
  await withLegacy(async count=>{
    for(const cutover of ['1','0']){
      const r=await gateway.fetch(make('/api/comments/'+post,
        {'x-orion-comment-write-route':'worker'}),environment('1',cutover));
      assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
    }
    assert.equal(count(),0);
  });
});
test('Unpinned old canaries and invalid pins fail before any mutation',async()=>{
  await withLegacy(async count=>{
    for(const headers of [
      {'x-orion-comment-write-canary':'1'},
      {'x-orion-comment-write-route':'unknown'}]){
      const r=await gateway.fetch(make('/api/comments/'+post,headers),environment());
      assert.equal(r.status,428);
    }
    assert.equal(count(),0);
  });
});
test('Read-only policy chooses routes for new operations, remains private and permits CORS',async()=>{
  await withLegacy(async count=>{
    for(const [flags,headers,route] of [
      [['0','0'],{},'legacy'],
      [['1','0'],{},'legacy'],
      [['1','0'],{'x-orion-comment-write-canary':'1'},'worker'],
      [['1','1'],{},'worker'],
      [['1','1'],{'x-google-auth':'synthetic-google'},'legacy'],
      [['1','1'],{'x-auth-token':''},'legacy'],
      [['0','1'],{},'legacy']
    ]){
      const r=await gateway.fetch(make('/api/comments/write-policy',headers,'GET'),
        environment(...flags));
      assert.equal(r.status,200);
      assert.deepEqual(await r.json(),{version:2,route});
      assert.equal(r.headers.get('cache-control'),'private, no-store');
      assert.equal(r.headers.get('access-control-allow-origin'),'https://samyao.me');
      assert.equal(r.headers.get('access-control-allow-credentials'),'true');
    }
    assert.equal(count(),0);
  });
});
