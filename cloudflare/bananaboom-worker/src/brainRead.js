import { ObjectId } from 'mongodb';

const VALID_OAUTH_BEARER = /^ov_[A-Za-z0-9_-]{43}$/;
const VALID_ID = /^[a-f0-9]{24}$/i;
const TYPE_SET = new Set(['instruction','identity','career','project','preference','decision','fact','other']);
export const BRAIN_MCP_RESOURCE = 'https://api.samyao.me/api/brain/sync/mcp';
export const BRAIN_API_RESOURCE = 'https://api.samyao.me/api/brain/sync/v1';

// Only fixed classifiers cross the DO RPC boundary or reach logs. Never
// include raw messages, Mongo queries, token strings or request URL data.
export function safeBrainFailureKind(error) {
  const msg=String(error?.message || '');
  if (msg.includes('is not a function')) return 'missing-function';
  if (msg.includes('Cannot read properties of undefined')) return 'undefined-access';
  if (msg.includes('Cannot read properties of null')) return 'null-access';
  if (/crypto|subtle|digest/i.test(msg)) return 'crypto-runtime';
  if (/RPC|Durable Object/i.test(msg)) return 'rpc-runtime';
  if (/clone|serialize/i.test(msg)) return 'serialization';
  if (/timeout|timed out|network/i.test(msg)) return 'database-io';
  return 'other';
}

export class BrainReadError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'BrainReadError';
    this.status = status;
  }
}

const fail = (code, status) => { throw new BrainReadError(code, status); };
const isId = value => typeof value === 'string' && VALID_ID.test(value);
const normalize = value => value.normalize('NFKC').toLowerCase();
function gramKey(gram) {
  let hash = 2166136261;
  for (let i = 0; i < gram.length; i++) hash = Math.imul(hash ^ gram.charCodeAt(i), 16777619);
  return 'g' + ((hash >>> 0) % 8192);
}
function escapeRegex(value) {
  return [...value].map(ch => '\\^$.*+?()[]{}|'.includes(ch) ? '\\' + ch : ch).join('');
}

export function brainSearchFilter(query) {
  if (!query) return {};
  if (typeof query !== 'string' || query.length > 200) fail('INVALID_QUERY');
  const normalizedText = normalize(query);
  const chars = Array.from(normalizedText);
  const grams = chars.length > 1
    ? chars.slice(0, 8).map((character, i) => chars[i + 1] ? character + chars[i + 1] : character)
    : chars;
  return {
    searchGrams: { $all: [...new Set(grams.map(gramKey))] },
    normalizedText: { $regex: escapeRegex(normalizedText) }
  };
}

export function validateBrainSearch(raw) {
  const query = raw === undefined ? {} : raw;
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(k => !['query', 'type', 'limit', 'cursor'].includes(k))) {
    fail('INVALID_SYNC_INPUT');
  }
  const text = query.query === undefined ? '' : query.query;
  const type = query.type;
  const limit = query.limit === undefined ? 20 : query.limit;
  const cursor = query.cursor;
  if (typeof text !== 'string' || text.length > 200 ||
      (type !== undefined && !TYPE_SET.has(type)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 50 ||
      (cursor !== undefined && !isId(cursor))) fail('INVALID_SYNC_INPUT');
  return { query: text, type, limit, cursor };
}

function publicMemory(raw) {
  if (!raw) fail('NOT_FOUND', 404);
  // Match the old Mongoose lean() + publicRow() serialization. This route
  // must never return index content or private object storage references.
  const row = JSON.parse(JSON.stringify(raw));
  const { privateObjectKey: _key, normalizedText: _text, searchGrams: _grams, ...safe } = row;
  return safe;
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Authorize the EXISTING Orion Brain OAuth/API credentials against the
 * existing Mongo collections. No replacement token/session and no new client
 * consent. All checks run inside the MongoDB Durable Object; the owner ID
 * is never accepted from browser arguments.
 */
export async function verifyBrainReadConnection(db, token, resource, now = new Date()) {
  if (!VALID_OAUTH_BEARER.test(token || '') ||
      ![BRAIN_API_RESOURCE, BRAIN_MCP_RESOURCE].includes(resource)) {
    fail('INVALID_CONNECTION_TOKEN', 401);
  }
  const hash = await tokenHash(token);
  const credential = await db.collection('braincredentials').findOne({
    hash, kind: 'access', expiresAt: { $gt: now }
  });
  if (!credential) fail('INVALID_CONNECTION_TOKEN', 401);
  const connection = await db.collection('brainconnections').findOne({
    _id: credential.connectionId, revokedAt: null, expiresAt: { $gt: now }
  });
  if (!connection || connection.resource !== resource || !isId(String(connection.ownerId))) {
    fail('INVALID_CONNECTION_TOKEN', 401);
  }
  const owner = await db.collection('users').findOne(
    { _id: connection.ownerId }, { projection: { role: 1, extraPermissions: 1 } }
  );
  if (!owner) fail('BRAIN_PERMISSION_REQUIRED', 403);
  const role = await db.collection('roles').findOne(
    { name: owner.role }, { projection: { permissions: 1 } }
  );
  const perms = [
    ...(Array.isArray(role?.permissions) ? role.permissions : []),
    ...(Array.isArray(owner.extraPermissions) ? owner.extraPermissions : [])
  ];
  if (!perms.includes('*') && !perms.includes('BRAIN:USE')) {
    fail('BRAIN_PERMISSION_REQUIRED', 403);
  }
  await db.collection('brainconnections').updateOne(
    { _id: connection._id, ownerId: connection.ownerId, revokedAt: null },
    { $set: { lastUsedAt: now } }
  );
  const scopes = (credential.scopes || []).filter(s =>
    connection.scopes?.includes(s) && ['memory:read','memory:write'].includes(s));
  return { ownerId: connection.ownerId, connectionId: connection._id, scopes };
}

export async function brainAccessScopes(db, token, resource) {
  const connection = await verifyBrainReadConnection(db, token, resource);
  return connection.scopes;
}

export async function readBrainMemory(db, token, id, resource = BRAIN_API_RESOURCE) {
  const connection = await verifyBrainReadConnection(db, token, resource);
  if (!connection.scopes.includes('memory:read')) fail('INSUFFICIENT_SCOPE', 403);
  if (!isId(id)) fail('INVALID_ID');
  const record = await db.collection('brainmemories').findOne({
    _id: new ObjectId(id),
    ownerId: connection.ownerId,
    deletedAt: null
  }, { maxTimeMS: 5000 });
  return publicMemory(record);
}

export async function searchBrainMemories(db, token, raw, resource = BRAIN_API_RESOURCE) {
  const connection = await verifyBrainReadConnection(db, token, resource);
  if (!connection.scopes.includes('memory:read')) fail('INSUFFICIENT_SCOPE', 403);
  const args = validateBrainSearch(raw);
  const filter = {
    ownerId: connection.ownerId,
    deletedAt: null,
    reviewStatus: { $ne: 'rejected' },
    ...brainSearchFilter(args.query)
  };
  if (args.type) filter.type = args.type;
  if (args.cursor) filter._id = { $gt: new ObjectId(args.cursor) };
  const docs = await db.collection('brainmemories').find(filter, { maxTimeMS: 5000 })
    .sort({ _id: 1 }).limit(args.limit + 1).toArray();
  return {
    items: docs.slice(0, args.limit).map(publicMemory),
    nextCursor: docs.length > args.limit ? String(docs[args.limit - 1]._id) : null
  };
}
