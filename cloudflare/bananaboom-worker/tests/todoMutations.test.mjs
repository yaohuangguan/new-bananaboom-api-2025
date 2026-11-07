import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {createApp} from '../src/app.js';

const secret='synthetic-not-production-jwt-secret-this-test-2026';
const owner='507f1f77bcf86cd799439011';
const task='507f1f77bcf86cd799439022';

async function signedToken() {
  return new SignJWT({user:{id:owner}})
    .setProtectedHeader({alg:'HS256'})
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}
const listen=async(repo,t)=>{
  const app=createApp(repo,{secretProvider:async()=>({legacy:secret,next:null})});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
};

test('Todo mutation routes require a verified existing JWT and live RBAC',async t=>{
  let invoked=0;
  const token=await signedToken();
  const repo={
    authorizeSession:async presented=>presented===token?{
      id:owner,role:'user',permissions:['TODO:USE']
    }:null,
    todoMutate:async()=>{invoked++;return {ok:true,data:[]}},
    todoDetail:async()=>{invoked++;return {ok:true,data:{_id:task,todo:'Synthetic'}}}
  };
  const base=await listen(repo,t);
  const post=(headers)=>fetch(base+'/api/todos',{
    method:'POST',headers:{origin:'https://samyao.me',
      'content-type':'application/json','idempotency-key':'create-key-001',
      ...headers},
    body:JSON.stringify({todo:'Synthetic task'})
  });
  let r=await post({});
  assert.equal(r.status,401);
  assert.equal(invoked,0);
  r=await post({'x-auth-token':'invalid-token'});
  assert.equal(r.status,401);
  assert.equal(invoked,0);
  r=await post({'x-auth-token':token});
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),[]);
  assert.equal(invoked,1);
  r=await fetch(base+'/api/todos/done/'+task);
  assert.equal(r.status,401);
  r=await fetch(base+'/api/todos/done/'+task,{
    headers:{'x-auth-token':token,origin:'https://samyao.me'}
  });
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{_id:task,todo:'Synthetic'});
  assert.equal(invoked,2);
});

test('Todo write accepts cookie only from first-party trusted Origin',async t=>{
  const token=await signedToken();
  let mutations=0;
  const repo={
    authorizeSession:async presented=>presented===token?{
      id:owner,role:'user',permissions:['TODO:USE']
    }:null,
    todoMutate:async()=>{mutations++;return {ok:true,data:{success:true}}}
  };
  const base=await listen(repo,t);
  const url=base+'/api/todos/done/'+task;
  const headers={
    'content-type':'application/json',
    'idempotency-key':'update-key-001',
    cookie:'orion_session='+encodeURIComponent(token)
  };
  let r=await fetch(url,{method:'POST',headers,body:'{"done":true}'});
  assert.equal(r.status,403);
  r=await fetch(url,{method:'POST',
    headers:{...headers,origin:'https://attacker.example'},
    body:'{"done":true}'});
  assert.equal(r.status,403);
  assert.equal(mutations,0);
  r=await fetch(url,{method:'POST',
    headers:{...headers,origin:'https://samyao.me'},
    body:'{"done":true}'});
  assert.equal(r.status,200);
  assert.equal(mutations,1);
});

test('Todo RBAC denial and known 404/409/428 errors are not retried',async t=>{
  const token=await signedToken();
  const repo={
    authorizeSession:async()=>({id:owner,role:'user',permissions:[]}),
    todoMutate:async()=>{throw Error('should not execute');}
  };
  const base=await listen(repo,t);
  const r=await fetch(base+'/api/todos',{
    method:'POST',headers:{origin:'https://samyao.me',
      'x-auth-token':token,'content-type':'application/json',
      'idempotency-key':'create-key-001'},
    body:'{"todo":"Synthetic"}'
  });
  assert.equal(r.status,403);
});

test('Todo operation reports safe idempotency errors and never exposes details',async t=>{
  const token=await signedToken();
  const messages=[
    {ok:false,status:428,code:'TODO_IDEMPOTENCY_KEY_REQUIRED'},
    {ok:false,status:409,code:'IDEMPOTENCY_CONFLICT'},
    {ok:false,status:404,code:'TODO_NOT_FOUND'},
    {ok:false,status:503,code:'Mongo connection debug should not leak'}
  ];
  let index=0;
  const repo={
    authorizeSession:async()=>({id:owner,role:'user',permissions:['TODO:USE']}),
    todoMutate:async()=>messages[index++]
  };
  const base=await listen(repo,t);
  const invoke=()=>fetch(base+'/api/todos',{
    method:'POST',
    headers:{origin:'https://samyao.me','x-auth-token':token,
      'content-type':'application/json','idempotency-key':'create-key-001'},
    body:'{"todo":"Synthetic"}'
  });
  for(const expected of [428,409,404,503]){
    const result=await invoke();
    assert.equal(result.status,expected);
    const body=await result.text();
    assert.equal(body.includes('Mongo connection debug'),false);
  }
});
