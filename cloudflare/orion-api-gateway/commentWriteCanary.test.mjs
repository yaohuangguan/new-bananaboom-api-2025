import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway, {isCommentWritePath} from './src/index.js';

const base='https://api.samyao.me';
const post='507f1f77bcf86cd799439022';
const limiter={limit:async()=>({success:true})};
const env=(binding,flag='0')=>({
  ORIGIN_URL:'https://legacy.invalid', BANANABOOM_CORE:binding,
  COMMENT_WRITE_CANARY:flag, GENERAL_LIMITER:limiter,
  WRITE_LIMITER:limiter,AUTH_LIMITER:limiter,EXPENSIVE_LIMITER:limiter
});
const make=(path, extras={}, body={content:'Synthetic user comment'})=>new Request(base+path,{
  method:'POST',
  headers:{
    origin:'https://samyao.me', 'x-auth-token':'synthetic-signed-jwt',
    'idempotency-key':'synthetic-comment-01', 'x-orion-comment-write-canary':'1',
    'content-type':'application/json',...extras
  },
  body:JSON.stringify(body)
});

test('Only the two legacy comment POST routes are eligible',()=>{
  assert.equal(isCommentWritePath('POST','/api/comments/'+post),true);
  assert.equal(isCommentWritePath('POST','/api/comments/reply/'+post),true);
  for(const [method,path] of [
    ['GET','/api/comments/'+post],['DELETE','/api/comments/'+post],
    ['POST','/api/comments'],['POST','/api/comments/admin/reset'],
    ['POST','/api/comments/bad'],['POST','/api/comments/reply/bad'],
    ['POST','/api/footprints'],['POST','/api/brain/sync/mcp']
  ]) assert.equal(isCommentWritePath(method,path),false);
});

test('Flag OFF makes arbitrary user canary header ineffective and strips it at legacy',async()=>{
  const old=globalThis.fetch;
  let cloudRun=0,worker=0;
  globalThis.fetch=async request=>{
    cloudRun++;
    assert.equal(request.headers.get('x-orion-comment-write-canary'),null);
    return Response.json({via:'legacy'});
  };
  try{
    const response=await gateway.fetch(make('/api/comments/'+post),
      env({fetch:async()=>{worker++;return Response.json({via:'worker'})}}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).via,'legacy');
    assert.equal(worker,0);assert.equal(cloudRun,1);
  }finally{globalThis.fetch=old}
});

test('Enabled comment and reply opt-in forward body and session to Core once',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>{throw Error('must not call legacy')};
  let count=0;
  try {
    for(const path of ['/api/comments/'+post,'/api/comments/reply/'+post]){
      const response=await gateway.fetch(make(path,{'x-orion-edge-secret':'spoofed'},
        {content:'Synthetic user comment'}),env({fetch:async request=>{
        count++;
        assert.equal(request.headers.get('x-orion-edge-secret'),null);
        assert.equal(request.headers.get('x-orion-comment-write-canary'),null);
        assert.equal(request.headers.get('x-auth-token'),'synthetic-signed-jwt');
        assert.equal(request.headers.get('idempotency-key'),'synthetic-comment-01');
        assert.deepEqual(await request.json(),{content:'Synthetic user comment'});
        return Response.json({via:'worker'});
      }},'1'));
      assert.equal(response.status,200);
      assert.equal(response.headers.get('x-bananaboom-origin'),'worker');
      assert.equal((await response.json()).via,'worker');
    }
    assert.equal(count,2);
  }finally{globalThis.fetch=old}
});

test('Enabled canary missing creds/key or Google-only fails before Core',async()=>{
  const old=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({})};
  try{
    const binding={fetch:async()=>{core++;return Response.json({})}};
    for(const [headers,status] of [
      [{'x-auth-token':''},401],
      [{'x-google-auth':'firebase-token'},401],
      [{'idempotency-key':''},428],
      [{'idempotency-key':'short'},428]
    ]){
      const r=await gateway.fetch(make('/api/comments/'+post,headers),env(binding,'1'));
      assert.equal(r.status,status);
    }
    assert.equal(legacy,0);assert.equal(core,0);
  }finally{globalThis.fetch=old}
});

test('Missing binding, 503 and throw never replay a comment mutation',async()=>{
  const old=globalThis.fetch;
  let replay=0;
  globalThis.fetch=async()=>{replay++;throw Error('MUST NOT REPLAY')};
  try{
    for(const binding of [undefined,
      {fetch:async()=>Response.json({secret:'internal'}, {status:503})},
      {fetch:async()=>{throw Error('Connection internal')}}]){
      const r=await gateway.fetch(make('/api/comments/'+post),env(binding,'1'));
      assert.equal(r.status,503);
      const body=await r.text();
      assert.equal(body.includes('internal'),false);
      assert.match(body,/same Idempotency-Key/);
    }
    assert.equal(replay,0);
  }finally{globalThis.fetch=old}
});
