import {test} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {ObjectId} from 'mongodb';
import {createServer} from 'node:http';
import {verifyKeyringToken} from '../src/auth.js';
import {
  passwordLoginInput,safePasswordPayload,legacyAuthCookie,
  createPasswordSession,revokePasswordSession,signCompatibleJwt
} from '../src/passwordSession.js';
import {createApp} from '../src/app.js';

const secret='tests-only-compatible-session-jwt-secret';
const actor=new ObjectId();
const existingHash=await bcrypt.hash('S3curePassLong',4);
const storedUser={
  _id:actor,email:'sam@example.invalid',phone:'+6421000000',
  displayName:'Sam',role:'admin',extraPermissions:['TODO:USE'],
  password:existingHash,photoURL:''
};
function mockDB(){
  const records=new Map();
  const db={
    collection(name){
      if(name==='users')return {findOne:async(query)=>{
        const match=query.$or.some(cond=>
          cond.email===storedUser.email||cond.phone===storedUser.phone);
        return match?{...storedUser}:null;
      }};
      if(name==='roles')return {findOne:async()=>({permissions:['BLOG:READ']})};
      if(name==='sessions')return {
        insertOne:async(record)=>{records.set(record.key,record);return {insertedId:new ObjectId()}},
        deleteOne:async(filter)=>{const deleted=records.delete(filter.key);return {deletedCount:Number(deleted)}}
      };
      throw new Error('Unexpected collection');
    }
  };
  return {db,records};
}

test('password input bounded and server payload never includes password',()=>{
  assert.equal(passwordLoginInput({email:'',password:'any'}),null);
  assert.equal(passwordLoginInput({email:'some@invalid',password:'x'.repeat(129)}),null);
  assert.equal(passwordLoginInput({email:'wrong',password:1}),null);
  const payload=safePasswordPayload(storedUser,['BLOG:READ']);
  assert.deepEqual(payload.permissions,['BLOG:READ','TODO:USE']);
  assert.equal(payload.password,undefined);
  assert.equal(payload._id,String(actor));
  assert.equal(payload.vip,false);
  assert.ok(legacyAuthCookie('a.b.c').includes('HttpOnly; Secure; SameSite=Lax'));
  assert.ok(legacyAuthCookie('',{clear:true}).includes('Max-Age=0'));
});

test('existing bcrypt hash login creates a legacy-format JWT and live Mongo session',async()=>{
  const {db,records}=mockDB();
  const r=await createPasswordSession(db,{email:'SAM@example.invalid',password:'S3curePassLong'},{legacy:secret});
  assert.equal(r.kind,'success');
  assert.equal(r.user.role,'admin');
  assert.equal(r.user.password,undefined);
  assert.ok(records.has('auth:'+r.token));
  const verified=await verifyKeyringToken(r.token,secret);
  assert.equal(verified.kind,'verified');
  assert.equal(verified.claims.user.id,String(actor));
  assert.equal(verified.claims.user.role,'admin');
  assert.equal(records.get('auth:'+r.token).value,String(actor));
  assert.ok(records.get('auth:'+r.token).createdAt instanceof Date);
  await revokePasswordSession(db,r.token);
  assert.equal(records.size,0);
});

test('wrong password and unknown account do not create sessions',async()=>{
  const {db,records}=mockDB();
  const a=await createPasswordSession(db,{email:'sam@example.invalid',password:'wrongpw'},{legacy:secret});
  const b=await createPasswordSession(db,{email:'unknown@example.invalid',password:'wrongpw'},{legacy:secret});
  assert.equal(a.kind,'invalid-credentials');
  assert.equal(b.kind,'invalid-credentials');
  assert.equal(records.size,0);
});

test('v2 signing only with separately configured safe key and strict kid',async()=>{
  await assert.rejects(signCompatibleJwt({id:String(actor)},{legacy:secret,mode:'v2'}));
  const next='new-v2-test-signing-key-that-is-over-32-chars';
  const t=await signCompatibleJwt({id:String(actor)},{legacy:secret,next,mode:'v2'});
  const check=await verifyKeyringToken(t,{legacy:secret,next});
  assert.equal(check.kind,'verified');
  assert.equal(check.claims.user.id,String(actor));
});

test('password Worker signin and logout preserve response and cookie contract',async(t)=>{
  const {db,records}=mockDB();
  const repo={
    passwordSignIn:async(input)=>createPasswordSession(db,input,{legacy:secret}),
    passwordLogout:async(token)=>revokePasswordSession(db,token)
  };
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  const signin=(payload,headers={})=>fetch(origin+'/api/users/signin',{
    method:'POST',headers:{'content-type':'application/json',...headers},
    body:JSON.stringify(payload)
  });
  const rejected=await signin({email:'sam@example.invalid',password:'S3curePassLong'},
    {origin:'https://attacker.example'});
  assert.equal(rejected.status,403);
  assert.equal(records.size,0);
  let response=await signin({email:'sam@example.invalid',password:'bad'},
    {origin:'https://samyao.me'});
  assert.equal(response.status,401);
  assert.equal(records.size,0);
  response=await signin({email:'sam@example.invalid',password:'S3curePassLong'},
    {origin:'https://samyao.me'});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.user.role,'admin');
  assert.ok(body.token);
  assert.ok(records.has('auth:'+body.token));
  assert.match(response.headers.get('set-cookie')||'',/orion_session=/);
  const logout=await fetch(origin+'/api/users/logout',{
    method:'POST',headers:{cookie:'orion_session='+body.token,origin:'https://samyao.me'}
  });
  assert.equal(logout.status,200);
  assert.equal((await logout.json()).success,true);
  assert.equal(records.size,0);
  assert.match(logout.headers.get('set-cookie')||'',/Max-Age=0/i);
});
