import { CronExpressionParser } from 'cron-parser';
import { retryDelayMs } from './postOutbox.js';

const MAX_BATCH = 8;
const MAX_LATENESS_MS = 5 * 60_000;
const LEASE_MS = 90_000;

// GCP Todo Scheduler is paused. Never replay an old due date after cutover.
export function nextTodoRun(recurrence, from, timezone = 'Asia/Shanghai') {
  if (!recurrence || typeof recurrence !== 'string') return null;
  try {
    const interval = /^interval:([1-9]\d{0,4})([mhd])$/.exec(recurrence);
    if (interval) {
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[interval[2]];
      return new Date(from.getTime() + Number(interval[1]) * unit);
    }
    return CronExpressionParser.parse(recurrence, {
      currentDate: from, tz: timezone
    }).next().toDate();
  } catch {
    return null;
  }
}

export function todoBarkUrl(base, title, message, options = {}) {
  if (typeof base !== 'string') return null;
  let url;
  try { url = new URL(base); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'api.day.app' ||
    url.port || url.username || url.password || url.search || url.hash ||
    !/^\/[A-Za-z0-9_-]{12,}$/.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\/$/, '') + '/' +
    encodeURIComponent(title) + '/' + encodeURIComponent(message);
  const sound = String(options.sound || 'minuet').slice(0, 32);
  const level = ['active', 'timeSensitive', 'passive', 'critical'].includes(options.level)
    ? options.level : 'active';
  url.searchParams.set('sound', sound);
  url.searchParams.set('level', level);
  url.searchParams.set('group', 'Todo');
  return url.toString();
}

export async function dispatchTodoReminders({
  client, db,
  enabled = false,
  fetchImpl = fetch,
  now = () => new Date(),
  makeLeaseId = () => crypto.randomUUID(),
  batch = MAX_BATCH
}) {
  if (!enabled) return { claimed: 0, sent: 0, deferred: 'paused' };
  const todos = db.collection('todos');
  const users = db.collection('users');
  const audits = db.collection('audit_logs');
  let claimed = 0, sent = 0, completed = 0;

  for (let i = 0; i < Math.min(MAX_BATCH, Math.max(0, batch)); i++) {
    const tick = now();
    const leaseId = makeLeaseId();
    const task = await todos.findOneAndUpdate({
      remindAt: { $gte: new Date(tick.getTime() - MAX_LATENESS_MS), $lte: tick },
      isNotified: false,
      status: { $ne: 'done' },
      isActive: { $ne: false },
      $and: [
        { $or: [{ reminderLeaseUntil: { $exists: false } }, { reminderLeaseUntil: { $lte: tick } }] },
        { $or: [{ reminderNextAttemptAt: { $exists: false } }, { reminderNextAttemptAt: { $lte: tick } }] }
      ]
    }, {
      $set: { reminderLeaseId: leaseId, reminderLeaseUntil: new Date(tick.getTime() + LEASE_MS) },
      $inc: { reminderAttempts: 1 }
    }, { sort: { remindAt: 1, _id: 1 }, returnDocument: 'after', includeResultMetadata: false });

    if (!task) break;
    claimed++;
    const filter = { _id: task._id, reminderLeaseId: leaseId, isNotified: false };
    const already = new Set((task.reminderDeliveredTargets || []).map(String));
    let failed = false;
    let deliveryCount = 0;
    let recipients = [];

    try {
      const owner = await users.findOne({ _id: task.user },
        { projection: { timezone: 1 } });
      if (!owner) throw new Error('MissingTodoOwner');
      const targets = Array.isArray(task.notifyUsers) ? task.notifyUsers : [];
      recipients = targets.length
        ? await users.find({ _id: { $in: targets } }, {
          projection: { _id: 1, displayName: 1, photoURL: 1, email: 1, barkUrl: 1 }
        }).toArray()
        : [];
      // The original scheduler sends only to the explicitly selected users.
      for (const recipient of recipients) {
        const id = String(recipient._id);
        if (already.has(id)) continue;
        const url = todoBarkUrl(recipient.barkUrl, '🔔 ' + task.todo,
          task.description || '时间到了，该执行任务了！', task.bark);
        if (!url) continue;
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8_000)
        });
        if (!response.ok) throw new Error('TodoBarkDeliveryFailed');
        await todos.updateOne(filter, { $addToSet: { reminderDeliveredTargets: id } });
        already.add(id);
        deliveryCount++;
      }

      // The business acknowledgement and audit are atomic. External Bark is
      // at-least-once: a crash after send but before ack may duplicate a push.
      const next = nextTodoRun(task.recurrence, tick, owner.timezone || 'Asia/Shanghai');
      await client.withSession((session) => session.withTransaction(async () => {
        const result = await todos.updateOne(filter, {
          $set: {
            ...(next ? { remindAt: next } : {}),
            isNotified: !next, updatedAt: tick
          },
          $unset: {
            reminderLeaseId: '', reminderLeaseUntil: '',
            reminderNextAttemptAt: '', reminderAttempts: '',
            reminderDeliveredTargets: ''
          }
        }, { session });
        if (result.modifiedCount !== 1) throw new Error('TodoLeaseLost');
        await audits.insertOne({
          operator: task.user,
          action: 'SYSTEM_REMINDER',
          target: String(task.todo || '').slice(0, 300),
          details: {
            task_id: task._id, recurrence: task.recurrence || null,
            notified_users: recipients.map((u) => ({
              _id: u._id, displayName: u.displayName,
              photoURL: u.photoURL || '', email: u.email
            })),
            next_run: next
          },
          ip: '127.0.0.1', createdDate: tick
        }, { session });
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }, readPreference: 'primary'
      }));
      completed++;
      sent += deliveryCount;
    } catch (error) {
      failed = true;
      // Never log Bark tokens, recipient IDs or reminder content.
      console.error('todo-worker-delivery-error', error?.name || 'Error');
    }

    if (failed) {
      await todos.updateOne(filter, {
        $set: {
          reminderNextAttemptAt: new Date(now().getTime() + retryDelayMs(task.reminderAttempts || 1))
        },
        $unset: { reminderLeaseId: '', reminderLeaseUntil: '' }
      });
    }
  }
  return { claimed, sent, completed };
}
