import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextTodoRun, todoBarkUrl, dispatchTodoReminders
} from '../src/todoReminders.js';

const today = new Date('2026-11-06T00:00:00.000Z');
const validBark = 'https://api.day.app/private-device-key-123456789';
const owner = '507f1f77bcf86cd799439001';
const recipientId = '507f1f77bcf86cd799439002';

function fakeDb({ responseOk = true, missingRecipient = false } = {}) {
  const records = {
    task: {
      _id: 'task-one', todo: 'Task name', description: 'Reminder body',
      user: owner, notifyUsers: [recipientId],
      bark: { sound: 'minuet', level: 'active' },
      remindAt: new Date(today.getTime()-1000), isNotified: false, reminderAttempts: 0
    },
    sent: [], audits: [], claims: [], writes: [],
    fetches: []
  };
  let claimedOnce = false;
  const todos = {
    async findOneAndUpdate(filter, update) {
      records.claims.push(filter);
      if (claimedOnce) return null;
      claimedOnce = true;
      Object.assign(records.task, update.$set);
      records.task.reminderAttempts += 1;
      return {...records.task};
    },
    async updateOne(filter, update) {
      records.writes.push({filter,update});
      Object.assign(records.task, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete records.task[key];
      if (update.$addToSet) {
        records.task.reminderDeliveredTargets ||= [];
        records.task.reminderDeliveredTargets.push(update.$addToSet.reminderDeliveredTargets);
      }
      return { modifiedCount: 1 };
    }
  };
  const users = {
    findOne: async () => ({ _id: owner, timezone: 'Pacific/Auckland' }),
    find: () => ({ toArray: async () => missingRecipient
      ? [] : [{ _id: recipientId, displayName: 'Recipient', email: 'test@example.invalid', barkUrl: validBark }]
    })
  };
  const audits = { insertOne: async (log) => { records.audits.push(log); return { insertedId: 'audit-1' }; } };
  const db = { collection(name) {
    return { todos, users, audit_logs: audits }[name];
  }};
  const client = {
    withSession: async (fn) => fn({
      withTransaction: async (callback) => callback()
    })
  };
  const fetchImpl = async (url) => {
    records.fetches.push(url);
    return { ok: responseOk, status: responseOk ? 200 : 503 };
  };
  return { client, db, records, fetchImpl };
}

test('paused Cron never connects to MongoDB or sends notifications', async () => {
  assert.deepEqual(await dispatchTodoReminders({
    enabled: false, db: { collection: () => { throw Error('DB touched'); } }
  }), { claimed: 0, sent: 0, deferred: 'paused' });
});

test('next run supports interval and IANA timezone Cron schedules', () => {
  assert.equal(nextTodoRun('interval:30m', today).toISOString(), '2026-11-06T00:30:00.000Z');
  assert.equal(nextTodoRun('interval:1h', today).toISOString(), '2026-11-06T01:00:00.000Z');
  assert.equal(nextTodoRun('interval:1d', today).toISOString(), '2026-11-07T00:00:00.000Z');
  const next = nextTodoRun('0 9 * * *', today, 'Pacific/Auckland');
  assert.ok(next instanceof Date);
  assert.equal(next.toISOString(), '2026-11-06T20:00:00.000Z');
  assert.equal(nextTodoRun('interval:0m', today), null);
  assert.equal(nextTodoRun('bogus syntax', today), null);
});

test('Bark destination must be a real official device URL, not SSRF', () => {
  assert.equal(todoBarkUrl('http://api.day.app/key-123456789123', 'x', 'x'), null);
  assert.equal(todoBarkUrl('https://private.internal/key-123456789123', 'x', 'x'), null);
  assert.equal(todoBarkUrl('https://api.day.app@localhost/key-123456789123','x','x'),null);
  const link=todoBarkUrl(validBark, '🔔 Task', 'A / B', {
    sound: 'birdsong', level: 'timeSensitive'
  });
  assert.equal(new URL(link).hostname,'api.day.app');
  assert.match(link,/A%20%2F%20B/);
  assert.equal(new URL(link).searchParams.get('level'), 'timeSensitive');
});

test('successful due reminder sends Bark once and atomically writes audit+task acknowledgement',async()=>{
  const {client,db,records,fetchImpl}=fakeDb();
  const result=await dispatchTodoReminders({
    client, db, enabled: true, now: () => today,
    fetchImpl,makeLeaseId:()=> 'fixed-lease'
  });
  assert.deepEqual(result,{claimed:1,sent:1,completed:1});
  assert.equal(records.fetches.length,1);
  assert.equal(records.task.isNotified,true);
  assert.equal(records.audits.length,1);
  assert.equal(records.audits[0].action,'SYSTEM_REMINDER');
  assert.equal(records.task.reminderLeaseUntil,undefined);
  assert.equal(records.task.reminderDeliveredTargets,undefined);
  assert.equal(records.claims[0].remindAt.$gte.toISOString(),
    '2026-11-05T23:55:00.000Z');
  assert.equal(records.claims[0].remindAt.$lte.toISOString(),today.toISOString());
});

test('Bark failure retains reminder without audit and schedules a retry',async()=>{
  const {client,db,records,fetchImpl}=fakeDb({responseOk:false});
  const result=await dispatchTodoReminders({
    client,db,enabled:true,now:()=>today,fetchImpl,makeLeaseId:()=> 'lease-2'
  });
  assert.deepEqual(result,{claimed:1,sent:0,completed:0});
  assert.equal(records.task.isNotified,false);
  assert.equal(records.audits.length,0);
  assert.equal(records.task.reminderLeaseUntil,undefined);
  assert.equal(records.task.reminderNextAttemptAt.toISOString(),'2026-11-06T00:00:15.000Z');
});

test('no notification recipient does not send to a different user',async()=>{
  const {client,db,records,fetchImpl}=fakeDb({missingRecipient:true});
  const result=await dispatchTodoReminders({
    client,db,enabled:true,now:()=>today,fetchImpl
  });
  assert.deepEqual(result,{claimed:1,sent:0,completed:1});
  assert.equal(records.fetches.length,0);
  assert.equal(records.task.isNotified,true);
});
