import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {handleBrainMcpRequest} from '../src/brainMcp.js';
import {BRAIN_API_RESOURCE,BRAIN_MCP_RESOURCE} from '../src/brainRead.js';

const token='ov_'+'A'.repeat(43);
const auth='Bearer '+token;
const memory={
  _id:'507f1f77bcf86cd799439011',
  statement:'Original dated user fact',revision:2,
  type:'fact',sourceAnchors:[{documentId:'507f1f77bcf86cd799439015',quote:'Original dated user fact'}]
};
function repo(){
  const calls=[];
  return {
    calls,
    async brainVaultScopes(value,resource){
      calls.push(['scopes',value,resource]);
      return {ok:true,data:['memory:read','memory:write']};
    },
    async brainVaultSearch(value,args,resource){
      calls.push(['search',value,args,resource]);
      return {ok:true,data:{items:[memory],nextCursor:null}};
    },
    async brainVaultRead(value,id,resource){
      calls.push(['read',value,id,resource]);
      return {ok:true,data:memory};
    }
  };
}
const rpc=(method,params,id=1)=>({
  jsonrpc:'2.0',id,method,...(params?{params}:{})
});
const mcpRequest=(body,{authorization=auth,origin='https://chatgpt.com'}={})=>
  new Request('https://api.samyao.me/api/brain/sync/mcp',{
    method:'POST',headers:{
      'content-type':'application/json',
      'accept':'application/json, text/event-stream',
      'authorization':authorization,
      'origin':origin,
      'mcp-protocol-version':'2025-06-18'
    },body:JSON.stringify(body)
  });

test('MCP requires existing Bearer ov token and publishes OAuth challenge',async()=>{
  const r=repo();
  const response=await handleBrainMcpRequest(
    mcpRequest(rpc('tools/list'),{authorization:''}),r);
  assert.equal(response.status,401);
  assert.match(response.headers.get('www-authenticate')||'',/oauth-protected-resource/);
  assert.deepEqual(r.calls,[]);
});

test('MCP prevents browser origins other than allowed OAuth clients',async()=>{
  const r=repo();
  const response=await handleBrainMcpRequest(
    mcpRequest(rpc('tools/list'),{origin:'https://attacker.example'}),r);
  assert.equal(response.status,403);
  assert.deepEqual(r.calls,[]);
});

test('official MCP Web transport negotiates initialization and exposes only read tools',async()=>{
  const r=repo();
  const initialize=await handleBrainMcpRequest(
    mcpRequest(rpc('initialize',{
      protocolVersion:'2025-06-18',
      capabilities:{},
      clientInfo:{name:'test-client',version:'1.0.0'}
    })),r);
  assert.equal(initialize.status,200);
  const initialized=await initialize.json();
  assert.equal(initialized.jsonrpc,'2.0');
  assert.equal(initialized.result.serverInfo.name,'orion-personal-knowledge');

  const list=await handleBrainMcpRequest(mcpRequest(rpc('tools/list',undefined,2)),r);
  assert.equal(list.status,200);
  const data=await list.json();
  assert.equal(data.jsonrpc,'2.0');
  const toolNames=data.result.tools.map(x=>x.name).sort();
  assert.deepEqual(toolNames,['read_knowledge','search_knowledge']);
  assert.equal(toolNames.includes('sync_knowledge'),false);
  assert.ok(r.calls.every((item)=>item[1]===token));
});

test('official MCP tools/call delegates to DO resource-scoped read',async()=>{
  const r=repo();
  const search=await handleBrainMcpRequest(mcpRequest(rpc('tools/call',{
    name:'search_knowledge',arguments:{query:'dated',limit:10}
  },3)),r);
  assert.equal(search.status,200);
  const result=await search.json();
  const text=result.result.content[0].text;
  assert.equal(JSON.parse(text).items[0].statement,memory.statement);
  assert.equal(r.calls.at(-1)[0],'search');
  assert.equal(r.calls.at(-1)[3],BRAIN_MCP_RESOURCE);

  const read=await handleBrainMcpRequest(mcpRequest(rpc('tools/call',{
    name:'read_knowledge',arguments:{id:memory._id}
  },4)),r);
  const detail=await read.json();
  assert.equal(JSON.parse(detail.result.content[0].text).revision,2);
  assert.equal(r.calls.at(-1)[3],BRAIN_MCP_RESOURCE);
});

test('MCP canary missing backend or revoked token does not expose content',async()=>{
  const r={
    brainVaultScopes:async()=>({ok:false,status:401,code:'INVALID_CONNECTION_TOKEN'})
  };
  const response=await handleBrainMcpRequest(mcpRequest(rpc('tools/list')),r);
  assert.equal(response.status,401);
  assert.equal((await response.json()).message,'INVALID_CONNECTION_TOKEN');
});

test('legacy-compatible REST read endpoints are bearer-only and same response shape',async t=>{
  const r=repo();
  const app=createApp(r,{brainReadOptions:{allowedOrigins:['https://samyao.me']}});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const searchUrl=base+'/api/brain/sync/v1/search';
  const post=(authorization,body,origin='https://samyao.me')=>fetch(searchUrl,{
    method:'POST',headers:{
      'content-type':'application/json',origin,
      ...(authorization?{authorization}:{})
    },body:JSON.stringify(body)
  });
  let response=await post('',{query:'dated'});
  assert.equal(response.status,401);
  response=await post(auth,{query:'dated'},'https://attacker.example');
  assert.equal(response.status,403);
  assert.deepEqual(r.calls,[]);

  response=await post(auth,{query:'dated',limit:10});
  assert.equal(response.status,200);
  assert.equal((await response.json()).items[0].statement,memory.statement);
  assert.equal(r.calls.at(-1)[3],BRAIN_API_RESOURCE);
  response=await fetch(base+'/api/brain/sync/v1/memories/'+memory._id,{
    headers:{authorization:auth,origin:'https://samyao.me'}
  });
  assert.equal(response.status,200);
  assert.equal((await response.json()).revision,2);
  assert.equal(r.calls.at(-1)[3],BRAIN_API_RESOURCE);
});
