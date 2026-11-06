import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { getPublicComments, normalizePublicComments } from '../src/commentReads.js';

test('comments preserve historical anonymous author and reply shape', () => {
  const post = new ObjectId();
  const id = new ObjectId();
  const author = new ObjectId();
  const comment = {
    _id: id, _postid: post, _userid: author,
    comment: 'legacy', photoURL: 'https://example.invalid/avatar.jpg',
    date: new Date('2025-01-01T00:00:00.000Z'),
    reply: [{ user:'Legacy Name', content:'hello', date: new Date('2025-01-02T00:00:00.000Z') }]
  };
  const [result] = JSON.parse(JSON.stringify(normalizePublicComments([comment])));
  assert.deepEqual(Object.keys(result), [
    '_id','id','_postid','_userid','user','photoURL',
    'comment','content','date','reply','__v'
  ]);
  assert.equal(result.user._id,String(author));
  assert.equal(result.user.vip,false);
  assert.equal(result.comment,'legacy');
  assert.equal(result.reply[0].user.displayName,'Legacy Name');
  assert.equal(result.reply[0].user.photoURL,'');
  assert.equal(result.__v,0);
});

test('joined users and reply authors expose only legacy public fields', () => {
  const userId = new ObjectId(), otherId = new ObjectId();
  const user = {_id:userId,displayName:'Owner',photoURL:'https://example.invalid/o',role:'super_admin'};
  const replyUser = {_id:otherId,displayName:'Reader',role:'user'};
  const doc = {_id:new ObjectId(), post:new ObjectId(),user:userId,content:'article',
    date:new Date(), reply:[{user:otherId,content:'nice',date:new Date()}]};
  const [value] = JSON.parse(JSON.stringify(normalizePublicComments([doc],[user,replyUser])));
  assert.equal(value.user.vip,true);
  assert.equal(value._userid,String(userId));
  assert.equal(value.user.email,undefined);
  assert.equal(value.user.password,undefined);
  assert.equal(value.reply[0].user.displayName,'Reader');
  assert.equal(value.reply[0].user.vip,false);
  assert.equal(value.reply[0].user.password,undefined);
});

test('read uses fixed ObjectId queries and joins only selected user profile fields', async () => {
  const post=new ObjectId(),owner=new ObjectId(),commentId=new ObjectId();
  const rows=[{_id:commentId,post,user:owner,content:'sample',reply:[],date:new Date(),__v:0}];
  let filter, projection, sort, joinFilter;
  const db={collection(name){
    if(name==='comments')return {
      find(f) {filter=f;return {sort(s){sort=s;return {toArray:async()=>rows};}};},
      findOne:async()=>rows[0]
    };
    if(name==='users')return { find(f,options) {
      joinFilter=f; projection=options.projection;
      return {toArray:async()=>[{_id:owner,displayName:'Owner',role:'user'}]};
    }};
    throw Error('Unexpected collection');
  }};
  const result=await getPublicComments(db,String(post));
  assert.equal(result.length,1);
  assert.equal(result[0].user.displayName,'Owner');
  assert.ok(filter.$or[0].post.equals(post));
  assert.ok(filter.$or[1]._postid.equals(post));
  assert.deepEqual(sort,{date:-1});
  assert.deepEqual(projection,{_id:1,displayName:1,photoURL:1,role:1});
  assert.ok(joinFilter._id.$in[0].equals(owner));
  assert.equal((await getPublicComments(db,String(commentId),{reply:true})).length,1);
  assert.equal(await getPublicComments(db,'../../not-an-id'),null);
});

test('missing replies and zero comments have matching legacy results', async () => {
  const db={collection(name) {
    if(name==='comments')return {
      findOne:async()=>null,
      find:()=>({sort:()=>({toArray:async()=>[]})})
    };
    throw Error('Unexpected users query when comments are empty');
  }};
  const id='507f1f77bcf86cd799439011';
  assert.deepEqual(await getPublicComments(db,id),[]);
  assert.equal(await getPublicComments(db,id,{reply:true}),null);
});
