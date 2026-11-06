import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';

const secret='a-long-test-only-secret-used-for-jwt-signing';
const actor='507f1f77bcf86cd799439011';
const token=await new SignJWT({user:{id:actor}}).setProtectedHeader({alg:'HS256'})
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));

test('private MongoDB backup accepts only live super_admin + SYSTEM_LOGS:USE and trusted cookie origin',async(t)=>{
  let user={id:actor,role:'super_admin',permissions:['SYSTEM_LOGS:USE']}, attempts=0;
  const repo={
    authorizeSession:async(t)=>t===token?user:null,
    backupDatabase:async()=>{attempts++;return {
      success:true,folder:'db-backups/test',manifestKey:'db-backups/test/manifest.json',
      totalFiles:2,collections:4,documents:5
    }}
  };
  const app=createApp(repo,{secretProvider:async()=>secret});await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/backup/database';
  const call=(headers)=>fetch(url,{method:'POST',headers});
  assert.equal((await call({})).status,401);
  assert.equal((await call({authorization:'Bearer forged'})).status,401);
  assert.equal((await call({cookie:'orion_session='+token})).status,403);
  assert.equal((await call({cookie:'orion_session='+token,origin:'https://evil.example'})).status,403);
  assert.equal(attempts,0);
  user={id:actor,role:'user',permissions:['SYSTEM_LOGS:USE']};
  assert.equal((await call({authorization:'Bearer '+token})).status,403);
  user={id:actor,role:'super_admin',permissions:[]};
  const response=await call({cookie:'orion_session='+token,origin:'https://samyao.me'});
  assert.equal(response.status,200);
  assert.equal(attempts,1);
  const body=await response.text();
  assert.match(body,/\[DONE\] /);
  assert.ok(!body.includes('mongodb://'));
});
