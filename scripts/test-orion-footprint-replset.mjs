import assert from 'node:assert/strict';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import mongodb from '../cloudflare/bananaboom-worker/node_modules/mongodb/lib/index.js';
const {MongoClient,ObjectId}=mongodb;
import {mutateOwnerFootprint} from '../cloudflare/bananaboom-worker/src/footprintMutations.js';
import Footprint from '../models/Footprint.js';
import AuditLog from '../models/AuditLog.js';

assert.equal(Footprint.collection.name,'footprints');
assert.equal(AuditLog.collection.name,'audit_logs');
const repl=await MongoMemoryReplSet.create({replSet:{count:1,storageEngine:'wiredTiger'}});
const uri=repl.getUri();
if(!/mongodb:\/\/(localhost|127\.0\.0\.1)/.test(uri)){
  await repl.stop();throw Error('Refuse non-local MongoDB');
}
const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000});
try{
  await client.connect();
  const db=client.db('orion_footprint_isolated_'+Date.now());
  const owner=new ObjectId(),other=new ObjectId();
  const user=id=>({id:String(id),role:'user',permissions:['FOOTPRINT:USE']});
  await db.collection('users').insertMany([
    {_id:owner,role:'user'},
    {_id:other,role:'user'}
  ]);
  await db.collection('roles').insertOne({
    name:'user',permissions:['FOOTPRINT:USE']
  });
  const repo={client,db};
  const act=(who,operation,id,body,key)=>mutateOwnerFootprint(repo,who,{
    operation,id,key,body
  });
  const data={
    location:{name:'Synthetic Auckland visit',country:'NZ',province:'Auckland',
      city:'Auckland',coordinates:[174.76,-36.85]},
    status:'planned',content:'No real personal information',
    rating:4,images:['https://assets.samyao.me/uploads/synthetic.png']
  };
  const created=await act(user(owner),'create',null,data,'synthetic-create-01');
  assert.equal(created.user,String(owner));
  assert.equal(created.location.name,data.location.name);
  assert.equal(created.location.country,'NZ');
  assert.equal(created.content,data.content);
  assert.equal(created.images.length,1);
  assert.equal(created.images[0],'uploads/synthetic.png');
  assert.equal(created.status,'planned');
  assert.equal(created.rating,4);
  assert.equal(created.mood,'happy');
  assert.equal(created.isHighlight,false);
  assert.equal(created.__v,0);
  const id=created._id;
  assert.equal(await db.collection('footprints').countDocuments({user:owner}),1);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:owner}),1);
  const retry=await act(user(owner),'create',null,data,'synthetic-create-01');
  assert.deepEqual(retry,created);
  assert.equal(await db.collection('footprints').countDocuments({user:owner}),1);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:owner}),1);

  await assert.rejects(act(user(owner),'create',null,
    {...data,status:'visited'},'synthetic-create-01'),e=>e.status===409);
  await assert.rejects(act(user(other),'update',id,
    {content:'Attempt foreign overwrite'},'foreign-update-01'),e=>e.status===404);
  await assert.rejects(act(user(other),'delete',id,{},'foreign-delete-01'),e=>e.status===404);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:other}),0);

  const updated=await act(user(owner),'update',id,{
    status:'visited',cost:0,mood:'excited',
    content:'Synthetic visit completed',
    visitDate:'2026-01-04T00:00:00Z'
  },'synthetic-update-01');
  assert.equal(updated.status,'visited');
  assert.equal(updated.cost,0);
  assert.equal(updated.mood,'excited');
  assert.equal(updated.content,'Synthetic visit completed');
  assert.equal(updated.visitDate,'2026-01-04T00:00:00.000Z');
  assert.equal(updated._id,id);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:owner}),2);
  assert.deepEqual(await act(user(owner),'update',id,{
    status:'visited',cost:0,mood:'excited',
    content:'Synthetic visit completed',
    visitDate:'2026-01-04T00:00:00Z'
  },'synthetic-update-01'),updated);

  const newPlace={location:{
    name:'Parallel synthetic location',coordinates:[175,-37]
  }};
  const parallel=await Promise.all([
    act(user(owner),'create',null,newPlace,'parallel-create-01'),
    act(user(owner),'create',null,newPlace,'parallel-create-01')
  ]);
  assert.equal(parallel[0]._id,parallel[1]._id);
  assert.equal(await db.collection('footprints').countDocuments({
    user:owner,'location.name':'Parallel synthetic location'
  }),1);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:owner}),3);

  const removed=await act(user(owner),'delete',id,{},'synthetic-delete-01');
  assert.deepEqual(removed,{msg:'Deleted successfully'});
  assert.deepEqual(await act(user(owner),'delete',id,{},'synthetic-delete-01'),
    removed);
  assert.equal(await db.collection('footprints').countDocuments({_id:new ObjectId(id)}),0);
  assert.equal(await db.collection('audit_logs').countDocuments({operator:owner}),4);

  await db.collection('roles').updateOne({name:'user'},{$set:{permissions:[]}});
  await assert.rejects(act(user(owner),'delete',id,{},'synthetic-delete-01'),
    e=>e.status===403);
  await db.collection('roles').updateOne({name:'user'},{$set:{permissions:['FOOTPRINT:USE']}});

  for(const [key,input] of [
    ['bad-owner',{...data,ownerId:String(other)}],
    ['bad-query',{...data,'$set':{user:String(other)}}],
    ['bad-coord',{...data,location:{name:'Unsafe',coordinates:[999,-36]}}],
    ['bad-caption',{...data,content:'x'.repeat(2100)}]
  ]){
    await assert.rejects(act(user(owner),'create',null,input,key+'-000001'),
      e=>e.status===400);
  }
  assert.equal(await db.collection('audit_logs').countDocuments({operator:owner}),4);
  await db.dropDatabase();
  console.log('PASS: isolated Mongo Replica Set footprint owner CRUD, Mongoose parity, audit/receipt atomicity, concurrent idempotency, forbidden owner, RBAC revocation, validation');
  console.log('NO_PRODUCTION_FOOTPRINT_WRITES=true');
}finally{
  await client.close();
  await repl.stop();
}
