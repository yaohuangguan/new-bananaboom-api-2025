import mongoose from 'mongoose';
const { Schema, model } = mongoose;
const id = { type: Schema.Types.ObjectId, required: true, index: true };
const opts = { strict: 'throw', versionKey: false };
const connection = new Schema({
  ownerId: id, label: { type: String, required: true, maxlength: 80 },
  provider: { type: String, enum: ['chatgpt', 'claude', 'other'], required: true },
  kind: { type: String, enum: ['api-key', 'oauth'], required: true },
  scopes: [{ type: String, enum: ['memory:read', 'memory:write'] }],
  clientId: String, resource: String, createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }, revokedAt: Date, lastUsedAt: Date, lastWriteAt: Date
}, opts);
connection.index({ ownerId: 1, createdAt: -1 });
const credential = new Schema({
  hash: { type: String, required: true, unique: true }, connectionId: id,
  kind: { type: String, enum: ['access', 'refresh'], required: true },
  scopes: [String], expiresAt: { type: Date, required: true }
}, opts);
credential.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const client = new Schema({ clientId: { type: String, unique: true, required: true }, metadata: Schema.Types.Mixed,
  expiresAt: { type: Date, required: true } }, opts);
client.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const authorization = new Schema({
  hash: { type: String, unique: true, required: true }, clientId: { type: String, required: true },
  params: Schema.Types.Mixed, expiresAt: { type: Date, required: true }
}, opts);
authorization.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const code = new Schema({
  hash: { type: String, unique: true, required: true }, clientId: { type: String, required: true },
  connectionId: id, params: Schema.Types.Mixed, expiresAt: { type: Date, required: true }
}, opts);
code.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const receipt = new Schema({
  ownerId: id, connectionId: id, requestId: { type: String, required: true },
  payloadHash: { type: String, required: true }, result: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now }
}, opts);
receipt.index({ ownerId: 1, connectionId: 1, requestId: 1 }, { unique: true });
export const BrainConnection = model('BrainConnection', connection);
export const BrainCredential = model('BrainCredential', credential);
export const BrainOAuthClient = model('BrainOAuthClient', client);
export const BrainAuthorization = model('BrainAuthorization', authorization);
export const BrainAuthorizationCode = model('BrainAuthorizationCode', code);
export const BrainSyncReceipt = model('BrainSyncReceipt', receipt);
