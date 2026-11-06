import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { parseTodoReadQuery, listOwnerTodos } from '../src/todoReads.js';
import { createApp } from '../src/app.js';

const sam = new ObjectId();
const family = new ObjectId();
const outsider = new ObjectId();
const todoId = new ObjectId();

function fakeDatabase() {
  const captures = { members: 0, filter: null, projection: null };
  const users = [
    { _id: sam, displayName: 'Sam', email: 'sam@example.invalid', role: 'super_admin', photoURL: '/sam.png' },
    { _id: family, displayName: 'Family', email: 'family@example.invalid', role: 'super_admin', photoURL: '/family.png' },
    { _id: outsider, displayName: 'Outsider', email: 'other@example.invalid', role: 'user', photoURL: '/other.png' }
  ];
  const db = { collection(name) {
    if (name === 'users') return {
      find(filter, opts) {
        if (filter.role === 'super_admin') {
          captures.members++;
          assert.deepEqual(opts.projection, { _id: 1 });
          return { toArray: async() => users.filter(u => u.role === 'super_admin').map(u => ({ _id: u._id })) };
        }
        captures.projection = opts.projection;
        return { toArray: async() => users.filter(u => filter._id.$in.some(id => id.equals(u._id)))
          .map(u => ({ ...u, password: undefined })) };
      }
    };
    if (name === 'todos') return {
      find(filter) {
        captures.filter = filter;
        return { sort(order) {
          assert.deepEqual(order, { order: -1, createdAt: -1 });
          return { skip(n) {
            captures.skip = n;
            return { limit(n) {
              captures.limit = n;
              return { toArray: async() => [
                { _id: todoId, user: sam, todo: 'Review docs', notifyUsers: [family, outsider],
                  createdAt: new Date('2026-11-01T00:00:00Z'), bark: { sound: 'alarm' }, __v: 0 }
              ] };
            } };
          } };
        } };
      },
      countDocuments: async(filter) => { assert.equal(filter, captures.filter); return 23; }
    };
    throw new Error('unexpected collection: ' + name);
  } };
  return { db, captures };
}

test('query validation rejects unbounded and unexpected search', () => {
  assert.deepEqual(parseTodoReadQuery({}), {
    page: 1, limit: 20, type: undefined, keyword: undefined, isActive: undefined
  });
  for (const input of [
    { page: '0' }, { limit: '101' }, { page: ['1', '2'] },
    { type: 'all' }, { isActive: 'maybe' }, { keyword: 'x'.repeat(101) },
    { user: String(outsider) }, { limit: { $gt: 0 } }
  ]) assert.throws(() => parseTodoReadQuery(input), TypeError);
});

test('ordinary user scope and populated fields are least-privilege', async() => {
  const {db, captures} = fakeDatabase();
  const result = await listOwnerTodos(db, { id: String(sam), role: 'user' }, {
    page: '2', limit: '10', type: 'wish', keyword: 'x.*', isActive: 'false'
  });
  assert.ok(captures.filter.user.equals(sam));
  assert.equal(captures.filter.type, 'wish');
  assert.equal(captures.filter.isActive, false);
  assert.equal(captures.filter.$or[0].todo.$regex, 'x\\.\\*');
  assert.equal(captures.members, 0);
  assert.equal(captures.skip, 10);
  assert.equal(captures.limit, 10);
  assert.deepEqual(captures.projection, {
    _id: 1, displayName: 1, photoURL: 1, email: 1
  });
  assert.deepEqual(result.pagination, {total: 23, page: 2, limit: 10, totalPages: 3});
  assert.equal(result.data[0].user.displayName, 'Sam');
  assert.equal(result.data[0].notifyUsers.length, 2);
  assert.equal(result.data[0].notifyUsers[0].email, undefined);
  assert.equal(result.data[0].notifyUsers[0].role, undefined);
  assert.equal(result.data[0].bark.sound, 'alarm');
  assert.equal(result.data[0].bark.level, 'active');
  assert.equal(result.data[0].type, 'wish');
  assert.equal(result.data[0].isActive, true);
  assert.equal(result.data[0].password, undefined);
});

test('super admin family filter excludes ordinary users', async() => {
  const {db, captures} = fakeDatabase();
  await listOwnerTodos(db, { id: String(sam), role: 'super_admin' });
  assert.equal(captures.members, 1);
  const ids = captures.filter.user.$in.map(String);
  assert.deepEqual(ids, [String(sam), String(family)]);
  assert.equal(ids.includes(String(outsider)), false);
});

test('HTTP list refuses unsigned, forged, revoked, and cross-user identity', async(t) => {
  const secret = 'unit-tests-only-long-hs256-secret';
  const token = await new SignJWT({user:{id:String(sam)}, role:'super_admin'})
    .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
  let liveUser = {id:String(sam),role:'user',permissions:[]}, calls=0;
  const repo = {
    authorizeSession: async(value) => value === token ? liveUser : null,
    ownerTodos: async(user,query) => {
      calls++;
      assert.equal(user.role,'user'); // JWT role must never be authoritative.
      assert.equal(query.page,'2');
      return { data:[], pagination:{total:0,page:2,limit:20,totalPages:0} };
    }
  };
  const app = createApp(repo,{secretProvider:async()=>secret});
  await app.ready();
  const server=createServer(app.callback());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/todos?page=2';
  for (const headers of [{}, {authorization:'Bearer fake'}]) {
    const response=await fetch(url,{headers});
    assert.equal(response.status,401);
  }
  assert.equal(calls,0);
  let response=await fetch(url,{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,403);
  assert.equal((await response.json()).required,'TODO:USE');
  assert.equal(calls,0);
  liveUser.permissions=['TODO:USE'];
  response=await fetch(url,{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).pagination.page,2);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  liveUser=null;
  response=await fetch(url,{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,401);
  assert.equal(calls,1);
});
