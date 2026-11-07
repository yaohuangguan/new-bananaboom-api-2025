import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {createApp} from '../src/app.js';

const owner='507f1f77bcf86cd799439011';
const post='507f1f77bcf86cd799439022';
const secret='synthetic-comment-auth-secret-2026-not-production';

async function serve(repo,t){
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}
const valid=()=>new SignJWT({user:{id:owner}})
  .setProtectedHeader({alg:'HS256'})
  .setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));
const expired=()=>new SignJWT({user:{id:owner}})
  .setProtectedHeader({alg:'HS256'})
  .setIssuedAt(1).setExpirationTime(2)
  .sign(new TextEncoder().encode(secret));

test('same public comment JSON for guest, valid JWT or soft-expired session',async t=>{
  const token=await valid();
  const expected=[{_id:post,user:{displayName:'Synthetic'},comment:'Safe'}];
  let authorized=0,reads=0;
  const repo={
    authorizeSession:async received=>{
      authorized++;
      return received===token ? {id:owner,role:'user'} : null;
    },
    publicComments:async()=>{reads++;return expected}
  };
  const base=await serve(repo,t);
  for(const headers of [
    {},
    {'x-auth-token':token},
    {authorization:'Bearer '+token},
    {cookie:'orion_session='+encodeURIComponent(token)},
  ]){
    const result=await fetch(base+'/api/comments/'+post,{headers});
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),expected);
    assert.match(result.headers.get('cache-control'),/no-store/);
  }
  assert.equal(reads,4);
  assert.equal(authorized,3);
  const orphan=await new SignJWT({user:{id:owner}})
    .setProtectedHeader({alg:'HS256'})
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  // A valid JWT without session is publicly readable, matching Express soft auth.
  const res=await fetch(base+'/api/comments/reply/'+post,{
    headers:{'x-auth-token':orphan}
  });
  assert.equal(res.status,200);
  assert.equal(reads,5);
});

test('invalid/expired bearer or session cookie must not become anonymous bypass',async t=>{
  let reads=0;
  const repo={
    authorizeSession:async()=>null,
    publicComments:async()=>{reads++;return []}
  };
  const base=await serve(repo,t);
  const stale=await expired();
  for(const credential of [
    {'x-auth-token':'invalid'},
    {authorization:'Bearer '+stale},
    {cookie:'orion_session=invalid'}
  ]){
    const result=await fetch(base+'/api/comments/'+post,{headers:credential});
    assert.equal(result.status,401);
    assert.equal(result.headers.get('cache-control'),'no-store');
  }
  assert.equal(reads,0);
});

test('GET post list preserves legacy large limit=1000 response contract',async t=>{
  const options=[];
  const repo={
    publicPosts:async arg=>{
      options.push(arg);
      return {data:[{isPrivate:false}],
        pagination:{currentPage:arg.page,totalPages:1,totalPosts:1,perPage:arg.limit}};
    }
  };
  const base=await serve(repo,t);
  const res=await fetch(base+'/api/posts?page=1&limit=1000');
  assert.equal(res.status,200);
  assert.equal((await res.json()).pagination.perPage,1000);
  assert.equal(options[0].limit,1000);
});
