import mongoose from 'mongoose';
const { Schema, model } = mongoose;
const id = { type: Schema.Types.ObjectId, required: true, index: true };
const options = { strict: 'throw', versionKey: false };
const source = new Schema({
  ownerId: id, provider: { type: String, enum: ['chatgpt', 'claude', 'orion-legacy', 'manual', 'other'], required: true },
  sourceType: String, externalId: String, originalFilename: String, originalSha256: { type: String, required: true },
  privateObjectKey: String, formatVersion: String, importedAt: { type: Date, default: Date.now },
  originalExportedAt: Date, metadata: Schema.Types.Mixed, status: String
}, options);
source.index({ ownerId: 1, provider: 1, originalSha256: 1 }, { unique: true });
const document = new Schema({
  ownerId: id, sourceId: id, stableKey: { type: String, required: true },
  externalConversationId: String, externalMessageId: String, parentId: String, role: String,
  rawText: { type: String, default: '' }, rawTimestamp: Schema.Types.Mixed, order: Number,
  assetIds: [Schema.Types.ObjectId], rawJsonRef: String, contentSha256: { type: String, required: true },
  metadata: Schema.Types.Mixed, normalizedText: String, searchGrams: [String]
}, options);
document.index({ ownerId: 1, stableKey: 1, contentSha256: 1 }, { unique: true });
document.index({ ownerId: 1, searchGrams: 1 });
const anchor = new Schema({ documentId: id, quote: String, start: Number, end: Number }, { _id: false, ...options });
const memory = new Schema({
  ownerId: id, sourceId: id, type: { type: String, enum: ['instruction', 'identity', 'career', 'project', 'preference', 'decision', 'fact', 'other'], default: 'fact' },
  statement: { type: String, required: true, maxlength: 20000 }, verbatim: String, sourceAnchors: [anchor],
  eventAt: Date, observedAt: Date, capturedAt: { type: Date, default: Date.now },
  reviewStatus: { type: String, enum: ['candidate', 'confirmed', 'rejected', 'disputed'], default: 'candidate' },
  validFrom: Date, validTo: Date, supersedesId: Schema.Types.ObjectId,
  sensitivity: { type: String, enum: ['normal', 'sensitive', 'restricted'], default: 'normal' },
  tags: [String], entityKeys: [String], revision: { type: Number, default: 1 },
  normalizedText: String, searchGrams: [String], deletedAt: Date
}, { ...options, timestamps: true });
memory.index({ ownerId: 1, updatedAt: -1, _id: 1 });
memory.index({ ownerId: 1, type: 1, reviewStatus: 1 });
memory.index({ ownerId: 1, searchGrams: 1 });
const revision = new Schema({
  ownerId: id, memoryId: id, action: { type: String, required: true }, before: Schema.Types.Mixed,
  after: Schema.Types.Mixed, reason: String, editedAt: { type: Date, default: Date.now }, actorId: id, revisionNumber: Number
}, options);
revision.index({ ownerId: 1, memoryId: 1, revisionNumber: 1 }, { unique: true });
const asset = new Schema({
  ownerId: id, sourceId: id, privateObjectKey: String, sha256: String, size: Number, mimeType: String,
  originalName: String, createdAt: { type: Date, default: Date.now }, availability: String
}, options);
asset.index({ ownerId: 1, sourceId: 1, sha256: 1, originalName: 1 }, { unique: true });
const job = new Schema({
  ownerId: id, kind: { type: String, default: 'import' }, provider: String, sourceSha256: String,
  state: String, counts: Schema.Types.Mixed, cursor: String, errorSummary: String,
  preview: Schema.Types.Mixed, privateObjectKey: String, originalFilename: String,
  startedAt: { type: Date, default: Date.now }, finishedAt: Date, expiresAt: Date
}, options);
job.index({ ownerId: 1, startedAt: -1 });
export const BrainSource = model('BrainSource', source);
export const BrainDocument = model('BrainDocument', document);
export const BrainMemory = model('BrainMemory', memory);
export const BrainRevision = model('BrainRevision', revision);
export const BrainAsset = model('BrainAsset', asset);
export const BrainImportJob = model('BrainImportJob', job);
export const tables = { sources: BrainSource, documents: BrainDocument, memories: BrainMemory, revisions: BrainRevision, assets: BrainAsset };
