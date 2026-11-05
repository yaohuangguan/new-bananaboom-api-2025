import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { barkEndpoint, retryDelayMs, deliverBarkOutbox } from '../src/postOutbox.js';

const clock = () => new Date('2026-11-05T08:00:00.000Z');

function memoryOutbox(seed = []) {
  const rows = seed.map((event, i) => ({
    _id: String(i + 1), createdAt: clock(), dispatchedAt: null, attempts: 0, ...event
  }));
  return {
    rows,
    async findOneAndUpdate(filter, update) {
      const current = rows.find((row) =>
        row.dispatchedAt === null &&
        (!row.leaseUntil || row.leaseUntil <= filter.$and[0].$or[1].leaseUntil.$lte) &&
        (!row.nextAttemptAt || row.nextAttemptAt <= filter.$and[1].$or[1].nextAttemptAt.$lte)
      );
      if (!current) return null;
      Object.assign(current, update.$set);
      current.attempts++;
      return { ...current };
    },
    async updateOne(filter, update) {
      const row = rows.find((x) => x._id === filter._id && x.leaseId === filter.leaseId);
      if (!row) return;
      Object.assign(row, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete row[key];
    }
  };
}

test('Bark URL is HTTPS-only, encodes notification path, and rejects secret-bearing URL credentials', () => {
  assert.equal(barkEndpoint('http://example.com/key', 'hi'), null);
  assert.equal(barkEndpoint('https://user:secret@example.com/key', 'hi'), null);
  const url = barkEndpoint('https://push.example.com/device/', 'Private / unsafe?');
  assert.equal(new URL(url).hostname, 'push.example.com');
  assert.match(url, /Private%20%2F%20unsafe%3F$/);
  assert.equal(retryDelayMs(1), 15_000);
  assert.equal(retryDelayMs(100), 3_600_000);
});

test('no Bark secret means no event is claimed or discarded', async () => {
  const db = memoryOutbox([{ action: 'CREATE_POST' }]);
  assert.deepEqual(await deliverBarkOutbox(db, { barkUrl: null }), {
    claimed: 0, sent: 0, deferred: 'bark-not-configured'
  });
  assert.equal(db.rows[0].attempts, 0);
});

test('success delivers once, sets dispatchedAt, and never mutates article records', async () => {
  const db = memoryOutbox([{ action: 'CREATE_POST', target: 'Example', operatorName: 'Admin' }]);
  const links = [];
  const dispatch = (url) => {
    links.push(url);
    return Promise.resolve({ ok: true, status: 200 });
  };
  const opts = {
    barkUrl: 'https://push.example.com/device',
    fetchImpl: dispatch, now: clock,
    makeLeaseId: () => 'lease-1'
  };
  assert.deepEqual(await deliverBarkOutbox(db, opts), { claimed: 1, sent: 1 });
  assert.equal(links.length, 1);
  assert.match(decodeURIComponent(links[0]), /Admin.*CREATE_POST.*Example/);
  assert.ok(db.rows[0].dispatchedAt instanceof Date);
  assert.deepEqual(await deliverBarkOutbox(db, opts), { claimed: 0, sent: 0 });
});

test('HTTP 5xx retains event and backs off; subsequent invocation may retry', async () => {
  const db = memoryOutbox([{ action: 'DELETE_POST', target: 'Article' }]);
  let t = clock().getTime();
  const opts = {
    barkUrl: 'https://push.example.com/device',
    now: () => new Date(t),
    makeLeaseId: () => 'fixed-lease',
    fetchImpl: async () => ({ ok: false, status: 503 })
  };
  assert.deepEqual(await deliverBarkOutbox(db, opts), { claimed: 1, sent: 0 });
  assert.equal(db.rows[0].dispatchedAt, null);
  assert.equal(db.rows[0].attempts, 1);
  assert.equal(db.rows[0].lastDeliveryError, 'http-503');
  assert.deepEqual(await deliverBarkOutbox(db, opts), { claimed: 0, sent: 0 });
  t += 15_001;
  opts.fetchImpl = async () => ({ ok: true, status: 200 });
  assert.deepEqual(await deliverBarkOutbox(db, opts), { claimed: 1, sent: 1 });
  assert.equal(db.rows[0].attempts, 2);
});

test('only administrator with a live verified session can read event feed', async (t) => {
  const key = 'feed-test-key-with-more-than-thirty-two-characters';
  const id = '507f1f77bcf86cd799439011';
  const token = await new SignJWT({ user: { id } })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(key));
  let current = { id, role: 'user', permissions: [] };
  const repo = {
    authorizeSession: async () => current,
    pollPostWriteEvents: async () => [{
      id: '507f1f77bcf86cd799439011', timestamp: clock().toISOString(),
      message: '[Admin] 执行了 [CREATE_POST] - Title', log: { action: 'CREATE_POST' }
    }]
  };
  const app = createApp(repo, { secretProvider: async () => key });
  await app.ready();
  const server = createServer(app.callback());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/audit/worker-events';
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + token } })).status, 403);
  current = { id, role: 'user', permissions: ['SYSTEM_LOGS:USE'] };
  const success = await fetch(url, { headers: { cookie: 'orion_session=' + token } });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'private, no-store');
  const json = await success.json();
  assert.equal(json.events.length, 1);
  assert.equal(json.cursor, '507f1f77bcf86cd799439011');
  assert.equal((await fetch(url + '?after=invalid', {
    headers: { authorization: 'Bearer ' + token }
  })).status, 400);
  current = null;
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + token } })).status, 401);
});

test('Bark destination reuses the canonical sam super_admin only', async () => {
  const { resolveBarkDestination } = await import('../src/postOutbox.js');
  const valid = 'https://api.day.app/fully-private-existing-device-token';
  const find = async (filter) => {
    assert.equal(filter.role, 'super_admin');
    assert.equal(filter.displayName, 'sam');
    return { barkUrl: valid };
  };
  assert.equal(await resolveBarkDestination({ findOne: find }), valid);
  assert.equal(await resolveBarkDestination({ findOne: find }, 'https://push.example.com/explicit'), 'https://push.example.com/explicit');
  assert.equal(await resolveBarkDestination({ findOne: async () => ({
    barkUrl: 'https://evil.example/collector'
  }) }), null);
  assert.equal(await resolveBarkDestination({ findOne: async () => null }), null);
});
