import assert from 'node:assert/strict';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
import {mutateComment} from '../cloudflare/bananaboom-worker/src/commentMutations.js';
import Comment from '../models/Comment.js';
import AuditLog from '../models/AuditLog.js';

const {MongoClient, ObjectId} = mongodb;
assert.equal(Comment.collection.name, 'comments');
assert.equal(AuditLog.collection.name, 'audit_logs');
const repl = await MongoMemoryReplSet.create({replSet: {count: 1, storageEngine:'wiredTiger'}});
const uri = repl.getUri();
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(uri)) {
  await repl.stop();
  throw Error('Refusing to use remote MongoDB');
}
const client = new MongoClient(uri, {serverSelectionTimeoutMS:5000});
try {
  await client.connect();
  const db = client.db('orion_comments_isolated_'+Date.now());
  const ownerId = new ObjectId(), otherId = new ObjectId(), postId = new ObjectId();
  const owner = {id:String(ownerId),role:'user',permissions:[]};
  const other = {id:String(otherId),role:'user',permissions:[]};
  const token='synthetic-live-comment-token';
  const otherToken='synthetic-live-other-token';
  const sessionDate=new Date();
  await db.collection('users').insertMany([
    {_id:ownerId,role:'user',displayName:'Synthetic Owner',photoURL:'/owner.png'},
    {_id:otherId,role:'user',displayName:'Other Synthetic',photoURL:'/other.png'}
  ]);
  await db.collection('sessions').insertMany([
    {key:'auth:'+token,value:String(ownerId),createdAt:sessionDate},
    {key:'auth:'+otherToken,value:String(otherId),createdAt:sessionDate}
  ]);
  const ctx = {client, db};
  const post = String(postId);
  const create = (who, authToken, key, body) => mutateComment(ctx, who, authToken, {
    operation:'create',id:post,key,body
  });
  const reply = (who, authToken, id, key, body) => mutateComment(ctx, who, authToken, {
    operation:'reply',id,key,body
  });

  const first = await create(owner,token,'comment-create-01',{content:'Synthetic comment'});
  assert.equal(first._postid, post);
  assert.equal(first.comment,'Synthetic comment');
  assert.equal(first.user.displayName,'Synthetic Owner');
  assert.equal(first._userid,String(ownerId));
  assert.equal(first.reply.length,0);
  const commentId=first.id;
  assert.equal(await db.collection('comments').countDocuments({}),1);
  assert.deepEqual(await create(owner,token,'comment-create-01',
    {content:'Synthetic comment'}),first);
  assert.equal(await db.collection('audit_logs').countDocuments({}),1);
  assert.equal(await db.collection('comment_mutation_receipts').countDocuments({}),1);
  await assert.rejects(create(owner,token,'comment-create-01',
    {content:'Different content'}), e=>e.status===409);

  const sent = await reply(other,otherToken,commentId,'comment-reply-01',{
    reply:'Synthetic reply',targetUser:String(ownerId)
  });
  assert.equal(sent.length,1);
  assert.equal(sent[0].reply.length,1);
  assert.equal(sent[0].reply[0].user.displayName,'Other Synthetic');
  assert.equal(String(sent[0].reply[0].targetUser),String(ownerId));
  assert.deepEqual(await reply(other,otherToken,commentId,'comment-reply-01',{
    reply:'Synthetic reply',targetUser:String(ownerId)
  }),sent);
  assert.equal(await db.collection('comments').countDocuments({}),1);
  assert.equal(await db.collection('audit_logs').countDocuments({}),2);
  assert.equal(await db.collection('comment_mutation_receipts').countDocuments({}),2);

  // Another writer on the same comment can reply independently.
  await reply(owner,token,commentId,'comment-reply-02',{content:'Second reply'});
  const updated=await db.collection('comments').findOne({_id:new ObjectId(commentId)});
  assert.equal(updated.reply.length,2);
  assert.equal(updated.__v,2);

  await assert.rejects(reply(owner,token,String(new ObjectId()),
    'comment-reply-missing',{content:'missing'}),e=>e.status===404);
  await assert.rejects(create(owner,otherToken,'forged-session-01',
    {content:'forged'}),e=>e.status===401);
  await db.collection('sessions').deleteOne({key:'auth:'+token});
  await assert.rejects(create(owner,token,'after-revoke-01',
    {content:'denied'}),e=>e.status===401);
  await assert.rejects(create(owner,token,'comment-create-01',
    {content:'Synthetic comment'}),e=>e.status===401);
  assert.equal(await db.collection('comments').countDocuments({}),1);
  assert.equal(await db.collection('audit_logs').countDocuments({}),3);
  console.log('PASS isolated Mongo replica: create/reply response parity, audit+receipt transaction, idempotency, reply version, no forged/revoked Session, 404');
  console.log('NO_PRODUCTION_COMMENTS_MODIFIED=true');
  await db.dropDatabase();
} finally {
  await client.close();
  await repl.stop();
}
