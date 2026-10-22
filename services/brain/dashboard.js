import { mcpResource, publicBase, apiResource } from './connections.js';
import mongoose from 'mongoose';
import { BrainMemory, BrainSource, BrainRevision } from '../../models/brain.js';
import { BrainConnection } from '../../models/brainSync.js';
import { publicRow } from './core.js';
export async function knowledgeDashboard(ownerId) {
  const owner = new mongoose.Types.ObjectId(ownerId);
  const [types, sources, recent, activity, connections] = await Promise.all([
    BrainMemory.aggregate([{ $match: { ownerId: owner, deletedAt: null } }, { $group: { _id: '$type', count: { $sum: 1 } } }]).option({ maxTimeMS: 5000 }),
    BrainSource.aggregate([{ $match: { ownerId: owner } }, { $group: { _id: '$provider', count: { $sum: 1 } } }]).option({ maxTimeMS: 5000 }),
    BrainMemory.find({ ownerId, deletedAt: null }).sort({ updatedAt: -1, _id: -1 }).limit(6).lean(),
    BrainRevision.aggregate([{ $match: { ownerId: owner, editedAt: { $gte: new Date(Date.now() - 14 * 86400000) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$editedAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }]).option({ maxTimeMS: 5000 }),
    BrainConnection.find({ ownerId, revokedAt: null, expiresAt: { $gt: new Date() } }).select('provider label lastUsedAt lastWriteAt kind scopes expiresAt').lean()
  ]);
  return { types: Object.fromEntries(types.map(t => [t._id, t.count])), sources: Object.fromEntries(sources.map(t => [t._id, t.count])),
    recent: recent.map(publicRow), activity: activity.map(a => ({ day: a._id, count: a.count })),
    connections: connections.map(c => ({ _id: String(c._id), provider: c.provider, label: c.label,
      lastUsedAt: c.lastUsedAt || null, lastWriteAt: c.lastWriteAt || null, kind: c.kind, scopes: c.scopes, expiresAt: c.expiresAt })) };
}
export function attachConnections(router, handlers) {
  router.get('/dashboard', async (req, res) => res.json(await knowledgeDashboard(req.brainOwner)));
  router.get('/connections', async (req, res) => {
    const rows = await BrainConnection.find({ ownerId: req.brainOwner }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ items: rows.map(handlers.connectionRow), configuration: { mcpUrl: mcpResource(), openapiUrl: publicBase() + '/api/brain/sync/openapi.json', apiBaseUrl: apiResource() } });
  });
  router.post('/connections', async (req, res) => res.status(201).json(await handlers.createApiKey(req.brainOwner, req.body)));
  router.delete('/connections/:id', async (req, res) => res.json(await handlers.revokeConnection(req.brainOwner, req.params.id)));
  router.post('/connections/authorize', async (req, res) => res.json(await handlers.approveAuthorization(req.brainOwner, req.body)));
}
