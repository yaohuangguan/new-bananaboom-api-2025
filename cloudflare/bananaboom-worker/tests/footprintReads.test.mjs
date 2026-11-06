import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SignJWT } from 'jose';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { readOwnerFootprints, readOwnerFootprint, parseFootprintQuery } from '../src/footprintReads.js';

const owner = new ObjectId();
const other = new ObjectId();
const visit = new Date('2026-09-09T00:00:00Z');

function mockDatabase(records) {
  let query, order, limit, counts = 0;
  const db = { collection(name) {
    assert.equal(name, 'footprints');
    return {
      countDocuments: async(filter) => { query = filter; counts++; return records.length; },
      find(filter) {
        assert.equal(filter, query);
        return { sort(value) {
          order = value;
          return { limit(value) {
            limit = value;
            return { toArray: async() => records };
          } };
        } };
      }
    };
  } };
  return { db, state: () => ({query,order,limit,counts}) };
}

test('only status filter is accepted, never caller-supplied owner selector', () => {
  assert.deepEqual(parseFootprintQuery({}), {status:undefined});
  assert.deepEqual(parseFootprintQuery({status:'planned'}), {status:'planned'});
  for (const value of [{user:String(other)}, {status:['visited']},
    {status:'hidden'}, {status:'visited',page:'2'}, {status:{$ne:'visited'}}]) {
    assert.throws(()=>parseFootprintQuery(value), TypeError);
  }
});

test('owner-scoped list and map stats preserve visited/planned behavior',async()=>{
  const records = [
    {_id:new ObjectId(),user:owner,visitDate:visit,location:{country:'中国',province:'广东',city:'深圳',name:'A'},status:'visited'},
    {_id:new ObjectId(),user:owner,visitDate:visit,location:{country:'中国',province:'广东',city:'深圳',name:'B'},status:'visited'},
    {_id:new ObjectId(),user:owner,visitDate:visit,location:{country:'NZ',province:'Auckland',city:'Auckland',name:'C'},status:'planned'},
    {_id:new ObjectId(),user:owner,visitDate:visit,location:{country:'NZ',province:'Auckland',city:'Auckland',name:'D'},status:'visited'}
  ];
  const {db,state} = mockDatabase(records);
  const output=await readOwnerFootprints(db,{id:String(owner),role:'user'});
  assert.ok(state().query.user.equals(owner));
  assert.deepEqual(state().order,{visitDate:-1});
  assert.equal(state().limit,5001);
  assert.equal(output.code,200);
  assert.equal(output.stats.totalCount,3);
  assert.deepEqual(output.stats.countries,['中国','NZ']);
  assert.deepEqual(output.stats.provinces,['广东','Auckland']);
  assert.equal(output.stats.citiesCount,2);
  assert.equal(output.data[0].visitDate,visit.toISOString());
  assert.equal(output.data[0].location.coordinates.length,0);
  assert.equal(output.data[0].content,'');
  assert.equal(output.data[0].rating,5);
  assert.equal(output.data[0].mood,'happy');
  assert.equal(output.data[0].isHighlight,false);
  assert.equal(output.data[0].user,String(owner));
});

test('filtered reads and empty histories maintain legacy shape',async()=>{
  const {db,state}=mockDatabase([]);
  const output=await readOwnerFootprints(db,{id:String(owner)},{status:'planned'});
  assert.equal(state().query.status,'planned');
  assert.deepEqual(output,{code:200,stats:{totalCount:0,countries:[],provinces:[],citiesCount:0},data:[]});
});

test('oversized history fails safely instead of truncating',async()=>{
  const db={collection(){return {countDocuments:async()=>5001,find:()=>{throw Error('must not start scan')}};}};
  await assert.rejects(()=>readOwnerFootprints(db,{id:String(owner)}),RangeError);
});

