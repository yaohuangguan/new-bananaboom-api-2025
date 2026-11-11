import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {createApp} from '../src/app.js';
import {parseCommentMutation} from '../src/commentMutations.js';

const secret='synthetic-comment-signing-secret-2026';
const owner='507f1f77bcf86cd799439011';
const id='507f1f77bcf86cd799439022';
const sign=()=>new SignJWT({user:{id:owner}})
  .setProtectedHeader({alg:'HS256'})
  .setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));
async function serverFor(repo,t){
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}

test('Comment input is strictly bounded; no caller owner injection',()=>{
  const valid=parseCommentMutation({operation:'create',id,key:'synthetic-ckey-01',
    body:{comment:'A valid synthetic comment'}});
  assert.equal(valid.content,'A valid synthetic comment');
  for(const body of [
    {content:'  '},{content:'x'.repeat(4001)},{content:12},
    {content:'okay',user:owner},{content:'okay',$set:{user:id}},
    {content:'okay',targetUser:id}
  ]) assert.throws(()=>parseCommentMutation({
    operation:'create',id,key:'synthetic-ckey-01',body
  }),e=>e.status===400);
  assert.throws(()=>parseCommentMutation({
    operation:'reply',id,key:'synthetic-ckey-01',
    body:{reply:'hi',targetUser:'invalid'}
  }),e=>e.status===400);
  assert.throws(()=>parseCommentMutation({
    operation:'create',id,key:'short',body:{content:'hi'}
  }),e=>e.status===428);
});

test('Comments require signed live session; do not leak DB failures',async t=>{
  const token=await sign();
  let current=true,called=0;
  const repo={
    authorizeSession:async incoming=>incoming===token&&current?{
      id:owner, role:'user', permissions:[]
    }:null,
    commentMutate:async(user,actualToken,input)=>{
      called++;
      assert.equal(user.id,owner);
      assert.equal(actualToken,token);
      assert.equal(input.key,'synthetic-comment-01');
      return {ok:true,data: input.operation==='create'?
        {content:'Synthetic'}:[{reply:[]}]};
    }
  };
  const base=await serverFor(repo,t);
  const path='/api/comments/'+id;
  const headers={origin:'https://samyao.me','content-type':'application/json',
    'idempotency-key':'synthetic-comment-01'};
  const call=extra=>fetch(base+path,{method:'POST',
    headers:{...headers,...extra},body:JSON.stringify({content:'Synthetic'})});
  assert.equal((await call({})).status,401);
  assert.equal((await call({'x-auth-token':'forged'})).status,401);
  assert.equal((await call({'x-auth-token':token})).status,200);
  assert.equal(called,1);
  current=false;
  assert.equal((await call({'x-auth-token':token})).status,401);
  assert.equal(called,1);
});

test('Cookie auth requires same-site origin; parse errors never invoke DB',async t=>{
  const token=await sign();
  let called=0;
  const repo={
    authorizeSession:async()=>({id:owner,role:'user',permissions:[]}),
    commentMutate:async()=>{called++;return {ok:false,code:'INVALID_COMMENT_INPUT',status:400}}
  };
  const base=await serverFor(repo,t);
  for(const origin of [null,'https://evil.example']){
    const result=await fetch(base+'/api/comments/'+id,{method:'POST',
      headers:{'content-type':'application/json',
        cookie:'orion_session='+encodeURIComponent(token),
        ...(origin?{origin}:{})},
      body:JSON.stringify({content:'Synthetic'})});
    assert.equal(result.status,403);
  }
  assert.equal(called,0);
  const body=await fetch(base+'/api/comments/'+id,{method:'POST',
    headers:{'content-type':'application/json',origin:'https://samyao.me',
      'x-auth-token':token,'idempotency-key':'synthetic-comment-01'},
    body:JSON.stringify({content:'Synthetic'})});
  assert.equal(body.status,400);
  assert.equal(called,1);
});
