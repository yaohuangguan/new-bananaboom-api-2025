import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
import {
  mutateOwnerTodo,readOwnerTodo,parseTodoMutation
} from '../cloudflare/bananaboom-worker/src/todoMutations.js';
import Todo from '../models/Todo.js';
import AuditLog from '../models/AuditLog.js';

const {MongoClient,ObjectId}=mongodb;
assert.equal(Todo.collection.name,'todos');
assert.equal(AuditLog.collection.name,'audit_logs');
const repl=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});
const uri=repl.getUri();
if(!/^(mongodb:\/\/|mongodb\+srv:\/\/)(localhost|127\.0\.0\.1)/.test(uri)){
  await repl.stop();throw new Error('Refuse non-local MongoDB');
}
const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
try{
  await client.connect();
  const db=client.db('orion_todo_worker_isolated_'+Date.now());
  const alice=new ObjectId();
  const bob=new ObjectId();
  const admin1=new ObjectId();
  const admin2=new ObjectId();
  const user=id=>({id:String(id),role:'user',permissions:['TODO:USE']});
  await db.collection('users').insertMany([
    {_id:alice,role:'user',displayName:'Synthetic Alice',timezone:'Pacific/Auckland'},
    {_id:bob,role:'user',displayName:'Synthetic Bob',timezone:'Pacific/Auckland'},
    {_id:admin1,role:'super_admin',displayName:'Family Admin A',timezone:'Pacific/Auckland'},
    {_id:admin2,role:'super_admin',displayName:'Family Admin B',timezone:'Pacific/Auckland'}
  ]);
  await db.collection('roles').insertMany([
    {name:'user',permissions:['TODO:USE']},
    {name:'super_admin',permissions:['*']}
  ]);
  const repo={client,db};
  const call=(who,operation,id,body,key)=>mutateOwnerTodo(
    repo,who,{operation,id,body,key}
  );
  const input={todo:'Walk every morning',type:'routine',
    recurrence:'interval:30m',description:'Synthetic test task',isActive:true};
  const first=await call(user(alice),'create',null,input,'routine-create-001');
  assert.equal(first.length,1);
  assert.equal(first[0].todo,'Walk every morning');
  assert.equal(first[0].user._id,String(alice));
  assert.equal(first[0].notifyUsers[0]._id,String(alice));
  assert.equal(first[0].type,'routine');
  const id=first[0]._id;
  assert.ok(first[0].remindAt);
  assert.equal(await db.collection('todos').countDocuments({user:alice}),1);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:alice}),1);
  const retry=await call(user(alice),'create',null,input,'routine-create-001');
  assert.deepEqual(retry,first);
  assert.equal(await db.collection('todos').countDocuments({user:alice}),1);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:alice}),1);
  await assert.rejects(call(user(alice),'create',null,{
    ...input,todo:'Changed text'
  },'routine-create-001'),e=>e.status===409&&e.message==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(call(user(alice),'create',null,{
    todo:'Attempt notify stranger',notifyUsers:[String(bob)]
  },'notify-stranger-01'),e=>e.status===403);
  assert.equal(await db.collection('todos').countDocuments({user:alice}),1);

  const detail=await readOwnerTodo(db,user(alice),id);
  assert.equal(detail.todo,'Walk every morning');
  await assert.rejects(readOwnerTodo(db,user(bob),id),
    e=>e.status===404);
  await assert.rejects(call(user(bob),'update',id,{done:true},'foreign-update-01'),
    e=>e.status===404);
  await assert.rejects(call(user(bob),'delete',id,{},'foreign-delete-01'),
    e=>e.status===404);

  const checked=await call(user(alice),'check',id,{},'routine-check-01');
  assert.equal(checked.success,true);
  assert.ok(checked.nextRun);
  const afterCheck=await db.collection('todos').findOne({_id:new ObjectId(id)});
  assert.equal(afterCheck.isNotified,false);
  assert.ok(afterCheck.remindAt instanceof Date);
  assert.equal((await call(user(alice),'check',id,{},'routine-check-01')).nextRun.toISOString(),
    checked.nextRun.toISOString());
  assert.equal(await db.collection('audit_logs').countDocuments({operator:alice}),2);

  const updated=await call(user(alice),'update',id,{
    done:true,description:'Completed synthetic test'
  },'task-update-done-01');
  assert.equal(updated.length,1);
  assert.equal(updated[0].done,true);
  assert.equal(updated[0].status,'done');
  assert.equal(updated[0].description,'Completed synthetic test');
  assert.ok(updated[0].complete_date);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:alice}),3);

  const same={todo:'Synthetic concurrent task',type:'wish'};
  const pair=await Promise.all([
    call(user(alice),'create',null,same,'parallel-create-01'),
    call(user(alice),'create',null,same,'parallel-create-01')
  ]);
  assert.deepEqual(pair[0].map(t=>t._id).sort(),pair[1].map(t=>t._id).sort());
  assert.equal(await db.collection('todos').countDocuments({
    user:alice,todo:'Synthetic concurrent task'
  }),1);
  assert.equal(await db.collection('todo_mutation_receipts').countDocuments({
    action:'create'
  }),2);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:alice}),4);

  const removed=await call(user(alice),'delete',id,{},'task-delete-001');
  assert.deepEqual(removed,{success:true});
  assert.deepEqual(await call(user(alice),'delete',id,{},'task-delete-001'),removed);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:alice}),5);
  await assert.rejects(readOwnerTodo(db,user(alice),id),e=>e.status===404);

  // Revoking TODO:USE invalidates even idempotent receipt replays.
  await db.collection('roles').updateOne({name:'user'},{$set:{permissions:[]}});
  await assert.rejects(call(user(alice),'delete',id,{},'task-delete-001'),
    e=>e.status===403);
  await db.collection('roles').updateOne({name:'user'},{$set:{permissions:['TODO:USE']}});

  const familyTask=await call({id:String(admin1),role:'super_admin'},
    'create',null,{todo:'Family-only task',notifyUsers:[String(admin2)]},
    'family-create-001');
  assert.equal(familyTask.length,1);
  const familyId=familyTask[0]._id;
  assert.equal(familyTask[0].notifyUsers[0]._id,String(admin2));
  const familyRead=await readOwnerTodo(db,{id:String(admin2),role:'super_admin'},familyId);
  assert.equal(familyRead.todo,'Family-only task');
  await assert.rejects(readOwnerTodo(db,user(bob),familyId),
    e=>e.status===404);

  for(const invalid of [
    {operation:'create',body:{todo:'x',ownerId:String(bob)},key:'bad-attributes-01'},
    {operation:'create',body:{todo:''},key:'bad-attributes-02'},
    {operation:'create',body:{todo:'x'},key:'short'},
    {operation:'update',id,body:{$set:{done:true}},key:'inject-update-01'}
  ])assert.throws(()=>parseTodoMutation(invalid));

  await db.dropDatabase();
  console.log('PASS: real isolated Todo CRUD+routine, legacy shape, idempotency/concurrency, family scope, unauthorized-owner denial, audit atomicity, revocation');
  console.log('NO_PRODUCTION_TODO_WRITES=true');
}finally{
  await client.close();
  await repl.stop();
}
