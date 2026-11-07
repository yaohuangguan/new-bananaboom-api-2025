import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {createApp} from '../src/app.js';

const id='507f1f77bcf86cd799439011';
const secret='synthetic-legacy-photowrite-auth-test-only-2026';
const valid=()=>new SignJWT({user:{id}})
  .setProtectedHeader({alg:'HS256'})
  .setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));

async function serve(repo,t){
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}

test('Private photo preflight checks current JWT and live admin session',async t=>{
  const token=await valid();
  let current={id,role:'super_admin',permissions:['*']};
  let calls=0;
  const repo={authorizeSession:async presented=>{
    calls++;
    return presented===token?current:null;
  }};
  const base=await serve(repo,t);
  const path=base+'/_internal/authorize-photos-write';
  const call=async headers=>fetch(path,{method:'POST',headers});
  let r=await call({origin:'https://samyao.me'});
  assert.equal(r.status,401);
  assert.equal(calls,0);

  r=await call({'x-auth-token':'forged-signature',
    origin:'https://samyao.me'});
  assert.equal(r.status,401);
  assert.equal(calls,0);

  r=await call({'x-auth-token':token,origin:'https://samyao.me'});
  assert.equal(r.status,204);
  assert.equal(await r.text(),'');
  assert.equal(calls,1);

  current={id,role:'user',permissions:['BLOG:INTERACT']};
  r=await call({'x-auth-token':token,origin:'https://samyao.me'});
  assert.equal(r.status,403);
  assert.equal(calls,2);
  current=null;
  r=await call({'x-auth-token':token,origin:'https://samyao.me'});
  assert.equal(r.status,401);
  assert.equal(calls,3);
});

test('Cookie-based preflight rejects untrusted/missing origin (CSRF)',async t=>{
  const token=await valid();
  let checked=0;
  const repo={authorizeSession:async()=>{checked++;
    return {id,role:'super_admin',permissions:['*']};
  }};
  const base=await serve(repo,t);
  const path=base+'/_internal/authorize-photos-write';
  const cookie={cookie:'orion_session='+encodeURIComponent(token)};
  for(const origin of ['', 'https://attacker.example']){
    const res=await fetch(path,{method:'POST',
      headers:{...cookie,...(origin?{origin}:{})}});
    assert.equal(res.status,403);
  }
  assert.equal(checked,0);
  const validRes=await fetch(path,{method:'POST',headers:{
    ...cookie,origin:'https://samyao.me'
  }});
  assert.equal(validRes.status,204);
  assert.equal(checked,1);
});
