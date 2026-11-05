import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { normalizePostInput, PostInputError } from '../src/postWrites.js';

const secret = 'a-long-test-only-secret-used-for-jwt-signing';
const id = '507f1f77bcf86cd799439011';
const article = '507f1f77bcf86cd799439012';
const makeToken = () => new SignJWT({user:{id}}).setProtectedHeader({alg:'HS256'})
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
const writer = {id,role:'user',permissions:['BLOG:MANAGE']};
const valid = {name:' New post ',info:'Summary',author:'Author',content:'Body'};
const req = (method, body, token, extra={}) => ({method,headers:{
  'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...extra
},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function serve(repo, adminSecret) {
  const app=createApp(repo,{secretProvider:async()=>secret,adminSecretProvider:async()=>adminSecret});
  await app.ready();const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,base:'http://127.0.0.1:'+server.address().port};
}

test('article input accepts only defined fields and legacy tag splitting',()=>{
  assert.deepEqual(normalizePostInput({...valid,name:' Hello ',tags:'a b',likes:999,user:'other'},{create:true}),
    {name:'Hello',info:'Summary',author:'Author',content:'Body',tags:['a','b']});
  assert.throws(()=>normalizePostInput({name:'missing'}, {create:true}),PostInputError);
  assert.throws(()=>normalizePostInput({...valid,isPrivate:'true'}),PostInputError);
});

test('CRUD requires live session and BLOG:MANAGE; cookie writes require trusted Origin',async(t)=>{
  const token=await makeToken();let live=writer;let writes=0;
  const repo={
    authorizeSession:async value=>value===token?live:null,
    createArticle:async()=>{writes++;return {_id:article}}
  };
  const {server,base}=await serve(repo);t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=base+'/api/posts';
  assert.equal((await fetch(url,req('POST',valid))).status,401);
  assert.equal((await fetch(url,req('POST',valid,token+'bad'))).status,401);
  live=null;assert.equal((await fetch(url,req('POST',valid,token))).status,401);
  live={...writer,permissions:[]};
  assert.equal((await fetch(url,req('POST',valid,token))).status,403);
  live=writer;
  assert.equal((await fetch(url,req('POST',valid,null,{cookie:'orion_session='+token}))).status,403);
  assert.equal((await fetch(url,req('POST',valid,null,{
    cookie:'orion_session='+token,origin:'https://evil.example'}))).status,403);
  assert.equal(writes,0);
  assert.equal((await fetch(url,req('POST',valid,null,{
    cookie:'orion_session='+token,origin:'https://samyao.me'}))).status,201);
  assert.equal(writes,1);
});

test('CREATE and UPDATE emit proper values and block forged fields',async(t)=>{
  const token=await makeToken();const operations=[];
  const repo={
    authorizeSession:async()=>writer,
    createArticle:async(...args)=>{operations.push(['create',...args]);
      return {_id:article,...args[0],likes:0}},
    updateArticle:async(...args)=>{operations.push(['update',...args]);
      return {_id:article,name:'Updated'}}
  };
  const {server,base}=await serve(repo);t.after(()=>new Promise(resolve=>server.close(resolve)));
  let res=await fetch(base+'/api/posts',req('POST',{
    ...valid,name:' New ',tags:'a b',user:'forged',likes:123
  },token));
  assert.equal(res.status,201);
  assert.equal((await res.json()).data.likes,0);
  assert.deepEqual(operations[0],['create',{
    name:'New',info:'Summary',author:'Author',content:'Body',tags:['a','b']
  },id,'']);
  res=await fetch(base+'/api/posts/'+article,req('PUT',{name:' Updated ',user:'forged'},token));
  assert.equal(res.status,200);
  assert.equal((await res.json()).data.name,'Updated');
  assert.deepEqual(operations[1],['update',article,{name:'Updated'},id,'']);
  assert.equal((await fetch(base+'/api/posts/'+article,req('PUT',{name:''},token))).status,400);
  assert.equal(operations.length,2);
});

test('DELETE accepts only live super_admin role, not the obsolete VIP flag or BLOG:MANAGE alone', async (t) => {
  const token = await makeToken();
  let role = { ...writer, vip: true };
  let reads = 0;
  let deletes = 0;
  const repo = {
    authorizeSession: async () => role,
    getArticleForDeletion: async () => { reads++; return { _id: article, isPrivate: true, name: 'Private' }; },
    deleteArticle: async () => { deletes++; return { _id: article, isPrivate: true }; },
    privatePosts: async () => ({ data: [], pagination: { currentPage: 1 } })
  };
  const { server, base } = await serve(repo);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = base + '/api/posts/' + article;

  let response = await fetch(url, req('DELETE', { secretKey: 'orion' }, token));
  assert.equal(response.status, 403);
  assert.equal(reads, 0, 'Denied callers must not learn article existence');
  assert.equal(deletes, 0);

  role = { id, role: 'super_admin', permissions: [], vip: false };
  response = await fetch(url, req('DELETE', {}, token));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pagination.currentPage, 1);
  assert.equal(deletes, 1);
});

test('DELETE write errors return 503 without exposing internal database info', async (t) => {
  const token = await makeToken();
  const repo = {
    authorizeSession: async () => ({ id, role: 'super_admin', permissions: [] }),
    getArticleForDeletion: async () => ({ _id: article, isPrivate: true }),
    deleteArticle: async () => { throw Error('mongodb+srv://internal-credentials'); }
  };
  const { server, base } = await serve(repo);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(base + '/api/posts/' + article, req('DELETE', {}, token));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /mongodb|internal-credentials/);
});
