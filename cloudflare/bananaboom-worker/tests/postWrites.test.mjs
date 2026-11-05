import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { normalizePostInput, PostInputError, matchesAdminSecret } from '../src/postWrites.js';

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

test('private DELETE never accepts missing admin secret or old hardcoded default',async(t)=>{
  const token=await makeToken();let deletes=0;let privatePost=true;
  const repo={
    authorizeSession:async()=>writer,
    getArticleForDeletion:async()=>({_id:article,isPrivate:privatePost,name:'Story'}),
    deleteArticle:async(...args)=>{deletes++;return {_id:article,isPrivate:args[3]}},
    publicPosts:async ({page})=>({data:[],pagination:{currentPage:page}}),
    privatePosts:async ({page})=>({data:[],pagination:{currentPage:page}})
  };
  const {server,base}=await serve(repo);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=base+'/api/posts/'+article+'?page=2';
  let res=await fetch(url,req('DELETE',{secretKey:'orion'},token));
  assert.equal(res.status,503);
  assert.equal(deletes,0);
  privatePost=false;
  res=await fetch(url,req('DELETE',{},token));
  assert.equal(res.status,200);
  assert.equal((await res.json()).pagination.currentPage,2);
  assert.equal(deletes,1);
});

test('private DELETE checks configured secret and errors do not leak Mongo credentials',async(t)=>{
  const token=await makeToken();let deletes=0;
  const repo={
    authorizeSession:async()=>writer,
    getArticleForDeletion:async()=>({_id:article,isPrivate:true,name:'Private'}),
    deleteArticle:async()=>{deletes++;throw Error('mongodb+srv://credentials.example')}
  };
  const app=createApp(repo,{
    secretProvider:async()=>secret,
    adminSecretProvider:async()=> 'correct-strong-private-secret-more-than-16'
  });
  await app.ready();const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/posts/'+article;
  assert.equal((await fetch(url,req('DELETE',{secretKey:'orion'},token))).status,403);
  assert.equal(deletes,0);
  const res=await fetch(url,req('DELETE',{
    secretKey:'correct-strong-private-secret-more-than-16'
  },token));
  assert.equal(res.status,503);
  assert.equal(deletes,1);
  assert.doesNotMatch(await res.text(),/mongodb|credentials/i);
});


test('admin secret comparison does not accept prefixes or legacy default', () => {
  assert.equal(matchesAdminSecret('a-strong-admin-secret-configuration','a-strong-admin-secret-configuration'), true);
  assert.equal(matchesAdminSecret('a-strong-admin-secret-configuration','a-strong-admin-secret-configuratio'), false);
  assert.equal(matchesAdminSecret(undefined,'orion'), false);
});
