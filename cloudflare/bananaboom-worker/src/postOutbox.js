// At-least-once Bark delivery for durable MongoDB post_write_outbox records.
// Never repeat the underlying article mutation when notification delivery fails.
const MAX_BATCH = 12;
const LEASE_MS = 30_000;

export function barkEndpoint(base, message) {
  if (typeof base !== 'string') return null;
  let url;
  try { url = new URL(base); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path + '/' + encodeURIComponent('BananaBoom 安全提醒') + '/' + encodeURIComponent(message);
  return url.toString();
}

// Prefer an explicit Worker secret, but preserve the account-owned Bark
// destination already saved for the canonical Orion super_admin. Never expose
// that URL to clients or logs. A stored user-controlled URL is HTTPS-host
// restricted to Bark's official endpoint to prevent server-side request forgery.
export async function resolveBarkDestination(users, configuredUrl) {
  if (barkEndpoint(configuredUrl, 'probe')) return configuredUrl;
  const user = await users.findOne(
    { role: 'super_admin', displayName: 'sam', barkUrl: { $type: 'string' } },
    { projection: { barkUrl: 1 } }
  );
  if (!user?.barkUrl || !barkEndpoint(user.barkUrl, 'probe')) return null;
  try {
    const parsed = new URL(user.barkUrl);
    return parsed.hostname.toLowerCase() === 'api.day.app' ? user.barkUrl : null;
  } catch {
    return null;
  }
}

export function retryDelayMs(attempts) {
  return Math.min(60 * 60_000, 15_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

export async function deliverBarkOutbox(collection, {
  barkUrl,
  fetchImpl = fetch,
  now = () => new Date(),
  batch = MAX_BATCH,
  makeLeaseId = () => crypto.randomUUID()
} = {}) {
  if (!barkEndpoint(barkUrl, 'probe')) return { claimed: 0, sent: 0, deferred: 'bark-not-configured' };
  let claimed = 0;
  let sent = 0;
  for (let i = 0; i < Math.min(Math.max(0, batch), MAX_BATCH); i++) {
    const tick = now();
    const leaseId = makeLeaseId();
    const event = await collection.findOneAndUpdate({
      dispatchedAt: null,
      $and: [
        { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: tick } }] },
        { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: tick } }] }
      ]
    }, {
      $set: { leaseId, leaseUntil: new Date(tick.getTime() + LEASE_MS) },
      $inc: { attempts: 1 }
    }, {
      sort: { createdAt: 1, _id: 1 },
      returnDocument: 'after',
      includeResultMetadata: false
    });
    if (!event) break;
    claimed++;
    let outcome = 'success';
    try {
      const message = `[${event.operatorName || 'System/Unknown'}] 执行了 [${event.action}] - ${event.target || ''}`;
      const response = await fetchImpl(barkEndpoint(barkUrl, message), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) outcome = 'http-' + String(response.status);
    } catch (error) {
      outcome = 'network-' + String(error?.name || 'Error').slice(0, 40);
    }
    const leaseFilter = { _id: event._id, leaseId, dispatchedAt: null };
    if (outcome === 'success') {
      await collection.updateOne(leaseFilter, {
        $set: { dispatchedAt: now() },
        $unset: { leaseId: '', leaseUntil: '', nextAttemptAt: '', lastDeliveryError: '' }
      });
      sent++;
    } else {
      await collection.updateOne(leaseFilter, {
        $set: {
          nextAttemptAt: new Date(now().getTime() + retryDelayMs(event.attempts || 1)),
          lastDeliveryError: outcome
        },
        $unset: { leaseId: '', leaseUntil: '' }
      });
    }
  }
  return { claimed, sent };
}
