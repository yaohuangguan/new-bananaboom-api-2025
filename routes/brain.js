import { Router, json } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { BrainSource, BrainDocument, BrainMemory, BrainRevision, BrainImportJob } from '../models/brain.js';
import { objectId, publicRow, pageRows, writeMemory, fail, limitOf } from '../services/brain/core.js';
import Conversation from '../models/Conversation.js';
import Chat from '../models/Chat.js';
export const brainRouter = Router();
brainRouter.use((req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  if (!req.user?.id || !mongoose.isObjectIdOrHexString(req.user.id)) return res.status(401).json({ message: 'AUTH_REQUIRED' });
  if (!Array.isArray(req.user.permissions) || !req.user.permissions.some(p => p === '*' || p === 'BRAIN:USE')) return res.status(403).json({ message: 'BRAIN_PERMISSION_REQUIRED' });
  req.brainOwner = String(req.user.id);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const allowed = (process.env.BRAIN_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
    if (process.env.NODE_ENV !== 'production') allowed.push('http://localhost:5173', 'http://127.0.0.1:5173');
    if ((origin && !allowed.includes(origin)) || (req.authSource === 'cookie' && (!origin || req.get('X-Brain-Request') !== '1'))) return res.status(403).json({ message: 'ORIGIN_REJECTED' });
  }
  next();
});
brainRouter.use(rateLimit({ windowMs: 60000, limit: 120, keyGenerator: req => req.brainOwner, standardHeaders: 'draft-8', legacyHeaders: false }));
brainRouter.use(json({ limit: '256kb' }));
brainRouter.get('/stats', async (req, res) => {
  const ownerId = req.brainOwner;
  const [memories, sources, documents, candidates, last] = await Promise.all([
    BrainMemory.countDocuments({ ownerId, deletedAt: null }), BrainSource.countDocuments({ ownerId }),
    BrainDocument.countDocuments({ ownerId }), BrainMemory.countDocuments({ ownerId, deletedAt: null, reviewStatus: 'candidate' }),
    BrainMemory.findOne({ ownerId }).sort({ updatedAt: -1 }).select('updatedAt').lean()
  ]);
  res.json({ memories, sources, documents, candidates, updatedAt: last?.updatedAt || null });
});
brainRouter.get('/memories', async (req, res) => res.json(await pageRows(BrainMemory, req.brainOwner, req.query, req.query.archived === 'true' ? { deletedAt: { $ne: null } } : { deletedAt: null })));
brainRouter.post('/memories', async (req, res) => res.status(201).json(await writeMemory(req.brainOwner, req.body)));
brainRouter.get('/memories/:id', async (req, res) => res.json(publicRow(await BrainMemory.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner }).lean())));
brainRouter.patch('/memories/:id', async (req, res) => res.json(await writeMemory(req.brainOwner, req.body, req.params.id)));
brainRouter.get('/memories/:id/revisions', async (req, res) => {
  if (!await BrainMemory.exists({ _id: objectId(req.params.id), ownerId: req.brainOwner })) fail('NOT_FOUND', 404);
  const page = await pageRows(BrainRevision, req.brainOwner, req.query, { memoryId: req.params.id });
  // Internal index fields never reach the browser, including revision snapshots.
  page.items = page.items.map(r => ({ ...r, before: r.before ? publicRow(r.before) : null, after: publicRow(r.after) }));
  res.json(page);
});
brainRouter.get('/sources', async (req, res) => res.json(await pageRows(BrainSource, req.brainOwner, req.query)));
brainRouter.get('/sources/:id', async (req, res) => res.json(publicRow(await BrainSource.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner }).lean())));
brainRouter.get('/documents', async (req, res) => res.json(await pageRows(BrainDocument, req.brainOwner, req.query)));
brainRouter.get('/documents/:id', async (req, res) => res.json(publicRow(await BrainDocument.findOne({ _id: objectId(req.params.id), ownerId: req.brainOwner }).lean())));
brainRouter.get('/search', async (req, res) => {
  const kind = req.query.kind === 'documents' ? 'documents' : 'memories';
  const page = await pageRows(kind === 'documents' ? BrainDocument : BrainMemory, req.brainOwner, req.query, kind === 'memories' ? { deletedAt: null } : {});
  res.json({ kind, ...page });
});
brainRouter.get('/imports', async (req, res) => res.json(await pageRows(BrainImportJob, req.brainOwner, req.query, { kind: 'import' })));
brainRouter.get('/legacy/conversations', async (req, res) => {
  const limit = limitOf(req.query.limit);
  const filter = { user: req.brainOwner };
  if (req.query.cursor) filter._id = { $gt: objectId(req.query.cursor) };
  const rows = await Conversation.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
  res.json({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null });
});
brainRouter.get('/legacy/messages', async (req, res) => {
  if (typeof req.query.sessionId !== 'string' || req.query.sessionId.length > 200) fail('INVALID_SESSION');
  if (!await Conversation.exists({ user: req.brainOwner, sessionId: req.query.sessionId })) fail('NOT_FOUND', 404);
  const filter = { room: 'ai_session_' + req.brainOwner, sessionId: req.query.sessionId };
  if (req.query.cursor) filter._id = { $gt: objectId(req.query.cursor) };
  const limit = limitOf(req.query.limit);
  const rows = await Chat.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
  res.json({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null });
});
export function finishBrainRouter(router = brainRouter) {
  router.use((_req, res) => res.status(404).json({ message: 'NOT_FOUND' }));
  router.use((error, _req, res, _next) => {
    const status = error.status || (error.name === 'ValidationError' || error.name === 'StrictModeError' ? 400 : 500);
    // Never serialize request bodies, Mongo values, provider text, object keys or crypto errors.
    res.status(status).json({ message: status === 500 ? 'VAULT_OPERATION_FAILED' : /^[A-Z_]+$/.test(error.message) ? error.message : 'INVALID_REQUEST' });
  });
  return router;
}
export default brainRouter;