test('HTTP requires live session and FOOTPRINT:USE; forged role has no authority',async(t)=>{
  const secret='footprint-test-only-long-unique-secret';
  const jwt=await new SignJWT({user:{id:String(owner)},role:'super_admin'})
    .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  let live={id:String(owner),role:'user',permissions:[]},reads=0;
  const repo={
    authorizeSession:async(token)=>token===jwt?live:null,
    ownerFootprints:async(user,query)=>{
      reads++;
      assert.equal(user.role,'user');
      assert.equal(user.id,String(owner));
      assert.equal(query.status,'visited');
      return {code:200,stats:{totalCount:0,countries:[],provinces:[],citiesCount:0},data:[]};
    }
  };
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/footprints?status=visited';
  for(const headers of [{},{authorization:'Bearer forged'}]) {
    assert.equal((await fetch(url,{headers})).status,401);
  }
  assert.equal(reads,0);
  const headers={authorization:'Bearer '+jwt};
  let response=await fetch(url,{headers});
  assert.equal(response.status,403);
  assert.equal((await response.json()).required,'FOOTPRINT:USE');
  assert.equal(reads,0);
  live.permissions=['FOOTPRINT:USE'];
  response=await fetch(url,{headers});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal((await response.json()).code,200);
  assert.equal(reads,1);
  live=null;
  assert.equal((await fetch(url,{headers})).status,401);
  assert.equal(reads,1);
});


test('detail uses fixed _id AND owner predicate, never reads a foreign record',async()=>{
  const itemId = new ObjectId();
  const row={_id:itemId,user:owner,location:{name:'Secret place'},visitDate:visit};
  let observed;
  const db={collection(name){
    assert.equal(name,'footprints');
    return {findOne:async(query)=>{
      observed=query;
      return query.user.equals(owner)?row:null;
    }};
  }};
  const item=await readOwnerFootprint(db,{id:String(owner)},String(itemId));
  assert.ok(observed._id.equals(itemId));
  assert.ok(observed.user.equals(owner));
  assert.equal(item.location.country,'中国');
  assert.equal(item._id,String(itemId));
  assert.equal(item.content,'');
  assert.equal(await readOwnerFootprint(db,{id:String(other)},String(itemId)),null);
  await assert.rejects(()=>readOwnerFootprint(db,{id:String(owner)},'not-an-id'),TypeError);
});

test('detail HTTP requires live permission and never returns another owner ID',async(t)=>{
  const secret='footprint-detail-test-only-long-unique-secret';
  const itemId=new ObjectId(), foreignId=new ObjectId();
  const jwt=await new SignJWT({user:{id:String(owner)},role:'super_admin'})
    .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  let live={id:String(owner),role:'user',permissions:['FOOTPRINT:USE']};
  let queries=0;
  const repo={
    authorizeSession:async(token)=>token===jwt?live:null,
    ownerFootprintDetail:async(user,id)=>{
      queries++;
      assert.equal(user.id,String(owner));
      assert.equal(user.role,'user');
      if(id===String(foreignId))return null;
      assert.equal(id,String(itemId));
      return {_id:String(itemId),user:String(owner),content:'Owned'};
    }
  };
  const app=createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/footprints/';
  const headers={authorization:'Bearer '+jwt};
  assert.equal((await fetch(url+itemId)).status,401);
  assert.equal((await fetch(url+itemId,{headers:{authorization:'Bearer fake'}})).status,401);
  assert.equal((await fetch(url+'invalid',{headers})).status,404);
  assert.equal(queries,0);
  let r=await fetch(url+itemId,{headers});
  assert.equal(r.status,200);
  assert.equal((await r.json()).content,'Owned');
  r=await fetch(url+foreignId,{headers});
  assert.equal(r.status,404);
  assert.equal((await r.json()).msg,'Not Found');
  live.permissions=[];
  assert.equal((await fetch(url+itemId,{headers})).status,403);
  live=null;
  assert.equal((await fetch(url+itemId,{headers})).status,401);
  assert.equal(queries,2);
});
