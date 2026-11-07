import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway, {isTodoListReadCandidate} from './src/index.js';

const signed = new Headers({cookie:'other=value; orion_session=fake-jwt'});
const canary = new Headers({cookie:'orion_session=fake-jwt','x-orion-todo-read-canary':'1'});

test('Todo canary is authenticated, read-only and narrowly query-scoped',()=>{
  assert.equal(isTodoListReadCandidate('GET','/api/todos','',signed,false),false);
  assert.equal(isTodoListReadCandidate('GET','/api/todos','',signed,true),true);
  assert.equal(isTodoListReadCandidate('GET','/api/todo','',signed,true),true);
  assert.equal(isTodoListReadCandidate('GET','/api/todos','?page=2&limit=15&type=wish&keyword=coffee&isActive=true',canary,false),true);
  assert.equal(isTodoListReadCandidate('GET','/api/todos','',canary,false),true);
  for(const [method,path,search,headers] of [
    ['GET','/api/todos','',new Headers()],
    ['GET','/api/todos','',new Headers({cookie:'gaesa=unrelated'})],
    ['POST','/api/todos','',canary],
    ['GET','/api/todos/done/507f1f77bcf86cd799439011','',canary],
    ['GET','/api/todos','?page=1&page=2',canary],
    ['GET','/api/todos','?limit=9999',canary],
    ['GET','/api/todos','?isActive=maybe',canary],
    ['GET','/api/todos','?user=admin',canary],
    ['GET','/api/todos','?type=unknown',canary],
    ['GET','/api/todos','',new Headers({authorization:'Bearer jwt','x-google-auth':'other','x-orion-todo-read-canary':'1'})]
  ]) assert.equal(isTodoListReadCandidate(method,path,search,headers,true),false);
});

test('Todo canary passes live session but strips canary header from Core request',async()=>{
  const oldFetch=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'});};
  const env={
    ORIGIN_URL:'https://legacy.example',TODO_READ_CUTOVER:'0',
    GENERAL_LIMITER:{limit:async()=>({success:true})},
    AUTH_LIMITER:{limit:async()=>({success:true})},
    BANANABOOM_CORE:{fetch:async(request)=>{
      core++;
      assert.equal(request.headers.get('x-orion-todo-read-canary'),null);
      assert.equal(request.headers.get('cookie'),'orion_session=fake-jwt');
      return Response.json({data:[],pagination:{total:0,page:1,limit:20,totalPages:0}});
    }}
  };
  try{
    const r=await gateway.fetch(new Request('https://api.samyao.me/api/todos',{headers:canary}),env);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
    assert.equal((await r.json()).pagination.total,0);
    assert.equal(core,1);
    assert.equal(legacy,0);
  }finally{globalThis.fetch=oldFetch;}
});

test('Todo Worker 5xx safely falls back to read-only Cloud Run',async()=>{
  const oldFetch=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'});};
  const env={
    ORIGIN_URL:'https://legacy.example',TODO_READ_CUTOVER:'1',
    GENERAL_LIMITER:{limit:async()=>({success:true})},
    AUTH_LIMITER:{limit:async()=>({success:true})},
    BANANABOOM_CORE:{fetch:async()=>{core++;return Response.json({error:'unavailable'},{status:503});}}
  };
  try{
    const r=await gateway.fetch(new Request('https://api.samyao.me/api/todos',{
      headers:signed
    }),env);
    assert.equal(r.status,200);
    assert.equal((await r.json()).from,'legacy');
    assert.equal(core,1);
    assert.equal(legacy,1);
  }finally{globalThis.fetch=oldFetch;}
});
