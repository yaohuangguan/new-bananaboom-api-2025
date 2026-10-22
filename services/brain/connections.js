import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import User from '../../models/User.js';
import Role from '../../models/Role.js';
import { BrainConnection, BrainCredential } from '../../models/brainSync.js';
import { fail, objectId, sha } from './core.js';
export const SCOPES = ['memory:read', 'memory:write'];
export const publicBase = () => (process.env.BRAIN_CONNECT_PUBLIC_URL || 'https://api.samyao.me').replace(/\/$/, '');
export const mcpResource = () => publicBase() + '/api/brain/sync/mcp';
export const apiResource = () => publicBase() + '/api/brain/sync/v1';
export const secret = () => 'ov_' + randomBytes(32).toString('base64url');
export function scopesOf(scopes = SCOPES) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 2 || scopes.some(s => !SCOPES.includes(s))) fail('INVALID_SCOPES');
  return [...new Set(scopes)];
}
export function connectionRow(c) {
  return { _id: String(c._id), label: c.label, provider: c.provider, kind: c.kind, scopes: c.scopes,
    createdAt: c.createdAt, expiresAt: c.expiresAt, revokedAt: c.revokedAt || null,
    lastUsedAt: c.lastUsedAt || null, lastWriteAt: c.lastWriteAt || null };
}
export async function ownerCanUse(ownerId) {
  const user = await User.findById(ownerId).select('role extraPermissions').lean();
  if (!user) return false;
  const role = await Role.findOne({ name: user.role }).select('permissions').lean();
  return [...(role?.permissions || []), ...(user.extraPermissions || [])].some(p => p === '*' || p === 'BRAIN:USE');
}
export async function issueCredential(connection, kind, expiresAt, session, scopes = connection.scopes) {
  const token = secret();
  await BrainCredential.create([{ hash: sha(token), connectionId: connection._id, kind, scopes, expiresAt }], { session });
  return token;
}
export async function createApiKey(ownerId, input) {
  objectId(ownerId);
  if (!input || Object.keys(input).some(k => !['label', 'provider', 'scopes', 'expiresInDays'].includes(k))) fail('INVALID_FIELDS');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) fail('INVALID_LABEL');
  const days = input.expiresInDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) fail('INVALID_EXPIRY');
  if (!['chatgpt', 'claude', 'other'].includes(input.provider)) fail('INVALID_PROVIDER');
  const scopes = scopesOf(input.scopes);
  return mongoose.connection.transaction(async session => {
    if (await BrainConnection.countDocuments({ ownerId, revokedAt: null, expiresAt: { $gt: new Date() } }).session(session) >= 20) fail('CONNECTION_LIMIT', 409);
    const [connection] = await BrainConnection.create([{ ownerId, label: input.label.trim(), provider: input.provider, kind: 'api-key',
      scopes, resource: apiResource(), expiresAt: new Date(Date.now() + days * 86400000) }], { session });
    const token = await issueCredential(connection, 'access', connection.expiresAt, session);
    return { connection: connectionRow(connection), token };
  });
}
export async function verifyVaultToken(token, resource) {
  if (typeof token !== 'string' || !/^ov_[a-zA-Z0-9_-]{43}$/.test(token)) fail('INVALID_CONNECTION_TOKEN', 401);
  const credential = await BrainCredential.findOne({ hash: sha(token), kind: 'access', expiresAt: { $gt: new Date() } }).lean();
  if (!credential) fail('INVALID_CONNECTION_TOKEN', 401);
  const connection = await BrainConnection.findOne({ _id: credential.connectionId, revokedAt: null, expiresAt: { $gt: new Date() } }).lean();
  if (!connection || connection.resource !== resource) fail('INVALID_CONNECTION_TOKEN', 401);
  if (!(await ownerCanUse(String(connection.ownerId)))) fail('BRAIN_PERMISSION_REQUIRED', 403);
  await BrainConnection.updateOne({ _id: connection._id, ownerId: connection.ownerId, revokedAt: null }, { $set: { lastUsedAt: new Date() } });
  return { ...connection, tokenExpiresAt: credential.expiresAt, scopes: credential.scopes.filter(s => connection.scopes.includes(s)) };
}
export function needScope(connection, scope) {
  if (!connection.scopes.includes(scope)) fail('INSUFFICIENT_SCOPE', 403);
}
export async function revokeConnection(ownerId, id) {
  const c = await BrainConnection.findOneAndUpdate({ _id: objectId(id), ownerId }, { $set: { revokedAt: new Date() } }, { new: true }).lean();
  if (!c) fail('NOT_FOUND', 404);
  await BrainCredential.deleteMany({ connectionId: c._id });
  return connectionRow(c);
}
