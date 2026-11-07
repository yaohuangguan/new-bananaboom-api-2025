import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';

// Prevent the 2026-11-07 regression where a Worker API was implemented and
// thoroughly tested under '/api/todos', while Express actually mounted
// routes/todo.js under '/api/todo' (singular). The source mount is the contract.
test('Todo Core exposes the ACTUAL Express route mount, not only plural typo',async t=>{
  const legacy=readFileSync(new URL('../../../index.js',import.meta.url),'utf8');
  assert.match(legacy,/app\.use\(\s*['"]\/api\/todo['"]\s*,\s*todoRoutes\s*\)/);
  const repo={
    todoMutate:async()=>{throw Error('Should reject anonymous before DB')},
    todoDetail:async()=>{throw Error('Should reject anonymous before DB')}
  };
  const app=createApp(repo,{secretProvider:async()=>({legacy:'not-real-secret'})});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const id='507f1f77bcf86cd799439011';
  for(const path of [
    '/api/todo','/api/todo/done/'+id,
    '/api/todos','/api/todos/done/'+id
  ]){
    const get=await fetch(base+path);
    // Full list/details must reject anonymous even when mounted correctly.
    assert.equal(get.status,401,path);
  }
  for(const [method,path] of [
    ['POST','/api/todo'],['POST','/api/todo/done/'+id],
    ['POST','/api/todo/routine/'+id+'/check'],['DELETE','/api/todo/'+id]
  ]){
    const response=await fetch(base+path,{
      method,
      headers:{'content-type':'application/json'},
      ...(method==='POST'?{body:'{}'}:{})
    });
    assert.equal(response.status,401,method+' '+path);
  }
});
