import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {BRAIN_API_RESOURCE,BRAIN_MCP_RESOURCE} from '../src/brainRead.js';
import {handleBrainMcpRequest} from '../src/brainMcp.js';

const token='ov_'+'A'.repeat(43);
const auth='Bearer '+token;
const statement='Synthetic only';
const packet={requestId:'test-write-0000001',statement};
const memory={_id:'507f1f77bcf86cd799439011',statement,revision:1};

test('Brain REST /v1/sync enforces Bearer and returns legacy-compatible result',async t=>{
  const calls=[];
  const repo={
    brainVaultSync:async(value,input,resource)=>{
      calls.push({value,input,resource});
      return {ok:true,data:{memory,created:true,requestId:input.requestId}};
    }
  };
  const app=createApp(repo);
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>server.close(ok)));
  const base='http://127.0.0.1:'+server.address().port;
  const write=(header,body=packet,origin='https://samyao.me')=>fetch(base+'/api/brain/sync/v1/sync',{
    method:'POST',
    headers:{
      origin,'content-type':'application/json',...(header?{authorization:header}:{})
    },
    body:JSON.stringify(body)
  });
  let r=await write('');
  assert.equal(r.status,401);
  assert.equal(calls.length,0);
  r=await write(auth,packet,'https://attacker.example');
  assert.equal(r.status,403);
  assert.equal(calls.length,0);
  r=await write(auth);
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{memory,created:true,requestId:packet.requestId});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{value:token,input:packet,resource:BRAIN_API_RESOURCE});
});

test('Brain REST sync reports 409 conflicts without leaking query details',async t=>{
  const repo={brainVaultSync:async()=>({ok:false,status:409,code:'REVISION_CONFLICT'})};
  const app=createApp(repo);
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise(ok=>server.close(ok)));
  const base='http://127.0.0.1:'+server.address().port;
  const r=await fetch(base+'/api/brain/sync/v1/sync',{
    method:'POST',
    headers:{authorization:auth,origin:'https://samyao.me','content-type':'application/json'},
    body:JSON.stringify(packet)
  });
  assert.equal(r.status,409);
  assert.deepEqual(await r.json(),{message:'REVISION_CONFLICT'});
});

const rpc=(method,params,id=1)=>({
  jsonrpc:'2.0',method,id,...(params?{params}:{})
});
function mcpRequest(body){
  return new Request('https://api.samyao.me/api/brain/sync/mcp',{
    method:'POST',
    headers:{origin:'https://chatgpt.com',
      authorization:auth,
      'content-type':'application/json',
      accept:'application/json, text/event-stream',
      'mcp-protocol-version':'2025-06-18'
    },
    body:JSON.stringify(body)
  });
}
const repo=({
  scopes=['memory:read','memory:write']
}={})=>({
  calls:[],
  brainVaultScopes:async()=>({ok:true,data:scopes}),
  brainVaultSync:async(value,input,resource)=>{
    assert.equal(resource,BRAIN_MCP_RESOURCE);
    assert.equal(value,token);
    assert.equal(input.statement,statement);
    return {ok:true,data:{memory,created:true,requestId:input.requestId}};
  }
});
test('MCP write tool is opt-in and forbidden for read-only OAuth scope',async()=>{
  const readOnly=repo();
  let r=await handleBrainMcpRequest(mcpRequest(rpc('tools/list')),readOnly);
  let body=await r.json();
  assert.equal(body.result.tools.some(x=>x.name==='sync_knowledge'),false);

  r=await handleBrainMcpRequest(mcpRequest(rpc('tools/list')),
    repo({scopes:['memory:read']}),{enableWriteCanary:true});
  body=await r.json();
  assert.equal(body.result.tools.some(x=>x.name==='sync_knowledge'),false);

  r=await handleBrainMcpRequest(mcpRequest(rpc('tools/list')),
    repo(),{enableWriteCanary:true});
  body=await r.json();
  assert.equal(body.result.tools.some(x=>x.name==='sync_knowledge'),true);
});

test('MCP write tool validates input and emits the original result envelope',async()=>{
  const r=await handleBrainMcpRequest(mcpRequest(rpc('tools/call',{
    name:'sync_knowledge',arguments:packet
  })),repo(),{enableWriteCanary:true});
  assert.equal(r.status,200);
  const response=await r.json();
  assert.equal(response.result.isError,undefined);
  assert.deepEqual(JSON.parse(response.result.content[0].text),{
    memory,created:true,requestId:packet.requestId
  });
});
