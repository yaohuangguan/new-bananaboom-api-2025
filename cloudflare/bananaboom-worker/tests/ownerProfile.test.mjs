import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { getOwnerProfile, getOwnerAiStatus } from '../src/ownerProfile.js';
import { createApp } from '../src/app.js';

const secret = 'unit-tests-only-long-hs256-secret';
const actor = String(new ObjectId());
const token = await new SignJWT({user:{id:actor}})
  .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));

test('profile has live privileges but never returns password or obsolete shared secrets',async()=>{
  const db={collection(name) {
    assert.equal(name,'users');
    return { findOne: async(_filter,{projection})=>{
      assert.equal(projection.password,undefined);
      assert.equal(projection.displayName,1);
      return {
        _id:new ObjectId(actor),displayName:'Sam',
        email:'sam@example.invalid',role:'super_admin',
        aiServices:{drawing:{quota:5}},
        password:'this-field-would-never-be-returned-by-real-Mongo-projection'
      };
    }};
  }};
  const profile=await getOwnerProfile(db,{
    id:actor,role:'super_admin',permissions:['*']
  });
  // Only a known projection should be used in live, but the transform must
  // also prevent a future accidental secret-bearing test/mock document.
  assert.equal(profile.password,undefined);
  assert.equal(profile.private_token,undefined);
  assert.equal(profile.role,'super_admin');
  assert.equal(profile.vip,true);
  assert.deepEqual(profile.permissions,['*']);
  assert.equal(profile.id,actor);
  assert.equal(profile.fitnessGoal,'maintain');
  assert.equal(profile.timezone,'Asia/Shanghai');
});

test('AI status returns only own configured AI fields',async()=>{
  const db={collection:()=>({findOne:async()=>({
    _id:new ObjectId(actor),aiServices:{rpg:{quota:6,enabled:true}}
  })})};
  const result=await getOwnerAiStatus(db,{id:actor});
  assert.deepEqual(result,{success:true,data:{rpg:{quota:6,enabled:true}}});
});

test('profile HTTP requires valid JWT and matching live session, never trusts JWT role', async(t)=>{
  let liveUser={id:actor,role:'user',permissions:['BLOG:READ']}, calls=0;
  const repo={
    authorizeSession:async(value)=>value===token?liveUser:null,
    ownerProfile:async(user)=>{
      calls++;
      return {id:user.id,role:user.role,permissions:user.permissions,vip:user.role==='super_admin'};
    },
    ownerAiStatus:async()=>({success:true,data:{drawing:{quota:5}}})
  };
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  for(const path of ['/api/users/profile','/api/users/ai-status']) {
    assert.equal((await fetch(url+path)).status,401);
    assert.equal((await fetch(url+path,{headers:{authorization:'Bearer forged'}})).status,401);
  }
  assert.equal(calls,0);
  let r=await fetch(url+'/api/users/profile',{headers:{authorization:'Bearer '+token}});
  assert.equal(r.status,200);
  assert.equal((await r.json()).role,'user');
  liveUser=null;
  r=await fetch(url+'/api/users/profile',{headers:{authorization:'Bearer '+token}});
  assert.equal(r.status,401);
  assert.equal(calls,1);
});
