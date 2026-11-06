import { test } from 'node:test';
import assert from 'node:assert/strict';
import gateway, { isFootprintReadCandidate } from './src/index.js';

const jwt=new Headers({cookie:'other=c; orion_session=session'});
const canary=new Headers({cookie:'orion_session=session','x-orion-footprint-read-canary':'1'});

test('footprint list canary is JWT-only and cannot route mutations or other identities',()=>{
  assert.equal(isFootprintReadCandidate('GET','/api/footprints','',jwt,false),false);
  assert.equal(isFootprintReadCandidate('GET','/api/footprints','',jwt,true),true);
  assert.equal(isFootprintReadCandidate('GET','/api/footprints','?status=visited',canary,false),true);
  assert.equal(isFootprintReadCandidate('GET','/api/footprints','?status=planned',canary,false),true);
  for(const [method,path,search,headers] of [
    ['GET','/api/footprints','',new Headers()],
    ['GET','/api/footprints','',new Headers({cookie:'other=irrelevant'})],
    ['POST','/api/footprints','',canary],
    ['PUT','/api/footprints/507f1f77bcf86cd799439011','',canary],
    ['GET','/api/footprints/507f1f77bcf86cd799439011','',canary],
    ['GET','/api/footprints','?status=visited&status=planned',canary],
    ['GET','/api/footprints','?user=someone',canary],
    ['GET','/api/footprints','?status=hidden',canary],
    ['GET','/api/footprints','',new Headers({authorization:'Bearer xx','x-google-auth':'yes','x-orion-footprint-read-canary':'1'})]
  ]) assert.equal(isFootprintReadCandidate(method,path,search,headers,true),false);
});

test('canary routes only to Worker; never sends canary header to Core',async()=>{
  const prev=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async()=>{legacy++;return Response.json({from:'legacy'});};
  const env={
    ORIGIN_URL:'https://legacy.example',FOOTPRINT_READ_CUTOVER:'0',
    GENERAL_LIMITER:{limit:async()=>({success:true})},
    BANANABOOM_CORE:{fetch:async(req)=>{
      core++;
      assert.equal(req.headers.get('x-orion-footprint-read-canary'),null);
      assert.equal(req.headers.get('cookie'),'orion_session=session');
      return Response.json({code:200,stats:{totalCount:0},data:[]});
    }}
  };
  try{
    const r=await gateway.fetch(new Request('https://api.samyao.me/api/footprints',{headers:canary}),env);
    assert.equal(r.status,200);
    assert.equal(r.headers.get('x-bananaboom-origin'),'worker');
    assert.equal((await r.json()).code,200);
    assert.equal(legacy,0);
    assert.equal(core,1);
  }finally{globalThis.fetch=prev;}
});

test('Worker 503 fails back to read-only Cloud Run without mutation',async()=>{
  const prev=globalThis.fetch;
  let legacy=0,core=0;
  globalThis.fetch=async(req)=>{legacy++;assert.equal(req.method,'GET');return Response.json({from:'legacy'});};
  const env={
    ORIGIN_URL:'https://legacy.example',FOOTPRINT_READ_CUTOVER:'1',
    GENERAL_LIMITER:{limit:async()=>({success:true})},
    BANANABOOM_CORE:{fetch:async()=>{core++;return Response.json({message:'unavailable'},{status:503});}}
  };
  try{
    const r=await gateway.fetch(new Request('https://api.samyao.me/api/footprints',{headers:jwt}),env);
    assert.equal(r.status,200);
    assert.equal((await r.json()).from,'legacy');
    assert.equal(core,1);
    assert.equal(legacy,1);
  }finally{globalThis.fetch=prev;}
});
