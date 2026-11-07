import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {createApp} from '../src/app.js';
import {parseFootprintMutation} from '../src/footprintMutations.js';

const secret='synthetic-footprint-only-2026-secret';
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
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  return 'http://127.0.0.1:'+server.address().port;
}
const body={
  location:{name:'Synthetic Auckland',coordinates:[174.76,-36.85]},
  content:'Synthetic'
};

test('Strict footprint create/update schema and idempotency reject owner injection',()=>{
  const ok=parseFootprintMutation({
    operation:'create',key:'valid-create-key-01',body
  });
  assert.equal(ok.body.location.name,'Synthetic Auckland');
  for(const input of [
    {...body,user:owner},{...body,ownerId:owner},{...body,deleteAll:true},
    {...body,location:{name:'broken',coordinates:[174.76,-190]}},
    {...body,location:{name:'bad',coordinates:['174.7',-36.8]}},
    {...body,content:'a'.repeat(2001)}
  ])assert.throws(()=>parseFootprintMutation({
    operation:'create',key:'valid-create-key-01',body:input
  }),e=>e.status===400);
  assert.throws(()=>parseFootprintMutation({
    operation:'create',key:'short',body
  }),e=>e.status===428);
  assert.throws(()=>parseFootprintMutation({
    operation:'update',id:'bad',key:'valid-update-01',body:{content:'fine'}
  }),e=>e.status===400);
  assert.throws(()=>parseFootprintMutation({
    operation:'update',id,key:'valid-update-01',body:{$set:{content:'hijack'}}
  }),e=>e.status===400);
});

test('POST/PUT/DELETE footprint endpoints require live JWT + FOOTPRINT:USE',async t=>{
  const token=await sign();
  let permitted=true,called=0;
  const repo={
    authorizeSession:async presented=>
      presented===token?{id:owner,role:'user',permissions:permitted?['FOOTPRINT:USE']:[]}:null,
    footprintMutate:async(principal,args)=>{
      called++;
      assert.equal(principal.id,owner);
      assert.equal(args.key,'synthetic-key-100');
      return {ok:true,data:{msg:'ok',operation:args.operation}};
    }
  };
  const base=await serverFor(repo,t);
  const headers={'content-type':'application/json',
    'idempotency-key':'synthetic-key-100',origin:'https://samyao.me'};
  const call=(method,path,headersExtra={},value=body)=>fetch(base+path,{
    method,headers:{...headers,...headersExtra},
    ...(method==='DELETE'?{}:{body:JSON.stringify(value)})
  });
  const paths=[
    ['POST','/api/footprints',body],
    ['PUT','/api/footprints/'+id,{content:'update'}],
    ['DELETE','/api/footprints/'+id,{}]
  ];
  for(const [method,path,value] of paths){
    const missing=await call(method,path,{},value);
    assert.equal(missing.status,401);
    const forged=await call(method,path,{'x-auth-token':'forged'},value);
    assert.equal(forged.status,401);
    const signed=await call(method,path,{'x-auth-token':token},value);
    assert.equal(signed.status,200);
    const result=await signed.json();
    assert.equal(result.msg,'ok');
  }
  assert.equal(called,3);
  permitted=false;
  const denied=await call('POST','/api/footprints',{'x-auth-token':token});
  assert.equal(denied.status,403);
  assert.equal(called,3);
});

test('Cookie mutation requires trusted Origin and blocks CSRF',async t=>{
  const token=await sign();
  let mutations=0;
  const repo={
    authorizeSession:async presented=>presented===token?{
      id:owner,role:'user',permissions:['FOOTPRINT:USE']
    }:null,
    footprintMutate:async()=>{mutations++;return {ok:true,data:{msg:'ok'}}}
  };
  const base=await serverFor(repo,t);
  const headers={'content-type':'application/json',
    cookie:'orion_session='+encodeURIComponent(token),
    'idempotency-key':'synthetic-key-200'};
  for(const orig of [null,'https://evil.example']){
    const res=await fetch(base+'/api/footprints',{
      method:'POST',headers:{...headers,...(orig?{origin:orig}:{})},
      body:JSON.stringify(body)
    });
    assert.equal(res.status,403);
  }
  assert.equal(mutations,0);
  const ok=await fetch(base+'/api/footprints',{
    method:'POST',headers:{...headers,origin:'https://samyao.me'},
    body:JSON.stringify(body)
  });
  assert.equal(ok.status,200);
  assert.equal(mutations,1);
});

test('Known 404/409/428 errors preserved, unexpected internal details redacted',async t=>{
  const token=await sign();
  const cases=[
    {ok:false,code:'FOOTPRINT_NOT_FOUND',status:404},
    {ok:false,code:'IDEMPOTENCY_CONFLICT',status:409},
    {ok:false,code:'IDEMPOTENCY_KEY_REQUIRED',status:428},
    {ok:false,code:'mongo://DO_NOT_LEAK_DB',status:503}
  ];
  let i=0;
  const repo={
    authorizeSession:async()=>({id:owner,role:'user',permissions:['FOOTPRINT:USE']}),
    footprintMutate:async()=>cases[i++]
  };
  const base=await serverFor(repo,t);
  for(const expected of [404,409,428,503]){
    const res=await fetch(base+'/api/footprints/'+id,{
      method:'PUT',headers:{'content-type':'application/json',
        origin:'https://samyao.me','x-auth-token':token,
        'idempotency-key':'synthetic-key-100'},
      body:JSON.stringify({status:'visited'})
    });
    assert.equal(res.status,expected);
    assert.equal((await res.text()).includes('DO_NOT_LEAK_DB'),false);
  }
});
