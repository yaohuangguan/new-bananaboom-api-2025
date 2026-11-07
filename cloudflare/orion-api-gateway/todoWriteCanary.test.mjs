import {test} from 'node:test';
import assert from 'node:assert/strict';
import gateway,{isTodoWritePath,isTodoDetailCandidate} from './src/index.js';

const base='https://api.samyao.me';
const taskId='507f1f77bcf86cd799439022';
const limiter={limit:async()=>({success:true})};

function env(worker,flags={}) {
  return {
    ORIGIN_URL:'https://legacy.invalid',
    TODO_WRITE_CANARY:'0',
    TODO_DETAIL_READ_CUTOVER:'0',
    TODO_READ_CUTOVER:'0',
    GENERAL_LIMITER:limiter,WRITE_LIMITER:limiter,
    AUTH_LIMITER:limiter,EXPENSIVE_LIMITER:limiter,
    BANANABOOM_CORE:worker,
    ...flags
  };
}
function request(path='/api/todos',options={}) {
  const method=options.method||'POST';
  return new Request(base+path,{
    method,
    headers:{
      origin:'https://samyao.me',
      cookie:'orion_session=synthetic-jwt',
      ...(options.canary?{'x-orion-todo-write-canary':'1'}:{}),
      ...(method==='POST'?{'content-type':'application/json',
        'idempotency-key':'synthetic-todo-key-01'}:{}),
      ...options.headers
    },
    ...(['POST','PUT','PATCH'].includes(method)?{
      body:JSON.stringify(options.body||{todo:'Synthetic test'})
    }:{})
  });
}

test('Todo mutation route allowlist is narrow',()=>{
  assert.equal(isTodoWritePath('POST','/api/todos'),true);
  assert.equal(isTodoWritePath('POST','/api/todos/done/'+taskId),true);
  assert.equal(isTodoWritePath('POST','/api/todos/routine/'+taskId+'/check'),true);
  assert.equal(isTodoWritePath('DELETE','/api/todos/'+taskId),true);
  for(const [method,path] of [
    ['POST','/api/todos/routine/'+taskId+'/test'],
    ['POST','/api/todos/done/not-an-id'],
    ['GET','/api/todos'],['DELETE','/api/todos/invalid'],
    ['POST','/api/todos/favorites'],['PUT','/api/todos']
  ])assert.equal(isTodoWritePath(method,path),false);
  assert.equal(isTodoDetailCandidate('GET','/api/todos/done/'+taskId,'',
    {cookie:'orion_session=fake','x-orion-todo-detail-canary':'1'}),true);
  assert.equal(isTodoDetailCandidate('GET','/api/todos/done/'+taskId,'',
    {'x-orion-todo-detail-canary':'1'}),false);
});

test('Normal Todo writes never switch unless server flag and canary both allow',async()=>{
  const before=globalThis.fetch;
  let old=0,core=0;
  globalThis.fetch=async()=>{old++;return Response.json({origin:'legacy'})};
  try{
    for(const flags of [{},{TODO_WRITE_CANARY:'1'}]){
      const r=await gateway.fetch(request('/api/todos',{canary:!flags.TODO_WRITE_CANARY}),
        env({fetch:async()=>{core++;return Response.json({origin:'worker'})}},flags));
      assert.equal(r.status,200);
      assert.equal((await r.json()).origin,'legacy');
    }
    assert.equal(old,2);assert.equal(core,0);
  }finally{globalThis.fetch=before}
});

test('Todo write passes signed cookie and idempotency key once to Worker',async()=>{
  const prior=globalThis.fetch;
  let legacy=0,forwarded=0;
  globalThis.fetch=async()=>{legacy++;throw Error('Do not replay mutation')};
  try{
    const original=request('/api/todos',{
      canary:true,
      headers:{'x-orion-edge-secret':'spoofed'},
      body:{todo:'Synthetic todo'}
    });
    const r=await gateway.fetch(original,env({
      fetch:async req=>{
        forwarded++;
        assert.equal(req.headers.get('cookie'),'orion_session=synthetic-jwt');
        assert.equal(req.headers.get('idempotency-key'),'synthetic-todo-key-01');
        assert.equal(req.headers.get('x-orion-todo-write-canary'),null);
        assert.equal(req.headers.get('x-orion-edge-secret'),null);
        assert.equal(req.method,'POST');
        assert.deepEqual(await req.json(),{todo:'Synthetic todo'});
        return Response.json([{todo:'Synthetic todo'}]);
      }
    },{TODO_WRITE_CANARY:'1'}));
    assert.equal(r.status,200);
    assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
    assert.equal((await r.json())[0].todo,'Synthetic todo');
    assert.equal(legacy,0);assert.equal(forwarded,1);
  }finally{globalThis.fetch=prior}
});

test('Todo writes fail closed on every 503, exception or missing Worker',async()=>{
  const before=globalThis.fetch;
  let legacy=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    for(const worker of [
      undefined,
      {fetch:async()=>Response.json({internal:'sensitive'},{status:503})},
      {fetch:async()=>{throw Error('database lost')}}
    ]){
      const r=await gateway.fetch(request('/api/todos',{canary:true}),
        env(worker,{TODO_WRITE_CANARY:'1'}));
      assert.equal(r.status,503);
      const output=await r.json();
      assert.ok(output.message.includes('Todo Worker operation unavailable'));
      assert.equal(JSON.stringify(output).includes('sensitive'),false);
    }
    assert.equal(legacy,0);
  }finally{globalThis.fetch=before}
});

test('Todo canary has strict auth, no alternate Google authentication bypass',async()=>{
  const before=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    const worker={fetch:async()=>{core++;return Response.json({origin:'worker'})}};
    const missing=request('/api/todos',{
      canary:true,headers:{cookie:''}
    });
    const r=await gateway.fetch(missing,env(worker,{TODO_WRITE_CANARY:'1'}));
    assert.equal(r.status,401);
    const google=request('/api/todos',{
      canary:true,headers:{'x-google-auth':'some-other-identity'}
    });
    const denied=await gateway.fetch(google,env(worker,{TODO_WRITE_CANARY:'1'}));
    assert.equal(denied.status,401);
    assert.equal(legacy,0);assert.equal(core,0);
  }finally{globalThis.fetch=before}
});

test('Todo detail requires session during canary and will not bypass owner-check failure',async()=>{
  const before=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({origin:'legacy'})};
  try{
    const worker={fetch:async req=>{
      core++;
      assert.equal(req.headers.get('x-orion-todo-detail-canary'),null);
      return Response.json({message:'owner validation unavailable'},{status:503});
    }};
    const missing=request('/api/todos/done/'+taskId,{
      method:'GET',
      headers:{cookie:'','x-orion-todo-detail-canary':'1'}
    });
    const noAuth=await gateway.fetch(missing,env(worker));
    assert.equal(noAuth.status,401);
    const withAuth=request('/api/todos/done/'+taskId,{
      method:'GET',
      headers:{'x-orion-todo-detail-canary':'1'}
    });
    const result=await gateway.fetch(withAuth,env(worker));
    assert.equal(result.status,503);
    assert.equal(legacy,0);assert.equal(core,1);
  }finally{globalThis.fetch=before}
});
